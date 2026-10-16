/**
 * B1 时间表服务（§2/§4/§5 + Task 4 简报裁决）：
 *   - 模板全量替换（PUT，幂等键=lawyer+version 乐观并发：入参 version 与服务端当前一致才接受，
 *     否则 409 E_CONFLICT——乐观锁错误码全仓统一 E_CONFLICT（G-B 做项2 裁决：version mismatch
 *     是冲突的种；A2 训练授权的 E_VERSION_MISMATCH 是 policy 闸语义，不属于乐观锁，不受此裁决影响）；
 *   - 物化入口 materializeSlots(lawyerId, date)：候选 timestamptz + 各候选当前状态（实时），
 *     不落库（R-02：具体时刻由 B2 slot_locks 承载）、不代锁（C1/C2 选段后自己调 B2 lockSlot）；
 *   - 状态视图 slotViews(lawyerId, from, to)：实时 join slot_locks（活跃=PENDING_PAYMENT/LOCKED/
 *     OCCUPIED 非终态）+ 60s 进程内缓存适配位（R-W2-8：Slot* 事件消费主动失效 + TTL 兜底）。
 *
 * 只写本 schema 的 B1 表（time_slot_templates / lawyer_schedule_versions）；slot_locks 只读
 * （§8 实时 join 的文档 mandate；同 schema，不越边界）。
 */
import { Injectable } from '@nestjs/common';
import { AppError, ErrorCode } from '@ljr/shared';
import type { SqlExecutor } from '../../infrastructure/sql';
import { PgPoolService } from '../../infrastructure/sql';
import type { SlotLockStatus } from './slot-lock.types';
import { materializeDay, wallClockToInstant, weekdayOfDate } from './time-table.materializer';
import { SlotViewCache } from './time-table.cache';
import {
  SLOT_DURATIONS,
  type MaterializedSlot,
  type ReplaceScheduleInput,
  type ScheduleView,
  type SlotViewRow,
  type TemplateWrite,
  type TimeSlotTemplateView,
} from './time-table.types';

/** 活跃（占段）状态集：B2 ux_slot_active / ix_slot_user 部分索引谓词同款（非终态口径） */
const ACTIVE_STATUSES_SQL = `'PENDING_PAYMENT', 'LOCKED', 'OCCUPIED'`;

/** 状态视图区间上限（自定护栏：防无界区间扫描；§5 未定，报告注明） */
const MAX_RANGE_DAYS = 31;

const DAY_MS = 86_400_000;

interface TemplateRow {
  readonly id: string;
  readonly weekday: number;
  readonly start_time: string;
  readonly duration_small: number;
  readonly enabled: boolean;
}

interface LockInfo {
  readonly status: SlotLockStatus;
  readonly refType: string;
  readonly refId: number;
}

@Injectable()
export class TimeTableService {
  constructor(
    private readonly pool: PgPoolService,
    private readonly cache: SlotViewCache,
  ) {}

  // ---------- §5 GET /lawyer/{id}/schedule ----------

  async getSchedule(lawyerId: number): Promise<ScheduleView> {
    this.assertLawyerId(lawyerId);
    return this.readSchedule(this.pool, lawyerId);
  }

  // ---------- §5 PUT /lawyer/schedule（全量替换，幂等键=lawyer+version） ----------

  /**
   * 全量替换：版本行确保存在（无行=0）→ FOR UPDATE 串行化并发替换 → 比对 version（不一致 409）
   * → DELETE+INSERT 全量 → version+1。R-01：删除/禁用只动模板行，slot_locks 不受影响。
   */
  async replaceSchedule(lawyerId: number, input: ReplaceScheduleInput): Promise<ScheduleView> {
    this.assertLawyerId(lawyerId);
    if (!Number.isInteger(input.version) || input.version < 0) {
      throw new AppError(
        ErrorCode.InvalidArgument,
        `version 须为非负整数（无行=0）：${String(input.version)}`,
      );
    }
    const templates = input.templates.map((t) => this.normalizeTemplate(t)); // R-03 应用校验层
    return this.pool.withTransaction(async (uow) => {
      await uow.query(
        `INSERT INTO schedule.lawyer_schedule_versions (lawyer_id, version) VALUES ($1, 0)
         ON CONFLICT (lawyer_id) DO NOTHING`,
        [lawyerId],
      );
      const current = await uow.query<{ version: number }>(
        `SELECT version FROM schedule.lawyer_schedule_versions WHERE lawyer_id = $1 FOR UPDATE`,
        [lawyerId],
      );
      const serverVersion = current.rows[0]?.version;
      if (serverVersion === undefined) {
        throw new AppError(ErrorCode.InternalError, '时间表版本行缺失（不应触达）');
      }
      if (serverVersion !== input.version) {
        throw new AppError(
          ErrorCode.Conflict,
          `时间表版本不一致（服务端 ${serverVersion}，入参 ${input.version}），请刷新后重试`,
        );
      }
      await uow.query(`DELETE FROM schedule.time_slot_templates WHERE lawyer_id = $1`, [lawyerId]);
      for (const t of templates) {
        await uow.query(
          `INSERT INTO schedule.time_slot_templates
             (lawyer_id, weekday, start_time, duration_small, enabled)
           VALUES ($1, $2, $3::time, $4, $5)`,
          [lawyerId, t.weekday, t.startTime, t.durationSmall, t.enabled],
        );
      }
      await uow.query(
        `UPDATE schedule.lawyer_schedule_versions
            SET version = version + 1, updated_at = now() WHERE lawyer_id = $1`,
        [lawyerId],
      );
      return this.readSchedule(uow, lawyerId);
    });
  }

  // ---------- 物化入口（简报：候选 timestamptz + 各候选当前状态；B1 不代锁） ----------

  async materializeSlots(lawyerId: number, date: string): Promise<MaterializedSlot[]> {
    this.assertLawyerId(lawyerId);
    this.assertDate(date, 'date');
    return (await this.loadRange(this.pool, lawyerId, date, date)).candidates;
  }

  // ---------- §5 GET /lawyer/{id}/slots?from=&to=（60s 进程内缓存适配位，R-W2-8） ----------

  async slotViews(lawyerId: number, from: string, to: string): Promise<SlotViewRow[]> {
    this.assertLawyerId(lawyerId);
    this.assertDate(from, 'from');
    this.assertDate(to, 'to');
    const cached = this.cache.get<SlotViewRow[]>(lawyerId, from, to);
    if (cached) return cached;
    const rows = this.toViewRows(await this.loadRange(this.pool, lawyerId, from, to));
    this.cache.set(lawyerId, from, to, rows);
    return rows;
  }

  // ---------- 内部件 ----------

  private async readSchedule(exec: SqlExecutor, lawyerId: number): Promise<ScheduleView> {
    const res = await exec.query<TemplateRow & { version: number }>(
      `SELECT t.id::text AS id, t.weekday, t.start_time::text AS start_time,
              t.duration_small, t.enabled,
              COALESCE((SELECT v.version FROM schedule.lawyer_schedule_versions v
                         WHERE v.lawyer_id = t.lawyer_id), 0) AS version
         FROM schedule.time_slot_templates t
        WHERE t.lawyer_id = $1
        ORDER BY t.weekday, t.start_time, t.id`,
      [lawyerId],
    );
    const templates: TimeSlotTemplateView[] = res.rows.map((row) => ({
      id: Number(row.id),
      weekday: row.weekday,
      startTime: row.start_time,
      durationSmall: this.assertDuration(row.duration_small),
      enabled: row.enabled,
    }));
    return { version: res.rows[0]?.version ?? 0, templates };
  }

  /**
   * 区间计算（候选 + 视图共用）：enabled 模板按日历日物化（§4 算法）→ 实时 join 活跃锁
   * （窗口=上海墙钟 [from 00:00, to 次日 00:00)，ux_slot_active 部分索引同款谓词）。
   * R-01 视图可见性：候选命中的锁以其实态呈现（非 FREE），未命中候选的孤儿活跃锁（模板已被
   * 禁用/替换删除的已排期场次）仍补入视图——已排期场次不受模板变更影响。
   */
  private async loadRange(
    exec: SqlExecutor,
    lawyerId: number,
    from: string,
    to: string,
  ): Promise<{ candidates: MaterializedSlot[]; lockByStart: Map<string, LockInfo> }> {
    const days = this.enumerateDays(from, to);
    const tplRes = await exec.query<TemplateRow>(
      `SELECT id::text AS id, weekday, start_time::text AS start_time, duration_small, enabled
         FROM schedule.time_slot_templates
        WHERE lawyer_id = $1 AND enabled`,
      [lawyerId],
    );
    const windowStart = wallClockToInstant(from, '00:00:00');
    const windowEnd = wallClockToInstant(this.dayAfter(to), '00:00:00');
    const lockRes = await exec.query<{
      slot_start: Date;
      status: SlotLockStatus;
      ref_type: string;
      ref_id: string;
    }>(
      `SELECT slot_start, status, ref_type, ref_id FROM schedule.slot_locks
        WHERE lawyer_id = $1 AND status IN (${ACTIVE_STATUSES_SQL})
          AND slot_start >= $2 AND slot_start < $3
        ORDER BY slot_start, id`,
      [lawyerId, windowStart, windowEnd],
    );
    const lockByStart = new Map<string, LockInfo>();
    for (const row of lockRes.rows) {
      lockByStart.set(new Date(row.slot_start).toISOString(), {
        status: this.assertLockStatus(row.status),
        refType: row.ref_type,
        refId: Number(row.ref_id),
      });
    }
    const candidates: MaterializedSlot[] = days.flatMap((day) =>
      materializeDay(
        day,
        tplRes.rows.map((row) => ({
          id: Number(row.id),
          weekday: row.weekday,
          startTime: row.start_time,
          durationSmall: row.duration_small,
          enabled: row.enabled,
        })),
      ).map((c) => {
        const lock = lockByStart.get(c.slotStart.toISOString());
        return {
          ...c,
          status: lock?.status ?? 'FREE',
          ref: lock ? { refType: lock.refType, refId: lock.refId } : null,
        };
      }),
    );
    return { candidates, lockByStart };
  }

  private toViewRows(range: {
    candidates: MaterializedSlot[];
    lockByStart: Map<string, LockInfo>;
  }): SlotViewRow[] {
    const rows: SlotViewRow[] = range.candidates.map((c) => ({
      slotStart: c.slotStart,
      status: c.status,
      ref: c.ref,
    }));
    const candidateStarts = new Set(range.candidates.map((c) => c.slotStart.toISOString()));
    for (const [iso, lock] of range.lockByStart) {
      if (!candidateStarts.has(iso)) {
        rows.push({
          slotStart: new Date(iso),
          status: lock.status,
          ref: { refType: lock.refType, refId: lock.refId },
        });
      }
    }
    return rows.sort((a, b) => a.slotStart.getTime() - b.slotStart.getTime());
  }

  // ---------- 校验（R-03 应用校验层；错误一律 InvalidArgument=400） ----------

  private normalizeTemplate(t: TemplateWrite): {
    weekday: number;
    startTime: string;
    durationSmall: number;
    enabled: boolean;
  } {
    if (!Number.isInteger(t.weekday) || t.weekday < 0 || t.weekday > 6) {
      throw new AppError(
        ErrorCode.InvalidArgument,
        `weekday 须为 0-6 整数（0=周日..6=周六）：${String(t.weekday)}`,
      );
    }
    if (typeof t.enabled !== 'undefined' && typeof t.enabled !== 'boolean') {
      throw new AppError(ErrorCode.InvalidArgument, `enabled 须为布尔：${String(t.enabled)}`);
    }
    return {
      weekday: t.weekday,
      startTime: this.normalizeStartTime(t.start_time),
      durationSmall: this.assertDuration(t.duration_small), // R-03：仅 60/90/120 三档
      enabled: t.enabled ?? true,
    };
  }

  /** 'HH:MM' / 'HH:MM:SS' → 'HH:MM:SS'（落库/出站归一口径） */
  private normalizeStartTime(raw: unknown): string {
    if (typeof raw !== 'string' || !/^\d{2}:\d{2}(:\d{2})?$/.test(raw)) {
      throw new AppError(
        ErrorCode.InvalidArgument,
        `start_time 须为 HH:MM 或 HH:MM:SS：${String(raw)}`,
      );
    }
    const [h, m, s] = raw.split(':').map(Number) as [number, number, number?];
    if (h > 23 || m > 59 || (s ?? 0) > 59) {
      throw new AppError(ErrorCode.InvalidArgument, `start_time 时刻越界：${raw}`);
    }
    return s === undefined ? `${raw}:00` : raw;
  }

  private assertDuration(value: unknown): 60 | 90 | 120 {
    if (typeof value !== 'number' || !(SLOT_DURATIONS as readonly number[]).includes(value)) {
      throw new AppError(
        ErrorCode.InvalidArgument,
        `duration_small 须为 60/90/120 三档（R-03）：${String(value)}`,
      );
    }
    return value as 60 | 90 | 120;
  }

  private assertLockStatus(value: string): SlotLockStatus {
    if (value === 'PENDING_PAYMENT' || value === 'LOCKED' || value === 'OCCUPIED') return value;
    throw new AppError(ErrorCode.InternalError, `slot_locks 出现非活跃状态（不应触达）：${value}`);
  }

  private assertLawyerId(lawyerId: number): void {
    if (!Number.isInteger(lawyerId) || lawyerId <= 0) {
      throw new AppError(ErrorCode.InvalidArgument, `lawyerId 须为正整数：${String(lawyerId)}`);
    }
  }

  private assertDate(value: string, name: string): void {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      throw new AppError(ErrorCode.InvalidArgument, `${name} 须为 YYYY-MM-DD：${String(value)}`);
    }
    try {
      weekdayOfDate(value);
    } catch {
      throw new AppError(
        ErrorCode.InvalidArgument,
        `${name} 须为真实存在的日历日（YYYY-MM-DD）：${value}`,
      );
    }
  }

  /** 闭区间 [from, to] 的日历日列表（含两端）；倒置/跨度超护栏即拒（自定护栏，报告注明） */
  private enumerateDays(from: string, to: string): string[] {
    const startMs = Date.parse(`${from}T00:00:00Z`);
    const endMs = Date.parse(`${to}T00:00:00Z`);
    if (endMs < startMs) {
      throw new AppError(ErrorCode.InvalidArgument, `区间倒置（from 须 ≤ to）：${from}..${to}`);
    }
    const days = Math.round((endMs - startMs) / DAY_MS) + 1;
    if (days > MAX_RANGE_DAYS) {
      throw new AppError(
        ErrorCode.InvalidArgument,
        `视图区间跨度过大（≤${MAX_RANGE_DAYS} 天）：${from}..${to}`,
      );
    }
    return Array.from({ length: days }, (_, i) =>
      new Date(startMs + i * DAY_MS).toISOString().slice(0, 10),
    );
  }

  private dayAfter(date: string): string {
    return new Date(Date.parse(`${date}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);
  }
}
