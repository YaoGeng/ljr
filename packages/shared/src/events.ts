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

// ---------------------------------------------------------------------------
// A2 实名认证与同意管理（M1-W2）：3 生产契约（消费：无——发起方；D5 语料删除=M2 接，
// C3/F1 实名闸口走内部查询面不走事件，A2 §6）
// ---------------------------------------------------------------------------

/** 实名核验通过（A2 §6 生产 → 预留 C3/F1/信用域订阅位；载荷最小化，PII 禁入）。 */
export const REAL_NAME_VERIFIED_TOPIC = 'identity.realname.verified';

export interface RealNameVerifiedPayload {
  readonly user_id: number;
}

/** 训练数据授权授予（A2 §6 生产 → D5 据此落 consent_records，M2；本批无消费者，只定型契约）。 */
export const TRAINING_CONSENT_GRANTED_TOPIC = 'identity.consent.training.granted';

export interface TrainingConsentGrantedPayload {
  readonly user_id: number;
  readonly policy_version: string;
  /** 房间级授权上下文（成团/支付流程内授权页携带；用户主动全局授权时缺省——A2 §3 注） */
  readonly room_ids?: number[];
}

/** 训练数据授权撤回（A2 §6 生产 → D5/I3 按 source_msg_id 反查物理删除未训练样本，R-03，M2）。 */
export const TRAINING_CONSENT_REVOKED_TOPIC = 'identity.consent.training.revoked';

export interface TrainingConsentRevokedPayload {
  readonly user_id: number;
  /** 撤回时刻（ISO 8601 UTC 即时；D5 删除执行的时间锚点） */
  readonly revoked_at: string;
}
