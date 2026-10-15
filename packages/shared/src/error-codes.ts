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
  /** 必填配置缺失（启动期 require 未命中，fail-fast；M0-8 配置基座） */
  ConfigMissing: 'E_CONFIG_MISSING',
  /** 配置值非法（端口非 1-65535 整数等）或密钥被写入配置文件（M0-8 配置基座） */
  ConfigInvalid: 'E_CONFIG_INVALID',
  /** 规则中心提交冲突：同 key+version 已存在（内容不等）或当前状态不允许提交（H7 §5 409 PUBLISHING） */
  RulePublishConflict: 'E_RULE_PUBLISHING',
  /** 词库内重复词：同一次词库提交中存在规范化后重复的词（H5 §5 400 DUP_WORD；H5 W1） */
  DuplicateWord: 'E_DUP_WORD',
  /** 规则中心保留前缀：rule_key 命中保留前缀（wordlist.* 为 H5 词库专用通道），通用管理面拒绝（H7 R15） */
  RuleKeyReserved: 'E_RULE_KEY_RESERVED',
  /** E3 专项不支持：V1 仅 labor_arbitration（R-04），其他专项 key 的管理面写入拒绝（400） */
  SpecialtyUnsupported: 'E_SPECIALTY_UNSUPPORTED',
  /** E3 知识库上传格式非法：file_ref 形态/source_type/license_status 枚举等（§5 400 BAD_FORMAT） */
  KnowledgeBadFormat: 'E_BAD_FORMAT',
  /** E3 问题树结构校验不通过：root/节点引用/连通性/环检测等（§5 400 INVALID_TREE） */
  InvalidQuestionTree: 'E_INVALID_TREE',
  /** A1 验证码限频拒绝：同号 60s/1h/1d 三窗任一触顶（A1 §5 429 RATE_LIMITED，R-01 承接 I1 R-02） */
  RateLimited: 'E_RATE_LIMITED',
  /** A1 验证码无效/过期/已消费/重放（A1 §5 401 CODE_INVALID） */
  CodeInvalid: 'E_CODE_INVALID',
  /** A1 refresh_token 无效/过期/已吊销（A1 §5 401 REFRESH_EXPIRED；吊销即时生效 R-W2-4） */
  RefreshExpired: 'E_REFRESH_EXPIRED',
  /** A1 目标角色未授予：switch-role 校验 user_roles 不含目标角色（A1 §5 403 ROLE_NOT_HELD） */
  RoleNotHeld: 'E_ROLE_NOT_HELD',
  /** A1 R-04 年龄声明缺失：新建号 age_declared 非 true 拒绝完成注册（裁决 R-W2-C，400） */
  AgeDeclarationRequired: 'E_AGE_DECLARATION_REQUIRED',
  /** A1 账号不可登录：BANNED/DELETING（§5 未列，最小自定 403；DELETING 细分语义随 A4=M4 细化） */
  AccountBanned: 'E_ACCOUNT_BANNED',
  /** A1 R-03 角色不符：claims.role 与接口要求角色不一致（律师端拒 user token / 用户端拒 lawyer token） */
  RoleForbidden: 'E_ROLE_FORBIDDEN',
  /** A1 未认证：缺 Bearer / JWT 无效或过期（A1 §5 GET /me 401 未具名，最小自定） */
  Unauthorized: 'E_UNAUTHORIZED',
  /** A2 实名证件形态非法：姓名为空 / id_no 非 18 位形态（A2 §5 400 INVALID_ID；校验位错≠形态错，走核验 FAILED） */
  InvalidId: 'E_INVALID_ID',
  /** A2 训练授权 policy_version 与当前有效版本不一致（A2 §5 409 VERSION_MISMATCH；当前值=config，裁决 R-W2-6） */
  VersionMismatch: 'E_VERSION_MISMATCH',
  /** A2 受控解密无完整审批：approval_id 缺失/未双签/指向不符（A2 §5 403 NOT_APPROVED；裁决 R-W2-5） */
  NotApproved: 'E_NOT_APPROVED',
  /** A3a 同人重复提交：资质已在审核流程中（SUBMITTED/IN_REVIEW）再提交（A3a §5 409 ALREADY_SUBMITTED；幂等键=user） */
  AlreadySubmitted: 'E_ALREADY_SUBMITTED',
  /** A3a R-03 执业证号已被其他账号占用：盲索引等值命中他人档案（A3a §5 409，最小自定命名） */
  LicenseNoTaken: 'E_LICENSE_NO_TAKEN',
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
  [ErrorCode.ConfigMissing]: {
    httpStatus: 500,
    defaultMessage: '必填配置缺失',
  },
  [ErrorCode.ConfigInvalid]: {
    httpStatus: 500,
    defaultMessage: '配置值非法或密钥被写入配置文件',
  },
  [ErrorCode.RulePublishConflict]: {
    httpStatus: 409,
    defaultMessage: '规则版本冲突：同 key+version 已存在或当前状态不允许提交',
  },
  [ErrorCode.DuplicateWord]: {
    httpStatus: 400,
    defaultMessage: '词库中存在重复词（大小写不敏感判定）',
  },
  [ErrorCode.RuleKeyReserved]: {
    httpStatus: 400,
    defaultMessage: 'rule_key 使用保留前缀（wordlist.* 为词库专用通道，须经词库管理面写入）',
  },
  [ErrorCode.SpecialtyUnsupported]: {
    httpStatus: 400,
    defaultMessage: '专项 key 未开放（V1 仅 labor_arbitration，R-04）',
  },
  [ErrorCode.KnowledgeBadFormat]: {
    httpStatus: 400,
    defaultMessage: '知识库上传请求格式非法（file_ref 形态/source_type/license_status）',
  },
  [ErrorCode.InvalidQuestionTree]: {
    httpStatus: 400,
    defaultMessage: '问题树结构校验不通过（root/节点引用/连通性/环）',
  },
  [ErrorCode.RateLimited]: {
    httpStatus: 429,
    defaultMessage: '请求过于频繁，请稍后再试',
  },
  [ErrorCode.CodeInvalid]: {
    httpStatus: 401,
    defaultMessage: '验证码无效或已过期',
  },
  [ErrorCode.RefreshExpired]: {
    httpStatus: 401,
    defaultMessage: '登录态已失效，请重新登录',
  },
  [ErrorCode.RoleNotHeld]: {
    httpStatus: 403,
    defaultMessage: '目标角色未授予',
  },
  [ErrorCode.AgeDeclarationRequired]: {
    httpStatus: 400,
    defaultMessage: '须先勾选年龄声明（已满 14 周岁或不满 14 已获监护人同意）',
  },
  [ErrorCode.AccountBanned]: {
    httpStatus: 403,
    defaultMessage: '账号当前不可登录',
  },
  [ErrorCode.RoleForbidden]: {
    httpStatus: 403,
    defaultMessage: '当前角色无权访问该接口',
  },
  [ErrorCode.Unauthorized]: {
    httpStatus: 401,
    defaultMessage: '未认证或凭证无效',
  },
  [ErrorCode.InvalidId]: {
    httpStatus: 400,
    defaultMessage: '实名信息形态非法：姓名不得为空，身份证号须为 18 位（末位可为 X）',
  },
  [ErrorCode.VersionMismatch]: {
    httpStatus: 409,
    defaultMessage: 'policy_version 与当前有效版本不一致，请刷新授权页后重试',
  },
  [ErrorCode.NotApproved]: {
    httpStatus: 403,
    defaultMessage: '受控解密未获完整审批（须审批人签发且复核人双签，两人不得相同）',
  },
  [ErrorCode.AlreadySubmitted]: {
    httpStatus: 409,
    defaultMessage: '资质已在审核流程中，请勿重复提交',
  },
  [ErrorCode.LicenseNoTaken]: {
    httpStatus: 409,
    defaultMessage: '执业证号已被其他账号使用（R-03 防一人多号重复入驻）',
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
