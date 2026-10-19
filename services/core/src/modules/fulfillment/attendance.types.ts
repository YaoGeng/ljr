/**
 * D3 到场与缺席判定类型契约（D3 §3/§5 契约词汇；时间=timestamptz+DB 钟，视图出参 ISO 8601
 * UTC 即时串——room.types 同口径）。判定参数全部配置化（attendance.config：容忍窗口）+
 * 15min 窗口常量=room.types.ABSENT_AFTER_MS（预写方 D1 持有偏移先例）。
 */
import type { AttendanceResult } from '@ljr/shared';

/** §3 status 值域（V39 ck_attendances_status 同字面；DB 词汇大写） */
export const ATTENDANCE_STATUSES = ['NORMAL', 'LATE', 'ABSENT'] as const;
export type AttendanceStatus = (typeof ATTENDANCE_STATUSES)[number];

/** §3 role 值域（V39 ck_attendances_role 同字面；presence 载荷 role 透传） */
export const ATTENDANCE_ROLES = ['user', 'lawyer'] as const;
export type AttendanceRole = (typeof ATTENDANCE_ROLES)[number];

/**
 * DB status → shared AttendanceResult（小写词汇）映射：AttendanceAdjudicated 载荷 result
 * 字段的契约锚（G1 消费端按 normal/absent 入信用、late 无分值行——credit.consumer 既有口径）。
 */
export const STATUS_TO_RESULT: Readonly<Record<AttendanceStatus, AttendanceResult>> = {
  NORMAL: 'normal',
  LATE: 'late',
  ABSENT: 'absent',
};

// ---------------------------------------------------------------------------
// presence 序列重放（R-05：判定以宽限结束时点快照为准——纯函数，配置项可测）
// ---------------------------------------------------------------------------

/** 一条 presence 序列样本（自 platform-outbox 的 PresenceJoined/Left 事件重放而来） */
export interface PresenceSample {
  readonly userId: number;
  readonly kind: 'joined' | 'left';
  /** 事件房间时刻戳（毫秒，PresencePayload.at 解析值） */
  readonly at: number;
}

/**
 * 判定锚时点在场性判定（D3 §4/R-05 的字面承载，纯函数；anchor=判定锚时刻）：
 *   主规则（序列重放）：at<=anchor 的最后一条事件为 join（join 后无 leave）→ 在场；
 *     最后一条为 leave（leave 后无 join）→ 不在场；
 *   容忍窗口（抖动吸收，仅 job1 形态启用）：[anchor−toleranceMs, anchor] 内存在 join 记录
 *     → 在场（断线重连 ≤窗口 不误判——leave 后 rejoin 在飞的事件滞后由回看窗口吸收）。
 * 锚=约定时刻系（job1/NO_SHOW_CLOSE=grace_end、job2=deadline=grace_end+15min，禁 now()
 * 漂移锚）；toleranceMs=0 即关闭容忍半边——job2 的末位事件判据形态（修复环 I-1：早进早走
 * 者 leave 为末位 → 不在场 → ABSENT；恰在 deadline 进入 join 为末位 → LATE，R-01 含端点）。
 */
export function presentUserIdsAt(
  samples: readonly PresenceSample[],
  graceEndMs: number,
  toleranceMs: number,
): Set<number> {
  const present = new Set<number>();
  // 序列序=样本传入序（调用方按 outbox id 升序装载=事件写入序，relay 同序投递）
  const lastKindAtOrBefore = new Map<number, 'joined' | 'left'>();
  for (const s of samples) {
    if (s.at <= graceEndMs) {
      lastKindAtOrBefore.set(s.userId, s.kind);
    }
    if (s.kind === 'joined' && s.at >= graceEndMs - toleranceMs && s.at <= graceEndMs) {
      present.add(s.userId); // 容忍半边：窗口内 join 记录即在场
    }
  }
  for (const [userId, kind] of lastKindAtOrBefore) {
    if (kind === 'joined') {
      present.add(userId); // 主规则：grace_end 前最后事件为 join
    }
  }
  return present;
}

// ---------------------------------------------------------------------------
// §5 契约出参（snake_case 逐字）
// ---------------------------------------------------------------------------

/** GET /rooms/{id}/attendance 条目（§5 逐字 {user_id, role, status, join_at}；join_at 首次进入） */
export interface AttendanceView {
  readonly user_id: number;
  readonly role: AttendanceRole;
  readonly status: AttendanceStatus;
  /** 首次进入时刻（ISO 8601；从未进入=null） */
  readonly join_at: string | null;
}

/** GET /lawyer/attendance-stats 出参（§5 逐字 {samples, punctual_rate}；口径=H4：punctual=
 * NORMAL 判定数/总判定数，窗口按上海日界；比率非金额不受 Money 禁 float 约束，4 位小数） */
export interface AttendanceStatsView {
  readonly samples: number;
  readonly punctual_rate: number;
}

/** POST /enrollments/{id}/confirm-arrival 出参（D2 §5 逐字 {status}） */
export interface ConfirmArrivalResult {
  readonly status: AttendanceStatus;
}

// ---------------------------------------------------------------------------
// 判定 job 出参（序列化进 schedule_job_log.detail，I2 §4）
// ---------------------------------------------------------------------------

/** job1（GracePeriodEnded 消费核心）判定结果观测量 */
export interface GraceAdjudicationOutcome {
  readonly room_id: number;
  /** true=本次执行了判定（room 仍 OPEN）；false=终态/缺失幂等无操作 */
  readonly judged: boolean;
  /** 本次新判定 NORMAL 行数（幂等跳过不计） */
  readonly normal: number;
  /** true=全员缺席走了平台取消路径（room CANCELLED+SessionCancelled(platform)+全员 ABSENT） */
  readonly cancelled: boolean;
  /** true=律师在场且 ≥1 用户在场 → room OPEN→IN_SERVICE + ROOM_IN_SERVICE 出箱 */
  readonly in_service: boolean;
}

/** job2（ABSENT_15M 执行器核心）判定结果观测量 */
export interface AbsentWindowOutcome {
  readonly room_id: number;
  /** 本次新判定 LATE 行数（deadline 重放末位事件为 join——期间进入且仍在/最后在房，I-1） */
  readonly late: number;
  /** 本次新判定 ABSENT 行数（末位为 leave/无事件——早进早走与从未进入，含补建缺席行） */
  readonly absent: number;
}

/** NO_SHOW_CLOSE 执行器结果观测量 */
export interface NoShowCloseOutcome {
  readonly room_id: number;
  /** true=执行了无人到场关闭（平台取消路径） */
  readonly closed: boolean;
}
