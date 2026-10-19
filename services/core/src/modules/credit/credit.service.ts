/**
 * G1 信用体系服务（§4/§5/§7 + Task 6 简报裁决）——机制核心：
 *   - EMIT_CREDIT_EVENT（内部接口，幂等键=ref+action）：查 H7 规则快照（credit.rules 行为时点）
 *     → 流水 INSERT（uq_credit_events_idem 幂等真兜底，重放短路且分数不变）→ 账户快照 UPSERT
 *     （R-01 GREATEST(0,…) 下限钳制、初始 100、上限开放）→ 达阈值发限制令（同 kind 未到期幂等
 *     跳过）+ CreditEventEmitted/RestrictionIssued 同事务出箱——流水/快照/限制令/事件一个事务
 *     （简报裁决「快照+流水同事务」）；
 *   - R-02 行为时快照：RuleCenterService.snapshotAt(CREDIT_RULES_KEY, 消费时点)（⚠简化裁决：
 *     消费时≈行为时，简报明示可接受并报告标注）；快照版本落 credit_events.rule_version 审计位；
 *     无生效版本/缺 action=配置缺口 → InternalError（消费面进重试轨道，不静默零分）；
 *   - 连续违规 30 天窗口（G1 §4）：violation 类行为窗口内计数 ≥ 阈值 → 按 owner 分流的窗口
 *     限制令（律师 SUSPEND_TAKE_7D / 用户 BAN_JOIN，PRD §8.6/§8.8）；计数 SQL 用 DB 时钟
 *     （窗口判定与 until 比对同参照，due_at 双钟口径同 I2）；
 *   - 限制令惰性失效（§3）：查询面按 until > now() 过滤，无 I2 到期 job；「活跃行唯一」无部分
 *     唯一索引可用（索引谓词禁 now()），以 pg_advisory_xact_lock(owner) 串行化「查活跃→插行」
 *     临界区兜底（pricing advisory 先例）；
 *   - 读：GET /credit/mine（score+recent_events+active restrictions）+ GET /credit/restrictions
 *     （入口校验面，30s 进程内缓存适配位 R-W2-8，发行后主动失效；缓存行读侧再按 until 过滤）。
 *
 * 只写本 schema 的 credit.* 三表；分值/限制映射一律 H7 快照内容（R-W2-10 禁本地分值表）；
 * 跨 schema 只读经 H7 service 接口（禁直查 ops 表——schema-refs 红线）。
 */
import { Injectable } from '@nestjs/common';
import {
  AppError,
  ErrorCode,
  CREDIT_EVENT_EMITTED_TOPIC,
  RESTRICTION_ISSUED_TOPIC,
  type CreditEventEmittedPayload,
  type RestrictionIssuedPayload,
} from '@ljr/shared';
import type { SqlExecutor } from '../../infrastructure/sql';
import { PgPoolService } from '../../infrastructure/sql';
import { OutboxService } from '../../infrastructure/outbox/outbox.service';
import { RuleCenterService } from '../ops/rule-center.service';
import { CreditRestrictionCache } from './credit.cache';
import { actionRuleOf, parseCreditRules, violationRestrictionFor } from './credit.rules';
import {
  CREDIT_INITIAL_SCORE,
  CREDIT_RULES_KEY,
  RECENT_EVENTS_LIMIT,
  isCreditAction,
  isOwnerType,
  type CreditEventView,
  type CreditMineView,
  type EmitCreditEventInput,
  type EmitCreditEventResult,
  type OwnerType,
  type RestrictionKind,
  type RestrictionSpec,
  type RestrictionView,
} from './credit.types';

interface EventRow {
  readonly id: string;
  readonly action: string;
  readonly delta: number;
  readonly rule_version: number;
  readonly ref_type: string;
  readonly ref_id: string;
  readonly created_at: Date;
}

interface RestrictionRow {
  readonly id: string;
  readonly kind: string;
  readonly until: Date;
  readonly reason: string;
  readonly created_at: Date;
}

/** 幂等引用形态（ref_type 值域形态约束：小写下划线，DB varchar(16) 列宽内） */
const REF_TYPE_PATTERN = /^[a-z][a-z_]{0,15}$/;

function isPositiveInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0;
}

@Injectable()
export class CreditService {
  constructor(
    private readonly pool: PgPoolService,
    private readonly outbox: OutboxService,
    // 跨 schema 只读经 H7 service 接口（snapshotAt），禁直查 ops 表——schema-refs 红线
    private readonly rules: RuleCenterService,
    private readonly cache: CreditRestrictionCache,
  ) {}

  // ---------- §5 EMIT_CREDIT_EVENT（内部接口；幂等键=ref+action） ----------

  /**
   * 事件入账（消费端与 W3 内部调用方共用）：幂等重放（同 owner+action+ref 在册）短路——
   * 分数不变、无新流水/出箱/限制令；新事件走「流水→快照→限制令→出箱」单事务。
   * now 可注入（测试时间旅行；生产缺省=new Date()，⚠行为时点=消费时点，报告标注）。
   */
  async emit(
    input: EmitCreditEventInput,
    opts: { readonly now?: Date } = {},
  ): Promise<EmitCreditEventResult> {
    this.assertOwner(input.owner_type, input.owner_id);
    if (!isCreditAction(input.action)) {
      throw new AppError(ErrorCode.InvalidArgument, `action 越行为词汇表：${String(input.action)}`);
    }
    if (typeof input.ref_type !== 'string' || !REF_TYPE_PATTERN.test(input.ref_type)) {
      throw new AppError(
        ErrorCode.InvalidArgument,
        `ref_type 须为 1-16 位小写下划线串：${String(input.ref_type)}`,
      );
    }
    if (!isPositiveInt(input.ref_id)) {
      throw new AppError(ErrorCode.InvalidArgument, `ref_id 须为正整数：${String(input.ref_id)}`);
    }
    const at = opts.now ?? new Date(); // R-02 行为时点=消费时点（⚠简化，简报裁决可接受）

    // 规则快照经 H7 service（自身连接；EFFECTIVE 行不可变，读取时点不影响一致性），
    // 流水/账户/限制令/出箱在本服务单事务——快照读不占业务事务，报告注明
    const snapshot = await this.rules.snapshotAt(CREDIT_RULES_KEY, at);
    if (!snapshot || snapshot.effectiveAt === null) {
      throw new AppError(
        ErrorCode.InternalError,
        `credit.rules 尚无生效版本（H7 运营配置缺口，显性化不静默零分）：at=${at.toISOString()}`,
      );
    }
    const parsed = parseCreditRules(snapshot.content, snapshot.version);
    const rule = actionRuleOf(parsed, input.action);
    if (!rule) {
      throw new AppError(
        ErrorCode.InternalError,
        `credit.rules v${snapshot.version} 缺 action=${input.action}（配置缺口，显性化不静默零分）`,
      );
    }

    const result = await this.pool.withTransaction(async (uow) => {
      // 幂等真兜底：uq_credit_events_idem ON CONFLICT DO NOTHING——重放插 0 行即短路
      const inserted = await uow.query<EventRow>(
        `INSERT INTO credit.credit_events
           (owner_type, owner_id, action, delta, rule_version, ref_type, ref_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (owner_type, owner_id, action, ref_type, ref_id) DO NOTHING
         RETURNING id, action, delta, rule_version, ref_type, ref_id, created_at`,
        [
          input.owner_type,
          input.owner_id,
          input.action,
          rule.delta,
          snapshot.version,
          input.ref_type,
          input.ref_id,
        ],
      );
      if (inserted.rows.length === 0) {
        // at-least-once 重放：分数不变、无新事件、不重复触发限制令
        return {
          deduplicated: true,
          event_id: null,
          delta: null,
          score: await this.readScore(uow, input.owner_type, input.owner_id),
          restrictions_issued: [] as RestrictionView[],
        };
      }

      // 账户快照 UPSERT：R-01 GREATEST(0,…) 下限钳制（流水记录规则原值不受钳制影响）
      const scoreRow = await uow.query<{ score: number }>(
        `INSERT INTO credit.credit_accounts (owner_type, owner_id, score, updated_at)
         VALUES ($1, $2, GREATEST(0, $3::int + $4::int), now())
         ON CONFLICT (owner_type, owner_id) DO UPDATE
           SET score = GREATEST(0, credit.credit_accounts.score + $4::int), updated_at = now()
         RETURNING score`,
        [input.owner_type, input.owner_id, CREDIT_INITIAL_SCORE, rule.delta],
      );
      const score = scoreRow.rows[0]!.score;

      // 限制令目标收集：①行为内嵌 restriction（达该行为即发）②violation 窗口计数达阈值
      const specs: Array<{ readonly spec: RestrictionSpec; readonly reason: string }> = [];
      if (rule.restriction) {
        specs.push({ spec: rule.restriction, reason: `action:${input.action}` });
      }
      if (rule.violation === true) {
        const violationActions = Object.entries(parsed.actions)
          .filter(([, r]) => r.violation === true)
          .map(([a]) => a);
        // 计数含本次（已在同事务插入）；窗口判定用 DB 时钟（now()，含端点 created_at >= now()-window）
        const counted = await uow.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM credit.credit_events
            WHERE owner_type = $1 AND owner_id = $2 AND action = ANY($3::varchar[])
              AND created_at >= now() - make_interval(days => $4::int)`,
          [input.owner_type, input.owner_id, violationActions, parsed.violation.window_days],
        );
        if ((counted.rows[0]?.n ?? 0) >= parsed.violation.threshold) {
          specs.push({
            spec: violationRestrictionFor(parsed, input.owner_type),
            reason: `violation_window:${parsed.violation.window_days}d`,
          });
        }
      }

      // 发行：advisory xact lock 串行化「查活跃→插行」临界区（无部分唯一索引可用——索引谓词
      // 禁 now()）；同批同 kind 由同事务可见性自然去重（先发行者命中 NOT EXISTS 跳过后者）
      const issued: RestrictionView[] = [];
      if (specs.length > 0) {
        await uow.query(
          `SELECT pg_advisory_xact_lock(hashtext('credit.credit_restrictions:' || $1::text || ':' || $2::text))`,
          [input.owner_type, input.owner_id],
        );
        for (const { spec, reason } of specs) {
          const row = await this.issueRestriction(
            uow,
            input.owner_type,
            input.owner_id,
            spec,
            reason,
          );
          if (row) {
            issued.push(row);
            await this.outbox.recordOutbox(uow, {
              type: RESTRICTION_ISSUED_TOPIC,
              payload: {
                owner_type: input.owner_type,
                owner_id: input.owner_id,
                kind: row.kind,
                until: row.until,
              } satisfies RestrictionIssuedPayload,
            });
          }
        }
      }

      // §6：CreditEventEmitted 与流水同事务出箱（C1/C3/A3a 入口校验、H4 消费位）
      await this.outbox.recordOutbox(uow, {
        type: CREDIT_EVENT_EMITTED_TOPIC,
        payload: {
          owner_type: input.owner_type,
          owner_id: input.owner_id,
          action: input.action,
          delta: rule.delta,
          score_after: score,
          rule_version: snapshot.version,
          ref_type: input.ref_type,
          ref_id: input.ref_id,
        } satisfies CreditEventEmittedPayload,
      });
      return {
        deduplicated: false,
        event_id: Number(inserted.rows[0]!.id),
        delta: rule.delta,
        score,
        restrictions_issued: issued,
      };
    });
    if (result.restrictions_issued.length > 0) {
      // 发行后主动失效（提交成功后；R-W2-8——入口校验读侧即时可见）
      this.cache.invalidateOwner({ ownerType: input.owner_type, ownerId: input.owner_id });
    }
    return result;
  }

  // ---------- 导出查询面（跨域消费：D4 I-4 choice 单选持久锚，M2-W2 T3 修复环纯加法） ----------

  /**
   * 信用事件存在性（D4 refund50/credit 二选一的持久锚：emit 幂等键 (owner,action,ref_type,
   * ref_id) 在册判定——credit 档入账后 refund50 拒，防跨 choice 翻单双得）。只读池连接。
   */
  async hasCreditEvent(input: {
    readonly owner_type: OwnerType;
    readonly owner_id: number;
    readonly action: string;
    readonly ref_type: string;
    readonly ref_id: number;
  }): Promise<boolean> {
    this.assertOwner(input.owner_type, input.owner_id);
    if (!isCreditAction(input.action)) {
      throw new AppError(ErrorCode.InvalidArgument, `action 越行为词汇表：${String(input.action)}`);
    }
    const res = await this.pool.query<{ ok: boolean }>(
      `SELECT EXISTS(
         SELECT 1 FROM credit.credit_events
          WHERE owner_type = $1 AND owner_id = $2 AND action = $3
            AND ref_type = $4 AND ref_id = $5
       ) AS ok`,
      [input.owner_type, input.owner_id, input.action, input.ref_type, input.ref_id],
    );
    return res.rows[0]?.ok === true;
  }

  // ---------- §5 GET /credit/mine（JWT 本人；score + recent_events + active restrictions） ----------

  async getMine(ownerType: OwnerType, ownerId: number): Promise<CreditMineView> {
    this.assertOwner(ownerType, ownerId);
    const [account, events, restrictions] = await Promise.all([
      this.pool.query<{ score: number }>(
        'SELECT score FROM credit.credit_accounts WHERE owner_type = $1 AND owner_id = $2',
        [ownerType, ownerId],
      ),
      this.pool.query<EventRow>(
        `SELECT id, action, delta, rule_version, ref_type, ref_id, created_at FROM credit.credit_events
          WHERE owner_type = $1 AND owner_id = $2 ORDER BY created_at DESC, id DESC LIMIT $3`,
        [ownerType, ownerId, RECENT_EVENTS_LIMIT],
      ),
      this.listActiveRestrictions(ownerType, ownerId),
    ]);
    return {
      // 无账户行=从未被评分 → R-01 初始 100 回显（与 DB DEFAULT 同口径）
      score: account.rows[0]?.score ?? CREDIT_INITIAL_SCORE,
      recent_events: events.rows.map(toEventView),
      restrictions,
    };
  }

  // ---------- §5 GET /credit/restrictions（内部/入口校验面；30s 缓存适配位 R-W2-8） ----------

  /**
   * 活跃限制令查询（C1/C3/A3a 入口拦截的调查询面）：缓存命中窗口内读侧再按 until 过滤
   * （惰性失效 §3——缓存行可能自然到期，应用时钟比对，漂移由 30s TTL 界内吸收）；
   * 未命中回源 DB（until > now()，DB 时钟）并回填缓存（含空数组防穿透）。
   */
  async listActiveRestrictions(ownerType: OwnerType, ownerId: number): Promise<RestrictionView[]> {
    this.assertOwner(ownerType, ownerId);
    const key = { ownerType, ownerId };
    const cached = this.cache.get<RestrictionView[]>(key);
    if (cached) {
      const now = Date.now();
      return cached.filter((r) => new Date(r.until).getTime() > now);
    }
    const res = await this.pool.query<RestrictionRow>(
      `SELECT id, kind, until, reason, created_at FROM credit.credit_restrictions
        WHERE owner_type = $1 AND owner_id = $2 AND until > now() ORDER BY until`,
      [ownerType, ownerId],
    );
    const views = res.rows.map(toRestrictionView);
    this.cache.set(key, views);
    return views;
  }

  // ---------- 内部件 ----------

  private async readScore(
    uow: SqlExecutor,
    ownerType: OwnerType,
    ownerId: number,
  ): Promise<number> {
    const res = await uow.query<{ score: number }>(
      'SELECT score FROM credit.credit_accounts WHERE owner_type = $1 AND owner_id = $2',
      [ownerType, ownerId],
    );
    return res.rows[0]?.score ?? CREDIT_INITIAL_SCORE;
  }

  /** 发行单条限制令：同 kind 未到期（until > now()）幂等跳过（插 0 行返回 null）；新行返回视图 */
  private async issueRestriction(
    uow: SqlExecutor,
    ownerType: OwnerType,
    ownerId: number,
    spec: RestrictionSpec,
    reason: string,
  ): Promise<RestrictionView | null> {
    const res = await uow.query<RestrictionRow>(
      `INSERT INTO credit.credit_restrictions (owner_type, owner_id, kind, until, reason)
       SELECT $1::varchar, $2::bigint, $3::varchar, now() + make_interval(days => $4::int), $5::varchar
       WHERE NOT EXISTS (
         SELECT 1 FROM credit.credit_restrictions r
          WHERE r.owner_type = $1::varchar AND r.owner_id = $2::bigint
            AND r.kind = $3::varchar AND r.until > now()
       )
       RETURNING id, kind, until, reason, created_at`,
      [ownerType, ownerId, spec.kind, spec.days, reason],
    );
    return res.rows[0] ? toRestrictionView(res.rows[0]) : null;
  }

  private assertOwner(ownerType: OwnerType, ownerId: number): void {
    if (!isOwnerType(ownerType)) {
      throw new AppError(
        ErrorCode.InvalidArgument,
        `owner_type 越域（user/lawyer）：${String(ownerType)}`,
      );
    }
    if (!isPositiveInt(ownerId)) {
      throw new AppError(ErrorCode.InvalidArgument, `owner_id 须为正整数：${String(ownerId)}`);
    }
  }
}

function toEventView(row: EventRow): CreditEventView {
  return {
    id: Number(row.id),
    action: row.action,
    delta: row.delta,
    rule_version: row.rule_version,
    ref_type: row.ref_type,
    ref_id: Number(row.ref_id),
    created_at: new Date(row.created_at).toISOString(),
  };
}

function toRestrictionView(row: RestrictionRow): RestrictionView {
  return {
    id: Number(row.id),
    kind: row.kind as RestrictionKind,
    until: new Date(row.until).toISOString(),
    reason: row.reason,
    created_at: new Date(row.created_at).toISOString(),
  };
}
