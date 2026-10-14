/**
 * schedule_jobs 状态机（I2 §3 status：PENDING|RUNNING|DONE|CANCELLED|FAILED）。
 *
 * 「状态字段禁裸写」（架构 §1.3/§4.1）：五条边全部经 infrastructure/state-machine 守卫迁移并落
 * state_transition_log（entity_type='schedule_job'）。边与代码路径一一对应：
 *   PENDING→RUNNING   tick 抢占（回查通过后）
 *   RUNNING→DONE      执行成功（与执行器业务效果、log、ScheduleJobFired 同事务）
 *   PENDING→CANCELLED 业务作废（CANCEL_JOB）或回查判定过期（recheck=false）
 *   PENDING→FAILED    重试退避耗尽（§4：3 次后 FAILED+告警）或类型未注册（NO_EXECUTOR）
 *   FAILED→PENDING    运维经 log 重放（同 job_id 重新入队，幂等回查兜底安全）
 * RUNNING 为事务内瞬态：抢占/执行同事务，进程崩溃整体回滚回 PENDING（misfile 自愈），无悬挂 RUNNING。
 */
import { createStateMachine } from '../../infrastructure/state-machine/state-machine';
import type { ScheduleJobStatus } from './scheduler.types';

export const SCHEDULE_JOB_MACHINE = createStateMachine<ScheduleJobStatus>({
  entityType: 'schedule_job',
  states: ['PENDING', 'RUNNING', 'DONE', 'CANCELLED', 'FAILED'],
  transitions: [
    { from: 'PENDING', to: 'RUNNING' },
    { from: 'RUNNING', to: 'DONE' },
    { from: 'PENDING', to: 'CANCELLED' },
    { from: 'PENDING', to: 'FAILED' },
    { from: 'FAILED', to: 'PENDING' },
  ],
});
