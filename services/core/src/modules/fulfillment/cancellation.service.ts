/**
 * D4 取消与违约处理服务（§1-§10 + M2-W2 T3 简报）——fulfillment 域应用服务导出面。
 *
 * 职责（§1）：取消规则引擎（全表判定 → 退款指令 → 违约金指令 → 信用事件）；不执行退款/
 * 扣划（F2/F3）、不记账信用（G1）。无独占表（§3）：判定留痕=state_transition_log（reason
 * 携 D4 分支+cancel.matrix 规则版本）；矩阵参数=H7 规则中心 rule_definitions 表（rule_key='cancel.matrix'
 * 快照读，无生效版本→DEFAULT_CANCEL_MATRIX 兜底=W2-4 决策位）。
 *
 * === 双路径退款边界（简报实现口径裁定，报告注明） ===
 *   全额路径：所有取消档经统一出箱点 emitSessionCancelled → F2 新增 SessionCancelled 消费
 *     =按退款源清单全额受理（reason=CANCEL_RULE，幂等键=refund/po-{id}/session-cancel——
 *     per enrollment：orders↔enrollments 1:1）；用户/律师直接档+平台开房失败+全员缺席
 *     （D3 job1 既有事件）统一承载。
 *   部分路径：用户 <2h 退 50%=本服务直调 F2 受理面（幂等键=refund/po-{id}/cancel-user50，
 *     不发 SessionCancelled——场次不终止，单报名维度退出）；choice=credit=零退款+G1
 *     user_cancel_late（enrollment ref）。
 *
 * === 三项裁定（⚠ 报告注明，翻转走 04 §8） ===
 *   裁定-1 律师缺席自动终止的 SessionCancelled cancelled_by='platform'：简报原文
 *     cancelled_by='lawyer' 缺席档，但 G1 credit.consumer 既有消费（验证不重写）对
 *     cancelled_by='lawyer' 恒判 lawyer_cancel_under_24h（-30）且与 AttendanceAdjudicated
 *     lawyer_absent（-50）双计=-80≠PRD §8.6 缺席档 -50 总口径；cancelled_by='platform'
 *     =G1 唯一跳过路径（PRD §8.7 平台取消零信用），-50 由 D3 判定事件独立承载、责任归属
 *     经 F3 赔付指令+STL reason 留痕。若产品要 -80 叠加语义=G1 契约变更（交叉审查面）。
 *   裁定-2 律师缺席/<24h 赔付指令形态=F3 导出面 SettlementService.applyPenalty（penalty/
 *     域幂等键，收据+deduction_detail+欠款 SettlementDebtIncurred 既有出箱——最小侵入形态）；
 *     用户侧补偿分配=splitCompensationPool 纯函数确定性重算（无新表/新 topic，本批不持久化
 *     分配明细——F2/F3 补偿兑付面落位时经同一纯函数+base_ref 重算，口径唯一）。
 *   裁定-3 G1 停接复核：credit.service.emit 既有 violation 窗口机制（30 天窗口 ≥ 阈值 →
 *     SUSPEND_TAKE_7D，credit.spec L691-755 已测第 2 次触发/第 31 天重计）——D4 只发
 *     SessionCancelled（档位 G1 按 cancelled_at 自判），停接规则归 G1 不越权实现。
 *
 * 事务形态：统一出箱点自持事务（trade 推进+房间终止+事件出箱原子）；F2/F3 指令面自持事务
 * 后置（幂等键收敛 at-least-once 崩溃窗口——ticket.callbacks「效果先行」同款）：取消事务
 * 已提交而赔付指令失败 → 回调重试 → 出箱点 dedup 短路 + 指令键重放，恰一次。
 */
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import {
  AppError,
  ErrorCode,
  REFUND_SOURCE_REF_TYPE_SESSION,
  SESSION_CANCELLED_TOPIC,
  type SessionCancelledPayload,
} from '@ljr/shared';
import type { SqlExecutor } from '../../infrastructure/sql';
import { PgPoolService } from '../../infrastructure/sql';
import { OutboxService } from '../../infrastructure/outbox/outbox.service';
import { StateTransitionGuardService } from '../../infrastructure/state-machine/state-transition-guard.service';
import { CreditService } from '../credit/credit.service';
import { RefundService } from '../payment/refund.service';
import { RefundSourceRegistry } from '../payment/refund.source';
import { RuleCenterService } from '../ops/rule-center.service';
import { TicketResolveCallbackRegistry } from '../ops/ticket.callbacks';
import { TicketService } from '../ops/ticket.service';
import { SettlementService } from '../settlement/settlement.service';
import { EnrollmentService } from '../trade/enrollment.service';
import { SessionService } from '../trade/session.service';
import {
  CANCEL_MATRIX_RULE_KEY,
  DEFAULT_CANCEL_MATRIX,
  judgeCancelMatrix,
  parseCancelMatrix,
  pctOfCents,
  splitCompensationPool,
} from './cancellation.engine';
import type {
  CancelBranch,
  CancelMatrixParams,
  CompensationAllocation,
  EnrollmentCancelInput,
  EnrollmentCancelResult,
  PenaltyInstruction,
  SessionCancelInput,
  SessionCancelResult,
  UnifiedCancelOutcome,
  UserLateChoice,
} from './cancellation.types';
import { ROOM_MACHINE, ROOM_TERMINAL_STATUSES } from './room.machine';
import { assertPositiveInt, centsToMoney, moneyToCents, type RoomStatus } from './room.types';

/** H3 回调路由词（ticket.callbacks idField 形状=任务简报逐字；值=场次 id——裁定注记见类注） */
const D4_CALLBACK_TARGET = 'd4';
const D4_CALLBACK_ID_FIELD = 'cancellation_id';

/** STL reason 组装（列宽 128 内；规则版本 rv=0 为内置默认兜底档） */
function stlReason(branch: CancelBranch, ruleVersion: number): string {
  return `d4_cancel:${branch}:rv=${ruleVersion}`;
}

@Injectable()
export class CancellationService implements OnModuleInit {
  private readonly logger = new Logger(CancellationService.name);

  constructor(
    private readonly pool: PgPoolService,
    private readonly outbox: OutboxService,
    private readonly guard: StateTransitionGuardService,
    // 跨模块消费全部走导出服务（禁跨 schema join，架构 §3.2 红线）：trade 快照/推进位、
    // F2 受理+退款源注册表、F3 赔付指令、H3 工单+回调注册表、H7 矩阵快照、G1 信用事件
    // （终态词汇经 sessionOpenable/isTerminalStatus 布尔面、订单定位经 'session' 退款源
    //  清单——机器件/幂等键格式等 trade 内部件不外泄，T1 先例纪律）
    private readonly sessions: SessionService,
    private readonly enrollments: EnrollmentService,
    private readonly refunds: RefundService,
    private readonly sources: RefundSourceRegistry,
    private readonly settlements: SettlementService,
    private readonly tickets: TicketService,
    private readonly callbacks: TicketResolveCallbackRegistry,
    private readonly rules: RuleCenterService,
    private readonly credit: CreditService,
  ) {}

  /** H3 回调接线（target='d4' 注册即通——ticket.callbacks T1 预留位，H3 侧零改动） */
  onModuleInit(): void {
    this.callbacks.register({
      target: D4_CALLBACK_TARGET,
      idField: D4_CALLBACK_ID_FIELD,
      invoke: async ({ ticketId, refId, approved }) => {
        // refId=cancellation_id=场次 id（D4 无独占表——取消实体即场次，简报形状的字段名承载）
        await this.onApprovalResolved(refId, approved, ticketId);
      },
    });
  }

  // ===========================================================================
  // POST /sessions/{id}/cancel（§5：幂等键=session+role；409 NOT_CANCELLABLE=终态）
  // ===========================================================================

  async cancelSession(
    input: SessionCancelInput,
    opts?: { readonly actorUserId?: number },
  ): Promise<SessionCancelResult> {
    const sessionId = assertPositiveInt(input.sessionId, 'session_id');
    if (input.role !== 'user' && input.role !== 'lawyer') {
      throw new AppError(ErrorCode.InvalidArgument, `role 须为 user|lawyer：${String(input.role)}`);
    }
    const reason = input.reason ?? '';
    if (typeof reason !== 'string' || reason.length > 200) {
      throw new AppError(ErrorCode.InvalidArgument, 'reason 须为 ≤200 字符文本（可选）');
    }

    const detail = await this.sessions.getDetail(sessionId); // 404=场次不存在
    if (this.sessions.isTerminalStatus(detail.status)) {
      // 终态短路优先于幂等回查：已被取消（含 D3 platform 路径）/已流标/已结算 → 409/幂等分野
      const prior = await this.priorCancelledEvent(sessionId);
      if (prior && prior.cancelled_by === input.role) {
        // 幂等键=session+role：重复取消幂等返回既有结果（§5）
        return { result: 'CANCELLED', deduplicated: true, refund: 'FULL' };
      }
      throw new AppError(
        ErrorCode.Conflict,
        `场次不可取消（NOT_CANCELLABLE）：${sessionId} 当前状态 ${detail.status}` +
          (prior ? `（已被 ${prior.cancelled_by} 取消）` : ''),
      );
    }

    // 归属校验（actor=JWT claims；user=PAID 参与方/场次律师，lawyer=场次属主——403 越权）
    if (opts?.actorUserId !== undefined) {
      const actorId = assertPositiveInt(opts.actorUserId, 'actorUserId');
      if (input.role === 'lawyer') {
        if (actorId !== detail.lawyer_id) {
          throw new AppError(
            ErrorCode.RoleForbidden,
            `律师 ${actorId} 非场次 ${sessionId} 属主（lawyer=${detail.lawyer_id}），不可取消他人场次`,
          );
        }
      } else if (!(await this.enrollments.isSessionParticipant(sessionId, actorId))) {
        throw new AppError(
          ErrorCode.RoleForbidden,
          `用户 ${actorId} 非场次 ${sessionId} 参与方（PAID 报名/场次律师），不可取消`,
        );
      }
    }

    const { params, version } = await this.matrixSnapshot();
    const verdict = judgeCancelMatrix({
      role: input.role,
      msUntilStart: Date.parse(detail.slot_start) - Date.now(),
      matrix: params,
    });

    if (verdict.branch === 'USER_LATE') {
      // <2h 矩阵=退 50% 或扣信用（用户 choice）——choice 在报名维度 API（§5 契约位），
      // 场次级入参无 choice：显式 400 指引（防静默全退偏离 R-01）
      throw new AppError(
        ErrorCode.InvalidArgument,
        `<2H_USE_ENROLLMENT_CANCEL：距开始不足 ${params.userFreeCancelHours}h，用户取消请走 POST /enrollments/{id}/cancel 携 choice（refund50|credit）——R-01 <2h 档为单报名维度`,
      );
    }

    if (verdict.branch === 'LAWYER_LT24H') {
      // <24h → H3 审批工单（category+ref 幂等=W2-9；不取消不发文，审批通过经回调续跑）
      const detail_text = JSON.stringify({
        reason,
        rule_version: version,
        lawyer_id: detail.lawyer_id,
        slot_start: detail.slot_start,
        hours_until_start: Math.floor((Date.parse(detail.slot_start) - Date.now()) / 3_600_000),
      });
      const { created, ticket } = await this.tickets.createTicket({
        category: 'cancel_lt24h',
        refType: 'session',
        refId: sessionId,
        title: `律师 <24h 取消审批：场次 ${sessionId}`,
        detail: detail_text,
      });
      // I-3 自愈（修复环）：建单重放遇 RESOLVED（审批在案）而场次非终态=「工单已决而取消
      // 流未生效」漂移（缺 target 处置/回调崩溃窗的历史形态——ticket.service 现已强制
      // cancel_lt24h 带 target，本面为二道防线）——重放建单口自愈续跑（onApprovalResolved
      // 双幂等锚=出箱点 prior/赔付收据，恰一次）
      if (
        !created &&
        ticket.status === 'RESOLVED' &&
        !this.sessions.isTerminalStatus(detail.status)
      ) {
        this.logger.warn(
          `I-3 自愈：cancel_lt24h 工单 ${ticket.id} 已 RESOLVED 而场次 ${sessionId} 未取消——建单重放续跑审批效果`,
        );
        await this.onApprovalResolved(sessionId, true, ticket.id);
        const after = await this.sessions.getDetail(sessionId);
        if (after.status === 'CANCELLED') {
          return { result: 'CANCELLED', refund: 'FULL' };
        }
      }
      if (ticket.status === 'REJECTED') {
        return {
          result: 'APPROVAL_REJECTED',
          approval: { ticket_id: ticket.id, sla_due: ticket.sla_due },
        };
      }
      return {
        result: 'PENDING_APPROVAL',
        approval: { ticket_id: ticket.id, sla_due: ticket.sla_due },
      };
    }

    // USER_FREE / LAWYER_NOTICE：直接取消档（统一出箱点）
    const byUserId =
      input.role === 'lawyer'
        ? detail.lawyer_id
        : assertPositiveInt(opts?.actorUserId, 'actorUserId');
    const out = await this.ensureCancelled({
      sessionId,
      by: input.role,
      byUserId,
      branch: verdict.branch,
      ruleVersion: version,
    });
    if (!out.executed && out.prior) {
      // 并发窗口：同刻已被取消（同角色重放口径）
      return { result: 'CANCELLED', deduplicated: true, refund: 'FULL' };
    }
    if (!out.executed) {
      throw new AppError(
        ErrorCode.Conflict,
        `场次不可取消（NOT_CANCELLABLE）：${sessionId} 当前状态 ${String(out.status)}`,
      );
    }
    return {
      result: 'CANCELLED',
      refund: 'FULL',
      // USER_FREE：免费改期一次的 C5 指引位（§4「改期一次」——D4 不代做，T5 C5 承载）
      ...(verdict.branch === 'USER_FREE' ? { reschedule_available: true } : {}),
    };
  }

  // ===========================================================================
  // POST /enrollments/{id}/cancel（§5：幂等键=enrollment；400 >=2H_USE_RESCHEDULE）
  // ===========================================================================

  async cancelEnrollment(
    input: EnrollmentCancelInput,
    opts?: { readonly actorUserId?: number },
  ): Promise<EnrollmentCancelResult> {
    if (input.choice !== 'refund50' && input.choice !== 'credit') {
      throw new AppError(
        ErrorCode.InvalidArgument,
        `choice 须为 refund50|credit：${String(input.choice)}`,
      );
    }
    const choice: UserLateChoice = input.choice;
    const enrollmentId = assertPositiveInt(input.enrollmentId, 'enrollment_id');
    const enrollment = await this.enrollments.resolveEnrollment(enrollmentId);
    if (!enrollment) {
      throw new AppError(ErrorCode.NotFound, `报名不存在：${enrollmentId}`);
    }
    if (opts?.actorUserId !== undefined && opts.actorUserId !== enrollment.user_id) {
      throw new AppError(
        ErrorCode.RoleForbidden,
        `用户 ${opts.actorUserId} 非报名 ${enrollmentId} 属主（user=${enrollment.user_id}），不可代取消`,
      );
    }
    if (enrollment.ref_type !== 'session') {
      throw new AppError(
        ErrorCode.InvalidArgument,
        `报名 ${enrollmentId} 非场次报名（ref_type=${enrollment.ref_type}），无取消矩阵语义（拼团转化链=W3）`,
      );
    }
    if (enrollment.pay_status === 'PENDING') {
      throw new AppError(
        ErrorCode.Conflict,
        `报名 ${enrollmentId} 未支付（PENDING），无取消退款语义（不占席位的未付清场归 C3 流标链）`,
      );
    }
    const wasRefunded = enrollment.pay_status === 'REFUNDED';
    if (wasRefunded) {
      // 幂等键=enrollment：已终态（本路径或流标退款收敛）→ 幂等返回既有结果
      return { result: 'CANCELLED_REFUND50', deduplicated: true };
    }

    const detail = await this.sessions.getDetail(enrollment.ref_id);
    if (this.sessions.isTerminalStatus(detail.status)) {
      throw new AppError(
        ErrorCode.Conflict,
        `场次不可取消（NOT_CANCELLABLE）：${enrollment.ref_id} 当前状态 ${detail.status}——报名取消随场次终止关闭`,
      );
    }

    const { params, version } = await this.matrixSnapshot();
    const msUntilStart = Date.parse(detail.slot_start) - Date.now();
    if (msUntilStart <= 0) {
      // C-1（修复环）开场后下界：取消矩阵的报名维度档全部关闭——开场后退出=缺席处理
      // （PRD §8.5 超 15min 费用不退 / §8.7「到点未进按缺席处理」），判定归 D3 不在 D4 发明
      throw new AppError(
        ErrorCode.Conflict,
        `场次已开场（${detail.slot_start}）——报名取消关闭，开场后按缺席处理（PRD §8.5/§8.7；到场判定归 D3）`,
      );
    }
    if (msUntilStart >= params.userFreeCancelHours * 3_600_000) {
      // §5 逐字 400 >=2H_USE_RESCHEDULE：≥2h 应走 C5 改期（免费一次）；全退取消=场次级 API
      throw new AppError(
        ErrorCode.InvalidArgument,
        `>=2H_USE_RESCHEDULE：距开始 ≥${params.userFreeCancelHours}h（${Math.floor(msUntilStart / 3_600_000)}h），应走 C5 改期（免费一次）或场次级全额取消（POST /sessions/${enrollment.ref_id}/cancel）——R-01 <2h 档才开放 50%/信用选择`,
      );
    }

    // ---- <2h 档（PAID）：订单/金额定位经 'session' 退款源清单（trade 真源导出面——
    // enroll/e{id}/pay 键格式等 trade 内部件知识不外泄；ux_enroll_active 保证同场次同人
    // 恰一活跃 PAID 报名 → 清单内 user 定位唯一）----
    const source = this.sources.resolve(REFUND_SOURCE_REF_TYPE_SESSION);
    if (!source) {
      throw new AppError(
        ErrorCode.ConfigInvalid,
        `退款源 'session' 未注册（F2 RefundSourceRegistry）——报名取消退款链路未装配`,
      );
    }
    const order = (await source.listPaidPaymentOrders(enrollment.ref_id)).find(
      (o) => o.user_id === enrollment.user_id,
    );
    if (!order) {
      throw new AppError(
        ErrorCode.InternalError,
        `报名 ${enrollmentId}（user=${enrollment.user_id}）在场次 ${enrollment.ref_id} 的 PAID 退款源清单缺行——数据漂移显性化`,
      );
    }
    const orderTotalCents = moneyToCents(order.cash_amount) + order.points_amount; // D19 全额口径

    if (choice === 'refund50') {
      // I-4（修复环）credit 档持久锚：choice 单选——G1 流水在册（user_cancel_late ref=
      // enrollment）则 refund50 拒（emit 幂等键只防同 action 重放，不防跨 choice 翻单）
      if (
        await this.credit.hasCreditEvent({
          owner_type: 'user',
          owner_id: enrollment.user_id,
          action: 'user_cancel_late',
          ref_type: 'enrollment',
          ref_id: enrollmentId,
        })
      ) {
        throw new AppError(
          ErrorCode.Conflict,
          `报名 ${enrollmentId} 已选择信用档（G1 user_cancel_late 在册）——<2h 取消二选一（refund50|credit）不可翻单`,
        );
      }
      // 双路径之部分路径：D4 直调 F2 受理面（不发 SessionCancelled——场次不终止）；
      // 池=支付全额×userLateRefundPct floor（R-01「退 50%」）；cash 先配、余量积分（积分=分
      // 整数域恒等，总额恰=池不破守恒）
      const pool = pctOfCents(orderTotalCents, params.userLateRefundPct);
      const cashPart = Math.min(pool, moneyToCents(order.cash_amount));
      const pointsPart = pool - cashPart;
      const { refund } = await this.refunds.accept({
        order_id: order.payment_order_id,
        user_id: enrollment.user_id,
        cash: centsToMoney(cashPart),
        points: pointsPart,
        reason: 'CANCEL_RULE',
        idempotency_key: `refund/po-${order.payment_order_id}/cancel-user50`,
      });
      // 报名终态化（PAID→REFUNDED，STL；refundIfRejected「受理先行→终态化」同款先例；
      // RefundCompleted 收敛消费对本单已 REFUNDED 幂等 no-op）
      await this.enrollments.advanceToRefunded(enrollmentId, `d4_cancel_refund50:rv=${version}`);
      return { result: 'CANCELLED_REFUND50', refund_id: refund.refund_id };
    }

    // choice=credit：零退款+G1 user_cancel_late（ref=enrollment；emit 幂等键=owner+action+ref
    // 重放短路）；报名保持 PAID（费用不退口径=§8.5 缺席同构——到场义务继续，信用损伤为价）
    const emitted = await this.credit.emit({
      owner_type: 'user',
      owner_id: enrollment.user_id,
      action: 'user_cancel_late',
      ref_type: 'enrollment',
      ref_id: enrollmentId,
    });
    return { result: 'CANCELLED_CREDIT', deduplicated: emitted.deduplicated };
  }

  // ===========================================================================
  // H3 审批回调续跑（<24h 律师取消：approve → 全退-30+20% 违约金占比补偿）
  // ===========================================================================

  /**
   * 审批决议续跑（ticket.callbacks invoke；at-least-once——出箱点/赔付收据双幂等收敛）：
   * approved=false → REJECTED 终态无动作（场次不动，§4「需平台审批」未获批=不取消）；
   * approved=true → 统一出箱点（lawyer 档，cancelled_at=DB 钟 → G1 判 <24h -30）→ F3
   * applyPenalty（20%×场次总价，penalty/session-{id}/cancel-lt24h）→ 占比分配确定性回显。
   */
  async onApprovalResolved(
    sessionId: number,
    approved: boolean,
    ticketId: number,
  ): Promise<{
    executed: boolean;
    approved: boolean;
    penalty?: PenaltyInstruction;
    allocation?: CompensationAllocation[];
  }> {
    const sid = assertPositiveInt(sessionId, 'session_id');
    if (!approved) {
      this.logger.log(`律师 <24h 取消审批驳回：session=${sid} ticket=${ticketId}（场次不动）`);
      return { executed: false, approved: false };
    }
    const detail = await this.sessions.getDetail(sid);
    const { params, version } = await this.matrixSnapshot();
    const out = await this.ensureCancelled({
      sessionId: sid,
      by: 'lawyer',
      byUserId: detail.lawyer_id,
      branch: 'LAWYER_LT24H',
      ruleVersion: version,
    });
    if (!out.executed && !out.prior) {
      // 终态且无既有取消事件（审批迟到跨过场次终态的防御位）：不赔付不发文，留痕
      this.logger.warn(
        `审批续跑撞终态：session=${sid} status=${String(out.status)} ticket=${ticketId}（不取消不赔付）`,
      );
      return { executed: false, approved: true };
    }
    // I-1（修复环）赔付归属闸：prior 非本分支预期 by（如缺席链已取消并已落 50% 赔付）=
    // 跨分支——20% 违约金不叠加（赔付归先落地的分支）；同分支重放（prior.cancelled_by=
    // 'lawyer'）仍恒尝试，收据键收敛恰一次
    if (!out.executed && out.payload && out.payload.cancelled_by !== 'lawyer') {
      this.logger.warn(
        `LT24H 赔付跳过（跨分支）：session=${sid} 已被 ${out.payload.cancelled_by} 分支取消（赔付归该分支，不叠加 20% 违约金）ticket=${ticketId}`,
      );
      return { executed: false, approved: true };
    }
    // 赔付指令（恒尝试——重放窗内取消已提交而指令失败时，收据键重放恰一次）
    const { penalty, allocation } = await this.instructPenalty({
      lawyerId: detail.lawyer_id,
      sessionId: sid,
      poolCents: pctOfCents(moneyToCents(detail.session_total), params.lawyerLatePenaltyPct),
      pct: params.lawyerLatePenaltyPct,
      keySuffix: 'cancel-lt24h',
      reasonText: `d4 律师 <24h 取消违约金 ${params.lawyerLatePenaltyPct}%×场次总价（按支付占比全额补偿用户，平台不抽佣，PRD §8.6）`,
      ruleVersion: version,
    });
    return { executed: true, approved: true, penalty, allocation };
  }

  // ===========================================================================
  // 消费路径：律师缺席自动终止（AttendanceAdjudicated lawyer absent → §4/R-03）
  // ===========================================================================

  /**
   * 律师缺席自动终止：场次终止+全退+-50（G1 经 AttendanceAdjudicated 消费承载，本路径
   * SessionCancelled cancelled_by='platform'=裁定-1）+场次总价 50% 赔付（占比分配同 20% 档）。
   * 幂等=adjudication_id 事实上的 N:1 收敛（一场次一律师一缺席判定）：事件重投 → 出箱点
   * prior 短路 + 赔付收据键重放（executed=false 仍恒尝试赔付——崩溃窗口收敛）。
   */
  async terminateForLawyerAbsence(input: {
    readonly sessionId: number;
    readonly lawyerId: number;
    readonly adjudicationId: number;
  }): Promise<{
    executed: boolean;
    penalty?: PenaltyInstruction;
    allocation?: CompensationAllocation[];
  }> {
    const sid = assertPositiveInt(input.sessionId, 'session_id');
    const detail = await this.sessions.getDetail(sid);
    const { params, version } = await this.matrixSnapshot();
    const out = await this.ensureCancelled({
      sessionId: sid,
      by: 'platform', // 裁定-1（类注）：G1 对 lawyer 档双计 -30，platform=唯一零信用路径
      byUserId: null,
      branch: 'LAWYER_ABSENT',
      ruleVersion: version,
    });
    if (!out.executed && !out.prior) {
      this.logger.warn(
        `律师缺席终止撞终态：session=${sid} status=${String(out.status)} adjudication=${input.adjudicationId}（不终止不赔付）`,
      );
      return { executed: false };
    }
    // I-1（修复环）赔付归属闸：prior 非本分支预期 by='platform'（如律师 <24h 审批已取消
    // 并已落 20% 违约金）=跨分支——50% 赔付不叠加；同分支重放仍恒尝试，收据键收敛恰一次
    if (!out.executed && out.payload && out.payload.cancelled_by !== 'platform') {
      this.logger.warn(
        `缺席赔付跳过（跨分支）：session=${sid} 已被 ${out.payload.cancelled_by} 分支取消（赔付归该分支，不叠加 50%）adjudication=${input.adjudicationId}`,
      );
      return { executed: false };
    }
    // 赔付指令（恒尝试——prior 短路时收据键重放恰一次；崩溃窗口收敛的另一半）
    const { penalty, allocation } = await this.instructPenalty({
      lawyerId: detail.lawyer_id,
      sessionId: sid,
      poolCents: pctOfCents(
        moneyToCents(detail.session_total),
        params.lawyerAbsenceCompensationPct,
      ),
      pct: params.lawyerAbsenceCompensationPct,
      keySuffix: 'lawyer-absence',
      reasonText: `d4 律师缺席赔付 ${params.lawyerAbsenceCompensationPct}%×场次总价（按支付占比全额补偿用户，PRD §8.6/§8.5）`,
      ruleVersion: version,
    });
    this.logger.log(
      `律师缺席自动终止：session=${sid} lawyer=${input.lawyerId} adjudication=${input.adjudicationId} penalty=${penalty.amount} 赔付分配=${JSON.stringify(allocation)}`,
    );
    // executed=本次是否真出箱（prior 短路=executed:false——幂等重放的可观察面）
    return { executed: out.executed, penalty, allocation };
  }

  // ===========================================================================
  // 消费路径：平台取消（RoomOpenFailed → §4/R-06 任意时刻全退零信用）
  // ===========================================================================

  /** 开房失败平台取消：全退+零信用（room 行 D1 已 CANCELLED 直插——房间步自然短路） */
  async cancelForPlatform(sessionId: number, trigger: string): Promise<UnifiedCancelOutcome> {
    const sid = assertPositiveInt(sessionId, 'session_id');
    const { version } = await this.matrixSnapshot();
    const out = await this.ensureCancelled({
      sessionId: sid,
      by: 'platform',
      byUserId: null,
      branch: 'PLATFORM',
      ruleVersion: version,
    });
    if (out.executed) {
      this.logger.log(`平台取消（${trigger}）：session=${sid}——全额退款经 F2 消费，零信用事件`);
    }
    return out;
  }

  // ===========================================================================
  // 内部件：统一出箱点 / 矩阵快照 / 既有事件查询 / 赔付指令 / 占比分配
  // ===========================================================================

  /**
   * SessionCancelled 出箱统一（所有取消路径唯一出口；幂等=session 终态短路+既有事件短路）：
   * ① 既有事件短路（D3 platform 路径/先前 D4 路径——含「room 已取消而 session 未迁移」
   *   形态：outbox 事件即取消事实，双发=F2 双退款单入口）→ prior=true；
   * ② trade 受限入边推进（cancelSession：守卫+STL+锁释放+job 作废）；终态不可达 → prior=false；
   * ③ 房间终止步（同事务：OPEN/IN_SERVICE→CANCELLED——不走 CLOSED 防 F3 结算双轨）；
   * ④ DB 钟出箱（cancelled_at=now()；session_start_at=scheduled_start 快照——G1 档位锚）。
   *
   * I-2（修复环）prior 分支仍执行 cancelSession（幂等收敛）：D3 全员缺席形态下 session 行
   * 未迁移（T2 只取消 room+出事件）——本点补 CANCELLED（STL 审计+B2 席位锁释放+job 作废）；
   * session 已终态时 cancelSession 返回 cancelled:false 零副作用（D4 重放安全）。
   */
  private async ensureCancelled(input: {
    readonly sessionId: number;
    readonly by: 'user' | 'lawyer' | 'platform';
    readonly byUserId: number | null;
    readonly branch: CancelBranch;
    readonly ruleVersion: number;
  }): Promise<UnifiedCancelOutcome> {
    const sid = assertPositiveInt(input.sessionId, 'session_id');
    return this.pool.withTransaction(async (uow) => {
      const prior = await this.existingCancelledInTx(uow, sid);
      const reason = stlReason(input.branch, input.ruleVersion);
      // I-2：恒推进（prior 收敛/正常取消共用）；reason=本分支 reason（收敛行的 D4 审计锚）
      const r = await this.sessions.cancelSession(uow, sid, reason);
      if (!r.cancelled && !prior) {
        return { executed: false, prior: false, branch: input.branch, status: r.status };
      }
      const roomStatus = await this.cancelRoomIfAny(uow, sid, reason);
      if (prior) {
        // 事件已在册（D3/先前 D4 路径）——不二次出箱（双发=F2 双退款单入口）；session/房间
        // 行收敛即本路径职责（I-2）
        return { executed: false, prior: true, branch: input.branch, payload: prior, roomStatus };
      }
      const nowRow = await uow.query<{ now: Date }>(`SELECT now() AS now`);
      const payload: SessionCancelledPayload = {
        session_id: sid,
        cancelled_by: input.by,
        cancelled_by_user_id: input.byUserId,
        cancelled_at: new Date(nowRow.rows[0]!.now).toISOString(),
        session_start_at: r.session!.slot_start, // ISO（toView 快照口径）
      };
      await this.outbox.recordOutbox(uow, { type: SESSION_CANCELLED_TOPIC, payload });
      return { executed: true, prior: false, branch: input.branch, payload, roomStatus };
    });
  }

  /** 房间终止步（同事务；无房间/已终态 → 短路返回现状——开房失败行 D1 已 CANCELLED 直插） */
  private async cancelRoomIfAny(
    uow: SqlExecutor,
    sessionId: number,
    reason: string,
  ): Promise<RoomStatus | null> {
    const res = await uow.query<{ id: string; status: string }>(
      `SELECT id, status FROM fulfillment.rooms WHERE session_id = $1 FOR UPDATE`,
      [sessionId],
    );
    const row = res.rows[0];
    if (!row) return null;
    const current = row.status as RoomStatus;
    const roomId = Number(row.id);
    if ((ROOM_TERMINAL_STATUSES as readonly RoomStatus[]).includes(current)) return current;
    await this.guard.assertTransition(ROOM_MACHINE, {
      entityId: roomId,
      from: current,
      to: 'CANCELLED',
      reason,
      uow,
    });
    const updated = await uow.query<{ id: string }>(
      `UPDATE fulfillment.rooms SET status = 'CANCELLED' WHERE id = $1 AND status = $2 RETURNING id`,
      [roomId, current],
    );
    if ((updated.rowCount ?? 0) === 0) {
      throw new AppError(ErrorCode.StateStaleEntity, `房间 ${roomId} 已被并发迁移`);
    }
    return 'CANCELLED';
  }

  /** 行为时矩阵快照（§8：rule_definitions 版本化；无生效版本→内置默认兜底 rv=0——W2-4） */
  private async matrixSnapshot(): Promise<{
    params: CancelMatrixParams;
    version: number;
  }> {
    const snapshot = await this.rules.snapshotAt(CANCEL_MATRIX_RULE_KEY, new Date());
    if (!snapshot) return { params: DEFAULT_CANCEL_MATRIX, version: 0 };
    return { params: parseCancelMatrix(snapshot.content), version: snapshot.version };
  }

  /** 既有取消事件（池连接读；幂等回查面——API 入口/出箱点外的前置判定） */
  private async priorCancelledEvent(sessionId: number): Promise<SessionCancelledPayload | null> {
    return this.pool.withTransaction((uow) => this.existingCancelledInTx(uow, sessionId));
  }

  /** 既有取消事件（事务内读：统一出箱点的 ① 短路半边；事件即取消事实源——D4 无独占表） */
  private async existingCancelledInTx(
    exec: SqlExecutor,
    sessionId: number,
  ): Promise<SessionCancelledPayload | null> {
    const events = await this.outbox.listEventsByPayload(
      exec,
      [SESSION_CANCELLED_TOPIC],
      'session_id',
      String(sessionId),
    );
    const first = events[0];
    return (first?.payload as SessionCancelledPayload | undefined) ?? null;
  }

  /**
   * 赔付指令（裁定-2：F3 导出面 applyPenalty——penalty/ 域幂等键+收据+deduction_detail，
   * 欠款 SettlementDebtIncurred 既有出箱由 F3 承载）+ 占比分配回显（裁定-2：确定性重算，
   * 不持久化——F2/F3 补偿兑付面落位时经同一纯函数+base_ref 重算）。
   */
  private async instructPenalty(input: {
    readonly lawyerId: number;
    readonly sessionId: number;
    readonly poolCents: number;
    readonly pct: number;
    readonly keySuffix: string;
    readonly reasonText: string;
    readonly ruleVersion: number;
  }): Promise<{ penalty: PenaltyInstruction; allocation: CompensationAllocation[] }> {
    const result = await this.settlements.applyPenalty({
      owner_id: input.lawyerId,
      amount: centsToMoney(input.poolCents),
      base_ref: { ref_type: 'session', ref_id: input.sessionId },
      base_version: input.ruleVersion,
      reason: input.reasonText.slice(0, 200),
      idempotency_key: `penalty/session-${input.sessionId}/${input.keySuffix}`,
    });
    const allocation = await this.compensationAllocation(input.sessionId, input.poolCents);
    return {
      penalty: {
        amount: centsToMoney(input.poolCents),
        replayed: result.replayed,
        from_settlement: result.from_settlement,
        from_deposit: result.from_deposit,
        debt: result.debt,
      },
      allocation,
    };
  }

  /** 赔付占比分配（R-04：按用户支付额占比；余数归 user_id 升序首名——engine 纯函数承载） */
  private async compensationAllocation(
    sessionId: number,
    poolCents: number,
  ): Promise<CompensationAllocation[]> {
    const source = this.sources.resolve(REFUND_SOURCE_REF_TYPE_SESSION);
    if (!source || poolCents <= 0) return [];
    const orders = await source.listPaidPaymentOrders(sessionId);
    const paidByUser = new Map<number, number>();
    for (const o of orders) {
      const paid = moneyToCents(o.cash_amount) + o.points_amount; // D19 全额口径（cash 分+points）
      paidByUser.set(o.user_id, (paidByUser.get(o.user_id) ?? 0) + paid);
    }
    const participants = [...paidByUser.entries()].map(([user_id, paid_cents]) => ({
      user_id,
      paid_cents,
    }));
    if (participants.length === 0) return []; // 无 PAID 单（理论不可达防御）——零分配不炸
    return splitCompensationPool(poolCents, participants);
  }
}
