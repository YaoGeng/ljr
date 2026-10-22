/**
 * 错误文案映射表（M3-W1 T1）：错误码 → 用户可读文案，单一事实源。
 *
 * 纪律（计划全局约束）：状态/错误文案用映射表，禁散写三元。
 * 码值来源两类：
 *   - 服务端契约码 = @ljr/shared ErrorCode 值（E_* 表内值，映射只摘用户端高频面；
 *     未命中表的服务端码回退服务端 message，再回退通用文案——不吞错、不撒谎）；
 *   - 客户端本地码 = client.ts 的 AppClientErrorCode（网络不通/响应不可解析/本地入参拒绝，
 *     属前端层信号，不入 shared 契约表，登记于设计决策文档）。
 * 键类型约束（T6 评审 S7）：Partial<Record<ErrorCode | AppClientErrorCodeValue, string>>——
 * 键集=shared 契约码 ∪ 客户端本地码，表内键拼写错误变编译错（Partial=允许只摘高频面）。
 */
import type { ErrorCode } from '@ljr/shared';
import type { AppClientErrorCodeValue } from './client';

const API_ERROR_COPY: Readonly<Partial<Record<ErrorCode | AppClientErrorCodeValue, string>>> = {
  // identity A1 登录面（E_RATE_LIMITED 为 A1 短信限频与 B2 R-03 发团滥用限频共用码——
  // 文案取语境中性形，T3 修正：原「验证码发送过于频繁」在发团 429 语境误导）
  E_RATE_LIMITED: '操作过于频繁，请稍后再试',
  E_CODE_INVALID: '验证码无效或已过期，请重新获取',
  E_INVALID_ARGUMENT: '输入格式有误，请检查后重试',
  E_AGE_DECLARATION_REQUIRED: '首次注册须先勾选年龄声明',
  E_ACCOUNT_BANNED: '账号当前不可登录，请联系客服',
  E_UNAUTHORIZED: '登录已失效，请重新登录',
  E_REFRESH_EXPIRED: '登录已失效，请重新登录',
  // 通用
  E_NOT_FOUND: '请求的内容不存在',
  E_CONFLICT: '操作冲突，请刷新后重试',
  E_INTERNAL: '服务开小差了，请稍后重试',
  // C3 报名支付（§5：402/403/409 三态）
  E_REALNAME_REQUIRED: '报名前需完成实名认证',
  E_RESTRICTED: '当前账号被限制拼单，暂不可操作（如有疑问请联系客服）',
  E_FULL_OR_DEADLINE: '名额已满或已过报名截止时间，请选择其他场次',
  E_ENROLL_DUP_KEY: '已存在进行中的报名，请勿重复提交',
  // C2 发起拼团（§5：409/400/403）
  E_SLOT_TAKEN: '该咨询时段已被占用，请更换时间',
  E_GROUP_BUY_DUP_KEY: '同一时段已有进行中的拼团，请勿重复发起',
  E_OUT_OF_RANGE: '拼团人数超出该律师接受的范围，请调整人数',
  E_ACCEPT_RANGE_UNSET: '该律师尚未配置拼团接受人数范围，暂不可对其发起拼团',
  E_REACHED_LOCKED: '该拼团已成团锁定，不再接受新加入',
  // A2 实名/授权
  E_INVALID_ID: '身份证号或姓名格式有误，请检查后重试',
  E_VERSION_MISMATCH: '授权协议版本已更新，请刷新后重试',
  // 客户端本地码
  CLIENT_NETWORK: '网络连接失败，请检查网络后重试',
  CLIENT_BAD_RESPONSE: '服务响应异常，请稍后重试',
  CLIENT_BAD_REQUEST: '请求参数有误，请返回重试',
};

const FALLBACK_COPY = '操作失败，请稍后重试';

/**
 * 解析用户可见文案：映射表优先 → 服务端 message（shared 默认文案即人话）→ 通用兜底。
 * 调试诉求不丢失：原始 code/httpStatus 始终保留在 AppApiError 字段上。
 */
export function resolveApiErrorCopy(code: string, serverMessage?: string): string {
  // 运行时入参为 string（表外码/表外形态照常流入）——索引处收窄到键类型，映射未命中回退链不变
  return (
    API_ERROR_COPY[code as ErrorCode | AppClientErrorCodeValue] ?? serverMessage ?? FALLBACK_COPY
  );
}
