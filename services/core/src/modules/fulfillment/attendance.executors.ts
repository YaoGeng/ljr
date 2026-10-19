/**
 * D3 调度执行器装配（M2-W2 T2；附录 A.2 裁定——零目录增量，catalog ABSENT_15M/NO_SHOW_CLOSE
 * 的 executor=D3 真实落位）：producer=D1 开房成功同事务预写（due=grace_end+15min 同锚，
 * room.service 预写缝）。
 *
 * 经 ScheduleExecutorRegistry.register 注册（onModuleInit，room.executors/reminder.executors
 * 同形态）。执行语义（I2 §4）：业务写经 ctx.uow 与 job DONE 同事务；recheck=false →
 * CANCELLED 无操作（R-02 幂等回查锚点=实体状态）。
 *   ABSENT_15M recheck=room 非 CANCELLED 且名册存在未判定成员（hasUnadjudicated）——
 *     **⚠W2-10 裁定=判定与房间生命周期正交**（控制者修复环 I-2：律师经 close API 提前关房
 *     OPEN→CLOSED 后缺席判定照常补判——PRD §8.5 的 70/30 分成依据不因关房静默缺失，04 §8
 *     回写随 T10；仅 CANCELLED=平台取消路径已由 job1 全员缺席分支承载且 presence 面已无
 *     意义）；execute=deadline（grace_end+15min，room.types.ABSENT_AFTER_MS 同源常量）的
 *     presence 序列末位事件判定：末位 join（含恰在 deadline 进入）=LATE、末位 leave/无事件
 *     =ABSENT（修复环 I-1——早进早走者不在场；first_join_at 列仅观测）。
 *   NO_SHOW_CLOSE recheck=room 仍 OPEN（关闭动作对 OPEN 房间才有语义——CLOSED=律师已收场
 *     （缺席补判归 ABSENT_15M）、CANCELLED=job1 全员缺席已处理，幂等无操作即此半边）；
 *     execute=无人到场关闭兜底（attendances 判定结果复核：零在场+零已判 NORMAL|LATE →
 *     平台取消路径；有人 → 无操作）。
 * 两 job 同 due（due_at,id 序）：ABSENT_15M 先拾取先行判定，NO_SHOW_CLOSE 复核判定结果——
 * 兜底场景（GracePeriodEnded 消费死信）下接力完成「全员缺席→取消」的关闭动作承载。
 */
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ScheduleExecutorRegistry } from '../schedule/scheduler-executor.registry';
import { AttendanceService } from './attendance.service';

@Injectable()
export class AttendanceJobExecutors implements OnModuleInit {
  constructor(
    private readonly registry: ScheduleExecutorRegistry,
    private readonly attendance: AttendanceService,
  ) {}

  onModuleInit(): void {
    // ABSENT_15M（I2 catalog：producer=D1 开房预写、executor=D3 缺席判定——本批装配）
    this.registry.register({
      jobType: 'ABSENT_15M',
      recheck: async ({ job, uow }) => {
        if (job.refType !== 'room' || job.refId === null) return false; // 类型防御
        return this.attendance.hasUnadjudicated(uow, job.refId);
      },
      execute: async ({ job, uow }) => {
        // 不可达死分支（recheck 已对 refType/refId 防御返回 false——room.executors 同款保留防御）
        if (job.refId === null) return { room_id: 0, late: 0, absent: 0 };
        const r = await this.attendance.adjudicateAbsentWindow(uow, job.refId);
        return { ...r }; // 展开为字面量类型（JobExecutor.execute 返回 Record 的形态约束）
      },
    });

    // NO_SHOW_CLOSE（I2 catalog：producer=D1 开房预写、executor=D3 无人到场关闭——本批装配）
    this.registry.register({
      jobType: 'NO_SHOW_CLOSE',
      recheck: async ({ job, uow }) => {
        if (job.refType !== 'room' || job.refId === null) return false; // 类型防御
        // 幂等回查锚=room 状态：job1 全员缺席已处理（CANCELLED）/已 IN_SERVICE/CLOSED → 无操作
        const status = await uow.query<{ status: string }>(
          `SELECT status FROM fulfillment.rooms WHERE id = $1`,
          [job.refId],
        );
        return status.rows[0]?.status === 'OPEN';
      },
      execute: async ({ job, uow }) => {
        if (job.refId === null) return { room_id: 0, closed: false };
        const r = await this.attendance.closeForNoShow(uow, job.refId);
        return { ...r };
      },
    });
  }
}
