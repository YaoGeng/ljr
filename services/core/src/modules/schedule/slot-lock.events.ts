/**
 * B2 领域事件（B2 §6 / docs/04 §6 具名清单：SlotLocked/SlotReleased/SlotTtlExpired/SlotAbuseDetected）。
 *
 * topic 前缀对齐 I2 'schedule.job.fired' 惯例（schema 名 + 实体 + 动词）；载荷字段按 §6 具名
 * （snake_case：lawyer_id/slot_start/ref/user_id/lawyer_id）。经 recordOutbox 与业务写同事务
 * （SlotAbuseDetected 例外：经独立连接写——拒绝路径上调用方事务必然回滚，同事务事件会被一并
 * 回滚吞掉，守卫「拒绝留痕走独立连接」同款口径，见 slot-lock.service.recordAbuse）。
 */
import type { SlotLockStatus } from './slot-lock.types';

export const SLOT_LOCKED_TOPIC = 'schedule.slot.locked';
export const SLOT_RELEASED_TOPIC = 'schedule.slot.released';
export const SLOT_TTL_EXPIRED_TOPIC = 'schedule.slot.ttl_expired';
export const SLOT_ABUSE_DETECTED_TOPIC = 'schedule.slot.abuse_detected';

/** ref 多态载荷（§6 SlotLocked{..., ref}） */
export interface SlotRefPayload {
  readonly ref_type: string;
  readonly ref_id: number;
}

/** SlotLocked{lawyer_id, slot_start, ref}（+lock_id/status 供 B1/H4 直用；LOCK_SLOT 成功时同事务发出） */
export interface SlotLockedPayload {
  readonly lock_id: number;
  readonly lawyer_id: number;
  /** ISO 8601（timestamptz 出站序列化口径） */
  readonly slot_start: string;
  readonly ref: SlotRefPayload;
  readonly status: SlotLockStatus;
}

/** SlotReleased{..., reason}：显式 RELEASE_SLOT / TTL / reaper 全部经此事件（B1 统一订阅口径） */
export interface SlotReleasedPayload {
  readonly lock_id: number;
  readonly lawyer_id: number;
  readonly slot_start: string;
  readonly ref: SlotRefPayload;
  readonly reason: string;
}

/** SlotTtlExpired{...}：PENDING_PAYMENT 到期未支付被释放（TTL 执行器或 reaper 兜底触达） */
export interface SlotTtlExpiredPayload {
  readonly lock_id: number;
  readonly lawyer_id: number;
  readonly slot_start: string;
  readonly ref: SlotRefPayload;
}

/** SlotAbuseDetected{user_id, lawyer_id}（→G1）；limit=触发的计数维度（R-03） */
export interface SlotAbuseDetectedPayload {
  readonly user_id: number;
  readonly lawyer_id: number;
  readonly limit: 'PER_LAWYER' | 'GLOBAL';
}
