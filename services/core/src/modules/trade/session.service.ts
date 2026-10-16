/**
 * C1 B2C 开团服务（§2/§4/§5/§7 + Task 4 简报裁决）——交易域应用服务导出面（PaymentModule
 * 可剥离纪律同形：只暴露应用服务+事件契约+HTTP 契约，执行器/终态 provider/缓存为模块内部件）。
 *
 * 开团事务（§8「B2 加锁+插入同事务」）：语句序=INSERT sessions → B2 lockSlot（refId=session.id
 * 的鸡生蛋解法——锁行 ref 指向业务实体 id 必须先有 id；同一 DB 事务内原子性不受语句序影响，
 * 简报「加锁+INSERT 同事务」为事务构成描述，报告注明）。拒绝语义（W1 交接纪律）：
 *   - SLOT_TAKEN → 事务已被 23505 毒化，抛 AppError(E_SLOT_TAKEN) 整事务回滚（零业务行）；
 *   - SLOT_ABUSE_LIMIT → 非毒化显式中止，抛 AppError(E_RATE_LIMITED 429) 回滚业务写（R-W3-E
 *     裁决：B2 保持 ok=false 返回形态，滥用中止责任在消费方——本服务即消费方，用例钉住零残留）。
 *
 * 幂等键=lawyer+slot_start（§5，F1 R-02 口径先例）：同键同载荷幂等返回原单、异载荷 409
 * E_SESSION_DUP_KEY。「同载荷」口径=解算后语义字段全等（缺省与显式同值同解，报告注明）；
 * 进行中场次（非终态）才参与幂等——终态场次的同段重开是新场次（终态不再占用锁，B2 唯一
 * 防线已放行；口径自定，报告注明）。并发同段真兜底=B2 ux_slot_active 唯一索引 + R-03 计数。
 *
 * 价格（R-01/R-04）：缺省取 B3 getCurrentPricing 默认（per_head 单价 / session_total 总价，
 * 语义随 price_mode——报告注明口径）；全程整数分运算禁 float；session_total 模式分摊=
 * 总价÷capacity 半分向上。快照只进本表行，不改 B3（用例断言 B3 行原值）。
 *
 * 截止流标（R-03）：ENROLL_DEADLINE 执行器（session.executors）→ failOnDeadline：仍 CREATED
 * 且 joined<capacity → FAILED（STL 留痕）+SessionFailed 出箱+占用锁同事务释放（架构 §4.2
 * 「锁状态迁移与业务状态迁移同一 DB 事务」）；退款指令面=T6 F2（未落位，本批只断言出箱）。
 */
import { Inject, Injectable } from '@nestjs/common';
import {
  AppError,
  ErrorCode,
  SESSION_CREATED_TOPIC,
  SESSION_FAILED_TOPIC,
  SESSION_FULL_TOPIC,
  type SessionCreatedPayload,
  type SessionFailedPayload,
  type SessionFullPayload,
} from '@ljr/shared';
import type { SqlExecutor } from '../../infrastructure/sql';
import { PgPoolService } from '../../infrastructure/sql';
import { OutboxService } from '../../infrastructure/outbox/outbox.service';
import { StateTransitionGuardService } from '../../infrastructure/state-machine/state-transition-guard.service';
import { LawyerQualificationService } from '../identity/lawyer.service';
import { CreditService } from '../credit/credit.service';
import { PricingConfigService } from '../pricing/pricing.service';
import type { ScheduleJobType } from '../schedule/scheduler.catalog';
import { SchedulerService } from '../schedule/scheduler.service';
import { SlotLockService } from '../schedule/slot-lock.service';
import { SESSION_MACHINE, type SessionStatus } from './session.machine';
import { SessionListCache } from './session.cache';
import { TRADE_SESSION_CONFIG, type TradeSessionConfig } from './session.config';
import {
  UNIT_PRICE_MAX_CENTS,
  assertCapacity,
  assertIsoDate,
  assertPositiveInt,
  assertPriceMode,
  assertRoomMode,
  centsToMoney,
  dbNumericToCents,
  moneyToCents,
  shanghaiDayAfter,
  shanghaiDayStart,
  splitTotalIntoUnit,
  type CreateSessionInput,
  type ListSessionsFilter,
  type PriceMode,
  type SessionDetailView,
  type SessionStatsView,
  type SessionView,
} from './session.types';

interface SessionRow {
  readonly id: string;
  readonly lawyer_id: string;
  readonly mode: string;
  readonly slot_start: Date;
  readonly price_mode: string;
  readonly unit_price: string;
  readonly session_total: string;
  readonly capacity: number;
  readonly joined: number;
  readonly enroll_deadline: Date;
  readonly room_mode: string;
  readonly status: string;
  readonly created_at: Date;
}

const SESSION_COLS = `id, lawyer_id, mode, slot_start, price_mode, unit_price::text AS unit_price,
  session_total::text AS session_total, capacity, joined, enroll_deadline, room_mode, status, created_at`;

/** 终态集（session.machine SESSION_TERMINAL_STATUSES 的 SQL 形态；幂等/锁口径共用） */
const TERMINAL_STATUSES_SQL = `'FAILED', 'CANCELLED', 'FINISHED', 'SETTLED'`;

/** 成团链（group_rate 分子：已出 CREATED 进入成团后任一状态） */
const GROUPED_STATUSES = ['FULL', 'CONFIRMED', 'OPEN', 'IN_SERVICE', 'FINISHED', 'HOLD', 'SETTLED'];

/** REMIND 系列 job 的 slot_start 前置偏移（I2 目录；executor=D2=M2 只预写） */
const REMIND_OFFSETS_MS: ReadonlyArray<readonly [ScheduleJobType, number]> = [
  ['REMIND_24H', 24 * 3_600_000],
  ['REMIND_1H', 1 * 3_600_000],
  ['REMIND_10MIN', 10 * 60_000],
  ['REMIND_1MIN', 1 * 60_000],
];

const HOUR_MS = 3_600_000;

function toView(row: SessionRow): SessionView {
  return {
    id: Number(row.id),
    lawyer_id: Number(row.lawyer_id),
    mode: row.mode,
    slot_start: new Date(row.slot_start).toISOString(),
    price_mode: row.price_mode as PriceMode,
    unit_price: row.unit_price,
    session_total: row.session_total,
    capacity: row.capacity,
    joined: row.joined,
    enroll_deadline: new Date(row.enroll_deadline).toISOString(),
    room_mode: row.room_mode,
    status: row.status as SessionStatus,
    created_at: new Date(row.created_at).toISOString(),
  };
}

/** 4 位小数四舍五入（比率展示口径；比率非金额，不受 Money 禁 float 约束——报告注明） */
function rate4(numerator: number, denominator: number): number {
  return Math.round((numerator / denominator) * 10_000) / 10_000;
}

@Injectable()
export class SessionService {
  constructor(
    private readonly pool: PgPoolService,
    private readonly outbox: OutboxService,
    private readonly guard: StateTransitionGuardService,
    private readonly scheduler: SchedulerService,
    private readonly locks: SlotLockService,
    // 跨模块消费全部走导出服务（B3/G1/A3a）——禁跨 schema join（架构 §3.2 红线）
    private readonly pricing: PricingConfigService,
    private readonly credit: CreditService,
    private readonly audit: LawyerQualificationService,
    private readonly cache: SessionListCache,
    // Symbol token（纯 interface 无运行时类型）：module useFactory 装配，测试构造直传
    @Inject(TRADE_SESSION_CONFIG) private readonly config: TradeSessionConfig,
  ) {}

  // ===========================================================================
  // 开团（§5 POST /sessions：幂等键=lawyer+slot_start；409 SLOT_TAKEN / 403 RESTRICTED）
  // ===========================================================================

  async create(input: CreateSessionInput): Promise<SessionView> {
    const lawyerId = assertPositiveInt(input.lawyer_id, 'lawyer_id');
    if (!(input.slot_start instanceof Date) || Number.isNaN(input.slot_start.getTime())) {
      throw new AppError(
        ErrorCode.InvalidArgument,
        `slot_start 须为有效时刻：${String(input.slot_start)}`,
      );
    }
    const slotStart = input.slot_start;
    const priceMode = assertPriceMode(input.price_mode);
    const capacity = assertCapacity(input.capacity);
    const roomMode = assertRoomMode(input.room_mode);
    const unitPriceRaw = input.unit_price === undefined ? null : input.unit_price;

    // R-05 G1 限制令入口校验（/credit/restrictions 查询面缓存适配位 30s，W2 形态）：
    // 仅 BAN_PUBLISH 拦截开团（简报逐字；SUSPEND_TAKE_* 语义=接单侧，⚠决策位报告注明）
    const restrictions = await this.credit.listActiveRestrictions('lawyer', lawyerId);
    if (restrictions.some((r) => r.kind === 'BAN_PUBLISH')) {
      throw new AppError(
        ErrorCode.Restricted,
        `律师 ${lawyerId} 停接限制令生效中（G1 R-05），不可开团`,
      );
    }

    // 价格解算（R-01 缺省取 B3 默认；R-04 基数双模式；整数分全程无浮点）
    const { unitCents, totalCents } = await this.resolvePrices(
      lawyerId,
      priceMode,
      capacity,
      unitPriceRaw,
    );
    this.assertColumnBounds(unitCents, totalCents);

    // D3 缺省（⚠04§8-3）：enroll_deadline 缺省=slot_start 前 N 小时（config 可调），律师可改
    const deadline =
      input.enroll_deadline ??
      new Date(slotStart.getTime() - this.config.enrollDeadlineHours * HOUR_MS);
    if (Number.isNaN(deadline.getTime())) {
      throw new AppError(ErrorCode.InvalidArgument, `enroll_deadline 须为有效时刻`);
    }
    if (deadline.getTime() >= slotStart.getTime()) {
      throw new AppError(
        ErrorCode.InvalidArgument,
        'enroll_deadline 须早于 slot_start（截止先于开始）',
      );
    }

    const view = await this.pool.withTransaction(async (uow) => {
      // 幂等（F1 R-02 口径先例）：同键（lawyer+slot_start，B2C，非终态）同载荷重放原单
      const existing = await uow.query<SessionRow>(
        `SELECT ${SESSION_COLS} FROM trade.sessions
          WHERE lawyer_id = $1 AND slot_start = $2 AND mode = 'B2C'
            AND status NOT IN (${TERMINAL_STATUSES_SQL})
          ORDER BY id DESC LIMIT 1 FOR UPDATE`,
        [lawyerId, slotStart],
      );
      const prev = existing.rows[0];
      if (prev) {
        const samePayload =
          prev.price_mode === priceMode &&
          dbNumericToCents(prev.unit_price) === unitCents &&
          dbNumericToCents(prev.session_total) === totalCents &&
          prev.capacity === capacity &&
          new Date(prev.enroll_deadline).getTime() === deadline.getTime() &&
          prev.room_mode === roomMode;
        if (samePayload) return toView(prev); // 幂等重放（不重复加锁/出事件/预写 job）
        throw new AppError(
          ErrorCode.SessionDuplicateKey,
          `开团幂等键冲突：律师 ${lawyerId} 在 ${slotStart.toISOString()} 已有进行中场次（id=${prev.id}）且载荷不一致`,
        );
      }

      // INSERT sessions（先）→ B2 lockSlot(ref_id=session.id)（后）——同事务原子（类注语句序说明）
      const inserted = await uow.query<SessionRow>(
        `INSERT INTO trade.sessions
           (lawyer_id, mode, slot_start, price_mode, unit_price, session_total,
            capacity, joined, enroll_deadline, room_mode, status)
         VALUES ($1, 'B2C', $2, $3, $4, $5, $6, 0, $7, $8, 'CREATED')
         RETURNING ${SESSION_COLS}`,
        [
          lawyerId,
          slotStart,
          priceMode,
          centsToMoney(unitCents),
          centsToMoney(totalCents),
          capacity,
          deadline,
          roomMode,
        ],
      );
      const row = inserted.rows[0]!;
      const sessionId = Number(row.id);

      // B2 加锁同事务：ok=false 回滚纪律（W1 交接；R-W3-E 裁决=消费方显式中止）
      const locked = await this.locks.lockSlot(uow, {
        lawyerId,
        slotStart,
        initiatorUserId: lawyerId, // B2C 创建即锁：发起人=律师本人（报告 ⚠注明滥用计数含义）
        refType: 'session',
        refId: sessionId,
      });
      if (!locked.ok) {
        if (locked.reason === 'SLOT_TAKEN') {
          // 事务已被 23505 毒化：只能整事务回滚——INSERT 的 sessions 行一并消失（零残留用例钉住）
          throw new AppError(
            ErrorCode.SlotTaken,
            `开团时段已被占用：律师 ${lawyerId} 在 ${slotStart.toISOString()} 的场次已在进行中`,
          );
        }
        // SLOT_ABUSE_LIMIT：非毒化，显式中止——零业务行（R-W3-E 消费方裁决；滥用事件已由
        // B2 经独立连接落 outbox，不随本回滚丢失）
        throw new AppError(
          ErrorCode.RateLimited,
          `时段占用滥用限制（B2 R-03：每发起人同律师进行中锁 ≤1、全局 ≤3），本次开团未创建`,
        );
      }

      // I2 job 预写（同事务；ENROLL_DEADLINE 锚 deadline、REMIND×4/ROOM_OPEN 锚 slot_start；
      // ROOM_OPEN executor=D1=M2、REMIND executor=D2=M2——只预写不装配，简报逐字）
      await this.scheduler.registerJob(uow, {
        jobType: 'ENROLL_DEADLINE',
        refType: 'session',
        refId: sessionId,
        dueAt: deadline,
      });
      for (const [jobType, offsetMs] of REMIND_OFFSETS_MS) {
        await this.scheduler.registerJob(uow, {
          jobType,
          refType: 'session',
          refId: sessionId,
          dueAt: new Date(slotStart.getTime() - offsetMs),
        });
      }
      await this.scheduler.registerJob(uow, {
        jobType: 'ROOM_OPEN',
        refType: 'session',
        refId: sessionId,
        dueAt: slotStart,
      });

      // §6：SessionCreated 与创建同事务出箱（业务回滚则事件不出）
      await this.outbox.recordOutbox(uow, {
        type: SESSION_CREATED_TOPIC,
        payload: {
          id: sessionId,
          lawyer_id: lawyerId,
          slot_start: slotStart.toISOString(),
          enroll_deadline: deadline.toISOString(),
        } satisfies SessionCreatedPayload,
      });
      return toView(row);
    });
    this.cache.invalidateAll(); // 列表写后失效（提交成功后；W2 缓存口径）
    return view;
  }

  // ===========================================================================
  // 查询面（§5 GET /sessions、GET /sessions/{id}；列表仅 PASSED 律师 + 30s 缓存适配位）
  // ===========================================================================

  /** GET /sessions/{id}：详情+剩余席位（capacity - joined） */
  async getDetail(id: number): Promise<SessionDetailView> {
    const sessionId = assertPositiveInt(id, 'id');
    const res = await this.pool.query<SessionRow>(
      `SELECT ${SESSION_COLS} FROM trade.sessions WHERE id = $1`,
      [sessionId],
    );
    const row = res.rows[0];
    if (!row) {
      throw new AppError(ErrorCode.NotFound, `场次不存在：${sessionId}`);
    }
    return { ...toView(row), remaining: row.capacity - row.joined };
  }

  /** GET /sessions：列表（仅审核 PASSED 律师；缓存 30s 进程内适配位 ⚠沿 W2 形态） */
  async list(filter: ListSessionsFilter): Promise<SessionView[]> {
    const normalized = this.normalizeListFilter(filter);
    const cacheKey = JSON.stringify(normalized);
    const cached = this.cache.get<SessionView[]>(cacheKey);
    if (cached) return cached;

    const clauses: string[] = [];
    const params: unknown[] = [];
    if (normalized.lawyer !== undefined) {
      params.push(normalized.lawyer);
      clauses.push(`lawyer_id = $${params.length}`);
    }
    if (normalized.from !== undefined) {
      params.push(shanghaiDayStart(normalized.from));
      clauses.push(`slot_start >= $${params.length}`);
    }
    if (normalized.to !== undefined) {
      params.push(shanghaiDayStart(shanghaiDayAfter(normalized.to)));
      clauses.push(`slot_start < $${params.length}`);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    params.push(500); // 自定护栏：单页上限（§5 未定分页；报告注明）
    const res = await this.pool.query<SessionRow>(
      `SELECT ${SESSION_COLS} FROM trade.sessions ${where} ORDER BY slot_start, id LIMIT $${params.length}`,
      params,
    );

    // 仅 PASSED 律师（A3a isAuditPassed 导出面，禁跨 schema join）：distinct 律师逐个判定
    const lawyerIds = [...new Set(res.rows.map((r) => Number(r.lawyer_id)))];
    const passed = new Map<number, boolean>();
    await Promise.all(
      lawyerIds.map(async (lid) => passed.set(lid, await this.audit.isAuditPassed(lid))),
    );
    const views = res.rows.filter((r) => passed.get(Number(r.lawyer_id)) === true).map(toView);
    this.cache.set(cacheKey, views);
    return views;
  }

  // ===========================================================================
  // 律师场次看板（§5 GET /lawyer/sessions/stats：四率；本批可算两率+两桩）
  // ===========================================================================

  async stats(lawyerId: number, from: string, to: string): Promise<SessionStatsView> {
    assertPositiveInt(lawyerId, 'lawyer_id');
    const fromDate = assertIsoDate(from, 'from');
    const toDate = assertIsoDate(to, 'to');
    if (Date.parse(`${toDate}T00:00:00Z`) < Date.parse(`${fromDate}T00:00:00Z`)) {
      throw new AppError(
        ErrorCode.InvalidArgument,
        `区间倒置（from 须 ≤ to）：${fromDate}..${toDate}`,
      );
    }
    const res = await this.pool.query<{
      total: number;
      grouped: number;
      joined_sum: number;
      capacity_sum: number;
    }>(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE status = ANY($3::varchar[]))::int AS grouped,
              COALESCE(sum(joined), 0)::int AS joined_sum,
              COALESCE(sum(capacity), 0)::int AS capacity_sum
         FROM trade.sessions
        WHERE lawyer_id = $1 AND slot_start >= $2 AND slot_start < $4`,
      [
        lawyerId,
        shanghaiDayStart(fromDate),
        GROUPED_STATUSES,
        shanghaiDayStart(shanghaiDayAfter(toDate)),
      ],
    );
    const row = res.rows[0]!;
    if (row.total === 0) {
      // 无数据：本批可算两率同桩一致返 null（「stats 出数」验收=有场次时出数，用例钉住）
      return { enroll_rate: null, group_rate: null, attendance_rate: null, ooo_rate: null };
    }
    return {
      enroll_rate: rate4(row.joined_sum, row.capacity_sum),
      group_rate: rate4(row.grouped, row.total),
      // 桩标注（§5 出参注释）：attendance 依赖 D3（M2）、ooo 依赖 D6（M2），H4 联调 M2-W2
      attendance_rate: null,
      ooo_rate: null,
    };
  }

  // ===========================================================================
  // markFull：FULL 推进守卫消费位（R-02 满员即成团；C3=T7 在其支付事务内以 uow 调用）
  // ===========================================================================

  /**
   * CREATED→FULL（守卫+STL+SessionFull 同事务）。前置=joined≥capacity（R-02「满员即成团」，
   * 未满 409 Conflict）；joined 计数本身由 C3 成团守卫 SQL（架构 §4.4 原子守卫）推进——本方法
   * 只做状态推进位，不触碰 joined（§9 禁令：joined 唯一写点=C3 守卫路径）。非 CREATED 源态
   * → 守卫拒绝（StateIllegalTransition，拒绝留痕走独立连接）。
   */
  async markFull(sessionId: number, uow?: SqlExecutor): Promise<SessionView> {
    const id = assertPositiveInt(sessionId, 'session_id');
    const run = async (exec: SqlExecutor): Promise<SessionView> => {
      const res = await exec.query<SessionRow>(
        `SELECT ${SESSION_COLS} FROM trade.sessions WHERE id = $1 FOR UPDATE`,
        [id],
      );
      const row = res.rows[0];
      if (!row) throw new AppError(ErrorCode.NotFound, `场次不存在：${id}`);
      if (row.joined < row.capacity) {
        throw new AppError(
          ErrorCode.Conflict,
          `场次 ${id} 未满员（${row.joined}/${row.capacity}），R-02 满员即成团——不可提前 FULL`,
        );
      }
      await this.guard.assertTransition(SESSION_MACHINE, {
        entityId: id,
        from: row.status as SessionStatus,
        to: 'FULL',
        reason: 'enrollment_full',
        uow: exec,
      });
      const updated = await exec.query<SessionRow>(
        `UPDATE trade.sessions SET status = 'FULL', status_since = now()
          WHERE id = $1 AND status = 'CREATED' RETURNING ${SESSION_COLS}`,
        [id],
      );
      if (updated.rows.length === 0) {
        throw new AppError(ErrorCode.StateStaleEntity, `场次 ${id} 已被并发迁移`);
      }
      await this.outbox.recordOutbox(exec, {
        type: SESSION_FULL_TOPIC,
        payload: this.priceRefPayload(updated.rows[0]!) satisfies SessionFullPayload,
      });
      return toView(updated.rows[0]!);
    };
    return uow ? run(uow) : this.pool.withTransaction(run);
  }

  // ===========================================================================
  // ENROLL_DEADLINE 流标判定（R-03；执行器装配见 session.executors，回查锚点=status）
  // ===========================================================================

  /** R-02 幂等回查锚点（I2 目录「场次状态是否仍有效」的字面承载）：仍 CREATED 才需执行 */
  async statusOf(exec: SqlExecutor, sessionId: number): Promise<SessionStatus | null> {
    const res = await exec.query<{ status: string }>(
      `SELECT status FROM trade.sessions WHERE id = $1`,
      [assertPositiveInt(sessionId, 'session_id')],
    );
    const status = res.rows[0]?.status;
    return status === undefined ? null : (status as SessionStatus);
  }

  /**
   * 截止流标：仍 CREATED 且 joined<capacity → FAILED（STL 留痕）+SessionFailed 出箱+
   * 占用锁同事务释放（架构 §4.2；reason=session_failed）。已终态/已满员 → {failed:false}
   * （回查兜底双保险：满员未推进 FULL 属 C3 职责，绝不容截止 job 误杀）。
   */
  async failOnDeadline(
    uow: SqlExecutor,
    sessionId: number,
  ): Promise<{ failed: boolean; session_id: number }> {
    const id = assertPositiveInt(sessionId, 'session_id');
    const res = await uow.query<SessionRow>(
      `SELECT ${SESSION_COLS} FROM trade.sessions WHERE id = $1 FOR UPDATE`,
      [id],
    );
    const row = res.rows[0];
    if (!row || row.status !== 'CREATED' || row.joined >= row.capacity) {
      return { failed: false, session_id: id };
    }
    await this.guard.assertTransition(SESSION_MACHINE, {
      entityId: id,
      from: 'CREATED',
      to: 'FAILED',
      reason: 'enroll_deadline_passed',
      uow,
    });
    const updated = await uow.query<SessionRow>(
      `UPDATE trade.sessions SET status = 'FAILED', status_since = now()
        WHERE id = $1 AND status = 'CREATED' RETURNING ${SESSION_COLS}`,
      [id],
    );
    if (updated.rows.length === 0) {
      throw new AppError(ErrorCode.StateStaleEntity, `场次 ${id} 已被并发迁移`);
    }
    // 锁同事务释放（架构 §4.2）：FAILED=锁终态（「不再需要占用锁」），不等 reaper 兜底
    await this.locks.releaseSlot(uow, { refType: 'session', refId: id, reason: 'session_failed' });
    await this.outbox.recordOutbox(uow, {
      type: SESSION_FAILED_TOPIC,
      payload: {
        ...this.priceRefPayload(updated.rows[0]!),
        reason: 'ENROLL_DEADLINE_PASSED',
      } satisfies SessionFailedPayload,
    });
    return { failed: true, session_id: id };
  }

  // ===========================================================================
  // 内部件
  // ===========================================================================

  /**
   * 价格解算：显式 unit_price 优先（语义随 price_mode：per_head=单价；session_total=开团总价
   * ——§5 契约仅 unit_price 一个价格入参位，报告 ⚠注明）；缺省取 B3 默认（R-01 仅本次有效，
   * B3 行不可变——用例断言）。全部整数分，列宽上限先行 400。
   */
  private async resolvePrices(
    lawyerId: number,
    priceMode: PriceMode,
    capacity: number,
    unitPriceRaw: string | null,
  ): Promise<{ unitCents: number; totalCents: number }> {
    if (unitPriceRaw !== null) {
      const rawCents = moneyToCents(unitPriceRaw);
      return priceMode === 'per_head'
        ? { unitCents: rawCents, totalCents: rawCents * capacity }
        : { totalCents: rawCents, unitCents: splitTotalIntoUnit(rawCents, capacity) };
    }
    const current = await this.pricing.getCurrentPricing(lawyerId);
    if (priceMode === 'per_head') {
      const perHead = current.pricing?.per_head;
      if (perHead === null || perHead === undefined) {
        throw new AppError(
          ErrorCode.InvalidArgument,
          `律师 ${lawyerId} 未提供 unit_price 且 B3 无 per_head 默认价（R-01 缺省价源缺失）`,
        );
      }
      const unitCents = moneyToCents(perHead);
      return { unitCents, totalCents: unitCents * capacity };
    }
    const sessionTotal = current.pricing?.session_total;
    if (sessionTotal === null || sessionTotal === undefined) {
      throw new AppError(
        ErrorCode.InvalidArgument,
        `律师 ${lawyerId} 未提供 unit_price 且 B3 无 session_total 默认价（R-01 缺省价源缺失）`,
      );
    }
    const totalCents = moneyToCents(sessionTotal);
    return { totalCents, unitCents: splitTotalIntoUnit(totalCents, capacity) };
  }

  /** SessionFull/Failed 公共价格快照载荷（shared SessionPriceRefPayload 最小集） */
  private priceRefPayload(row: SessionRow): {
    id: number;
    lawyer_id: number;
    slot_start: string;
    price_mode: PriceMode;
    unit_price: string;
    session_total: string;
  } {
    return {
      id: Number(row.id),
      lawyer_id: Number(row.lawyer_id),
      slot_start: new Date(row.slot_start).toISOString(),
      price_mode: row.price_mode as PriceMode,
      unit_price: row.unit_price,
      session_total: row.session_total,
    };
  }

  /** 列表筛选归一（400 收口；specialty 形态收口但不参与过滤——类型注释与报告注明口径） */
  private normalizeListFilter(filter: ListSessionsFilter): ListSessionsFilter {
    if (filter.specialty !== undefined) {
      if (
        typeof filter.specialty !== 'string' ||
        filter.specialty.length === 0 ||
        filter.specialty.length > 64
      ) {
        throw new AppError(
          ErrorCode.InvalidArgument,
          `specialty 须为 1-64 字符：${JSON.stringify(filter.specialty)}`,
        );
      }
    }
    return {
      specialty: filter.specialty,
      lawyer: filter.lawyer === undefined ? undefined : assertPositiveInt(filter.lawyer, 'lawyer'),
      from: filter.from === undefined ? undefined : assertIsoDate(filter.from, 'from'),
      to: filter.to === undefined ? undefined : assertIsoDate(filter.to, 'to'),
    };
  }

  /** UNIT_PRICE 列宽上限校验落点（resolvePrices 出口统一把关） */
  private assertColumnBounds(unitCents: number, totalCents: number): void {
    if (unitCents > UNIT_PRICE_MAX_CENTS || totalCents > 999_999_999_999) {
      throw new AppError(
        ErrorCode.InvalidArgument,
        '金额超出列宽上限（unit_price numeric(10,2) / session_total numeric(12,2)）',
      );
    }
  }
}
