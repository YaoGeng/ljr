/**
 * E1 Agent 草稿气泡管线服务（M2-W3 T4；docs/modules/E-AI辅助/E1-Agent草稿气泡管线.md
 * §2/§3/§4/§5/§7/§8）：管线编排（脱敏→硬拦→意图→RAG→LLM→落库→气泡推送）+ 草稿 CRUD +
 * 律师三动作。只写 agent_assist.* 两表（V48；边界纪律），跨 fulfillment 域只走导出面：
 *   - ConversationService.readMessageForAgent（消息回查，A.4 清单——E1 消费回查唯一入口）；
 *   - ConversationService.sendMessage（**R-01 隔离铁律：草稿发送的唯一路径**——send/edit_send
 *     经律师链路提交（senderRole='lawyer'：成员门→checkRisk→发号→MessageSent），本服务零
 *     fulfillment 写面；发送不在此事务内，见 action 头注）；
 *   - ConversationHub.publishTo（气泡/拦截/降级帧——仅律师订阅者，R-04/W3-6）。
 *
 * 合规红线（§7，违反=返工）：
 *   R-01 草稿写路径与消息发送路径无共享写入点（本服务不 import 任何 fulfillment 写面）；
 *   R-02 原文（含 PII）不进 RAG/LLM——先 SanitizeService 脱敏，adapter 入参无 placeholders
 *        （类型面钉死）；占位符映射只落 drafts/气泡帧（律师端还原显示）；
 *   R-03 敏感话术硬拦——legal_industry BLOCK 词集命中即不生成（拦截提示帧推律师端）；
 *   R-05 Agent 输出永不直接进公屏——草稿只到律师气泡/HTTP 补拉面，进公屏必经律师 action →
 *        sendMessage 律师链路。
 *
 * 降级纪律（W3-7）：管线段失败（脱敏后任意段异常）=不抛错不出草稿——降级帧
 * （agent_degraded）推律师端 + 进程内降级态（last_error/计数，health 面透出）；用户下一条
 * 消息自然重跑（不烧 relay 重试）。恢复=下一次成功出稿清 last_error（计数单调累计）。
 *
 * ⚠M2 后置位：意图聚类真算法（E3 问题树在册后的消费位——当前 version=0 恒 'general'）、
 * answered 待办标记写面（E2/M4）、EXPIRED 定时器（本批只在同用户新问题到达时去重置换）。
 */
import { Inject, Injectable } from '@nestjs/common';
import {
  AppError,
  ErrorCode,
  DRAFT_ACTIONED_TOPIC,
  DRAFT_GENERATED_TOPIC,
  type DraftActionedPayload,
  type DraftGeneratedPayload,
} from '@ljr/shared';
import { OutboxService } from '../../infrastructure/outbox/outbox.service';
import type { SqlExecutor } from '../../infrastructure/sql';
import { PgPoolService } from '../../infrastructure/sql';
import { StateTransitionGuardService } from '../../infrastructure/state-machine/state-transition-guard.service';
import { TRACE_LOGGER } from '../../observability/observability.module';
import type { TraceLogger } from '../../observability/trace-logger';
import { ConversationHub } from '../fulfillment/conversation.hub';
import { ConversationService } from '../fulfillment/conversation.service';
import { WordDictService } from '../ops/word-dict.service';
import { DRAFT_MACHINE } from './draft.machine';
import type {
  AgentHealth,
  DraftActionInput,
  DraftActionResult,
  DraftPipelineInput,
  DraftPipelineOutcome,
  DraftPlaceholders,
  DraftSegmentMs,
  DraftStatus,
  DraftView,
} from './draft.types';
import { AI_ASSIST_MARKER, LLM_ADAPTER, type LlmAdapter } from './llm.adapter';
import type { KnowledgeHit } from './knowledge.types';
import { KnowledgeService } from './knowledge.service';
import { SanitizeService } from './sanitize.service';
import { SpecialtyConfigService } from './specialty.service';
import { SUPPORTED_SPECIALTIES } from './specialty.types';

/**
 * RAG 检索的专项锚：V1 唯一在册专项（R-04：V2 才新增专项）=首发垂直 labor_arbitration。
 * 房间→场次→专项的跨域锚（经事件或导出面）=V2 多专项接线位——本批取全集首值，不预发明。
 */
const PIPELINE_SPECIALTY = SUPPORTED_SPECIALTIES[0];

/** 硬拦词集所在词库（R-05 专项词表所在库=legal_industry；E1 §4「承诺结果/包赢类词表 H5」） */
const BLOCK_DICT_TYPE = 'legal_industry';

/** 断线补拉面上限（自定口径：列表查询护栏，对齐 D5 MAX_PULL_LIMIT=200 形态） */
const DRAFT_LIST_LIMIT = 200;

interface DraftRow {
  readonly id: string;
  readonly room_id: string;
  readonly conversation_id: string;
  readonly target_user_id: string;
  readonly question_digest: string;
  readonly content: string;
  readonly placeholders: Record<string, unknown> | null;
  readonly status: string;
  readonly answered: boolean;
  readonly latency_ms: number | null;
  readonly segment_ms: Record<string, unknown> | null;
  readonly created_at: Date;
  readonly replied_at: Date | null;
}

const DRAFT_COLUMNS = `id, room_id, conversation_id, target_user_id, question_digest, content,
  placeholders, status, answered, latency_ms, segment_ms, created_at, replied_at`;

function assertPositiveInt(raw: number, field: string): number {
  if (!Number.isInteger(raw) || raw <= 0) {
    throw new AppError(ErrorCode.InvalidArgument, `${field} 须为正整数，收到：${String(raw)}`);
  }
  return raw;
}

function toPlaceholders(raw: Record<string, unknown> | null): DraftPlaceholders {
  if (raw === null || typeof raw !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [token, value] of Object.entries(raw)) {
    if (typeof value === 'string') out[token] = value;
  }
  return out;
}

function toSegmentMs(raw: Record<string, unknown> | null): DraftSegmentMs | null {
  if (raw === null) return null;
  const pick = (key: string): number => (typeof raw[key] === 'number' ? (raw[key] as number) : 0);
  return { sanitize: pick('sanitize'), intent: pick('intent'), rag: pick('rag'), llm: pick('llm') };
}

function toDraftView(row: DraftRow): DraftView {
  return {
    draft_id: Number(row.id),
    room_id: Number(row.room_id),
    conversation_id: Number(row.conversation_id),
    target_user_id: Number(row.target_user_id),
    question_digest: row.question_digest,
    content: row.content,
    placeholders: toPlaceholders(row.placeholders),
    status: row.status as DraftStatus,
    answered: row.answered,
    latency_ms: row.latency_ms,
    segment_ms: toSegmentMs(row.segment_ms),
    created_at: new Date(row.created_at).toISOString(),
    replied_at: row.replied_at === null ? null : new Date(row.replied_at).toISOString(),
  };
}

@Injectable()
export class DraftService {
  /** 降级态（进程内，W3-7）：last_error=最近一次管线段失败摘要；degraded_count=单调累计 */
  private lastError: string | null = null;
  private degradedCount = 0;

  constructor(
    private readonly pool: PgPoolService,
    private readonly outbox: OutboxService,
    private readonly guard: StateTransitionGuardService,
    private readonly hub: ConversationHub,
    // R-01：fulfillment 只经两导出面（sendMessage=发送唯一路径；气泡帧=hub）
    private readonly conversations: ConversationService,
    private readonly risk: WordDictService,
    private readonly sanitize: SanitizeService,
    private readonly knowledge: KnowledgeService,
    private readonly specialties: SpecialtyConfigService,
    @Inject(LLM_ADAPTER) private readonly llm: LlmAdapter,
    @Inject(TRACE_LOGGER) private readonly logger: TraceLogger,
  ) {}

  // ===========================================================================
  // 管线（§4 顺序铁律：脱敏→硬拦→意图→RAG→LLM→落库→气泡；§8 各段打点）
  // ===========================================================================

  /**
   * 草稿生成管线（消费端在消息过滤后调用）：五段顺序执行，各段打点（segment_ms）+ 总延迟
   * （latency_ms=脱敏起点→LLM 完成——四段和的下确界，落库/推送不计入 §8 管线预算）。
   * 落库事务：R-06 去重（同 (room_id,target_user_id) 旧 PENDING 置 EXPIRED 经守卫）+ 新行
   * INSERT + DraftGenerated 出箱同事务；气泡帧在事务提交后推（先持久后推送——sendMessage
   * 先例，崩溃窗由 HTTP 补拉面收敛）。W3-7：任意段异常=降级（帧+态）不抛错。
   */
  async runPipeline(msg: DraftPipelineInput): Promise<DraftPipelineOutcome> {
    const startedAt = Date.now();
    try {
      // —— 1) 脱敏段（R-02：sanitized 是唯一可进 RAG/LLM 的问题载荷）——
      const tSanitize = Date.now();
      const sanitized = await this.sanitize.sanitize({ text: msg.content });
      const segSanitize = Date.now() - tSanitize;
      return await this.pipelineTail(
        msg,
        sanitized.sanitized,
        sanitized.placeholders,
        startedAt,
        segSanitize,
      );
    } catch (e) {
      this.noteDegradation(e);
      this.hub.publishTo(msg.conversationId, ['lawyer'], {
        type: 'agent_degraded',
        conversation_id: msg.conversationId,
        room_id: msg.roomId,
        target_user_id: msg.targetUserId,
      });
      return 'degraded';
    }
  }

  /**
   * 管线 2~6 段（脱敏产物续跑：硬拦→意图→RAG→LLM→落库+气泡+事件）。拆出私有段仅为
   * 头注可读性——外部入口只有 runPipeline。
   */
  private async pipelineTail(
    msg: DraftPipelineInput,
    questionDigest: string,
    bindings: readonly { readonly token: string; readonly value: string }[],
    startedAt: number,
    segSanitize: number,
  ): Promise<DraftPipelineOutcome> {
    // —— 2) 敏感话术硬拦（R-03：命中即不生成——拦截提示帧推律师端，零草稿零事件）——
    // 判定文本=脱敏后文本（词表为承诺/包赢类词形，不含 PII 形态——脱敏不改命中面，
    // 本段零原文接触）；词库更新在消息发出后的到达（D5 checkRisk 先拦为第一道门，
    // 本段=管线侧第二道门，词表热更新竞态的兜底）。
    const blockWords = await this.risk.currentBlockWords(BLOCK_DICT_TYPE);
    const hit = this.firstBlockHit(questionDigest, blockWords);
    if (hit !== null) {
      this.hub.publishTo(msg.conversationId, ['lawyer'], {
        type: 'draft_blocked',
        conversation_id: msg.conversationId,
        room_id: msg.roomId,
        target_user_id: msg.targetUserId,
        hit_word_count: hit.count,
      });
      return 'blocked';
    }

    // —— 3) 意图段（≤1s 预算；E3 问题树 version=0 ⇒ 恒 'general'，E2/E3 联调位）——
    let t = Date.now();
    const intent = await this.resolveIntent();
    const segIntent = Date.now() - t;

    // —— 4) RAG 段（≤2s 预算；空结果容忍——无知识命中照常出稿）——
    t = Date.now();
    const hits: readonly KnowledgeHit[] =
      questionDigest.trim().length > 0
        ? await this.knowledge.retrieve({ specialty: PIPELINE_SPECIALTY, query: questionDigest })
        : [];
    const segRag = Date.now() - t;

    // —— 5) LLM 段（≤4s 预算；adapter 入参=脱敏后载荷，placeholders 禁入——R-02）——
    t = Date.now();
    const llmOut = await this.llm.generate({ questionDigest, intent, hits });
    const segLlm = Date.now() - t;
    // R-04 管线级强制（T4 评审 I-1）：标记缺失=适配器违约（真供应商换装输出形态不可控），
    // 降级不出稿——红线不悬于适配器自觉；抛错进 runPipeline catch=降级帧+态
    if (!llmOut.content.includes(AI_ASSIST_MARKER)) {
      throw new AppError(
        ErrorCode.InternalError,
        `LLM 输出缺「AI 辅助，仅供参考」标记（R-04 违约，降级不出稿；draft 适配器输出须带标）`,
      );
    }

    const segmentMs: DraftSegmentMs = {
      sanitize: segSanitize,
      intent: segIntent,
      rag: segRag,
      llm: segLlm,
    };
    const latencyMs = Date.now() - startedAt;

    // —— 6) 落库事务（R-06 去重置换 + 新行 + DraftGenerated 出箱；状态经守卫+STL）——
    const placeholders: Record<string, string> = {};
    for (const b of bindings) placeholders[b.token] = b.value;
    const draftId = await this.pool.withTransaction(async (uow) => {
      await this.expireSuperseded(uow, msg.roomId, msg.targetUserId);
      const inserted = await uow.query<{ id: string }>(
        `INSERT INTO agent_assist.drafts
           (room_id, conversation_id, target_user_id, question_digest, content, placeholders,
            status, latency_ms, segment_ms)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'PENDING', $7, $8::jsonb)
         RETURNING id`,
        [
          msg.roomId,
          msg.conversationId,
          msg.targetUserId,
          questionDigest,
          llmOut.content,
          JSON.stringify(placeholders),
          latencyMs,
          JSON.stringify(segmentMs),
        ],
      );
      const id = Number(inserted.rows[0]!.id);
      await this.outbox.recordOutbox(uow, {
        type: DRAFT_GENERATED_TOPIC,
        payload: {
          draft_id: id,
          room_id: msg.roomId,
          conversation_id: msg.conversationId,
          target_user_id: msg.targetUserId,
          latency_ms: latencyMs,
          segment_ms: segmentMs,
        } satisfies DraftGeneratedPayload,
      });
      return id;
    });

    // —— 7) 气泡帧（事务提交后推；仅律师订阅者——R-04/W3-6）——
    this.hub.publishTo(msg.conversationId, ['lawyer'], {
      type: 'draft',
      conversation_id: msg.conversationId,
      draft_id: draftId,
      room_id: msg.roomId,
      target_user_id: msg.targetUserId,
      question_digest: questionDigest,
      content: llmOut.content,
      placeholders,
    });
    this.noteRecovered();
    return 'drafted';
  }

  // ===========================================================================
  // 律师三动作（§5 POST /drafts/{id}/action；409 EXPIRED；幂等键=draft+action）
  // ===========================================================================

  /**
   * 律师动作（send|edit_send|discard）：全程单事务+行锁（FOR UPDATE 先于一切判定——T4 评审
   * I-3 修复环）：
   *   1) 幂等前置：agent_review_logs 已有 (draft_id,action) 行 ⇒ 零副作用幂等返回（重放
   *      不重复发消息/不出第二份事件）；
   *   2) 非 PENDING 且无同动作留痕 ⇒ 409 EXPIRED（含被 R-06 置 EXPIRED 的旧草稿）；
   *   3) send/edit_send：经 ConversationService.sendMessage 律师链路提交（R-01 唯一发送
   *      路径——成员门+checkRisk+发号+MessageSent 全链真跑，与律师手打完全同路径）。
   *      sendMessage 自持事务（外层行锁只串行化动作，锁序无环）；消息发出后外层事务失败
   *      （进程崩溃窗）的重放会再发一条——at-least-once 接受项（HTTP 面无 msg_client_id；
   *      窗口=崩溃级，JSDoc 钉住不静默）；
   *   4) 守卫迁移 PENDING→终态+agent_review_logs 落行（UNIQUE(draft_id,action) DB 兜底）
   *      +DraftActioned 出箱（review_ms=created_at→动作时刻）；edit_send 的编辑稿存
   *      review log（R-05 审查留痕）。
   */
  async action(
    draftId: number,
    lawyerId: number,
    input: DraftActionInput,
  ): Promise<DraftActionResult> {
    const id = assertPositiveInt(draftId, 'draft_id');
    const actor = assertPositiveInt(lawyerId, 'lawyer_id');
    if (input.action !== 'send' && input.action !== 'edit_send' && input.action !== 'discard') {
      throw new AppError(
        ErrorCode.InvalidArgument,
        `action 须为 send|edit_send|discard，收到：${String(input.action)}`,
      );
    }
    if (input.action === 'edit_send') {
      if (typeof input.editedContent !== 'string' || input.editedContent.length === 0) {
        throw new AppError(ErrorCode.InvalidArgument, 'edit_send 须携带非空 edited_content');
      }
    } else if (input.editedContent !== undefined) {
      throw new AppError(
        ErrorCode.InvalidArgument,
        `edited_content 仅 edit_send 可携带（action=${input.action}）`,
      );
    }

    // 串行化事务（T4 评审 I-3 修复环）：行锁先于幂等前置/状态门/sendMessage——并发同/异
    // 动作在此串行（先到者终态化提交后，后到者锁内读到非 PENDING：同动作幂等返回、异动作
    // 409，消息不再双发； sendMessage 自持事务不反向取 drafts 锁——锁序无环）。消息发出后
    // 本事务失败的崩溃窗=at-least-once 接受项（重放幂等短路，不静默——见类注）。
    return this.pool.withTransaction(async (uow) => {
      const locked = await uow.query<DraftRow>(
        `SELECT ${DRAFT_COLUMNS} FROM agent_assist.drafts WHERE id = $1 FOR UPDATE`,
        [id],
      );
      const draft = locked.rows[0];
      if (!draft) {
        throw new AppError(ErrorCode.NotFound, `草稿 ${id} 不存在`);
      }

      // 1) 幂等前置（同动作已留痕 → 零副作用；锁内读无竞态）
      const logged = await uow.query(
        `SELECT 1 FROM agent_assist.agent_review_logs
        WHERE draft_id = $1 AND action = $2`,
        [id, input.action],
      );
      if ((logged.rowCount ?? 0) > 0) {
        return { draft_id: id, status: draft.status as DraftStatus, deduplicated: true };
      }

      // 2) 状态门（409 EXPIRED）
      if (draft.status !== 'PENDING') {
        throw new AppError(
          ErrorCode.Conflict,
          `草稿 ${id} 已终态（${draft.status}），不可 ${input.action}（409 EXPIRED）`,
        );
      }

      // 3) 发送（R-01：律师链路唯一路径；行锁内——并发动作已串行化）
      let sentAt: Date | null = null;
      if (input.action === 'send' || input.action === 'edit_send') {
        const content = input.action === 'edit_send' ? input.editedContent! : draft.content;
        const sent = await this.conversations.sendMessage({
          conversationId: Number(draft.conversation_id),
          senderId: actor,
          senderRole: 'lawyer',
          content,
        });
        sentAt = new Date(sent.created_at);
      }

      const reviewMs = Math.max(0, Date.now() - draft.created_at.getTime());
      const target: DraftStatus =
        input.action === 'send'
          ? 'SENT'
          : input.action === 'edit_send'
            ? 'EDITED_SENT'
            : 'DISCARDED';

      // 4) 守卫迁移+审查日志+DraftActioned（锁内单点）
      await this.guard.assertTransition(DRAFT_MACHINE, {
        entityId: id,
        from: 'PENDING',
        to: target,
        reason: `lawyer_${input.action}`,
        uow,
      });
      await uow.query(
        `UPDATE agent_assist.drafts SET status = $2, replied_at = now()
          WHERE id = $1 AND status = 'PENDING'`,
        [id, target],
      );
      await uow.query(
        `INSERT INTO agent_assist.agent_review_logs
           (draft_id, lawyer_id, action, edited_content, review_ms, sent_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (draft_id, action) DO NOTHING`,
        [
          id,
          actor,
          input.action,
          input.action === 'edit_send' ? input.editedContent! : null,
          reviewMs,
          sentAt,
        ],
      );
      await this.outbox.recordOutbox(uow, {
        type: DRAFT_ACTIONED_TOPIC,
        payload: {
          draft_id: id,
          room_id: Number(draft.room_id),
          action: input.action,
          review_ms: reviewMs,
        } satisfies DraftActionedPayload,
      });
      return { draft_id: id, status: target, deduplicated: false };
    });
  }

  // ===========================================================================
  // 读面（断线补拉 + 健康面）
  // ===========================================================================

  /** 草稿单读（404 缺失） */
  async getDraft(draftId: number): Promise<DraftView> {
    const id = assertPositiveInt(draftId, 'draft_id');
    const res = await this.pool.query<DraftRow>(
      `SELECT ${DRAFT_COLUMNS} FROM agent_assist.drafts WHERE id = $1`,
      [id],
    );
    const row = res.rows[0];
    if (!row) throw new AppError(ErrorCode.NotFound, `草稿 ${id} 不存在`);
    return toDraftView(row);
  }

  /**
   * 律师端断线补拉（§5 WSS lawyer/drafts 的 HTTP 补充面——**自定口径**）：按 room_id 过滤
   * （可选）+status 过滤（可选，缺省 PENDING——律师待处理面），id 倒序至上限 200。授权门
   * =JWT lawyer 角色（controller）+ **per-room 归属校验**（T4 评审 I-2 修复环：结果集去重
   * conversation_id 逐一经 fulfillment 导出面 assertAccess 成员门——非该房参与方 403，
   * placeholders 含 PII 原文映射不外泄；空结果零校验零暴露）。E2 工作台批次可换更精细的
   * 会话列表面，本门为底线不撤。
   */
  async listDrafts(
    lawyerId: number,
    query: {
      readonly roomId?: number;
      readonly status?: DraftStatus;
    },
  ): Promise<DraftView[]> {
    const actor = assertPositiveInt(lawyerId, 'lawyer_id');
    const where: string[] = [];
    const params: unknown[] = [];
    if (query.roomId !== undefined) {
      assertPositiveInt(query.roomId, 'room_id');
      params.push(query.roomId);
      where.push(`room_id = $${params.length}`);
    }
    if (query.status !== undefined) {
      params.push(query.status); // 枚举词汇（http 面 isDraftStatus 白名单校验后参数化）
      where.push(`status = $${params.length}`);
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const res = await this.pool.query<DraftRow>(
      `SELECT ${DRAFT_COLUMNS} FROM agent_assist.drafts ${whereSql}
        ORDER BY id DESC LIMIT ${DRAFT_LIST_LIMIT}`,
      params,
    );
    // 归属门（I-2）：结果集涉及的每个会话逐一验成员资格（fail-closed——任一非成员即 403）
    for (const conversationId of new Set(res.rows.map((r) => Number(r.conversation_id)))) {
      await this.conversations.assertAccess(conversationId, actor);
    }
    return res.rows.map(toDraftView);
  }

  /** 健康面（§5 GET /agent/health：降级态透出——last_error 不含原文（R-02），截断 200 字） */
  health(): AgentHealth {
    return {
      status: this.lastError === null ? 'ok' : 'degraded',
      last_error: this.lastError,
      degraded_count: this.degradedCount,
    };
  }

  // ===========================================================================
  // 内部件
  // ===========================================================================

  /**
   * 意图段（§4「意图识别/聚类 ≤1s」的 W3 轻量形态）：E3 问题树 version=0（未配置，含行缺失
   * =清场/未 seed 的 NotFound 容错）⇒ 恒 'general'（执行计划 T4 行钉住）。问题树在册
   * （version>0）后的聚类真算法=E2/E3 联调位——不预发明口径，当前同样返回 'general'。
   * DB 级故障（非 NotFound）照常上抛（→降级轨道，不静默吞基础设施异常）。
   */
  private async resolveIntent(): Promise<string> {
    try {
      await this.specialties.getQuestionTree(PIPELINE_SPECIALTY);
    } catch (e) {
      if (e instanceof AppError && e.code === ErrorCode.NotFound) return 'general';
      throw e;
    }
    return 'general';
  }

  /** 硬拦命中（小写包含匹配；返回命中计数，null=未命中）。词集空=零命中（无版本兜底语义） */
  private firstBlockHit(text: string, words: readonly string[]): { count: number } | null {
    const haystack = text.toLowerCase();
    let count = 0;
    for (const word of words) {
      if (word.length === 0) continue;
      if (haystack.includes(word.toLowerCase())) count += 1;
    }
    return count > 0 ? { count } : null;
  }

  /**
   * R-06 每用户最新去重：同 (room_id,target_user_id) 的 PENDING 行（行锁）逐行经守卫置
   * EXPIRED（reason=superseded——新问题到达即旧草稿作废，与调用方新行 INSERT 同事务）。
   */
  private async expireSuperseded(
    uow: SqlExecutor,
    roomId: number,
    targetUserId: number,
  ): Promise<number> {
    const res = await uow.query<{ id: string }>(
      `SELECT id FROM agent_assist.drafts
        WHERE room_id = $1 AND target_user_id = $2 AND status = 'PENDING'
        ORDER BY id FOR UPDATE`,
      [roomId, targetUserId],
    );
    for (const row of res.rows) {
      const id = Number(row.id);
      await this.guard.assertTransition(DRAFT_MACHINE, {
        entityId: id,
        from: 'PENDING',
        to: 'EXPIRED',
        reason: 'superseded_by_newer_question',
        uow,
      });
      await uow.query(
        `UPDATE agent_assist.drafts SET status = 'EXPIRED', replied_at = now()
          WHERE id = $1 AND status = 'PENDING'`,
        [id],
      );
    }
    return res.rows.length;
  }

  /** 降级态记账（W3-7）：last_error 只存错误摘要（管线各段错误信息不含原文——构造面保证） */
  private noteDegradation(e: unknown): void {
    this.degradedCount += 1;
    const raw = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    this.lastError = [...raw].slice(0, 200).join('');
    this.logger.warn('E1 草稿管线段失败（降级：不出草稿，用户下一条消息自然重跑）', {
      degraded_count: this.degradedCount,
      error: this.lastError,
    });
  }

  /** 恢复记账：成功出稿清 last_error（degraded_count 单调累计——健康面频次锚） */
  private noteRecovered(): void {
    this.lastError = null;
  }
}
