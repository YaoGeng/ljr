/**
 * C3 报名域资损巡检检测件（H4 巡检第①类的 trade 侧候选集；M1-W4 Task 1）。
 *
 * 架构 §7.2 ①：已支付但场次终态且未发起退款 >10min。检测 SQL 各域自持（本文件 owner=trade，
 * trade-enrollments ⋈ 同域 trade-sessions / trade-group-buys 域内 join 合法）；在途/已完成
 * 退款核对经 payment 域导出面（F1 findOrderByIdempotencyKey + F2 listByOrderId）由 ops 侧
 * PatrolService 应用层聚合——禁跨 schema join（check-schema-refs 0 为门）。
 *
 * 终态口径（⚠裁决，报告注明）：「场次终态」取**退款应发起**语义集，非 B2 锁释放终态集
 * （trade 侧 SESSION/GROUP_BUY_TERMINAL_STATUSES 含 FINISHED/SETTLED/CONVERTED——服务已
 * 交付/分账已解冻/已转化，退款不应发起，纳入即假阳）：
 *   session  → FAILED（流标，F2 批量退款链即时承接）| CANCELLED（词汇 M2 接线，预防性纳入）
 *   groupbuy → EXPIRED（流标扫场退款）| REJECTED（律师拒绝退款）
 *   排除：REFUNDED（机内已退）、CONVERTED（转化不退款）、FINISHED/SETTLED（已交付）。
 *
 * 窗口锚=实体终态迁移时刻 status_since（V23/V24 头注③列，STL 同源时钟），非 created_at——
 * 简报 Review Focus② 口径；谓词以 now()（DB 钟）计算（A3b R-03 双钟教训）。
 * enrollments 与 F1 支付单的关联沿既定幂等键 enroll/e{id}/pay（V26 头注：关联不落列）。
 */
import { Injectable } from '@nestjs/common';
import { PgPoolService } from '../../infrastructure/sql';

/** ①候选行（ops 侧逐单核对退款后裁决入账） */
export interface RefundDueCandidate {
  readonly enrollmentId: number;
  readonly refType: 'session' | 'groupbuy';
  readonly refId: number;
  readonly userId: number;
  /** 应付全额（Money 字符串，巡检只读展示位，不参与运算） */
  readonly paidAmount: string;
  readonly entityStatus: string;
  readonly terminalSince: string;
}

@Injectable()
export class EnrollmentPatrolService {
  constructor(private readonly pool: PgPoolService) {}

  /**
   * PAID 报名 × 关联实体退款应发起终态 × 终态迁移超窗的候选集（新在前）。
   * 两半 UNION 各自域内 join（session/groupbuy 两表 id 序列独立，按 ref_type 分流防串行）。
   * 只读检测：不写任何业务表（巡检只报因不修因）。
   */
  async findRefundDueCandidates(options: {
    readonly windowMs: number;
    readonly limit?: number;
  }): Promise<readonly RefundDueCandidate[]> {
    const limit = options.limit ?? 200;
    const rows = await this.pool.query<{
      id: string;
      ref_type: 'session' | 'groupbuy';
      ref_id: string;
      user_id: string;
      paid_amount: string;
      entity_status: string;
      status_since: Date;
    }>(
      `SELECT e.id, e.ref_type, e.ref_id, e.user_id, e.paid_amount::text AS paid_amount,
              s.status AS entity_status, s.status_since
         FROM trade.enrollments e
         JOIN trade.sessions s ON s.id = e.ref_id
        WHERE e.ref_type = 'session' AND e.pay_status = 'PAID'
          AND s.status IN ('FAILED', 'CANCELLED')
          AND s.status_since < now() - ($1::bigint * interval '1 millisecond')
        UNION ALL
       SELECT e.id, e.ref_type, e.ref_id, e.user_id, e.paid_amount::text AS paid_amount,
              g.status AS entity_status, g.status_since
         FROM trade.enrollments e
         JOIN trade.group_buys g ON g.id = e.ref_id
        WHERE e.ref_type = 'groupbuy' AND e.pay_status = 'PAID'
          AND g.status IN ('EXPIRED', 'REJECTED')
          AND g.status_since < now() - ($1::bigint * interval '1 millisecond')
        ORDER BY id DESC
        LIMIT $2`,
      [options.windowMs, limit],
    );
    return rows.rows.map((r) => ({
      enrollmentId: Number(r.id),
      refType: r.ref_type,
      refId: Number(r.ref_id),
      userId: Number(r.user_id),
      paidAmount: r.paid_amount,
      entityStatus: r.entity_status,
      terminalSince: new Date(r.status_since).toISOString(),
    }));
  }
}
