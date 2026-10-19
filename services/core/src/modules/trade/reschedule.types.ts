/**
 * C5 改期类型契约（M2-W2 T5；§3/§5 词汇 snake_case；时间出参 ISO 字符串——Money/时间
 * 铁律延续，本模块无金额运算（R-03 快照沿用=逐字复制不重算，见 service 头注））。
 */
import type { RescheduleStatus } from './reschedule.machine';

/** reschedule_requests 行视图（DB 行读出口径；§5 申请出参 {request} 形状） */
export interface RescheduleRequestView {
  readonly id: number;
  readonly enrollment_id: number;
  readonly target_session_id: number;
  readonly status: RescheduleStatus;
  readonly requested_at: string;
  readonly confirmed_at: string | null;
  readonly expires_at: string;
}

/** 确认事务迁移源行（FOR UPDATE 行锁；快照列原样带走——R-03 逐字复制不重算） */
export interface RescheduleMigrateRow {
  readonly id: string;
  readonly user_id: string;
  readonly ref_type: string;
  readonly ref_id: string;
  readonly price_snapshot: unknown;
  readonly unit_price: string;
  readonly paid_amount: string;
  readonly cash_amount: string;
  readonly points_amount: number;
  readonly price_version_id: string;
  readonly credit_used: number;
  readonly reschedule_used: boolean;
  readonly pay_status: string;
}

export const RESCHEDULE_MIGRATE_COLS = `id, user_id::text AS user_id, ref_type, ref_id::text AS ref_id,
  price_snapshot, unit_price::text AS unit_price, paid_amount::text AS paid_amount,
  cash_amount::text AS cash_amount, points_amount, price_version_id::text AS price_version_id,
  credit_used, reschedule_used, pay_status`;

/**
 * RESCHEDULE_CONFIRM_TIMEOUT job 的 ref 词汇（I2 registerJob 幂等键=type+ref）：
 * refType='reschedule' + refId=request_id——每请求恰一 job（撤回作废后重开申请=新请求行
 * 新 job，不撞唯一键）；executor recheck 按 request_id 直查本表状态（catalog recheckAnchor
 * 「reschedule_requests 状态」的字面承载）。
 */
export const RESCHEDULE_JOB_REF_TYPE = 'reschedule';
