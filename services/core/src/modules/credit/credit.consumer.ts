/**
 * G1 事件消费端（§6）：八个上游事件 → EMIT_CREDIT_EVENT 统一入账。
 *   - SlotAbuseDetected（B2 真事件源，真接线；topic/载荷契约经 slot-lock.events 编译期绑定）
 *     → owner=滥用发起用户，action=user_slot_abuse，ref=(outbox_event, outbox 行 id)——载荷无
 *     业务 id（B2 拒绝路径锁行未写入），幂等引用取投递行 id（稳定；同用户再次滥用=新行新事件）；
 *   - LawyerRejected（C2B 拒绝/超时）、PriceChangeApproved（C6，kind 三档映射）、
 *     AttendanceAdjudicated（D3，normal/absent 入信用；late 无 §8.8 分值行不产生信用事件）、
 *     SessionCancelled（D4，档位按 PRD §8.7 时间锚归类；platform 取消无信用影响跳过）、
 *     ReviewSubmitted（G2，direction 定位被评方 owner）——生产者在 W3/M2，本批只注册消费
 *     +合成事件测试（docs/05 §2 桩方案；契约在 @ljr/shared 由本消费端钉形，R-W2-A 口径）；
 *   - OneOnOneDiffUnpaid（D6 生产=M2-W3 T2；补差 15min 未付）→ owner=下单用户，
 *     action=user_cancel_early（W3-11：PRD §8.8 无专属档位行——对齐既有最轻用户违约档 -5
 *     默认，不自创；专属档位=04 §8 登记待产品拍板），ref=(one_on_one_order, order_id)。
 *
 * 消费幂等：emit 的 uq_credit_events_idem 兜底，at-least-once 重投零副作用；载荷缺/坏字段 →
 * 抛错进重试轨道（不静默丢弃——载荷漂移显性化，identity.consumer 同口径）。
 * 事务形态：emit 自持事务（流水+快照+限制令+出箱原子），handler 不用 relay 认领事务的 uow——
 * 崩溃窗口内 handler 已提交而 SENT 未标 → 重投由幂等键短路（at-least-once 语义内）。
 */
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { AppError, ErrorCode } from '@ljr/shared';
import {
  ATTENDANCE_ADJUDICATED_TOPIC,
  LAWYER_REJECTED_TOPIC,
  ONE_ON_ONE_DIFF_UNPAID_TOPIC,
  PRICE_CHANGE_APPROVED_TOPIC,
  REVIEW_SUBMITTED_TOPIC,
  SESSION_CANCELLED_TOPIC,
  type AttendanceResult,
  type PriceChangeKind,
} from '@ljr/shared';
import type { OutboxHandler, RelayEvent } from '../../infrastructure/outbox/outbox-relay.service';
import { OutboxRelayService } from '../../infrastructure/outbox/outbox-relay.service';
import {
  SLOT_ABUSE_DETECTED_TOPIC,
  type SlotAbuseDetectedPayload,
} from '../schedule/slot-lock.events';
import { CreditService } from './credit.service';
import type { CreditAction, OwnerType } from './credit.types';

/** PRD §8.7/§8.8 取消档位锚（用户开始前 ≥2h=提前档；律师 ≥24h=轻档）；恰在锚点=高档（含端点） */
const USER_CANCEL_HORIZON_MS = 2 * 3_600_000;
const LAWYER_CANCEL_HORIZON_MS = 24 * 3_600_000;

/** C6 kind 三档 → 行为动作（档位归类在 C6 生产侧，G1 只承载映射） */
const PRICE_KIND_TO_ACTION: Record<PriceChangeKind, CreditAction> = {
  PRICE_UP: 'lawyer_price_up',
  PRICE_DOWN_LE10: 'lawyer_price_down_le10',
  PRICE_DOWN_GT10: 'lawyer_price_down_gt10',
};

function isPositiveInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0;
}

function badPayload(topic: string, detail: string): AppError {
  return new AppError(
    ErrorCode.InvalidArgument,
    `事件 ${topic} 载荷非法（${detail}；进重试轨道，不静默丢弃）`,
  );
}

function requirePositiveInt(value: unknown, topic: string, field: string): number {
  if (!isPositiveInt(value)) throw badPayload(topic, `缺 ${field} 或非正整数`);
  return value;
}

function requireIsoDate(value: unknown, topic: string, field: string): number {
  if (typeof value !== 'string') throw badPayload(topic, `缺 ${field}`);
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw badPayload(topic, `${field} 非 ISO 8601`);
  return ms;
}

/** 到场判定 → 行为动作（normal/absent 入信用；late=§8.5 迟到无 §8.8 分值行 → null 不产生信用事件） */
function attendanceAction(ownerType: OwnerType, result: AttendanceResult): CreditAction | null {
  if (result === 'normal')
    return ownerType === 'lawyer' ? 'lawyer_participated' : 'user_participated';
  if (result === 'absent') return ownerType === 'lawyer' ? 'lawyer_absent' : 'user_absent';
  return null;
}

/** 独立可测的入账 handler：六 topic 共用（按 topic 分流到 EMIT_CREDIT_EVENT） */
export function createCreditEventHandler(credit: CreditService): OutboxHandler {
  return async (event: RelayEvent): Promise<void> => {
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    switch (event.topic) {
      case SLOT_ABUSE_DETECTED_TOPIC: {
        const abuse = payload as Partial<SlotAbuseDetectedPayload>;
        const userId = requirePositiveInt(abuse.user_id, event.topic, 'user_id');
        requirePositiveInt(abuse.lawyer_id, event.topic, 'lawyer_id'); // 契约字段校验（本侧不落库）
        if (abuse.limit !== 'PER_LAWYER' && abuse.limit !== 'GLOBAL') {
          throw badPayload(event.topic, 'limit 越域（PER_LAWYER/GLOBAL）');
        }
        await credit.emit({
          owner_type: 'user',
          owner_id: userId,
          action: 'user_slot_abuse',
          ref_type: 'outbox_event',
          ref_id: event.id, // B2 拒绝路径无业务 id：投递行 id=稳定幂等引用（类注）
        });
        return;
      }
      case LAWYER_REJECTED_TOPIC: {
        const lawyerId = requirePositiveInt(payload['lawyer_id'], event.topic, 'lawyer_id');
        const groupId = requirePositiveInt(payload['group_id'], event.topic, 'group_id');
        await credit.emit({
          owner_type: 'lawyer',
          owner_id: lawyerId,
          action: 'lawyer_reject_timeout',
          ref_type: 'group',
          ref_id: groupId,
        });
        return;
      }
      case PRICE_CHANGE_APPROVED_TOPIC: {
        const lawyerId = requirePositiveInt(payload['lawyer_id'], event.topic, 'lawyer_id');
        const changeId = requirePositiveInt(
          payload['price_change_id'],
          event.topic,
          'price_change_id',
        );
        const kind = payload['kind'];
        if (kind !== 'PRICE_UP' && kind !== 'PRICE_DOWN_LE10' && kind !== 'PRICE_DOWN_GT10') {
          throw badPayload(event.topic, 'kind 越域（PRICE_UP/PRICE_DOWN_LE10/PRICE_DOWN_GT10）');
        }
        await credit.emit({
          owner_type: 'lawyer',
          owner_id: lawyerId,
          action: PRICE_KIND_TO_ACTION[kind],
          ref_type: 'price_change',
          ref_id: changeId,
        });
        return;
      }
      case ATTENDANCE_ADJUDICATED_TOPIC: {
        const adjudicationId = requirePositiveInt(
          payload['adjudication_id'],
          event.topic,
          'adjudication_id',
        );
        requirePositiveInt(payload['session_id'], event.topic, 'session_id');
        const ownerType = payload['owner_type'];
        if (ownerType !== 'user' && ownerType !== 'lawyer') {
          throw badPayload(event.topic, 'owner_type 越域（user/lawyer）');
        }
        const ownerId = requirePositiveInt(payload['owner_id'], event.topic, 'owner_id');
        const result = payload['result'];
        if (result !== 'normal' && result !== 'late' && result !== 'absent') {
          throw badPayload(event.topic, 'result 越域（normal/late/absent）');
        }
        const action = attendanceAction(ownerType, result);
        if (action === null) return; // late：无 §8.8 分值行，不产生信用事件（类注）
        await credit.emit({
          owner_type: ownerType,
          owner_id: ownerId,
          action,
          ref_type: 'attendance',
          ref_id: adjudicationId,
        });
        return;
      }
      case SESSION_CANCELLED_TOPIC: {
        const sessionId = requirePositiveInt(payload['session_id'], event.topic, 'session_id');
        const cancelledBy = payload['cancelled_by'];
        if (cancelledBy !== 'user' && cancelledBy !== 'lawyer' && cancelledBy !== 'platform') {
          throw badPayload(event.topic, 'cancelled_by 越域（user/lawyer/platform）');
        }
        const cancelledAt = requireIsoDate(payload['cancelled_at'], event.topic, 'cancelled_at');
        const startAt = requireIsoDate(
          payload['session_start_at'],
          event.topic,
          'session_start_at',
        );
        if (cancelledBy === 'platform') return; // PRD §8.7：平台取消全额退款无信用影响
        const actorId = requirePositiveInt(
          payload['cancelled_by_user_id'],
          event.topic,
          'cancelled_by_user_id',
        );
        const ownerType: OwnerType = cancelledBy === 'lawyer' ? 'lawyer' : 'user';
        const aheadMs = startAt - cancelledAt; // >0=开始前取消；恰在锚点=高档（含端点，PRD §8.7 ≥2h/≥24h）
        const action: CreditAction =
          ownerType === 'lawyer'
            ? aheadMs >= LAWYER_CANCEL_HORIZON_MS
              ? 'lawyer_cancel_24h_plus'
              : 'lawyer_cancel_under_24h'
            : aheadMs >= USER_CANCEL_HORIZON_MS
              ? 'user_cancel_early'
              : 'user_cancel_late';
        await credit.emit({
          owner_type: ownerType,
          owner_id: actorId,
          action,
          ref_type: 'session',
          ref_id: sessionId,
        });
        return;
      }
      case REVIEW_SUBMITTED_TOPIC: {
        const sessionId = requirePositiveInt(payload['session_id'], event.topic, 'session_id');
        const direction = payload['direction'];
        if (direction !== 'user_to_lawyer' && direction !== 'lawyer_to_user') {
          throw badPayload(event.topic, 'direction 越域（user_to_lawyer/lawyer_to_user）');
        }
        const revieweeId = requirePositiveInt(
          payload['reviewee_user_id'],
          event.topic,
          'reviewee_user_id',
        );
        if (typeof payload['dims'] !== 'object' || payload['dims'] === null) {
          throw badPayload(event.topic, '缺 dims');
        }
        await credit.emit({
          owner_type: (direction === 'user_to_lawyer' ? 'lawyer' : 'user') as OwnerType,
          owner_id: revieweeId,
          action: 'review_received',
          ref_type: 'review',
          ref_id: sessionId, // G2 幂等键=session+direction；owner 分账户后 (owner,action,ref) 唯一仍成立
        });
        return;
      }
      case ONE_ON_ONE_DIFF_UNPAID_TOPIC: {
        // M2-W3 T2（W3-11）：补差 15min 未付——PRD §8.8 无专属档位行（用户侧全表仅
        // 参与/取消/缺席三类），按「-5 默认」对齐既有最轻用户违约档 user_cancel_early
        // （种子 delta=-5、violation 计入 30 天窗口）不自创新档位；专属档位=04 §8 登记
        // 待产品拍板后扩展 G1 词汇表+H7 credit.rules 行
        const orderId = requirePositiveInt(payload['order_id'], event.topic, 'order_id');
        const userId = requirePositiveInt(payload['user_id'], event.topic, 'user_id');
        await credit.emit({
          owner_type: 'user',
          owner_id: userId,
          action: 'user_cancel_early',
          ref_type: 'one_on_one_order',
          ref_id: orderId,
        });
        return;
      }
      default:
        // 注册表只按六 topic 注册，不应触达；防御性抛错进重试轨道（不静默）
        throw badPayload(event.topic, '未注册的 topic');
    }
  };
}

@Injectable()
export class CreditEventConsumer implements OnModuleInit {
  constructor(
    private readonly relay: OutboxRelayService,
    private readonly credit: CreditService,
  ) {}

  onModuleInit(): void {
    const handler = createCreditEventHandler(this.credit);
    this.relay.registerHandler(SLOT_ABUSE_DETECTED_TOPIC, handler);
    this.relay.registerHandler(LAWYER_REJECTED_TOPIC, handler);
    this.relay.registerHandler(PRICE_CHANGE_APPROVED_TOPIC, handler);
    this.relay.registerHandler(ATTENDANCE_ADJUDICATED_TOPIC, handler);
    this.relay.registerHandler(SESSION_CANCELLED_TOPIC, handler);
    this.relay.registerHandler(REVIEW_SUBMITTED_TOPIC, handler);
    // M2-W3 T2：D6 补差 15min 未付信用记录（档位=W3-11 对齐既有，类注）
    this.relay.registerHandler(ONE_ON_ONE_DIFF_UNPAID_TOPIC, handler);
  }
}
