/**
 * A3b 保证金冻结服务（§5 POST /firms/{id}/deposit/freeze + R-04 + Task 3 简报）。
 *
 * R-04 资金红线：保证金专户在持牌机构侧，平台仅「指令 + 台账」不自收——本服务经 F1 通道原语
 * freeze 下发指令（ChannelRouter 主→备，故障切换/降级出箱同 F1 先例），lawyer_deposits 台账
 * 与指令同事务（claim INSERT → 通道应答 → 守卫 ISSUED→FROZEN，entity_type='lawyer_deposit'；
 * 台账行无 DELETE）。通道失败（含 INSUFFICIENT 业务应答）随事务回滚不烧键。
 *
 * 幂等口径（§5「幂等键=firm+batch」）：确定性复合键 deposit:firm:{firm_id}:batch:{batch_no}
 * （batch=调用方批次引用，客户端提供；UNIQUE 为 DB 真兜底）——同键同载荷幂等重放（返回首访
 * 台账行），同键异载荷 409 E_DUP_KEY（F1 台账同口径；失败尝试随事务回滚不烧键，demo/F1 先例）。
 *
 * ⚠W3-D4 金额配置化（简报「台账先行」）：amount 缺省取 LJR_PAYMENT_DEPOSIT_AMOUNT
 * （firm-merchant.config；⚠04§8-4 保证金金额=待澄清点，生产缺失 E_CONFIG_MISSING fail-fast）。
 *
 * firm 上下文：表无 firm_id 列（§3 模型逐字）——firm_id 必载入 detail（V22 ck 固化），幂等键
 * 内嵌 firm 保证跨 firm 同 batch 号互不冲突。
 */
import { Inject, Injectable } from '@nestjs/common';
import {
  AppError,
  ErrorCode,
  CHANNEL_DEGRADED_TOPIC,
  type ChannelDegradedPayload,
  type Money,
} from '@ljr/shared';
import type { SqlExecutor } from '../../infrastructure/sql';
import { PgPoolService } from '../../infrastructure/sql';
import { OutboxService } from '../../infrastructure/outbox/outbox.service';
import { StateTransitionGuardService } from '../../infrastructure/state-machine/state-transition-guard.service';
import { ChannelFaultError, ChannelRouter } from './payment.channels';
import { FIRM_MERCHANT_CONFIG, type FirmMerchantConfig } from './firm-merchant.config';
import { LAWYER_DEPOSIT_MACHINE } from './firm-merchant.machine';
import {
  assertMoney,
  assertPositiveInt,
  centsToMoney,
  dbNumericToCents,
  moneyToCents,
} from './payment.types';

interface DepositRow {
  readonly id: string;
  readonly lawyer_id: string;
  readonly channel: string;
  readonly escrow_amount: string;
  readonly status: string;
  readonly batch_no: string;
  readonly detail: DepositDetail | null;
  readonly created_at: Date;
}

/** 指令上下文（⑨口径：firm_id 必载/lawyer_id/batch/channel_txn_no——对账核对锚点） */
interface DepositDetail {
  readonly firm_id?: number;
  readonly lawyer_id?: number;
  readonly batch?: string;
  readonly channel_txn_no?: string;
}

const DEPOSIT_COLS = `id, lawyer_id, channel, escrow_amount::text AS escrow_amount, status,
  batch_no, detail, created_at`;

const BATCH_RE = /^[A-Za-z0-9._:-]{1,64}$/;

export interface DepositFreezeInput {
  readonly firm_id: number;
  readonly lawyer_id: number;
  readonly batch: string;
  readonly amount?: Money;
}

/** 出参（§5 契约 {escrow_status} 逐字 + 定位上下文） */
export interface DepositFreezeView {
  readonly escrow_status: string;
  readonly deposit_id: number;
  readonly firm_id: number;
  readonly lawyer_id: number;
  readonly batch: string;
  readonly amount: Money;
  readonly channel: string;
  readonly channel_txn_no: string | null;
  readonly created_at: string;
}

@Injectable()
export class DepositService {
  constructor(
    private readonly pool: PgPoolService,
    private readonly outbox: OutboxService,
    private readonly guard: StateTransitionGuardService,
    private readonly router: ChannelRouter,
    // Symbol token（纯 interface 无运行时类型）：module useFactory 装配，测试构造直传
    @Inject(FIRM_MERCHANT_CONFIG) private readonly config: FirmMerchantConfig,
  ) {}

  async freeze(input: DepositFreezeInput): Promise<DepositFreezeView> {
    const firmId = assertPositiveInt(input.firm_id, 'firm_id');
    const lawyerId = assertPositiveInt(input.lawyer_id, 'lawyer_id');
    if (typeof input.batch !== 'string' || !BATCH_RE.test(input.batch)) {
      throw new AppError(
        ErrorCode.InvalidArgument,
        `batch 须为 1-64 位 [A-Za-z0-9._:-] 字符：${typeof input.batch === 'string' ? `长度 ${input.batch.length}` : JSON.stringify(typeof input.batch)}`,
      );
    }
    // 金额：入参缺省取配置（⚠W3-D4 台账先行）；形态/越界校验在此收口（Money 字符串禁 float）
    const amount = input.amount ?? this.config.depositAmount;
    moneyToCents(assertMoney(amount));
    const idempotencyKey = `deposit:firm:${firmId}:batch:${input.batch}`;

    // 幂等快路径：在册键直接按载荷比对（重放/409），不开事务（F1 台账先例）
    const existing = await this.findByIdempotencyKey(idempotencyKey);
    if (existing) return this.replayOr(existing, firmId, lawyerId, amount);

    return this.pool.withTransaction(async (uow) => {
      // claim：唯一约束真兜底（并发同键第二笔在此败退转重放比对）
      const claim = await uow.query<DepositRow>(
        `INSERT INTO payment.lawyer_deposits
           (lawyer_id, channel, escrow_amount, status, batch_no, idempotency_key, detail)
         VALUES ($1, $2, $3::numeric, 'ISSUED', $4, $5, $6::jsonb)
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING ${DEPOSIT_COLS}`,
        [
          lawyerId,
          this.configPrimaryChannel(),
          amount,
          input.batch,
          idempotencyKey,
          JSON.stringify({
            firm_id: firmId,
            lawyer_id: lawyerId,
            batch: input.batch,
          } satisfies DepositDetail),
        ],
      );
      if (claim.rows.length === 0) {
        // 冲突分支（并发同键）：读回比对——同键同载荷重放 / 异载荷 409（I-1 修复口径同 F1）
        const prev = await this.findByIdempotencyKeyInTx(uow, idempotencyKey);
        if (!prev) throw new AppError(ErrorCode.InternalError, '幂等台账不可读（不应触达）');
        return this.replayOr(prev, firmId, lawyerId, amount);
      }
      const ledger = claim.rows[0]!;

      // 通道指令（§4.4 持牌机构专户冻结；INSUFFICIENT=资金来源不足业务应答 → 400，不切换）
      let out;
      try {
        out = await this.router.execute((a) => a.freeze({ orderId: null, amount, idempotencyKey }));
      } catch (e) {
        if (e instanceof ChannelFaultError && e.kind === 'INSUFFICIENT') {
          throw new AppError(
            ErrorCode.InsufficientFunds,
            `保证金冻结资金来源不足：firm=${firmId} lawyer=${lawyerId} amount=${amount}`,
          );
        }
        throw e; // CHANNEL_ERROR 已翻降级并试备用；双通道故障 E_CHANNEL_UNAVAILABLE（claim 随事务回滚）
      }
      if (out.degradedNow && out.degradedChannel !== null) {
        await this.outbox.recordOutbox(uow, {
          type: CHANNEL_DEGRADED_TOPIC,
          payload: { channel: out.degradedChannel } satisfies ChannelDegradedPayload,
        });
      }

      // 台账落定：ISSUED→FROZEN（守卫+留痕）+ 实际通道/流水号回填（channel_txn_no 入 detail，
      // §3 模型无流水号列——V20 split_ledgers detail 承载先例）
      await this.guard.assertTransition(LAWYER_DEPOSIT_MACHINE, {
        entityId: Number(ledger.id),
        from: 'ISSUED',
        to: 'FROZEN',
        reason: 'channel_confirmed',
        uow,
      });
      const updated = await uow.query<DepositRow>(
        `UPDATE payment.lawyer_deposits
           SET status = 'FROZEN', channel = $2,
               detail = jsonb_set(COALESCE(detail, '{}'::jsonb), '{channel_txn_no}', to_jsonb($3::text))
         WHERE id = $1 AND status = 'ISSUED' RETURNING ${DEPOSIT_COLS}`,
        [ledger.id, out.adapter.channel, out.result.channelTxnNo],
      );
      if (updated.rows.length === 0) {
        throw new AppError(ErrorCode.StateStaleEntity, `保证金台账 ${ledger.id} 已被并发推进`);
      }
      return toView(updated.rows[0]!);
    });
  }

  // ===========================================================================
  // 内部件
  // ===========================================================================

  private configPrimaryChannel(): string {
    // 指令初落通道=主通道（实际通道由通道应答回填——主备切换后 channel=实际承接方）
    return 'wechat_ecom';
  }

  private toReplayView(row: DepositRow): DepositFreezeView {
    return toView(row);
  }

  /** 重放判定：同键同载荷=返回首访台账行；异载荷=409 E_DUP_KEY（金额按分整化比对，禁 float） */
  private replayOr(
    row: DepositRow,
    firmId: number,
    lawyerId: number,
    amount: Money,
  ): DepositFreezeView {
    const storedCents = dbNumericToCents(row.escrow_amount);
    const same =
      Number(row.lawyer_id) === lawyerId &&
      (row.detail?.firm_id ?? Number.NaN) === firmId &&
      storedCents === moneyToCents(amount);
    if (!same) {
      throw new AppError(
        ErrorCode.PaymentDuplicateKey,
        `幂等键已绑定其他载荷（firm+batch 同键须同载荷重放）：batch=${row.batch_no}`,
      );
    }
    return this.toReplayView(row);
  }

  private async findByIdempotencyKey(key: string): Promise<DepositRow | null> {
    const res = await this.pool.query<DepositRow>(
      `SELECT ${DEPOSIT_COLS} FROM payment.lawyer_deposits WHERE idempotency_key = $1`,
      [key],
    );
    return res.rows[0] ?? null;
  }

  private async findByIdempotencyKeyInTx(
    uow: SqlExecutor,
    key: string,
  ): Promise<DepositRow | null> {
    const res = await uow.query<DepositRow>(
      `SELECT ${DEPOSIT_COLS} FROM payment.lawyer_deposits WHERE idempotency_key = $1`,
      [key],
    );
    return res.rows[0] ?? null;
  }
}

function toView(row: DepositRow): DepositFreezeView {
  return {
    escrow_status: row.status,
    deposit_id: Number(row.id),
    firm_id: row.detail?.firm_id ?? 0,
    lawyer_id: Number(row.lawyer_id),
    batch: row.batch_no,
    amount: centsToMoney(dbNumericToCents(row.escrow_amount)),
    channel: row.channel,
    channel_txn_no: row.detail?.channel_txn_no ?? null,
    created_at: new Date(row.created_at).toISOString(),
  };
}
