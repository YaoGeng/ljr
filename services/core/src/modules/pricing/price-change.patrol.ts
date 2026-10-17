/**
 * C6 改价补偿巡检检测件（H4 巡检第⑤类的 pricing 侧候选集；M1-W4 Task 1）。owner=pricing
 * （pricing-histories 同 owner schema）；补偿授予核对经 benefits 域 F4 导出面
 * （PointsService.hasTxnOfKindRef）由 ops 侧 PatrolService 应用层聚合——禁跨 schema join。
 *
 * 架构 §7.2 ⑤：补偿应发未发 >24h。C6 口径（price-change.service 头注）：补偿仅
 * 「在团（has_active_group）且 DOWN 生效路径」——approve/直效提交后同步直发 F4 grant
 * （幂等 ref=price_change:{id}）；巡检位=EFFECTED DOWN 在团历史行对照积分流水（C6 头注
 * 「EFFECTED DOWN 历史行对照 points_txns 对账」原文承载，T9-③ 挂账收口）。
 *
 * 窗口锚=生效时刻 created_at（直效/approve 同事务落行）；REJECTED/PENDING 不欠补偿、
 * REVOKED 行补偿已发不追回（撤销回滚语义=04 §8 待澄清，patrol 不重复裁决）。
 *
 * ⚠边界注记（报告记录待澄清）：「应发」的事实源=生效时点的补偿对象快照，未持久化——
 * 生效时点在团但补偿对象为空（无已支付报名/整除取整为 0）的行零发放合法，本检测会假阳
 * （人工核对即可 dismissal；若噪音成为问题=M2 COMPENSATION_DISPATCH job 真接线时随补偿
 * 台账一起收口，届时「应发」有持久事实源）。
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

  /** EFFECTED DOWN 在团 × 生效超窗的候选集（新在前）；只读检测不写业务表 */
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
      `SELECT id, lawyer_id, direction, has_active_group, created_at
         FROM pricing.pricing_histories
        WHERE result = 'EFFECTED' AND direction = 'DOWN' AND has_active_group
          AND created_at < now() - ($1::bigint * interval '1 millisecond')
        ORDER BY id DESC
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
