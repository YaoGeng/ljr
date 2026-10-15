/**
 * 领域事件契约（骨架占位）。
 * 事件流是模块协作唯一通道（架构 §2.1 Outbox），具名清单以 docs/04 §6 为准，M0-4 起逐批充实。
 * topic 命名 = `<schema>.<entity>.<过去式动词>`（W1 起惯例，如 identity.user.registered）。
 */
export interface DomainEvent {
  /** 事件类型（具名以 docs/04 §6 领域事件清单为准） */
  readonly type: string;
  /** 事件体（占位，随各事件具名定义细化） */
  readonly payload: unknown;
}

// ---------------------------------------------------------------------------
// A1 注册登录与双角色（M1-W2）：1 生产 + 2 消费契约（生产方 A3a=本批 Task 3、A4=M4；
// A1 消费端先以合成事件钉住契约，生产方落位后联调对齐——错位即进重试轨道/死信，不静默）
// ---------------------------------------------------------------------------

/** 用户注册完成（A1 §6 生产 → H8 归因、H4）。手机号等 PII 禁入载荷（lj-data-security）。 */
export const USER_REGISTERED_TOPIC = 'identity.user.registered';

export interface UserRegisteredPayload {
  readonly user_id: number;
  /** 投放归因（H8）；注册链路无投放场景时缺省 */
  readonly utm?: string;
}

/** 律师资质审核通过（A3a §6 生产 → A1 消费授予 lawyer role）。 */
export const LAWYER_AUDIT_PASSED_TOPIC = 'identity.lawyer.audit.passed';

export interface LawyerAuditPassedPayload {
  /** 获授律师角色的账号（identity.users.id） */
  readonly lawyer_user_id: number;
  /** 所属律所（trade/pricing 域引用；A1 消费侧不使用，随契约定型防 A3a 载荷漂移） */
  readonly firm_id: number;
}

/** 账号注销执行完成（A4 §6 生产 → A1 消费置 DELETING，经状态机守卫）。 */
export const ACCOUNT_DELETION_EXECUTED_TOPIC = 'identity.account.deletion.executed';

export interface AccountDeletionExecutedPayload {
  readonly user_id: number;
}
