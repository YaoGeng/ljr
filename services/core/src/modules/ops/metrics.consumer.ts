/**
 * H4 指标管道事件消费端（M2-W2 T8；H4 §6「消费：全域事件（幂等消费，重放不双计）」）。
 *
 * 注册面=02 §7.2 映射表在 W2 时点事件流已可算的指标源 topic（16 个计数源）+ A.1/H4
 * 消费位登记的记账位 topic（4 个：消费留痕 events_consumed，无 W2 指标不发明口径）。
 * 同 topic 多 handler 扇出（relay 追加不覆盖）——各域既有消费面零影响。
 *
 * 事务形态：handler 用 relay 认领事务的 uow（去重+聚合并与 SENT 标记同事务——
 * 对比 ticket.consumer 自持事务形态：metrics 无业务实体要建，uow 形态最薄）。
 * 载荷校验失败抛 AppError → relay 重试轨道（不静默丢弃，spec 钉住零半计）。
 */
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import {
  AppError,
  ErrorCode,
  TICKET_CATEGORIES,
  type AttendanceAdjudicatedPayload,
  type CouponGrantedPayload,
  type EnrollmentPaidPayload,
  type GroupBuyConvertedPayload,
  type GroupBuyLawyerConfirmedPayload,
  type GroupBuyPublishedPayload,
  type GroupBuyReachedPayload,
  type OneOnOnePaidPayload,
  type PointsGrantedPayload,
  type PriceChangeApprovedPayload,
  type ReminderDispatchedPayload,
  type RescheduleConfirmedPayload,
  type ReviewSubmittedPayload,
  type RoomClosedPayload,
  type RoomInServicePayload,
  type SessionCancelledPayload,
  type SessionCreatedPayload,
  type SessionFullPayload,
  type TicketCreatedPayload,
} from '@ljr/shared';
import type { OutboxHandler } from '../../infrastructure/outbox/outbox-relay.service';
import { OutboxRelayService } from '../../infrastructure/outbox/outbox-relay.service';
import { MC, REVIEW_DIMS, TICKET_CATEGORY_DIM, type MetricIncrement } from './metrics.types';
import { MetricsService } from './metrics.service';

function isPositiveInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0;
}

function isNonEmptyStr(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

function bad(topic: string, payload: unknown, hint: string): never {
  throw new AppError(
    ErrorCode.InvalidArgument,
    `指标消费载荷非法（${topic} ${hint}）：${JSON.stringify(payload)}`,
  );
}

// ---------------------------------------------------------------------------
// topic → 计数器增量（纯函数：载荷校验+口径映射；测试与 handler 共用）
// ---------------------------------------------------------------------------

const attendanceResultCounter: Record<string, string> = {
  normal: MC.ATTENDANCE_NORMAL,
  late: MC.ATTENDANCE_LATE,
  absent: MC.ATTENDANCE_ABSENT,
};

/**
 * 按 §7.2 映射表把事件载荷映射为计数器增量（登记位 topic 返回空数组=只留痕零计数）。
 * 载荷形状非法即抛（→relay 重试轨道，不静默）。
 */
export function counterIncrementsFor(topic: string, payload: unknown): readonly MetricIncrement[] {
  const raw = (payload ?? {}) as Record<string, unknown>;
  switch (topic) {
    case 'trade.session.created': {
      const p = raw as Partial<SessionCreatedPayload>;
      if (!isPositiveInt(p.id) || !isPositiveInt(p.lawyer_id) || !isNonEmptyStr(p.slot_start)) {
        bad(topic, payload, '须 id/lawyer_id 正整数且 slot_start 非空');
      }
      // dim=''（修复环 C-1）：载荷无 mode 字段——B2C/C2B 分列在查询层经算术推导
      //（每次场次创建恰发一次本事件：B2C 开团 + C4 confirm 生成 + C4 convert 生成）
      return [{ key: MC.SESSION_CREATED, dim: '', inc: 1 }];
    }
    case 'trade.session.full': {
      const p = raw as Partial<SessionFullPayload>;
      if (!isPositiveInt(p.id) || !isNonEmptyStr(p.unit_price) || !isNonEmptyStr(p.session_total)) {
        bad(topic, payload, '须 id 正整数且 unit_price/session_total 非空');
      }
      // dim=''（修复环 C-1）：B2C 满员与 C4 confirm「满员即成团」都发本事件——B2C 分子经
      // 查询层减 c2b_session_created 推导（每次 confirm 恰一次 SessionFull；convert 无 markFull）
      return [{ key: MC.SESSION_FULL, dim: '', inc: 1 }];
    }
    case 'trade.group_buy.published': {
      const p = raw as Partial<GroupBuyPublishedPayload>;
      if (!isPositiveInt(p.id) || !isPositiveInt(p.lawyer_id)) {
        bad(topic, payload, '须 id/lawyer_id 正整数');
      }
      return [{ key: MC.GROUP_BUY_PUBLISHED, dim: '', inc: 1 }];
    }
    case 'trade.group_buy.reached': {
      const p = raw as Partial<GroupBuyReachedPayload>;
      if (!isPositiveInt(p.id)) bad(topic, payload, '须 id 正整数');
      return [{ key: MC.GROUP_BUY_REACHED, dim: '', inc: 1 }];
    }
    case 'fulfillment.attendance.adjudicated': {
      const p = raw as Partial<AttendanceAdjudicatedPayload>;
      if (
        !isPositiveInt(p.session_id) ||
        !isPositiveInt(p.owner_id) ||
        (p.owner_type !== 'user' && p.owner_type !== 'lawyer') ||
        typeof p.result !== 'string' ||
        !(p.result in attendanceResultCounter)
      ) {
        bad(
          topic,
          payload,
          '须 session_id/owner_id 正整数、owner_type∈user|lawyer、result∈normal|late|absent',
        );
      }
      // 用户口径（02 §7.2「attendances.status」分母=参与用户判定行）；律师行留痕不计数
      if (p.owner_type !== 'user') return [];
      // 上方 `in` 校验已保证键存在；! 断言消 noUncheckedIndexedAccess 噪音
      const resultCounter = attendanceResultCounter[p.result]!;
      return [
        { key: MC.ATTENDANCE_JUDGED, dim: 'role:user', inc: 1 },
        { key: resultCounter, dim: 'role:user', inc: 1 },
      ];
    }
    case 'fulfillment.one_on_one.paid': {
      const p = raw as Partial<OneOnOnePaidPayload>;
      if (!isPositiveInt(p.order_id) || !isPositiveInt(p.user_id) || !isPositiveInt(p.lawyer_id)) {
        bad(topic, payload, '须 order_id/user_id/lawyer_id 正整数');
      }
      return [{ key: MC.ONE_ON_ONE_PAID, dim: '', inc: 1 }];
    }
    case 'fulfillment.room.closed': {
      const p = raw as Partial<RoomClosedPayload>;
      if (!isPositiveInt(p.session_id) || !isPositiveInt(p.lawyer_id) || !isNonEmptyStr(p.gross)) {
        bad(topic, payload, '须 session_id/lawyer_id 正整数且 gross 非空');
      }
      return [{ key: MC.ROOM_CLOSED, dim: `lawyer:${p.lawyer_id}`, inc: 1 }];
    }
    case 'review.review.submitted': {
      const p = raw as Partial<ReviewSubmittedPayload>;
      const dims = p.dims as Record<string, unknown> | undefined;
      if (
        !isPositiveInt(p.session_id) ||
        !isPositiveInt(p.reviewee_user_id) ||
        (p.direction !== 'user_to_lawyer' && p.direction !== 'lawyer_to_user') ||
        dims === null ||
        typeof dims !== 'object'
      ) {
        bad(topic, payload, '须 session_id/reviewee_user_id 正整数、direction 双值、dims 对象');
      }
      // 修复环 I-1：§7.2「用户满意度」=user_to_lawyer 方向——计数与维度和都按 direction 切 dim
      //（lawyer_to_user 计数保留不入 satisfaction_avg，留 dim 供后续口径扩展）
      const direction = p.direction === 'lawyer_to_user' ? 'lawyer_to_user' : 'user_to_lawyer';
      const dirDim = `direction:${direction}`;
      const out: MetricIncrement[] = [{ key: MC.REVIEW_SUBMITTED, dim: dirDim, inc: 1 }];
      for (const dim of REVIEW_DIMS) {
        const v = dims?.[dim];
        if (typeof v !== 'number' || !Number.isFinite(v)) {
          bad(topic, payload, `dims.${dim} 须数值（G2 四维契约）`);
        }
        out.push({ key: `${MC.REVIEW_DIM_SUM}${dim}`, dim: dirDim, inc: v });
      }
      return out;
    }
    case 'trade.enrollment.paid': {
      const p = raw as Partial<EnrollmentPaidPayload>;
      const amounts = p.amounts as { paid?: unknown; cash?: unknown; points?: unknown } | undefined;
      if (
        (p.ref_type !== 'session' && p.ref_type !== 'groupbuy') ||
        !isPositiveInt(p.ref_id) ||
        !isPositiveInt(p.user_id) ||
        !isNonEmptyStr(amounts?.paid) ||
        !isNonEmptyStr(amounts?.cash)
      ) {
        bad(topic, payload, '须 ref_type 双值、ref_id/user_id 正整数、amounts.paid/cash 非空');
      }
      return [
        { key: MC.ENROLLMENT_PAID, dim: '', inc: 1 },
        { key: MC.ENROLLMENT_PAID, dim: `user:${p.user_id}`, inc: 1 }, // 复购去重维度
      ];
    }
    case 'payment.refund.completed': {
      const p = raw as { refund_id?: unknown; order_id?: unknown; amounts?: { cash?: unknown } };
      if (
        !isPositiveInt(p.refund_id) ||
        !isPositiveInt(p.order_id) ||
        !isNonEmptyStr(p.amounts?.cash)
      ) {
        bad(topic, payload, '须 refund_id/order_id 正整数且 amounts.cash 非空');
      }
      return [{ key: MC.REFUND_COMPLETED, dim: '', inc: 1 }];
    }
    case 'ops.ticket.created': {
      const p = raw as Partial<TicketCreatedPayload>;
      if (
        !isPositiveInt(p.ticket_id) ||
        !(TICKET_CATEGORIES as readonly string[]).includes(String(p.category))
      ) {
        bad(topic, payload, `须 ticket_id 正整数且 category∈${TICKET_CATEGORIES.join('|')}`);
      }
      return [{ key: MC.TICKET_CREATED, dim: TICKET_CATEGORY_DIM(String(p.category)), inc: 1 }];
    }
    case 'fulfillment.session.cancelled': {
      const p = raw as Partial<SessionCancelledPayload>;
      if (
        !isPositiveInt(p.session_id) ||
        (p.cancelled_by !== 'user' &&
          p.cancelled_by !== 'lawyer' &&
          p.cancelled_by !== 'platform') ||
        !isNonEmptyStr(p.cancelled_at) ||
        !isNonEmptyStr(p.session_start_at)
      ) {
        bad(
          topic,
          payload,
          '须 session_id 正整数、cancelled_by 三值、cancelled_at/session_start_at 非空',
        );
      }
      return [{ key: MC.SESSION_CANCELLED, dim: '', inc: 1 }];
    }
    case 'trade.group_buy.lawyer_confirmed': {
      const p = raw as Partial<GroupBuyLawyerConfirmedPayload>;
      if (!isPositiveInt(p.gb_id) || !isPositiveInt(p.session_id) || !isPositiveInt(p.lawyer_id)) {
        bad(topic, payload, '须 gb_id/session_id/lawyer_id 正整数');
      }
      return [{ key: MC.C2B_SESSION_CREATED, dim: '', inc: 1 }];
    }
    case 'trade.group_buy.converted': {
      const p = raw as Partial<GroupBuyConvertedPayload>;
      if (
        !isPositiveInt(p.gb_id) ||
        !isPositiveInt(p.session_id) ||
        !Array.isArray(p.migrated_users)
      ) {
        bad(topic, payload, '须 gb_id/session_id 正整数且 migrated_users 数组');
      }
      return [{ key: MC.CONVERTED_SESSION_CREATED, dim: '', inc: 1 }];
    }
    case 'pricing.price_change.approved': {
      const p = raw as Partial<PriceChangeApprovedPayload>;
      if (!isPositiveInt(p.price_change_id) || !isPositiveInt(p.lawyer_id)) {
        bad(topic, payload, '须 price_change_id/lawyer_id 正整数');
      }
      return [{ key: MC.PRICE_CHANGE_APPROVED, dim: '', inc: 1 }];
    }
    case 'benefits.points.granted': {
      const p = raw as Partial<PointsGrantedPayload>;
      if (
        !isPositiveInt(p.user_id) ||
        typeof p.delta !== 'number' ||
        !isNonEmptyStr(p.kind) ||
        !isNonEmptyStr(p.ref)
      ) {
        bad(topic, payload, '须 user_id 正整数、delta 数值、kind/ref 非空');
      }
      // 补偿发放率分子=COMPENSATION 授予；ABSENCE_SHARE/REFUND_RESTORE 留痕不计数
      if (p.kind !== 'COMPENSATION') return [];
      return [{ key: MC.COMP_POINTS_GRANTED, dim: '', inc: 1 }];
    }
    // —— 登记位（A.1/H4 消费位：留痕零计数——无 W2 指标不发明口径） ——
    case 'trade.reschedule.confirmed': {
      const p = raw as Partial<RescheduleConfirmedPayload>;
      if (!isPositiveInt(p.session_id) || !isPositiveInt(p.user_id)) {
        bad(topic, payload, '须 session_id/user_id 正整数');
      }
      return [];
    }
    case 'benefits.coupon.granted': {
      const p = raw as Partial<CouponGrantedPayload>;
      if (!isPositiveInt(p.grant_id) || !isPositiveInt(p.user_id) || !isNonEmptyStr(p.face_value)) {
        bad(topic, payload, '须 grant_id/user_id 正整数且 face_value 非空');
      }
      return [];
    }
    case 'fulfillment.room.in_service': {
      const p = raw as Partial<RoomInServicePayload>;
      if (!isPositiveInt(p.room_id) || !isPositiveInt(p.session_id)) {
        bad(topic, payload, '须 room_id/session_id 正整数');
      }
      return [];
    }
    case 'notify.reminder.dispatched': {
      const p = raw as Partial<ReminderDispatchedPayload>;
      if (!isPositiveInt(p.user_id) || !isNonEmptyStr(p.kind)) {
        bad(topic, payload, '须 user_id 正整数且 kind 非空');
      }
      return []; // 提醒到达率：§7.2 映射表未列口径——记账不解释（待澄清）
    }
    default:
      throw new AppError(
        ErrorCode.InvalidArgument,
        `指标管道收到未注册 topic：${topic}（注册清单=METRICS_SOURCE_TOPICS）`,
      );
  }
}

/** 指标源 topic 注册清单（16 计数源 + 4 登记位；handler 注册与文档锚） */
export const METRICS_SOURCE_TOPICS = [
  'trade.session.created',
  'trade.session.full',
  'trade.group_buy.published',
  'trade.group_buy.reached',
  'fulfillment.attendance.adjudicated',
  'fulfillment.one_on_one.paid',
  'fulfillment.room.closed',
  'review.review.submitted',
  'trade.enrollment.paid',
  'payment.refund.completed',
  'ops.ticket.created',
  'fulfillment.session.cancelled',
  'trade.group_buy.lawyer_confirmed',
  'trade.group_buy.converted',
  'pricing.price_change.approved',
  'benefits.points.granted',
  'trade.reschedule.confirmed',
  'benefits.coupon.granted',
  'fulfillment.room.in_service',
  'notify.reminder.dispatched',
] as const;

@Injectable()
export class MetricsConsumer implements OnModuleInit {
  private readonly logger = new Logger('MetricsConsumer');

  constructor(
    private readonly relay: OutboxRelayService,
    private readonly metrics: MetricsService,
  ) {}

  onModuleInit(): void {
    for (const topic of METRICS_SOURCE_TOPICS) {
      this.relay.registerHandler(topic, this.handlerFor(topic));
    }
  }

  /** 单 topic handler：校验+映射（counterIncrementsFor）→ 去重+同事务聚合（applyEvent） */
  private handlerFor(_topic: string): OutboxHandler {
    return async (event, uow) => {
      const increments = counterIncrementsFor(event.topic, event.payload);
      const { deduped } = await this.metrics.applyEvent(
        uow,
        { eventId: event.eventId, topic: event.topic },
        increments,
      );
      if (deduped) {
        this.logger.log(`事件重放短路（R-03）：${event.topic} event_id=${event.eventId}`);
      }
    };
  }
}
