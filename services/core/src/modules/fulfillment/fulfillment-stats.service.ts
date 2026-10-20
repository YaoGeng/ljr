/**
 * C1 stats 的 fulfillment 侧聚合导出面（M2-W3 T3；A.4「fulfillment→trade stats」行——
 * attendances/one_on_one_orders 聚合读接口，禁跨 schema join 架构 §3.2）。
 *
 * 平级装配裁定（PricingChangeModule/BenefitsConsumersModule 先例）：FulfillmentModule 已
 * imports TradeModule（C1 快照导出面），TradeModule 反向 imports FulfillmentModule 即模块环；
 * 故本面独立成 FulfillmentStatsModule（仅依赖 InfrastructureModule）由 TradeModule 平级引入
 * ——文件级无环（本文件不 import 任何 trade 侧件），挂载序见 trade.module.ts。
 *
 * 口径（02 §7.2 指标-事件源映射；窗口锚=调用方传入的场次 id 清单——C1 stats 的
 * slot_start∈[from,to) 上海日界窗，D3 attendanceStats 同款分工）：
 *   attendance_rate（到场率）＝(NORMAL+LATE)÷已判定行——H4「到场率（normal+late÷判定数）」
 *     逐字（C1 §5「口径=H4」），统计域=这些场次的房间上全部已判定成员行（律师+用户双角色，
 *     H4 平台口径同源）；samples=0 → null（C1 stats 空窗语义=缺数据 null，非 0）。
 *   ooo_rate（1对1转化率）＝one_on_one_orders ÷ 参与房间用户数——02 §7.2「one_on_one_orders
 *     ÷ 参与房间用户数」逐字；分子=这些场次的房间上全部 1对1 订单行（下单即转化，不筛订单
 *     状态——取消/退款仍是已发生的转化行为）；分母=这些房间上实际进入过的去重用户数
 *     （attendances role='user' AND first_join_at IS NOT NULL——1对1 订单只能自房间内发起，
 *     进过房间者=真转化基盘；PAID 未进场者不计入）；participants=0 → null。
 * 入参 sessionIds 由 trade 侧窄面 sessionIdsOfLawyerBetween 产出（trade 域场次归属事实源）。
 */
import { Injectable, Module } from '@nestjs/common';
import { InfrastructureModule } from '../../infrastructure/infrastructure.module';
import { PgPoolService } from '../../infrastructure/sql';

/** 4 位小数四舍五入（比率展示口径；比率非金额，不受 Money 禁 float 约束——session/attendance 同款） */
function rate4(numerator: number, denominator: number): number {
  return Math.round((numerator / denominator) * 10_000) / 10_000;
}

@Injectable()
export class FulfillmentStatsService {
  constructor(private readonly pool: PgPoolService) {}

  /**
   * 到场率（H4 口径）：窗内场次房间上 (NORMAL+LATE)÷已判定行（双角色）；零判定 → null。
   * 只读本域（rooms/attendances），空清单 → null（零房间零判定同收敛）。
   */
  async attendanceRateOfSessions(sessionIds: readonly number[]): Promise<number | null> {
    if (sessionIds.length === 0) return null;
    const res = await this.pool.query<{ samples: number; attended: number }>(
      `SELECT count(*)::int AS samples,
              count(*) FILTER (WHERE a.status IN ('NORMAL', 'LATE'))::int AS attended
         FROM fulfillment.attendances a
        WHERE a.adjudicated_at IS NOT NULL
          AND a.room_id IN (SELECT id FROM fulfillment.rooms WHERE session_id = ANY($1::bigint[]))`,
      [sessionIds as number[]],
    );
    const row = res.rows[0]!;
    return row.samples === 0 ? null : rate4(row.attended, row.samples);
  }

  /**
   * 1对1转化率（02 §7.2 口径，分子对齐 H4 one_on_one_conversion_rate 的已支付语义——
   * C1 模块文档「口径=H4」；排除 CREATED 弃单防真支付期（M5）抬高律师侧转化率，T3 评审 I-1）：
   * 窗内场次房间上（非 CREATED）订单数÷进房去重用户数；零参与 → null。只读本域
   * （rooms/one_on_one_orders/attendances）。
   */
  async oooConversionRateOfSessions(sessionIds: readonly number[]): Promise<number | null> {
    if (sessionIds.length === 0) return null;
    const res = await this.pool.query<{ orders: number; participants: number }>(
      `SELECT (SELECT count(*)::int FROM fulfillment.one_on_one_orders o
                 WHERE o.status <> 'CREATED'
                   AND o.room_id IN (SELECT id FROM fulfillment.rooms WHERE session_id = ANY($1::bigint[])))
                    AS orders,
              (SELECT count(DISTINCT a.user_id)::int FROM fulfillment.attendances a
                 WHERE a.role = 'user' AND a.first_join_at IS NOT NULL
                   AND a.room_id IN (SELECT id FROM fulfillment.rooms WHERE session_id = ANY($1::bigint[])))
                    AS participants`,
      [sessionIds as number[]],
    );
    const row = res.rows[0]!;
    return row.participants === 0 ? null : rate4(row.orders, row.participants);
  }
}

/** 平级装配模块（类注裁决；TradeModule imports 本模块，FulfillmentModule 不依赖——无环） */
@Module({
  imports: [InfrastructureModule],
  providers: [FulfillmentStatsService],
  exports: [FulfillmentStatsService],
})
export class FulfillmentStatsModule {}
