/**
 * D5 会话与消息服务（M2-W1 T3；docs/modules/D-履约/D5-会话与消息.md §2/§3/§4/§5/§7）——
 * fulfillment schema owner 的应用服务导出面（可剥离纪律：D2 房间内提醒=W1 T4 经
 * postInternalMessage 写入；E1 agent 写入=W3 接线位）。
 *
 * 发送链顺序（⚠W1 补充裁决，dev 形态；架构 §3.3-1 生产形态=广播先行+MQ 异步持久化，dev
 * 单进程=先持久后广播，正确性不降级——广播丢失由断线补拉 after_seq 收敛；**换装时序**：
 * 剥离 rtc-im（V2 演进）时改为「广播先行+MQ 异步落库」，本方法 1-4 步整体迁往消费端，
 * 网关只留广播）：
 *   1) checkRisk 同步判定（H5 单入口，R-01：房间/私聊/1对1 同链路）——W1 用 checkRisk 现状
 *      （自持短事务+REVIEW 落 ops 域 risk_records；message_id 关联与同事务 uow 形态=word-dict
 *      头注既有 ⚠ 留缝，OPS 域变更需独立评审，不在本批改）；
 *   2) BLOCKED 即拒：403 E_BLOCKED_BY_RISK——不广播不出箱零落行（拒发即无 MessageSent 事件，
 *      §9「违规消息广播前被拦」）；
 *   3) 单事务：发号（UPDATE conversations SET next_seq=next_seq+1 RETURNING——⚠W1-3 行锁
 *      事务内单调，UNIQUE(conversation_id,seq) 兜底；Redis INCR 换装=本方法发号段整体替换的
 *      SeqIssuer 接口缝）+ INSERT messages + 出箱 MessageSent（载荷无 content——PII 铁律，
 *      消费者按 conversation_id+seq 回查）；
 *   4) 进程内广播房间成员（ConversationHub，已 join 连接）。
 *
 * 隔离铁律（§9）：sender_role=agent/system 只能经 postInternalMessage（内部系统 API）写入
 * （律师审查后发送=E1 W3 接线位）；sendMessage 只收 WSS 白名单角色（user|lawyer），网关侧
 * 另有 claims 比对防伪造。@Agent 消息 sender_role 仍=user（提及非代发）；mention 本批只落
 * 标记+路由桩位（E1 管线=W3）。
 *
 * consent 双门（R-03）：仅 one_on_one（拼单房间默认不录制=D10 边界，room 型信令 403）；
 * consent_records UNIQUE(ref_type,ref_id,party_id) 幂等；**新落行且双方 distinct party 齐**
 * → RTC startRecording（commit 后触达——真通道禁事务内外呼，mock 期零网络；崩溃窗恢复=
 * W2 D6 落位后按订单双方锚补核，头注声明）。并发串行化（T3 评审 C-2）：consent 事务首拍
 * conversations 行 FOR UPDATE——双方并发信令时后到者必见已提交对侧行，恰一次启动成立。
 * 双方身份 vs 订单 user/lawyer 的核验=D6（W3）订单面落位后接入（W1 无 D6 订单表，distinct
 * 双方即门）。
 *
 * 撤回删除（R-04）：purgeTrainingCorpus=source_msg_id IS NOT NULL AND sender_id=该 user 的
 * 热行物理 DELETE + TrainingDataPurged{hot_count, cold_count:0} 回执（恒出箱——重放零行
 * hot_count=0 仍回执，重投由 outbox at-least-once 收敛）；cold 侧=I3 协作位留缝（冷存按
 * 用户反查=W2+ 联调，E3 语料标记生产=W3——cold_count 恒 0）。
 *
 * 冷存（R-05）：archiveColdMessages=日扫 created_at<now-90d 按会话分组 → I3 putArtifact
 * （kind=cold_message，ref_type='conversation'，bytes=JSON-lines 序列化——**parquet=OSS
 * 换装缝**：真对象存储接线时改列式编码，putArtifact 入参不变）→ 同事务热删；逐会话独立
 * 事务单会话失败不连坐；水位=扫描时刻（进程内 ConversationJobExecutors.lastScan +
 * job detail 承载，表列不加禁自发明）。
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  AppError,
  ErrorCode,
  MESSAGE_SENT_TOPIC,
  PRESENCE_JOINED_TOPIC,
  PRESENCE_LEFT_TOPIC,
  RECORDING_CONSENT_GIVEN_TOPIC,
  TRAINING_DATA_PURGED_TOPIC,
  type MessageSentPayload,
  type PresencePayload,
  type RecordingConsentGivenPayload,
  type TrainingDataPurgedPayload,
} from '@ljr/shared';
import type { SqlExecutor } from '../../infrastructure/sql';
import { PgPoolService } from '../../infrastructure/sql';
import { ArtifactsService } from '../../infrastructure/artifacts/artifacts.service';
import { OutboxService } from '../../infrastructure/outbox/outbox.service';
import { WordDictService } from '../ops/word-dict.service';
import { EnrollmentService } from '../trade/enrollment.service';
import { ConversationHub } from './conversation.hub';
import { RTC_PROVIDER, type RtcProvider } from './rtc-provider';
import {
  BACKFILL_LIMIT,
  DEFAULT_PULL_LIMIT,
  MAX_PULL_LIMIT,
  MESSAGE_MAX_LEN,
  isConversationType,
  isMentionTarget,
  type ColdArchiveResult,
  type ConversationType,
  type ConversationView,
  type EnsureConversationResult,
  type ListMessagesInput,
  type MentionTarget,
  type MessageRiskFlag,
  type MessageView,
  type RecordingConsentInput,
  type RecordingConsentResult,
  type SendMessageInput,
  type SenderRole,
} from './conversation.types';

/** 热存窗口（R-05：聊天留存 ≥3 年，热存 90 天→I3 冷存） */
export const COLD_ARCHIVE_AFTER_MS = 90 * 86_400_000;

/** Asia/Shanghai 固定 +08:00（artifacts.service 同口径：retention_until 的 DB 钟日界） */
const SHANGHAI_OFFSET_MS = 8 * 3_600_000;
const COLD_RETENTION_YEARS = 3;

/** 录制同意版本缺省锚（A2 policy_version 联动=W2+；W1 无版本线用 v1） */
const RECORDING_CONSENT_VERSION = 'v1';

/** system 消息 sender_id 锚（identity 域无系统账号；0=平台锚，DB bigint NOT NULL 承载） */
export const SYSTEM_SENDER_ID = 0;

interface ConversationRow {
  readonly id: string;
  readonly type: string;
  readonly ref_id: string;
  readonly created_at: Date;
}

interface MessageRow {
  readonly id: string;
  readonly conversation_id: string;
  readonly seq: string;
  readonly sender_id: string;
  readonly sender_role: string;
  readonly type: string;
  readonly content: string;
  readonly mention: string | null;
  readonly risk_flag: string | null;
  readonly source_msg_id: string | null;
  readonly created_at: Date;
}

const MESSAGE_COLS = `id, conversation_id, seq, sender_id, sender_role, type, content, mention, risk_flag, source_msg_id, created_at`;

function assertPositiveInt(raw: number, field: string): number {
  if (!Number.isInteger(raw) || raw <= 0) {
    throw new AppError(ErrorCode.InvalidArgument, `${field} 须为正整数，收到：${String(raw)}`);
  }
  return raw;
}

function toMessageView(row: MessageRow): MessageView {
  return {
    message_id: Number(row.id),
    conversation_id: Number(row.conversation_id),
    seq: Number(row.seq),
    sender_id: Number(row.sender_id),
    sender_role: row.sender_role as SenderRole,
    type: row.type as MessageView['type'],
    content: row.content,
    mention: (row.mention as MentionTarget | null) ?? null,
    risk_flag: (row.risk_flag as MessageRiskFlag | null) ?? 'PASS',
    source_msg_id: row.source_msg_id,
    created_at: new Date(row.created_at).toISOString(),
  };
}

/** 冷存留存到期日（上海日 +3 年——R-05 聊天留存 ≥3 年；法务确认并行中同 I3 默认口径） */
function coldRetentionUntil(now: Date): string {
  const d = new Date(now.getTime() + SHANGHAI_OFFSET_MS);
  d.setUTCFullYear(d.getUTCFullYear() + COLD_RETENTION_YEARS);
  return d.toISOString().slice(0, 10);
}

@Injectable()
export class ConversationService {
  private readonly logger = new Logger(ConversationService.name);

  constructor(
    private readonly pool: PgPoolService,
    private readonly outbox: OutboxService,
    private readonly hub: ConversationHub,
    private readonly risk: WordDictService,
    // C-1 成员门的 trade 侧事实源（PAID 报名/场次律师——导出查询面，禁跨 schema join）
    private readonly enrollments: EnrollmentService,
    private readonly artifacts: ArtifactsService,
    @Inject(RTC_PROVIDER) private readonly rtc: RtcProvider,
  ) {}

  // ===========================================================================
  // 会话面（统一模型：room/private/one_on_one；幂等键=type+ref_id）
  // ===========================================================================

  /** 会话确保存在（UNIQUE 幂等：重放回读在册行 created=false；并发双插败者回落既有行） */
  async ensureConversation(
    type: ConversationType,
    refId: number,
    opts?: { readonly uow?: SqlExecutor },
  ): Promise<EnsureConversationResult> {
    if (!isConversationType(type)) {
      throw new AppError(ErrorCode.InvalidArgument, `会话 type 非法：${type}`);
    }
    assertPositiveInt(refId, 'ref_id');
    const run = async (exec: SqlExecutor): Promise<EnsureConversationResult> => {
      const inserted = await exec.query<{ id: string }>(
        `INSERT INTO fulfillment.conversations (type, ref_id)
         VALUES ($1, $2)
         ON CONFLICT (type, ref_id) DO NOTHING
         RETURNING id`,
        [type, refId],
      );
      const row = inserted.rows[0];
      if (row) {
        return { conversation_id: Number(row.id), type, ref_id: refId, created: true };
      }
      const prev = await exec.query<{ id: string }>(
        `SELECT id FROM fulfillment.conversations WHERE type = $1 AND ref_id = $2`,
        [type, refId],
      );
      const existing = prev.rows[0];
      if (!existing) {
        // 理论不可达（唯一冲突后回落无行=并发窗口内行消失）；显式失败不裸取
        throw new AppError(ErrorCode.InternalError, `会话 (${type},${refId}) 唯一冲突后回落无行`);
      }
      return { conversation_id: Number(existing.id), type, ref_id: refId, created: false };
    };
    return opts?.uow ? run(opts.uow) : this.pool.withTransaction(run);
  }

  /** 会话读取（join 门/发送前置；null=不存在） */
  async getConversation(conversationId: number): Promise<ConversationView | null> {
    const id = assertPositiveInt(conversationId, 'conversation_id');
    const res = await this.pool.query<ConversationRow>(
      `SELECT id, type, ref_id, created_at FROM fulfillment.conversations WHERE id = $1`,
      [id],
    );
    const row = res.rows[0];
    return row
      ? {
          conversation_id: Number(row.id),
          type: row.type as ConversationType,
          ref_id: Number(row.ref_id),
          created_at: new Date(row.created_at),
        }
      : null;
  }

  /** 房间存在性（GET /rooms/{id}/notice 薄代理的存在性校验——本域自有 rooms 直读） */
  async roomExists(roomId: number): Promise<boolean> {
    const id = assertPositiveInt(roomId, 'room_id');
    const res = await this.pool.query(`SELECT 1 FROM fulfillment.rooms WHERE id = $1`, [id]);
    return res.rows.length > 0;
  }

  // ===========================================================================
  // 成员门（T3 评审 C-1：四口统一——join/send/pull + GET messages；room 型校验成员资格）
  // ===========================================================================

  /**
   * room 会话成员门：conversation.ref_id=rooms.id → session_id（本域 rooms 直读）→ trade
   * 导出面 isSessionParticipant（PAID 报名或场次律师）。非成员 → 403 E_ROLE_FORBIDDEN。
   * private/one_on_one 型 W1 无订单锚（D6=W3，双方校验截止订单面落位）——开放（04§8 登记
   * 由控制者承接）；调用方保证先行会话存在性判定（404）。
   */
  async assertRoomMembership(conversation: ConversationView, userId: number): Promise<void> {
    if (conversation.type !== 'room') return;
    assertPositiveInt(userId, 'user_id');
    const room = await this.pool.query<{ session_id: string }>(
      `SELECT session_id FROM fulfillment.rooms WHERE id = $1`,
      [conversation.ref_id],
    );
    const row = room.rows[0];
    if (!row) {
      // 会话在册而房间缺失=数据漂移——显式失败不静默放行
      throw new AppError(
        ErrorCode.Conflict,
        `房间 ${conversation.ref_id} 不存在（room 会话 ${conversation.conversation_id} 数据漂移）`,
      );
    }
    const sessionId = Number(row.session_id);
    const participant = await this.enrollments.isSessionParticipant(sessionId, userId);
    if (!participant) {
      throw new AppError(
        ErrorCode.RoleForbidden,
        `用户 ${userId} 非场次 ${sessionId} 参与方（PAID 报名/场次律师），无权访问 room 会话 ${conversation.conversation_id}`,
      );
    }
  }

  /** 四口统一入口：会话存在（404）+ room 型成员门（403）→ 返回会话视图 */
  async assertAccess(conversationId: number, userId: number): Promise<ConversationView> {
    const conversation = await this.getConversation(conversationId);
    if (!conversation) {
      throw new AppError(ErrorCode.NotFound, `会话 ${conversationId} 不存在`);
    }
    await this.assertRoomMembership(conversation, userId);
    return conversation;
  }

  // ===========================================================================
  // 发送链（§4 顺序铁律；WSS send 的服务承载）
  // ===========================================================================

  /** 客户端文本发送（WSS 白名单角色；BLOCKED 即拒——步骤 2 的 403 出口） */
  async sendMessage(input: SendMessageInput): Promise<MessageView> {
    const conversationId = assertPositiveInt(input.conversationId, 'conversation_id');
    const senderId = assertPositiveInt(input.senderId, 'sender_id');
    if (input.senderRole !== 'user' && input.senderRole !== 'lawyer') {
      throw new AppError(
        ErrorCode.RoleForbidden,
        `WSS 发送角色仅限 user|lawyer（隔离铁律：agent/system 走内部系统 API），收到：${input.senderRole}`,
      );
    }
    if (typeof input.content !== 'string' || input.content.length === 0) {
      throw new AppError(ErrorCode.InvalidArgument, 'content 须为非空字符串');
    }
    if (input.content.length > MESSAGE_MAX_LEN) {
      // I-1 防滥用护栏（W1 裁量，见 conversation.types.MESSAGE_MAX_LEN 注）
      throw new AppError(
        ErrorCode.InvalidArgument,
        `content 超长：${input.content.length} > ${MESSAGE_MAX_LEN} 字符上限`,
      );
    }
    if (input.mention !== undefined && !isMentionTarget(input.mention)) {
      throw new AppError(
        ErrorCode.InvalidArgument,
        `mention 须为 agent|lawyer，收到：${String(input.mention)}`,
      );
    }
    const conversation = await this.getConversation(conversationId);
    if (!conversation) {
      throw new AppError(ErrorCode.NotFound, `会话 ${conversationId} 不存在`);
    }
    // C-1 成员门（发送口）：room 型非参与方拒于风控/发号之前（最廉价的门先过）
    await this.assertRoomMembership(conversation, senderId);

    // 1) 同步风控（R-01 单入口；REVIEW 副作用=risk_records 自持短事务——W1 checkRisk 现状）
    const verdict = await this.risk.checkRisk({ content: input.content, conversationId });
    // 2) BLOCKED 即拒：不广播不出箱零落行
    if (verdict.action === 'BLOCK') {
      throw new AppError(
        ErrorCode.BlockedByRisk,
        `消息命中风控拦截词（BLOCK），拒绝发送：会话 ${conversationId} seq 未发号`,
      );
    }
    const riskFlag: 'PASS' | 'REVIEW' = verdict.action === 'REVIEW' ? 'REVIEW' : 'PASS'; // MARK→PASS（词表标记面=W2 人审闭环，risk_flag 词汇无 MARK）

    // 3) 单事务：发号+落库+MessageSent（载荷无 content）
    const message = await this.pool.withTransaction(async (uow) => {
      const seqRow = await uow.query<{ next_seq: string }>(
        `UPDATE fulfillment.conversations SET next_seq = next_seq + 1 WHERE id = $1 RETURNING next_seq`,
        [conversationId],
      );
      const seq = Number(seqRow.rows[0]?.next_seq);
      if (!Number.isInteger(seq) || seq <= 0) {
        throw new AppError(ErrorCode.NotFound, `会话 ${conversationId} 不存在（发号无行）`);
      }
      const inserted = await uow.query<MessageRow>(
        `INSERT INTO fulfillment.messages
           (conversation_id, seq, sender_id, sender_role, type, content, mention, risk_flag)
         VALUES ($1, $2, $3, $4, 'text', $5, $6, $7)
         RETURNING ${MESSAGE_COLS}`,
        [
          conversationId,
          seq,
          senderId,
          input.senderRole,
          input.content,
          input.mention ?? null,
          riskFlag,
        ],
      );
      const view = toMessageView(inserted.rows[0]!);
      await this.outbox.recordOutbox(uow, {
        type: MESSAGE_SENT_TOPIC,
        payload: {
          conversation_id: conversationId,
          seq,
          risk_flag: riskFlag,
        } satisfies MessageSentPayload,
      });
      return view;
    });

    // 4) 进程内广播（已 commit；dev 顺序=先持久后广播）
    this.hub.publish(conversationId, { type: 'message', conversation_id: conversationId, message });
    return message;
  }

  /**
   * 内部系统消息写入面（T3 评审 I-2 头注修正）：**仅限 system 通知（D2 房间内提醒）与
   * H7 模板驱动的 @Agent 非法律意见自动响应**。E1 律师审查后的草稿发送**必须走
   * sendMessage(senderRole:'lawyer') 经正常风控链**（架构 §3.3-2 隔离铁律：草稿以律师
   * 名义提交、走与人工消息完全相同的判定/发号/出箱路径）——本面永不承载律师署名内容。
   * 不走 checkRisk（平台/模板内容——词面拦截职责在模板治理+E1 草稿管线）；与客户端消息
   * 共用 seq 序列与 MessageSent 出箱；I-1 长度护栏同 sendMessage。
   */
  async postInternalMessage(input: {
    readonly conversationId: number;
    readonly senderRole: 'system' | 'agent';
    readonly content: string;
    readonly mention?: MentionTarget;
  }): Promise<MessageView> {
    const conversationId = assertPositiveInt(input.conversationId, 'conversation_id');
    if (input.senderRole !== 'system' && input.senderRole !== 'agent') {
      throw new AppError(ErrorCode.InvalidArgument, `内部写入角色仅限 system|agent`);
    }
    if (typeof input.content !== 'string' || input.content.length === 0) {
      throw new AppError(ErrorCode.InvalidArgument, 'content 须为非空字符串');
    }
    if (input.content.length > MESSAGE_MAX_LEN) {
      throw new AppError(
        ErrorCode.InvalidArgument,
        `content 超长：${input.content.length} > ${MESSAGE_MAX_LEN} 字符上限`,
      );
    }
    if (input.mention !== undefined && !isMentionTarget(input.mention)) {
      throw new AppError(ErrorCode.InvalidArgument, `mention 须为 agent|lawyer`);
    }
    const conversation = await this.getConversation(conversationId);
    if (!conversation) {
      throw new AppError(ErrorCode.NotFound, `会话 ${conversationId} 不存在`);
    }
    const message = await this.pool.withTransaction(async (uow) => {
      const seqRow = await uow.query<{ next_seq: string }>(
        `UPDATE fulfillment.conversations SET next_seq = next_seq + 1 WHERE id = $1 RETURNING next_seq`,
        [conversationId],
      );
      const seq = Number(seqRow.rows[0]?.next_seq);
      if (!Number.isInteger(seq) || seq <= 0) {
        throw new AppError(ErrorCode.NotFound, `会话 ${conversationId} 不存在（发号无行）`);
      }
      const inserted = await uow.query<MessageRow>(
        `INSERT INTO fulfillment.messages
           (conversation_id, seq, sender_id, sender_role, type, content, mention, risk_flag)
         VALUES ($1, $2, $3, $4, 'system', $5, $6, 'PASS')
         RETURNING ${MESSAGE_COLS}`,
        [
          conversationId,
          seq,
          SYSTEM_SENDER_ID,
          input.senderRole,
          input.content,
          input.mention ?? null,
        ],
      );
      const view = toMessageView(inserted.rows[0]!);
      await this.outbox.recordOutbox(uow, {
        type: MESSAGE_SENT_TOPIC,
        payload: {
          conversation_id: conversationId,
          seq,
          risk_flag: 'PASS',
        } satisfies MessageSentPayload,
      });
      return view;
    });
    this.hub.publish(conversationId, { type: 'message', conversation_id: conversationId, message });
    return message;
  }

  // ===========================================================================
  // 读路径（§5 断线增量拉取 + §2 迟到回填 N=200）
  // ===========================================================================

  /** 增量拉取（after_seq 独占下界、seq 升序、limit 缺省 50 上限 200；C-1 成员门=读口） */
  async listMessages(input: ListMessagesInput): Promise<MessageView[]> {
    const conversationId = assertPositiveInt(input.conversationId, 'conversation_id');
    const asUserId = assertPositiveInt(input.asUserId, 'asUserId');
    const afterSeq = input.afterSeq ?? 0;
    if (!Number.isInteger(afterSeq) || afterSeq < 0) {
      throw new AppError(
        ErrorCode.InvalidArgument,
        `after_seq 须为非负整数：${String(input.afterSeq)}`,
      );
    }
    const rawLimit = input.limit ?? DEFAULT_PULL_LIMIT;
    if (!Number.isInteger(rawLimit) || rawLimit <= 0) {
      throw new AppError(ErrorCode.InvalidArgument, `limit 须为正整数：${String(input.limit)}`);
    }
    const limit = Math.min(rawLimit, MAX_PULL_LIMIT);
    const conversation = await this.getConversation(conversationId);
    if (!conversation) {
      throw new AppError(ErrorCode.NotFound, `会话 ${conversationId} 不存在`);
    }
    // C-1 成员门（读口：HTTP GET 与 WSS pull 共用本方法——单点设门）
    await this.assertRoomMembership(conversation, asUserId);
    const res = await this.pool.query<MessageRow>(
      `SELECT ${MESSAGE_COLS} FROM fulfillment.messages
        WHERE conversation_id = $1 AND seq > $2
        ORDER BY seq ASC
        LIMIT $3`,
      [conversationId, afterSeq, limit],
    );
    return res.rows.map(toMessageView);
  }

  /** 迟到回填（§2 N=200：join 时自动推最近 200 条，升序返回） */
  async recentMessages(
    conversationId: number,
    limit: number = BACKFILL_LIMIT,
  ): Promise<MessageView[]> {
    const id = assertPositiveInt(conversationId, 'conversation_id');
    const cap = Math.min(Math.max(limit, 1), BACKFILL_LIMIT);
    const res = await this.pool.query<MessageRow>(
      `SELECT ${MESSAGE_COLS} FROM fulfillment.messages
        WHERE conversation_id = $1
        ORDER BY seq DESC
        LIMIT $2`,
      [id, cap],
    );
    return res.rows.map(toMessageView).reverse(); // DESC 取最近 N → 升序回填
  }

  // ===========================================================================
  // 录制 consent 双门（R-03；§5 WSS recording-consent 的服务承载）
  // ===========================================================================

  async recordConsent(input: RecordingConsentInput): Promise<RecordingConsentResult> {
    const conversationId = assertPositiveInt(input.conversationId, 'conversation_id');
    const partyId = assertPositiveInt(input.partyId, 'party_id');
    const conversation = await this.getConversation(conversationId);
    if (!conversation) {
      throw new AppError(ErrorCode.NotFound, `会话 ${conversationId} 不存在`);
    }
    if (conversation.type !== 'one_on_one') {
      // D10 边界：拼单房间默认不录制（consent 门仅 1对1）——信令面直接 403（kind 策略口径）
      throw new AppError(
        ErrorCode.KindPolicy,
        `录制同意仅限 one_on_one 会话（拼单房间默认不录制，D10）；会话 ${conversationId} type=${conversation.type}`,
      );
    }
    if (!input.accept) {
      // W1 无撤回语义（consent_records 无撤销列）：拒结名义零落行零判门，回执直达
      return {
        conversation_id: conversationId,
        party_id: partyId,
        recorded: false,
        bothPartiesConsented: false,
      };
    }
    const version = input.version ?? RECORDING_CONSENT_VERSION;

    const outcome = await this.pool.withTransaction(async (uow) => {
      // C-2 并发串行化：会话行 FOR UPDATE——双方并发 consent 时后到者阻塞至先到者提交，
      // count(DISTINCT party_id) 必见已提交对侧行 → 「新落行且双方齐」判定的恰一次性成立
      await uow.query(`SELECT id FROM fulfillment.conversations WHERE id = $1 FOR UPDATE`, [
        conversationId,
      ]);
      const inserted = await uow.query<{ id: string }>(
        `INSERT INTO fulfillment.consent_records (ref_type, ref_id, party_id, version)
         VALUES ('recording', $1, $2, $3)
         ON CONFLICT (ref_type, ref_id, party_id) DO NOTHING
         RETURNING id`,
        [conversationId, partyId, version],
      );
      const recorded = inserted.rows.length > 0;
      if (recorded) {
        // 审计留痕（非门控信号——双门判定在下方同步完成）
        await this.outbox.recordOutbox(uow, {
          type: RECORDING_CONSENT_GIVEN_TOPIC,
          payload: {
            conversation_id: conversationId,
            party_id: partyId,
          } satisfies RecordingConsentGivenPayload,
        });
      }
      const parties = await uow.query<{ parties: number }>(
        `SELECT count(DISTINCT party_id)::int AS parties
           FROM fulfillment.consent_records
          WHERE ref_type = 'recording' AND ref_id = $1`,
        [conversationId],
      );
      return { recorded, parties: parties.rows[0]?.parties ?? 0 };
    });

    const both = outcome.recorded && outcome.parties >= 2;
    if (both) {
      // 双门齐：启动云录制（commit 后触达；mock 零网络——真通道两段式换装约束见 rtc-provider
      // 头注。仅「新落行且双方齐」触达：重放幂等信令不重复启动）
      await this.rtc.startRecording({ conversationId });
    }
    return {
      conversation_id: conversationId,
      party_id: partyId,
      recorded: outcome.recorded,
      bothPartiesConsented: both,
    };
  }

  // ===========================================================================
  // 撤回删除（R-04：TrainingConsentRevoked 消费承载；热侧物理删）
  // ===========================================================================

  /**
   * 语料热行物理删除：source_msg_id IS NOT NULL AND sender_id=user（未训练样本；已训练样本
   * 的排除判定=E3 语料标记生产（W3）——W1 全量删）。返回删除行数（hot_count）。
   */
  async purgeTrainingCorpus(uow: SqlExecutor, userId: number): Promise<number> {
    const id = assertPositiveInt(userId, 'user_id');
    const deleted = await uow.query(
      `DELETE FROM fulfillment.messages WHERE source_msg_id IS NOT NULL AND sender_id = $1`,
      [id],
    );
    return deleted.rowCount ?? 0;
  }

  /** TrainingDataPurged 回执出箱（消费事务内；恒出箱——重放零行 hot_count=0 仍回执） */
  async recordTrainingPurged(uow: SqlExecutor, userId: number, hotCount: number): Promise<void> {
    await this.outbox.recordOutbox(uow, {
      type: TRAINING_DATA_PURGED_TOPIC,
      payload: {
        user_id: userId,
        hot_count: hotCount,
        cold_count: 0,
      } satisfies TrainingDataPurgedPayload,
    });
  }

  // ===========================================================================
  // presence 出箱（§6：join/leave→PresenceJoined/Left；at=服务器接收时刻）
  // ===========================================================================

  async recordPresence(
    conversation: ConversationView,
    userId: number,
    role: 'user' | 'lawyer',
    direction: 'joined' | 'left',
  ): Promise<void> {
    assertPositiveInt(userId, 'user_id');
    const at = new Date().toISOString(); // 服务器接收时刻（调用方=网关接收路径）
    await this.pool.withTransaction((uow) =>
      this.outbox.recordOutbox(uow, {
        type: direction === 'joined' ? PRESENCE_JOINED_TOPIC : PRESENCE_LEFT_TOPIC,
        payload: {
          conversation_id: conversation.conversation_id,
          ref_id: conversation.ref_id,
          user_id: userId,
          role,
          at,
        } satisfies PresencePayload,
      }),
    );
  }

  // ===========================================================================
  // 冷存（R-05：>90d → I3 cold_message + 同事务热删；COLD_ARCHIVE 执行器内核）
  // ===========================================================================

  /**
   * 一轮冷存扫描：cutoff=扫描时刻-90d（扫描期新消息不入本轮——水位语义）；逐会话独立事务
   * （putArtifact+DELETE 同事务原子；单会话失败 warn 不连坐，下轮重扫）；JSON-lines 首行=
   * {conversation_id, cutoff, archived_at} 表头（跨会话哈希区分锚）。
   */
  async archiveColdMessages(options?: { readonly now?: Date }): Promise<ColdArchiveResult> {
    const now = options?.now ?? new Date();
    const cutoff = new Date(now.getTime() - COLD_ARCHIVE_AFTER_MS);
    const scan = await this.pool.query<{ conversation_id: string }>(
      `SELECT DISTINCT conversation_id FROM fulfillment.messages WHERE created_at < $1 ORDER BY conversation_id`,
      [cutoff],
    );
    let archivedConversations = 0;
    let archivedMessages = 0;
    let failed = 0;
    for (const row of scan.rows) {
      const conversationId = Number(row.conversation_id);
      try {
        const batch = await this.pool.withTransaction(async (uow): Promise<number> => {
          const messages = await uow.query<MessageRow>(
            `SELECT ${MESSAGE_COLS} FROM fulfillment.messages
              WHERE conversation_id = $1 AND created_at < $2
              ORDER BY seq`,
            [conversationId, cutoff],
          );
          if (messages.rows.length === 0) return 0; // 并发已冷存（下轮判重面收敛）
          const lines: string[] = [
            JSON.stringify({
              conversation_id: conversationId,
              cutoff: cutoff.toISOString(),
              archived_at: now.toISOString(),
            }),
            ...messages.rows.map((m) =>
              JSON.stringify({
                message_id: Number(m.id),
                seq: Number(m.seq),
                sender_id: Number(m.sender_id),
                sender_role: m.sender_role,
                type: m.type,
                content: m.content,
                mention: m.mention,
                risk_flag: m.risk_flag,
                source_msg_id: m.source_msg_id,
                created_at: new Date(m.created_at).toISOString(),
              }),
            ),
          ];
          await this.artifacts.putArtifact(
            {
              kind: 'cold_message',
              ref_type: 'conversation',
              ref_id: conversationId,
              bytes: Buffer.from(`${lines.join('\n')}\n`, 'utf8'),
              retentionUntil: coldRetentionUntil(now),
            },
            { uow },
          );
          const deleted = await uow.query(
            `DELETE FROM fulfillment.messages WHERE conversation_id = $1 AND created_at < $2`,
            [conversationId, cutoff],
          );
          return deleted.rowCount ?? 0;
        });
        if (batch > 0) {
          archivedConversations += 1;
          archivedMessages += batch;
        }
      } catch (e) {
        failed += 1;
        const message = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
        this.logger.warn(
          `COLD_ARCHIVE 单会话冷存失败（跳过不连坐，下轮重扫）：conversation ${conversationId} ${message}`,
        );
      }
    }
    return {
      conversations: archivedConversations,
      messages: archivedMessages,
      failed,
      scanned_at: now.toISOString(),
      cutoff: cutoff.toISOString(),
    };
  }
}
