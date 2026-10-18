/**
 * D2 调度执行器装配（M2-W1 T4）：REMIND×4 + REMIND_GRACE_END——I2 目录 executor='D2（提醒）'
 * 的真实落位（catalog 已注册，本批只装配执行器）。NO_EXECUTOR 设计内噪音随本装配消失并验
 * （04 §8 #33 关闭条件的一半——另一半=ROOM_OPEN，T1 已装）。
 *
 * 经 ScheduleExecutorRegistry.register 注册（onModuleInit，room.executors/session.executors
 * 同形态）。执行语义（I2 §4）：业务写经 ctx.uow 与 job DONE 同事务（通知登记/事件出箱/
 * 房间消息整体原子，崩溃窗口回滚重投由判重收敛）；recheck=false → CANCELLED 无操作。
 *   REMIND×4 recheck=场次仍有效（trade sessionRemindable 导出面，修环 I-1 收紧：
 *   sessionOpenable 同口径（终态/不存在 → false）+「报名已截止仍未成团」半边——
 *   **耦合声明**：ENROLL_DEADLINE 流标执行器异常进重试退避窗时，CREATED 场次的 REMIND_24H
 *   （due=slot_start−24h 与 deadline 同刻同源）若同刻先行拾取会对即将 FAILED 的场次发幽灵
 *   提醒——recheck 半边在流标 job 终态化之前先行拦截（R-03）；成团链不受截止窗影响）；
 *   幂等=(user,kind,session) 通知判重（reminder.service 头注，W2 可升级回执表）。
 *   REMIND_GRACE_END（目录第 25 项，M2-W1 T4 唯一增量）recheck=room 仍 OPEN（与 GRACE_END
 *   同锚——终态/IN_SERVICE 无宽限语义；**不受 I-1 收紧影响，锚=room 非 session**）；
 *   execute=宽限结束前 1min 房间消息（@Agent 名义），
 *   只对 room 会话、无个人推送（用户侧 1min 前推送非 D2 §2 规格要求，不发明）。
 */
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ScheduleExecutorRegistry } from '../schedule/scheduler-executor.registry';
import { RoomService } from '../fulfillment/room.service';
import { SessionService } from '../trade/session.service';
import { REMINDER_KINDS, ReminderDispatchService } from './reminder.service';

@Injectable()
export class ReminderJobExecutors implements OnModuleInit {
  constructor(
    private readonly registry: ScheduleExecutorRegistry,
    private readonly reminders: ReminderDispatchService,
    private readonly sessions: SessionService,
    private readonly rooms: RoomService,
  ) {}

  onModuleInit(): void {
    // REMIND×4（I2 catalog：producer=C3/C1 预写（M1）、executor=D2 提醒（本批装配））
    for (const kind of REMINDER_KINDS) {
      this.registry.register({
        jobType: kind,
        // 回查锚点=场次可提醒性（trade 预写口径 refType='session'）：终态/不存在/已截止未成团
        // → false → CANCELLED（修环 I-1 收紧，耦合声明见类注）
        recheck: async ({ job, uow }) => {
          if (job.refType !== 'session' || job.refId === null) return false; // 类型防御
          return this.sessions.sessionRemindable(uow, job.refId);
        },
        execute: async ({ job, uow }) => {
          // 不可达死分支（recheck 已对 refType/refId 防御返回 false——room.executors 同款保留防御）
          if (job.refId === null) {
            return { session_id: 0, kind, recipients: 0, dispatched: 0, room_message: false };
          }
          const r = await this.reminders.dispatchSessionReminder(uow, job.refId, kind);
          return { ...r }; // 展开为字面量类型（JobExecutor.execute 返回 Record 的形态约束）
        },
      });
    }

    // REMIND_GRACE_END（I2 catalog：producer=D1 开房成功同事务预写（due=grace_end−1min）、
    // executor=D2 房间内提醒——本批新增目录项）
    this.registry.register({
      jobType: 'REMIND_GRACE_END',
      // 回查锚点=room 状态（GRACE_END 同锚）：已终态/IN_SERVICE/不存在 → false → CANCELLED 无消息
      recheck: async ({ job, uow }) => {
        if (job.refType !== 'room' || job.refId === null) return false; // 类型防御
        return (await this.rooms.statusOf(uow, job.refId)) === 'OPEN';
      },
      execute: async ({ job, uow }) => {
        // 不可达死分支（recheck 已对 refType/refId 防御返回 false——room.executors 同款保留防御）
        if (job.refId === null) return { room_id: 0, posted: false };
        const r = await this.reminders.postGraceEndReminder(uow, job.refId);
        return { ...r }; // 同上：字面量展开
      },
    });
  }
}
