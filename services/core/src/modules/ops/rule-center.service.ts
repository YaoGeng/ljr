/**
 * H7 规则中心服务（机制核心）：规则版本化（§5 管理：创建草案/提交公示/废弃）+ 行为时快照
 * （§3 语句）+ 现行版缓存（§8）+ 房间须知内容块（R-02）+ R-03 词库免公示通道（Task 5 H5 消费）+
 * RULE_EFFECTIVE 回查/生效迁移（I2 执行器的机制面，经 rule-center.executors 注册）。
 * 施工规格：docs/modules/H-运营后台/H7-规则中心.md；只写 ops.* 表（边界纪律）。
 *
 * 状态纪律（§2/§9）：三条迁移边全经 infrastructure/state-machine 守卫 + state_transition_log
 * （rule-center.machine）；「未公示直接 EFFECTIVE」无状态机边，守卫必然拒绝。
 * 事务形态：管理面方法自带事务（pool.withTransaction）；R-03 免公示通道与生效迁移为 uow 形态
 * （调用方/H5 业务事务句柄，与 I2 registerJob(uow,…) 同款）。
 *
 * 7 日自动生效（R-01）：提交公示时同事务注册 RULE_EFFECTIVE job（ref=规则行 id，dueAt=
 * effective_at+生效缓冲 ⚠——due_at 由应用时钟写入而生效窗口以 DB 时钟判定，缓冲吸收双钟
 * 微漂移）；执行器回查=仍 PUBLISHED（recheck false=CANCELLED，仅「被取代/已生效/废弃」语义）；
 * 生效窗口在 markEffective 以 DB 时钟判定：已到 → 迁移 EFFECTIVE；未到（提前到期的漂移/
 * 伪造 job）→ 不迁移，DONE+outcome:'window_not_due' 落 schedule_job_log.detail + logger.warn
 * （评审修复 Important-2：窗口未到不再与误杀混同，留可查询痕迹；W2+ 周期兜底=控制者 R12 记账）。
 *
 * ⚠后置位：§4「重大规则公开征求意见（公示期内反馈入口）」M3 后台页面批次承载（控制者裁决，
 * W1 不建反馈表）。
 */
import { Inject, Injectable } from '@nestjs/common';
import { AppError, ErrorCode } from '@ljr/shared';
import { OutboxService } from '../../infrastructure/outbox/outbox.service';
import type { SqlExecutor } from '../../infrastructure/sql';
import { PgPoolService } from '../../infrastructure/sql';
import { StateTransitionGuardService } from '../../infrastructure/state-machine/state-transition-guard.service';
import { StateTransitionLogService } from '../../infrastructure/state-machine/state-transition-log.service';
import { TRACE_LOGGER } from '../../observability/observability.module';
import type { TraceLogger } from '../../observability/trace-logger';
import { SchedulerService } from '../schedule/scheduler.service';
import { RULE_CURRENT_CACHE, type RuleCurrentCachePort } from './rule-center.cache';
import { RULE_CENTER_CONFIG, type RuleCenterConfig } from './rule-center.config';
import { RULE_PUBLISHED_TOPIC, type RulePublishedPayload } from './rule-center.events';
import { RULE_PUBLISH_MACHINE } from './rule-center.machine';
import type {
  CreateDraftInput,
  CreateDraftResult,
  LexiconVersionInput,
  RoomNoticeContent,
  RoomNoticeView,
  RuleDefinitionView,
  RulePublishStatus,
  SubmitPublicationResult,
} from './rule-center.types';
import {
  assertContent,
  assertEffectiveAt,
  assertNotReservedRuleKey,
  assertRuleKey,
  assertVersion,
  canonicalJson,
  isNoticeShape,
  parseNoticeContent,
} from './rule-center.validate';

/** RULE_EFFECTIVE job 的幂等键 ref（ref_id=规则行 id；一版一 job，I2 幂等键=type+ref） */
export const RULE_EFFECTIVE_JOB_REF_TYPE = 'rule_definition';

/** 免公示通道的等价审计 reason（state_transition_log；控制者裁决：留痕不可省） */
export const LEXICON_PUBLISH_FREEZE_REASON = 'lexicon_publish_freeze';

const RULE_COLUMNS =
  'id, rule_key, version, content, effective_at, publish_status, published_at, created_at';

interface RuleRow {
  readonly id: string;
  readonly rule_key: string;
  readonly version: number;
  readonly content: Record<string, unknown>;
  readonly effective_at: Date | null;
  readonly publish_status: string;
  readonly published_at: Date | null;
  readonly created_at: Date;
}

function toView(row: RuleRow): RuleDefinitionView {
  return {
    id: Number(row.id),
    ruleKey: row.rule_key,
    version: Number(row.version),
    content: row.content,
    effectiveAt: row.effective_at === null ? null : new Date(row.effective_at),
    publishStatus: row.publish_status as RulePublishStatus,
    publishedAt: row.published_at === null ? null : new Date(row.published_at),
    createdAt: new Date(row.created_at),
  };
}

@Injectable()
export class RuleCenterService {
  readonly config: RuleCenterConfig;

  constructor(
    private readonly pool: PgPoolService,
    private readonly outbox: OutboxService,
    private readonly guard: StateTransitionGuardService,
    private readonly stl: StateTransitionLogService,
    private readonly scheduler: SchedulerService,
    // 缓存 port 注入（module 缺省装进程内实现，测试/M2+ 可 override Redis 实现位，Ruling-3）
    @Inject(RULE_CURRENT_CACHE) private readonly cache: RuleCurrentCachePort,
    // 纯 interface 无运行时类型 token，须经 RULE_CENTER_CONFIG Symbol 注入（module useFactory 装配；
    // 缺 provider 即 DI 报错 fail-fast——slot-lock.config 评审修复①同口径）
    @Inject(RULE_CENTER_CONFIG) config: RuleCenterConfig,
    // window_not_due 的告警位（评审修复 Important-2）：TRACE_LOGGER 由 ObservabilityModule 提供
    //（RuleCenterModule 显式 import，独立装配/测试均可解析；测试经 overrideProvider 注桩断言）。
    // 必需痕迹在 schedule_job_log.detail（执行器回传 outcome），logger 为运维侧 warn 增益。
    @Inject(TRACE_LOGGER) private readonly logger: TraceLogger,
  ) {
    this.config = config;
  }

  // ---------- 管理（§5 POST/GET /admin/rules） ----------

  /**
   * 创建草案（INSERT status='DRAFT'，创建非迁移无需守卫——demo/notify/slot-lock 同口径）。
   * §5 幂等键=key+version：INSERT ... ON CONFLICT DO NOTHING（registerJob 同款——23505 会把
   * 事务打入 aborted，冲突判定改走无错路径）；命中在册行时读回首访行，内容全等（键序无关
   * canonical 全等）⇒ 幂等回读 created:false；内容不等 ⇒ 409 E_RULE_PUBLISHING（REST 语义
   * 裁量，报告论证）。room_notice 键在创建期校验须知结构（R-02 早反馈）。
   */
  async createDraft(input: CreateDraftInput): Promise<CreateDraftResult> {
    assertRuleKey(input.ruleKey);
    // R15：wordlist.* 保留前缀经通用管理面拒绝（词库专用通道=H5，防绕过词库结构校验，
    // 评审 Important-1 系统性修法）；免公示通道 createLexiconVersion 不受限
    assertNotReservedRuleKey(input.ruleKey);
    assertVersion(input.version);
    assertContent(input.content);
    if (input.ruleKey === this.config.noticeRuleKey && !isNoticeShape(input.content)) {
      throw new AppError(
        ErrorCode.InvalidArgument,
        '房间须知内容结构不合法（须为 {title, paragraphs, disclosures} 且 disclosures 非空，R-02）',
      );
    }
    const canonical = canonicalJson(input.content);
    return this.pool.withTransaction(async (uow) => {
      const inserted = await uow.query<RuleRow>(
        `INSERT INTO ops.rule_definitions (rule_key, version, content, publish_status)
         VALUES ($1, $2, $3::jsonb, 'DRAFT')
         ON CONFLICT (rule_key, version) DO NOTHING
         RETURNING ${RULE_COLUMNS}`,
        [input.ruleKey, input.version, JSON.stringify(input.content)],
      );
      const row = inserted.rows[0];
      if (row) return { ...toView(row), created: true };
      // 同键已在册：读回首访行做幂等/冲突判定（UNIQUE 兜底，无 23505 进 aborted）
      const existing = await this.readForUpdate(uow, input.ruleKey, input.version);
      if (existing && canonicalJson(existing.content) === canonical) {
        return { ...toView(existing), created: false };
      }
      throw new AppError(
        ErrorCode.RulePublishConflict,
        `规则版本已存在：${input.ruleKey} v${input.version}`,
      );
    });
  }

  /**
   * 提交公示（DRAFT→PUBLISHED，守卫留痕）：published_at/effective_at 落值（effective_at=
   * now+publicationMs，§2 公示期满承诺时刻），同事务注册 RULE_EFFECTIVE job 与 RulePublished
   * 出箱（§6）。重复提交（已 PUBLISHED）⇒ deduplicated:true 幂等短路（不重发事件/不重注册，
   * 回读首次公示时刻）。now 可注入（测试时间旅行；生产缺省=new Date()）。
   */
  async submitForPublication(
    ruleKey: string,
    version: number,
    opts: { readonly now?: Date } = {},
  ): Promise<SubmitPublicationResult> {
    assertRuleKey(ruleKey);
    assertVersion(version);
    const now = opts.now ?? new Date();
    assertEffectiveAt(now, 'now');
    const effectiveAt = new Date(now.getTime() + this.config.publicationMs);
    const result = await this.pool.withTransaction(async (uow) => {
      const row = await this.readForUpdate(uow, ruleKey, version);
      if (!row) {
        throw new AppError(ErrorCode.NotFound, `规则草案不存在：${ruleKey} v${version}`);
      }
      if (row.publish_status === 'PUBLISHED') {
        // §5 幂等键重放：PUBLISHED 行恒带 effective_at/published_at（提交时落值的不变量）
        if (row.effective_at === null || row.published_at === null) {
          throw new AppError(ErrorCode.InternalError, `PUBLISHED 行缺公示时刻（不变量破坏）`);
        }
        return {
          ruleKey,
          version,
          effectiveAt: new Date(row.effective_at),
          publishedAt: new Date(row.published_at),
          deduplicated: true,
        };
      }
      if (row.publish_status !== 'DRAFT') {
        throw new AppError(
          ErrorCode.RulePublishConflict,
          `规则 ${ruleKey} v${version} 状态为 ${row.publish_status}，不可提交公示`,
        );
      }
      const ruleId = Number(row.id);
      await this.transition(uow, ruleId, 'DRAFT', 'PUBLISHED', 'submit_publication');
      await uow.query(
        `UPDATE ops.rule_definitions SET published_at = $2, effective_at = $3 WHERE id = $1`,
        [ruleId, now, effectiveAt],
      );
      // R-01：公示期满自动生效的 job（dueAt=effective_at+生效缓冲 ⚠，见类注）
      await this.scheduler.registerJob(uow, {
        jobType: 'RULE_EFFECTIVE',
        refType: RULE_EFFECTIVE_JOB_REF_TYPE,
        refId: ruleId,
        dueAt: new Date(effectiveAt.getTime() + this.config.effectiveJobDelayMs),
      });
      // §6：RulePublished 与公示提交同事务（业务回滚则事件不出）；→I1 公示通知（广播型，
      // I1 侧消费适配 W2+ 对接，见 rule-center.events 头注）/D5 须知刷新/消费方缓存失效
      await this.outbox.recordOutbox(uow, {
        type: RULE_PUBLISHED_TOPIC,
        payload: {
          rule_key: ruleKey,
          version,
          effective_at: effectiveAt.toISOString(),
        } satisfies RulePublishedPayload,
      });
      return { ruleKey, version, effectiveAt, publishedAt: now, deduplicated: false };
    });
    // 提交后失效（pending 变化影响 /rules/current 的展示面；现行版不受影响但统一失效更稳）
    this.cache.invalidate(ruleKey);
    return result;
  }

  /**
   * 废弃草案（DRAFT→ABANDONED，控制者裁决终态：留痕优于删行——电商法 §34 变更历史可查）。
   * 非 DRAFT ⇒ 守卫拒绝（StateIllegalTransition + allowed=false 拒绝留痕走独立连接）：
   * PUBLISHED 不可废弃（只能被新版本取代）、EFFECTIVE/ABANDONED 为终态。
   */
  async abandonDraft(ruleKey: string, version: number): Promise<RuleDefinitionView> {
    assertRuleKey(ruleKey);
    assertVersion(version);
    const view = await this.pool.withTransaction(async (uow) => {
      const row = await this.readForUpdate(uow, ruleKey, version);
      if (!row) {
        throw new AppError(ErrorCode.NotFound, `规则草案不存在：${ruleKey} v${version}`);
      }
      const ruleId = Number(row.id);
      await this.transition(
        uow,
        ruleId,
        row.publish_status as RulePublishStatus,
        'ABANDONED',
        'abandon_draft',
      );
      return this.readById(uow, ruleId);
    });
    this.cache.invalidate(ruleKey);
    return view;
  }

  /** 管理面列表（§5 GET /admin/rules[/{key}]）：rule_key/status 筛选，version DESC */
  async listRules(
    filter: {
      readonly ruleKey?: string;
      readonly status?: RulePublishStatus;
      readonly limit?: number;
    } = {},
  ): Promise<RuleDefinitionView[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter.ruleKey !== undefined) {
      assertRuleKey(filter.ruleKey);
      params.push(filter.ruleKey);
      clauses.push(`rule_key = $${params.length}`);
    }
    if (filter.status !== undefined) {
      params.push(filter.status);
      clauses.push(`publish_status = $${params.length}`);
    }
    params.push(filter.limit ?? 100);
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const res = await this.pool.query<RuleRow>(
      `SELECT ${RULE_COLUMNS} FROM ops.rule_definitions ${where}
        ORDER BY rule_key, version DESC
        LIMIT $${params.length}`,
      params,
    );
    return res.rows.map(toView);
  }

  // ---------- 快照与现行版（§3/§8） ----------

  /**
   * 行为时快照（§3 语句照抄 + 控制者裁决两过滤：EFFECTIVE 且 effective_at 非空才可命中）：
   * SELECT * WHERE rule_key=? AND effective_at <= ?(行为时刻) ORDER BY version DESC LIMIT 1。
   * 不走缓存（历史时刻无现行版语义；ix_rule_defs_key_version 点查满足 P95 预算）。
   */
  async snapshotAt(ruleKey: string, at: Date): Promise<RuleDefinitionView | null> {
    assertRuleKey(ruleKey);
    assertEffectiveAt(at, 'at');
    const res = await this.pool.query<RuleRow>(
      `SELECT ${RULE_COLUMNS} FROM ops.rule_definitions
        WHERE rule_key = $1 AND publish_status = 'EFFECTIVE'
          AND effective_at IS NOT NULL AND effective_at <= $2
        ORDER BY version DESC
        LIMIT 1`,
      [ruleKey, at],
    );
    return res.rows[0] ? toView(res.rows[0]) : null;
  }

  /** 现行版（/rules/current 的 at=now 特例；§8 缓存现行版+版本号失效——缓存 port 见 rule-center.cache） */
  async currentVersion(ruleKey: string): Promise<RuleDefinitionView | null> {
    assertRuleKey(ruleKey);
    const cached = this.cache.get(ruleKey);
    if (cached !== undefined) return cached;
    const fresh = await this.snapshotAt(ruleKey, new Date());
    this.cache.set(ruleKey, fresh);
    return fresh;
  }

  /**
   * 现行版 + 公示中最新版（§4「App 规则页展示即将生效」；pending 为附加出参——§5 契约只列
   * current，additive 字段服务于 §4 展示语义，报告注明）。
   */
  async currentWithPending(ruleKey: string): Promise<{
    current: RuleDefinitionView | null;
    pending: RuleDefinitionView | null;
  }> {
    assertRuleKey(ruleKey);
    const current = await this.currentVersion(ruleKey);
    const res = await this.pool.query<RuleRow>(
      `SELECT ${RULE_COLUMNS} FROM ops.rule_definitions
        WHERE rule_key = $1 AND publish_status = 'PUBLISHED'
        ORDER BY version DESC
        LIMIT 1`,
      [ruleKey],
    );
    return { current, pending: res.rows[0] ? toView(res.rows[0]) : null };
  }

  // ---------- 房间须知内容块（R-02，D5 消费） ----------

  /**
   * GET /rooms/notice-content 机制面：现行版 content 按 H7 定义结构提取（RoomNoticeContent）。
   * 无生效版本 ⇒ NotFound（D5 渲染兜底由调用方定）；结构违例 ⇒ InternalError（脏数据显性化，
   * 不静默透传无披露须知——R-02 合规面）。
   */
  async noticeContent(ruleKey?: string): Promise<RoomNoticeView> {
    const key = ruleKey ?? this.config.noticeRuleKey;
    const view = await this.currentVersion(key);
    if (!view || view.effectiveAt === null) {
      throw new AppError(ErrorCode.NotFound, `房间须知尚无生效版本：${key}`);
    }
    const content: RoomNoticeContent = parseNoticeContent(view.content);
    return { ruleKey: view.ruleKey, version: view.version, effectiveAt: view.effectiveAt, content };
  }

  // ---------- R-03 词库免公示通道（Task 5 H5 消费；仅限内部机制调用，不暴露 HTTP） ----------

  /**
   * 词库版本化免公示入口（R-03，最终签名见任务报告 §「H5 消费契约」）：版本化但不走公示流——
   * uow 形态与 H5 业务事务同 commit/rollback；创建即 EFFECTIVE（INSERT 非迁移，创建态无需守卫
   * 同 demo/notify 先例；「DRAFT→EFFECTIVE 无边」的 §9 守卫语义不受影响——公示流内不存在该边）。
   * 留痕=state_transition_log 显式审计行（from NULL → EFFECTIVE，reason=lexicon_publish_freeze，
   * 控制者裁决「免公示通道仍须留痕」）；不 RulePublished（无公示通知语义）、不注册 RULE_EFFECTIVE
   * job（已生效）。同 key+version 冲突 ⇒ 409 E_RULE_PUBLISHING（UNIQUE 兜底）。
   * effectiveAt 缺省 now；传未来时刻=预约生效（快照按行为时刻命中，热更新灰度位）。
   *
   * ⚠缓存失效时序：失效在本方法内即时发生（先于调用方 commit）——并发读者可能回填旧现行版，
   * 最迟 currentCacheTtlMs 后一致（TTL 安全网职责，单机 dev 精确；见 config 注释）。
   */
  async createLexiconVersion(
    uow: SqlExecutor,
    input: LexiconVersionInput,
    opts: { readonly now?: Date } = {},
  ): Promise<RuleDefinitionView> {
    assertRuleKey(input.ruleKey);
    assertVersion(input.version);
    assertContent(input.content);
    const effectiveAt = input.effectiveAt ?? opts.now ?? new Date();
    assertEffectiveAt(effectiveAt);
    // ON CONFLICT DO NOTHING（非裸 23505）：uow 是 H5 的业务事务，唯一冲突不得把它打入
    // aborted 态——以干净 AppError 交还调用方，由其决定回滚语义
    const res = await uow.query<RuleRow>(
      `INSERT INTO ops.rule_definitions
         (rule_key, version, content, effective_at, publish_status, published_at)
       VALUES ($1, $2, $3::jsonb, $4, 'EFFECTIVE', NULL)
       ON CONFLICT (rule_key, version) DO NOTHING
       RETURNING ${RULE_COLUMNS}`,
      [input.ruleKey, input.version, JSON.stringify(input.content), effectiveAt],
    );
    const row = res.rows[0];
    if (!row) {
      throw new AppError(
        ErrorCode.RulePublishConflict,
        `词库版本已存在：${input.ruleKey} v${input.version}`,
      );
    }
    // 等价审计：创建即 EFFECTIVE 显式留痕（守卫放行留痕同款列；from NULL=创建语义）
    await this.stl.write(uow, {
      entityType: RULE_PUBLISH_MACHINE.def.entityType,
      entityId: Number(row.id),
      fromStatus: null,
      toStatus: 'EFFECTIVE',
      allowed: true,
      reason: LEXICON_PUBLISH_FREEZE_REASON,
    });
    this.cache.invalidate(input.ruleKey);
    return toView(row);
  }

  // ---------- RULE_EFFECTIVE 执行器机制面（经 rule-center.executors 注册到 I2 注册表） ----------

  /**
   * 回查（I2 R-02 幂等回查；catalog 锚点=rule_definitions.publish_status）：规则仍 PUBLISHED
   * ⇒ true 需执行（**不看生效窗口**——评审修复 Important-2：窗口判定移入 markEffective，
   * 把「被取代/废弃」（recheck=false → CANCELLED，语义正确）与「窗口未到」（提前到期的
   * 双钟漂移/伪造 job）分开——后者走执行路径留 DONE+outcome 痕迹，不再与误杀混同且永久
   * 不可观测）；EFFECTIVE/ABANDONED/行消失 ⇒ false → job CANCELLED 无操作。
   */
  async isPublicationPending(uow: SqlExecutor, ruleId: number): Promise<boolean> {
    if (!Number.isInteger(ruleId) || ruleId <= 0) return false;
    const res = await uow.query<{ id: string }>(
      `SELECT id FROM ops.rule_definitions
        WHERE id = $1 AND publish_status = 'PUBLISHED'`,
      [ruleId],
    );
    return (res.rowCount ?? 0) > 0;
  }

  /**
   * 生效迁移（PUBLISHED→EFFECTIVE，守卫留痕）：FOR UPDATE 重验后迁移。
   * 生效窗口（effective_at<=now()，DB 时钟）在本方法判定（评审修复 Important-2）：
   *   - 窗口已到 → 守卫迁移 EFFECTIVE（transitioned:true）；
   *   - PUBLISHED 但窗口未到（双钟漂移/伪造提前到期）→ 不迁移、**不与被取代混同**：
     outcome:'window_not_due'（执行器经 I2 writeLog 序列化进 schedule_job_log.detail，
     H4/运维可查询）+ logger.warn（TRACE_LOGGER 注入，测试经 overrideProvider 注桩）；job 以
     DONE 收束，规则保持 PUBLISHED 等待 W2+ 周期兜底（控制者 R12 记账）。
   */
  async markEffective(
    uow: SqlExecutor,
    ruleId: number,
  ): Promise<{ ruleId: number; transitioned: boolean; outcome?: 'window_not_due' }> {
    if (!Number.isInteger(ruleId) || ruleId <= 0) return { ruleId, transitioned: false };
    const res = await uow.query<{
      id: string;
      rule_key: string;
      publish_status: string;
      window_due: boolean;
    }>(
      // 窗口判定用 DB 时钟（now()）：多节点共享钟参照；due_at 由应用时钟写入，
      // 双钟漂移恰在此处显形为 window_not_due（而非误迁移）
      `SELECT id, rule_key, publish_status,
              (effective_at IS NOT NULL AND effective_at <= now()) AS window_due
         FROM ops.rule_definitions WHERE id = $1 FOR UPDATE`,
      [ruleId],
    );
    const row = res.rows[0];
    if (!row || row.publish_status !== 'PUBLISHED') {
      // 回查与执行间被并发推进（同事务+行锁下不应发生；防御性良性 skip）
      return { ruleId, transitioned: false };
    }
    if (!row.window_due) {
      // 窗口未到：双钟漂移/伪造提前到期——留可查询痕迹，不生效（job DONE 收束，W2+ 周期兜底接管）
      this.logger?.warn('RULE_EFFECTIVE 提前到期：生效窗口未到，不迁移（window_not_due）', {
        rule_id: ruleId,
        rule_key: row.rule_key,
        outcome: 'window_not_due',
      });
      return { ruleId, transitioned: false, outcome: 'window_not_due' };
    }
    await this.transition(uow, ruleId, 'PUBLISHED', 'EFFECTIVE', 'rule_effective_due');
    // 进程内即时失效（先于调度方 commit——最迟 TTL 后一致，见 config 注释与报告 ⚠）
    this.cache.invalidate(row.rule_key);
    return { ruleId, transitioned: true };
  }

  // ---------- 内部件 ----------

  private async readForUpdate(
    uow: SqlExecutor,
    ruleKey: string,
    version: number,
  ): Promise<RuleRow | null> {
    const res = await uow.query<RuleRow>(
      `SELECT ${RULE_COLUMNS} FROM ops.rule_definitions WHERE rule_key = $1 AND version = $2 FOR UPDATE`,
      [ruleKey, version],
    );
    return res.rows[0] ?? null;
  }

  private async readById(uow: SqlExecutor, ruleId: number): Promise<RuleDefinitionView> {
    const res = await uow.query<RuleRow>(
      `SELECT ${RULE_COLUMNS} FROM ops.rule_definitions WHERE id = $1`,
      [ruleId],
    );
    const row = res.rows[0];
    if (!row) throw new AppError(ErrorCode.InternalError, `规则行消失（不应触达）：${ruleId}`);
    return toView(row);
  }

  /** 守卫状态迁移（状态禁裸写）+ 条件更新兜底乐观并发（0 行=并发竞态，slot-lock 同款） */
  private async transition(
    uow: SqlExecutor,
    ruleId: number,
    from: RulePublishStatus,
    to: RulePublishStatus,
    reason: string,
  ): Promise<void> {
    await this.guard.assertTransition(RULE_PUBLISH_MACHINE, {
      entityId: ruleId,
      from,
      to,
      reason,
      uow,
    });
    const updated = await uow.query<{ id: string }>(
      `UPDATE ops.rule_definitions SET publish_status = $2::varchar
        WHERE id = $1 AND publish_status = $3::varchar
        RETURNING id`,
      [ruleId, to, from],
    );
    if ((updated.rowCount ?? 0) === 0) {
      throw new AppError(
        ErrorCode.StateStaleEntity,
        `规则 ${ruleId} 已被并发迁移（${from}→${to}）`,
      );
    }
  }
}
