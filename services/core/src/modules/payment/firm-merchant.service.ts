/**
 * A3b 律所进件服务（§4/§5/§7 + Task 3 简报裁决）——进件子域应用服务导出面（PaymentModule
 * exports 唯一入口，形态沿 F1 可剥离纪律）：F3=T8 经 assertSplittable 消费 R-01 分账前置；
 * T10 H1 经 getMerchant 消费状态视图。状态字段全部经 StateTransitionGuardService 守卫
 * （entity_type='firm_merchant'，拒绝留痕走独立连接不随业务回滚）。
 *
 * 通道面（Task 3 简报「机构 API 经 F1 通道抽象」）：进件按商户行 channel 定点适配器
 * （PAYMENT_CHANNEL_ADAPTERS 按 channel 选址）——进件不做主备切换（切换是支付指令的路由语义，
 * 在 alipay 上进件不能因 wechat 故障改道）；指令面（保证金冻结）才经 ChannelRouter 主→备。
 *
 * 生效口径（→ACTIVE 三入边同语义）：IN_REVIEW→ACTIVE（首次生效）、CHANGING→ACTIVE（变更完成）、
 * SUSPENDED→ACTIVE（复验恢复）均刷新 verified_at/reverify_due + 注册 FIRM_REVERIFY 一年后 job
 * （同事务，type+ref 幂等在册去重）+ FirmMerchantActivated 出箱——「生效」是 R-01 可分账唯一信号。
 *
 * R-W3-C2 裁决落位：change 进入 CHANGING 即分账暂停语义——同事务出箱
 * FirmMerchantSuspended(reason=ACCOUNT_CHANGING)；assertSplittable 对 CHANGING 与 SUSPENDED
 * 同拒（均非 ACTIVE）。
 *
 * LawyerAuditPassed 消费口径（A3a 真事件，Task 3 简报）：建 SUBMITTING 行启动进件；幂等=
 * UNIQUE(firm_id,channel)（重投短路，credit.consumer at-least-once 先例）；firm_id 显式 null=
 * 记日志跳过不崩溃（A1 consumer 先例口径）；载荷缺 lawyer_user_id=抛错进重试轨道（不静默丢弃）。
 * 「触发机构提交」裁量为不调机构：事件载荷无 materials（A3a 契约只有 lawyer_user_id/firm_id），
 * 空材料向机构提交违背 §2「材料收集→机构提交」次序——SUBMITTING 行开放后由 POST submit 补齐
 * 材料、触发机构提交（SUBMITTING 行再提交=材料补齐路径，非 409；其余状态再提交=409 E_DUPLICATE）。
 * 报告偏差节同口径记录。
 *
 * PII 红线（§9）：materials（对公账户/开户许可）不落日志不进事件载荷——日志只落 keys 数/
 * 字节数摘要（本文件 logMaterialsSafe 唯一出入口）；错误信息不内嵌材料值。
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  AppError,
  ErrorCode,
  FIRM_MERCHANT_ACTIVATED_TOPIC,
  FIRM_MERCHANT_REVERIFIED_DUE_TOPIC,
  FIRM_MERCHANT_SUSPENDED_TOPIC,
  type FirmMerchantActivatedPayload,
  type FirmMerchantReverifiedDuePayload,
  type FirmMerchantSuspendedPayload,
} from '@ljr/shared';
import type { SqlExecutor } from '../../infrastructure/sql';
import { PgPoolService } from '../../infrastructure/sql';
import { OutboxService } from '../../infrastructure/outbox/outbox.service';
import { StateTransitionGuardService } from '../../infrastructure/state-machine/state-transition-guard.service';
import { SchedulerService } from '../schedule/scheduler.service';
import {
  PAYMENT_CHANNEL_ADAPTERS,
  type MerchantReviewResult,
  type PaymentChannelAdapter,
  type PaymentChannelName,
} from './payment.channels';
import { FIRM_MERCHANT_CONFIG, type FirmMerchantConfig } from './firm-merchant.config';
import { FIRM_MERCHANT_MACHINE, type FirmMerchantStatus } from './firm-merchant.machine';
import {
  assertChannel,
  assertMaterials,
  type FirmMerchantView,
  type MerchantOnboardingStartResult,
  type ReverifyOverdueOutcome,
} from './firm-merchant.types';
import { assertPositiveInt } from './payment.types';

interface MerchantRow {
  readonly id: string;
  readonly firm_id: string;
  readonly channel: string;
  readonly sub_mchid: string | null;
  readonly status: string;
  readonly verified_at: Date | null;
  readonly reverify_due: Date | null;
  readonly created_at: Date;
}

/** materials 摘要（PII 红线：日志唯一允许的 materials 形态——只有键数与字节数） */
interface MaterialsSummary {
  readonly keys: number;
  readonly bytes: number;
}

const MERCHANT_COLS = `id, firm_id, channel, sub_mchid, status, verified_at, reverify_due, created_at`;

function toView(row: MerchantRow): FirmMerchantView {
  return {
    id: Number(row.id),
    firm_id: Number(row.firm_id),
    channel: row.channel,
    sub_mchid: row.sub_mchid,
    status: row.status as FirmMerchantStatus,
    verified_at: row.verified_at === null ? null : new Date(row.verified_at).toISOString(),
    reverify_due: row.reverify_due === null ? null : new Date(row.reverify_due).toISOString(),
    created_at: new Date(row.created_at).toISOString(),
  };
}

function summarizeMaterials(materials: Readonly<Record<string, unknown>>): MaterialsSummary {
  return {
    keys: Object.keys(materials).length,
    bytes: Buffer.byteLength(JSON.stringify(materials), 'utf8'),
  };
}

@Injectable()
export class FirmMerchantService {
  private readonly logger = new Logger(FirmMerchantService.name);

  constructor(
    private readonly pool: PgPoolService,
    private readonly outbox: OutboxService,
    private readonly guard: StateTransitionGuardService,
    private readonly scheduler: SchedulerService,
    // Symbol token（readonly PaymentChannelAdapter[] 无运行时类型，DI 元数据按 Array 解析）：
    // module providers 装配，测试 override 注入自己的 mock 实例（merchantReview 钩子可达）
    @Inject(PAYMENT_CHANNEL_ADAPTERS) private readonly adapters: readonly PaymentChannelAdapter[],
    // Symbol token（纯 interface 无运行时类型）：module useFactory 装配，测试构造直传
    @Inject(FIRM_MERCHANT_CONFIG) private readonly config: FirmMerchantConfig,
  ) {}

  // ===========================================================================
  // 进件提交（§5 POST /firms/{id}/merchant/submit：幂等键=firm+channel，409 DUPLICATE）
  // ===========================================================================

  async submit(input: {
    readonly firm_id: number;
    readonly channel: string;
    readonly materials: Readonly<Record<string, unknown>>;
  }): Promise<FirmMerchantView> {
    const firmId = assertPositiveInt(input.firm_id, 'firm_id');
    const channel = assertChannel(input.channel);
    const materials = assertMaterials(input.materials);
    this.logMaterialsSafe('律所进件提交', firmId, channel, materials);

    return this.pool.withTransaction(async (uow) => {
      let row = await this.lockByFirmChannel(uow, firmId, channel);
      if (row && row.status !== 'SUBMITTING') {
        // 幂等键=firm+channel：已在审/生效/变更/暂停/停用 → 409（SUBMITTING=补材料放行，类注）
        throw new AppError(
          ErrorCode.MerchantDuplicate,
          `律所进件重复提交：firm=${firmId} channel=${channel} 已处于 ${row.status}（幂等键=firm+channel）`,
        );
      }
      if (!row) {
        // claim：UNIQUE(firm_id, channel) 真兜底（并发同键第二笔读回走补材料路径）
        const claim = await uow.query<MerchantRow>(
          `INSERT INTO payment.firm_merchants (firm_id, channel, status, materials)
           VALUES ($1, $2, 'SUBMITTING', $3::jsonb)
           ON CONFLICT (firm_id, channel) DO NOTHING
           RETURNING ${MERCHANT_COLS}`,
          [firmId, channel, JSON.stringify(materials)],
        );
        row =
          claim.rows[0] ??
          (await this.lockByFirmChannel(uow, firmId, channel)) ??
          (() => {
            throw new AppError(ErrorCode.InternalError, '进件行插入后不可读（不应触达）');
          })();
        if (row.status !== 'SUBMITTING') {
          throw new AppError(
            ErrorCode.MerchantDuplicate,
            `并发进件已先行：firm=${firmId} channel=${channel}`,
          );
        }
      } else {
        // SUBMITTING 行材料补齐（LawyerAuditPassed 启动的开放行；SUBMITTING→IN_REVIEW 前落定）
        await uow.query(`UPDATE payment.firm_merchants SET materials = $2::jsonb WHERE id = $1`, [
          row.id,
          JSON.stringify(materials),
        ]);
      }

      // SUBMITTING→IN_REVIEW：机构受理（守卫+留痕）
      const inReview = await this.transitionRow(uow, row, 'IN_REVIEW', 'channel_submit');
      // 机构提交（通道原语；mock 同步审核——真实通道 M2 异步应答经 refreshFromChannel 推进）
      const res = await this.adapterFor(channel).submitMerchant({ firmId, materials });
      if (res.review === 'APPROVED') {
        const active = await this.transitionRow(uow, inReview, 'ACTIVE', 'channel_approved');
        return this.refreshReverifyAnchor(uow, active, res.subMchid);
      }
      return toView(inReview);
    });
  }

  // ===========================================================================
  // 账户变更（§5 POST /firms/{id}/merchant/change；R-02 + R-W3-C2）
  // ===========================================================================

  async change(input: {
    readonly firm_id: number;
    readonly channel?: string;
    readonly materials: Readonly<Record<string, unknown>>;
  }): Promise<FirmMerchantView> {
    const firmId = assertPositiveInt(input.firm_id, 'firm_id');
    const channel = assertChannel(input.channel ?? 'wechat_ecom');
    const materials = assertMaterials(input.materials);
    this.logMaterialsSafe('律所账户变更', firmId, channel, materials);

    return this.pool.withTransaction(async (uow) => {
      const row = await this.requireByFirmChannel(uow, firmId, channel);
      // ACTIVE→CHANGING（守卫拒其余源态：SUBMITTING/IN_REVIEW 未生效无可变更；SUSPENDED/STOPPED
      // 须先复验/重新进件——拒绝留痕走独立连接不随事务回滚）
      const changing = await this.transitionRow(uow, row, 'CHANGING', 'account_change');
      await uow.query(`UPDATE payment.firm_merchants SET materials = $2::jsonb WHERE id = $1`, [
        row.id,
        JSON.stringify(materials),
      ]);
      // R-W3-C2：变更期=分账暂停语义——CHANGING 进入即发 Suspended（F3 查询态 CHANGING 与
      // SUSPENDED 同拒；事件使 F3 暂停+挂起待结算可见，A3b §8）
      await this.outbox.recordOutbox(uow, {
        type: FIRM_MERCHANT_SUSPENDED_TOPIC,
        payload: {
          firm_id: firmId,
          channel,
          reason: 'ACCOUNT_CHANGING',
        } satisfies FirmMerchantSuspendedPayload,
      });
      // 材料透传机构（重新进件）；变更完成=机构审核通过经 refreshFromChannel 推进
      //（§5 出参恒 {status: CHANGING}——同步应答不在此消费，mock 经 merchantReview 钩子驱动）
      await this.adapterFor(channel).submitMerchant({ firmId, materials });
      return toView(changing);
    });
  }

  // ===========================================================================
  // 年度复验（R-03；复验完成路径=POST /firms/{id}/merchant/reverify → SUSPENDED→ACTIVE）
  // ===========================================================================

  async reverify(input: {
    readonly firm_id: number;
    readonly channel?: string;
  }): Promise<FirmMerchantView> {
    const firmId = assertPositiveInt(input.firm_id, 'firm_id');
    const channel = assertChannel(input.channel ?? 'wechat_ecom');
    return this.pool.withTransaction(async (uow) => {
      const row = await this.requireByFirmChannel(uow, firmId, channel);
      // SUSPENDED→ACTIVE（§4「复验/变更完成」；ACTIVE/CHANGING 复验被守卫拒=无复验义务）
      const reactivated = await this.transitionRow(uow, row, 'ACTIVE', 'reverify_completed');
      return this.refreshReverifyAnchor(uow, reactivated, null);
    });
  }

  // ===========================================================================
  // 机构回调→状态机推进（适配器异步应答驱动；IN_REVIEW/CHANGING→ACTIVE）
  // ===========================================================================

  /** 查询机构审核状态并推进：APPROVED → →ACTIVE（生效口径）；PENDING/其余态幂等返回现状 */
  async refreshFromChannel(input: {
    readonly firm_id: number;
    readonly channel?: string;
  }): Promise<FirmMerchantView> {
    const firmId = assertPositiveInt(input.firm_id, 'firm_id');
    const channel = assertChannel(input.channel ?? 'wechat_ecom');
    return this.pool.withTransaction(async (uow) => {
      const row = await this.requireByFirmChannel(uow, firmId, channel);
      if (row.status !== 'IN_REVIEW' && row.status !== 'CHANGING') {
        return toView(row); // 非在审态幂等无操作（不出事件不留痕）
      }
      const review: MerchantReviewResult =
        await this.adapterFor(channel).queryMerchantStatus(firmId);
      if (review !== 'APPROVED') return toView(row);
      const reason = row.status === 'CHANGING' ? 'change_completed' : 'channel_approved';
      // sub_mchid 缺位时补拉（mock 确定性可重取；真实通道 M2 审核回调载荷自带 mchid——适配点）
      const subMchid =
        row.sub_mchid ??
        (await this.adapterFor(channel).submitMerchant({ firmId, materials: {} })).subMchid;
      const activated = await this.transitionRow(uow, row, 'ACTIVE', reason);
      return this.refreshReverifyAnchor(uow, activated, subMchid);
    });
  }

  // ===========================================================================
  // R-01 分账前置查询面（F3=T8 消费；§10「非 ACTIVE 分账拒绝」的本模块承载）
  // ===========================================================================

  /**
   * 断言律所在指定通道可作为分账接收方（R-01：仅 ACTIVE）。CHANGING（R-W3-C2 变更期暂停
   * 语义）与 SUSPENDED 同拒；未进件同拒（F3 拿到统一 409 E_MERCHANT_NOT_ACTIVE）。
   */
  async assertSplittable(firmId: number, channel: string): Promise<void> {
    const status = await this.statusOf(firmId, channel);
    if (status !== 'ACTIVE') {
      throw new AppError(
        ErrorCode.MerchantNotActive,
        `R-01 分账前置不满足：firm=${firmId} channel=${channel} status=${status ?? '未进件'}（仅 ACTIVE 可作分账接收方；CHANGING 变更期同拒）`,
      );
    }
  }

  /** 商户状态视图（H1/T10 数据源；未进件返回 null 不抛） */
  async getMerchant(firmId: number, channel: string): Promise<FirmMerchantView | null> {
    const res = await this.pool.query<MerchantRow>(
      `SELECT ${MERCHANT_COLS} FROM payment.firm_merchants WHERE firm_id = $1 AND channel = $2`,
      [assertPositiveInt(firmId, 'firm_id'), assertChannel(channel)],
    );
    return res.rows[0] ? toView(res.rows[0]) : null;
  }

  // ===========================================================================
  // LawyerAuditPassed 消费启动位（§6；幂等=UNIQUE(firm_id, channel) 短路）
  // ===========================================================================

  /**
   * 进件流程启动：建 SUBMITTING 行（materials 空对象占位——事件载荷无材料，见类注「触发机构
   * 提交」裁量）。行已在（重投/已在件）→ started=false 幂等短路，不抛（at-least-once 语义内）。
   * 不触发机构提交、不出事件——材料齐备的 POST submit 才是机构提交与生效的入口。
   */
  async startOnboarding(input: {
    readonly firm_id: number;
    readonly channel?: string;
  }): Promise<MerchantOnboardingStartResult> {
    const firmId = assertPositiveInt(input.firm_id, 'firm_id');
    const channel = assertChannel(input.channel ?? 'wechat_ecom');
    return this.pool.withTransaction(async (uow) => {
      const claim = await uow.query<MerchantRow>(
        `INSERT INTO payment.firm_merchants (firm_id, channel, status, materials)
         VALUES ($1, $2, 'SUBMITTING', '{}'::jsonb)
         ON CONFLICT (firm_id, channel) DO NOTHING
         RETURNING ${MERCHANT_COLS}`,
        [firmId, channel],
      );
      if (claim.rows.length === 0) return { started: false }; // 幂等短路（事件重投/已在件）
      this.logger.log(
        `律所进件流程启动：firm_id=${firmId} channel=${channel} status=SUBMITTING（待 POST submit 补齐材料触发机构提交）`,
      );
      return { started: true };
    });
  }

  // ===========================================================================
  // R-03 复验到期处置（FIRM_REVERIFY 执行器业务效果；executor 在 firm-merchant.executors）
  // ===========================================================================

  /**
   * 到期未复验 → SUSPENDED（ACTIVE→SUSPENDED，reason=reverify_overdue）+ 成对出箱
   * Suspended(REVERIFY_OVERDUE)/ReverifiedDue（I1 通知律所复验、F3 暂停分账——§8「SUSPENDED
   * 期间 F3 待结算挂起可见」）。非 ACTIVE/未到期 → null（回查兜底，executor recheck 双保险）。
   */
  async suspendOverdueInTx(
    uow: SqlExecutor,
    merchantId: number,
  ): Promise<ReverifyOverdueOutcome | null> {
    const res = await uow.query<MerchantRow>(
      `SELECT ${MERCHANT_COLS} FROM payment.firm_merchants WHERE id = $1 FOR UPDATE`,
      [assertPositiveInt(merchantId, 'merchant_id')],
    );
    const row = res.rows[0];
    if (!row || row.status !== 'ACTIVE' || row.reverify_due === null) return null;
    if (new Date(row.reverify_due).getTime() > Date.now()) return null; // 未到期（应用钟兜底；recheck 走 DB 钟）

    await this.guard.assertTransition(FIRM_MERCHANT_MACHINE, {
      entityId: Number(row.id),
      from: 'ACTIVE',
      to: 'SUSPENDED',
      reason: 'reverify_overdue',
      uow,
    });
    const updated = await uow.query<MerchantRow>(
      `UPDATE payment.firm_merchants SET status = 'SUSPENDED'
        WHERE id = $1 AND status = 'ACTIVE' RETURNING ${MERCHANT_COLS}`,
      [row.id],
    );
    if (updated.rows.length === 0) {
      throw new AppError(ErrorCode.StateStaleEntity, `律所商户 ${merchantId} 已被并发迁移`);
    }
    const dueAt = new Date(updated.rows[0]!.reverify_due!).toISOString();
    const channel = updated.rows[0]!.channel;
    await this.outbox.recordOutbox(uow, {
      type: FIRM_MERCHANT_SUSPENDED_TOPIC,
      payload: {
        firm_id: Number(updated.rows[0]!.firm_id),
        channel,
        reason: 'REVERIFY_OVERDUE',
      } satisfies FirmMerchantSuspendedPayload,
    });
    await this.outbox.recordOutbox(uow, {
      type: FIRM_MERCHANT_REVERIFIED_DUE_TOPIC,
      payload: {
        firm_id: Number(updated.rows[0]!.firm_id),
        due_at: dueAt,
      } satisfies FirmMerchantReverifiedDuePayload,
    });
    return { firm_id: Number(updated.rows[0]!.firm_id), channel, due_at: dueAt };
  }

  // ===========================================================================
  // 内部件
  // ===========================================================================

  private adapterFor(channel: PaymentChannelName): PaymentChannelAdapter {
    const adapter = this.adapters.find((a) => a.channel === channel);
    if (!adapter) {
      throw new AppError(ErrorCode.NotFound, `未知支付通道：${channel}`);
    }
    return adapter;
  }

  private async lockByFirmChannel(
    uow: SqlExecutor,
    firmId: number,
    channel: string,
  ): Promise<MerchantRow | null> {
    const res = await uow.query<MerchantRow>(
      `SELECT ${MERCHANT_COLS} FROM payment.firm_merchants
        WHERE firm_id = $1 AND channel = $2 FOR UPDATE`,
      [firmId, channel],
    );
    return res.rows[0] ?? null;
  }

  private async requireByFirmChannel(
    uow: SqlExecutor,
    firmId: number,
    channel: string,
  ): Promise<MerchantRow> {
    const row = await this.lockByFirmChannel(uow, firmId, channel);
    if (!row)
      throw new AppError(ErrorCode.NotFound, `律所商户不存在：firm=${firmId} channel=${channel}`);
    return row;
  }

  private async statusOf(firmId: number, channel: string): Promise<string | null> {
    const res = await this.pool.query<{ status: string }>(
      `SELECT status FROM payment.firm_merchants WHERE firm_id = $1 AND channel = $2`,
      [firmId, channel],
    );
    return res.rows[0]?.status ?? null;
  }

  /** 守卫迁移 + 条件更新兜底乐观并发（F1 transition 同形；合法迁移留痕与业务同事务） */
  private async transitionRow(
    uow: SqlExecutor,
    row: MerchantRow,
    to: FirmMerchantStatus,
    reason: string,
  ): Promise<MerchantRow> {
    const from = row.status as FirmMerchantStatus;
    await this.guard.assertTransition(FIRM_MERCHANT_MACHINE, {
      entityId: Number(row.id),
      from,
      to,
      reason,
      uow,
    });
    const updated = await uow.query<MerchantRow>(
      `UPDATE payment.firm_merchants SET status = $3 WHERE id = $1 AND status = $2 RETURNING ${MERCHANT_COLS}`,
      [row.id, from, to],
    );
    if (updated.rows.length === 0) {
      throw new AppError(ErrorCode.StateStaleEntity, `律所商户 ${row.id} 已被并发迁移`);
    }
    return updated.rows[0]!;
  }

  /**
   * 生效收口（→ACTIVE 三入边共用）：刷新 verified_at=now()、reverify_due=now()+复验期（DB 钟，
   * 测试 SQL interval 时间旅行同锚）、sub_mchid（null=保留现值）；同事务注册一年后 FIRM_REVERIFY
   * job（type+ref 在册去重）+ FirmMerchantActivated 出箱。
   */
  private async refreshReverifyAnchor(
    uow: SqlExecutor,
    active: MerchantRow,
    subMchid: string | null,
  ): Promise<FirmMerchantView> {
    const updated = await uow.query<MerchantRow>(
      `UPDATE payment.firm_merchants
         SET verified_at = now(),
             reverify_due = now() + ($3::bigint * interval '1 day'),
             sub_mchid = COALESCE($2, sub_mchid)
       WHERE id = $1 AND status = 'ACTIVE' RETURNING ${MERCHANT_COLS}`,
      [active.id, subMchid, this.config.reverifyDays],
    );
    if (updated.rows.length === 0) {
      throw new AppError(ErrorCode.StateStaleEntity, `律所商户 ${active.id} 非 ACTIVE（不应触达）`);
    }
    const row = updated.rows[0]!;
    const dueAt = new Date(row.reverify_due!);
    await this.scheduler.registerJob(uow, {
      jobType: 'FIRM_REVERIFY',
      refType: 'firm_merchant',
      refId: Number(row.id),
      dueAt,
    });
    await this.outbox.recordOutbox(uow, {
      type: FIRM_MERCHANT_ACTIVATED_TOPIC,
      payload: {
        firm_id: Number(row.firm_id),
        channel: row.channel,
      } satisfies FirmMerchantActivatedPayload,
    });
    return toView(row);
  }

  /** 进件/变更的材料摘要日志（PII 红线唯一出入口：只落 keys 数/字节数，内容永不落盘） */
  private logMaterialsSafe(
    event: string,
    firmId: number,
    channel: string,
    materials: Readonly<Record<string, unknown>>,
  ): void {
    const s = summarizeMaterials(materials);
    this.logger.log(
      `${event}：firm_id=${firmId} channel=${channel} materials_keys=${s.keys} materials_bytes=${s.bytes}（内容不落日志——PII 红线）`,
    );
  }
}
