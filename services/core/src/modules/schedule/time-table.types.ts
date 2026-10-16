/**
 * B1 时间表管理类型契约（施工规格 docs/modules/B-律师配置/B1-时间表管理.md §3/§5/§6 + Task 4 简报裁决）。
 *
 * 边界（§1）：B1 只做模板管理 + 物化候选计算 + 状态视图；具体时刻的唯一性/锁定在 B2 slot_locks
 * （R-02：模板不参与唯一约束），B1 不代锁——C1/C2（W3）选段后自己调 B2 lockSlot。
 */
import type { SlotLockStatus } from './slot-lock.types';

/** 单场时长三档（R-03，分钟）：DB CHECK + 应用校验双层 */
export const SLOT_DURATIONS = [60, 90, 120] as const;
export type SlotDuration = (typeof SLOT_DURATIONS)[number];

/** weekday 口径：0=周日..6=周六（JS getUTCDay / PG extract(dow) 同口径；§3 CHECK 0-6） */

/** §3 模板行视图形态（start_time 归一 'HH:MM:SS'） */
export interface TimeSlotTemplateView {
  readonly id: number;
  readonly weekday: number;
  readonly startTime: string;
  readonly durationSmall: SlotDuration;
  readonly enabled: boolean;
}

/** GET /lawyer/{id}/schedule 出参（§5 {templates[]} + version 附加——PUT 乐观并发的读侧，报告注明自定口径） */
export interface ScheduleView {
  readonly version: number;
  readonly templates: readonly TimeSlotTemplateView[];
}

/** PUT /lawyer/schedule 入参（§5 {templates[]} 全量替换；幂等键=lawyer+version 的 version 半边） */
export interface ReplaceScheduleInput {
  /**
   * 乐观并发令牌（version 语义最小化，简报裁决）：与服务端当前一致才接受，否则 409
   * E_CONFLICT（G-B 做项2：乐观锁错误码全仓统一）；无行=0。成功替换后服务端 +1，同 version 重放即 409。
   */
  readonly version: number;
  readonly templates: readonly TemplateWrite[];
}

export interface TemplateWrite {
  readonly weekday: number;
  /** 'HH:MM' 或 'HH:MM:SS'（入站宽容、落库/出站归一 'HH:MM:SS'；§5 契约词汇=snake_case） */
  readonly start_time: string;
  /** 60/90/120 三档（R-03；§5 契约词汇=snake_case） */
  readonly duration_small: number;
  readonly enabled?: boolean;
}

/** 物化候选（§4 纯函数产物；不落库——R-02 具体时刻由 B2 slot_locks 承载） */
export interface SlotCandidate {
  readonly templateId: number;
  readonly slotStart: Date;
  /** = slotStart + durationSmall 分钟（跨周边界在此显形：周日 23:30+60min → 次日 00:30） */
  readonly slotEnd: Date;
  readonly durationSmall: SlotDuration;
}

/**
 * 状态视图状态词汇：FREE=无活跃锁（§2「空闲」）；其余为活跃锁状态原样透出（PENDING_PAYMENT/
 * LOCKED/OCCUPIED，对齐 B2 SlotLockStatus 非终态口径——PENDING_PAYMENT 是活跃态不得显示为空闲）。
 */
export type SlotViewStatus = 'FREE' | SlotLockStatus;

/** §5 出参行：{slot_start, status, ref}；ref=活跃锁归属业务实体（FREE 时 null） */
export interface SlotViewRow {
  readonly slotStart: Date;
  readonly status: SlotViewStatus;
  readonly ref: { readonly refType: string; readonly refId: number } | null;
}

/** materializeSlots 出参（简报：返回候选 timestamptz + 各候选当前状态；调用方自己调 B2 lockSlot） */
export interface MaterializedSlot extends SlotCandidate, SlotViewRow {}
