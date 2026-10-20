/**
 * D6 1对1 服务闭环应用服务（§2/§4/§5/§6/§7 + M2-W3 执行计划 T2 行）——履约域导出面
 * （RoomService 同形可剥离纪律：跨域取数全走导出服务/事件，禁跨 schema join）。
 *
 * === 下单链（§5 POST /one-on-one；幂等键=user+room+type） ===
 *   闸口顺序：实名 R-06（A2 导出面，402）→ 房间→场次→律师锚（本域 rooms 行 + C1 getDetail
 *   导出面）→ B3 矩阵价 current 读取（403/400 PRICE_MISSING 档=PricingConfigService）→
 *   **同事务原子编排**（C3 先例）：INSERT one_on_one_orders(CREATED) → F1 createOrderInTx
 *   （幂等键=ooo/o{id}/pay，金额=prepaid，biz_type='ooo'）→ payment_order_id 回写——任一失败
 *   全回滚不烧键。幂等：活跃单（ux_ooo_active 八值）行锁重读 → 重放原支付单（同键无载荷
 *   分异面——入参三键即幂等键全量，恒同载荷重放）；终态后同房间同类型可再下单（部分唯一
 *   索引口径，V47 头注）。**prepaid=1 单位起付**（契约无数量入参：text=1 轮、voice/video=
 *   1 个 15min；多消费经实结少补承载——⚠04 §8 候选登记，报告注明）。
 *
 * === 支付收敛（PAY_SUCCESS 回调消费，C3 enrollment.consumer 同形态） ===
 *   F1 冻结推进先行（R-01 支付即冻结，CREATED→FROZEN）→ onPaySuccess：CREATED→PAID +
 *   accept_deadline=paid_at+N（N=W3-2 配置化默认 30min）+ OneOnOnePaid 出箱（D5 W1 既有
 *   消费建会话）+ OOO_ACCEPT_TIMEOUT job 同事务预写（due=accept_deadline 同锚）。幂等：
 *   非 CREATED 短路（PAY_SUCCESS 重放不双推进）。
 *
 * === 接单/服务/计量（§4 主链；W3-8/W3-9/W3-15 裁决） ===
 *   accept：PAID 且 now≤accept_deadline（N+1s → 409 TIMEOUT；executor 与 accept 经行锁
 *   串行不竞态）→ ACCEPTED + conversation 回填（W3-13：会话 D5 异建未达时 null，消息面补）。
 *   IN_SERVICE 锚（W3-8）：text=accept 后首条用户消息（MESSAGE_SENT 消费）/voice-video=
 *   首次时长回调（recordDuration）→ started_at。计量事实源=系统（W3-15）：text 轮次=消息表
 *   确定性重算（律师答消息且其与上一条律师答之间存在用户问=1 轮——重复/乱序投递幂等）；
 *   voice/video 段数=ceil(duration/900) 单调上界（W3-9：consumed=GREATEST(现值,段数)，
 *   重复/乱序回调不重复计数）；finish 的 consumed_units 声明仅校验回执（advisory 出参，
 *   不阻塞不采信虚报）。FINISHED 同事务预写 OOO_SETTLE_DEFAULT（due=finished_at+30min，
 *   D9 配置化）。
 *
 * === 实结（§4 SETTLING 分支；R-02/R-04） ===
 *   settleConfirm（role 入参，user/lawyer 各一次）：首次=FINISHED→SETTLING 落 settle_amount
 *   +role（STL reason 承载）；二次须相等否则 409 MISMATCH（同角色同额=幂等重放）；一致→
 *   结算动作：恰好→SETTLED；多退→**F2 受理先行**（reason SETTLE_REFUND，键 refund/po-{po}/
 *   ooo-settle——refundIfRejected 先例：崩溃窗口重放由幂等键+默认确认 executor 收敛）→
 *   REFUND_PARTIAL→SETTLED；少补→F1 补差单同事务（键 ooo/o{id}/diff，biz_type='ooo_diff'）
 *   +diff_order_id+DIFF_PENDING+OneOnOneDiffPending 出箱+DIFF_PAY_TIMEOUT 预写（due=+15min）
 *   ——补差单未确认支付不扣款（R-02 禁无密扣款）。settle-diff/pay=支付参数重建面（dev mock
 *   通道预下单即成功形态，#40 四次修正口径）；补差 PAY_SUCCESS 收敛 DIFF_PENDING→SETTLED。
 *   30min 默认（executor）：FINISHED=系统计量值双默认；SETTLING=已录值补默认。终态出箱
 *   OneOnOneSettled（gross=prepaid/net=实结参考/lawyer_id/firm_id/payment_order_id——F3 既有
 *   契约逐字；firm_id 经 A3a getFirmId 导出面，进件前 null=显式失败不静默，RoomClosed 先例）。
 *
 * === 取消三档（R-03 逐字，W3-4）与接单超时 ===
 *   ①IN_SERVICE 前（PAID/ACCEPTED）全退：CANCELLED→F2 全额（reason OOO_CANCEL，键
 *   refund/po-{po}/ooo-cancel）→REFUNDED；②text 开始后 settle=单价×已完成轮次退差（键
 *   ooo-cancel-partial）；③voice-video consumed=0 收 1 单位 50%（半单位 floor 到分）退其余、
 *   ≥1 实结多退少补（**取消少补侧按 prepaid 封顶**——状态机冻结 DIFF_PENDING 仅自 SETTLING
 *   可达，cancel 无补差出边；超支面=平台让利口径，报告注明）；settle=0 形态走全退键 REFUNDED。
 *   受理先行→终态化（D4 双路径先例）；崩溃窗口=CANCELLED 行重入续跑（幂等键重放）+
 *   RefundCompleted 消费收敛兜底。接单超时=executor：PAID→LAWYER_TIMEOUT+OneOnOneLawyerTimeout
 *   出箱（载荷自带 payment_order_id 免跨域查）→ F2 消费全退（OOO_TIMEOUT）→RefundCompleted
 *   收敛 REFUNDED。
 *
 * === 评审修复环登记注记（M2-W3 T2 review；04 §8 回写归 T7） ===
 *   M-4：未支付 CREATED 订单无清场/关单路径（对齐 C3「F1 单保持 CREATED 不发明关单指令」
 *     口径——dev mock 通道预下单即成功形态下 CREATED 恒短暂；真通道关单=M2 批统一落位）；
 *   C-1：补差支付与 15min 超时的双损防线=diffPayTimeoutExecute 支付竞态回查（FROZEN/PAID
 *     →已付收敛）+onDiffPaySuccess 迟到支付退款（ooo-diff-late 键；G1 不自动冲销——人工经
 *     H3 工单冲正）。
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  AppError,
  ErrorCode,
  ONE_ON_ONE_ACCEPTED_TOPIC,
  ONE_ON_ONE_DIFF_PENDING_TOPIC,
  ONE_ON_ONE_DIFF_UNPAID_TOPIC,
  ONE_ON_ONE_FINISHED_TOPIC,
  ONE_ON_ONE_LAWYER_TIMEOUT_TOPIC,
  ONE_ON_ONE_PAID_TOPIC,
  ONE_ON_ONE_SETTLED_TOPIC,
  type Money,
  type OneOnOneAcceptedPayload,
  type OneOnOneDiffPendingPayload,
  type OneOnOneDiffUnpaidPayload,
  type OneOnOneFinishedPayload,
  type OneOnOneLawyerTimeoutPayload,
  type OneOnOnePaidPayload,
  type OneOnOneSettledPayload,
} from '@ljr/shared';
import type { SqlExecutor } from '../../infrastructure/sql';
import { PgPoolService } from '../../infrastructure/sql';
import { OutboxService } from '../../infrastructure/outbox/outbox.service';
import { StateTransitionGuardService } from '../../infrastructure/state-machine/state-transition-guard.service';
import { StateTransitionLogService } from '../../infrastructure/state-machine/state-transition-log.service';
import { LawyerQualificationService } from '../identity/lawyer.service';
import { RealnameService } from '../identity/realname.service';
import { PaymentGatewayService } from '../payment/payment.gateway.service';
import { RefundService } from '../payment/refund.service';
import { PricingConfigService } from '../pricing/pricing.service';
import { SchedulerService } from '../schedule/scheduler.service';
import { SessionService } from '../trade/session.service';
import { ONE_ON_ONE_CONFIG, type OneOnOneConfig } from './one-on-one.config';
import { ONE_ON_ONE_MACHINE } from './one-on-one.machine';
import {
  ONE_ON_ONE_ACTIVE_STATUSES,
  ONE_ON_ONE_JOB_REF_TYPE,
  assertOneOnOneMode,
  assertNonNegativeIntField,
  assertPositiveIntField,
  assertServiceType,
  oooCancelPartialRefundKey,
  oooCancelRefundKey,
  oooDiffKey,
  oooPayKey,
  oooSettleRefundKey,
  segmentsOfDuration,
  type CancelOneOnOneResult,
  type CreateOneOnOneInput,
  type CreateOneOnOneResult,
  type FinishOneOnOneResult,
  type OneOnOneMode,
  type OneOnOneOrderView,
  type OneOnOneServiceType,
  type OneOnOneStatus,
  type RecordDurationResult,
  type SettleConfirmResult,
} from './one-on-one.types';
import { assertPositiveInt, centsToMoney, moneyToCents } from './room.types';

/** one_on_one_orders 行（DB 读出形态：numeric::text、bigint::text 归一） */
interface OneOnOneRow {
  readonly id: string;
  readonly room_id: string;
  readonly conversation_id: string | null;
  readonly user_id: string;
  readonly lawyer_id: string;
  readonly service_type: string;
  readonly mode: string;
  readonly unit_price: string;
  readonly prepaid: string;
  readonly consumed_units: number;
  readonly settle_amount: string | null;
  readonly refund_amount: string | null;
  readonly diff_order_id: string | null;
  readonly payment_order_id: string;
  readonly status: string;
  readonly accept_deadline: Date | null;
  readonly started_at: Date | null;
  readonly finished_at: Date | null;
  readonly settle_deadline: Date | null;
  readonly created_at: Date;
}

const OOO_COLS = `id, room_id, conversation_id, user_id, lawyer_id, service_type, mode,
  unit_price::text AS unit_price, prepaid::text AS prepaid, consumed_units,
  settle_amount::text AS settle_amount, refund_amount::text AS refund_amount,
  diff_order_id, payment_order_id, status, accept_deadline, started_at, finished_at,
  settle_deadline, created_at`;

function toView(row: OneOnOneRow): OneOnOneOrderView {
  return {
    id: Number(row.id),
    room_id: Number(row.room_id),
    conversation_id: row.conversation_id === null ? null : Number(row.conversation_id),
    user_id: Number(row.user_id),
    lawyer_id: Number(row.lawyer_id),
    service_type: row.service_type as OneOnOneServiceType,
    mode: row.mode as OneOnOneMode,
    unit_price: row.unit_price,
    prepaid: row.prepaid,
    consumed_units: row.consumed_units,
    settle_amount: row.settle_amount,
    refund_amount: row.refund_amount,
    diff_order_id: row.diff_order_id === null ? null : Number(row.diff_order_id),
    payment_order_id: Number(row.payment_order_id),
    status: row.status as OneOnOneStatus,
    accept_deadline:
      row.accept_deadline === null ? null : new Date(row.accept_deadline).toISOString(),
    started_at: row.started_at === null ? null : new Date(row.started_at).toISOString(),
    finished_at: row.finished_at === null ? null : new Date(row.finished_at).toISOString(),
    settle_deadline:
      row.settle_deadline === null ? null : new Date(row.settle_deadline).toISOString(),
    created_at: new Date(row.created_at).toISOString(),
  };
}

/** 实结确认 STL reason 前缀（FINISHED→SETTLING 行承载首方角色——settleConfirm 二次判别锚） */
const SETTLE_CONFIRM_REASON_PREFIX = 'settle_confirm:role=';
const SETTLE_DEFAULT_REASON = 'settle_default:system';

/** duration_seconds 上限（M-1 修复环：30 天=2_592_000s——脏回调/溢出防护，越界 400） */
const DURATION_MAX_SECONDS = 30 * 86_400;

/** PG 唯一冲突判定（M-2：并发双插败者的 23505 收口——constraint 精确匹配防误吞） */
function isUniqueViolation(e: unknown, constraint: string): boolean {
  return (
    typeof e === 'object' &&
    e !== null &&
    (e as { code?: unknown }).code === '23505' &&
    (e as { constraint?: unknown }).constraint === constraint
  );
}

@Injectable()
export class OneOnOneService {
  private readonly logger = new Logger(OneOnOneService.name);

  constructor(
    private readonly pool: PgPoolService,
    private readonly outbox: OutboxService,
    private readonly guard: StateTransitionGuardService,
    private readonly stl: StateTransitionLogService,
    private readonly scheduler: SchedulerService,
    // 跨模块消费全部走导出服务（禁跨 schema join，架构 §3.2 红线）：A2 实名闸口、B3 矩阵价、
    // C1 场次锚（room→session→lawyer）、F1 下单/读单/支付参数、F2 受理面、A3a firm_id 导出面
    private readonly realname: RealnameService,
    private readonly pricing: PricingConfigService,
    private readonly sessions: SessionService,
    private readonly payments: PaymentGatewayService,
    private readonly refunds: RefundService,
    private readonly lawyerQuals: LawyerQualificationService,
    @Inject(ONE_ON_ONE_CONFIG) private readonly config: OneOnOneConfig,
  ) {}

  // ===========================================================================
  // POST /one-on-one（§5：{room_id, service_type, mode}；402 REALNAME/400 PRICE_MISSING）
  // ===========================================================================

  async create(input: CreateOneOnOneInput): Promise<CreateOneOnOneResult> {
    const roomId = assertPositiveInt(input.room_id, 'room_id');
    const userId = assertPositiveInt(input.user_id, 'user_id');
    const serviceType = assertServiceType(input.service_type);
    const mode = assertOneOnOneMode(input.mode);

    // ---- 闸口①（事务外预检，fail-fast）：R-06 实名闸口（A2 导出面，C3 同款）
    if (!(await this.realname.isRealnameVerified(userId))) {
      throw new AppError(
        ErrorCode.RealnameRequired,
        `用户 ${userId} 未完成实名认证（R-06），不可发起 1对1 订单`,
      );
    }

    // ---- 锚解析：本域 rooms 行 → C1 场次详情导出面（lawyer_id 快照源）
    // I-5a 修复环：房间活跃门（同 schema 直查——status 非 CLOSED/CANCELLED 即可；完整成员门
    // =T3 #43 四口联动，D6 侧不越权实现——04 §8 登记归 T7）
    const roomRes = await this.pool.query<{ session_id: string; status: string }>(
      `SELECT session_id, status FROM fulfillment.rooms WHERE id = $1`,
      [roomId],
    );
    const room = roomRes.rows[0];
    if (!room) {
      throw new AppError(ErrorCode.NotFound, `房间不存在：${roomId}（1对1 订单须自房间内发起）`);
    }
    if (room.status === 'CLOSED' || room.status === 'CANCELLED') {
      throw new AppError(
        ErrorCode.Conflict,
        `房间 ${roomId} 已${room.status === 'CLOSED' ? '关闭' : '取消'}（${room.status}），不可发起 1对1 订单`,
      );
    }
    const detail = await this.sessions.getDetail(Number(room.session_id));
    const lawyerId = detail.lawyer_id;

    // ---- B3 矩阵价 current 读取（400 PRICE_MISSING 档：无版本/缺该 mode 档）
    const unitPrice = await this.currentUnitPrice(lawyerId, mode);
    moneyToCents(unitPrice); // 形态/正数校验（Money 字符串禁 float）

    try {
      return await this.pool.withTransaction(async (uow) => {
        // ---- 幂等权威判定：活跃单行锁重读（ux_ooo_active 物理兜底；入参三键=幂等键全量恒同载荷）
        const activeList = (ONE_ON_ONE_ACTIVE_STATUSES as readonly string[])
          .map((s) => `'${s}'`)
          .join(', ');
        const existing = await uow.query<OneOnOneRow>(
          `SELECT ${OOO_COLS} FROM fulfillment.one_on_one_orders
            WHERE room_id = $1 AND user_id = $2 AND service_type = $3
              AND status IN (${activeList})
            ORDER BY id DESC LIMIT 1 FOR UPDATE`,
          [roomId, userId, serviceType],
        );
        const prev = existing.rows[0];
        if (prev) {
          return this.replayCreate(toView(prev)); // 终态前同键重放原单（不重复 INSERT/下单）
        }

        // ---- INSERT（CREATED；prepaid=1 单位起付——类注 ⚠口径）
        const inserted = await uow.query<OneOnOneRow>(
          `INSERT INTO fulfillment.one_on_one_orders
             (room_id, user_id, lawyer_id, service_type, mode, unit_price, prepaid,
              consumed_units, payment_order_id, status)
           VALUES ($1, $2, $3, $4, $5, $6::numeric, $6::numeric, 0, 0, 'CREATED')
           RETURNING ${OOO_COLS}`,
          [roomId, userId, lawyerId, serviceType, mode, unitPrice],
        );
        const row = toView(inserted.rows[0]!);

        // ---- F1 同事务下单（C3 先例：幂等键=ooo/o{id}/pay；失败全回滚不烧键）
        const order = await this.payments.createOrderInTx(uow, {
          biz_type: 'ooo',
          biz_id: row.id,
          cash_amount: row.prepaid,
          points_amount: 0,
          idempotency_key: oooPayKey(row.id),
        });
        const updated = await uow.query<OneOnOneRow>(
          `UPDATE fulfillment.one_on_one_orders SET payment_order_id = $2, updated_at = now()
            WHERE id = $1 RETURNING ${OOO_COLS}`,
          [row.id, order.payment_order.id],
        );
        return {
          order: toView(updated.rows[0]!),
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
          deduplicated: false,
        };
      });
    } catch (e) {
      // M-2 修复环：并发同键双插败者（ux_ooo_active 唯一索引 23505）——胜者已提交，回读重放
      // 原单（不再 500；C3 ux-enroll-active 同款口径）。非唯一冲突照常上抛。
      if (isUniqueViolation(e, 'ux_ooo_active')) {
        const winner = await this.readActiveOrder(roomId, userId, serviceType);
        if (winner) return this.replayCreate(toView(winner));
      }
      throw e;
    }
  }

  // ===========================================================================
  // 支付收敛（PAY_SUCCESS 回调消费核心：预付/补差两形态）
  // ===========================================================================

  /**
   * 预付支付成功：CREATED→PAID + accept_deadline=paid_at+N + OneOnOnePaid 出箱 +
   * OOO_ACCEPT_TIMEOUT 同事务预写。幂等：非 CREATED 短路（重放不双推进/不双出箱/不双预写）。
   */
  async onPaySuccess(orderId: number, paidAt: Date): Promise<{ processed: boolean }> {
    const id = assertPositiveInt(orderId, 'order_id');
    await this.pool.withTransaction(async (uow) => {
      const row = await this.lockOrder(uow, id);
      if (!row) throw new AppError(ErrorCode.NotFound, `1对1 订单不存在：${id}`);
      if (row.status !== 'CREATED') return; // 幂等短路（PAID/终态重放）

      const acceptDeadline = new Date(paidAt.getTime() + this.config.acceptTimeoutMinutes * 60_000);
      await this.transition(uow, id, 'CREATED', 'PAID', 'pay_success', {
        accept_deadline: acceptDeadline,
      });
      await this.scheduler.registerJob(uow, {
        jobType: 'OOO_ACCEPT_TIMEOUT',
        refType: ONE_ON_ONE_JOB_REF_TYPE,
        refId: id,
        dueAt: acceptDeadline, // 与 accept_deadline 同锚（I2 锦定约定时刻）
      });
      const payload: OneOnOnePaidPayload = {
        order_id: id,
        user_id: Number(row.user_id),
        lawyer_id: Number(row.lawyer_id),
      };
      await this.outbox.recordOutbox(uow, { type: ONE_ON_ONE_PAID_TOPIC, payload });
    });
    return { processed: true };
  }

  /**
   * 补差支付成功收敛（C-1 修复环）：
   *   - DIFF_PENDING → SETTLED + OneOnOneSettled（gross=prepaid/net=实结落定值 含补差）；
   *   - **迟到支付**（SETTLED 且 diff 超时签名在册——OneOnOneDiffUnpaid 事件留痕）：用户资金
   *     已冻结但订单已按 prepaid 结算——发起补差单全额退款（幂等键 refund/po-{diffPo}/
   *     ooo-diff-late，reason SETTLE_REFUND），订单净额不动（settle=prepaid 维持）。**G1 的
   *     diff_unpaid 信用记录不自动冲销**——人工经 H3 工单冲正（04 §8 登记归 T7）；
   *   - SETTLED 且无超时签名=正常收敛后的回调重放（inbox 层通常已去重）——幂等短路。
   */
  async onDiffPaySuccess(orderId: number): Promise<{
    processed: boolean;
    action: 'settled' | 'diff_late_refunded' | 'deduplicated' | 'skipped';
  }> {
    const id = assertPositiveInt(orderId, 'order_id');
    let action: 'settled' | 'diff_late_refunded' | 'deduplicated' | 'skipped' = 'skipped';
    await this.pool.withTransaction(async (uow) => {
      const row = await this.lockOrder(uow, id);
      if (!row) throw new AppError(ErrorCode.NotFound, `1对1 订单不存在：${id}`);
      if (row.status === 'DIFF_PENDING') {
        const settle = row.settle_amount ?? row.prepaid;
        await this.transition(uow, id, 'DIFF_PENDING', 'SETTLED', 'diff_paid');
        await this.emitSettled(uow, toView({ ...row, status: 'SETTLED', settle_amount: settle }));
        action = 'settled';
        return;
      }
      if (row.status !== 'SETTLED') return; // 其他态（取消轨道等）：幂等短路
      // 超时签名判别：DiffUnpaid 事件在册=本单曾走 15min 超时按比例结算（迟到支付面）
      const unpaidEvents = await this.outbox.listEventsByPayload(
        uow,
        [ONE_ON_ONE_DIFF_UNPAID_TOPIC],
        'order_id',
        String(id),
      );
      if (unpaidEvents.length === 0) {
        action = 'deduplicated'; // 正常收敛后的重放（防御位）
        return;
      }
      // C-1b：迟到支付 → 补差单全额退款（F2 受理自持事务；幂等键重放恰一次）
      const diffOrder = await this.payments.findOrderByIdempotencyKey(oooDiffKey(id));
      if (!diffOrder) {
        throw new AppError(
          ErrorCode.InternalError,
          `订单 ${id} 迟到补差收敛但补差单不可读（键 ${oooDiffKey(id)}——不应触达）`,
        );
      }
      await this.refunds.accept({
        order_id: diffOrder.id,
        user_id: Number(row.user_id),
        cash: diffOrder.cash_amount,
        points: 0,
        reason: 'SETTLE_REFUND',
        idempotency_key: `refund/po-${diffOrder.id}/ooo-diff-late`,
      });
      this.logger.warn(
        `补差迟到支付退款：订单 ${id} 已按 prepaid 结算（diff 超时在先）——补差单 ${diffOrder.id} 全额退 ${diffOrder.cash_amount}；G1 diff_unpaid 信用不自动冲销（人工经 H3 工单冲正，04 §8 登记）`,
      );
      action = 'diff_late_refunded';
    });
    return { processed: action !== 'skipped', action };
  }

  // ===========================================================================
  // POST /one-on-one/{id}/accept（§5：409 TIMEOUT；幂等键=order）
  // ===========================================================================

  async accept(
    orderId: number,
    opts?: { readonly actorLawyerId?: number },
  ): Promise<{ conversation_id: number | null; deduplicated: boolean }> {
    const id = assertPositiveInt(orderId, 'order_id');
    return this.pool.withTransaction(async (uow) => {
      const row = await this.lockOrder(uow, id);
      if (!row) throw new AppError(ErrorCode.NotFound, `1对1 订单不存在：${id}`);
      const view = toView(row);
      if (opts?.actorLawyerId !== undefined && opts.actorLawyerId !== view.lawyer_id) {
        throw new AppError(
          ErrorCode.RoleForbidden,
          `律师 ${opts.actorLawyerId} 非订单 ${id} 服务律师（lawyer=${view.lawyer_id}），不可接单`,
        );
      }
      if (row.status !== 'PAID') {
        // 幂等重放半边：已接单及之后的主链态返回回填结果；超时/终态=409 TIMEOUT（不可再接）
        if (
          [
            'ACCEPTED',
            'IN_SERVICE',
            'FINISHED',
            'SETTLING',
            'REFUND_PARTIAL',
            'DIFF_PENDING',
            'SETTLED',
          ].includes(row.status)
        ) {
          return { conversation_id: view.conversation_id, deduplicated: true };
        }
        throw new AppError(
          ErrorCode.AcceptTimeout,
          `订单 ${id} 当前状态 ${row.status}——paid_at+N 未接单已进入超时/退款轨道，不可接单`,
        );
      }
      if (row.accept_deadline !== null && row.accept_deadline.getTime() <= Date.now()) {
        // 超时边界（N+1s 侧）：executor 与本口经行锁串行——此处先到即拒绝（N-1s 侧放行）
        throw new AppError(
          ErrorCode.AcceptTimeout,
          `律师接单超时：accept_deadline=${row.accept_deadline.toISOString()} 已过（paid_at+N，N=${this.config.acceptTimeoutMinutes}min）`,
        );
      }

      await this.transition(uow, id, 'PAID', 'ACCEPTED', 'lawyer_accept');
      // conversation 回填（W3-13：D5 异建会话——已达则回填返回；未达 null 由消息面补）
      const conv = await uow.query<{ id: string }>(
        `SELECT id FROM fulfillment.conversations WHERE type = 'one_on_one' AND ref_id = $1`,
        [id],
      );
      const conversationId = conv.rows[0] ? Number(conv.rows[0]!.id) : null;
      if (conversationId !== null) {
        await uow.query(
          `UPDATE fulfillment.one_on_one_orders SET conversation_id = $2, updated_at = now()
            WHERE id = $1 AND conversation_id IS NULL`,
          [id, conversationId],
        );
      }
      const payload: OneOnOneAcceptedPayload = {
        order_id: id,
        conversation_id: conversationId,
        lawyer_id: view.lawyer_id,
      };
      await this.outbox.recordOutbox(uow, { type: ONE_ON_ONE_ACCEPTED_TOPIC, payload });
      return { conversation_id: conversationId, deduplicated: false };
    });
  }

  // ===========================================================================
  // 计量（W3-8 IN_SERVICE 锚 / W3-9 幂等单调上界 / W3-15 系统计量事实源）
  // ===========================================================================

  /**
   * RTC 时长回调（dev 面 POST /one-on-one/{id}/duration；mock 注入用——HTTP 面另有环境闸
   * I-5b）：段数=ceil(秒/900) 单调上界；duration=0=会话开启信标（触发 IN_SERVICE 不计段
   * ——R-03 ③「consumed=0 未满首个 15min」的可达路径）；M-1：>30 天 400（脏回调防溢出）。
   */
  async recordDuration(orderId: number, durationSeconds: number): Promise<RecordDurationResult> {
    const id = assertPositiveInt(orderId, 'order_id');
    const duration = assertNonNegativeIntField(durationSeconds, 'duration_seconds');
    if (duration > DURATION_MAX_SECONDS) {
      // M-1 修复环：30 天上限——脏回调/溢出防护（>prepaid×任意倍数的荒谬时长不入场）
      throw new AppError(
        ErrorCode.InvalidArgument,
        `duration_seconds 超上限（≤${DURATION_MAX_SECONDS}=30 天）：${duration}`,
      );
    }
    const segments = segmentsOfDuration(duration);
    let triggered = false;
    const view = await this.pool.withTransaction(async (uow) => {
      const row = await this.lockOrder(uow, id);
      if (!row) throw new AppError(ErrorCode.NotFound, `1对1 订单不存在：${id}`);
      if (row.mode === 'text') {
        throw new AppError(
          ErrorCode.InvalidArgument,
          `订单 ${id} 为 text 模式——时长回调仅适用 voice/video（text 计量=会话轮次）`,
        );
      }
      if (row.status === 'ACCEPTED') {
        // W3-8：voice/video 首次时长回调=IN_SERVICE 锚
        await this.transition(uow, id, 'ACCEPTED', 'IN_SERVICE', 'rtc_duration_first', {
          started_at: new Date(),
        });
        triggered = true;
      }
      if (!triggered && row.status !== 'IN_SERVICE') {
        return toView(row); // 早到（未接单）/晚到（已实结）回调：幂等无操作（不重复计数）
      }
      // W3-9 单调上界：consumed_units=GREATEST(现值, 段数)——重复/乱序回调不重复计数
      const updated = await uow.query<OneOnOneRow>(
        `UPDATE fulfillment.one_on_one_orders
           SET consumed_units = GREATEST(consumed_units, $2), updated_at = now()
          WHERE id = $1 RETURNING ${OOO_COLS}`,
        [id, segments],
      );
      return toView(updated.rows[0]!);
    });
    return { order: view, segments, in_service_triggered: triggered };
  }

  /**
   * MESSAGE_SENT 消费核心（text 锚+轮次；voice/video 的会话消息不计量——其 IN_SERVICE 锚
   * =时长回调）。轮次=消息表确定性重算：律师答消息且其与上一条律师答之间存在用户问=1 轮
   * （重复/乱序事件投递幂等——重算值只随消息行增长；consumed=GREATEST(现值,重算值)）。
   */
  async onMessageSent(
    conversationId: number,
    seq: number,
  ): Promise<{ applied: boolean; rounds: number | null }> {
    const convId = assertPositiveInt(conversationId, 'conversation_id');
    const seqNo = assertPositiveIntField(seq, 'seq');
    return this.pool.withTransaction(async (uow) => {
      const conv = await uow.query<{ type: string; ref_id: string }>(
        `SELECT type, ref_id FROM fulfillment.conversations WHERE id = $1`,
        [convId],
      );
      const conversation = conv.rows[0];
      if (!conversation || conversation.type !== 'one_on_one') {
        return { applied: false, rounds: null }; // room/private 会话：非 D6 计量面
      }
      const id = Number(conversation.ref_id);
      const row = await this.lockOrder(uow, id);
      if (!row) {
        throw new AppError(
          ErrorCode.InternalError,
          `one_on_one 会话 ${convId} 的订单 ${id} 不可读（不应触达——D5 建会话锚=OneOnOnePaid）`,
        );
      }
      // conversation 回填半边（W3-13：accept 早于 D5 建会话的补锚）
      if (row.conversation_id === null) {
        await uow.query(
          `UPDATE fulfillment.one_on_one_orders SET conversation_id = $2, updated_at = now()
            WHERE id = $1 AND conversation_id IS NULL`,
          [id, convId],
        );
      }
      const sender = await uow.query<{ sender_role: string }>(
        `SELECT sender_role FROM fulfillment.messages WHERE conversation_id = $1 AND seq = $2`,
        [convId, seqNo],
      );
      const senderRole = sender.rows[0]?.sender_role;
      if (senderRole !== 'user' && senderRole !== 'lawyer') {
        throw new AppError(
          ErrorCode.InternalError,
          `消息 ${convId}#${seqNo} 不可读或角色漂移（不应触达）`,
        );
      }
      if (row.mode !== 'text') return { applied: false, rounds: null }; // voice/video 消息不计量

      if (senderRole === 'user' && row.status === 'ACCEPTED') {
        // W3-8 text 锚：accept 后首条用户消息
        await this.transition(uow, id, 'ACCEPTED', 'IN_SERVICE', 'first_user_message', {
          started_at: new Date(),
        });
        return { applied: true, rounds: row.consumed_units };
      }
      if (row.status !== 'ACCEPTED' && row.status !== 'IN_SERVICE') {
        return { applied: false, rounds: null }; // 终态/未接单：消息不计量（服务未开/已收）
      }
      // 轮次确定性重算（同事务防并发双计：行锁+消息表读同快照）。
      // M-7 评审登记注记：ACCEPTED 态（用户 accept 前已问、律师接单即答）的先答轮次亦计入
      // （问答对完整即服务已交付——确定性重算口径）；「accept 前律师可答」的产品口径待拍板
      // （04 §8 登记归 T7），翻转时在此收紧重算窗口。
      const rounds = await this.recountRounds(uow, convId);
      if (row.consumed_units < rounds) {
        await uow.query(
          `UPDATE fulfillment.one_on_one_orders
             SET consumed_units = GREATEST(consumed_units, $2), updated_at = now()
            WHERE id = $1`,
          [id, rounds],
        );
      }
      return { applied: true, rounds };
    });
  }

  // ===========================================================================
  // POST /one-on-one/{id}/finish（§5：409 NOT_IN_SERVICE；consumed 声明仅回执 W3-15）
  // ===========================================================================

  async finish(
    orderId: number,
    declaredConsumedUnits?: number,
    opts?: { readonly actorLawyerId?: number },
  ): Promise<FinishOneOnOneResult> {
    const id = assertPositiveInt(orderId, 'order_id');
    const declared =
      declaredConsumedUnits === undefined
        ? null
        : assertNonNegativeIntField(declaredConsumedUnits, 'consumed_units');
    const view = await this.pool.withTransaction(async (uow) => {
      const row = await this.lockOrder(uow, id);
      if (!row) throw new AppError(ErrorCode.NotFound, `1对1 订单不存在：${id}`);
      if (opts?.actorLawyerId !== undefined && opts.actorLawyerId !== Number(row.lawyer_id)) {
        throw new AppError(
          ErrorCode.RoleForbidden,
          `律师 ${opts.actorLawyerId} 非订单 ${id} 服务律师（lawyer=${row.lawyer_id}），不可声明完成`,
        );
      }
      if (row.status !== 'IN_SERVICE') {
        throw new AppError(
          ErrorCode.NotInService,
          `订单 ${id} 当前状态 ${row.status}（须 IN_SERVICE 才可声明完成；重复 finish=幂等口径由 SETTLING 后续链承载）`,
        );
      }
      const now = new Date();
      const settleDeadline = new Date(now.getTime() + this.config.settleDefaultMinutes * 60_000);
      await this.transition(uow, id, 'IN_SERVICE', 'FINISHED', 'lawyer_finish', {
        finished_at: now,
        settle_deadline: settleDeadline,
      });
      await this.scheduler.registerJob(uow, {
        jobType: 'OOO_SETTLE_DEFAULT',
        refType: ONE_ON_ONE_JOB_REF_TYPE,
        refId: id,
        dueAt: settleDeadline, // =finished_at+30min（D9 配置化，W3-2）
      });
      const updated = toView({
        ...row,
        status: 'FINISHED',
        finished_at: now,
        settle_deadline: settleDeadline,
      });
      // 完成时点暂估实结（unit_price×系统计量）——Settled 落定值以确认/默认为准
      const tentative = centsToMoney(moneyToCents(row.unit_price) * row.consumed_units);
      const payload: OneOnOneFinishedPayload = {
        order_id: id,
        user_id: Number(row.user_id),
        lawyer_id: Number(row.lawyer_id),
        consumed_units: row.consumed_units,
        settle_amount: tentative,
      };
      await this.outbox.recordOutbox(uow, { type: ONE_ON_ONE_FINISHED_TOPIC, payload });
      return updated;
    });
    const advisory =
      declared === null
        ? null
        : { declared, system: view.consumed_units, matches: declared === view.consumed_units };
    return { order: view, advisory };
  }

  // ===========================================================================
  // POST /one-on-one/{id}/settle-confirm（§5：409 MISMATCH；双方各一次，幂等键=order）
  // ===========================================================================

  async settleConfirm(
    orderId: number,
    input: { readonly role: 'user' | 'lawyer'; readonly settle_amount: string },
    opts?: { readonly actorUserId?: number },
  ): Promise<SettleConfirmResult> {
    const id = assertPositiveInt(orderId, 'order_id');
    if (input.role !== 'user' && input.role !== 'lawyer') {
      throw new AppError(ErrorCode.InvalidArgument, `role 须为 user|lawyer：${String(input.role)}`);
    }
    const settleCents = moneyToCents(input.settle_amount); // Money 形态校验（两位小数非负）
    const settleMoney = centsToMoney(settleCents);

    // 预读（actor 归属校验用；权威判定在事务内行锁后）
    const pre = await this.readOrder(id);
    if (!pre) throw new AppError(ErrorCode.NotFound, `1对1 订单不存在：${id}`);
    if (opts?.actorUserId !== undefined) {
      const owner = input.role === 'user' ? Number(pre.user_id) : Number(pre.lawyer_id);
      if (opts.actorUserId !== owner) {
        throw new AppError(
          ErrorCode.RoleForbidden,
          `用户 ${opts.actorUserId} 非订单 ${id} 的确认方（${input.role} 侧属主=${owner}）`,
        );
      }
    }

    if (pre.status === 'SETTLED') {
      // 幂等重放：双方一致已结算——同额=回执，异额=409 MISMATCH（事后翻供不允许）
      if ((pre.settle_amount ?? '') === settleMoney) {
        return { status: 'SETTLED', deduplicated: true };
      }
      throw new AppError(
        ErrorCode.SettleMismatch,
        `订单 ${id} 已按 ${pre.settle_amount ?? ''} 结算——确认值 ${settleMoney} 与落定值不一致`,
      );
    }
    if (pre.status !== 'FINISHED' && pre.status !== 'SETTLING') {
      throw new AppError(
        ErrorCode.NotConfirmed,
        `订单 ${id} 当前状态 ${pre.status}——实结确认窗未开（须 FINISHED/SETTLING）`,
      );
    }

    if (pre.status === 'FINISHED') {
      // ---- 首次确认：落值+角色（STL reason 承载）→ SETTLING，待另一方
      await this.pool.withTransaction(async (uow) => {
        const row = await this.lockOrder(uow, id);
        if (!row || row.status !== 'FINISHED') {
          throw new AppError(
            ErrorCode.StateStaleEntity,
            `订单 ${id} 已被并发迁移（确认窗状态漂移，请重读重试）`,
          );
        }
        await this.transition(
          uow,
          id,
          'FINISHED',
          'SETTLING',
          `${SETTLE_CONFIRM_REASON_PREFIX}${input.role}`,
          { settle_amount: settleMoney },
        );
      });
      return { status: 'SETTLING' };
    }

    // ---- status=SETTLING：二次确认（角色须为另一方；金额须相等）
    const firstRole = await this.firstConfirmRole(id);
    if (firstRole === null) {
      throw new AppError(
        ErrorCode.InternalError,
        `订单 ${id} 处于 SETTLING 但 SETTLING 迁移留痕不可读（不应触达）`,
      );
    }
    if (firstRole === input.role) {
      // 同角色重复：同额=幂等重放（幂等键=order）；异额=409 MISMATCH（不可翻改自己的确认）
      if ((pre.settle_amount ?? '') === settleMoney) {
        return { status: 'SETTLING', deduplicated: true };
      }
      throw new AppError(
        ErrorCode.SettleMismatch,
        `订单 ${id} 的 ${input.role} 侧已确认 ${pre.settle_amount ?? ''}——同侧二次确认不可改值（${settleMoney}）`,
      );
    }
    if ((pre.settle_amount ?? '') !== settleMoney) {
      throw new AppError(
        ErrorCode.SettleMismatch,
        `双方实结确认不一致：${firstRole} 侧 ${pre.settle_amount ?? ''} ≠ ${input.role} 侧 ${settleMoney}`,
      );
    }
    const view = await this.finalizeSettlement(
      id,
      settleMoney,
      `both_confirm:${firstRole}+${input.role}`,
    );
    // 少补=DIFF_PENDING（补差支付后 SETTLED）；恰好/多退=SETTLED——按落定实况回显
    return { status: view.status === 'DIFF_PENDING' ? 'DIFF_PENDING' : 'SETTLED', order: view };
  }

  // ===========================================================================
  // POST /one-on-one/{id}/settle-diff/pay（§5：409 NOT_CONFIRMED；幂等键=order）
  // ===========================================================================

  /** 补差支付参数面（dev mock 通道预下单即成功形态 #40；真链时点=M5-6b） */
  async settleDiffPay(
    orderId: number,
    opts?: { readonly actorUserId?: number },
  ): Promise<{
    diff_payment_order: {
      readonly id: number;
      readonly biz_type: string;
      readonly biz_id: number;
      readonly cash_amount: string;
      readonly total: string;
      readonly status: string;
      readonly idempotency_key: string;
    };
    readonly pay_params: Record<string, unknown>;
  }> {
    const id = assertPositiveInt(orderId, 'order_id');
    const row = await this.readOrder(id);
    if (!row) throw new AppError(ErrorCode.NotFound, `1对1 订单不存在：${id}`);
    if (opts?.actorUserId !== undefined && opts.actorUserId !== Number(row.user_id)) {
      throw new AppError(
        ErrorCode.RoleForbidden,
        `用户 ${opts.actorUserId} 非订单 ${id} 属主（user=${row.user_id}），不可支付补差`,
      );
    }
    if (row.status !== 'DIFF_PENDING') {
      throw new AppError(
        ErrorCode.NotConfirmed,
        `订单 ${id} 当前状态 ${row.status}——补差单未挂起（须 DIFF_PENDING；实结>预付时结算动作生成补差单）`,
      );
    }
    const order = await this.payments.findOrderByIdempotencyKey(oooDiffKey(id));
    if (!order) {
      throw new AppError(
        ErrorCode.InternalError,
        `订单 ${id} 补差支付单不可读（幂等键 ${oooDiffKey(id)}——不应触达）`,
      );
    }
    return {
      diff_payment_order: {
        id: order.id,
        biz_type: order.biz_type,
        biz_id: order.biz_id,
        cash_amount: order.cash_amount,
        total: order.total,
        status: order.status,
        idempotency_key: order.idempotency_key,
      },
      pay_params: this.payments.payParamsFor(order) as unknown as Record<string, unknown>,
    };
  }

  // ===========================================================================
  // POST /one-on-one/{id}/cancel（§5：409 NOT_CANCELLABLE；R-03 三档）
  // ===========================================================================

  async cancel(
    orderId: number,
    opts?: { readonly role?: 'user' | 'lawyer'; readonly actorUserId?: number },
  ): Promise<CancelOneOnOneResult> {
    const id = assertPositiveInt(orderId, 'order_id');
    const role = opts?.role ?? 'user';
    if (role !== 'user' && role !== 'lawyer') {
      throw new AppError(ErrorCode.InvalidArgument, `role 须为 user|lawyer：${String(role)}`);
    }
    const pre = await this.readOrder(id);
    if (!pre) throw new AppError(ErrorCode.NotFound, `1对1 订单不存在：${id}`);
    if (opts?.actorUserId !== undefined) {
      const owner = role === 'user' ? Number(pre.user_id) : Number(pre.lawyer_id);
      if (opts.actorUserId !== owner) {
        throw new AppError(
          ErrorCode.RoleForbidden,
          `用户 ${opts.actorUserId} 非订单 ${id} 的 ${role} 侧属主（=${owner}），不可取消`,
        );
      }
    }

    // ---- 分支路由（崩溃窗口 CANCELLED 行重入续跑；已收敛终态=幂等回执/409）
    if (
      !['PAID', 'ACCEPTED', 'IN_SERVICE', 'CANCELLED', 'REFUNDED', 'PARTIAL_REFUNDED'].includes(
        pre.status,
      )
    ) {
      throw new AppError(
        ErrorCode.NotCancellable,
        `订单 ${id} 不可取消（当前状态 ${pre.status}——已入实结链/超时轨道/已结算）`,
      );
    }
    if (pre.status === 'REFUNDED' || pre.status === 'PARTIAL_REFUNDED') {
      const wasCancelled =
        (
          await this.stl.listAllowedTransitions({
            entityType: 'one_on_one_order',
            toStatus: 'CANCELLED',
            entityIds: [id],
          })
        ).length > 0;
      if (!wasCancelled) {
        throw new AppError(
          ErrorCode.NotCancellable,
          `订单 ${id} 已 ${pre.status}（非取消轨道：接单超时自动退款），不可取消`,
        );
      }
      return {
        order: toView(pre),
        refund: {
          kind: pre.status === 'REFUNDED' ? 'FULL' : 'PARTIAL',
          amount: pre.status === 'REFUNDED' ? pre.prepaid : (pre.refund_amount ?? '0.00'),
          refund_id: null,
        },
        deduplicated: true,
      };
    }

    // ---- R-03 三档金额解算（settleCents=收取额；refundCents=退还额）
    // I-2 评审登记注记：②③的保留额（settleCents）当前无 F3 结算出口——取消路径只发 F2 退差
    // 指令不产 OneOnOneSettled（场次取消同口径：取消走退款轨道禁双轨）；律师收取侧兑付=
    // F3 结算链扩展（与 I-3 的 gross 构成对齐一并在 M2 联调闭合，04 §8 登记归 T7）。
    const unitCents = moneyToCents(pre.unit_price);
    const prepaidCents = moneyToCents(pre.prepaid);
    let refundCents: number;
    let full: boolean;
    if (pre.status === 'CANCELLED') {
      // B-1 终审修复波（BLOCKER）：崩溃窗重入（步骤一已提交 CANCELLED+refund_amount、
      // F2 受理/终态化未达）——**以步骤一原子持久化的 refund_amount 为权威**续跑，禁按
      // status 重算档位：重入态非 IN_SERVICE 会使解算恒退化为全退（③voice consumed≥1 封顶
      // 情形将以全退键 refund/po-{po}/ooo-cancel 超退整单 prepaid——资损面）。full 判据=
      // 已持久化退款额等于 prepaid。
      if (pre.refund_amount === null) {
        throw new AppError(
          ErrorCode.InternalError,
          `订单 ${id} 处于 CANCELLED 但 refund_amount 缺失（不应触达——取消步骤一原子写入）`,
        );
      }
      refundCents = moneyToCents(pre.refund_amount);
      full = refundCents >= prepaidCents;
    } else {
      let settleCents = 0;
      if (pre.status === 'IN_SERVICE') {
        if (pre.mode === 'text') {
          // ②开始后文字：settle=单价×已完成轮次（封顶 prepaid——cancel 无补差出边，类注口径）
          settleCents = Math.min(unitCents * pre.consumed_units, prepaidCents);
        } else {
          // ③开始后音视频：consumed=0 收 1 单位 50%（floor 到分）退其余；≥1 实结（封顶同上）
          settleCents =
            pre.consumed_units === 0
              ? Math.floor(unitCents / 2)
              : Math.min(unitCents * pre.consumed_units, prepaidCents);
        }
      }
      // ① IN_SERVICE 前：settle=0 全退（含 text 已开始但 0 轮完成形态——服务未交付）
      refundCents = Math.max(0, prepaidCents - settleCents);
      full = settleCents === 0;
    }

    if (pre.status !== 'CANCELLED') {
      // ---- 步骤一：CANCELLED（受理先行于退款指令——D4 双路径先例）
      await this.pool.withTransaction(async (uow) => {
        const row = await this.lockOrder(uow, id);
        if (!row || row.status !== pre.status) {
          throw new AppError(
            ErrorCode.StateStaleEntity,
            `订单 ${id} 已被并发迁移（取消分支状态漂移，请重读重试）`,
          );
        }
        await this.transition(
          uow,
          id,
          row.status as OneOnOneStatus,
          'CANCELLED',
          `ooo_cancel:${role}`,
          {
            refund_amount: centsToMoney(refundCents),
          },
        );
      });
    }

    // ---- 步骤二：F2 受理（幂等键重放；full=①全退键 / partial=②③部分键——同单不可两键全退）
    let refundId: number | null = null;
    if (refundCents > 0) {
      const accepted = await this.refunds.accept({
        order_id: Number(pre.payment_order_id),
        user_id: Number(pre.user_id),
        cash: centsToMoney(refundCents),
        points: 0,
        reason: 'OOO_CANCEL',
        idempotency_key: full
          ? oooCancelRefundKey(Number(pre.payment_order_id))
          : oooCancelPartialRefundKey(Number(pre.payment_order_id)),
      });
      refundId = accepted.refund.refund_id;
    }

    // ---- 步骤三：终态化（CANCELLED→REFUNDED/PARTIAL_REFUNDED；已收敛=幂等跳过）
    const target = full ? 'REFUNDED' : 'PARTIAL_REFUNDED';
    await this.pool.withTransaction(async (uow) => {
      const row = await this.lockOrder(uow, id);
      if (!row || row.status !== 'CANCELLED') return; // 并发胜者/重放已收敛
      await this.transition(uow, id, 'CANCELLED', target, 'cancel_refund_accepted');
    });
    const after = (await this.readOrder(id))!;
    return {
      order: toView(after),
      refund: {
        kind: full ? 'FULL' : refundCents > 0 ? 'PARTIAL' : 'NONE',
        amount: centsToMoney(refundCents),
        refund_id: refundId,
      },
    };
  }

  // ===========================================================================
  // RefundCompleted 收敛（F2 退款完成 → 订单终态；enrollment advanceToRefunded 同形态）
  // ===========================================================================

  /**
   * 退款完成收敛：LAWYER_TIMEOUT→REFUNDED（超时全退）；CANCELLED→REFUNDED/PARTIAL_REFUNDED
   * （取消受理崩溃窗口兜底——按退款额与 prepaid 全等判全/部分）。已终态/其他态=幂等短路。
   * refundCents=本笔退款单金额（cash+points 折分；D6 订单 cash-only，恒精确）。
   */
  async advanceRefundCompleted(
    orderId: number,
    refundCents: number,
  ): Promise<{ advanced: boolean }> {
    const id = assertPositiveInt(orderId, 'order_id');
    await this.pool.withTransaction(async (uow) => {
      const row = await this.lockOrder(uow, id);
      if (!row) throw new AppError(ErrorCode.NotFound, `1对1 订单不存在：${id}`);
      if (row.status === 'LAWYER_TIMEOUT') {
        await this.transition(uow, id, 'LAWYER_TIMEOUT', 'REFUNDED', 'refund_completed');
        return;
      }
      if (row.status === 'CANCELLED') {
        const full = refundCents >= moneyToCents(row.prepaid);
        await this.transition(
          uow,
          id,
          'CANCELLED',
          full ? 'REFUNDED' : 'PARTIAL_REFUNDED',
          'refund_completed',
        );
      }
      // REFUNDED/PARTIAL_REFUNDED/SETTLED 等：幂等短路（多退实结路径自行终态化，不经本面）
    });
    return { advanced: true };
  }

  // ===========================================================================
  // I2 执行器核心（OOO_ACCEPT_TIMEOUT / OOO_SETTLE_DEFAULT / DIFF_PAY_TIMEOUT）
  // ===========================================================================

  /** executor 回查锚（I2 目录 recheckAnchor=订单状态）：给定态集合内才需触发 */
  async statusIn(
    exec: SqlExecutor,
    orderId: number,
    statuses: readonly string[],
  ): Promise<boolean> {
    const res = await exec.query<{ status: string }>(
      `SELECT status FROM fulfillment.one_on_one_orders WHERE id = $1`,
      [assertPositiveInt(orderId, 'order_id')],
    );
    const status = res.rows[0]?.status;
    return status !== undefined && statuses.includes(status);
  }

  /** OOO_ACCEPT_TIMEOUT：PAID 未接单 → LAWYER_TIMEOUT + OneOnOneLawyerTimeout 出箱（F2 消费全退） */
  async acceptTimeoutExecute(
    uow: SqlExecutor,
    orderId: number,
  ): Promise<{ order_id: number; status: string }> {
    const id = assertPositiveInt(orderId, 'order_id');
    const row = await this.lockOrder(uow, id);
    if (!row) throw new AppError(ErrorCode.NotFound, `1对1 订单不存在：${id}`);
    if (row.status !== 'PAID') return { order_id: id, status: row.status }; // recheck 后防御（已接单/已取消）
    await this.transition(uow, id, 'PAID', 'LAWYER_TIMEOUT', 'accept_timeout');
    const payload: OneOnOneLawyerTimeoutPayload = {
      order_id: id,
      user_id: Number(row.user_id),
      payment_order_id: Number(row.payment_order_id), // 资金面免跨域查增补（F2 消费定位 F1 单）
    };
    await this.outbox.recordOutbox(uow, { type: ONE_ON_ONE_LAWYER_TIMEOUT_TOPIC, payload });
    this.logger.warn(`接单超时：订单 ${id} → LAWYER_TIMEOUT（F2 全额退款消费受理中）`);
    return { order_id: id, status: 'LAWYER_TIMEOUT' };
  }

  /**
   * OOO_SETTLE_DEFAULT（30min 默认确认，D9 配置化）：FINISHED=系统计量值双默认；
   * **SETTLING=半默认锚系统计量**（I-1 修复环：不采信首方声明值——低报防线；
   * settle=clamp[0, unit_price×consumed_units]，少补>prepaid 合法域经补差承载）——
   * **例外（H-1 终审修复波）**：在册 ooo-settle 退款单（双确认多退崩溃窗）=共识值权威，
   * 尊重已落 settle_amount 禁系统计量覆盖。多退=F2 受理（自持事务，崩溃窗口重放幂等收敛）；
   * 少补=F1 补差单同 uow。其他态=幂等无操作。
   */
  async settleDefaultExecute(
    uow: SqlExecutor,
    orderId: number,
  ): Promise<{ order_id: number; status: string }> {
    const id = assertPositiveInt(orderId, 'order_id');
    const row = await this.lockOrder(uow, id);
    if (!row) throw new AppError(ErrorCode.NotFound, `1对1 订单不存在：${id}`);
    if (row.status === 'FINISHED') {
      const settle = this.systemSettleOf(row);
      // 系统计量值「双默认」：一次迁移承载（SETTLING 留痕 reason=system 默认，不逐一模拟双方）
      await this.transition(uow, id, 'FINISHED', 'SETTLING', SETTLE_DEFAULT_REASON, {
        settle_amount: settle,
      });
      await this.finalizeInUow(
        uow,
        toView({ ...row, status: 'SETTLING', settle_amount: settle }),
        settle,
        'settle_default',
      );
      // M-3 修复环：落定实况回读（少补挂起=DIFF_PENDING 非 SETTLED——出参不再虚报）
      const after = await this.readOrderInTx(uow, id);
      return { order_id: id, status: after?.status ?? 'SETTLED' };
    }
    if (row.status === 'SETTLING') {
      // H-1 终审修复波：**双确认多退崩溃窗**（双方一致已确认→F2 ooo-settle 受理已提交而终态化
      // 未达，30min 默认先于客户端重试触发）——在册 ooo-settle 退款单为权威：尊重已落
      // settle_amount 共识值收敛（系统计量不得覆盖——退款已按共识额发出，重算会造成
      // 「共识值被覆盖+同键异额受理冲突」双面漂移）；无在册退款单=首方单独确认的半默认
      // → I-1 口径锚系统计量（不采信首方声明值——低报防线）。
      const settleRefund = (await this.refunds.listByOrderId(Number(row.payment_order_id))).find(
        (r) => r.idempotency_key === oooSettleRefundKey(Number(row.payment_order_id)),
      );
      let settle: string;
      if (settleRefund) {
        settle = row.settle_amount ?? row.prepaid; // 双确认共识值（多退受理在册——禁覆盖）
      } else {
        // I-1：半默认改锚系统计量（首方声明值弃用——覆盖写 settle_amount 后按系统值结算）
        settle = this.systemSettleOf(row);
        await uow.query(
          `UPDATE fulfillment.one_on_one_orders SET settle_amount = $2, updated_at = now()
            WHERE id = $1`,
          [id, settle],
        );
      }
      await this.finalizeInUow(
        uow,
        toView({ ...row, settle_amount: settle }),
        settle,
        'settle_default',
      );
      const after = await this.readOrderInTx(uow, id);
      return { order_id: id, status: after?.status ?? 'SETTLED' };
    }
    return { order_id: id, status: row.status }; // SETTLED/取消轨道/补差在途：幂等无操作
  }

  /**
   * DIFF_PAY_TIMEOUT（15min 未付）：按已服务比例结算（settle=prepaid——用户已付即所收）
   * → SETTLED + OneOnOneSettled（net=prepaid）+ OneOnOneDiffUnpaid 出箱（G1 W3-11）。
   * **C-1a 竞态回查**：执行超时路径前查补差 F1 单态——已 FROZEN/PAID=支付先达（executor
   * 锁窗外竞态），改走已付收敛（SETTLED+OneOnOneSettled net=实结 含补差），不发 DiffUnpaid
   * 不扣信用。补差 F1 单保持 CREATED（C3 未支付清场同款：不发明关单指令，真通道关单=M2 批）。
   */
  async diffPayTimeoutExecute(
    uow: SqlExecutor,
    orderId: number,
  ): Promise<{ order_id: number; status: string }> {
    const id = assertPositiveInt(orderId, 'order_id');
    const row = await this.lockOrder(uow, id);
    if (!row) throw new AppError(ErrorCode.NotFound, `1对1 订单不存在：${id}`);
    if (row.status !== 'DIFF_PENDING') return { order_id: id, status: row.status };
    // C-1a：支付竞态回查（F1 导出面只读——不占 fulfillment 锁序）
    const diffOrder = await this.payments.findOrderByIdempotencyKey(oooDiffKey(id));
    if (diffOrder && (diffOrder.status === 'FROZEN' || diffOrder.status === 'PAID')) {
      const settle = row.settle_amount ?? row.prepaid;
      await this.transition(uow, id, 'DIFF_PENDING', 'SETTLED', 'diff_paid_racing_timeout');
      await this.emitSettled(uow, toView({ ...row, status: 'SETTLED', settle_amount: settle }));
      this.logger.warn(
        `补差超时 job 撞已付（竞态收敛）：订单 ${id} 补差单已 ${diffOrder.status}——按实结 ${settle} 结算，不发 DiffUnpaid`,
      );
      return { order_id: id, status: 'SETTLED' };
    }
    await this.transition(uow, id, 'DIFF_PENDING', 'SETTLED', 'diff_timeout_settle', {
      settle_amount: row.prepaid, // 按已服务比例结算=net 收敛到 prepaid
    });
    const settled = toView({ ...row, status: 'SETTLED', settle_amount: row.prepaid });
    await this.emitSettled(uow, settled);
    await this.outbox.recordOutbox(uow, {
      type: ONE_ON_ONE_DIFF_UNPAID_TOPIC,
      payload: { order_id: id, user_id: Number(row.user_id) } satisfies OneOnOneDiffUnpaidPayload,
    });
    this.logger.warn(
      `补差 15min 未付：订单 ${id} 按已服务比例结算（settle=prepaid=${row.prepaid}）+G1 信用记录`,
    );
    return { order_id: id, status: 'SETTLED' };
  }

  // ===========================================================================
  // 内部件
  // ===========================================================================

  /** 结算动作（双方确认一致路径）：多退=F2 受理先行→终态化；恰好/少补=单事务 */
  private async finalizeSettlement(
    orderId: number,
    settleMoney: string,
    reason: string,
  ): Promise<OneOnOneOrderView> {
    const pre = await this.readOrder(orderId);
    if (!pre) throw new AppError(ErrorCode.NotFound, `1对1 订单不存在：${orderId}`);
    const settleCents = moneyToCents(settleMoney);
    const prepaidCents = moneyToCents(pre.prepaid);

    if (settleCents > prepaidCents) {
      // 少补：F1 补差单同事务（不扣款——用户确认支付后经 settle-diff/pay + PAY_SUCCESS 收敛）
      return this.pool.withTransaction(async (uow) => {
        const row = await this.lockOrder(uow, orderId);
        if (!row || row.status !== 'SETTLING') {
          throw new AppError(
            ErrorCode.StateStaleEntity,
            `订单 ${orderId} 已被并发迁移（实结落定漂移）`,
          );
        }
        await this.finalizeInUow(uow, toView(row), settleMoney, reason);
        return (await this.readOrderInTx(uow, orderId))!;
      });
    }
    if (settleCents < prepaidCents) {
      // 多退：F2 受理先行（SETTLE_REFUND；崩溃窗口=重放幂等键收敛——类注）
      const refundCents = prepaidCents - settleCents;
      await this.refunds.accept({
        order_id: Number(pre.payment_order_id),
        user_id: Number(pre.user_id),
        cash: centsToMoney(refundCents),
        points: 0,
        reason: 'SETTLE_REFUND',
        idempotency_key: oooSettleRefundKey(Number(pre.payment_order_id)),
      });
      return this.pool.withTransaction(async (uow) => {
        const row = await this.lockOrder(uow, orderId);
        if (!row || row.status !== 'SETTLING') {
          throw new AppError(
            ErrorCode.StateStaleEntity,
            `订单 ${orderId} 已被并发迁移（实结落定漂移）`,
          );
        }
        await this.transition(uow, orderId, 'SETTLING', 'REFUND_PARTIAL', reason, {
          refund_amount: centsToMoney(refundCents),
        });
        await this.transition(
          uow,
          orderId,
          'REFUND_PARTIAL',
          'SETTLED',
          'settle_refund_instructed',
        );
        const settled = (await this.readOrderInTx(uow, orderId))!;
        await this.emitSettled(uow, settled);
        return settled;
      });
    }
    // 恰好：SETTLING→SETTLED 单事务
    return this.pool.withTransaction(async (uow) => {
      const row = await this.lockOrder(uow, orderId);
      if (!row || row.status !== 'SETTLING') {
        throw new AppError(
          ErrorCode.StateStaleEntity,
          `订单 ${orderId} 已被并发迁移（实结落定漂移）`,
        );
      }
      await this.finalizeInUow(uow, toView(row), settleMoney, reason);
      return (await this.readOrderInTx(uow, orderId))!;
    });
  }

  /**
   * 结算动作 uow 形态（executor 与确认路径共用核；调用方已确保 status=SETTLING 且行锁在手）：
   * 恰好→SETTLED；多退→F2 受理（自持事务）+REFUND_PARTIAL→SETTLED；少补→F1 补差单
   * （同 uow）+DIFF_PENDING+OneOnOneDiffPending 出箱+DIFF_PAY_TIMEOUT 预写。
   */
  private async finalizeInUow(
    uow: SqlExecutor,
    row: OneOnOneOrderView,
    settleMoney: string,
    reason: string,
  ): Promise<void> {
    const settleCents = moneyToCents(settleMoney);
    const prepaidCents = moneyToCents(row.prepaid);
    if (settleCents > prepaidCents) {
      const diffMoney = centsToMoney(settleCents - prepaidCents);
      const diffOrder = await this.payments.createOrderInTx(uow, {
        biz_type: 'ooo_diff',
        biz_id: row.id,
        cash_amount: diffMoney,
        points_amount: 0,
        idempotency_key: oooDiffKey(row.id),
      });
      await uow.query(
        `UPDATE fulfillment.one_on_one_orders
           SET diff_order_id = $2, updated_at = now() WHERE id = $1`,
        [row.id, diffOrder.payment_order.id],
      );
      await this.transition(uow, row.id, 'SETTLING', 'DIFF_PENDING', reason);
      await this.scheduler.registerJob(uow, {
        jobType: 'DIFF_PAY_TIMEOUT',
        refType: ONE_ON_ONE_JOB_REF_TYPE,
        refId: row.id,
        dueAt: new Date(Date.now() + this.config.diffPayMinutes * 60_000), // +15min（R-02）
      });
      await this.outbox.recordOutbox(uow, {
        type: ONE_ON_ONE_DIFF_PENDING_TOPIC,
        payload: {
          order_id: row.id,
          user_id: row.user_id,
          diff_amount: diffMoney,
        } satisfies OneOnOneDiffPendingPayload,
      });
      return;
    }
    if (settleCents < prepaidCents) {
      // 多退：F2 受理（自持事务；幂等键=refund/po-{po}/ooo-settle，崩溃窗口重放收敛）
      const refundCents = prepaidCents - settleCents;
      await this.refunds.accept({
        order_id: row.payment_order_id,
        user_id: row.user_id,
        cash: centsToMoney(refundCents),
        points: 0,
        reason: 'SETTLE_REFUND',
        idempotency_key: oooSettleRefundKey(row.payment_order_id),
      });
      await this.transition(uow, row.id, 'SETTLING', 'REFUND_PARTIAL', reason, {
        refund_amount: centsToMoney(refundCents),
      });
      await this.transition(uow, row.id, 'REFUND_PARTIAL', 'SETTLED', 'settle_refund_instructed');
    } else {
      await this.transition(uow, row.id, 'SETTLING', 'SETTLED', reason);
    }
    const settled = await this.readOrderInTx(uow, row.id);
    if (settled) await this.emitSettled(uow, settled);
  }

  /**
   * OneOnOneSettled 出箱（F3 既有契约逐字：gross=prepaid/net=实结参考；firm_id=A3a 导出面）。
   * I-2/I-3 评审登记注记：**F3 构成以 gross（prepaid）为基而净额语义=实结**——多退路径
   * （SETTLE_REFUND 退差）与取消②③保留额（lawyer 收取侧）的 F3 gross 构成/F2 退差账面
   * 叠加，为 shared OneOnOneSettled 头注既有「M2 联调对齐位」——真通道/集成验收前必须
   * 闭合（04 §8 登记归 T7）。
   */
  private async emitSettled(uow: SqlExecutor, view: OneOnOneOrderView): Promise<void> {
    const firmId = await this.lawyerQuals.getFirmId(view.lawyer_id);
    if (firmId === null) {
      throw new AppError(
        ErrorCode.Conflict,
        `律师 ${view.lawyer_id} 未绑定律所（A3b 进件前 firm_id=null），订单 ${view.id} 的 OneOnOneSettled 结算构成缺 firm_id——显式失败不静默（RoomClosed 同口径）`,
      );
    }
    const payload: OneOnOneSettledPayload = {
      order_id: view.id,
      lawyer_id: view.lawyer_id,
      firm_id: firmId,
      gross: view.prepaid,
      net: view.settle_amount ?? view.prepaid,
      payment_order_id: view.payment_order_id,
    };
    await this.outbox.recordOutbox(uow, { type: ONE_ON_ONE_SETTLED_TOPIC, payload });
  }

  /** 守卫迁移 + UPDATE（乐观并发双闸；extra=随迁移落值的非状态列） */
  private async transition(
    uow: SqlExecutor,
    orderId: number,
    from: OneOnOneStatus,
    to: OneOnOneStatus,
    reason: string,
    extra?: {
      readonly accept_deadline?: Date;
      readonly started_at?: Date;
      readonly finished_at?: Date;
      readonly settle_deadline?: Date;
      readonly settle_amount?: string;
      readonly refund_amount?: string;
    },
  ): Promise<void> {
    await this.guard.assertTransition(ONE_ON_ONE_MACHINE, {
      entityId: orderId,
      from,
      to,
      reason: reason.slice(0, 120),
      uow,
    });
    const sets: string[] = ['status = $3', 'updated_at = now()'];
    const params: unknown[] = [orderId, from, to];
    const add = (column: string, value: unknown): void => {
      params.push(value);
      sets.push(`${column} = $${params.length}`);
    };
    if (extra?.accept_deadline !== undefined) add('accept_deadline', extra.accept_deadline);
    if (extra?.started_at !== undefined) add('started_at', extra.started_at);
    if (extra?.finished_at !== undefined) add('finished_at', extra.finished_at);
    if (extra?.settle_deadline !== undefined) add('settle_deadline', extra.settle_deadline);
    if (extra?.settle_amount !== undefined) add('settle_amount', extra.settle_amount);
    if (extra?.refund_amount !== undefined) add('refund_amount', extra.refund_amount);
    const updated = await uow.query(
      `UPDATE fulfillment.one_on_one_orders SET ${sets.join(', ')}
        WHERE id = $1 AND status = $2 RETURNING id`,
      params,
    );
    if (updated.rows.length === 0) {
      throw new AppError(
        ErrorCode.StateStaleEntity,
        `订单 ${orderId} 已被并发迁移（${from}→${to}）`,
      );
    }
  }

  /** B3 矩阵价 current 读取（mode 档映射；无版本/缺档=400 PRICE_MISSING） */
  private async currentUnitPrice(lawyerId: number, mode: OneOnOneMode): Promise<Money> {
    const current = await this.pricing.getCurrentPricing(lawyerId);
    const prices = current.pricing?.one_on_one_prices ?? null;
    const raw =
      prices === null
        ? null
        : mode === 'text'
          ? (prices.text?.per_round ?? null)
          : mode === 'voice'
            ? (prices.voice?.per_15min ?? null)
            : (prices.video?.per_15min ?? null);
    if (raw === null || typeof raw !== 'string') {
      throw new AppError(
        ErrorCode.PriceMissing,
        `律师 ${lawyerId} 未配置 1对1 ${mode} 档价格（B3 one_on_one_prices 矩阵缺配，版本 v${current.version}）——不可发起 1对1 订单`,
      );
    }
    return raw;
  }

  /** 首方确认角色（STL FINISHED→SETTLING 留痕 reason 解析；null=留痕缺失=漂移显性化） */
  private async firstConfirmRole(orderId: number): Promise<'user' | 'lawyer' | 'system' | null> {
    const rows = await this.stl.listAllowedTransitions({
      entityType: 'one_on_one_order',
      toStatus: 'SETTLING',
      entityIds: [orderId],
      limit: 10,
    });
    const last = rows[rows.length - 1];
    if (!last) return null;
    if (last.reason === SETTLE_DEFAULT_REASON) return 'system';
    const m = /^settle_confirm:role=(user|lawyer)$/.exec(last.reason ?? '');
    return m ? (m[1] as 'user' | 'lawyer') : null;
  }

  /** 幂等重放出参（原支付单+pay_params 确定性重建；C3 replayResult 同形） */
  private async replayCreate(row: OneOnOneOrderView): Promise<CreateOneOnOneResult> {
    const order = await this.payments.findOrderByIdempotencyKey(oooPayKey(row.id));
    if (!order) {
      throw new AppError(
        ErrorCode.InternalError,
        `订单 ${row.id} 幂等重放原支付单不可读（不应触达）`,
      );
    }
    return {
      order: row,
      payment_order: {
        id: order.id,
        biz_type: order.biz_type,
        biz_id: order.biz_id,
        cash_amount: order.cash_amount,
        points_amount: order.points_amount,
        total: order.total,
        status: order.status,
      },
      pay_params: this.payments.payParamsFor(order) as unknown as Record<string, unknown>,
      deduplicated: true,
    };
  }

  /** text 轮次确定性重算：律师答消息且其与上一条律师答之间存在用户问（重复/乱序投递幂等） */
  private async recountRounds(uow: SqlExecutor, conversationId: number): Promise<number> {
    const res = await uow.query<{ rounds: number }>(
      `SELECT count(*)::int AS rounds
         FROM fulfillment.messages m
        WHERE m.conversation_id = $1 AND m.sender_role = 'lawyer'
          AND EXISTS (
            SELECT 1 FROM fulfillment.messages u
             WHERE u.conversation_id = $1 AND u.sender_role = 'user'
               AND u.seq < m.seq
               AND u.seq > COALESCE((
                    SELECT MAX(m2.seq) FROM fulfillment.messages m2
                     WHERE m2.conversation_id = $1 AND m2.sender_role = 'lawyer' AND m2.seq < m.seq
                  ), 0)
          )`,
      [conversationId],
    );
    return res.rows[0]?.rounds ?? 0;
  }

  private async lockOrder(uow: SqlExecutor, orderId: number): Promise<OneOnOneRow | null> {
    const res = await uow.query<OneOnOneRow>(
      `SELECT ${OOO_COLS} FROM fulfillment.one_on_one_orders WHERE id = $1 FOR UPDATE`,
      [orderId],
    );
    return res.rows[0] ?? null;
  }

  private async readOrder(orderId: number): Promise<OneOnOneRow | null> {
    const res = await this.pool.query<OneOnOneRow>(
      `SELECT ${OOO_COLS} FROM fulfillment.one_on_one_orders WHERE id = $1`,
      [orderId],
    );
    return res.rows[0] ?? null;
  }

  /** 活跃单回读（M-2：并发双插败者 23505 收口的胜者定位——池连接读已提交行） */
  private async readActiveOrder(
    roomId: number,
    userId: number,
    serviceType: string,
  ): Promise<OneOnOneRow | null> {
    const activeList = (ONE_ON_ONE_ACTIVE_STATUSES as readonly string[])
      .map((s) => `'${s}'`)
      .join(', ');
    const res = await this.pool.query<OneOnOneRow>(
      `SELECT ${OOO_COLS} FROM fulfillment.one_on_one_orders
        WHERE room_id = $1 AND user_id = $2 AND service_type = $3
          AND status IN (${activeList})
        ORDER BY id DESC LIMIT 1`,
      [roomId, userId, serviceType],
    );
    return res.rows[0] ?? null;
  }

  private async readOrderInTx(
    uow: SqlExecutor,
    orderId: number,
  ): Promise<OneOnOneOrderView | null> {
    const res = await uow.query<OneOnOneRow>(
      `SELECT ${OOO_COLS} FROM fulfillment.one_on_one_orders WHERE id = $1`,
      [orderId],
    );
    return res.rows[0] ? toView(res.rows[0]) : null;
  }

  /**
   * 系统计量的实结值（I-1 修复环：默认确认的事实源——FINISHED 双默认与 SETTLING 半默认共用）：
   * settle=clamp[0, unit_price×consumed_units]（R-04；少补>prepaid 为合法域——经补差承载）。
   */
  private systemSettleOf(row: OneOnOneRow): string {
    const cents = Math.max(0, moneyToCents(row.unit_price) * row.consumed_units);
    return centsToMoney(cents);
  }
}
