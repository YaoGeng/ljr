/**
 * coupon_grants 状态机（F4 §3/§4，M2-W2 T6 ②全量）。
 *
 * 「状态字段禁裸写」（架构 §1.3/§4.1；M2-W2 计划全局约束明列 coupon_grants）：全部边经
 * infrastructure/state-machine 守卫迁移并落 state_transition_log（entity_type=
 * 'coupon_grant'）。边语义：
 *   ACTIVE→USED    核销（下单抵扣——C3 联动预留接口 CouponService.redeemInTx；
 *                   dev 期支付直接成功口径下核销面=接口位+用例，不做完整下单编排）
 *   ACTIVE→EXPIRED 到期（惰性：GET /coupons/mine 读时翻转；周期：POINTS_EXPIRE 日扫槽
 *                   sweepExpired——F4 日维护共用该周期槽，目录零增量裁定，报告注明）
 * 建单 INSERT status='ACTIVE' 非迁移无需守卫（demo/notify/ticket 同口径）；USED/EXPIRED
 * 为终态无出边——再核销由服务层幂等/409 短路。
 */
import { createStateMachine } from '../../infrastructure/state-machine/state-machine';

export type CouponStatus = 'ACTIVE' | 'USED' | 'EXPIRED';

export const COUPON_MACHINE = createStateMachine<CouponStatus>({
  entityType: 'coupon_grant',
  states: ['ACTIVE', 'USED', 'EXPIRED'],
  transitions: [
    { from: 'ACTIVE', to: 'USED' }, // 核销（下单抵扣）
    { from: 'ACTIVE', to: 'EXPIRED' }, // 到期（惰性读时/周期日扫）
  ],
});
