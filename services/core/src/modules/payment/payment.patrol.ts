/**
 * F1 指令台账资损巡检检测件（H4 巡检第④类；M1-W4 Task 1）。owner=payment（split-ledgers
 * 同 owner schema），只读检测不写业务表。
 *
 * 架构 §7.2 ④：分账指令发出但渠道未确认。V20 头注⑦已为此落两态：status ISSUED|CONFIRMED
 * （§7 巡检第 4 类要求两态可分）。窗口 ⚠架构未定 → 默认 24h（patrol.config 注记）。
 *
 * mock 通道语义注记（W4 许可桩清单增量）：mock 同步确认——指令行恒当场 CONFIRMED，dev 无
 * 自然 ISSUED 窗（仅崩溃注入可见）；M2 真实异步通道换装时复核窗口语义（可能收窄），本批
 * 不强造假阴用例。
 * 谓词以 now()（DB 钟）计算；DIFF 行 status='DIFF' 天然不命中（对账差异行另属 F1 对账面）。
 */
import { Injectable } from '@nestjs/common';
import { PgPoolService } from '../../infrastructure/sql';

/** ④违例行（一指令一 finding） */
export interface UnconfirmedSplitRow {
  readonly ledgerId: number;
  readonly period: string;
  readonly channel: string;
  readonly direction: string;
  /** 指令金额（Money 字符串展示位） */
  readonly amount: string;
  readonly idempotencyKey: string | null;
  readonly createdAt: string;
}

@Injectable()
export class PaymentPatrolService {
  constructor(private readonly pool: PgPoolService) {}

  /** ISSUED 超窗未确认指令集（新在前） */
  async findUnconfirmedSplits(options: {
    readonly windowMs: number;
    readonly limit?: number;
  }): Promise<readonly UnconfirmedSplitRow[]> {
    const limit = options.limit ?? 200;
    const rows = await this.pool.query<{
      id: string;
      period: Date;
      channel: string;
      direction: string;
      amount: string;
      idempotency_key: string | null;
      created_at: Date;
    }>(
      `SELECT id, period, channel, direction, amount::text AS amount, idempotency_key, created_at
         FROM payment.split_ledgers
        WHERE status = 'ISSUED'
          AND created_at < now() - ($1::bigint * interval '1 millisecond')
        ORDER BY id DESC
        LIMIT $2`,
      [options.windowMs, limit],
    );
    return rows.rows.map((r) => ({
      ledgerId: Number(r.id),
      period: new Date(r.period).toISOString().slice(0, 10),
      channel: r.channel,
      direction: r.direction,
      amount: r.amount,
      idempotencyKey: r.idempotency_key,
      createdAt: new Date(r.created_at).toISOString(),
    }));
  }
}
