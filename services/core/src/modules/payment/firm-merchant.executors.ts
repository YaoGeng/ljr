/**
 * FIRM_REVERIFY 执行器装配（I2 §4 目录在册：producer=A3b（进件生效时）、executor=A3b（年度
 * 复验）、回查锚点=firm_merchants.reverify_due；POINTS_EXPIRE/SLOT_REAPER 先例形态）。
 *
 * 与 POINTS_EXPIRE 的形态差异（Task 3 简报「job 自投/注册形态照先例」的裁量边界，报告同口径）：
 * FIRM_REVERIFY 不是周期兜底 job——job 按商户在进件生效时注册一年后锚（reverify_due 落表），
 * 无「自投下一期」：下一次注册由复验恢复/变更完成/变更生效的 →ACTIVE 收口承担（同事务）。
 * 首个 job 引导=首次进件生效，进程入口无引导动作（main.ts 不接线，与 POINTS_EXPIRE 的差异位）。
 *
 * 回查（R-02）：recheck 比对业务当前状态——商户非 ACTIVE（已变更/暂停/停用，复验义务消失）
 * 或未到期 → false（CANCELLED 无操作）；execute 幂等由服务层 suspendOverdueInTx 的状态/到期
 * 双重兜底承担（at-least-once：crash 后重跑对已 SUSPENDED 行 no-op）。
 */
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ScheduleExecutorRegistry } from '../schedule/scheduler-executor.registry';
import { FirmMerchantService } from './firm-merchant.service';

@Injectable()
export class FirmMerchantJobExecutors implements OnModuleInit {
  constructor(
    private readonly registry: ScheduleExecutorRegistry,
    private readonly merchants: FirmMerchantService,
  ) {}

  onModuleInit(): void {
    this.registry.register({
      jobType: 'FIRM_REVERIFY',
      recheck: async ({ job, uow }) => {
        // DB 钟回查：仅「ACTIVE 且已到期」需要处置（到期未复验 → SUSPENDED，R-03）
        const res = await uow.query<{ due: boolean }>(
          `SELECT (status = 'ACTIVE' AND reverify_due IS NOT NULL AND reverify_due <= now()) AS due
             FROM payment.firm_merchants WHERE id = $1`,
          [job.refId],
        );
        return res.rows[0]?.due === true;
      },
      execute: async ({ job, uow }) => {
        if (job.refId === null) return { skipped: true }; // FIRM_REVERIFY 注册恒带 refId（防御位）
        const out = await this.merchants.suspendOverdueInTx(uow, job.refId);
        if (!out) return { skipped: true }; // 回查与执行间隙被并发推进（幂等兜底，job 仍 DONE）
        return { firm_id: out.firm_id, channel: out.channel, due_at: out.due_at };
      },
    });
  }
}
