/**
 * H7 调度执行器装配：RULE_EFFECTIVE（公示期满自动生效，R-01）。
 *
 * 经 ScheduleExecutorRegistry.register 注册（I2 机制面；onModuleInit 装配，slot-lock.executors
 * 同形态）。执行语义（I2 §4）：执行器业务写经 ctx.uow 与 job DONE 同事务；recheck=false →
 * CANCELLED 无操作（R-02）。
 *
 * 契约注记（I2 评审确认）落地口径：
 *   ① registerJob 同键重注册不刷新 dueAt——RULE_EFFECTIVE 一版一 job（ref=规则行 id），提交公示
 *      恰注册一次且重复提交幂等短路，不涉及改期；
 *   ② 取消语义=cancelJob 之外须落业务终态——规则域无「撤销公示」业务态（PUBLISHED 只能被新版本
 *      取代），recheck 以 publish_status+生效窗口为锚点兜底一切竞态（未到窗/已生效/已废弃均
 *      CANCELLED 无操作），无成对 cancelJob 调用点（控制者裁决口径）。
 */
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ScheduleExecutorRegistry } from '../schedule/scheduler-executor.registry';
import { RuleCenterService } from './rule-center.service';

@Injectable()
export class RuleCenterJobExecutors implements OnModuleInit {
  constructor(
    private readonly registry: ScheduleExecutorRegistry,
    private readonly rules: RuleCenterService,
  ) {}

  onModuleInit(): void {
    // RULE_EFFECTIVE（I2 catalog：生产方/执行器=H7 规则中心，回查锚点=rule_definitions.publish_status）
    this.registry.register({
      jobType: 'RULE_EFFECTIVE',
      recheck: async ({ job, uow }) => {
        if (job.refId === null) return false; // 类型防御：RULE_EFFECTIVE 恒带 refId
        return this.rules.isEffectiveDue(uow, job.refId);
      },
      execute: async ({ job, uow }) => {
        if (job.refId === null) return { rule_id: 0, transitioned: false };
        const r = await this.rules.markEffective(uow, job.refId);
        return { rule_id: r.ruleId, transitioned: r.transitioned };
      },
    });
  }
}
