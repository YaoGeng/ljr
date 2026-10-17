/**
 * C3 报名与支付成团服务（§2/§4/§5/§7 + Task 7 简报裁决）——交易域应用服务导出面（可剥离纪律
 * 同形：只暴露应用服务+事件契约+HTTP 契约；状态机/查询件/退款源/消费者为模块内部件）。
 *
 * 报名下单链（§5 POST 两端点，幂等键=user+ref）：闸口顺序=事务外预检（实名 R-06→G1 限制令→
 * 截止前 30s）→事务内权威判定（行锁重读：状态/joined/deadline 30s 再核）→**同事务原子编排**：
 * INSERT enrollments(PENDING) → F1 createOrderInTx（cash+points 拆分，幂等键=enroll/e{id}/pay）
 * → F4 freezeInTx（积分冻结）——任一失败全回滚（含冻结，简报「会话同一事务性」；T5 发布锁
 * 事务先例同形）。幂等：同键同载荷（points_to_use 全等）重放返回原支付单、异载荷 409
 * E_ENROLL_DUP_KEY（F1 R-02 口径先例）；活跃态唯一由 ux_enroll_active 部分唯一索引物理兜底。
 *
 * 快照（R-03）：price_snapshot 六键 §3 逐字——session_total=违约金基数单一来源；price_version=
 * 报名时点 B3 当前版本号；session_total 模式本席单价按 R-W3-I seatPriceFor（席位序=报名时点
 * joined+1；快照在报名时点固化，支付时点席位漂移不影响——R-03 逐字）。**下界守卫（T4 minor①
 * 交接）**：session_total 模式末位 patch=total−share×(capacity−1)<0 → 400 拒绝该场报名（数据
 * 退化显性化，防卖出负价席——整场拒绝口径，报告注明）。
 *
 * 成团原子守卫（§4，本模块灵魂；onPaySuccess）：**先 UPDATE 后 INSERT 铁律**（顺序反=超卖）——
 *   BEGIN → 行锁锚（enrollment FOR UPDATE 串行化同单重投）→ 席位计数推进（session=UPDATE
 *   joined+1 WHERE status='CREATED' AND joined<capacity RETURNING；groupbuy=行锁 group_buys
 *   后按 PAID 计数判定）→ 0 行/终态 = 满员/终态 ⇒ 自动退款分支（F2 受理+STL 痕+F4 解冻）→
 *   enrollment PENDING→PAID（STL）→ joined==capacity ⇒ C1 markFull（SessionFull 同事务出箱）/
 *   PAID 计数达 sub_min ⇒ C2 groupBuyReachedGuard（REACHED+12h job 预写+GroupBuyReached 出箱）
 *   → F4 settleInTx（积分核销）→ EnrollmentPaid 出箱 COMMIT。
 * 幂等：pay_status 非 PENDING 即短路（Inbox 幂等号+outbox event_id 之上的服务级重放锚）；
 * 并发：同单由行锁串行，异单由席位计数谓词（joined<capacity）保证 2×capacity 恰 capacity 成功。
 *
 * 自动退款分支守恒口径（R-W3-O 关联裁决）：PENDING 源报名退款=**现金原路退（F2 cash-only）+
 * 积分 UNFREEZE 原额回摆**——积分从未核销（PENDING 不 settle），退现必双计/不解冻必冻结泄漏；
 * F4 unfreeze 幂等（同 order 已解冻即短路）正是「流标清场已解冻 + 晚到回调再解冻不双计」的锚。
 * F2 受理先行于终态化（幂等键稳定 refund/po-{id}/enroll-guard；崩溃窗口=重投重放受理后补终态化）。
 */
import { Injectable } from '@nestjs/common';
import {
  AppError,
  ErrorCode,
  ENROLLMENT_PAID_TOPIC,
  type EnrollmentPaidPayload,
  type EnrollmentRefType,
  type Money,
} from '@ljr/shared';
import type { SqlExecutor } from '../../infrastructure/sql';
import { PgPoolService } from '../../infrastructure/sql';
import { OutboxService } from '../../infrastructure/outbox/outbox.service';
import { StateTransitionGuardService } from '../../infrastructure/state-machine/state-transition-guard.service';
import { PointsService } from '../benefits/points.service';
import { CreditService } from '../credit/credit.service';
import { RealnameService } from '../identity/realname.service';
import { PaymentGatewayService } from '../payment/payment.gateway.service';
import { RefundService } from '../payment/refund.service';
import { PricingConfigService } from '../pricing/pricing.service';
import { GroupBuyService } from './group-buy.service';
import { ENROLLMENT_MACHINE, type EnrollmentPayStatus } from './enrollment.machine';
import { EnrollmentQueryService } from './enrollment.query';
import { SessionService } from './session.service';
import { moneyToCents, centsToMoney, seatPriceFor, assertPositiveInt } from './session.types';
import {
  ENROLL_CUTOFF_LEAD_MS,
  autoRefundKey,
  enrollmentOrderKey,
  parsePriceSnapshot,
  type EnrollInput,
  type EnrollResult,
  type EnrollmentMineItem,
  type EnrollmentRefundStatus,
  type EnrollmentRowView,
  type PriceSnapshot,
} from './enrollment.types';

/** enrollments 行（DB 读出形态：numeric::text，jsonb 原值） */
interface EnrollmentRow {
  readonly id: string;
  readonly ref_type: string;
  readonly ref_id: string;
  readonly user_id: string;
  readonly price_snapshot: unknown;
  readonly unit_price: string;
  readonly paid_amount: string;
  readonly cash_amount: string;
  readonly points_amount: number;
  readonly price_version_id: string;
  readonly pay_status: string;
  readonly credit_used: number;
  readonly created_at: Date;
}

const ENROLLMENT_COLS = `id, ref_type, ref_id::text AS ref_id, user_id::text AS user_id, price_snapshot,
  unit_price::text AS unit_price, paid_amount::text AS paid_amount, cash_amount::text AS cash_amount,
  points_amount, price_version_id::text AS price_version_id, pay_status, credit_used, created_at`;

/** C2 拼团行（成团守卫权威判定所需切面） */
interface GroupBuyGuardRow {
  readonly id: string;
  readonly sub_min: number;
  readonly sub_max: number;
  readonly share_price: string;
  readonly deadline: Date;
  readonly status: string;
}

/** 场次行（报名/守卫所需切面） */
interface SessionGuardRow {
  readonly id: string;
  readonly lawyer_id: string;
  readonly price_mode: string;
  readonly unit_price: string;
  readonly session_total: string;
  readonly capacity: number;
  readonly joined: number;
  readonly enroll_deadline: Date;
  readonly status: string;
}

const SESSION_GUARD_COLS = `id, lawyer_id::text AS lawyer_id, price_mode, unit_price::text AS unit_price,
  session_total::text AS session_total, capacity, joined, enroll_deadline, status`;

const GB_GUARD_COLS = `id, sub_min, sub_max, share_price::text AS share_price, deadline, status`;

function toRowView(row: EnrollmentRow): EnrollmentRowView {
  return {
    id: Number(row.id),
    ref_type: row.ref_type as EnrollmentRefType,
    ref_id: Number(row.ref_id),
    user_id: Number(row.user_id),
    price_snapshot: parsePriceSnapshot(row.price_snapshot),
    unit_price: row.unit_price,
    paid_amount: row.paid_amount,
    cash_amount: row.cash_amount,
    points_amount: row.points_amount,
    price_version_id: Number(row.price_version_id),
    pay_status: row.pay_status as EnrollmentPayStatus,
    credit_used: row.credit_used,
    created_at: new Date(row.created_at).toISOString(),
  };
}

function assertRefType(v: unknown): EnrollmentRefType {
  if (v === 'session' || v === 'groupbuy') return v;
  throw new AppError(ErrorCode.InvalidArgument, `ref_type 须为 session|groupbuy：${String(v)}`);
}

/** 非负整数（points_to_use；0=不抵扣） */
function assertNonNegativeInt(v: unknown, field: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || !Number.isSafeInteger(v)) {
    throw new AppError(ErrorCode.InvalidArgument, `${field} 须为非负整数：${JSON.stringify(v)}`);
  }
  return v;
}

/** 守卫探测结果：processed=false=幂等短路（非 PENDING）；refund=true=席位被拒需走自动退款分支 */
export interface PayGuardOutcome {
  readonly processed: boolean;
  readonly refund: boolean;
  readonly enrollment_id: number;
}

@Injectable()
export class EnrollmentService {
  constructor(
    private readonly pool: PgPoolService,
    private readonly outbox: OutboxService,
    private readonly guard: StateTransitionGuardService,
    // 同域导出服务（C1/C2 守卫推进位——禁跨 schema join，架构 §3.2 红线）
    private readonly sessions: SessionService,
    private readonly groupBuys: GroupBuyService,
    // 跨模块消费全部走导出服务（F1/F4/F2/B3/G1/A2）
    private readonly payment: PaymentGatewayService,
    private readonly points: PointsService,
    private readonly refunds: RefundService,
    private readonly pricing: PricingConfigService,
    private readonly credit: CreditService,
    private readonly realname: RealnameService,
    private readonly queries: EnrollmentQueryService,
  ) {}

  // ===========================================================================
  // 报名下单（§5 POST /sessions/{id}/enroll 与 POST /group-buys/{id}/join 同链：
  // 幂等键=user+ref；402 REALNAME_REQUIRED / 403 RESTRICTED / 409 FULL_OR_DEADLINE）
  // ===========================================================================

  async create(input: EnrollInput): Promise<EnrollResult> {
    const refType = assertRefType(input.ref_type);
    const refId = assertPositiveInt(input.ref_id, 'ref_id');
    const userId = assertPositiveInt(input.user_id, 'user_id');
    const pointsToUse =
      input.points_to_use === undefined
        ? 0
        : assertNonNegativeInt(input.points_to_use, 'points_to_use');

    // ---- 闸口①（事务外预检，fail-fast：无效请求不耗外部写路径）——R-06 实名闸口（A2 导出面）
    if (!(await this.realname.isRealnameVerified(userId))) {
      throw new AppError(
        ErrorCode.RealnameRequired,
        `用户 ${userId} 未完成实名认证（R-06），不可报名`,
      );
    }
    // ---- 闸口② G1 限制令（BAN_JOIN=拼单侧限制；SUSPEND_TAKE_*=接单侧锚定律师确认=M2 不拦截）
    const restrictions = await this.credit.listActiveRestrictions('user', userId);
    if (restrictions.some((r) => r.kind === 'BAN_JOIN')) {
      throw new AppError(
        ErrorCode.Restricted,
        `用户 ${userId} 限制拼单令生效中（G1 R-05），不可报名`,
      );
    }

    // ---- 闸口③④（事务外预检）：截止前 30s 停开新单（R-05）+ 满员/REACHED_LOCKED（C1/C2 导出守卫）
    if (refType === 'session') {
      const session = await this.readSession(refId);
      if (!session) throw new AppError(ErrorCode.NotFound, `场次不存在：${refId}`);
      this.assertEnrollWindow(
        session.status,
        session.joined,
        session.capacity,
        session.enroll_deadline,
      );
    } else {
      await this.groupBuys.assertJoinable(refId); // 非 PUBLISHED → 409 E_REACHED_LOCKED（C2 导出守卫）
      const gb = await this.readGroupBuy(refId);
      if (!gb) throw new AppError(ErrorCode.NotFound, `拼团任务不存在：${refId}`);
      if (new Date(gb.deadline).getTime() - ENROLL_CUTOFF_LEAD_MS < Date.now()) {
        throw new AppError(
          ErrorCode.FullOrDeadline,
          `拼团 ${refId} 已过报名截止（截止前 ${ENROLL_CUTOFF_LEAD_MS / 1000}s 停开新单，R-05）`,
        );
      }
      const active = await this.queries.countActive('groupbuy', refId);
      if (active >= gb.sub_max) {
        throw new AppError(
          ErrorCode.FullOrDeadline,
          `拼团 ${refId} 加入数已满（${active}/${gb.sub_max}），不再接受报名`,
        );
      }
    }

    return this.pool.withTransaction(async (uow) => {
      // ---- 幂等权威判定（F1 R-02 口径）：活跃报名行（PENDING+PAID）行锁重读
      const existing = await uow.query<EnrollmentRow>(
        `SELECT ${ENROLLMENT_COLS} FROM trade.enrollments
          WHERE ref_type = $1 AND ref_id = $2 AND user_id = $3
            AND pay_status IN ('PENDING', 'PAID')
          ORDER BY id DESC LIMIT 1 FOR UPDATE`,
        [refType, refId, userId],
      );
      const prev = existing.rows[0];
      if (prev) {
        if (prev.credit_used === pointsToUse) {
          return this.replayResult(toRowView(prev)); // 同键同载荷：幂等重放原支付单
        }
        throw new AppError(
          ErrorCode.EnrollDuplicateKey,
          `报名幂等键冲突：用户 ${userId} 在 ${refType} ${refId} 已有活跃报名（id=${prev.id}）且 points_to_use 不一致`,
        );
      }

      // ---- 事务内权威判定 + 快照解算（行锁重读：预检与权威之间状态可漂移）
      let seatPrice: Money;
      let snapshot: PriceSnapshot;
      if (refType === 'session') {
        const session = await this.lockSession(uow, refId);
        if (!session) throw new AppError(ErrorCode.NotFound, `场次不存在：${refId}`);
        this.assertEnrollWindow(
          session.status,
          session.joined,
          session.capacity,
          session.enroll_deadline,
        );
        const seatNo = session.joined + 1; // 席位序=报名时点下一席（R-W3-I；支付时点漂移不影响快照）
        this.assertSeatPriceDomain(session); // 下界守卫（T4 minor①）：末位 patch<0 → 400 拒绝该场报名
        seatPrice = seatPriceFor(
          {
            price_mode: session.price_mode as 'per_head' | 'session_total',
            unit_price: session.unit_price,
            session_total: session.session_total,
            capacity: session.capacity,
          },
          seatNo,
        );
        snapshot = {
          price_mode: session.price_mode as 'per_head' | 'session_total',
          unit_price: seatPrice,
          share_price: null,
          session_total: session.session_total, // 违约金基数单一来源（§3）
          price_version: await this.currentPricingVersion(Number(session.lawyer_id)),
          snapshot_at: new Date().toISOString(),
        };
      } else {
        const gb = await this.lockGroupBuy(uow, refId);
        if (!gb) throw new AppError(ErrorCode.NotFound, `拼团任务不存在：${refId}`);
        if (gb.status !== 'PUBLISHED') {
          // 权威判定：预检后达线锁人 → REACHED_LOCKED；已终态 → FULL_OR_DEADLINE
          if (['REACHED', 'PENDING_LAWYER', 'CONFIRMED', 'CONVERTED'].includes(gb.status)) {
            throw new AppError(
              ErrorCode.ReachedLocked,
              `拼团 ${refId} 已达最低成团人数锁人（R-05，当前 ${gb.status}），不再接受新加入`,
            );
          }
          throw new AppError(
            ErrorCode.FullOrDeadline,
            `拼团 ${refId} 已终态（当前 ${gb.status}），不再接受报名`,
          );
        }
        if (new Date(gb.deadline).getTime() - ENROLL_CUTOFF_LEAD_MS < Date.now()) {
          throw new AppError(
            ErrorCode.FullOrDeadline,
            `拼团 ${refId} 已过报名截止（截止前 ${ENROLL_CUTOFF_LEAD_MS / 1000}s 停开新单，R-05）`,
          );
        }
        const active = await this.queries.countActive('groupbuy', refId);
        if (active >= gb.sub_max) {
          throw new AppError(
            ErrorCode.FullOrDeadline,
            `拼团 ${refId} 加入数已满（${active}/${gb.sub_max}），不再接受报名`,
          );
        }
        seatPrice = gb.share_price;
        snapshot = {
          price_mode: 'per_head',
          unit_price: gb.share_price,
          share_price: gb.share_price,
          session_total: gb.share_price, // ⚠口径：加入者违约金基数=其分摊总额（D4=M2 消费时校准，报告注明）
          price_version: await this.currentPricingVersionFromGb(uow, refId),
          snapshot_at: new Date().toISOString(),
        };
      }

      const payableCents = moneyToCents(seatPrice);
      const cashCents = payableCents - pointsToUse; // R-04：100 积分=1 元=100 分（1 积分=1 分），cash+points=应付
      if (cashCents < 0) {
        throw new AppError(
          ErrorCode.InvalidArgument,
          `points_to_use 超过应付额：${pointsToUse} 分 > 应付 ${payableCents} 分`,
        );
      }

      // ---- INSERT enrollments(PENDING)（快照固化，R-03）
      const inserted = await uow.query<EnrollmentRow>(
        `INSERT INTO trade.enrollments
           (ref_type, ref_id, user_id, price_snapshot, unit_price, paid_amount,
            cash_amount, points_amount, price_version_id, pay_status, credit_used)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, 'PENDING', $10)
         RETURNING ${ENROLLMENT_COLS}`,
        [
          refType,
          refId,
          userId,
          JSON.stringify(snapshot),
          seatPrice,
          seatPrice,
          centsToMoney(cashCents),
          pointsToUse,
          snapshot.price_version,
          pointsToUse,
        ],
      );
      const row = toRowView(inserted.rows[0]!);

      // ---- F1 同事务下单（cash+points 拆分；幂等键=enroll/e{id}/pay）
      const order = await this.payment.createOrderInTx(uow, {
        biz_type: 'enroll',
        biz_id: row.id,
        cash_amount: centsToMoney(cashCents),
        points_amount: pointsToUse,
        idempotency_key: enrollmentOrderKey(row.id),
      });

      // ---- F4 同事务冻结（R-04 50% 上限/余额 INSUFFICIENT 权威校验在 F4；失败全回滚含本 INSERT）
      if (pointsToUse > 0) {
        await this.points.freezeInTx(uow, {
          user_id: userId,
          payment_order_id: order.payment_order.id,
          points_to_use: pointsToUse,
          order_payable_cents: payableCents,
        });
      }

      return {
        enrollment_id: row.id,
        ref_type: refType,
        ref_id: refId,
        paid_amount: row.paid_amount,
        cash_amount: row.cash_amount,
        points_amount: row.points_amount,
        payment_order: {
          id: order.payment_order.id,
          biz_type: order.payment_order.biz_type,
          biz_id: order.payment_order.biz_id,
          cash_amount: order.payment_order.cash_amount,
          points_amount: order.payment_order.points_amount,
          total: order.payment_order.total,
          status: order.payment_order.status,
        },
        pay_params: order.pay_params as unknown as Record<string, unknown>,
      };
    });
  }

  // ===========================================================================
  // 成团原子守卫（§4；先 UPDATE 后 INSERT 顺序铁律——本模块灵魂）
  // ===========================================================================

  /**
   * 支付成功回调推进（onPaySuccess）：席位被拒时返回 {refund:true}，调用方（回调消费器）
   * 接力自动退款分支（本方法零退款副作用——探测事务无写，分支逻辑单点在 refundIfRejected）。
   * 幂等：pay_status≠PENDING 即 {processed:false}（PAID=重投重放；REFUNDED=分支已处理）。
   */
  async onPaySuccess(enrollmentId: number, orderId: number): Promise<PayGuardOutcome> {
    const id = assertPositiveInt(enrollmentId, 'enrollment_id');
    const poId = assertPositiveInt(orderId, 'order_id');
    return this.pool.withTransaction(async (uow) => {
      // ① 行锁锚：同单重投/并发在此串行（第二笔重读已 PAID → 幂等短路，席位绝不双计）
      const current = await this.lockEnrollment(uow, id);
      if (!current) throw new AppError(ErrorCode.NotFound, `报名不存在：${id}`);
      if (current.pay_status !== 'PENDING') {
        return { processed: false, refund: false, enrollment_id: id };
      }

      // ② 席位计数推进（§4 顺序铁律第一步：先 UPDATE 席位、后报名 PAID——顺序反=超卖）
      let joined: number | null = null;
      let capacity: number | null = null;
      let subMin: number | null = null;
      if (current.ref_type === 'session') {
        const upd = await uow.query<{ joined: number; capacity: number }>(
          `UPDATE trade.sessions SET joined = joined + 1
            WHERE id = $1 AND status = 'CREATED' AND joined < capacity
            RETURNING joined, capacity`,
          [current.ref_id],
        );
        if (upd.rows.length === 0) {
          return { processed: false, refund: true, enrollment_id: id }; // 满员/终态 → 自动退款分支
        }
        joined = upd.rows[0]!.joined;
        capacity = upd.rows[0]!.capacity;
      } else {
        // groupbuy 无计数列（V24 头注⑥）：group_buys 行锁=计数串行化锚（读-迁移-计数原子）；
        // 先于 REACHED 锁人的已报名者支付照常入团（REACHED 只拒新加入，不拒已受理者的回调）
        const gb = await this.lockGroupBuy(uow, current.ref_id);
        if (!gb) throw new AppError(ErrorCode.NotFound, `拼团任务不存在：${current.ref_id}`);
        const CHAIN = ['PUBLISHED', 'REACHED', 'PENDING_LAWYER', 'CONFIRMED'];
        if (!CHAIN.includes(gb.status)) {
          return { processed: false, refund: true, enrollment_id: id }; // 终态（EXPIRED/REJECTED/REFUNDED/CONVERTED）
        }
        subMin = gb.sub_min;
      }

      // ③ enrollment PENDING→PAID（STL 留痕；§4 的「INSERT ...PAID...」=PENDING 行的就地迁移）
      await this.guard.assertTransition(ENROLLMENT_MACHINE, {
        entityId: id,
        from: 'PENDING',
        to: 'PAID',
        reason: 'pay_success',
        uow,
      });
      const updated = await uow.query<EnrollmentRow>(
        `UPDATE trade.enrollments SET pay_status = 'PAID'
          WHERE id = $1 AND pay_status = 'PENDING' RETURNING ${ENROLLMENT_COLS}`,
        [id],
      );
      if (updated.rows.length === 0) {
        throw new AppError(ErrorCode.StateStaleEntity, `报名 ${id} 已被并发迁移`);
      }
      const row = toRowView(updated.rows[0]!);

      // ④ 满员/达线推进（同一事务；C1/C2 导出守卫消费位）
      if (current.ref_type === 'session') {
        if (joined === null || capacity === null) {
          throw new AppError(ErrorCode.InternalError, '场次席位计数缺失（不应触达）');
        }
        if (joined >= capacity) {
          await this.sessions.markFull(current.ref_id, uow); // CREATED→FULL + STL + SessionFull 出箱
        }
      } else if (subMin !== null) {
        const paidCount = await this.queries.countPaid(uow, 'groupbuy', current.ref_id); // **uow 内计数**（独立连接读不到本事务未提交的 PAID 行）
        if (paidCount >= subMin) {
          // REACHED+12h job 预写+GroupBuyReached 出箱（C2 守卫；成团链内=幂等短路）
          await this.groupBuys.groupBuyReachedGuard(current.ref_id, paidCount, uow);
        }
      }

      // ⑤ 积分核销（同事务编排：PENDING 的冻结额随支付成功永久核销；幂等键=order）
      if (row.points_amount > 0) {
        await this.points.settleInTx(uow, { user_id: row.user_id, payment_order_id: poId });
      }

      // ⑥ EnrollmentPaid 出箱（§6；成团守卫事务同箱）
      await this.outbox.recordOutbox(uow, {
        type: ENROLLMENT_PAID_TOPIC,
        payload: {
          ref_type: row.ref_type,
          ref_id: row.ref_id,
          user_id: row.user_id,
          amounts: {
            paid: row.paid_amount,
            cash: row.cash_amount,
            points: row.points_amount,
          },
        } satisfies EnrollmentPaidPayload,
      });
      return { processed: true, refund: false, enrollment_id: id };
    });
  }

  /**
   * 自动退款分支（§4「0 行 ⇒ 满员/终态」；R-01 未成团自动退款；§8 资损不变量的执行面）。
   * 顺序：F2 受理先行（幂等键 refund/po-{id}/enroll-guard，崩溃窗口=重投重放受理）→ 终态化
   * 事务（PENDING→REFUNDED STL + F4 unfreezeInTx 解冻，幂等双保险）。现金原路退+积分原额回摆
   * 的守恒口径见类注。
   */
  async refundIfRejected(enrollmentId: number, orderId: number): Promise<{ refunded: boolean }> {
    const id = assertPositiveInt(enrollmentId, 'enrollment_id');
    const poId = assertPositiveInt(orderId, 'order_id');
    const row = await this.readEnrollment(id);
    if (!row) throw new AppError(ErrorCode.NotFound, `报名不存在：${id}`);
    if (row.pay_status !== 'PENDING') return { refunded: false }; // 幂等：已 PAID/已 REFUNDED 不重退

    // ① F2 受理（现金原路退；积分不退现——PENDING 从未核销，积分走 UNFREEZE 原额回摆）
    await this.refunds.accept({
      order_id: poId,
      user_id: row.user_id,
      cash: row.cash_amount,
      points: 0,
      reason: 'GROUP_FAIL', // 未成团类枚举（F2 §2 九值内；满员溢出/流标后到达同源）
      idempotency_key: autoRefundKey(poId),
    });

    // ② 终态化事务：STL 痕 + 解冻（unfreeze 幂等——流标清场已解冻的再解冻=deduplicated 短路）
    await this.pool.withTransaction(async (uow) => {
      const current = await this.lockEnrollment(uow, id);
      if (!current || current.pay_status !== 'PENDING') return; // 并发胜者已终态化
      await this.guard.assertTransition(ENROLLMENT_MACHINE, {
        entityId: id,
        from: 'PENDING',
        to: 'REFUNDED',
        reason: 'auto_refund_full_or_terminal',
        uow,
      });
      const updated = await uow.query<EnrollmentRow>(
        `UPDATE trade.enrollments SET pay_status = 'REFUNDED'
          WHERE id = $1 AND pay_status = 'PENDING' RETURNING ${ENROLLMENT_COLS}`,
        [id],
      );
      if (updated.rows.length === 0) {
        throw new AppError(ErrorCode.StateStaleEntity, `报名 ${id} 已被并发迁移`);
      }
      if (row.points_amount > 0) {
        await this.points.unfreezeInTx(uow, { user_id: row.user_id, payment_order_id: poId });
      }
    });
    return { refunded: true };
  }

  // ===========================================================================
  // 终态协调（流标清场 R-W3-O / 退款完成收敛）
  // ===========================================================================

  /**
   * 终态未支付清场（SessionFailed/GroupBuyExpired 消费）：PENDING 报名 → F4 UNFREEZE 解冻
   * 积分（幂等）。R-W3-O 裁决执行口径：pay_status **保持 PENDING 不终态化**（三态词汇内无
   * 「钱没收」的终态；REFUNDED 不对）——晚到回调经 onPaySuccess 席位被拒 → refundIfRejected →
   * PENDING→REFUNDED 补上终态（此时解冻已发生，幂等短路不双计）；F1 单保持 CREATED 不发明
   * 关单指令（真通道关单=M2 批）。逐单独立事务（部分失败收集上抛进 relay 重试轨道，重入只补
   * 未解冻单）。
   *
   * ⚠范围扩展（报告偏差节）：GroupBuyExpired（C2 截止流标/发起人取消）与 SessionFailed 同裁决
   * 同机制——发起人取消的检查点只拦「已支付」加入者（R-W3-L/T7 扩展），PENDING 加入者的冻结
   * 积分若不清场将在取消路径永久冻结（W3 可达主线的资冻泄漏），故本清场对两类终态事件同用；
   * F2 侧 GroupBuyExpired 批量退款（PAID 单）仍按 T6 裁决=M2 接线。
   */
  async sweepPendingOnFail(
    refType: EnrollmentRefType,
    refId: number,
  ): Promise<{ swept: number; failed: number }> {
    const id = assertPositiveInt(refId, 'ref_id');
    const rows = await this.pool.query<EnrollmentRow>(
      `SELECT ${ENROLLMENT_COLS} FROM trade.enrollments
        WHERE ref_type = $1 AND ref_id = $2 AND pay_status = 'PENDING'
        ORDER BY id`,
      [assertRefType(refType), id],
    );
    let swept = 0;
    let failed = 0;
    for (const raw of rows.rows) {
      const row = toRowView(raw);
      try {
        if (row.points_amount > 0) {
          const order = await this.payment.findOrderByIdempotencyKey(enrollmentOrderKey(row.id));
          if (!order) {
            throw new AppError(
              ErrorCode.InternalError,
              `报名 ${row.id} 的支付单不可读（幂等键 ${enrollmentOrderKey(row.id)}）`,
            );
          }
          await this.points.unfreeze({
            user_id: row.user_id,
            payment_order_id: order.id,
          });
        }
        swept += 1;
      } catch {
        failed += 1; // 单笔失败不阻断余单（收集计数，整体上抛由消费器决定重试轨道）
      }
    }
    return { swept, failed };
  }

  /** 退款完成收敛（RefundCompleted 消费）：PAID→REFUNDED（STL）；PENDING→REFUNDED 兜底；已终态短路 */
  async advanceToRefunded(enrollmentId: number, reason: string): Promise<{ advanced: boolean }> {
    const id = assertPositiveInt(enrollmentId, 'enrollment_id');
    await this.pool.withTransaction(async (uow) => {
      const current = await this.lockEnrollment(uow, id);
      if (!current || current.pay_status === 'REFUNDED') return; // 幂等短路
      await this.guard.assertTransition(ENROLLMENT_MACHINE, {
        entityId: id,
        from: current.pay_status,
        to: 'REFUNDED',
        reason: reason.slice(0, 200),
        uow,
      });
      const updated = await uow.query<EnrollmentRow>(
        `UPDATE trade.enrollments SET pay_status = 'REFUNDED'
          WHERE id = $1 AND pay_status = $2 RETURNING id`,
        [id, current.pay_status],
      );
      if (updated.rows.length === 0) {
        throw new AppError(ErrorCode.StateStaleEntity, `报名 ${id} 已被并发迁移`);
      }
    });
    return { advanced: true };
  }

  // ===========================================================================
  // 查询面（§5 GET /enrollments/mine：{status, amounts, refund_status}）
  // ===========================================================================

  async listMine(userId: number): Promise<EnrollmentMineItem[]> {
    assertPositiveInt(userId, 'user_id');
    const rows = await this.pool.query<EnrollmentRow>(
      `SELECT ${ENROLLMENT_COLS} FROM trade.enrollments
        WHERE user_id = $1 ORDER BY id DESC LIMIT 100`,
      [userId],
    );
    const items: EnrollmentMineItem[] = [];
    for (const raw of rows.rows) {
      const row = toRowView(raw);
      const order = await this.payment.findOrderByIdempotencyKey(enrollmentOrderKey(row.id));
      let refundStatus: EnrollmentRefundStatus = 'NONE';
      if (row.pay_status === 'REFUNDED') {
        refundStatus = 'REFUNDED';
      } else if (order) {
        const refundRows = await this.refunds.listByOrderId(order.id);
        const latest = refundRows[0]?.status;
        if (latest === 'DONE') refundStatus = 'REFUNDED';
        else if (latest === 'FAILED') refundStatus = 'FAILED';
        else if (latest !== undefined) refundStatus = 'PROCESSING';
      }
      items.push({
        enrollment_id: row.id,
        ref_type: row.ref_type,
        ref_id: row.ref_id,
        status: row.pay_status,
        amounts: { paid: row.paid_amount, cash: row.cash_amount, points: row.points_amount },
        refund_status: refundStatus,
        created_at: row.created_at,
      });
    }
    return items;
  }

  // ===========================================================================
  // 内部件
  // ===========================================================================

  /** R-05 截止窗+满员/状态闸（预检与权威判定共用；409 FULL_OR_DEADLINE 单点收口） */
  private assertEnrollWindow(
    status: string,
    joined: number,
    capacity: number,
    deadline: Date,
  ): void {
    if (status !== 'CREATED' || joined >= capacity) {
      throw new AppError(
        ErrorCode.FullOrDeadline,
        `场次已满员或不在报名中（status=${status}，${joined}/${capacity}）`,
      );
    }
    if (new Date(deadline).getTime() - ENROLL_CUTOFF_LEAD_MS < Date.now()) {
      throw new AppError(
        ErrorCode.FullOrDeadline,
        `已过报名截止（截止前 ${ENROLL_CUTOFF_LEAD_MS / 1000}s 停开新单，R-05）`,
      );
    }
  }

  /**
   * 末位 patch 下界守卫（T4 minor① 交接）：session_total 模式末位席 patch=total−share×
   * (capacity−1)<0 → 400 拒绝该场报名（整场口径：数据退化显性化，防末席负价；现实价格域
   * 不可达的防御位，报告注明）。
   */
  private assertSeatPriceDomain(session: SessionGuardRow): void {
    if (session.price_mode !== 'session_total') return;
    const totalCents = moneyToCents(session.session_total);
    const shareCents = moneyToCents(session.unit_price);
    if (totalCents - shareCents * (session.capacity - 1) < 0) {
      throw new AppError(
        ErrorCode.InvalidArgument,
        `场次 ${session.id} 价格退化：末位席位差额为负（session_total ${session.session_total} < 分摊×(capacity−1)），拒绝报名`,
      );
    }
  }

  /** 幂等重放出参（原支付单+原 pay_params 确定性重建；不重复 INSERT/冻结/出箱） */
  private async replayResult(row: EnrollmentRowView): Promise<EnrollResult> {
    const order = await this.payment.findOrderByIdempotencyKey(enrollmentOrderKey(row.id));
    if (!order) {
      throw new AppError(
        ErrorCode.InternalError,
        `报名 ${row.id} 幂等重放原支付单不可读（不应触达）`,
      );
    }
    const payParams = await this.payment.payParamsFor(order);
    return {
      enrollment_id: row.id,
      ref_type: row.ref_type,
      ref_id: row.ref_id,
      paid_amount: row.paid_amount,
      cash_amount: row.cash_amount,
      points_amount: row.points_amount,
      payment_order: {
        id: order.id,
        biz_type: order.biz_type,
        biz_id: order.biz_id,
        cash_amount: order.cash_amount,
        points_amount: order.points_amount,
        total: order.total,
        status: order.status,
      },
      pay_params: payParams as unknown as Record<string, unknown>,
    };
  }

  /**
   * 快照版本锚：走 getHistory（无缓存读）而非 getCurrentPricing（30s 进程内缓存适配位）——
   * 版本锚是审计口径（R-03 快照「改价后版本可追溯」），30s 陈旧版本会让同批报名锚到旧版本。
   */
  private async currentPricingVersion(lawyerId: number): Promise<number> {
    const history = await this.pricing.getHistory(lawyerId);
    return history[0]?.version ?? 0; // 无任何版本=0（B3 GET /lawyer/{id}/pricing 同口径）
  }

  /** groupbuy 报名的快照版本锚：任务行回链律师（同 schema 读 trade-group-buys 行，禁跨域） */
  private async currentPricingVersionFromGb(uow: SqlExecutor, groupBuyId: number): Promise<number> {
    const res = await uow.query<{ lawyer_id: string }>(
      `SELECT lawyer_id::text AS lawyer_id FROM trade.group_buys WHERE id = $1`,
      [groupBuyId],
    );
    const lawyerId = Number(res.rows[0]!.lawyer_id);
    return this.currentPricingVersion(lawyerId);
  }

  private async readSession(id: number): Promise<SessionGuardRow | null> {
    const res = await this.pool.query<SessionGuardRow>(
      `SELECT ${SESSION_GUARD_COLS} FROM trade.sessions WHERE id = $1`,
      [assertPositiveInt(id, 'session_id')],
    );
    return res.rows[0] ?? null;
  }

  private async readGroupBuy(id: number): Promise<GroupBuyGuardRow | null> {
    const res = await this.pool.query<GroupBuyGuardRow>(
      `SELECT ${GB_GUARD_COLS} FROM trade.group_buys WHERE id = $1`,
      [assertPositiveInt(id, 'group_buy_id')],
    );
    return res.rows[0] ?? null;
  }

  private async lockSession(uow: SqlExecutor, id: number): Promise<SessionGuardRow | null> {
    const res = await uow.query<SessionGuardRow>(
      `SELECT ${SESSION_GUARD_COLS} FROM trade.sessions WHERE id = $1 FOR UPDATE`,
      [assertPositiveInt(id, 'session_id')],
    );
    return res.rows[0] ?? null;
  }

  private async lockGroupBuy(uow: SqlExecutor, id: number): Promise<GroupBuyGuardRow | null> {
    const res = await uow.query<GroupBuyGuardRow>(
      `SELECT ${GB_GUARD_COLS} FROM trade.group_buys WHERE id = $1 FOR UPDATE`,
      [assertPositiveInt(id, 'group_buy_id')],
    );
    return res.rows[0] ?? null;
  }

  private async lockEnrollment(uow: SqlExecutor, id: number): Promise<EnrollmentRowView | null> {
    const res = await uow.query<EnrollmentRow>(
      `SELECT ${ENROLLMENT_COLS} FROM trade.enrollments WHERE id = $1 FOR UPDATE`,
      [assertPositiveInt(id, 'enrollment_id')],
    );
    return res.rows[0] ? toRowView(res.rows[0]) : null;
  }

  private async readEnrollment(id: number): Promise<EnrollmentRowView | null> {
    const res = await this.pool.query<EnrollmentRow>(
      `SELECT ${ENROLLMENT_COLS} FROM trade.enrollments WHERE id = $1`,
      [assertPositiveInt(id, 'enrollment_id')],
    );
    return res.rows[0] ? toRowView(res.rows[0]) : null;
  }
}
