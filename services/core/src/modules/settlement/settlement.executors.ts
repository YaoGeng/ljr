/**
 * SETTLE_HOLD_RELEASE 执行器装配（I2 §4 目录在册：producer=F3（进 HOLD）、executor=F3
 * （24h 到期→READY）、回查锚点=settlements.hold 状态与工单；FIRM_REVERIFY 同款形态）。
 *
 * 非「周期自投」job：job 进 HOLD 时按冻结期锚注册一次；到期执行=释放+结算同占抢事务
 * （F-2 round2 评审修复：releaseDueHoldInTx/runSettlementByIdInTx 承接 uow——FIRM_REVERIFY
 * 的 suspendOverdueInTx 同款范式）：结算抛错（如 split 通道故障）随抢占事务整体回滚到 HOLD、
 * job 退避重试，无 READY 滞留面（释放独立提交会令重试 recheck 见 READY 判 superseded→
 * job CANCELLED→READY 行无驱动滞留——复审实测证伪位，已修）。
 * ⚠/pay/split 外部指令先行提交：抢占回滚后重试经 F1 同键幂等重放不双扣（service InTx 注记）。
 * 被工单挡住（OPEN_TICKETS）/冻结期未满 → job DONE 无操作，后续释放归 TicketResolved 消费链。
 * 回查（R-02）：业务先行（已释放/挂起/终态）→ false → CANCELLED 无操作。
 */
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ScheduleExecutorRegistry } from '../schedule/scheduler-executor.registry';
import { SettlementService } from './settlement.service';

@Injectable()
export class SettlementJobExecutors implements OnModuleInit {
  constructor(
    private readonly registry: ScheduleExecutorRegistry,
    private readonly settlements: SettlementService,
  ) {}

  onModuleInit(): void {
    this.registry.register({
      jobType: 'SETTLE_HOLD_RELEASE',
      recheck: async ({ job, uow }) => {
        // 回查锚点（I2 §4）：行仍 HOLD 才需要处置（已释放/挂起/终态=业务先行 → CANCELLED）
        const res = await uow.query<{ ok: boolean }>(
          `SELECT (status = 'HOLD') AS ok FROM settlement.settlements WHERE id = $1`,
          [job.refId],
        );
        return res.rows[0]?.ok === true;
      },
      execute: async ({ job, uow }) => {
        if (job.refId === null) return { skipped: true }; // SETTLE_HOLD_RELEASE 注册恒带 refId（防御位）
        // F-2 round2：业务效果做进抢占事务（uow 承接）——释放+结算原子，失败整体回滚自 HOLD 重试
        const rel = await this.settlements.releaseDueHoldInTx(uow, job.refId, 'HOLD_EXPIRED');
        if (!rel.released) {
          // 工单未闭（OPEN_TICKETS）/冻结期未满：job DONE 无操作，释放归 TicketResolved 消费链
          return { released: false, blocked: rel.blocked ?? null };
        }
        const run = await this.settlements.runSettlementByIdInTx(uow, job.refId);
        return { released: true, settled: run.settled, suspended: run.suspended ?? false };
      },
    });
  }
}
