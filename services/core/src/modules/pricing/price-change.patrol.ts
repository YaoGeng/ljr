/**
 * C6 改价补偿巡检检测件（H4 巡检第⑤类的 pricing 侧候选集；M1-W4 Task 1 → M2-W2 T6
 * #39 收口改版）。owner=pricing（pricing_histories/comp_snapshots 同 owner schema，域内
 * join 合法）；补偿授予核对经 benefits 域 F4 导出面（PointsService.hasTxnOfKindRef）由
 * ops 侧 PatrolService 应用层聚合——禁跨 schema join。
 *
 * 架构 §7.2 ⑤：补偿应发未发 >24h。C6 口径（price-change.service）：补偿仅「在团
 * （has_active_group）且 DOWN 生效路径」——approve 生效事务内 grant 直发（幂等 ref=
 * price_change:{id}）+ comp_snapshots 快照同事务落位（#39 收口，M2-W2 T6）。
 *
 * #39 收口后的候选判定（对照 V44 comp_snapshots，任务简报口径）：
 *   - 有快照行 granted=false（>24h）＝真未发 → 候选（同事务化后正常不可见，保留判定位
 *     为 COMPENSATION_DISPATCH 异步路径（目录在册不装配）与回归 Bug 的检出锚）；
 *   - granted=true ＝已发 → 非候选；
 *   - **快照零行 ＝ 无补偿对象（零已支付/全取整为 0 的合法行）→ 非候选**——原「以
 *     pricing_histories 行推算应发」形态对零发放合法行必假阳（CRITICAL 噪音），V44 快照
 *     落位即收口（04 §8 #39 处置口径「⑤类已知假阳形态 dismissal」随之退役）。
 *
 * 窗口锚=生效时刻 created_at（直效/approve 同事务落行）；REJECTED/PENDING 不欠补偿、
 * REVOKED 行补偿已发不追回（撤销回滚语义=04 §8 待澄清，patrol 不重复裁决）。
 */
import { Injectable } from '@nestjs/common';
import { PgPoolService } from '../../infrastructure/sql';

/** ⑤候选行（ops 侧核对 F4 授予流水后裁决入账） */
export interface UnpaidCompensationCandidate {
  readonly historyId: number;
  readonly lawyerId: number;
  readonly direction: string;
  readonly hasActiveGroup: boolean;
  readonly createdAt: string;
}

@Injectable()
export class PriceChangePatrolService {
  constructor(private readonly pool: PgPoolService) {}

  /**
   * EFFECTED DOWN 在团 × 生效超窗 × 存在 granted=false 快照行 的候选集（新在前）；
   * 只读检测不写业务表。快照零行/全 granted=true → 非候选（#39 假阳收口）。
   */
  async findUnpaidCompensationCandidates(options: {
    readonly windowMs: number;
    readonly limit?: number;
  }): Promise<readonly UnpaidCompensationCandidate[]> {
    const limit = options.limit ?? 200;
    const rows = await this.pool.query<{
      id: string;
      lawyer_id: string;
      direction: string;
      has_active_group: boolean;
      created_at: Date;
    }>(
      `SELECT h.id, h.lawyer_id, h.direction, h.has_active_group, h.created_at
         FROM pricing.pricing_histories h
        WHERE h.result = 'EFFECTED' AND h.direction = 'DOWN' AND h.has_active_group
          AND h.created_at < now() - ($1::bigint * interval '1 millisecond')
          AND EXISTS (
                SELECT 1 FROM pricing.comp_snapshots cs
                 WHERE cs.price_change_id = h.id AND cs.granted = false)
        ORDER BY h.id DESC
        LIMIT $2`,
      [options.windowMs, limit],
    );
    return rows.rows.map((r) => ({
      historyId: Number(r.id),
      lawyerId: Number(r.lawyer_id),
      direction: r.direction,
      hasActiveGroup: r.has_active_group,
      createdAt: new Date(r.created_at).toISOString(),
    }));
  }
}
