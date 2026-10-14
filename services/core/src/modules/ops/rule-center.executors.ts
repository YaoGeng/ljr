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
 *      取代），recheck 以 publish_status 为锚点兜底一切竞态，无成对 cancelJob 调用点。
 *
 * 回查/执行分工（评审修复 Important-2，控制者 R12）：
 *   recheck=isPublicationPending（只看 publish_status）：false → CANCELLED（被并发推进=已生效/
 *   废弃/行消失，「被取代」语义，CANCELLED 正确）；
 *   execute=markEffective：生效窗口（DB 时钟）在其内判定——已到 → 守卫迁移 EFFECTIVE（DONE）；
 *   未到（双钟漂移/伪造提前到期）→ 不迁移，DONE+outcome:'window_not_due' 经 I2 writeLog 序列化
 *   进 schedule_job_log.detail（H4/运维可查询），与「被取代=CANCELLED 静默」明确区分；W2+ 周期
 *   兜底扫描接管卡 PUBLISHED 的规则（控制者记账）。
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
        return this.rules.isPublicationPending(uow, job.refId);
      },
      execute: async ({ job, uow }) => {
        if (job.refId === null) return { rule_id: 0, transitioned: false };
        const r = await this.rules.markEffective(uow, job.refId);
        // outcome 进 detail（DONE 路径 I2 writeLog 序列化）：window_not_due=窗口未到痕迹
        return { rule_id: r.ruleId, transitioned: r.transitioned, outcome: r.outcome };
      },
    });
  }
}
