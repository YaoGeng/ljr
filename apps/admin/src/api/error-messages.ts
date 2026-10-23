/**
 * 错误文案映射表（M3-W3 T1，对照 apps/app/src/api/error-messages.ts 先例、独立实现）：
 * 错误码 → 用户可读文案，admin 面单一事实源（纪律：状态/错误文案用映射表，禁散写三元）。
 *
 * 码值来源两类：
 *   - 服务端契约码 = @ljr/shared ErrorCode 值（admin 不依赖 shared 包——workspace 依赖面
 *     本卡零新增，码值以字面量副本收窄；后续卡只增）；
 *   - 客户端本地码 = client.ts 的 AdminClientErrorCode（网络不通/响应不可解析——前端层
 *     信号，不入服务端契约表）。
 * 解析链：映射表优先 → 服务端 message → 通用兜底（不吞错、不撒谎）；原始 code/httpStatus
 * 始终保留在 AdminApiError 字段上供调试。
 */
import type { AdminClientErrorCodeValue } from './client';

/** admin 面起步的服务端契约码副本（@ljr/shared error-codes.ts 值域子集；后续卡只增） */
export type AdminServerErrorCode =
  | 'E_INTERNAL'
  | 'E_INVALID_ARGUMENT'
  | 'E_NOT_FOUND'
  | 'E_CONFLICT'
  | 'E_STATE_ILLEGAL_TRANSITION'
  | 'E_STATE_STALE_ENTITY'
  | 'E_RATE_LIMITED'
  | 'E_CODE_INVALID'
  | 'E_ACCOUNT_BANNED'
  | 'E_ROLE_FORBIDDEN'
  | 'E_UNAUTHORIZED'
  | 'E_REFRESH_EXPIRED'
  | 'E_DUP_WORD'
  | 'E_RULE_PUBLISHING'
  | 'E_RULE_KEY_RESERVED';

export type AdminApiCode = AdminServerErrorCode | AdminClientErrorCodeValue;

/** 已知服务端码白名单（响应 code 是否表内值——表外码回退服务端 message） */
export const KNOWN_SERVER_CODES: ReadonlySet<string> = new Set<AdminServerErrorCode>([
  'E_INTERNAL',
  'E_INVALID_ARGUMENT',
  'E_NOT_FOUND',
  'E_CONFLICT',
  'E_STATE_ILLEGAL_TRANSITION',
  'E_STATE_STALE_ENTITY',
  'E_RATE_LIMITED',
  'E_CODE_INVALID',
  'E_ACCOUNT_BANNED',
  'E_ROLE_FORBIDDEN',
  'E_UNAUTHORIZED',
  'E_REFRESH_EXPIRED',
  'E_DUP_WORD',
  'E_RULE_PUBLISHING',
  'E_RULE_KEY_RESERVED',
]);

const API_ERROR_COPY: Readonly<Partial<Record<AdminApiCode, string>>> = {
  // 登录面（POST /auth/verify）
  E_CODE_INVALID: '验证码无效或已过期，请重新输入',
  E_RATE_LIMITED: '操作过于频繁，请稍后再试',
  E_INVALID_ARGUMENT: '输入格式有误，请检查后重试',
  E_ACCOUNT_BANNED: '账号当前不可登录，请联系客服',
  E_UNAUTHORIZED: '登录已失效，请重新登录',
  E_REFRESH_EXPIRED: '登录已失效，请重新登录',
  // admin 鉴权门（IdentityRoleGuard @RequireRole('admin') → 403）
  E_ROLE_FORBIDDEN: '该操作要求运营（admin）权限',
  // 通用
  E_NOT_FOUND: '请求的内容不存在',
  E_CONFLICT: '操作冲突，请刷新后重试',
  // H1 审核状态冲突面（409：核心=该档案状态不允许此动作/已被并发处理——调用方据此横幅+刷新）
  E_STATE_ILLEGAL_TRANSITION:
    '该档案当前状态不允许此操作（可能已被处理或状态已流转），请刷新列表后重试',
  E_STATE_STALE_ENTITY: '操作对象刚被并发处理，请刷新列表后重试',
  // H5 词库提交面（400 重复词=本地防呆先行服务端兜底；409 版本冲突=重取后重试）。
  // E_RULE_PUBLISHING=H7 域通用码（词库并发竞态只是消费位之一，T5 规则中心复用）——文案通用措辞
  E_DUP_WORD: '词库内存在重复词（大小写不敏感判定），请检查词条',
  E_RULE_PUBLISHING: '规则/词库版本冲突（并发提交），请刷新后重试',
  // H7 规则 key 保留前缀（T5 扩：core rule-center.validate.ts assertNotReservedRuleKey →
  // 400 E_RULE_KEY_RESERVED；文案对照 @ljr/shared error-codes.ts defaultMessage）
  E_RULE_KEY_RESERVED: 'rule_key 使用保留前缀（wordlist.* 为词库专用通道，须经词库管理面写入）',
  E_INTERNAL: '服务开小差了，请稍后重试',
  // 客户端本地码
  CLIENT_NETWORK: '网络连接失败，请检查网络后重试',
  CLIENT_BAD_RESPONSE: '服务响应异常，请稍后重试',
  CLIENT_BAD_REQUEST: '请求参数有误，请刷新重试',
};

const FALLBACK_COPY = '操作失败，请稍后重试';

/** 解析用户可见文案：映射表优先 → 服务端 message → 通用兜底 */
export function resolveApiErrorCopy(code: string, serverMessage?: string): string {
  return API_ERROR_COPY[code as AdminApiCode] ?? serverMessage ?? FALLBACK_COPY;
}
