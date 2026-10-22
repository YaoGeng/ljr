/**
 * dev 支付模拟器（M3-W1 T3，⚠#40 支付直接成功口径的 dev 实现路径）：
 * 报名/发团拿到 payment_order 后，按 core w3-smoke 同款回调报文+HMAC 签名打真实
 * POST /callbacks/{channel} 入 Inbox → core relay（1s 轮询）推进 CREATED→FROZEN→
 * EnrollmentPaid→成团守卫——「点支付即 PAID→成团」。
 *
 * dev-gated（红线）：EXPO_PUBLIC_DEV_PAY_SIM=1 且 EXPO_PUBLIC_DEV_PAY_SECRET 非空才启用；
 * isDevPaySimEnabled 为唯一判定位（视图层入口与 simulatePaySuccess 调用口同闸，评审 I2）。
 * env 访问必须是 process.env.EXPO_PUBLIC_* 直取形态（禁 ?. 可选链——Expo 构建期内联
 * 只匹配直取，可选链会被常量折叠成 undefined 使模拟器在 export 产物中静态失效，实证见
 * T3-报告评审修复波）。
 * 秘钥零字面量：secret 构建期/运行时读 EXPO_PUBLIC_DEV_PAY_SECRET（与 core
 * LJR_PAYMENT_WECHAT_SECRET 同值——config/dev/app.env 无支付密钥[密钥禁入文件层]，
 * 起 core 时显式注入同值即可对签；env 配方见任务报告 §五）。
 * 生产形态=M5-6b 通道拉起换装；显式双 env 注入即构建期白名单——生产构建不注入即禁用。
 * （评审建议的 NODE_ENV!=='production' 附加守卫未采纳：export 产物 NODE_ENV 恒折叠
 * 'production'，加守卫将禁用 T5 E2E 对标准 expo export 产物的模拟器启用路径；显式双 env
 * 白名单等价承载「生产不可达」意图——登记于 T3-报告评审修复波。）
 *
 * dev-only 已接受姿态（评审 I2 登记）：模拟器可对任意 order_id 发起回调（不校验订单归属
 * 当前用户）——等价于通道侧任意报文重放，core 侧验签+幂等+守卫为权威防线；模拟器仅在
 * 显式声明的 dev/E2E 构建中存在。
 *
 * 字节级纪律（core rawBody 验签要求）：签名与发送必须是同一字符串——本模块自建 payload
 * 字符串并直发 fetch（不经 apiFetch 的重序列化），HMAC 覆盖该原文（w3-smoke postCallback 同构）。
 *
 * 本模块保持平台无关（签名原语=纯 TS hmac-sha256，无 node:crypto/react-native import）。
 */
import { apiBaseUrl } from './config';
import { hmacSha256Hex } from '../utils/hmac-sha256';

/** 回调发送超时（评审 S6：5s 兜底，防 fetch 无限悬挂） */
const CALLBACK_TIMEOUT_MS = 5000;

function envFlag(): string | undefined {
  return process.env.EXPO_PUBLIC_DEV_PAY_SIM;
}

function envSecret(): string | undefined {
  return process.env.EXPO_PUBLIC_DEV_PAY_SECRET;
}

/** 模拟器是否启用（唯一判定位：视图层入口与调用口同闸；false 时不得渲染入口/发起调用） */
export function isDevPaySimEnabled(): boolean {
  const secret = envSecret();
  return envFlag() === '1' && secret !== undefined && secret.length > 0;
}

/** 回调报文（w3-smoke 同款三键；channel_txn_no 每次唯一防 Inbox 去重误吞） */
function buildPayload(orderId: number): string {
  const channelTxnNo = `MOCK-APP-${orderId}-${Date.now()}`;
  return JSON.stringify({
    order_id: orderId,
    event_type: 'PAY_SUCCESS',
    channel_txn_no: channelTxnNo,
  });
}

/** 报文签名（hex 小写——core 验签侧 toLowerCase 后比对，形态一致） */
export function signCallbackPayload(secret: string, payload: string): string {
  return hmacSha256Hex(secret, payload);
}

export interface MockPayResult {
  /** true=首次入箱；false=重复回调（Inbox 双唯一去重，语义=已受理） */
  readonly inboxed: boolean;
}

/**
 * 模拟通道支付成功回调：POST /callbacks/{channel}（x-payment-signature 头=HMAC-SHA256 hex）。
 * channel 来自 pay_params.channel（无 pay_params 面（C2 发布出参为最小集）时缺省主通道
 * wechat_ecom——core dev PAYMENT_CONFIG.primary 即该通道）。
 */
export async function simulatePaySuccess(
  orderId: number,
  channel = 'wechat_ecom',
): Promise<MockPayResult> {
  if (!isDevPaySimEnabled()) {
    // 双保险：视图层已闸，此处同闸再拒（fail-visible，不静默假装成功——评审 I2：总闸为唯一判定位）
    throw new Error('dev 支付模拟器未启用（EXPO_PUBLIC_DEV_PAY_SIM / EXPO_PUBLIC_DEV_PAY_SECRET）');
  }
  const secret = envSecret() as string;
  const payload = buildPayload(orderId);
  const signature = signCallbackPayload(secret, payload);
  // 评审 S6：AbortController 超时兜底（不用 AbortSignal.timeout——RN/Hermes 无该 API）
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CALLBACK_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${apiBaseUrl()}/callbacks/${channel}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-payment-signature': signature,
      },
      body: payload,
      signal: controller.signal,
    });
  } catch {
    throw new Error('模拟支付回调发送失败（core 未启动、网络不通或超时）');
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    // 验签失败/订单不存在等：透传状态码，调用方展示（不吞错）
    let detail = '';
    try {
      detail = await res.text();
    } catch {
      detail = '';
    }
    throw new Error(`模拟支付回调被拒（HTTP ${res.status}）：${detail.slice(0, 120)}`);
  }
  try {
    const body = (await res.json()) as { inboxed?: unknown };
    return { inboxed: body.inboxed === true };
  } catch {
    throw new Error('模拟支付回调响应不可解析');
  }
}
