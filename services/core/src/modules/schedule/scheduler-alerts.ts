/**
 * 调度告警（R-03 开房准点 + FAILED 处置 + 积压监控判定）。
 *
 * 外部对接后置约定（工作约定 2026-10-14）：电话告警为 mock 适配器（零外部调用、零凭据），
 * 接口留供应商位——真实电话/IM 通道在 M2+ 经同一 SchedulerAlertSink 替换；
 * FAILED 告警工单最终落 H3 dead_letter（H3 落位后接 sink），积压 >60s 告警由 H4 巡检消费
 * isBacklogExpired/backlog()（本批次只交付可测试判定，不接巡检）。
 *
 * 告警在 tick 事务提交后触发（不阻塞/不回滚调度主流程）；同类型 FAILED 5min 去重（§4）为
 * 进程内存态——多实例部署下各实例独立去重，可能重复告警（⚠决策位：dev 单实例口径，M2+ 随
 * H3 告警工单表持久化收敛）。
 */
import { Injectable, Optional } from '@nestjs/common';
import type { ScheduleJobType } from './scheduler.catalog';
import { SCHEDULER_DEFAULT_CONFIG, type SchedulerConfig } from './scheduler.config';

export type SchedulerAlertKind = 'ROOM_OPEN_DELAY' | 'JOB_FAILED' | 'BACKLOG';

export interface SchedulerAlert {
  readonly kind: SchedulerAlertKind;
  readonly jobType?: ScheduleJobType;
  readonly jobId?: number;
  readonly message: string;
}

/** 告警出口（供应商位：mock=M2+ 替换为真实电话/IM 通道；FAILED 工单位=H3） */
export interface SchedulerAlertSink {
  send(alert: SchedulerAlert): Promise<void>;
}

/** 电话告警 mock：零外部调用，记录到内存数组供测试断言（供应商位=M2+） */
@Injectable()
export class MockPhoneAlertSink implements SchedulerAlertSink {
  readonly alerts: SchedulerAlert[] = [];

  async send(alert: SchedulerAlert): Promise<void> {
    this.alerts.push(alert);
  }
}

/** R-03：ROOM_OPEN 触发延迟 >thresholdMs（默认 30s）——纯函数可测试 */
export function isRoomOpenDelayed(dueAt: Date, now: Date, thresholdMs = 30_000): boolean {
  return now.getTime() - dueAt.getTime() > thresholdMs;
}

/** 积压判定：PENDING job 逾期 >thresholdMs（默认 60s，H4 巡检联动口径）——纯函数可测试 */
export function isBacklogExpired(dueAt: Date, now: Date, thresholdMs = 60_000): boolean {
  return now.getTime() - dueAt.getTime() > thresholdMs;
}

@Injectable()
export class SchedulerAlertService {
  private readonly config: SchedulerConfig;
  /** 同类型 FAILED 上次告警时刻（进程内 5min 去重，§4） */
  private readonly lastFailedAlertAt = new Map<ScheduleJobType, number>();

  constructor(
    private readonly sink: SchedulerAlertSink,
    @Optional() config?: SchedulerConfig,
  ) {
    this.config = config ?? SCHEDULER_DEFAULT_CONFIG;
  }

  /** job FAILED 告警：同类型 failedAlertDedupMs 内去重；返回是否实际发出 */
  async alertJobFailed(
    jobType: ScheduleJobType,
    jobId: number,
    message: string,
    now: Date = new Date(),
  ): Promise<boolean> {
    const last = this.lastFailedAlertAt.get(jobType);
    if (last !== undefined && now.getTime() - last < this.config.failedAlertDedupMs) {
      return false;
    }
    this.lastFailedAlertAt.set(jobType, now.getTime());
    await this.sink.send({
      kind: 'JOB_FAILED',
      jobType,
      jobId,
      message: `调度 job FAILED（${jobType} #${jobId}）：${message}`,
    });
    return true;
  }

  /** R-03：ROOM_OPEN 延迟 >30s 电话告警（每次延迟触发独立告警，不去重）；返回是否实际发出 */
  async alertRoomOpenDelay(jobId: number, dueAt: Date, now: Date = new Date()): Promise<boolean> {
    if (!isRoomOpenDelayed(dueAt, now, this.config.roomOpenDelayAlertMs)) {
      return false;
    }
    await this.sink.send({
      kind: 'ROOM_OPEN_DELAY',
      jobType: 'ROOM_OPEN',
      jobId,
      message: `ROOM_OPEN 延迟 ${Math.round((now.getTime() - dueAt.getTime()) / 1000)}s 触发（准点保障 R-03）`,
    });
    return true;
  }
}
