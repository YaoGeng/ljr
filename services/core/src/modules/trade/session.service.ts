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
import { FulfillmentStatsService } from '../fulfillment/fulfillment-stats.service';
import { SESSION_MACHINE, SESSION_TERMINAL_STATUSES, type SessionStatus } from './session.machine';
import { SessionListCache } from './session.cache';
import { TRADE_SESSION_CONFIG, type TradeSessionConfig } from './session.config';
import {
  DEFAULT_CITY,
  SPECIALTY_LABOR_ARBITRATION,
  UNIT_PRICE_MAX_CENTS,
  assertCapacity,
  assertCity,
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
  type Money,
  type PriceMode,
  type SessionDetailView,
  type SessionRoomMode,
  type SessionStatsView,
  type SessionView,
} from './session.types';

interface SessionRow {
  readonly id: string;
  readonly lawyer_id: string;
  readonly mode: string;
  readonly specialty: string;
  readonly city: string;
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

const SESSION_COLS = `id, lawyer_id, mode, specialty, city, slot_start, price_mode, unit_price::text AS unit_price,
  session_total::text AS session_total, capacity, joined, enroll_deadline, room_mode, status, created_at`;

/** 终态集（session.machine SESSION_TERMINAL_STATUSES 的 SQL 形态；幂等/锁口径共用） */
const TERMINAL_STATUSES_SQL = `'FAILED', 'CANCELLED', 'FINISHED', 'SETTLED'`;

/** 成团链（group_rate 分子：已出 CREATED 进入成团后任一状态） */
const GROUPED_STATUSES = ['FULL', 'CONFIRMED', 'OPEN', 'IN_SERVICE', 'FINISHED', 'HOLD', 'SETTLED'];

/** REMIND 系列 job 的 slot_start 前置偏移（I2 目录；executor=D2 已随 M2-W1 T4 装配——
 *  本常量同时是流标作废钩（failOnDeadline）与创建预写（create/createC2BFulfillment）的
 *  jobType 清单单一来源） */
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
    specialty: row.specialty,
    city: row.city,
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

/** 非负整数计数字段（C4 迁移 initial_joined：0=零参与转化合法，无 CAPACITY_MIN 下限） */
function assertNonNegativeCount(v: unknown, field: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || !Number.isSafeInteger(v)) {
    throw new AppError(ErrorCode.InvalidArgument, `${field} 须为非负整数：${JSON.stringify(v)}`);
  }
  return v;
}

@Injectable()
export class SessionService {
  constructor(
    private readonly pool: PgPoolService,
    private readonly outbox: OutboxService,
    private readonly guard: StateTransitionGuardService,
    private readonly scheduler: SchedulerService,
    private readonly locks: SlotLockService,
    // 跨模块消费全部走导出服务（B3/G1/A3a/D3+D6 聚合）——禁跨 schema join（架构 §3.2 红线）
    private readonly pricing: PricingConfigService,
    private readonly credit: CreditService,
    private readonly audit: LawyerQualificationService,
    private readonly cache: SessionListCache,
    // M2-W3 T3：C1 stats attendance/ooo 聚合面（fulfillment 域 owner——平级装配模块，trade.module 注记）
    private readonly fulfillmentStats: FulfillmentStatsService,
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

    // R-W3-G ①（⚠W3-11 决策位：产品若翻转「允许即开即报」走 H7 规则）：slot_start 须为未来时刻
    //（校验先行于 G1/价格 I/O——fail-fast，无效入参不耗外部查询）
    if (slotStart.getTime() <= Date.now()) {
      throw new AppError(ErrorCode.InvalidArgument, 'slot_start 须为未来时刻（不得晚于当前开团）');
    }

    // D3 缺省（⚠04§8-3）：enroll_deadline 缺省=slot_start 前 N 小时（config 可调），律师可改
    const defaultDeadline = new Date(
      slotStart.getTime() - this.config.enrollDeadlineHours * HOUR_MS,
    );
    const deadline = input.enroll_deadline ?? defaultDeadline;
    if (Number.isNaN(deadline.getTime())) {
      throw new AppError(ErrorCode.InvalidArgument, `enroll_deadline 须为有效时刻`);
    }
    if (deadline.getTime() >= slotStart.getTime()) {
      throw new AppError(
        ErrorCode.InvalidArgument,
        'enroll_deadline 须早于 slot_start（截止先于开始）',
      );
    }
    // R-W3-G ②（⚠W3-11）：临期场次（缺省截止已过）必须显式传晚于当前时刻的截止——防「创建即流标」
    // 的静默无效场次；远期场次显式传过去截止不在此列（创建即流标=misfire 自愈口径，执行器用例锚）
    if (defaultDeadline.getTime() <= Date.now()) {
      if (input.enroll_deadline === undefined || deadline.getTime() <= Date.now()) {
        throw new AppError(
          ErrorCode.EnrollDeadlineInvalid,
          `临期场次（开始于 ${slotStart.toISOString()}，缺省截止已过）须显式传晚于当前时刻且早于开始时刻的 enroll_deadline`,
        );
      }
    }

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

    // 双维度物化（序 11.5 V33）：specialty=V1 恒 labor_arbitration 常量（E3 R-04，M2 接线可
    // 配置）；city=律师执业城市经 A3a 导出面 getPracticeCity（禁跨 schema 直查），null 兜底北京
    const specialty = SPECIALTY_LABOR_ARBITRATION;
    const city = (await this.audit.getPracticeCity(lawyerId)) ?? DEFAULT_CITY;

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
           (lawyer_id, mode, specialty, city, slot_start, price_mode, unit_price, session_total,
            capacity, joined, enroll_deadline, room_mode, status)
         VALUES ($1, 'B2C', $2, $3, $4, $5, $6, $7, $8, 0, $9, $10, 'CREATED')
         RETURNING ${SESSION_COLS}`,
        [
          lawyerId,
          specialty,
          city,
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
        initiatorUserId: lawyerId, // B2C 创建即锁：发起人=律师本人；B2 计数集=仅 PENDING_PAYMENT（R-W3-F）→ LOCKED 不计数
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
        // B2 经独立连接落 outbox，不随本回滚丢失）。**防御位（R-W3-F 收窄后）**：B2C 创建即锁
        // LOCKED 不计数，本分支对 B2C 自然流程不可达（触发锚=B2 计数集内的 C2B PENDING_PAYMENT
        // 锁，机制用例归 B2 spec 持有；C1 侧用例经直调注入钉消费方中止契约）。B2C 频控归属=
        // R-W3-H：不设上限（B1 自然边界+G1 BAN_PUBLISH 滥用闸），待澄清备查。
        throw new AppError(
          ErrorCode.RateLimited,
          `时段占用滥用限制（B2 R-03 计数，C2B 待支付锁锚定），本次开团未创建`,
        );
      }

      // I2 job 预写（同事务；ENROLL_DEADLINE 锚 deadline、REMIND×4/ROOM_OPEN 锚 slot_start；
      // ROOM_OPEN executor=D1（M2-W1 T1 装配）、REMIND executor=D2（M2-W1 T4 装配，流标
      // 作废钩见 failOnDeadline）
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

  /**
   * GET /sessions/{id}：详情+剩余席位（capacity - joined）。
   * exec（可选，#42 M2-W2 T3 纯加法）：调用方业务事务句柄——传入时读与调用方事务同快照；
   * 缺省池连接（既有消费端形态，行为不变）。
   */
  async getDetail(id: number, exec?: SqlExecutor): Promise<SessionDetailView> {
    const sessionId = assertPositiveInt(id, 'id');
    const res = await (exec ?? this.pool).query<SessionRow>(
      `SELECT ${SESSION_COLS} FROM trade.sessions WHERE id = $1`,
      [sessionId],
    );
    const row = res.rows[0];
    if (!row) {
      throw new AppError(ErrorCode.NotFound, `场次不存在：${sessionId}`);
    }
    return { ...toView(row), remaining: row.capacity - row.joined };
  }

  /**
   * GET /sessions：公开列表（仅审核 PASSED 律师；缓存 30s 进程内适配位 ⚠沿 W2 形态）。
   * **仅 CREATED（报名中）**（⚠W3-12 决策位 R-W3-J）：公开面只承载「可报名场次」发现——
   * FULL 及成团链/终态场次不出公开列表（详情/律师 stats 不过滤，审计与看板口径不变）。
   */
  async list(filter: ListSessionsFilter): Promise<SessionView[]> {
    const normalized = this.normalizeListFilter(filter);
    const cacheKey = JSON.stringify(normalized);
    const cached = this.cache.get<SessionView[]>(cacheKey);
    if (cached) return cached;

    const clauses: string[] = [`status = 'CREATED'`]; // ⚠W3-12：公开列表仅报名中
    const params: unknown[] = [];
    if (normalized.specialty !== undefined) {
      params.push(normalized.specialty);
      clauses.push(`specialty = $${params.length}`); // 序 11.5：specialty 转真过滤
    }
    if (normalized.city !== undefined) {
      params.push(normalized.city);
      clauses.push(`city = $${params.length}`); // 序 11.5：city 维过滤（与 specialty 双维 AND）
    }
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
  // 律师场次看板（§5 GET /lawyer/sessions/stats：四率——M2-W3 T3 起全真值）
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
      // 无场次：四率一致 null（attendance/ooo 的聚合面窗内零场次同收敛——FulfillmentStatsService 空清单）
      return { enroll_rate: null, group_rate: null, attendance_rate: null, ooo_rate: null };
    }
    // attendance/ooo=M2-W3 T3 接真（W2 复审 §3-⑤）：窗内场次清单（本域窄面，D3 attendanceStats
    // 同款分工）→ fulfillment 聚合导出面（跨域=接口，禁 join——A.4「fulfillment→trade stats」行）
    const sessionIds = await this.sessionIdsOfLawyerBetween(
      lawyerId,
      shanghaiDayStart(fromDate),
      shanghaiDayStart(shanghaiDayAfter(toDate)),
    );
    const [attendanceRate, oooRate] = await Promise.all([
      this.fulfillmentStats.attendanceRateOfSessions(sessionIds),
      this.fulfillmentStats.oooConversionRateOfSessions(sessionIds),
    ]);
    return {
      enroll_rate: rate4(row.joined_sum, row.capacity_sum),
      group_rate: rate4(row.grouped, row.total),
      attendance_rate: attendanceRate,
      ooo_rate: oooRate,
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
  // C2B 履约 Session 创建（R-W3-K 裁决导出位；C4 确认=M2 经此生成，禁直 INSERT）
  // ===========================================================================

  /**
   * C2B 确认后生成履约 Session（§4「CONFIRMED 生成履约 Session」；R-W3-K：同 schema 同域内
   * 服务调用保持「session 创建逻辑单点」——C4=M2 经本方法落 trade.sessions mode='C2B'）。
   * 职责=纯行创建+SessionCreated 出箱+I2 job 同事务预写（ENROLL_DEADLINE/REMIND×4/ROOM_OPEN，
   * 与 B2C 创建同构锚位）；**B2 不加锁**：发布锁 ref=groupbuy 由 C2 持有并占用同段，履约 Session
   * 重复加锁会撞唯一防线——锁迁移/释放语义（groupbuy 锁与 session 锁的衔接）随 C4=M2 设计，
   * 报告注明。价格形态：C2B=每人固定分摊 → price_mode='per_head'、unit_price=share_price 快照、
   * session_total=share_price×capacity（整数分无浮点）。enroll_deadline 缺省=slot_start 前 N 小时
   * （⚠04§8-3 同源口径；已确认场次该列仅作形式承载，报名面不开放）。
   *
   * M2-W2 T4（C4 接线）加法二件：
   *   - initial_joined：迁移参与者的初始席位数（C4 确认事务=capacity/joined 同为参与者数——
   *     满员闭环使 ENROLL_DEADLINE 流标 job 对已确认场次天然 no-op，且 remaining=0 对外
   *     表达「报名面不开放」；joined 写点仍收敛在本创建方法内，不产生独立 UPDATE）；
   *   - uow：调用方业务事务句柄——传入时行创建/预写/出箱与 C4 确认事务（GroupBuy 推进+
   *     enrollment 迁移）同事务原子（§8 迁移事务原子）；缺省=自持事务（既有形态）。
   */
  async createC2BFulfillment(
    input: {
      readonly group_buy_id: number;
      readonly lawyer_id: number;
      readonly slot_start: Date;
      /** R-02 分摊额快照（C2 发布时固化；Money 字符串禁 float） */
      readonly share_price: Money;
      readonly capacity: number;
      readonly room_mode: SessionRoomMode;
      readonly enroll_deadline?: Date;
      /** 初始已占席位（C4 迁移参与者数；缺省 0=既有形态） */
      readonly initial_joined?: number;
    },
    uow?: SqlExecutor,
  ): Promise<SessionView> {
    // group_buy_id 形态校验（回链责任在 C4/M2 的 enrollment 行——架构 §4.1「新建 enrollment 行」，
    // 本方法只承载 Session 行；SessionCreatedPayload 契约 §6 逐字无 group_buy_id，不扩载荷）
    assertPositiveInt(input.group_buy_id, 'group_buy_id');
    const lawyerId = assertPositiveInt(input.lawyer_id, 'lawyer_id');
    if (!(input.slot_start instanceof Date) || Number.isNaN(input.slot_start.getTime())) {
      throw new AppError(
        ErrorCode.InvalidArgument,
        `slot_start 须为有效时刻：${String(input.slot_start)}`,
      );
    }
    const slotStart = input.slot_start;
    const shareCents = moneyToCents(input.share_price); // 形态/越界校验内聚（Money 字符串禁 float）
    const capacity = assertCapacity(input.capacity);
    const roomMode = assertRoomMode(input.room_mode);
    const initialJoined = assertNonNegativeCount(input.initial_joined ?? 0, 'initial_joined');
    if (initialJoined > capacity) {
      throw new AppError(
        ErrorCode.InvalidArgument,
        `initial_joined 超出 capacity（${initialJoined}/${capacity}）`,
      );
    }
    const totalCents = shareCents * capacity;
    this.assertColumnBounds(shareCents, totalCents);
    const deadline =
      input.enroll_deadline ??
      new Date(slotStart.getTime() - this.config.enrollDeadlineHours * HOUR_MS);
    if (Number.isNaN(deadline.getTime())) {
      throw new AppError(ErrorCode.InvalidArgument, 'enroll_deadline 须为有效时刻');
    }
    if (deadline.getTime() >= slotStart.getTime()) {
      throw new AppError(
        ErrorCode.InvalidArgument,
        'enroll_deadline 须早于 slot_start（截止先于开始）',
      );
    }

    const run = async (exec: SqlExecutor): Promise<SessionView> => {
      // 双维度列（序 11.5 V33）：specialty/city 不显式物化——C4=M2 接线位随拼团任务带出，
      // 先落 V33 列默认（labor_arbitration/北京），本批单城单垂直下与 B2C 同值
      const inserted = await exec.query<SessionRow>(
        `INSERT INTO trade.sessions
           (lawyer_id, mode, slot_start, price_mode, unit_price, session_total,
            capacity, joined, enroll_deadline, room_mode, status)
         VALUES ($1, 'C2B', $2, 'per_head', $3, $4, $5, $8, $6, $7, 'CREATED')
         RETURNING ${SESSION_COLS}`,
        [
          lawyerId,
          slotStart,
          input.share_price,
          centsToMoney(totalCents),
          capacity,
          deadline,
          roomMode,
          initialJoined,
        ],
      );
      const row = inserted.rows[0]!;
      const sessionId = Number(row.id);

      // I2 job 预写（与 B2C 创建同构：REMIND×4 锚 slot_start、ENROLL_DEADLINE 锚 deadline、
      // ROOM_OPEN 锚 slot_start——executor=D1/D2 均已随 M2-W1 T1/T4 装配）
      await this.scheduler.registerJob(exec, {
        jobType: 'ENROLL_DEADLINE',
        refType: 'session',
        refId: sessionId,
        dueAt: deadline,
      });
      for (const [jobType, offsetMs] of REMIND_OFFSETS_MS) {
        await this.scheduler.registerJob(exec, {
          jobType,
          refType: 'session',
          refId: sessionId,
          dueAt: new Date(slotStart.getTime() - offsetMs),
        });
      }
      await this.scheduler.registerJob(exec, {
        jobType: 'ROOM_OPEN',
        refType: 'session',
        refId: sessionId,
        dueAt: slotStart,
      });

      // §6：SessionCreated 与创建同事务出箱（业务回滚则事件不出）
      await this.outbox.recordOutbox(exec, {
        type: SESSION_CREATED_TOPIC,
        payload: {
          id: sessionId,
          lawyer_id: lawyerId,
          slot_start: slotStart.toISOString(),
          enroll_deadline: deadline.toISOString(),
        } satisfies SessionCreatedPayload,
      });
      return toView(row);
    };
    return uow ? run(uow) : this.pool.withTransaction(run);
  }

  // ===========================================================================
  // C4 认领转化 Session 创建（mode='B2C'；M2-W2 T4——转化事务的 trade.sessions 唯一写点）
  // ===========================================================================

  /**
   * 认领转化生成的 B2C 场次（C4 §2「高需求 C2B → B2C 场次」；R-W3-K 单点纪律的 B2C 面）：
   * GroupBuy→CONVERTED 同事务创建 mode='B2C' 开放场次——joined=迁移参与者数（占席），
   * capacity=律师转化容量（默认 sub_max，§11），价格=显式覆盖（per_head）或 B3 现值解算
   * （C4 侧完成，本方法只承载行）；specialty/city 从拼团任务物化带出（双维度延续）。
   *
   * 与 B2C create() 的差异（不经 create() 的理由，报告注明）：create() 携带 B2 幂等键
   * （lawyer+slot_start）/G1 BAN_PUBLISH 闸/价格解算等新开团语义——转化场次是既有拼团的
   * 迁移承接，幂等锚=group_buy（C4 侧 CONVERTED 状态短路），不重复走新开团闸。
   *
   * **锁承接**：转化=groupbuy 锁终态（CONVERTED「不再需要占用锁」）→ 调用方先释放 groupbuy
   * 锁后经本方法对同段 lockSlot（refType='session'）——同事务内释放后重占，slot 唯一防线
   * 连续不破。B2C 创建即锁 LOCKED 不计数（R-W3-F），无滥用路径。
   *
   * **ENROLL_DEADLINE 条件预写**：截止已过（临期转化）不注册该 job——避免过期 job 立即
   * misfire 流标掉已迁移参与者的场次（C1 create 用 400 拒绝临期创建承载同一不变量，本路径
   * 是迁移承接而非新开团，选择保留场次+不开放报名：C3 30s 截止闸自然拦新单）。
   */
  async createConvertedB2C(
    input: {
      readonly group_buy_id: number;
      readonly lawyer_id: number;
      readonly slot_start: Date;
      readonly specialty: string;
      readonly city: string;
      readonly price_mode: PriceMode;
      readonly unit_price: Money;
      readonly session_total: Money;
      readonly capacity: number;
      /** 迁移参与者数（占席；< capacity=开放新加入按 B2C 价） */
      readonly initial_joined: number;
      readonly enroll_deadline?: Date;
      readonly room_mode: SessionRoomMode;
    },
    uow?: SqlExecutor,
  ): Promise<SessionView> {
    assertPositiveInt(input.group_buy_id, 'group_buy_id');
    const lawyerId = assertPositiveInt(input.lawyer_id, 'lawyer_id');
    if (!(input.slot_start instanceof Date) || Number.isNaN(input.slot_start.getTime())) {
      throw new AppError(
        ErrorCode.InvalidArgument,
        `slot_start 须为有效时刻：${String(input.slot_start)}`,
      );
    }
    const slotStart = input.slot_start;
    const capacity = assertCapacity(input.capacity);
    const initialJoined = assertNonNegativeCount(input.initial_joined, 'initial_joined');
    if (initialJoined > capacity) {
      throw new AppError(
        ErrorCode.InvalidArgument,
        `initial_joined 超出 capacity（${initialJoined}/${capacity}）`,
      );
    }
    const unitCents = moneyToCents(input.unit_price);
    const totalCents = moneyToCents(input.session_total);
    this.assertColumnBounds(unitCents, totalCents);
    if (input.specialty.length === 0 || input.specialty.length > 32) {
      throw new AppError(ErrorCode.InvalidArgument, 'specialty 须为 1-32 字符（列宽）');
    }
    if (input.city.length === 0 || input.city.length > 32) {
      throw new AppError(ErrorCode.InvalidArgument, 'city 须为 1-32 字符（列宽）');
    }
    // 报名截止缺省=slot_start 前 N 小时（⚠04§8-3 同源口径；临期转化=已过值保留，头注条件预写）
    const deadline =
      input.enroll_deadline ??
      new Date(slotStart.getTime() - this.config.enrollDeadlineHours * HOUR_MS);
    if (Number.isNaN(deadline.getTime())) {
      throw new AppError(ErrorCode.InvalidArgument, 'enroll_deadline 须为有效时刻');
    }
    if (deadline.getTime() >= slotStart.getTime()) {
      throw new AppError(
        ErrorCode.InvalidArgument,
        'enroll_deadline 须早于 slot_start（截止先于开始）',
      );
    }
    const roomMode = assertRoomMode(input.room_mode);

    const run = async (exec: SqlExecutor): Promise<SessionView> => {
      const inserted = await exec.query<SessionRow>(
        `INSERT INTO trade.sessions
           (lawyer_id, mode, specialty, city, slot_start, price_mode, unit_price, session_total,
            capacity, joined, enroll_deadline, room_mode, status)
         VALUES ($1, 'B2C', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'CREATED')
         RETURNING ${SESSION_COLS}`,
        [
          lawyerId,
          input.specialty,
          input.city,
          slotStart,
          input.price_mode,
          input.unit_price,
          input.session_total,
          capacity,
          initialJoined,
          deadline,
          roomMode,
        ],
      );
      const row = inserted.rows[0]!;
      const sessionId = Number(row.id);

      // 锁承接（头注）：同段 groupbuy 锁已由调用方在本事务释放——B2C 场次接管占用
      const locked = await this.locks.lockSlot(exec, {
        lawyerId,
        slotStart,
        initiatorUserId: lawyerId, // B2C 创建即锁：发起人=律师本人（create 同口径）
        refType: 'session',
        refId: sessionId,
      });
      if (!locked.ok) {
        // SLOT_TAKEN=事务毒化整回滚（零残留）；SLOT_ABUSE_LIMIT=B2C LOCKED 不计数（R-W3-F）
        // 的防御位（不可达，机制用例归 B2 spec）
        throw new AppError(
          ErrorCode.SlotTaken,
          `转化场次锁承接失败：律师 ${lawyerId} 在 ${slotStart.toISOString()} 的时段占用异常（${locked.reason}）`,
        );
      }

      // I2 job 预写（与 B2C 创建同构；ENROLL_DEADLINE 条件预写=头注临期口径）
      if (deadline.getTime() > Date.now()) {
        await this.scheduler.registerJob(exec, {
          jobType: 'ENROLL_DEADLINE',
          refType: 'session',
          refId: sessionId,
          dueAt: deadline,
        });
      }
      for (const [jobType, offsetMs] of REMIND_OFFSETS_MS) {
        await this.scheduler.registerJob(exec, {
          jobType,
          refType: 'session',
          refId: sessionId,
          dueAt: new Date(slotStart.getTime() - offsetMs),
        });
      }
      await this.scheduler.registerJob(exec, {
        jobType: 'ROOM_OPEN',
        refType: 'session',
        refId: sessionId,
        dueAt: slotStart,
      });

      await this.outbox.recordOutbox(exec, {
        type: SESSION_CREATED_TOPIC,
        payload: {
          id: sessionId,
          lawyer_id: lawyerId,
          slot_start: slotStart.toISOString(),
          enroll_deadline: deadline.toISOString(),
        } satisfies SessionCreatedPayload,
      });
      return toView(row);
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
   * D1 开房回查锚（M2-W1 T1 纯读导出位）：场次存在且非终态=仍有效可开——ROOM_OPEN 执行器
   * recheck 消费（I2 目录 recheckAnchor「room 状态与开房结果」的场次侧前置半边）。
   * 终态集词汇（SESSION_TERMINAL_STATUSES）不外泄——封装为本布尔面，D1 免 import 本模块机器件。
   *
   * **复合守卫（M2-W3 T5 收口，W2 终审 N-4 逐字）**：openable = 非终态 AND（status != 'CREATED'
   * OR 存在 PAID enrollment OR ENROLL_DEADLINE job 在册）——收紧只作用在 CREATED 态：
   *   - 幽灵场次（CREATED、无 PAID 报名、无在册截止 job——临期转化路径坏孪生/流标 job 丢失
   *     漂移形态）不再开房（recheck=false → ROOM_OPEN job CANCELLED 兜底）；
   *   - 临期转化承接（createConvertedB2C 条件预写不注册截止 job，但迁移参与者 PAID 在册）
   *     与正常 CREATED 场次（创建同事务预写 ENROLL_DEADLINE）均合法放行；
   *   - 成团链 CONFIRMED/FULL/OPEN/IN_SERVICE 等非 CREATED 非终态不受收紧（历史开房链不动）。
   * 「job 在册」经 schedule 域导出面 hasActiveJob（非终态 PENDING|RUNNING 计数，禁跨 schema
   * join）；PAID 半边=本域 enrollments 直查（ref_type='session' 锚）。
   *
   * 历史（W1→W2 口径链，备查）：T1 评审 Minor-3 曾「禁收紧行为」防破坏 FULL 开房链；M-2 注记
   * 揭示临期转化合法产生「截止已过无 job 的 CREATED 承接场次」——两者由本复合守卫统一裁决
   * （非白名单化：CREATED 态以 PAID/job 在册为放行证据，其余非终态不收紧）。
   */
  async sessionOpenable(exec: SqlExecutor, sessionId: number): Promise<boolean> {
    const id = assertPositiveInt(sessionId, 'session_id');
    const status = await this.statusOf(exec, id);
    if (status === null) return false; // 不存在 → false
    if ((SESSION_TERMINAL_STATUSES as readonly SessionStatus[]).includes(status)) {
      return false; // 终态 → false
    }
    if (status !== 'CREATED') return true; // 成团链/其余非终态：不受 CREATED 收紧
    // CREATED 态收紧（N-4）：PAID 报名在册（本域直查）OR 截止 job 在册（schedule 导出面）
    const paid = await exec.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM trade.enrollments
        WHERE ref_type = 'session' AND ref_id = $1 AND pay_status = 'PAID'`,
      [id],
    );
    if ((paid.rows[0]?.n ?? 0) > 0) return true;
    return this.scheduler.hasActiveJob(exec, 'ENROLL_DEADLINE', 'session', id);
  }

  /**
   * 终态布尔面（M2-W2 T3 纯函数加法，D4 消费）：status ∈ 终态集（FAILED/CANCELLED/
   * FINISHED/SETTLED）→ true。sessionOpenable「词汇不外泄——封装为布尔面」同款纪律：
   * D4 取消 API 的 409 NOT_CANCELLABLE 判定经此面，免 import 本模块机器件。
   */
  isTerminalStatus(status: string): boolean {
    return (SESSION_TERMINAL_STATUSES as readonly string[]).includes(status);
  }

  /**
   * D2 提醒回查锚（M2-W1 T4 修复环 I-1）：sessionOpenable 同口径（存在且非终态）**加上**
   * 「报名已截止仍未成团」防御半边——status='CREATED' 且 now>enroll_deadline → false。
   *
   * 耦合声明（头注）：ENROLL_DEADLINE 流标执行器异常进重试退避窗时，CREATED 场次的 REMIND_24H
   * （due=slot_start−24h，与 deadline 同刻同源）若先行拾取会对即将 FAILED 的场次发出幽灵提醒
   * ——本半边在流标 job 终态化之前先行拦截（R-03 幽灵提醒禁令）。成团链（FULL/CONFIRMED/OPEN/
   * IN_SERVICE）不受截止窗影响恒可提醒；**sessionOpenable 已于 M2-W3 T5 对 CREATED 收紧
   * （N-4 复合守卫：PAID 在册 OR 截止 job 在册——开房链口径）**，本面防御半边与之同向
   * （截止已过即拦提醒），两面独立导出不变。
   *
   * **承接反查例外（M-2 裁定已落地，M2-W4 T4b——W3 复审 §3-⑤ 消费项）**：临期转化路径
   * （createConvertedB2C 条件预写）合法产生「截止已过、无 ENROLL_DEADLINE job」的 CREATED
   * 迁移承接场次（REMIND×4 job 已同事务预写）——防御半边对这类场次恒 false 致迁移参与者收不到
   * D2 提醒（M2-W2 T4 M-2 注记缺口）。裁定=承接反查例外放行：本分支内 trade.group_buys.
   * session_id 反查在册（V41 承接锚，建面同事务落值；同 schema 合法直查）即转化承接场次 →
   * true；反查不在册维持 false（「报名已截止仍未成团」幽灵提醒禁令不变——普通 CREATED 的
   * M-2 坏孪生半边不受例外影响）。开房链口径（sessionOpenable）不随本例外变化。
   */
  async sessionRemindable(exec: SqlExecutor, sessionId: number): Promise<boolean> {
    const res = await exec.query<{ status: string; enroll_deadline: Date }>(
      `SELECT status, enroll_deadline FROM trade.sessions WHERE id = $1`,
      [assertPositiveInt(sessionId, 'session_id')],
    );
    const row = res.rows[0];
    if (!row) return false; // 不存在 → false（sessionOpenable 同口径）
    if (
      (SESSION_TERMINAL_STATUSES as readonly SessionStatus[]).includes(row.status as SessionStatus)
    ) {
      return false; // 终态 → false
    }
    if (row.status === 'CREATED' && Date.now() > new Date(row.enroll_deadline).getTime()) {
      // 承接反查例外（M-2 裁定，头注）：group_buys.session_id 在册=转化承接场次放行；
      // 不在册维持 false（幽灵提醒禁令）。同 schema 直查（V41 回链列，禁跨 schema join 不涉）
      const anchored = await exec.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM trade.group_buys WHERE session_id = $1`,
        [sessionId],
      );
      return (anchored.rows[0]?.n ?? 0) > 0;
    }
    return true;
  }

  /**
   * D1 RoomClosed 聚合锚（M2-W1 T1 纯读导出位，加法）：{lawyer_id, firm_id}——close 出箱载荷的
   * 归属半边（gross/payment_order_id 由消费方经 F2 退款源聚合）。firm_id 经 A3a getFirmId
   * （档案绑定，A3b 进件前 null——消费方显式失败口径，不静默）；场次缺失返回 null。
   * exec（可选，#42 M2-W2 T3 纯加法）：sessions 读走调用方事务句柄（同快照）；firm_id 的
   * A3a 读保持池连接（档案行低频变更，非资金聚合列——报告注记）。
   */
  async closeAnchorOf(
    sessionId: number,
    exec?: SqlExecutor,
  ): Promise<{ lawyer_id: number; firm_id: number | null } | null> {
    const id = assertPositiveInt(sessionId, 'session_id');
    const res = await (exec ?? this.pool).query<{ lawyer_id: string }>(
      `SELECT lawyer_id FROM trade.sessions WHERE id = $1`,
      [id],
    );
    const row = res.rows[0];
    if (!row) return null;
    const lawyerId = Number(row.lawyer_id);
    return { lawyer_id: lawyerId, firm_id: await this.audit.getFirmId(lawyerId) };
  }

  /**
   * D3 attendance-stats 查询面的 trade 侧窄面（M2-W2 T2 纯读导出位，加法）：[from,to) 窗内
   * 该律师的场次 id 清单（slot_start 锚、左闭右开——窗口语义=上海日界由 D3 调用方计算后传
   * 时刻）。D3 按 room→session 映射在 fulfillment 域内聚合律师到场行（禁跨 schema join，
   * 架构 §3.2——本面只交付 id 清单）。
   */
  async sessionIdsOfLawyerBetween(lawyerId: number, from: Date, to: Date): Promise<number[]> {
    const lid = assertPositiveInt(lawyerId, 'lawyer_id');
    if (
      !(from instanceof Date) ||
      !(to instanceof Date) ||
      Number.isNaN(from.getTime()) ||
      Number.isNaN(to.getTime())
    ) {
      throw new AppError(ErrorCode.InvalidArgument, 'from/to 须为有效 Date（上海日界窗口）');
    }
    const res = await this.pool.query<{ id: string }>(
      `SELECT id FROM trade.sessions
        WHERE lawyer_id = $1 AND slot_start >= $2 AND slot_start < $3
        ORDER BY id`,
      [lid, from, to],
    );
    return res.rows.map((r) => Number(r.id));
  }

  /**
   * C6 消费位（M1-W3 T9，R-W2-9 在团判定换装的一翼）：该律师有无进行中场次（终态集外，
   * TERMINAL_STATUSES_SQL 同口径）。只读面（池连接）；C6 改价引擎在团判定 =
   * 本方法 OR GroupBuyService.hasActiveGroupBuys（禁跨 schema join，导出服务查询面）。
   */
  async hasActiveSessions(lawyerId: number): Promise<boolean> {
    const res = await this.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM trade.sessions
        WHERE lawyer_id = $1 AND status NOT IN (${TERMINAL_STATUSES_SQL})`,
      [assertPositiveInt(lawyerId, 'lawyer_id')],
    );
    return (res.rows[0]?.n ?? 0) > 0;
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
    // R-03 作废钩（M2-W1 T4 补位，D2 §4「取消/改期/流标 → 业务侧作废未发 job（同事务）」）：
    // 未发 REMIND×4 同事务作废（幽灵提醒禁令；M1 未落，本批纯加法补）。ROOM_OPEN 不在
    // 本钩范围（D1 职责——其 recheck=sessionOpenable 对 FAILED 场次自然 CANCELLED 兜底）。
    // SessionCancelled（用户/平台取消）作废路径=D4/W2（W1 无该事件生产方，交接见 D2 头注）。
    for (const [jobType] of REMIND_OFFSETS_MS) {
      await this.scheduler.cancelJob(uow, { jobType, refType: 'session', refId: id });
    }
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
  // D4 取消推进位（M2-W2 T3：受限入边 CANCELLED 的 trade 侧唯一写点；SessionCancelled
  // 事件出箱归 D4 fulfillment——本面只做状态+锁+job 清场，不代发事件）
  // ===========================================================================

  /**
   * 场次取消推进（D4 §4/§5；session.machine D4 受限入边）：FOR UPDATE 行锁 → 终态
   * {cancelled:false, status}（幂等/409 判定归调用方 D4）→ 守卫迁移 CANCELLED（STL 留痕，
   * reason=调用方携 D4 分支+规则版本，≤128）→ 占用锁同事务释放（架构 §4.2，failOnDeadline
   * 同款）→ 未发 session 锚 job 同事务作废（REMIND×4+ENROLL_DEADLINE+ROOM_OPEN——D2 §4
   * 「取消 → 业务侧作废未发 job」；房间锚 job 归 D4 房间取消步/执行器 recheck 兜底）。
   * 出参 session=迁移后全量视图（D4 载荷锚 slot_start/session_total 取自本读）。
   */
  async cancelSession(
    uow: SqlExecutor,
    sessionId: number,
    reason: string,
  ): Promise<{
    cancelled: boolean;
    status: SessionStatus;
    session: SessionView | null;
  }> {
    const id = assertPositiveInt(sessionId, 'session_id');
    const found = await uow.query<SessionRow>(
      `SELECT ${SESSION_COLS} FROM trade.sessions WHERE id = $1 FOR UPDATE`,
      [id],
    );
    const row = found.rows[0];
    if (!row) throw new AppError(ErrorCode.NotFound, `场次不存在：${id}`);
    const current = row.status as SessionStatus;
    if ((SESSION_TERMINAL_STATUSES as readonly SessionStatus[]).includes(current)) {
      return { cancelled: false, status: current, session: null };
    }
    await this.guard.assertTransition(SESSION_MACHINE, {
      entityId: id,
      from: current,
      to: 'CANCELLED',
      reason,
      uow,
    });
    const updated = await uow.query<SessionRow>(
      `UPDATE trade.sessions SET status = 'CANCELLED', status_since = now()
        WHERE id = $1 AND status = $2 RETURNING ${SESSION_COLS}`,
      [id, current],
    );
    if (updated.rows.length === 0) {
      throw new AppError(ErrorCode.StateStaleEntity, `场次 ${id} 已被并发迁移`);
    }
    // 占用锁同事务释放（CANCELLED=锁终态「不再需要占用锁」，不等 reaper 兜底）
    await this.locks.releaseSlot(uow, {
      refType: 'session',
      refId: id,
      reason: 'session_cancelled',
    });
    // 未发 session 锚 job 作废（幽灵提醒禁令 D2 §4；ROOM_OPEN 对 CANCELLED 的 recheck
    // sessionOpenable 亦兜底，双保险同 failOnDeadline 头注口径）
    for (const [jobType] of REMIND_OFFSETS_MS) {
      await this.scheduler.cancelJob(uow, { jobType, refType: 'session', refId: id });
    }
    await this.scheduler.cancelJob(uow, {
      jobType: 'ENROLL_DEADLINE',
      refType: 'session',
      refId: id,
    });
    await this.scheduler.cancelJob(uow, { jobType: 'ROOM_OPEN', refType: 'session', refId: id });
    return { cancelled: true, status: 'CANCELLED', session: toView(updated.rows[0]!) };
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

  /** 列表筛选归一（400 收口；specialty/city 形态收口且参与真过滤——city×specialty 双维 WHERE，序 11.5） */
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
    const city = filter.city === undefined ? undefined : assertCity(filter.city);
    return {
      specialty: filter.specialty,
      city,
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
