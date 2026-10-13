/**
 * 横切基座模块（M0-4）：PG 连接池 / Outbox 写入端 / Outbox relay / 状态机守卫与留痕。
 * 各业务模块（M1 起）按需 import；relay 的 start() 由进程入口 main.ts 显式调用。
 */
import { Module } from '@nestjs/common';
import { OutboxService } from './outbox/outbox.service';
import { OutboxRelayService } from './outbox/outbox-relay.service';
import { PgPoolService } from './sql';
import { StateTransitionGuardService } from './state-machine/state-transition-guard.service';
import { StateTransitionLogService } from './state-machine/state-transition-log.service';

@Module({
  providers: [
    PgPoolService,
    OutboxService,
    // relay 构造子是 Pool|PgPoolService 联合类型（测试可注入裸 Pool），DI 元数据无法表达联合——
    // 走工厂显式注入 PgPoolService，选项走默认（env 可配 interval）。
    {
      provide: OutboxRelayService,
      useFactory: (pool: PgPoolService) => new OutboxRelayService(pool),
      inject: [PgPoolService],
    },
    StateTransitionLogService,
    StateTransitionGuardService,
  ],
  exports: [
    PgPoolService,
    OutboxService,
    OutboxRelayService,
    StateTransitionLogService,
    StateTransitionGuardService,
  ],
})
export class InfrastructureModule {}
