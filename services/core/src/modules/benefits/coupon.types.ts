/**
 * F4 券面类型契约（②全量，M2-W2 T6）：券定义解析/发放/查询/核销的出入参视图。
 * 面额一律 Money 字符串（元；@ljr/shared 禁 float 纪律）；有效期天数 int。
 */

/** PRICE_COMP 券定义种子行 id（V43 seed：面额 50.00/有效期 90 天 ⚠待产品拍板） */
export const PRICE_COMP_COUPON_ID = 1;

/** H7 配置键（计划 T6 行口径：券面额/有效期落值位；无现行版回退 V43 seed 行） */
export const COUPON_PRICE_COMP_RULE_KEY = 'coupon.price_comp';

/** 券定义快照（发放时点解析结果：H7 现行版优先，回退 seed 行） */
export interface CouponDefinition {
  readonly couponId: number;
  /** 面额（元；Money 字符串） */
  readonly faceValue: string;
  /** 有效天数（expires_at=granted_at+本值） */
  readonly validityDays: number;
}

/** PRICE_COUPON_INSTRUCTED 消费入参（shared 载荷的窄化形态） */
export interface GrantPriceCompInput {
  readonly price_change_id: number;
  readonly user_id: number;
}

/** 发放出参（deduplicated=true=指令重放短路：无新行无新事件） */
export interface GrantCouponResult {
  readonly deduplicated: boolean;
  readonly grant: CouponGrantView;
}

/** GET /coupons/mine 行视图（§5 券列表） */
export interface CouponGrantView {
  readonly id: number;
  readonly coupon_id: number;
  readonly face_value: string;
  readonly status: 'ACTIVE' | 'USED' | 'EXPIRED';
  readonly granted_at: string;
  readonly used_at: string | null;
  readonly expires_at: string;
}

/** 券核销入参（C3 联动预留接口位：下单抵扣——USED 翻转幂等；order_ref=核销审计锚） */
export interface RedeemCouponInput {
  readonly grant_id: number;
  /** 属主校验（非本人 403） */
  readonly user_id: number;
  /** 核销业务引用（如 order:{支付单id}——落 STL reason 审计，无独立列） */
  readonly order_ref: string;
}

/** 核销出参（deduplicated=true=已 USED 重放幂等） */
export interface RedeemCouponResult {
  readonly deduplicated: boolean;
  readonly grant: CouponGrantView;
}
