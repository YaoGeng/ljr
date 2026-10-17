/**
 * F3 分账结算服务（§2/§4/§5/§7/§10）——settlement 域应用服务导出面（PaymentModule 同款
 * 可剥离纪律：导出面=本应用服务 + shared 事件契约 + HTTP 契约；机器件/闸/消费者/执行器为
 * 模块内部件）。消费点：SettlementConsumer（§6 合成桩+A3b 真事件）与 SettlementExecutors
 * （SETTLE_HOLD_RELEASE，I2 目录在册）。
 *
 * 状态机纪律（§4/架构 §1.3）：全部迁移经 StateTransitionGuardService + STL
 * （entity_type='settlement'，拒绝留痕走独立连接）；「唯一解冻分账节点=READY→SETTLED」（R-01
 * 硬规则）是 runSettlement 独占的守卫边——其余路径（释放/挂起/恢复）无权触达 SETTLED。
 *
 * HOLD 边界（R-02/§10-1）：冻结期到期判定=**DB 钟**（created_at + interval '24 hours' <= now()，
 * 应用钟不参与——firm_merchants 复验双钟闭合同款）；进 HOLD 同事务注册 SETTLE_HOLD_RELEASE
 * job（I2 目录在册：producer/executor=F3，锚=settlements.hold 状态与工单）；工单闸
 * （OpenTicketGate，H3=M2 换装位）报有未结工单则维持 HOLD（hold_reason=OPEN_TICKETS）。
 *
 * 分账构成（§2/R-03/R-06/D20）：建行时按生效 fee_versions 固化 platform_fee 与 fee_version_id
 * （版本漂移不影响已建行）；RUN_SETTLE 时 composeSplits（Σsplits=net=gross−penalty 构成恒等式）→
 * F1 /pay/split 指令面（幂等键=ref_type+ref_id 派生 settle/{ref}-{id}/split）→ READY→SETTLED +
 * SplitSettled 出箱。R-05：违约金不进 platform_fee（费恒按建行口径，penalty 只减律师净额）。
 *
 * 违约扣减（R-04/§5 APPLY_PENALTY/R-W3-A）：W3 带金额入参（调用方 D4=M2 自备 C3 快照金额；
 * 「按 base_ref 回查快照」=M2 换装位，入参快照落 deduction_detail 留痕）。扣减顺序：待结算余额
 * （本域 unsettled 行 net 合计，FIFO 摊扣行 penalty）→ 保证金专户（F1 /pay/deduct from=settlement|
 * deposit 服务面）；通道 INSUFFICIENT 业务应答=该腿 SHORTFALL 留痕并顺次补足；残余=挂欠款 →
 * SettlementDebtIncurred 出箱（G1 SUSPEND_TAKE 消费位=M2 联调，F3 侧只出箱）+ deduction_detail。
 * F1 指令幂等键：结算腿=原键（penalty/ 域约束），保证金腿=首段换 deposit（防同键异 detail 409）。
 * ⚠通道指令在业务事务内（deposit.service 同款形态；mock 同步确认；真实通道 M2 换装时经
 * outbox/Inbox 舞蹈承接崩溃窗口）。
 *
 * 进件前置（R-07）：RUN_SETTLE 前 assertSplittable（A3a 导出查询面，CHANGING 同拒）——非 ACTIVE
 * → 挂起 SUSPENDED（hold_reason=MERCHANT_NOT_ACTIVE）不分账；FirmMerchantSuspended 事件驱动
 * suspendForFirm 全量挂起、FirmMerchantActivated 驱动 resumeForFirm 重入（释放条件满足→READY→
 * 重驱动分账；未满足→回 HOLD + job 重注册，锚仍=created_at）。
 */
import { Injectable, Logger } from '@nestjs/common';
import {
  AppError,
  ErrorCode,
  SETTLEMENT_DEBT_INCURRED_TOPIC,
  SETTLEMENT_HELD_TOPIC,
  SETTLEMENT_RELEASED_TOPIC,
  SPLIT_SETTLED_TOPIC,
  isValidIdempotencyKey,
  type Money,
  type SettlementDebtIncurredPayload,
  type SettlementHeldPayload,
  type SettlementReleasedPayload,
  type SettlementSplitItem,
  type SplitSettledPayload,
} from '@ljr/shared';
import type { SqlExecutor } from '../../infrastructure/sql';
import { PgPoolService } from '../../infrastructure/sql';
import { OutboxService } from '../../infrastructure/outbox/outbox.service';
import { StateTransitionGuardService } from '../../infrastructure/state-machine/state-transition-guard.service';
import { SchedulerService } from '../schedule/scheduler.service';
import { FirmMerchantService } from '../payment/firm-merchant.service';
import { PaymentGatewayService } from '../payment/payment.gateway.service';
import { SETTLEMENT_MACHINE, type SettlementStatus } from './settlement.machine';
import { OpenTicketGate } from './settlement.gate';
import {
  SETTLEMENT_REF_TYPES,
  centsToMoney,
  composeSplits,
  dbNumericToCents,
  moneyToCents,
  platformFeeCents,
  type ApplyPenaltyInput,
  type ApplyPenaltyResult,
  type DeductionLeg,
  type EnterSettlementInput,
  type MarkAbsenceResult,
  type ReleaseHoldResult,
  type RunSettleResult,
  type SettlementDeductionDetail,
  type SettlementRefType,
  type SettlementView,
  type ShareMode,
} from './settlement.types';

/** 24h 冻结期（DB interval 同值；job 注册用） */
const HOLD_INTERVAL = "interval '24 hours'";

interface SettlementRow {
  readonly id: string;
  readonly ref_type: string;
  readonly ref_id: string;
  readonly lawyer_id: string;
  readonly firm_id: string;
  readonly gross: string;
  readonly penalty: string;
  readonly platform_fee: string;
  readonly fee_version_id: string;
  readonly net: string;
  readonly share_mode: string;
  readonly payment_order_id: string | null;
  readonly escrow_status: string | null;
  readonly deduction_detail: SettlementDeductionDetail | null;
  readonly status: string;
  readonly hold_reason: string | null;
  readonly created_at: Date;
  readonly settled_at: Date | null;
}

const ROW_COLS = `id, ref_type, ref_id, lawyer_id, firm_id, gross::text AS gross, penalty::text AS penalty,
  platform_fee::text AS platform_fee, fee_version_id, net::text AS net, share_mode,
  payment_order_id, escrow_status, deduction_detail, status, hold_reason, created_at, settled_at`;

function toView(row: SettlementRow): SettlementView {
  return {
    id: Number(row.id),
    ref_type: row.ref_type as SettlementRefType,
    ref_id: Number(row.ref_id),
    lawyer_id: Number(row.lawyer_id),
    firm_id: Number(row.firm_id),
    gross: row.gross,
    penalty: row.penalty,
    platform_fee: row.platform_fee,
    fee_version_id: Number(row.fee_version_id),
    net: row.net,
    share_mode: row.share_mode as ShareMode,
    payment_order_id: row.payment_order_id === null ? null : Number(row.payment_order_id),
    escrow_status: row.escrow_status,
    deduction_detail: row.deduction_detail,
    status: row.status as SettlementStatus,
    hold_reason: row.hold_reason,
    created_at: new Date(row.created_at).toISOString(),
    settled_at: row.settled_at === null ? null : new Date(row.settled_at).toISOString(),
  };
}

/** settle/penalty 事件载荷的 session 兼容位（§6 逐字：session 时=ref_id，one_on_one=null） */
function sessionIdOf(refType: SettlementRefType, refId: number): number | null {
  return refType === 'session' ? refId : null;
}

function assertPositiveInt(v: unknown, field: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0 || !Number.isSafeInteger(v)) {
    throw new AppError(ErrorCode.InvalidArgument, `${field} 须为正整数：${JSON.stringify(v)}`);
  }
  return v;
}

function assertRefType(v: string): SettlementRefType {
  if (!SETTLEMENT_REF_TYPES.includes(v as SettlementRefType)) {
    throw new AppError(
      ErrorCode.InvalidArgument,
      `ref_type 越域（${SETTLEMENT_REF_TYPES.join('|')}）：${String(v)}`,
    );
  }
  return v as SettlementRefType;
}

function assertPenaltyKey(key: string): string {
  // 域前缀约束（R-W3-A 裁决注记）：保证金腿派生键=首段换 deposit——非 penalty/ 键会与之撞向
  if (!isValidIdempotencyKey(key) || !key.startsWith('penalty/')) {
    throw new AppError(
      ErrorCode.IdempotencyKeyInvalid,
      `违约扣减幂等键须为 penalty/ 域三段键（如 penalty/session-1/cancel-20）：${JSON.stringify(key)}`,
    );
  }
  return key;
}

@Injectable()
export class SettlementService {
  private readonly logger = new Logger(SettlementService.name);

  constructor(
    private readonly pool: PgPoolService,
    private readonly outbox: OutboxService,
    private readonly guard: StateTransitionGuardService,
    private readonly scheduler: SchedulerService,
    private readonly gate: OpenTicketGate,
    private readonly merchants: FirmMerchantService,
    private readonly payment: PaymentGatewayService,
  ) {}

  // ===========================================================================
  // 进结算（§6 RoomClosed/OneOnOneSettled 服务核；§4 FINISHED→PENDING→HOLD）
  // ===========================================================================

  async enterSettlement(
    input: EnterSettlementInput,
  ): Promise<{ created: boolean; settlement: SettlementView }> {
    const refType = assertRefType(input.ref_type);
    const refId = assertPositiveInt(input.ref_id, 'ref_id');
    const lawyerId = assertPositiveInt(input.lawyer_id, 'lawyer_id');
    const firmId = assertPositiveInt(input.firm_id, 'firm_id');
    const orderId = assertPositiveInt(input.payment_order_id, 'payment_order_id');
    const grossCents = moneyToCents(input.gross);
    if (grossCents <= 0) {
      throw new AppError(ErrorCode.InvalidArgument, `gross 须为正金额：${input.gross}`);
    }

    return this.pool.withTransaction(async (uow) => {
      // R-06：生效费率版本（effective_at<=now() 最新一条；种子 0% 兜底，缺失=硬错误不静默）
      const fee = await this.effectiveFeeInTx(uow);
      const feeCents = platformFeeCents(grossCents, fee.rate);

      // claim：UNIQUE(ref_type, ref_id) 真兜底（§10-7 重复触发幂等前哨）
      const claim = await uow.query<SettlementRow>(
        `INSERT INTO settlement.settlements
           (ref_type, ref_id, lawyer_id, firm_id, gross, penalty, platform_fee, fee_version_id,
            net, share_mode, payment_order_id, escrow_status, status)
         VALUES ($1, $2, $3, $4, $5::numeric, 0, $6::numeric, $7, $5::numeric,
                 'FULL_TO_LAWYER', $8, 'PAID', 'PENDING')
         ON CONFLICT (ref_type, ref_id) DO NOTHING
         RETURNING ${ROW_COLS}`,
        [refType, refId, lawyerId, firmId, input.gross, centsToMoney(feeCents), fee.id, orderId],
      );
      if (claim.rows.length === 0) {
        const prev = await this.getByRefInTx(uow, refType, refId);
        if (!prev) throw new AppError(ErrorCode.InternalError, '结算行冲突但不可读（不应触达）');
        return { created: false, settlement: toView(prev) }; // 幂等重投：返回原行不重建
      }
      const row = claim.rows[0]!;

      // PENDING→HOLD（R-02 冻结期；锚=created_at DB 钟）+ SETTLE_HOLD_RELEASE job 同事务预写
      await this.guard.assertTransition(SETTLEMENT_MACHINE, {
        entityId: Number(row.id),
        from: 'PENDING',
        to: 'HOLD',
        reason: 'HOLD_24H',
        uow,
      });
      const held = await uow.query<SettlementRow>(
        `UPDATE settlement.settlements SET status = 'HOLD', hold_reason = 'HOLD_24H'
          WHERE id = $1 AND status = 'PENDING' RETURNING ${ROW_COLS}`,
        [row.id],
      );
      if (held.rows.length === 0) {
        throw new AppError(ErrorCode.StateStaleEntity, `结算行 ${row.id} 已被并发迁移`);
      }
      await this.scheduler.registerJob(uow, {
        jobType: 'SETTLE_HOLD_RELEASE',
        refType: 'settlement',
        refId: Number(row.id),
        dueAt: new Date(Date.now() + 24 * 3_600_000),
      });
      await this.outbox.recordOutbox(uow, {
        type: SETTLEMENT_HELD_TOPIC,
        payload: {
          settlement_id: Number(held.rows[0]!.id),
          ref_type: refType,
          ref_id: refId,
          session_id: sessionIdOf(refType, refId),
          reason: 'HOLD_24H',
        } satisfies SettlementHeldPayload,
      });
      return { created: true, settlement: toView(held.rows[0]!) };
    });
  }

  // ===========================================================================
  // 缺席分成标记（R-03；§6 AttendanceAdjudicated 消费核）
  // ===========================================================================

  /**
   * user 缺席判定 → 场次结算 70/30（R-03；分账构成切换位）。无结算行（D3 判定先于 RoomClosed
   * 的真实时序）→ NO_SETTLEMENT 显性返回不炸——M2 D3/D1 联调换装位（届时由 RoomClosed 消费时
   * 回查 D3 判定结果或事件重放承担，报告偏差节同口径）；已 SETTLED → 拒改（钱已分，补偿流=D4/M2）。
   */
  async markAbsenceShare(refType: SettlementRefType, refId: number): Promise<MarkAbsenceResult> {
    assertRefType(refType);
    assertPositiveInt(refId, 'ref_id');
    const res = await this.pool.query<{ id: string }>(
      `UPDATE settlement.settlements SET share_mode = 'ABSENCE_7030'
        WHERE ref_type = $1 AND ref_id = $2 AND status <> 'SETTLED' RETURNING id`,
      [refType, refId],
    );
    if (res.rows.length > 0) return { marked: true };
    const row = await this.getByRef(refType, refId);
    if (!row) return { marked: false, reason: 'NO_SETTLEMENT' };
    return { marked: false, reason: 'SETTLED' };
  }

  // ===========================================================================
  // HOLD 释放（R-02/§10-1：24h 到期 / 工单关闭；job 执行器与 TicketResolved 消费共用）
  // ===========================================================================

  async releaseDueHold(
    settlementId: number,
    reason: 'HOLD_EXPIRED' | 'TICKET_RESOLVED',
  ): Promise<ReleaseHoldResult> {
    assertPositiveInt(settlementId, 'settlement_id');
    const outcome = await this.pool.withTransaction(async (uow) => {
      const row = await this.lockById(uow, settlementId);
      if (!row) throw new AppError(ErrorCode.NotFound, `结算行 ${settlementId} 不存在`);
      if (row.status !== 'HOLD') return { released: false }; // 幂等/并发败者
      // R-02 到期判定=DB 钟（应用钟不参与；时间注入用例经 created_at SQL 旅行锚定）
      const due = await uow.query<{ ok: boolean }>(
        `SELECT (created_at + ${HOLD_INTERVAL}) <= now() AS ok FROM settlement.settlements WHERE id = $1`,
        [row.id],
      );
      if (due.rows[0]!.ok !== true) return { released: false, blocked: 'HOLD_24H' } as const;
      // 工单闸（H3=M2 换装位；W3 默认无未结工单）：未闭维持 HOLD
      if (await this.gate.hasOpenTicket(row.ref_type as SettlementRefType, Number(row.ref_id))) {
        await uow.query(
          `UPDATE settlement.settlements SET hold_reason = 'OPEN_TICKETS' WHERE id = $1 AND status = 'HOLD'`,
          [row.id],
        );
        return { released: false, blocked: 'OPEN_TICKETS' } as const;
      }
      await this.guard.assertTransition(SETTLEMENT_MACHINE, {
        entityId: settlementId,
        from: 'HOLD',
        to: 'READY',
        reason: `hold_release:${reason}`,
        uow,
      });
      const updated = await uow.query<SettlementRow>(
        `UPDATE settlement.settlements SET status = 'READY', hold_reason = NULL
          WHERE id = $1 AND status = 'HOLD' RETURNING ${ROW_COLS}`,
        [row.id],
      );
      if (updated.rows.length === 0) {
        throw new AppError(ErrorCode.StateStaleEntity, `结算行 ${settlementId} 已被并发迁移`);
      }
      await this.outbox.recordOutbox(uow, {
        type: SETTLEMENT_RELEASED_TOPIC,
        payload: {
          settlement_id: settlementId,
          ref_type: row.ref_type as SettlementRefType,
          ref_id: Number(row.ref_id),
          session_id: sessionIdOf(row.ref_type as SettlementRefType, Number(row.ref_id)),
          reason,
        } satisfies SettlementReleasedPayload,
      });
      return { released: true } as const;
    });
    return outcome;
  }

  // ===========================================================================
  // RUN_SETTLEMENT（§5 内部指令：job 释放/H3 释放/进件恢复重驱动；幂等键=ref_type+ref_id）
  // ===========================================================================

  async runSettlement(ref: {
    readonly ref_type: SettlementRefType;
    readonly ref_id: number;
  }): Promise<RunSettleResult> {
    const refType = assertRefType(ref.ref_type);
    const refId = assertPositiveInt(ref.ref_id, 'ref_id');
    const row0 = await this.getByRef(refType, refId);
    if (!row0) {
      throw new AppError(ErrorCode.NotFound, `结算行不存在：${refType}=${refId}`);
    }
    const settlementId = Number(row0.id);
    if (row0.status === 'SETTLED') {
      return { settlement_id: settlementId, settled: false, already_settled: true }; // §10-7 幂等无操作
    }
    if (row0.status !== 'READY') {
      return { settlement_id: settlementId, settled: false, status: row0.status as SettlementStatus };
    }

    // R-07 进件前置 + F1 通道定位（经 F1 导出读面；跨 schema 禁直查 payment_orders）
    const order = row0.payment_order_id
      ? await this.payment.findOrderById(Number(row0.payment_order_id))
      : null;
    if (!order) {
      throw new AppError(
        ErrorCode.NotFound,
        `F1 支付单不可读：settlement=${settlementId} payment_order_id=${String(row0.payment_order_id)}（进重试轨道，不静默）`,
      );
    }
    try {
      await this.merchants.assertSplittable(Number(row0.firm_id), order.channel);
    } catch (e) {
      if (e instanceof AppError && e.code === ErrorCode.MerchantNotActive) {
        await this.suspendOne(settlementId, 'READY', 'MERCHANT_NOT_ACTIVE');
        return { settlement_id: settlementId, settled: false, suspended: true };
      }
      throw e;
    }

    // 分账构成（Σsplits=net=gross−penalty 恒等式；fee=建行固化值）→ F1 /pay/split 指令面
    const composed = composeSplits({
      firm_id: Number(row0.firm_id),
      gross_cents: dbNumericToCents(row0.gross),
      penalty_cents: dbNumericToCents(row0.penalty),
      platform_fee_cents: dbNumericToCents(row0.platform_fee),
      share_mode: row0.share_mode as ShareMode,
    });
    if (composed.splits.length > 0) {
      await this.payment.split({
        order_id: order.id,
        splits: composed.splits,
        idempotency_key: `settle/${refType}-${refId}/split`, // §5 幂等键=ref_type+ref_id（F1 UNIQUE 兜底）
      });
    } else {
      // 零可分净额（违约金吃满）：无资金可分，跳过指令面仍终态化（F1 单闭单位=M2 D4）
      this.logger.log(
        `结算零可分净额，跳过 /pay/split：settlement=${settlementId} ${refType}=${refId}`,
      );
    }

    const settled = await this.pool.withTransaction(async (uow) => {
      const row = await this.lockById(uow, settlementId);
      if (!row || row.status !== 'READY') return false; // 并发败者幂等
      await this.guard.assertTransition(SETTLEMENT_MACHINE, {
        entityId: settlementId,
        from: 'READY',
        to: 'SETTLED',
        reason: 'split_confirmed',
        uow,
      });
      const updated = await uow.query<SettlementRow>(
        `UPDATE settlement.settlements
           SET status = 'SETTLED', settled_at = now(), escrow_status = 'SPLIT'
         WHERE id = $1 AND status = 'READY' RETURNING ${ROW_COLS}`,
        [settlementId],
      );
      if (updated.rows.length === 0) {
        throw new AppError(ErrorCode.StateStaleEntity, `结算行 ${settlementId} 已被并发迁移`);
      }
      await this.outbox.recordOutbox(uow, {
        type: SPLIT_SETTLED_TOPIC,
        payload: {
          settlement_id: settlementId,
          ref_type: refType,
          ref_id: refId,
          session_id: sessionIdOf(refType, refId),
          net: centsToMoney(composed.net_cents),
          fee: centsToMoney(composed.fee_cents),
          splits: composed.splits satisfies readonly SettlementSplitItem[],
        } satisfies SplitSettledPayload,
      });
      return true;
    });
    return { settlement_id: settlementId, settled };
  }

  /** id 定位变体（job 执行器/进件恢复消费链按 settlement 行 id 续跑；语义同 runSettlement） */
  async runSettlementById(settlementId: number): Promise<RunSettleResult> {
    assertPositiveInt(settlementId, 'settlement_id');
    const row = await this.pool.query<SettlementRow>(
      `SELECT ref_type, ref_id FROM settlement.settlements WHERE id = $1`,
      [settlementId],
    );
    const r = row.rows[0];
    if (!r) throw new AppError(ErrorCode.NotFound, `结算行 ${settlementId} 不存在`);
    return this.runSettlement({
      ref_type: r.ref_type as SettlementRefType,
      ref_id: Number(r.ref_id),
    });
  }

  // ===========================================================================
  // 进件挂起/恢复重驱动（R-07；§6 FirmMerchantSuspended/Activated 消费核）
  // ===========================================================================

  /** 进件非 ACTIVE：该律所全部未终态结算挂起 SUSPENDED（事件驱动，A3b reason 入 STL 留痕） */
  async suspendForFirm(firmId: number, reason: string): Promise<{ suspended: number }> {
    assertPositiveInt(firmId, 'firm_id');
    if (typeof reason !== 'string' || reason.length === 0 || reason.length > 32) {
      throw new AppError(ErrorCode.InvalidArgument, `reason 须为 1-32 字符：${String(reason)}`);
    }
    return this.pool.withTransaction(async (uow) => {
      const rows = await uow.query<SettlementRow>(
        `SELECT ${ROW_COLS} FROM settlement.settlements
          WHERE firm_id = $1 AND status IN ('HOLD', 'READY') ORDER BY id FOR UPDATE`,
        [firmId],
      );
      for (const row of rows.rows) {
        const from = row.status as 'HOLD' | 'READY';
        await this.guard.assertTransition(SETTLEMENT_MACHINE, {
          entityId: Number(row.id),
          from,
          to: 'SUSPENDED',
          reason: `merchant_suspended:${reason}`,
          uow,
        });
        const updated = await uow.query<SettlementRow>(
          `UPDATE settlement.settlements SET status = 'SUSPENDED', hold_reason = 'MERCHANT_NOT_ACTIVE'
            WHERE id = $1 AND status = $2 RETURNING id`,
          [row.id, from],
        );
        if (updated.rows.length === 0) {
          throw new AppError(ErrorCode.StateStaleEntity, `结算行 ${row.id} 已被并发迁移`);
        }
        await this.outbox.recordOutbox(uow, {
          type: SETTLEMENT_HELD_TOPIC,
          payload: {
            settlement_id: Number(row.id),
            ref_type: row.ref_type as SettlementRefType,
            ref_id: Number(row.ref_id),
            session_id: sessionIdOf(row.ref_type as SettlementRefType, Number(row.ref_id)),
            reason: 'MERCHANT_NOT_ACTIVE',
          } satisfies SettlementHeldPayload,
        });
      }
      return { suspended: rows.rows.length };
    });
  }

  /**
   * 进件恢复重驱动（FirmMerchantActivated）：SUSPENDED 行逐条判定释放条件——满足（冻结期满+
   * 无工单）→ READY（调用方对 readied 行续跑 runSettlement 完成重驱动）；未满足 → 回 HOLD
   * （锚仍=created_at）+ SETTLE_HOLD_RELEASE job 重注册（原 job 可能已被消费）。
   */
  async resumeForFirm(firmId: number): Promise<{ readied: number[]; reheld: number }> {
    assertPositiveInt(firmId, 'firm_id');
    const readied: number[] = [];
    let reheld = 0;
    await this.pool.withTransaction(async (uow) => {
      const rows = await uow.query<SettlementRow>(
        `SELECT ${ROW_COLS} FROM settlement.settlements
          WHERE firm_id = $1 AND status = 'SUSPENDED' ORDER BY id FOR UPDATE`,
        [firmId],
      );
      for (const row of rows.rows) {
        const refType = row.ref_type as SettlementRefType;
        const refId = Number(row.ref_id);
        const due = await uow.query<{ ok: boolean }>(
          `SELECT (created_at + ${HOLD_INTERVAL}) <= now() AS ok FROM settlement.settlements WHERE id = $1`,
          [row.id],
        );
        const eligible = due.rows[0]!.ok === true && !(await this.gate.hasOpenTicket(refType, refId));
        if (eligible) {
          await this.guard.assertTransition(SETTLEMENT_MACHINE, {
            entityId: Number(row.id),
            from: 'SUSPENDED',
            to: 'READY',
            reason: 'merchant_recovered',
            uow,
          });
          const updated = await uow.query<SettlementRow>(
            `UPDATE settlement.settlements SET status = 'READY', hold_reason = NULL
              WHERE id = $1 AND status = 'SUSPENDED' RETURNING id`,
            [row.id],
          );
          if (updated.rows.length === 0) {
            throw new AppError(ErrorCode.StateStaleEntity, `结算行 ${row.id} 已被并发迁移`);
          }
          await this.outbox.recordOutbox(uow, {
            type: SETTLEMENT_RELEASED_TOPIC,
            payload: {
              settlement_id: Number(row.id),
              ref_type: refType,
              ref_id: refId,
              session_id: sessionIdOf(refType, refId),
              reason: 'MERCHANT_RECOVERED',
            } satisfies SettlementReleasedPayload,
          });
          readied.push(Number(row.id));
        } else {
          await this.guard.assertTransition(SETTLEMENT_MACHINE, {
            entityId: Number(row.id),
            from: 'SUSPENDED',
            to: 'HOLD',
            reason: 'merchant_recovered_rehold',
            uow,
          });
          const updated = await uow.query<SettlementRow>(
            `UPDATE settlement.settlements SET status = 'HOLD', hold_reason = 'HOLD_24H'
              WHERE id = $1 AND status = 'SUSPENDED' RETURNING id, created_at`,
            [row.id],
          );
          if (updated.rows.length === 0) {
            throw new AppError(ErrorCode.StateStaleEntity, `结算行 ${row.id} 已被并发迁移`);
          }
          // job 重注册：dueAt=created_at+24h（已过则即刻到期由执行器回查兜底）
          const createdAt = new Date(updated.rows[0]!.created_at);
          const dueAt = new Date(createdAt.getTime() + 24 * 3_600_000);
          await this.scheduler.registerJob(uow, {
            jobType: 'SETTLE_HOLD_RELEASE',
            refType: 'settlement',
            refId: Number(row.id),
            dueAt: dueAt.getTime() <= Date.now() ? new Date(Date.now() + 1_000) : dueAt,
          });
          reheld += 1;
        }
      }
    });
    return { readied, reheld };
  }

  // ===========================================================================
  // APPLY_PENALTY（§5 内部指令；R-04 扣减顺序/R-05 不抽佣/R-W3-A 带金额入参）
  // ===========================================================================

  async applyPenalty(input: ApplyPenaltyInput): Promise<ApplyPenaltyResult> {
    const ownerId = assertPositiveInt(input.owner_id, 'owner_id');
    const amountCents = moneyToCents(input.amount);
    if (amountCents <= 0) {
      throw new AppError(ErrorCode.InvalidArgument, `amount 须为正金额：${input.amount}`);
    }
    if (
      typeof input.base_ref?.ref_type !== 'string' ||
      input.base_ref.ref_type.length === 0 ||
      input.base_ref.ref_type.length > 16
    ) {
      throw new AppError(ErrorCode.InvalidArgument, `base_ref.ref_type 须为 1-16 字符`);
    }
    assertPositiveInt(input.base_ref.ref_id, 'base_ref.ref_id');
    if (
      input.base_version !== undefined &&
      input.base_version !== null &&
      (!Number.isInteger(input.base_version) || input.base_version < 0)
    ) {
      throw new AppError(ErrorCode.InvalidArgument, `base_version 须为非负整数`);
    }
    if (typeof input.reason !== 'string' || input.reason.length === 0 || input.reason.length > 200) {
      throw new AppError(ErrorCode.InvalidArgument, `reason 须为 1-200 字符`);
    }
    const key = assertPenaltyKey(input.idempotency_key);
    const depositKey = ['deposit', ...key.split('/').slice(1)].join('/'); // 保证金腿派生键

    // 幂等重放（§10-7）：本域扣减留痕承载（F1 台账 UNIQUE 为资金面真兜底）
    const replay = await this.pool.query<{
      id: string;
      deduction_detail: SettlementDeductionDetail;
    }>(
      `SELECT id, deduction_detail FROM settlement.settlements
        WHERE lawyer_id = $1 AND deduction_detail->'items' @> $2::jsonb LIMIT 1`,
      [ownerId, JSON.stringify([{ idempotency_key: key }])],
    );
    const prior = replay.rows[0];
    if (prior) {
      const detail = prior.deduction_detail;
      const same =
        detail !== null &&
        detail.amount === input.amount &&
        detail.base_ref.ref_type === input.base_ref.ref_type &&
        detail.base_ref.ref_id === input.base_ref.ref_id &&
        detail.reason === input.reason;
      if (!same) {
        throw new AppError(
          ErrorCode.PaymentDuplicateKey,
          `幂等键 ${key} 已绑定其他载荷（同键须同载荷重放）`,
        );
      }
      const confirmed = (leg: DeductionLeg['leg']): Money =>
        centsToMoney(
          detail.items
            .filter((it) => it.leg === leg && it.status === 'CONFIRMED')
            .reduce((s, it) => s + moneyToCents(it.amount), 0),
        );
      return {
        replayed: true,
        from_settlement: confirmed('settlement'),
        from_deposit: confirmed('deposit'),
        debt: detail.debt,
        items: detail.items,
      };
    }

    return this.pool.withTransaction(async (uow) => {
      // 待结算余额（R-04 事实源=本域台账）：未终态行 net 合计，FIFO 摊扣
      const rows = await uow.query<SettlementRow>(
        `SELECT ${ROW_COLS} FROM settlement.settlements
          WHERE lawyer_id = $1 AND status IN ('PENDING', 'HOLD', 'READY', 'SUSPENDED')
          ORDER BY created_at, id FOR UPDATE`,
        [ownerId],
      );
      const balance = rows.rows.reduce((s, r) => s + dbNumericToCents(r.net), 0);
      const planFromSettle = Math.min(amountCents, balance);
      const legs: DeductionLeg[] = [];
      let settleShortfall = 0;

      if (planFromSettle > 0) {
        try {
          const r = await this.payment.deduct({
            lawyer_id: ownerId,
            amount: centsToMoney(planFromSettle),
            from: 'settlement',
            idempotency_key: key,
          });
          legs.push({
            leg: 'settlement',
            amount: centsToMoney(planFromSettle),
            idempotency_key: key,
            ledger_id: r.ledger_id,
            status: 'CONFIRMED',
          });
        } catch (e) {
          if (e instanceof AppError && e.code === ErrorCode.InsufficientFunds) {
            // 通道业务应答=机构侧待结算资金不足：腿 SHORTFALL 留痕，顺次补足（R-04 次序保持）
            settleShortfall = planFromSettle;
            legs.push({
              leg: 'settlement',
              amount: centsToMoney(planFromSettle),
              idempotency_key: key,
              ledger_id: null,
              status: 'SHORTFALL',
            });
          } else {
            throw e;
          }
        }
      }

      const depositTry = amountCents - (planFromSettle - settleShortfall);
      let debtCents = 0;
      if (depositTry > 0) {
        try {
          const r = await this.payment.deduct({
            lawyer_id: ownerId,
            amount: centsToMoney(depositTry),
            from: 'deposit',
            idempotency_key: depositKey,
          });
          legs.push({
            leg: 'deposit',
            amount: centsToMoney(depositTry),
            idempotency_key: depositKey,
            ledger_id: r.ledger_id,
            status: 'CONFIRMED',
          });
        } catch (e) {
          if (e instanceof AppError && e.code === ErrorCode.InsufficientFunds) {
            debtCents = depositTry; // 保证金专户亦不足 → 挂欠款（G1 事件出箱）
            legs.push({
              leg: 'deposit',
              amount: centsToMoney(depositTry),
              idempotency_key: depositKey,
              ledger_id: null,
              status: 'SHORTFALL',
            });
          } else {
            throw e;
          }
        }
      }

      // FIFO 摊扣实到腿（仅 CONFIRMED 结算腿入行账——SHORTFALL 腿无资金移动不虚减净额）
      let remaining = planFromSettle - settleShortfall;
      const touched: number[] = [];
      for (const row of rows.rows) {
        if (remaining <= 0) break;
        const rowNet = dbNumericToCents(row.net);
        const take = Math.min(rowNet, remaining);
        if (take <= 0) continue;
        const newPenalty = dbNumericToCents(row.penalty) + take;
        const newNet = dbNumericToCents(row.gross) - dbNumericToCents(row.platform_fee) - newPenalty;
        if (newNet < 0) {
          throw new AppError(ErrorCode.InternalError, `扣减摊布守恒失守：行 ${row.id} 净额为负`);
        }
        await uow.query(
          `UPDATE settlement.settlements SET penalty = $2::numeric, net = $3::numeric WHERE id = $1`,
          [row.id, centsToMoney(newPenalty), centsToMoney(newNet)],
        );
        touched.push(Number(row.id));
        remaining -= take;
      }
      if (remaining > 0) {
        throw new AppError(ErrorCode.InternalError, '违约扣减摊布不足（台账守恒失守，不应触达）');
      }

      // deduction_detail 留痕（§10-4；锚=最后被摊扣行——无行=仅 F1 台账+事件承载）
      const detail: SettlementDeductionDetail = {
        items: legs,
        debt: centsToMoney(debtCents),
        amount: input.amount,
        base_ref: { ...input.base_ref },
        base_version: input.base_version ?? null,
        reason: input.reason,
        idempotency_key: key,
        applied_at: new Date().toISOString(),
      };
      let anchorFirm: number | null = null;
      if (touched.length > 0) {
        anchorFirm = rows.rows.filter((r) => touched.includes(Number(r.id))).at(-1)!.firm_id as number;
        await uow.query(
          `UPDATE settlement.settlements SET deduction_detail = $2::jsonb WHERE id = $1`,
          [touched[touched.length - 1]!, JSON.stringify(detail)],
        );
      }
      if (debtCents > 0) {
        if (anchorFirm !== null) anchorFirm = Number(anchorFirm);
        await this.outbox.recordOutbox(uow, {
          type: SETTLEMENT_DEBT_INCURRED_TOPIC,
          payload: {
            lawyer_id: ownerId,
            firm_id: anchorFirm,
            amount: centsToMoney(debtCents),
            ref_type: input.base_ref.ref_type,
            ref_id: input.base_ref.ref_id,
          } satisfies SettlementDebtIncurredPayload,
        });
        this.logger.warn(
          `违约扣减挂欠款：lawyer=${ownerId} debt=${centsToMoney(debtCents)}（G1 SUSPEND_TAKE 消费位=M2 联调）`,
        );
      }

      const confirmedSum = (leg: DeductionLeg['leg']): number =>
        legs
          .filter((it) => it.leg === leg && it.status === 'CONFIRMED')
          .reduce((s, it) => s + moneyToCents(it.amount), 0);
      return {
        replayed: false,
        from_settlement: centsToMoney(confirmedSum('settlement')),
        from_deposit: centsToMoney(confirmedSum('deposit')),
        debt: centsToMoney(debtCents),
        items: legs,
      };
    });
  }

  // ===========================================================================
  // 查询面（§5 GET /lawyer/settlements、GET /admin/settlements?status= 数据核）
  // ===========================================================================

  async listForLawyer(lawyerId: number): Promise<readonly SettlementView[]> {
    assertPositiveInt(lawyerId, 'lawyer_id');
    const res = await this.pool.query<SettlementRow>(
      `SELECT ${ROW_COLS} FROM settlement.settlements WHERE lawyer_id = $1 ORDER BY id DESC`,
      [lawyerId],
    );
    return res.rows.map(toView);
  }

  async listForAdmin(filter: { readonly status?: SettlementStatus } = {}): Promise<
    readonly SettlementView[]
  > {
    const params: unknown[] = [];
    let where = '';
    if (filter.status !== undefined) {
      params.push(filter.status);
      where = `WHERE status = $1`;
    }
    const res = await this.pool.query<SettlementRow>(
      `SELECT ${ROW_COLS} FROM settlement.settlements ${where} ORDER BY id DESC LIMIT 200`,
      params,
    );
    return res.rows.map(toView);
  }

  // ===========================================================================
  // 内部件
  // ===========================================================================

  private async effectiveFeeInTx(
    uow: SqlExecutor,
  ): Promise<{ readonly id: number; readonly rate: string }> {
    const res = await uow.query<{ id: string; rate: string }>(
      `SELECT id, rate::text AS rate FROM settlement.fee_versions
        WHERE effective_at <= now() ORDER BY effective_at DESC, id DESC LIMIT 1`,
    );
    const row = res.rows[0];
    if (!row) {
      throw new AppError(ErrorCode.InternalError, 'fee_versions 无生效版本（R-06 种子 0% 缺失，硬错误）');
    }
    return { id: Number(row.id), rate: row.rate };
  }

  private async getByRef(
    refType: SettlementRefType,
    refId: number,
  ): Promise<SettlementRow | null> {
    const res = await this.pool.query<SettlementRow>(
      `SELECT ${ROW_COLS} FROM settlement.settlements WHERE ref_type = $1 AND ref_id = $2`,
      [refType, refId],
    );
    return res.rows[0] ?? null;
  }

  private async getByRefInTx(
    uow: SqlExecutor,
    refType: SettlementRefType,
    refId: number,
  ): Promise<SettlementRow | null> {
    const res = await uow.query<SettlementRow>(
      `SELECT ${ROW_COLS} FROM settlement.settlements WHERE ref_type = $1 AND ref_id = $2`,
      [refType, refId],
    );
    return res.rows[0] ?? null;
  }

  private async lockById(uow: SqlExecutor, id: number): Promise<SettlementRow | null> {
    const res = await uow.query<SettlementRow>(
      `SELECT ${ROW_COLS} FROM settlement.settlements WHERE id = $1 FOR UPDATE`,
      [id],
    );
    return res.rows[0] ?? null;
  }

  /** 单行挂起（R-07 runSettlement 前置断言失败路径；from 收窄由调用方传入） */
  private async suspendOne(
    settlementId: number,
    from: SettlementStatus,
    holdReason: string,
  ): Promise<void> {
    await this.pool.withTransaction(async (uow) => {
      const row = await this.lockById(uow, settlementId);
      if (!row || row.status !== from) return; // 并发已迁移（幂等）
      await this.guard.assertTransition(SETTLEMENT_MACHINE, {
        entityId: settlementId,
        from,
        to: 'SUSPENDED',
        reason: `settle_precheck:${holdReason}`,
        uow,
      });
      const updated = await uow.query<SettlementRow>(
        `UPDATE settlement.settlements SET status = 'SUSPENDED', hold_reason = $3
          WHERE id = $1 AND status = $2 RETURNING ref_type, ref_id`,
        [settlementId, from, holdReason],
      );
      if (updated.rows.length === 0) {
        throw new AppError(ErrorCode.StateStaleEntity, `结算行 ${settlementId} 已被并发迁移`);
      }
      const refType = updated.rows[0]!.ref_type as SettlementRefType;
      const refId = Number(updated.rows[0]!.ref_id);
      await this.outbox.recordOutbox(uow, {
        type: SETTLEMENT_HELD_TOPIC,
        payload: {
          settlement_id: settlementId,
          ref_type: refType,
          ref_id: refId,
          session_id: sessionIdOf(refType, refId),
          reason: holdReason,
        } satisfies SettlementHeldPayload,
      });
    });
  }
}
