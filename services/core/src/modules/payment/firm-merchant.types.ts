/**
 * A3b 类型与契约词汇（§5 snake_case 逐字；materials PII 最小化：服务视图不回显材料内容，
 * 日志只落 keys 数/字节数摘要——红线断言用例钉住）。复用 payment.types 的金额/正整数工具
 * （同域文件平级，不造本地重复）。
 */
import { AppError, ErrorCode } from '@ljr/shared';
import type { PaymentChannelName } from './payment.channels';
import type { FirmMerchantStatus } from './firm-merchant.machine';

/** materials 体积上限（jsonb 载荷防炸；对公账户等敏感材料应用侧禁落日志） */
export const MATERIALS_MAX_BYTES = 16_384;

export interface FirmMerchantSubmitInput {
  readonly firm_id: number;
  readonly channel: string;
  readonly materials: Readonly<Record<string, unknown>>;
}

export interface FirmMerchantChangeInput {
  readonly firm_id: number;
  readonly channel?: string;
  readonly materials: Readonly<Record<string, unknown>>;
}

export interface FirmMerchantReverifyInput {
  readonly firm_id: number;
  readonly channel?: string;
}

/** 商户视图（DB 行读出口径：时间一律字符串 ISO；materials 故意不在视图——HTTP 面不回显敏感材料） */
export interface FirmMerchantView {
  readonly id: number;
  readonly firm_id: number;
  readonly channel: string;
  readonly sub_mchid: string | null;
  readonly status: FirmMerchantStatus;
  readonly verified_at: string | null;
  readonly reverify_due: string | null;
  readonly created_at: string;
}

/** LawyerAuditPassed 消费启动结果（started=false=行已在，幂等短路） */
export interface MerchantOnboardingStartResult {
  readonly started: boolean;
}

/** R-03 复验到期执行结果（executor 返回值进 schedule_job_log.detail） */
export interface ReverifyOverdueOutcome {
  readonly firm_id: number;
  readonly channel: string;
  readonly due_at: string;
}

/** channel 值域收口（wechat_ecom|alipay，§3 注释；缺省=主通道） */
export function assertChannel(v: string): PaymentChannelName {
  if (v !== 'wechat_ecom' && v !== 'alipay') {
    throw new AppError(
      ErrorCode.InvalidArgument,
      `channel 越域（wechat_ecom|alipay）：${String(v)}`,
    );
  }
  return v;
}

/** materials 形状/体积校验（object 非 array/null；≤16KB；错误信息不含材料值——PII 红线） */
export function assertMaterials(v: unknown): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new AppError(ErrorCode.InvalidArgument, 'materials 须为 JSON 对象（键值不落日志）');
  }
  const bytes = Buffer.byteLength(JSON.stringify(v), 'utf8');
  if (bytes > MATERIALS_MAX_BYTES) {
    throw new AppError(
      ErrorCode.InvalidArgument,
      `materials 超限（${bytes} > ${MATERIALS_MAX_BYTES} 字节）`,
    );
  }
  return v as Record<string, unknown>;
}
