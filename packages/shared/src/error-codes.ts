/**
 * 全局错误码契约（M0-4，docs/05 M0-4 / task-3 Interfaces 锁定）。
 *
 * 约定：
 *   - 码格式 `E_大写下划线`，全表唯一；新增码须同步本表（禁止散落裸字符串）。
 *   - 每个码绑定默认 httpStatus 与默认文案；AppError 构造时可覆盖 status（降级场景），
 *     但 code 不可为表外值（类型层面收窄）。
 *   - 本表是横切基座的首批码；各业务模块按模块文档错误码章节扩展时在此追加（M1 起）。
 */
export const ErrorCode = {
  /** 未分类内部错误（兜底，禁止业务路径主动抛） */
  InternalError: 'E_INTERNAL',
  /** 请求参数非法 */
  InvalidArgument: 'E_INVALID_ARGUMENT',
  /** 目标资源不存在 */
  NotFound: 'E_NOT_FOUND',
  /** 并发/状态冲突（通用） */
  Conflict: 'E_CONFLICT',
  /** 金额不满足 NUMERIC(12,2) 两位小数字符串规范（架构 §1.3） */
  MoneyInvalidFormat: 'E_MONEY_INVALID',
  /** 幂等键不符合 domain/entity/event 规范 */
  IdempotencyKeyInvalid: 'E_IDEMPOTENCY_KEY_INVALID',
  /** 状态机未定义的迁移（架构 §4.1：非法迁移被守卫拒绝并告警） */
  StateIllegalTransition: 'E_STATE_ILLEGAL_TRANSITION',
  /** 乐观并发冲突：实体已被并发迁移，当前迁移基于过期状态 */
  StateStaleEntity: 'E_STATE_STALE_ENTITY',
  /** Outbox 消费者处理失败（at-least-once，由 relay 重试/死信接管） */
  OutboxHandlerFailed: 'E_OUTBOX_HANDLER_FAILED',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

interface ErrorCodeMeta {
  readonly httpStatus: number;
  readonly defaultMessage: string;
}

const ERROR_CODE_META: Readonly<Record<ErrorCode, ErrorCodeMeta>> = {
  [ErrorCode.InternalError]: { httpStatus: 500, defaultMessage: '内部错误' },
  [ErrorCode.InvalidArgument]: { httpStatus: 400, defaultMessage: '请求参数非法' },
  [ErrorCode.NotFound]: { httpStatus: 404, defaultMessage: '目标资源不存在' },
  [ErrorCode.Conflict]: { httpStatus: 409, defaultMessage: '状态冲突' },
  [ErrorCode.MoneyInvalidFormat]: {
    httpStatus: 422,
    defaultMessage: '金额必须是非负 NUMERIC(12,2) 两位小数字符串',
  },
  [ErrorCode.IdempotencyKeyInvalid]: {
    httpStatus: 400,
    defaultMessage: '幂等键必须符合 domain/entity/event 规范',
  },
  [ErrorCode.StateIllegalTransition]: {
    httpStatus: 409,
    defaultMessage: '状态机未定义的非法迁移',
  },
  [ErrorCode.StateStaleEntity]: {
    httpStatus: 409,
    defaultMessage: '实体状态已被并发修改，请重读后重试',
  },
  [ErrorCode.OutboxHandlerFailed]: {
    httpStatus: 500,
    defaultMessage: '事件消费者处理失败',
  },
};

/** 全局应用错误：code（表内错误码）+ httpStatus（默认按码绑定，可显式覆盖） */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;

  constructor(code: ErrorCode, message?: string, httpStatus?: number) {
    const meta = ERROR_CODE_META[code];
    super(message ?? meta.defaultMessage);
    this.name = 'AppError';
    this.code = code;
    this.httpStatus = httpStatus ?? meta.httpStatus;
  }
}

/** unknown → AppError 收窄（relay/守卫的 catch 路径用） */
export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}
