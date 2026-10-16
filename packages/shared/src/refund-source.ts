/**
 * R-W3-M 退款源接口契约（M1-W3 T6 裁决定型）：流标全员退款的付款人清单经 trade 模块退款源
 * 接口获取——F2（payment 域）消费方与 trade 实现方共用本契约（消费方定型，生产方 import 同一
 * 契约，避免两任务各自发明；G1 消费契约同口径先例）。
 *
 * 落位裁决（简报「形状你定型，落 shared 或 trade 导出」）：落 shared——trade 实现方注册时
 * 禁 import payment 模块内部件（F1 可剥离纪律：导出面只暴露应用服务），shared 是两域唯一
 * 公共依赖，接口放此处不破边界。
 *
 * 注册表形态（T6）：接口注册表由 F2 持有（payment 域 RefundSourceRegistry），测试注册假源
 * 跑全流程；T6 期 trade 侧真实实现不存在，无源注册时消费端 warn 跳过不炸；T7 C3 落真实
 * 实现并注册（T7 简报已带）。
 */
import type { Money } from './money';

/** 退款源清单行：原支付拆分快照（金额守恒与全额退款的上限锚；金额 Money 字符串禁 float） */
export interface RefundSourceOrder {
  /** F1 支付单 id（payment.payment_orders.id） */
  readonly payment_order_id: number;
  /** 付款人账号（identity 侧用户 id；R-03 积分还原与通知定位） */
  readonly user_id: number;
  /** 原支付现金部分（原路退回上限） */
  readonly cash_amount: Money;
  /** 原支付积分部分（R-03 还原为积分不退现） */
  readonly points_amount: number;
}

/** 退款源：按业务实体返回已支付支付单清单（仅已支付——未支付单无款可退，流标静默跳过） */
export interface RefundSource {
  listPaidPaymentOrders(refId: number): Promise<readonly RefundSourceOrder[]>;
}

/** 注册键：B2C 场次（SessionFailed 消费器的 refType；同 B2 占用锁 ref_type 词汇） */
export const REFUND_SOURCE_REF_TYPE_SESSION = 'session';
