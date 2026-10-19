/**
 * H3 事件消费端（§6 消费：ReconciliationDiffFound / RefundFailed / ReserveDiffFound /
 * AbsenceShareDangling；死信事件=relay outbox_dead_letter 落表 Hook 位，M2+ 换装评估——
 * 本批不接线）：
 *   ① ReconciliationDiffFound（payment.reconciliation.diff_found，F1=M1-W3 出箱既有）：
 *      category=reconciliation（R-03 SLA 24h 硬——SLA 计算在 createTicket 配置化）；
 *      幂等键=category+(recon_period, YYYYMMDD 整型编码)——对账期为一期一工单的运维口径
 *      （⚠决策位：payload 无数值 ref，period 数值化为 bigint 幂等锚；期重复事件短路返回
 *      首访工单。F1 侧 newDiffs 已按 split_ledgers 差异行去重，正常路径不重发同期新差异）；
 *   ② RefundFailed（payment.refund.failed，F2=M1-W3 出箱既有，下发重试 3 次耗尽=终局 FAILED）：
 *      category=dead_letter（⚠决策位：终局死退款=死信工单语义——refund_review 留给
 *      R-02 律师<24h 取消审批类（D4/W2 T3 建）；简报两可载荷无判别字段，按死信归类，
 *      任务报告标注）；幂等键=category+(refund, refund_id)。
 *   ③ ReserveDiffFound（benefits.reserve.diff_found，F4=M2-W2 T6 出箱——RESERVE_RECONCILE
 *      日终备付对平不平）：category=reconciliation（控制者裁定：复用对账差异类目=R-03
 *      SLA 24h 硬——备付不平属资损面，合理；title 区分「备付对平差异」；不新设类目——
 *      tickets category ck 七值固定）；幂等键=category+(reserve_period, YYYYMMDD 整型编码)
 *      ——一期一工单，①同款口径。经事件面建单（非直调 TicketService）=规避模块环
 *      Benefits→Ticket→PricingChange→Benefits（①先例同为事件面，M2-W2 T6 任务裁定）。
 *   ④ AbsenceShareDangling（benefits.absence.share_dangling，F4=M2-W2 T6 修复环 I-3 出箱
 *      ——RESERVE_RECONCILE 附带核对：判定流静默 48h 场次的缺席分成应发未发）：③同款
 *      reconciliation 类目（控制者修复环裁定）+title 区分「分成悬空」；幂等键=category+
 *      (absence_session, session_id)——一场一工单。
 *
 * 事务形态（settlement.consumer 先例）：handler 不用 relay 认领事务的 uow——服务自持事务；
 * at-least-once 重投由 DB 部分唯一索引兜底（ON CONFLICT 短路 created:false，零副作用）。
 */
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import {
  ABSENCE_SHARE_DANGLING_TOPIC,
  AppError,
  ErrorCode,
  RECONCILIATION_DIFF_FOUND_TOPIC,
  REFUND_FAILED_TOPIC,
  RESERVE_DIFF_FOUND_TOPIC,
  type AbsenceShareDanglingPayload,
  type ReconciliationDiffFoundPayload,
  type RefundFailedPayload,
  type ReserveDiffFoundPayload,
} from '@ljr/shared';
import type { OutboxHandler, RelayEvent } from '../../infrastructure/outbox/outbox-relay.service';
import { OutboxRelayService } from '../../infrastructure/outbox/outbox-relay.service';
import { TICKET_DETAIL_MAX, TicketService } from './ticket.service';

function isPositiveInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0;
}

/**
 * 对账期 → bigint 幂等锚（'2026-10-16' → 20261016；无溢出面，见类注①）。
 * 日历合法性=逐分量校验（修复环 M-4）：Date.parse 对日越界**回滚而非 NaN**（如
 * '2026-02-30'→2026-03-02），纯 parse 判 NaN 拦不住——回读 UTC 分量比对防回滑。
 */
function periodToRefId(period: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(period);
  if (m === null) {
    throw new AppError(
      ErrorCode.InvalidArgument,
      `对账期必须为 YYYY-MM-DD：${JSON.stringify(period)}`,
    );
  }
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const roundtrip = new Date(Date.UTC(year, month - 1, day));
  if (
    roundtrip.getUTCFullYear() !== year ||
    roundtrip.getUTCMonth() !== month - 1 ||
    roundtrip.getUTCDate() !== day
  ) {
    throw new AppError(
      ErrorCode.InvalidArgument,
      `对账期日历非法（月/日越界）：${JSON.stringify(period)}`,
    );
  }
  const refId = Number(period.replaceAll('-', ''));
  if (!Number.isSafeInteger(refId)) {
    throw new AppError(ErrorCode.InternalError, `对账期数值化溢出（不应触达）：${period}`);
  }
  return refId;
}

/**
 * 事件留档 detail 截断（修复环 C-1）：对账差异日 20-25 行差异即超 4000 字符——若走人工面
 * 的硬校验拒单，消费失败进 relay 重试→DEAD，工单永不创建（恰落在 R-03 硬 SLA 场景）。
 * 事件路径改为截断留档：保头 + 「truncated N chars，全量回查 <回查锚>」标记（明细本就
 * 约定按需回查各域台账），总长恰=TICKET_DETAIL_MAX；人工 HTTP 面保留硬校验不放宽。
 */
export function truncateEventDetail(raw: string, lookupHint: string): string {
  if (raw.length <= TICKET_DETAIL_MAX) return raw;
  // 两轮定点：marker 含 dropped 位数，先估后校准（位数差 ≤1，两轮内收敛）
  let dropped = raw.length;
  let marker = `…[truncated ${dropped} chars，全量回查 ${lookupHint}]`;
  for (let i = 0; i < 3; i += 1) {
    const keep = TICKET_DETAIL_MAX - marker.length;
    if (raw.length - keep === dropped) break;
    dropped = raw.length - keep;
    marker = `…[truncated ${dropped} chars，全量回查 ${lookupHint}]`;
  }
  return raw.slice(0, TICKET_DETAIL_MAX - marker.length) + marker;
}

/** 独立可测的 ReconciliationDiffFound handler（①对账差异工单；R-03 SLA 24h 硬） */
export function createReconciliationDiffFoundHandler(tickets: TicketService): OutboxHandler {
  const logger = new Logger('TicketReconciliationDiff');
  return async (event: RelayEvent): Promise<void> => {
    if (event.topic !== RECONCILIATION_DIFF_FOUND_TOPIC) {
      throw new AppError(
        ErrorCode.InvalidArgument,
        `对账差异消费器收到未注册 topic：${event.topic}`,
      );
    }
    const raw = (event.payload ?? {}) as Partial<ReconciliationDiffFoundPayload>;
    if (
      typeof raw.period !== 'string' ||
      !Array.isArray(raw.detail) ||
      raw.detail.length === 0 ||
      raw.detail.some((d) => typeof d?.channel !== 'string' || typeof d?.amount !== 'string')
    ) {
      throw new AppError(
        ErrorCode.InvalidArgument,
        `ReconciliationDiffFound 载荷非法（须 period=YYYY-MM-DD、detail 非空且项含 channel/amount）：${JSON.stringify(raw)}`,
      );
    }
    const refId = periodToRefId(raw.period);
    const res = await tickets.createTicket({
      category: 'reconciliation',
      refType: 'recon_period',
      refId,
      title: `对账差异：${raw.period}`,
      // 触发事件载荷 JSON 留档（金额 Money 字符串原样；超长截断留档——明细按需回查
      // split_ledgers，C-1：截断不拒单，防 relay DEAD 致 R-03 场景工单永不创建）
      detail: truncateEventDetail(
        JSON.stringify({ period: raw.period, detail: raw.detail }),
        `split_ledgers period=${raw.period}`,
      ),
    });
    if (!res.created) {
      logger.log(
        `对账差异工单幂等短路：period=${raw.period} ticket=${res.ticket.id}（event_id=${event.eventId}）`,
      );
      return;
    }
    logger.log(
      `对账差异工单建单：period=${raw.period} ticket=${res.ticket.id} sla_due=${res.ticket.sla_due}（event_id=${event.eventId}）`,
    );
  };
}

/** 独立可测的 RefundFailed handler（②死信工单；SLA 48h 软） */
export function createRefundFailedHandler(tickets: TicketService): OutboxHandler {
  const logger = new Logger('TicketRefundFailed');
  return async (event: RelayEvent): Promise<void> => {
    if (event.topic !== REFUND_FAILED_TOPIC) {
      throw new AppError(
        ErrorCode.InvalidArgument,
        `退款失败消费器收到未注册 topic：${event.topic}`,
      );
    }
    const raw = (event.payload ?? {}) as Partial<RefundFailedPayload>;
    if (
      !isPositiveInt(raw.refund_id) ||
      !isPositiveInt(raw.order_id) ||
      typeof raw.reason !== 'string' ||
      typeof raw.attempts !== 'number' ||
      typeof raw.last_error !== 'string'
    ) {
      throw new AppError(
        ErrorCode.InvalidArgument,
        `RefundFailed 载荷非法（须 refund_id/order_id 正整数、reason/attempts/last_error 齐备）：${JSON.stringify(raw)}`,
      );
    }
    const res = await tickets.createTicket({
      category: 'dead_letter',
      refType: 'refund',
      refId: raw.refund_id,
      title: `退款失败（重试耗尽）：refund=${raw.refund_id}`,
      // 留档截断同 ①（C-1）：last_error 通道侧报文可长，防超限拒单
      detail: truncateEventDetail(
        JSON.stringify({
          refund_id: raw.refund_id,
          order_id: raw.order_id,
          reason: raw.reason,
          attempts: raw.attempts,
          last_error: raw.last_error,
        }),
        `refunds refund_id=${raw.refund_id}`,
      ),
    });
    if (!res.created) {
      logger.log(
        `退款失败工单幂等短路：refund=${raw.refund_id} ticket=${res.ticket.id}（event_id=${event.eventId}）`,
      );
      return;
    }
    logger.log(
      `退款失败工单建单：refund=${raw.refund_id} ticket=${res.ticket.id} sla_due=${res.ticket.sla_due}（event_id=${event.eventId}）`,
    );
  };
}

/** 独立可测的 ReserveDiffFound handler（③备付对平差异工单；M2-W2 T6；R-03 SLA 24h 硬） */
export function createReserveDiffFoundHandler(tickets: TicketService): OutboxHandler {
  const logger = new Logger('TicketReserveDiff');
  return async (event: RelayEvent): Promise<void> => {
    if (event.topic !== RESERVE_DIFF_FOUND_TOPIC) {
      throw new AppError(
        ErrorCode.InvalidArgument,
        `备付对平差异消费器收到未注册 topic：${event.topic}`,
      );
    }
    const raw = (event.payload ?? {}) as Partial<ReserveDiffFoundPayload>;
    if (
      typeof raw.period !== 'string' ||
      !Number.isInteger(raw.points_outstanding_cents) ||
      !Number.isInteger(raw.reserve_net_cents) ||
      !Number.isInteger(raw.diff_cents) ||
      raw.diff_cents === 0
    ) {
      throw new AppError(
        ErrorCode.InvalidArgument,
        `ReserveDiffFound 载荷非法（须 period=YYYY-MM-DD、三个金额 int 分且 diff≠0）：${JSON.stringify(raw)}`,
      );
    }
    const refId = periodToRefId(raw.period);
    const res = await tickets.createTicket({
      category: 'reconciliation',
      refType: 'reserve_period',
      refId,
      title: `备付对平差异：${raw.period}`,
      // 触发事件载荷 JSON 留档（int 分金额原样；超长截断留档——明细按需回查 benefits 两表
      // （积分账户+备付台账），C-1 同款：截断不拒单，防 relay DEAD 致 R-03 硬 SLA 场景工单
      // 永不创建）
      detail: truncateEventDetail(
        JSON.stringify({
          period: raw.period,
          points_outstanding_cents: raw.points_outstanding_cents,
          reserve_net_cents: raw.reserve_net_cents,
          diff_cents: raw.diff_cents,
        }),
        `benefits 积分账户+备付台账 period=${raw.period}`,
      ),
      priority: 1, // 资损面（R-05 备付不平）：最高优先级
    });
    if (!res.created) {
      logger.log(
        `备付对平差异工单幂等短路：period=${raw.period} ticket=${res.ticket.id}（event_id=${event.eventId}）`,
      );
      return;
    }
    logger.log(
      `备付对平差异工单建单：period=${raw.period} ticket=${res.ticket.id} sla_due=${res.ticket.sla_due} diff=${raw.diff_cents} 分（event_id=${event.eventId}）`,
    );
  };
}

/** 独立可测的 AbsenceShareDangling handler（④分成悬空工单；M2-W2 T6 修复环 I-3；SLA 24h 硬） */
export function createAbsenceShareDanglingHandler(tickets: TicketService): OutboxHandler {
  const logger = new Logger('TicketAbsenceShareDangling');
  return async (event: RelayEvent): Promise<void> => {
    if (event.topic !== ABSENCE_SHARE_DANGLING_TOPIC) {
      throw new AppError(
        ErrorCode.InvalidArgument,
        `分成悬空消费器收到未注册 topic：${event.topic}`,
      );
    }
    const raw = (event.payload ?? {}) as Partial<AbsenceShareDanglingPayload>;
    if (
      !isPositiveInt(raw.session_id) ||
      !isPositiveInt(raw.absent_users) ||
      !isPositiveInt(raw.attending_users)
    ) {
      throw new AppError(
        ErrorCode.InvalidArgument,
        `AbsenceShareDangling 载荷非法（须 session_id/absent_users/attending_users 均正整数）：${JSON.stringify(raw)}`,
      );
    }
    const res = await tickets.createTicket({
      category: 'reconciliation',
      refType: 'absence_session',
      refId: raw.session_id,
      title: `分成悬空：session=${raw.session_id}`,
      // 留档：事件载荷 JSON（明细按需回查 fulfillment 判定留痕与 benefits 积分流水——
      // absence:{session_id} 锚；截断同 C-1 纪律）
      detail: truncateEventDetail(
        JSON.stringify({
          session_id: raw.session_id,
          absent_users: raw.absent_users,
          attending_users: raw.attending_users,
        }),
        `fulfillment 判定留痕+benefits 积分流水 absence锚 session=${raw.session_id}`,
      ),
      priority: 1, // 资损面（分成应发未发）：最高优先级
    });
    if (!res.created) {
      logger.log(
        `分成悬空工单幂等短路：session=${raw.session_id} ticket=${res.ticket.id}（event_id=${event.eventId}）`,
      );
      return;
    }
    logger.log(
      `分成悬空工单建单：session=${raw.session_id} ticket=${res.ticket.id} sla_due=${res.ticket.sla_due} 缺席 ${raw.absent_users}/到场 ${raw.attending_users}（event_id=${event.eventId}）`,
    );
  };
}

@Injectable()
export class TicketConsumer implements OnModuleInit {
  constructor(
    private readonly relay: OutboxRelayService,
    private readonly tickets: TicketService,
  ) {}

  onModuleInit(): void {
    this.relay.registerHandler(
      RECONCILIATION_DIFF_FOUND_TOPIC,
      createReconciliationDiffFoundHandler(this.tickets),
    );
    this.relay.registerHandler(REFUND_FAILED_TOPIC, createRefundFailedHandler(this.tickets));
    this.relay.registerHandler(
      RESERVE_DIFF_FOUND_TOPIC,
      createReserveDiffFoundHandler(this.tickets),
    );
    this.relay.registerHandler(
      ABSENCE_SHARE_DANGLING_TOPIC,
      createAbsenceShareDanglingHandler(this.tickets),
    );
  }
}
