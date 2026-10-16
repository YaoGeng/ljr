/**
 * F1 T+1 对账（§2/§4/R-04；⚠W3-10 调度面后置：本批仅 service + admin REST 手动触发，
 * T+1 定时挂 I2 属 M2 真通道批——I2 22 种 job 目录无对账 job，不扩目录）。
 *
 * 双向核对（§4「与 payment_orders/split_ledgers 双向核对」）按通道进行（statementOf 直连
 * 指定适配器，不经 failover——必须用指令实际发生通道的账单）：
 *   - PAY 行 ↔ payment_orders（按 channel_txn_no；本地候选=paid_at（Asia/Shanghai 日切）∈ 期）；
 *   - REFUND/SPLIT/DEDUCT 行 ↔ split_ledgers（按 detail.channel_txn_no；本地候选=period ∈ 期
 *     且 status='CONFIRMED'——ISSUED 未确认行属巡检第 4 类（指令发出渠道未确认），不入对账面）；
 *   - 三态差异（§6 ReconciliationDiffItem）：CHANNEL_ONLY（账单有行本地无）、LOCAL_ONLY
 *     （本地有账单缺）、AMOUNT_MISMATCH（双边同单金额不一致）。
 *
 * 差异行落 split_ledgers：direction=DIFF + status=DIFF + diff_reason（ck_split_ledgers_diff_shape
 * 固化形态）+ 确定性幂等键 recon:{period}:{channel}:{txn}:{kind}（UNIQUE 真兜底——对账重跑不重复
 * 落行）；ReconciliationDiffFound 仅对新插入差异行同事务出箱（已记录差异不再重复触发工单——
 * 24h SLA 工单面=H3（M2），本批断言到事件出箱为止）。
 *
 * 资金红线（R-01）：对账只读账单+本地台账比对，零资金动作；差异处置（追补/退款/挂起）为
 * H3/F2 域，不在本层。
 */
import { Inject, Injectable } from '@nestjs/common';
import {
  AppError,
  ErrorCode,
  RECONCILIATION_DIFF_FOUND_TOPIC,
  type ReconciliationDiffFoundPayload,
  type ReconciliationDiffItem,
} from '@ljr/shared';
import type { SqlExecutor } from '../../infrastructure/sql';
import { PgPoolService } from '../../infrastructure/sql';
import { OutboxService } from '../../infrastructure/outbox/outbox.service';
import { dbNumericToCents, moneyToCents, centsToMoney } from './payment.types';
import {
  PAYMENT_CHANNEL_ADAPTERS,
  type PaymentChannelAdapter,
  type PaymentChannelName,
  type StatementLine,
} from './payment.channels';

const PERIOD_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 与账单核对的指令行方向（PAY 行走 payment_orders，其余走 split_ledgers） */
const LEDGER_DIRECTIONS = ['REFUND', 'SPLIT', 'DEDUCT'] as const;
type LedgerDirection = (typeof LEDGER_DIRECTIONS)[number];

export interface ReconcileInput {
  /** 对账期（ISO date YYYY-MM-DD；本地侧按 Asia/Shanghai 日切比对） */
  readonly period: string;
  /** 缺省=双通道全集（adapters 顺序）；元素值域校验在本层（未知通道 → 404） */
  readonly channels?: readonly string[];
}

export interface ReconcileChannelResult {
  readonly channel: PaymentChannelName;
  readonly statement_lines: number;
  /** 与本地记录双边对平的账单行数 */
  readonly matched: number;
  readonly diffs: readonly ReconciliationDiffItem[];
}

export interface ReconcileResult {
  readonly period: string;
  readonly per_channel: readonly ReconcileChannelResult[];
}

interface DiffCandidate {
  readonly channel_txn_no: string | null;
  readonly kind: ReconciliationDiffItem['kind'];
  readonly amount: string;
  readonly expect?: string;
  readonly actual?: string;
}

interface LocalRef {
  readonly txn: string | null;
  readonly amount: string;
}

@Injectable()
export class PaymentReconcileService {
  constructor(
    private readonly pool: PgPoolService,
    private readonly outbox: OutboxService,
    // Symbol token（通道适配器数组；module useFactory 装配，测试构造直传）
    @Inject(PAYMENT_CHANNEL_ADAPTERS) private readonly adapters: readonly PaymentChannelAdapter[],
  ) {}

  /** 对账入口（admin REST POST /admin/payment/reconcile {period}；channels 缺省双通道） */
  async reconcile(input: ReconcileInput): Promise<ReconcileResult> {
    if (!PERIOD_RE.test(input.period)) {
      throw new AppError(ErrorCode.InvalidArgument, `对账期须为 YYYY-MM-DD：${String(input.period)}`);
    }
    const requested: readonly string[] = input.channels ?? this.adapters.map((a) => a.channel);
    if (requested.length === 0) {
      throw new AppError(ErrorCode.InvalidArgument, '对账通道集为空');
    }
    const targets = requested.map((ch) => {
      if (ch !== 'wechat_ecom' && ch !== 'alipay') {
        throw new AppError(ErrorCode.NotFound, `未知支付通道：${ch}`);
      }
      return ch as PaymentChannelName;
    });

    return this.pool.withTransaction(async (uow) => {
      const perChannel: ReconcileChannelResult[] = [];
      const newDiffs: ReconciliationDiffItem[] = [];

      for (const channel of targets) {
        const adapter = this.adapters.find((a) => a.channel === channel);
        if (!adapter) {
          throw new AppError(ErrorCode.NotFound, `未知支付通道：${channel}`);
        }
        const lines = await adapter.statement(input.period);
        const { matched, candidates } = await this.reconcileChannel(uow, channel, input.period, lines);
        const diffs: ReconciliationDiffItem[] = [];
        for (const c of candidates) {
          const item: ReconciliationDiffItem = {
            channel,
            channel_txn_no: c.channel_txn_no,
            kind: c.kind,
            amount: c.amount,
            reason: diffReason(c),
          };
          const inserted = await this.insertDiffRow(uow, input.period, channel, c);
          if (inserted) {
            // 仅新差异行进事件（重跑幂等：已记录差异不重复触发工单）
            diffs.push(item);
            newDiffs.push(item);
          }
        }
        perChannel.push({ channel, statement_lines: lines.length, matched, diffs });
      }

      if (newDiffs.length > 0) {
        await this.outbox.recordOutbox(uow, {
          type: RECONCILIATION_DIFF_FOUND_TOPIC,
          payload: {
            period: input.period,
            detail: newDiffs,
          } satisfies ReconciliationDiffFoundPayload,
        });
      }
      return { period: input.period, per_channel: perChannel };
    });
  }

  // ---------- 单通道双向核对 ----------

  private async reconcileChannel(
    uow: SqlExecutor,
    channel: PaymentChannelName,
    period: string,
    lines: readonly StatementLine[],
  ): Promise<{ matched: number; candidates: DiffCandidate[] }> {
    const candidates: DiffCandidate[] = [];
    let matched = 0;

    // ---- PAY 行 ↔ payment_orders ----
    const payLines = lines.filter((l) => l.direction === 'PAY');
    const localOrders = await uow.query<{ channel_txn_no: string | null; total: string }>(
      `SELECT channel_txn_no, total::text AS total FROM payment.payment_orders
        WHERE channel = $1 AND channel_txn_no IS NOT NULL
          AND (paid_at AT TIME ZONE 'Asia/Shanghai')::date = $2::date`,
      [channel, period],
    );
    const payByTxn = new Map<string, LocalRef>(
      localOrders.rows.map((o) => [o.channel_txn_no as string, { txn: o.channel_txn_no, amount: o.total }]),
    );
    const seenPayTxns = new Set<string>();
    for (const line of payLines) {
      const local = payByTxn.get(line.channelTxnNo);
      if (!local) {
        candidates.push({
          channel_txn_no: line.channelTxnNo,
          kind: 'CHANNEL_ONLY',
          amount: line.amount,
          actual: line.amount,
        });
        continue;
      }
      seenPayTxns.add(line.channelTxnNo);
      matched += 1;
      if (dbNumericToCents(local.amount) !== moneyToCents(line.amount)) {
        candidates.push({
          channel_txn_no: line.channelTxnNo,
          kind: 'AMOUNT_MISMATCH',
          amount: line.amount,
          expect: local.amount,
          actual: line.amount,
        });
      }
    }
    for (const o of localOrders.rows) {
      if (!seenPayTxns.has(o.channel_txn_no as string)) {
        candidates.push({
          channel_txn_no: o.channel_txn_no,
          kind: 'LOCAL_ONLY',
          amount: o.total,
          expect: o.total,
        });
      }
    }

    // ---- REFUND/SPLIT/DEDUCT 行 ↔ split_ledgers（CONFIRMED 行） ----
    for (const dir of LEDGER_DIRECTIONS) {
      const dirLines = lines.filter((l) => l.direction === dir);
      if (dirLines.length === 0) continue;
      const localLedgers = await uow.query<{ txn: string | null; amount: string }>(
        `SELECT detail ->> 'channel_txn_no' AS txn, amount::text AS amount
           FROM payment.split_ledgers
          WHERE channel = $1 AND direction = $2 AND period = $3::date AND status = 'CONFIRMED'`,
        [channel, dir, period],
      );
      const byTxn = new Map<string, LocalRef>();
      const nullTxn: LocalRef[] = [];
      for (const row of localLedgers.rows) {
        if (row.txn === null) nullTxn.push({ txn: null, amount: row.amount });
        else byTxn.set(row.txn, { txn: row.txn, amount: row.amount });
      }
      const seen = new Set<string>();
      for (const line of dirLines) {
        const local = byTxn.get(line.channelTxnNo);
        if (!local) {
          candidates.push({
            channel_txn_no: line.channelTxnNo,
            kind: 'CHANNEL_ONLY',
            amount: line.amount,
            actual: line.amount,
          });
          continue;
        }
        seen.add(line.channelTxnNo);
        matched += 1;
        if (dbNumericToCents(local.amount) !== moneyToCents(line.amount)) {
          candidates.push({
            channel_txn_no: line.channelTxnNo,
            kind: 'AMOUNT_MISMATCH',
            amount: line.amount,
            expect: local.amount,
            actual: line.amount,
          });
        }
      }
      for (const row of localLedgers.rows) {
        if (row.txn !== null && !seen.has(row.txn)) {
          candidates.push({
            channel_txn_no: row.txn,
            kind: 'LOCAL_ONLY',
            amount: row.amount,
            expect: row.amount,
          });
        }
      }
      // 本地 CONFIRMED 行却无通道流水号：指令落定缺锚点——LOCAL_ONLY（txn=null）显性化不静默
      for (const row of nullTxn) {
        candidates.push({ channel_txn_no: null, kind: 'LOCAL_ONLY', amount: row.amount, expect: row.amount });
      }
    }

    return { matched, candidates };
  }

  /** 差异行落库：recon:{period}:{channel}:{txn}:{kind} 确定性键防重跑重复；返回是否新插入 */
  private async insertDiffRow(
    uow: SqlExecutor,
    period: string,
    channel: PaymentChannelName,
    c: DiffCandidate,
  ): Promise<boolean> {
    const txnPart = c.channel_txn_no ?? 'null-txn';
    const key = `recon:${period}:${channel}:${txnPart}:${c.kind}`.slice(0, 128);
    const res = await uow.query<{ id: string }>(
      `INSERT INTO payment.split_ledgers
         (period, channel, direction, amount, status, idempotency_key, detail, diff_reason)
       VALUES ($1::date, $2, 'DIFF', $3::numeric, 'DIFF', $4, $5::jsonb, $6)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING id`,
      [
        period,
        channel,
        centsToMoney(moneyToCents(c.amount)),
        key,
        JSON.stringify({
          kind: c.kind,
          channel_txn_no: c.channel_txn_no,
          expect: c.expect ?? null,
          actual: c.actual ?? null,
        }),
        diffReason(c),
      ],
    );
    return res.rows.length > 0;
  }
}

function diffReason(c: DiffCandidate): string {
  const txn = c.channel_txn_no ?? '(无通道流水号)';
  switch (c.kind) {
    case 'CHANNEL_ONLY':
      return `对账差异[CHANNEL_ONLY]：通道账单有行、本地无对应记录（txn=${txn} amount=${c.amount}）`;
    case 'LOCAL_ONLY':
      return `对账差异[LOCAL_ONLY]：本地有记录、通道账单缺行（txn=${txn} amount=${c.amount}）`;
    case 'AMOUNT_MISMATCH':
      return `对账差异[AMOUNT_MISMATCH]：双边金额不一致（txn=${txn} 本地=${c.expect ?? '?'} 账单=${c.actual ?? '?'}）`;
  }
}
