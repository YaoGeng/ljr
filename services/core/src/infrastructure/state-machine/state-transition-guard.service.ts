/**
 * 状态迁移守卫服务（M0-4）：machine.assertTransition（纯校验，锁定接口）+ state_transition_log 留痕的组合入口。
 *
 * 语义（架构 §4.1）：
 *   - 合法迁移：经 uow（业务事务）写 allowed=true 留痕 —— 与业务写同事务，业务回滚则留痕一并消失；
 *   - 非法迁移：先用独立连接写 allowed=false 留痕（拒绝审计不随业务回滚消失），再抛 AppError。
 *
 * 典型调用（demo 模块示例见 modules/demo/demo-order.service.ts）：
 *   BEGIN;
 *   SELECT ... FOR UPDATE;                          -- 行锁读当前状态
 *   guard.assertTransition(machine, { entityId, from, to, uow });
 *   UPDATE ... WHERE status = from RETURNING *;     -- 条件更新兜底乐观并发
 *   recordOutbox(uow, evt);                         -- 事件同事务
 *   COMMIT;
 */
import { Injectable } from '@nestjs/common';
import type { SqlExecutor } from '../sql';
import { PgPoolService } from '../sql';
import type { StateMachine } from './state-machine';
import { StateTransitionLogService } from './state-transition-log.service';

export interface TransitionAttempt<S extends string> {
  readonly entityId: number;
  readonly from: S;
  readonly to: S;
  readonly reason?: string;
  readonly jobId?: string;
  /** 业务事务 client（放行留痕同事务）；缺省用独立连接 */
  readonly uow?: SqlExecutor;
}

@Injectable()
export class StateTransitionGuardService {
  constructor(
    private readonly logService: StateTransitionLogService,
    private readonly pool: PgPoolService,
  ) {}

  async assertTransition<S extends string>(
    machine: StateMachine<S>,
    attempt: TransitionAttempt<S>,
  ): Promise<void> {
    const { entityId, from, to, reason, jobId, uow } = attempt;
    const base = {
      entityType: machine.def.entityType,
      entityId,
      fromStatus: from,
      toStatus: to,
      reason,
      jobId,
    };

    if (machine.canTransition(from, to)) {
      await this.logService.write(uow ?? this.pool, { ...base, allowed: true });
      return;
    }
    // 拒绝留痕走独立连接：业务事务随后回滚也不丢拒绝审计（架构 §4.4「非法迁移被守卫拒绝并告警」）
    await this.logService.write(this.pool, { ...base, allowed: false });
    machine.assertTransition(from, to); // 抛 AppError(StateIllegalTransition)
  }
}
