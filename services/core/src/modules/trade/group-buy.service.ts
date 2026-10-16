/**
 * C2 C2B 拼团服务（§2/§4/§5/§7 + Task 5 简报裁决）——交易域应用服务导出面（可剥离纪律同形：
 * 只暴露应用服务+事件契约+HTTP 契约；状态机/缓存/执行器/终态 provider 为模块内部件）。
 *
 * 发布事务（§8「B2 PENDING_PAYMENT 锁+插入+支付单创建」同事务，架构 §4.2）语句序=
 * INSERT group_buys → F1 createOrderInTx（发起人支付单，share_price 金额）→ B2 lockSlot
 * （payment_order_id 绑定，refId=group_buy.id 的鸡生蛋解法同 C1——锁行 ref 必须先有 id；
 * 同一 DB 事务内原子性不受语句序影响，简报「同事务」为事务构成描述）。拒绝语义（W1 交接纪律）：
 *   - SLOT_TAKEN → 事务已被 23505 毒化，抛 AppError(E_SLOT_TAKEN) 整事务回滚（零业务行：
 *     group_buys/支付单/锁全无，W1 前置②用例钉住）；
 *   - SLOT_ABUSE_LIMIT → 非毒化显式中止，抛 AppError(E_RATE_LIMITED 429)（R-W3-E 消费方裁决；
 *     滥用事件已由 B2 经独立连接落 outbox 不随回滚丢失）。R-W3-F 收窄后计数集=仅 PENDING_PAYMENT
 *     （C2B 发布锁即计数锚：每用户同律师 ≤1、全局 ≤3）——本服务是该防线的自然触发方。
 *
 * 幂等键=user+slot_start（§5，F1 R-02 口径先例）：同键同载荷幂等返回原单、异载荷 409
 * E_GROUP_BUY_DUP_KEY；进行中（非终态）才参与幂等——终态拼团同段重发是新任务（终态不再占用锁，
 * B2 唯一防线已放行）。发起人支付单的 F1 幂等键=groupbuy/g{id}/pay（per-instance）：§5 的
 * user+slot_start 承载在 POST /group-buys 层（本服务幂等查先于 F1 调用）；F1 键若用 user+slot，
 * 「EXPIRED 后同段重新发起/recreate」会同键异载荷撞 E_DUP_KEY 409，破坏 §5 cancel/recreate
 * 契约——口径取舍见任务报告偏差节。
 *
 * 价格（R-01/R-02）：⚠W3-5 裁决=B3 accept_min/accept_max 两字段 NULL（未配置）→ 400
 * E_ACCEPT_RANGE_UNSET（律师须先配置）；越界（含边界矩阵 min-1/min/max/max+1）→ 400
 * E_OUT_OF_RANGE；R-02 分摊=默认场次总价÷sub_min HALF_UP 两位（splitShareCents，发布时固化，
 * 律师后改价不影响——用例断言 B3 改版后行值不变）；share_price 列宽 numeric(10,2) 先行 400。
 *
 * R-05 守卫消费端预留：groupBuyReachedGuard(id, joinedCount)——T7（C3）在 EnrollmentPaid 消费
 * 事务内以成团守卫 SQL 的新计数调用；一次跨两边（PUBLISHED→REACHED=锁人+GroupBuyReached 出箱，
 * REACHED→PENDING_LAWYER=12h 确认窗起点+lawyer_confirm_by 落列+C2B_CONFIRM_TIMEOUT job 同事务
 * 预写），STL 双边留痕；REACHED 即 assertJoinable 拒新加入（E_REACHED_LOCKED）。
 *
 * 取消（R-W3-L 保守裁决）：仅 PUBLISHED 且「无任何已支付加入者」（锁仍 PENDING_PAYMENT 或已
 * TTL 释放=null；锁已 LOCKED/OCCUPIED=有人支付已核销 → 409 E_HAS_JOINED）。取消→锁释放+
 * PUBLISHED→EXPIRED（状态机无 PUBLISHED→CANCELLED 边——EXPIRED+cancel 来源注记：STL reason=
 * initiator_cancelled+GroupBuyExpired.reason=INITIATOR_CANCELLED，报告偏差节记录）。
 */
import { Inject, Injectable } from '@nestjs/common';
import {
  AppError,
  ErrorCode,
  GROUP_BUY_EXPIRED_TOPIC,
  GROUP_BUY_PUBLISHED_TOPIC,
  GROUP_BUY_REACHED_TOPIC,
  LAWYER_REJECTED_TOPIC,
  type GroupBuyExpiredPayload,
  type GroupBuyExpiredReason,
  type GroupBuyPublishedPayload,
  type GroupBuyReachedPayload,
  type LawyerRejectedPayload,
} from '@ljr/shared';
import type { SqlExecutor } from '../../infrastructure/sql';
import { PgPoolService } from '../../infrastructure/sql';
import { OutboxService } from '../../infrastructure/outbox/outbox.service';
import { StateTransitionGuardService } from '../../infrastructure/state-machine/state-transition-guard.service';
import { LawyerQualificationService } from '../identity/lawyer.service';
import { CreditService } from '../credit/credit.service';
import { PricingConfigService } from '../pricing/pricing.service';
import { PaymentGatewayService } from '../payment/payment.gateway.service';
import type { PaymentOrderView } from '../payment/payment.types';
import { SchedulerService } from '../schedule/scheduler.service';
import { SlotLockService } from '../schedule/slot-lock.service';
import { GROUP_BUY_MACHINE, type GroupBuyStatus } from './group-buy.machine';
import { GroupBuyListCache } from './group-buy.cache';
import { TRADE_GROUP_BUY_CONFIG, type TradeGroupBuyConfig } from './group-buy.config';
import {
  SHARE_PRICE_MAX_CENTS,
  assertPositiveInt,
  assertQuestionTags,
  assertSpecialty,
  assertSubRange,
  centsToMoney,
  dbNumericToCents,
  moneyToCents,
  splitShareCents,
  type CreateGroupBuyInput,
  type GroupBuyView,
  type ListGroupBuysFilter,
  type PaymentOrderRefView,
  type PublishGroupBuyResult,
} from './group-buy.types';

interface GroupBuyRow {
  readonly id: string;
  readonly initiator_id: string;
  readonly lawyer_id: string;
  readonly specialty: string;
  readonly slot_start: Date;
  readonly sub_min: number;
  readonly sub_max: number;
  readonly share_price: string;
  readonly question_tags: unknown;
  readonly deadline: Date;
  readonly status: string;
  readonly lawyer_confirm_by: Date | null;
  readonly status_since: Date;
  readonly created_at: Date;
}

const GB_COLS = `id, initiator_id, lawyer_id, specialty, slot_start, sub_min, sub_max,
  share_price::text AS share_price, question_tags, deadline, status, lawyer_confirm_by,
  status_since, created_at`;

/** 终态集（group-buy.machine GROUP_BUY_TERMINAL_STATUSES 的 SQL 形态；幂等/锁口径共用） */
const TERMINAL_STATUSES_SQL = `'EXPIRED', 'REJECTED', 'REFUNDED', 'CONVERTED'`;

/** 已出 PUBLISHED 进入成团链（at-least-once 守卫重放的幂等短路集） */
const REACHED_CHAIN: readonly string[] = ['REACHED', 'PENDING_LAWYER', 'CONFIRMED', 'CONVERTED'];

const HOUR_MS = 3_600_000;

/** 发布锁幂等键的支付单键（F1 幂等键 per-instance 口径，类注） */
const paymentOrderKey = (groupBuyId: number): string => `groupbuy/g${groupBuyId}/pay`;

function toView(row: GroupBuyRow): GroupBuyView {
  return {
    id: Number(row.id),
    initiator_id: Number(row.initiator_id),
    lawyer_id: Number(row.lawyer_id),
    specialty: row.specialty,
    slot_start: new Date(row.slot_start).toISOString(),
    sub_min: row.sub_min,
    sub_max: row.sub_max,
    share_price: row.share_price,
    question_tags: toTags(row.question_tags),
    deadline: new Date(row.deadline).toISOString(),
    status: row.status as GroupBuyStatus,
    lawyer_confirm_by:
      row.lawyer_confirm_by === null ? null : new Date(row.lawyer_confirm_by).toISOString(),
    created_at: new Date(row.created_at).toISOString(),
    joined: null, // 桩：已加入数事实源=C3 enrollments（T7 接线经服务面取数，禁跨 schema join）
  };
}

/** question_tags 出库形态防御（写入侧已校验；漂移=InternalError 显性化，不静默透传残缺数据） */
function toTags(raw: unknown): string[] {
  if (
    !Array.isArray(raw) ||
    raw.some((t) => typeof t !== 'string' || t.length === 0 || t.length > 64)
  ) {
    throw new AppError(
      ErrorCode.InternalError,
      'group_buys.question_tags 出库形态漂移（不应触达）',
    );
  }
  return raw as string[];
}

/** 问题标签同载荷口径：多重选择集语义——排序后逐项比对（顺序不敏感，重复项敏感） */
function sameTags(a: unknown, b: readonly string[]): boolean {
  const left = toTags(a);
  if (left.length !== b.length) return false;
  const norm = (xs: readonly string[]): string => [...xs].sort().join('\u0000');
  return norm(left) === norm(b);
}

function toOrderRef(order: PaymentOrderView): PaymentOrderRefView {
  return {
    id: order.id,
    biz_type: order.biz_type,
    biz_id: order.biz_id,
    cash_amount: order.cash_amount,
    total: order.total,
    status: order.status,
  };
}

/** 发布计划（事务外解算产物：校验+G1+B3 读+价格固化） */
interface PublishPlan {
  readonly initiatorId: number;
  readonly lawyerId: number;
  readonly specialty: string;
  readonly slotStart: Date;
  readonly subMin: number;
  readonly subMax: number;
  readonly tags: string[];
  readonly deadline: Date;
  readonly sharePrice: string;
  readonly shareCents: number;
}

@Injectable()
export class GroupBuyService {
  constructor(
    private readonly pool: PgPoolService,
    private readonly outbox: OutboxService,
    private readonly guard: StateTransitionGuardService,
    private readonly scheduler: SchedulerService,
    private readonly locks: SlotLockService,
    // 跨模块消费全部走导出服务（B3/G1/A3a/F1）——禁跨 schema join（架构 §3.2 红线）
    private readonly pricing: PricingConfigService,
    private readonly credit: CreditService,
    private readonly audit: LawyerQualificationService,
    private readonly payment: PaymentGatewayService,
    private readonly cache: GroupBuyListCache,
    // Symbol token（纯 interface 无运行时类型）：module useFactory 装配，测试构造直传
    @Inject(TRADE_GROUP_BUY_CONFIG) private readonly config: TradeGroupBuyConfig,
  ) {}

  // ===========================================================================
  // 发布（§5 POST /group-buys：幂等键=user+slot_start；409 SLOT_TAKEN / 400 越界 / 403 RESTRICTED）
  // ===========================================================================

  async create(input: CreateGroupBuyInput): Promise<PublishGroupBuyResult> {
    const plan = await this.resolvePublishPlan(input);
    return this.publish(plan);
  }

  // ===========================================================================
  // 查询面（§5 GET /group-buys?specialty=：公开列表仅 PUBLISHED+PASSED 律师+30s 缓存适配位）
  // ===========================================================================

  async list(filter: ListGroupBuysFilter): Promise<GroupBuyView[]> {
    // specialty 形态收口（400）；本批参与真实过滤（specialty 是本表列——与 C1 恒真口径不同，报告注明）
    const specialty =
      filter.specialty === undefined ? undefined : assertSpecialty(filter.specialty);
    const cacheKey = JSON.stringify({ specialty: specialty ?? null });
    const cached = this.cache.get<GroupBuyView[]>(cacheKey);
    if (cached) return cached;

    const clauses: string[] = [`status = 'PUBLISHED'`]; // 公开列表仅拼团中（沿 C1 ⚠W3-12 口径）
    const params: unknown[] = [];
    if (specialty !== undefined) {
      params.push(specialty);
      clauses.push(`specialty = $${params.length}`);
    }
    params.push(500); // 自定护栏：单页上限（§5 未定分页；报告注明）
    const res = await this.pool.query<GroupBuyRow>(
      `SELECT ${GB_COLS} FROM trade.group_buys
        WHERE ${clauses.join(' AND ')} ORDER BY deadline, id LIMIT $${params.length}`,
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
  // R-05 达 sub_min 锁人（守卫消费端预留，T7 在其支付事务内以 uow 调用；合成驱动用例钉住）
  // ===========================================================================

  /**
   * PUBLISHED→REACHED→PENDING_LAWYER（一次跨两边，双侧 STL 留痕）：①REACHED=锁人+GroupBuyReached
   * 出箱（§6 逐字 {id}）；②PENDING_LAWYER=12h 确认窗起点——lawyer_confirm_by=now()+N(h) 落列，
   * C2B_CONFIRM_TIMEOUT job 同事务预写（锚 lawyer_confirm_by）。joinedCount=T7 成团守卫 SQL 的
   * 原子计数（< sub_min → 409）；非 PUBLISHED：成团链内=at-least-once 幂等短路（reached:false），
   * 退款/终态=经守卫拒绝（拒绝留痕走独立连接）。T7 未落位：合成驱动测试消费契约。
   */
  async groupBuyReachedGuard(
    groupBuyId: number,
    joinedCount: number,
    uow?: SqlExecutor,
  ): Promise<{ reached: boolean; group_buy_id: number }> {
    const id = assertPositiveInt(groupBuyId, 'group_buy_id');
    if (!Number.isInteger(joinedCount) || joinedCount < 0) {
      throw new AppError(
        ErrorCode.InvalidArgument,
        `joinedCount 须为非负整数：${JSON.stringify(joinedCount)}`,
      );
    }
    const run = async (exec: SqlExecutor): Promise<{ reached: boolean; group_buy_id: number }> => {
      const row = await this.lockRowForUpdate(exec, id);
      if (!row) throw new AppError(ErrorCode.NotFound, `拼团任务不存在：${id}`);
      if (row.status !== 'PUBLISHED') {
        if (REACHED_CHAIN.includes(row.status)) {
          return { reached: false, group_buy_id: id }; // at-least-once 重放/并发后到：幂等短路
        }
        await this.guard.assertTransition(GROUP_BUY_MACHINE, {
          entityId: id,
          from: row.status as GroupBuyStatus,
          to: 'REACHED',
          reason: 'reached_sub_min',
          uow: exec,
        }); // 退款/终态上不可达：守卫拒绝+留痕
        throw new AppError(
          ErrorCode.StateIllegalTransition,
          `拼团 ${id} 状态 ${row.status} 不可达 REACHED（不应触达）`,
        );
      }
      if (joinedCount < row.sub_min) {
        throw new AppError(
          ErrorCode.Conflict,
          `拼团 ${id} 未达锁人线（${joinedCount}/${row.sub_min}），R-05 达 sub_min 即锁人`,
        );
      }
      await this.guard.assertTransition(GROUP_BUY_MACHINE, {
        entityId: id,
        from: 'PUBLISHED',
        to: 'REACHED',
        reason: 'reached_sub_min',
        uow: exec,
      });
      await this.outbox.recordOutbox(exec, {
        type: GROUP_BUY_REACHED_TOPIC,
        payload: { id } satisfies GroupBuyReachedPayload,
      });
      await this.guard.assertTransition(GROUP_BUY_MACHINE, {
        entityId: id,
        from: 'REACHED',
        to: 'PENDING_LAWYER',
        reason: 'await_lawyer_confirm',
        uow: exec,
      });
      const confirmBy = new Date(Date.now() + this.config.confirmTimeoutHours * HOUR_MS);
      // 一次 UPDATE 落两边（守卫已先后断言 PUBLISHED→REACHED→PENDING_LAWYER 双边并留痕）；
      // 乐观谓词锚=迁移前源态 PUBLISHED（0 行=并发迁移）
      const updated = await exec.query<GroupBuyRow>(
        `UPDATE trade.group_buys
           SET status = 'PENDING_LAWYER', status_since = now(), lawyer_confirm_by = $2
          WHERE id = $1 AND status = 'PUBLISHED' RETURNING ${GB_COLS}`,
        [id, confirmBy],
      );
      if (updated.rows.length === 0) {
        throw new AppError(ErrorCode.StateStaleEntity, `拼团 ${id} 已被并发迁移`);
      }
      await this.scheduler.registerJob(exec, {
        jobType: 'C2B_CONFIRM_TIMEOUT',
        refType: 'groupbuy',
        refId: id,
        dueAt: confirmBy,
      });
      return { reached: true, group_buy_id: id };
    };
    return uow ? run(uow) : this.pool.withTransaction(run);
  }

  /** 加入资格闸（T7 报名/支付前调用）：仅 PUBLISHED 可加入；锁人后/终态 → 409 E_REACHED_LOCKED */
  async assertJoinable(groupBuyId: number): Promise<GroupBuyView> {
    const id = assertPositiveInt(groupBuyId, 'group_buy_id');
    const res = await this.pool.query<GroupBuyRow>(
      `SELECT ${GB_COLS} FROM trade.group_buys WHERE id = $1`,
      [id],
    );
    const row = res.rows[0];
    if (!row) throw new AppError(ErrorCode.NotFound, `拼团任务不存在：${id}`);
    if (row.status !== 'PUBLISHED') {
      throw new AppError(
        ErrorCode.ReachedLocked,
        `拼团 ${id} 已达最低成团人数锁人（R-05，当前 ${row.status}），不再接受新加入`,
      );
    }
    return toView(row);
  }

  // ===========================================================================
  // 发起人取消（§5 POST /group-buys/{id}/cancel：409 HAS_JOINED；R-W3-L 保守裁决）
  // ===========================================================================

  /**
   * 仅 PUBLISHED 且「无任何已支付加入者」可取消（R-W3-L：锁仍 PENDING_PAYMENT=本人未核销，
   * 锁已 TTL 释放=null 同样无已支付者；LOCKED/OCCUPIED=支付已核销 → 409 E_HAS_JOINED——他人
   * 退款路径规格未定义，不发明部分退款，⚠04§8-14 备查）。取消→锁同事务释放+EXPIRED（状态机
   * 无 PUBLISHED→CANCELLED 边：EXPIRED+cancel 来源注记=STL reason=initiator_cancelled+
   * GroupBuyExpired.reason=INITIATOR_CANCELLED，偏差节记录）。
   */
  async cancel(groupBuyId: number, initiatorUserId: number): Promise<{ status: 'EXPIRED' }> {
    const id = assertPositiveInt(groupBuyId, 'group_buy_id');
    const uid = assertPositiveInt(initiatorUserId, 'initiator_user_id');
    return this.pool.withTransaction(async (uow) => {
      const row = await this.lockRowForUpdate(uow, id);
      if (!row || Number(row.initiator_id) !== uid) {
        throw new AppError(ErrorCode.NotFound, `拼团任务不存在：${id}`); // 非发起人不暴露他人物（自定口径，报告注明）
      }
      if (row.status !== 'PUBLISHED') {
        throw new AppError(
          ErrorCode.Conflict,
          `拼团 ${id} 已不在拼团中（当前 ${row.status}），不可取消`,
        );
      }
      const lockStatus = await this.locks.activeStatusOf(uow, 'groupbuy', id);
      if (lockStatus === 'LOCKED' || lockStatus === 'OCCUPIED') {
        throw new AppError(
          ErrorCode.HasJoined,
          `拼团 ${id} 已有已支付加入者，发起人不可单方取消（R-W3-L；走协商/客服 ⚠04§8-14）`,
        );
      }
      await this.guard.assertTransition(GROUP_BUY_MACHINE, {
        entityId: id,
        from: 'PUBLISHED',
        to: 'EXPIRED',
        reason: 'initiator_cancelled',
        uow,
      });
      const updated = await uow.query<GroupBuyRow>(
        `UPDATE trade.group_buys SET status = 'EXPIRED', status_since = now()
          WHERE id = $1 AND status = 'PUBLISHED' RETURNING ${GB_COLS}`,
        [id],
      );
      if (updated.rows.length === 0) {
        throw new AppError(ErrorCode.StateStaleEntity, `拼团 ${id} 已被并发迁移`);
      }
      // 锁同事务释放（架构 §4.2）；TTL 已先释放=ALREADY_RELEASED 良性（锁口径已达成）
      await this.locks.releaseSlot(uow, {
        refType: 'groupbuy',
        refId: id,
        reason: 'group_buy_cancelled',
      });
      await this.outbox.recordOutbox(uow, {
        type: GROUP_BUY_EXPIRED_TOPIC,
        payload: this.expiredPayload(updated.rows[0]!, 'INITIATOR_CANCELLED'),
      });
      return { status: 'EXPIRED' as const };
    });
  }

  // ===========================================================================
  // 一键重新发起（§5 POST /group-buys/{id}/recreate：幂等键=source_id）
  // ===========================================================================

  /**
   * 复制源任务参数（lawyer/specialty/slot/sub 范围/问题标签——R-04 源不可变故载荷恒可复现）为
   * 新任务，走与发布全同的校验/解算/锁/支付单管线（R-01/R-02 按 B3 现值重解算；deadline 缺省
   * 重算=slot_start 前 N 小时——截止是调度参数而非任务配置，复制过期截止会让重发必然无效，
   * 口径取舍报告注明）。幂等键=source_id（F1 R-02 口径）：ux_group_buys_source 唯一兜底，同
   * source 重放=幂等返回已建任务（载荷全由不可变源派生，无异载荷分叉）；源任务状态不变（纯复制）。
   * PUBLISHED 源=锁仍活跃，recreate 撞自己发布锁 → 409 SLOT_TAKEN（不发明隐式取消）。
   */
  async recreate(groupBuyId: number, initiatorUserId: number): Promise<{ group_buy_id: number }> {
    const gid = assertPositiveInt(groupBuyId, 'group_buy_id');
    const uid = assertPositiveInt(initiatorUserId, 'initiator_user_id');

    // 源读取+参数解算在事务外（B3/G1 走导出服务自持连接）；事务内 FOR UPDATE 重读源行串行化
    // 同 source 并发（第二笔在锁上等待→重放检查看到首笔已提交行→幂等返回）
    const source = await this.readRow(gid);
    if (!source || Number(source.initiator_id) !== uid) {
      throw new AppError(ErrorCode.NotFound, `拼团任务不存在：${gid}`); // 非发起人不暴露他人物
    }
    const plan = await this.resolvePublishPlan({
      initiator_id: uid,
      lawyer_id: Number(source.lawyer_id),
      specialty: source.specialty,
      slot_start: new Date(source.slot_start),
      sub_min: source.sub_min,
      sub_max: source.sub_max,
      question_tags: toTags(source.question_tags),
      // deadline 不复制：重发按缺省重算（类注）；临期源经 R-W3-G 400 显性化
    });

    return this.pool.withTransaction(async (uow) => {
      const res = await uow.query<GroupBuyRow>(
        `SELECT ${GB_COLS} FROM trade.group_buys WHERE id = $1 FOR UPDATE`,
        [gid],
      );
      const locked = res.rows[0];
      if (!locked || Number(locked.initiator_id) !== uid) {
        throw new AppError(ErrorCode.NotFound, `拼团任务不存在：${gid}`);
      }
      // 幂等键=source_id：DB 唯一兜底 + 重放返回已建任务（F1 R-02 同键同载荷口径）
      const existing = await uow.query<{ id: string }>(
        `SELECT id FROM trade.group_buys WHERE source_id = $1 ORDER BY id DESC LIMIT 1`,
        [gid],
      );
      if (existing.rows[0]) return { group_buy_id: Number(existing.rows[0].id) };

      const inserted = await uow.query<GroupBuyRow>(
        `INSERT INTO trade.group_buys
           (initiator_id, lawyer_id, specialty, slot_start, sub_min, sub_max, share_price,
            question_tags, deadline, status, source_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, 'PUBLISHED', $10)
         RETURNING ${GB_COLS}`,
        [
          plan.initiatorId,
          plan.lawyerId,
          plan.specialty,
          plan.slotStart,
          plan.subMin,
          plan.subMax,
          plan.sharePrice,
          JSON.stringify(plan.tags),
          plan.deadline,
          gid,
        ],
      );
      const row = inserted.rows[0]!;
      const newId = Number(row.id);

      const order = await this.payment.createOrderInTx(uow, {
        biz_type: 'enroll',
        biz_id: newId,
        cash_amount: plan.sharePrice,
        points_amount: 0,
        idempotency_key: paymentOrderKey(newId),
      });
      const lockResult = await this.locks.lockSlot(uow, {
        lawyerId: plan.lawyerId,
        slotStart: plan.slotStart,
        initiatorUserId: plan.initiatorId,
        refType: 'groupbuy',
        refId: newId,
        paymentOrderId: order.payment_order.id,
      });
      if (!lockResult.ok) {
        throw this.lockRejectError(lockResult.reason, plan.lawyerId, plan.slotStart);
      }
      await this.scheduler.registerJob(uow, {
        jobType: 'ENROLL_DEADLINE',
        refType: 'groupbuy',
        refId: newId,
        dueAt: plan.deadline,
      });
      await this.outbox.recordOutbox(uow, {
        type: GROUP_BUY_PUBLISHED_TOPIC,
        payload: this.publishedPayload(row),
      });
      return { group_buy_id: newId };
    });
  }

  // ===========================================================================
  // 执行器路径（装配见 group-buy.executors / session.executors 分流；回查锚点=statusOf）
  // ===========================================================================

  /** R-02 幂等回查锚点（I2 目录「group_buy 状态」的字面承载）：执行器 recheck 判定用 */
  async statusOf(exec: SqlExecutor, groupBuyId: number): Promise<GroupBuyStatus | null> {
    const res = await exec.query<{ status: string }>(
      `SELECT status FROM trade.group_buys WHERE id = $1`,
      [assertPositiveInt(groupBuyId, 'group_buy_id')],
    );
    const status = res.rows[0]?.status;
    return status === undefined ? null : (status as GroupBuyStatus);
  }

  /**
   * 截止流标（C2 §4 EXPIRED）：仍 PUBLISHED → EXPIRED（STL 留痕）+GroupBuyExpired
   * （DEADLINE_PASSED）出箱+占用锁同事务释放（架构 §4.2）。已终态/已进成团链 → {expired:false}
   * （回查兜底双保险：成团链绝不容截止 job 误杀）。退款指令面=F2（T6 接线，本批断言出箱）。
   */
  async expireOnDeadline(
    uow: SqlExecutor,
    groupBuyId: number,
  ): Promise<{ expired: boolean; group_buy_id: number }> {
    const id = assertPositiveInt(groupBuyId, 'group_buy_id');
    const row = await this.lockRowForUpdate(uow, id);
    if (!row || row.status !== 'PUBLISHED') {
      return { expired: false, group_buy_id: id };
    }
    await this.guard.assertTransition(GROUP_BUY_MACHINE, {
      entityId: id,
      from: 'PUBLISHED',
      to: 'EXPIRED',
      reason: 'enroll_deadline_passed',
      uow,
    });
    const updated = await uow.query<GroupBuyRow>(
      `UPDATE trade.group_buys SET status = 'EXPIRED', status_since = now()
        WHERE id = $1 AND status = 'PUBLISHED' RETURNING ${GB_COLS}`,
      [id],
    );
    if (updated.rows.length === 0) {
      throw new AppError(ErrorCode.StateStaleEntity, `拼团 ${id} 已被并发迁移`);
    }
    await this.locks.releaseSlot(uow, {
      refType: 'groupbuy',
      refId: id,
      reason: 'group_buy_expired',
    });
    await this.outbox.recordOutbox(uow, {
      type: GROUP_BUY_EXPIRED_TOPIC,
      payload: this.expiredPayload(updated.rows[0]!, 'DEADLINE_PASSED'),
    });
    return { expired: true, group_buy_id: id };
  }

  /**
   * 12h 确认超时自动拒（M-1：C2 是 LawyerRejected(via_timeout=true) 生产方；C4 显式拒=M2，
   * via_timeout=false）：仍 PENDING_LAWYER → REJECTED（STL 留痕）+LawyerRejected 出箱（G1 按
   * topic 消费 -5 档）+占用锁同事务释放（架构 §4.2）。
   */
  async confirmTimeout(
    uow: SqlExecutor,
    groupBuyId: number,
  ): Promise<{ rejected: boolean; group_buy_id: number }> {
    const id = assertPositiveInt(groupBuyId, 'group_buy_id');
    const row = await this.lockRowForUpdate(uow, id);
    if (!row || row.status !== 'PENDING_LAWYER') {
      return { rejected: false, group_buy_id: id };
    }
    await this.guard.assertTransition(GROUP_BUY_MACHINE, {
      entityId: id,
      from: 'PENDING_LAWYER',
      to: 'REJECTED',
      reason: 'confirm_timeout',
      uow,
    });
    const updated = await uow.query<GroupBuyRow>(
      `UPDATE trade.group_buys SET status = 'REJECTED', status_since = now()
        WHERE id = $1 AND status = 'PENDING_LAWYER' RETURNING ${GB_COLS}`,
      [id],
    );
    if (updated.rows.length === 0) {
      throw new AppError(ErrorCode.StateStaleEntity, `拼团 ${id} 已被并发迁移`);
    }
    await this.locks.releaseSlot(uow, {
      refType: 'groupbuy',
      refId: id,
      reason: 'group_buy_rejected',
    });
    await this.outbox.recordOutbox(uow, {
      type: LAWYER_REJECTED_TOPIC,
      payload: {
        group_id: id,
        lawyer_id: Number(updated.rows[0]!.lawyer_id),
        via_timeout: true,
      } satisfies LawyerRejectedPayload,
    });
    return { rejected: true, group_buy_id: id };
  }

  // ===========================================================================
  // 内部件
  // ===========================================================================

  /**
   * 发布前解算（事务外）：入参校验 → R-W3-G 时序校验（同 C1 口径）→ G1 BAN_JOIN 入口校验
   * （⚠口径：发起拼团含发起人本人加入=BAN_JOIN 语义；律师 SUSPEND_TAKE_*=接单侧闸口，锚定
   * C4 确认时点=M2，本批不拦截，报告注明）→ B3 接受范围+默认价解算（R-01/R-02）。
   */
  private async resolvePublishPlan(input: CreateGroupBuyInput): Promise<PublishPlan> {
    const initiatorId = assertPositiveInt(input.initiator_id, 'initiator_id');
    const lawyerId = assertPositiveInt(input.lawyer_id, 'lawyer_id');
    const specialty = assertSpecialty(input.specialty);
    if (!(input.slot_start instanceof Date) || Number.isNaN(input.slot_start.getTime())) {
      throw new AppError(
        ErrorCode.InvalidArgument,
        `slot_start 须为有效时刻：${String(input.slot_start)}`,
      );
    }
    const slotStart = input.slot_start;
    // R-W3-G ①（同 C1 口径）：slot_start 须为未来时刻（校验先行于 G1/B3 I/O——fail-fast）
    if (slotStart.getTime() <= Date.now()) {
      throw new AppError(ErrorCode.InvalidArgument, 'slot_start 须为未来时刻（不得晚于当前发布）');
    }
    const { sub_min: subMin, sub_max: subMax } = assertSubRange(input.sub_min, input.sub_max);
    const tags = assertQuestionTags(input.question_tags);

    // D3 缺省（⚠04§8-3）：deadline 缺省=slot_start 前 N 小时（config 可调）
    const defaultDeadline = new Date(
      slotStart.getTime() - this.config.enrollDeadlineHours * HOUR_MS,
    );
    const deadline = input.deadline ?? defaultDeadline;
    if (Number.isNaN(deadline.getTime())) {
      throw new AppError(ErrorCode.InvalidArgument, 'deadline 须为有效时刻');
    }
    if (deadline.getTime() >= slotStart.getTime()) {
      throw new AppError(ErrorCode.InvalidArgument, 'deadline 须早于 slot_start（截止先于开始）');
    }
    // R-W3-G ②（同 C1）：临期拼团（缺省截止已过）必须显式传晚于当前时刻的截止——防「发布即流标」
    // 的静默无效任务；远期任务显式传过去截止不在此列（misfire 自愈口径，执行器用例锚）
    if (defaultDeadline.getTime() <= Date.now()) {
      if (input.deadline === undefined || deadline.getTime() <= Date.now()) {
        throw new AppError(
          ErrorCode.EnrollDeadlineInvalid,
          `临期拼团（开始于 ${slotStart.toISOString()}，缺省截止已过）须显式传晚于当前时刻且早于开始时刻的 deadline`,
        );
      }
    }

    // G1 限制令入口校验（/credit/restrictions 查询面缓存适配位 30s）：BAN_JOIN 拦截发起拼团
    const restrictions = await this.credit.listActiveRestrictions('user', initiatorId);
    if (restrictions.some((r) => r.kind === 'BAN_JOIN')) {
      throw new AppError(
        ErrorCode.Restricted,
        `用户 ${initiatorId} 限制拼单令生效中（G1 R-05），不可发起拼团`,
      );
    }

    // B3 默认配置解算（R-01 接受范围 / R-02 默认场次总价）
    const current = await this.pricing.getCurrentPricing(lawyerId);
    const cfg = current.pricing;
    if (cfg === null || cfg.session_total === null || cfg.session_total === undefined) {
      throw new AppError(
        ErrorCode.InvalidArgument,
        `律师 ${lawyerId} 未配置 B3 默认场次总价（R-02 分摊额解算源缺失）`,
      );
    }
    // ⚠W3-5 裁决：两字段 NULL（未配置）→ 400 E_ACCEPT_RANGE_UNSET（律师须先在 B3 配置）
    if (cfg.accept_min === null || cfg.accept_max === null) {
      throw new AppError(
        ErrorCode.AcceptRangeUnset,
        `律师 ${lawyerId} 未配置接受拼团人数范围（B3 accept_min/accept_max），须先配置后再发起（R-01）`,
      );
    }
    // R-01 子范围 ⊆ B3 接受范围：越界（含边界 min-1/max+1）→ 400 E_OUT_OF_RANGE（§5 契约码）
    if (subMin < cfg.accept_min || subMax > cfg.accept_max) {
      throw new AppError(
        ErrorCode.PriceOutOfRange,
        `子范围越界：${subMin}-${subMax} 超出律师接受拼团范围 ${cfg.accept_min}-${cfg.accept_max}（R-01）`,
      );
    }
    // R-02 分摊额=默认场次总价÷sub_min HALF_UP（发布时固化）；share_price 列宽 numeric(10,2) 先行 400
    const totalCents = moneyToCents(cfg.session_total);
    const shareCents = splitShareCents(totalCents, subMin);
    if (shareCents > SHARE_PRICE_MAX_CENTS) {
      throw new AppError(
        ErrorCode.InvalidArgument,
        '分摊额超出 share_price 列宽上限（numeric(10,2)）',
      );
    }
    return {
      initiatorId,
      lawyerId,
      specialty,
      slotStart,
      subMin,
      subMax,
      tags,
      deadline,
      sharePrice: centsToMoney(shareCents),
      shareCents,
    };
  }

  /** 发布事务（POST /group-buys 主路径）：幂等查→INSERT→支付单→发布锁→截止 job→出箱 */
  private async publish(plan: PublishPlan): Promise<PublishGroupBuyResult> {
    const result = await this.pool.withTransaction(async (uow) => {
      // 幂等（F1 R-02 口径先例）：同键（initiator+slot_start，非终态）同载荷重放原单
      const existing = await uow.query<GroupBuyRow>(
        `SELECT ${GB_COLS} FROM trade.group_buys
          WHERE initiator_id = $1 AND slot_start = $2
            AND status NOT IN (${TERMINAL_STATUSES_SQL})
          ORDER BY id DESC LIMIT 1 FOR UPDATE`,
        [plan.initiatorId, plan.slotStart],
      );
      const prev = existing.rows[0];
      if (prev) {
        const samePayload =
          Number(prev.lawyer_id) === plan.lawyerId &&
          prev.specialty === plan.specialty &&
          prev.sub_min === plan.subMin &&
          prev.sub_max === plan.subMax &&
          sameTags(prev.question_tags, plan.tags) &&
          new Date(prev.deadline).getTime() === plan.deadline.getTime() &&
          dbNumericToCents(prev.share_price) === plan.shareCents;
        if (samePayload) {
          const order = await this.payment.findOrderByIdempotencyKey(
            paymentOrderKey(Number(prev.id)),
          );
          if (!order) {
            throw new AppError(ErrorCode.InternalError, '幂等重放原单支付单不可读（不应触达）');
          }
          return {
            group_buy: toView(prev),
            share_price: prev.share_price,
            payment_order: toOrderRef(order),
          }; // 幂等重放（不重复加锁/出事件/预写 job）
        }
        throw new AppError(
          ErrorCode.GroupBuyDuplicateKey,
          `发起拼团幂等键冲突：用户 ${plan.initiatorId} 在 ${plan.slotStart.toISOString()} 已有进行中拼团（id=${prev.id}）且载荷不一致`,
        );
      }

      // INSERT group_buys（先）→ F1 支付单 → B2 lockSlot(payment_order_id)（后）——同事务原子
      const inserted = await uow.query<GroupBuyRow>(
        `INSERT INTO trade.group_buys
           (initiator_id, lawyer_id, specialty, slot_start, sub_min, sub_max, share_price,
            question_tags, deadline, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, 'PUBLISHED')
         RETURNING ${GB_COLS}`,
        [
          plan.initiatorId,
          plan.lawyerId,
          plan.specialty,
          plan.slotStart,
          plan.subMin,
          plan.subMax,
          plan.sharePrice,
          JSON.stringify(plan.tags),
          plan.deadline,
        ],
      );
      const row = inserted.rows[0]!;
      const gbId = Number(row.id);

      // 发起人支付单（F1 /pay/orders 同事务下单：share_price 金额；F1 键 per-instance，类注）
      const order = await this.payment.createOrderInTx(uow, {
        biz_type: 'enroll',
        biz_id: gbId,
        cash_amount: plan.sharePrice,
        points_amount: 0,
        idempotency_key: paymentOrderKey(gbId),
      });

      // B2 发布锁同事务（PENDING_PAYMENT 形态：绑定支付单 → TTL+SLOT_TTL job 由 B2 自理）：
      // ok=false 回滚纪律（W1 交接；R-W3-E 裁决=消费方显式中止）
      const locked = await this.locks.lockSlot(uow, {
        lawyerId: plan.lawyerId,
        slotStart: plan.slotStart,
        initiatorUserId: plan.initiatorId,
        refType: 'groupbuy',
        refId: gbId,
        paymentOrderId: order.payment_order.id,
      });
      if (!locked.ok) {
        throw this.lockRejectError(locked.reason, plan.lawyerId, plan.slotStart);
      }

      // I2 job 预写（同事务；ENROLL_DEADLINE 锚 deadline，executor=本模块按 ref_type 分流）
      await this.scheduler.registerJob(uow, {
        jobType: 'ENROLL_DEADLINE',
        refType: 'groupbuy',
        refId: gbId,
        dueAt: plan.deadline,
      });

      // §6：GroupBuyPublished 与发布同事务出箱（业务回滚则事件不出）
      await this.outbox.recordOutbox(uow, {
        type: GROUP_BUY_PUBLISHED_TOPIC,
        payload: this.publishedPayload(row),
      });
      return {
        group_buy: toView(row),
        share_price: plan.sharePrice,
        payment_order: toOrderRef(order.payment_order),
      };
    });
    this.cache.invalidateAll(); // 列表写后失效（提交成功后；W2 缓存口径）
    return result;
  }

  /** B2 lockSlot 拒绝 → AppError（SLOT_TAKEN=事务已毒化整回滚；SLOT_ABUSE_LIMIT=显式中止） */
  private lockRejectError(
    reason: 'SLOT_TAKEN' | 'SLOT_ABUSE_LIMIT',
    lawyerId: number,
    slotStart: Date,
  ): AppError {
    if (reason === 'SLOT_TAKEN') {
      return new AppError(
        ErrorCode.SlotTaken,
        `发布时段已被占用：律师 ${lawyerId} 在 ${slotStart.toISOString()} 的场次/拼团已在进行中`,
      );
    }
    return new AppError(
      ErrorCode.RateLimited,
      '时段占用滥用限制（B2 R-03 计数：PENDING_PAYMENT 每用户同律师 ≤1、全局 ≤3），本次发布未创建',
    );
  }

  private publishedPayload(row: GroupBuyRow): GroupBuyPublishedPayload {
    return {
      id: Number(row.id),
      lawyer_id: Number(row.lawyer_id),
      slot_start: new Date(row.slot_start).toISOString(),
      sub_min: row.sub_min,
      share_price: row.share_price,
    };
  }

  private expiredPayload(row: GroupBuyRow, reason: GroupBuyExpiredReason): GroupBuyExpiredPayload {
    return {
      id: Number(row.id),
      lawyer_id: Number(row.lawyer_id),
      initiator_id: Number(row.initiator_id),
      share_price: row.share_price,
      sub_min: row.sub_min,
      reason,
    };
  }

  private async readRow(id: number): Promise<GroupBuyRow | null> {
    const res = await this.pool.query<GroupBuyRow>(
      `SELECT ${GB_COLS} FROM trade.group_buys WHERE id = $1`,
      [id],
    );
    return res.rows[0] ?? null;
  }

  /** 行锁重读（守卫路径第一语句：FOR UPDATE 串行化并发迁移） */
  private async lockRowForUpdate(exec: SqlExecutor, id: number): Promise<GroupBuyRow | null> {
    const res = await exec.query<GroupBuyRow>(
      `SELECT ${GB_COLS} FROM trade.group_buys WHERE id = $1 FOR UPDATE`,
      [id],
    );
    return res.rows[0] ?? null;
  }
}
