/**
 * SETTLE_HOLD_RELEASE 执行器装配（I2 §4 目录在册：producer=F3（进 HOLD）、executor=F3
 * （24h 到期→READY）、回查锚点=settlements.hold 状态与工单；FIRM_REVERIFY 同款形态）。
 *
 * 非「周期自投」job：job 进 HOLD 时按冻结期锚注册一次；到期执行=释放（DB 钟+工单闸复判）
 * → 重驱动分账（READY→SETTLED，R-01 唯一解冻节点）。被工单挡住（OPEN_TICKETS）→ job DONE
 * （无操作），后续释放由 TicketResolved 消费链承担。回查（R-02）：业务先行（已释放/挂起/终态）
 * → false → CANCELLED 无操作。
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
      execute: async ({ job }) => {
        if (job.refId === null) return { skipped: true }; // SETTLE_HOLD_RELEASE 注册恒带 refId（防御位）
        const rel = await this.settlements.releaseDueHold(job.refId, 'HOLD_EXPIRED');
        if (!rel.released) {
          // 工单未闭（OPEN_TICKETS）/冻结期被并发调整：job DONE 无操作，释放归 TicketResolved 消费链
          return { released: false, blocked: rel.blocked ?? null };
        }
        const run = await this.settlements.runSettlementById(job.refId);
        return { released: true, settled: run.settled, suspended: run.suspended ?? false };
      },
    });
  }
}
