/**
 * D6 调度执行器装配（M2-W3 T2；附录 A.2 裁定——零目录增量：OOO_ACCEPT_TIMEOUT/
 * OOO_SETTLE_DEFAULT/DIFF_PAY_TIMEOUT 三目录行 M1-W1 已建（producer/executor=D6，
 * recheckAnchor=one_on_one_orders 状态），本批装配 executor+预写缝三处：PAID 同事务预写
 * 接单锅（due=accept_deadline）/FINISHED 同事务预写实结默认（due=finished_at+30min）/
 * DIFF_PENDING 同事务预写补差超时（due=+15min）。
 *
 * 经 ScheduleExecutorRegistry.register 注册（onModuleInit，room.executors/
 * attendance.executors 同形态）。执行语义（I2 §4）：业务写经 ctx.uow 与 job DONE 同事务；
 * recheck=false → CANCELLED 无操作（R-02 幂等回查锚点=订单状态）。
 *   OOO_ACCEPT_TIMEOUT recheck=status='PAID'（已接单/已取消→无操作）；
 *   OOO_SETTLE_DEFAULT recheck=status∈{FINISHED,SETTLING}（已结算/取消/补差在途→无操作）；
 *   DIFF_PAY_TIMEOUT recheck=status='DIFF_PENDING'（已付/已按比例结算→无操作）。
 * 多退实结的 F2 受理为自持事务（指令面先行；崩溃窗口重放由幂等键收敛——服务面类注）。
 */
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ScheduleExecutorRegistry } from '../schedule/scheduler-executor.registry';
import { OneOnOneService } from './one-on-one.service';
import { ONE_ON_ONE_JOB_REF_TYPE } from './one-on-one.types';

@Injectable()
export class OneOnOneJobExecutors implements OnModuleInit {
  constructor(
    private readonly registry: ScheduleExecutorRegistry,
    private readonly orders: OneOnOneService,
  ) {}

  onModuleInit(): void {
    // OOO_ACCEPT_TIMEOUT（I2 catalog：producer=D6 支付收敛预写、executor=D6 接单超时——本批装配）
    this.registry.register({
      jobType: 'OOO_ACCEPT_TIMEOUT',
      // 回查锚点=订单状态：PAID 未接单才触发（accept 先到=ACCEPTED 及之后 → CANCELLED 无事件）
      recheck: async ({ job, uow }) => {
        if (job.refType !== ONE_ON_ONE_JOB_REF_TYPE || job.refId === null) return false; // 类型防御
        return this.orders.statusIn(uow, job.refId, ['PAID']);
      },
      execute: async ({ job, uow }) => {
        if (job.refId === null) return { order_id: 0, status: 'SKIPPED' };
        const r = await this.orders.acceptTimeoutExecute(uow, job.refId);
        return { ...r }; // 展开为字面量类型（JobExecutor.execute 返回 Record 的形态约束）
      },
    });

    // OOO_SETTLE_DEFAULT（I2 catalog：producer=D6 finish 预写、executor=D6 实结默认确认——本批装配）
    this.registry.register({
      jobType: 'OOO_SETTLE_DEFAULT',
      // 回查锚点=订单状态：FINISHED（双默认）/SETTLING（补默认）才触发；其余幂等无操作
      recheck: async ({ job, uow }) => {
        if (job.refType !== ONE_ON_ONE_JOB_REF_TYPE || job.refId === null) return false;
        return this.orders.statusIn(uow, job.refId, ['FINISHED', 'SETTLING']);
      },
      execute: async ({ job, uow }) => {
        if (job.refId === null) return { order_id: 0, status: 'SKIPPED' };
        const r = await this.orders.settleDefaultExecute(uow, job.refId);
        return { ...r };
      },
    });

    // DIFF_PAY_TIMEOUT（I2 catalog：producer=D6 少补结算预写、executor=D6 补差超时——本批装配）
    this.registry.register({
      jobType: 'DIFF_PAY_TIMEOUT',
      // 回查锚点=订单状态：DIFF_PENDING 未付才触发（补差 PAY_SUCCESS 先到 → 已 SETTLED 无操作）
      recheck: async ({ job, uow }) => {
        if (job.refType !== ONE_ON_ONE_JOB_REF_TYPE || job.refId === null) return false;
        return this.orders.statusIn(uow, job.refId, ['DIFF_PENDING']);
      },
      execute: async ({ job, uow }) => {
        if (job.refId === null) return { order_id: 0, status: 'SKIPPED' };
        const r = await this.orders.diffPayTimeoutExecute(uow, job.refId);
        return { ...r };
      },
    });
  }
}
