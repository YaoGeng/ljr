/**
 * D1 调度执行器装配（I2 §4 对照表：ROOM_OPEN executor=D1 开房（catalog highPriority=true
 * 独立通道）、GRACE_END executor 落 D1——附录 A.2 裁决：catalog 字段语义=最终判定方 D3=W2
 * 事件消费，W1 执行器在 D1 发 GracePeriodEnded 即止，判定禁前置（D1 §9），零搬迁）。
 *
 * 经 ScheduleExecutorRegistry.register 注册（onModuleInit，session.executors/
 * rule-center.executors 同形态）。执行语义（I2 §4）：业务写经 ctx.uow 与 job DONE 同事务；
 * recheck=false → CANCELLED 无操作（R-02 幂等回查锚点=实体状态）。
 *   ROOM_OPEN recheck=场次仍有效可开（经 trade 导出面 sessionOpenable：终态/不存在→false）；
 *   幂等兜底=rooms.session_id UNIQUE + openRoomForSession 入口短路（重放无副作用）。
 *   GRACE_END recheck=room 仍 OPEN（终态/不存在→false——close 先到/开房失败行无宽限语义）。
 */
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ScheduleExecutorRegistry } from '../schedule/scheduler-executor.registry';
import { SessionService } from '../trade/session.service';
import { RoomService } from './room.service';

@Injectable()
export class RoomJobExecutors implements OnModuleInit {
  constructor(
    private readonly registry: ScheduleExecutorRegistry,
    private readonly rooms: RoomService,
    private readonly sessions: SessionService,
  ) {}

  onModuleInit(): void {
    // ROOM_OPEN（I2 catalog：producer=C1/C3 创建预写（M1）、executor=D1 开房（本批装配））
    this.registry.register({
      jobType: 'ROOM_OPEN',
      // 回查锚点=场次有效性（trade 预写口径 refType='session'）：终态/不存在 → false → CANCELLED
      recheck: async ({ job, uow }) => {
        if (job.refType !== 'session' || job.refId === null) return false; // 类型防御
        return this.sessions.sessionOpenable(uow, job.refId);
      },
      execute: async ({ job, uow }) => {
        if (job.refId === null) return { opened: false, room_id: 0, session_id: 0 };
        const r = await this.rooms.openRoomForSession(uow, job.refId);
        return { ...r }; // 展开为字面量类型（JobExecutor.execute 返回 Record 的形态约束）
      },
    });

    // GRACE_END（I2 catalog：producer=D1 开房成功同事务预写、executor=D1（W1）→D3 判定=W2 消费）
    this.registry.register({
      jobType: 'GRACE_END',
      // 回查锚点=room 状态：已终态（close 先到/失败行）/不存在 → false → CANCELLED 无事件
      recheck: async ({ job, uow }) => {
        if (job.refType !== 'room' || job.refId === null) return false; // 类型防御
        return (await this.rooms.statusOf(uow, job.refId)) === 'OPEN';
      },
      execute: async ({ job, uow }) => {
        if (job.refId === null) return { ended: false, room_id: 0, session_id: null };
        const r = await this.rooms.endGracePeriod(uow, job.refId);
        return { ...r }; // 同上：字面量展开
      },
    });
  }
}
