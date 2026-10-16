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
  /**
   * 所属律所（trade/pricing 域引用；A1 消费侧不使用，随契约定型防 A3a 载荷漂移）。
   * null=律所未定：A3b 进件（W3）前提交的资质不产生 firm_id（A3a §3 firm_id 可空；
   * M1-W2 T3 简报裁决「载荷 firm_id=null 合法」，A1 消费端同批放宽为可空）。
   */
  readonly firm_id: number | null;
}

/** 律师资质停用（A3a §6 生产 → 预留 C3/H1 订阅位：下架接单资格与可见性）。 */
export const LAWYER_SUSPENDED_TOPIC = 'identity.lawyer.suspended';

export interface LawyerSuspendedPayload {
  /** 被停用律师的账号（identity.users.id） */
  readonly lawyer_user_id: number;
  /** 停用事由（H1 审核操作入参；审计口径，非 PII） */
  readonly reason: string;
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

// ---------------------------------------------------------------------------
// B3 默认价格与1对1价格配置（M1-W2）：1 生产契约。消费位（W3 接线，M1-W2 T5 简报裁决）：
//   I1「通知已参与拼团用户」经本事件消费实现；C6 改价引擎的回流判定
//   （PriceChangeApproved/Rejected）本批不落——B3 只生产，不自带消费端。
// ---------------------------------------------------------------------------

/** 价格版本创建（B3 §6 生产 → I1 参与者通知 W3 消费位 / C6 改价引擎基线）。 */
export const PRICE_VERSION_CREATED_TOPIC = 'pricing.price_version.created';

export interface PriceVersionCreatedPayload {
  /** 价格所属律师（identity 侧用户 id，bigint 裸引用口径） */
  readonly lawyer_id: number;
  /** 新版本号（= 该律师 price_versions 当前最大 version + 1，从 1 起） */
  readonly version: number;
}

// ---------------------------------------------------------------------------
// G1 信用体系（M1-W2）：2 生产契约（消费：C1/C3/A3a 入口校验、H4）+ 5 消费契约
// （生产者 C2/C4/C6/D3/D4 在 W3、G2 在 M2——G1 消费端先行钉契约（R-W2-A 口径：
// 契约由消费方定型，生产方 import 同一契约，避免两任务各自发明），生产方落位后联调对齐）。
// ---------------------------------------------------------------------------

/** 信用事件入账（G1 §6 生产 → C1/C3/A3a、H4）。 */
export const CREDIT_EVENT_EMITTED_TOPIC = 'credit.event.emitted';

export interface CreditEventEmittedPayload {
  readonly owner_type: 'user' | 'lawyer';
  readonly owner_id: number;
  /** 行为动作（G1 行为词汇表，PRD §8.8 全表 + 机制扩展；语义见 G1 模块文档 §7） */
  readonly action: string;
  /** 本事件分值增量（正加负减；账户侧 R-01 下限 0 钳制不影响流水记录值） */
  readonly delta: number;
  /** 入账后账户分（快照） */
  readonly score_after: number;
  /** 行为时快照命中的 credit.rules 版本号（R-02 审计位） */
  readonly rule_version: number;
  /** 幂等引用（ref+action=G1 幂等键；载荷多态：session/price_change/attendance/review/group/outbox_event） */
  readonly ref_type: string;
  readonly ref_id: number;
}

/** 限制令发放（G1 §6 生产 → C1/C3/A3a 入口拦截、H4）。 */
export const RESTRICTION_ISSUED_TOPIC = 'credit.restriction.issued';

export interface RestrictionIssuedPayload {
  readonly owner_type: 'user' | 'lawyer';
  readonly owner_id: number;
  /** BAN_JOIN|BAN_PUBLISH|SUSPEND_TAKE_3D|SUSPEND_TAKE_7D（G1 §3 值域） */
  readonly kind: string;
  /** 失效时刻（ISO 8601；惰性失效——查询面按 until<=now 过滤，无 I2 到期 job） */
  readonly until: string;
}

/** C2B 律师拒绝/超时（C2/C4 §6 生产 → G1 消费扣分 -5 档；docs/04 §6 LawyerRejected(Timeout)）。 */
export const LAWYER_REJECTED_TOPIC = 'trade.group_buy.lawyer_rejected';

export interface LawyerRejectedPayload {
  readonly group_id: number;
  readonly lawyer_id: number;
}

/** 改价审批通过（C6 §6 生产 → G1 消费按档扣分/停接）。kind 由 C6 按 §8.8 档位归类（G1 只承载机制）。 */
export const PRICE_CHANGE_APPROVED_TOPIC = 'pricing.price_change.approved';

export type PriceChangeKind = 'PRICE_UP' | 'PRICE_DOWN_LE10' | 'PRICE_DOWN_GT10';

export interface PriceChangeApprovedPayload {
  readonly price_change_id: number;
  readonly lawyer_id: number;
  readonly kind: PriceChangeKind;
}

/** 到场判定（D3 §6 生产 → G1 消费；normal/absent 入信用，late 无 §8.8 分值行不产生信用事件）。 */
export const ATTENDANCE_ADJUDICATED_TOPIC = 'fulfillment.attendance.adjudicated';

export type AttendanceResult = 'normal' | 'late' | 'absent';

export interface AttendanceAdjudicatedPayload {
  readonly adjudication_id: number;
  readonly session_id: number;
  readonly owner_type: 'user' | 'lawyer';
  readonly owner_id: number;
  readonly result: AttendanceResult;
}

/** 场次取消（D4 §6 生产 → G1/F2/F3/I1 消费；platform 取消无信用影响（PRD §8.7），G1 跳过）。
 *  取消档位（用户 2h/律师 24h，PRD §8.7/§8.8）由 G1 按 cancelled_at 与 session_start_at 差值归类；
 *  cancelled_by_user_id=取消方账号（lawyer 取消时=律师 identity 侧用户 id；platform 取消为 null）。 */
export const SESSION_CANCELLED_TOPIC = 'fulfillment.session.cancelled';

export interface SessionCancelledPayload {
  readonly session_id: number;
  readonly cancelled_by: 'user' | 'lawyer' | 'platform';
  /** 取消方账号（G1 定位信用 owner；platform 取消=null） */
  readonly cancelled_by_user_id: number | null;
  /** 取消时刻（ISO 8601） */
  readonly cancelled_at: string;
  /** 约定开始时刻（ISO 8601；§8.7 档位判定锚点） */
  readonly session_start_at: string;
}

/** 评价提交（G2 §6 生产 → G1/C1/H4 消费；G2 §4「G1 联动（正向加分）」——分值由 credit.rules 配置）。
 *  reviewee_user_id 为被评方账号（G2 §3 reviews 无 from 字段匿名拆分，事件载荷显式携带供 G1 定位 owner）。 */
export const REVIEW_SUBMITTED_TOPIC = 'review.review.submitted';

export type ReviewDirection = 'user_to_lawyer' | 'lawyer_to_user';

export interface ReviewSubmittedPayload {
  readonly session_id: number;
  readonly direction: ReviewDirection;
  /** 四维分 {professional, response, attitude, overall}（1-5；G1 机制侧不解释，透传审计） */
  readonly dims: Record<string, number>;
  readonly reviewee_user_id: number;
}

// ---------------------------------------------------------------------------
// F1 支付网关与回调 Inbox（M1-W3 T1）：3 生产契约。F1 §6「消费：无」——指令型服务，
// 事件出箱即止：PaymentCallbackInboxed → C3（T7 接线）消费推进业务状态机；
// ReconciliationDiffFound → H3 工单面（M2）；ChannelDegraded → 告警 sink（本批 mock，
// M2+ 换装，沿 B2 告警 mock sink 先例）。
// ---------------------------------------------------------------------------

/** 支付回调入箱（F1 §6 生产 → C3 消费推进）。载荷逐字 §6：{biz_idempotency_key, event}；
 *  biz_idempotency_key = {业务幂等号}:{channel_event_type}（F1 §3 构成，下游按前缀定位支付单）。 */
export const PAYMENT_CALLBACK_INBOXED_TOPIC = 'payment.callback.inboxed';

export interface PaymentCallbackInboxedPayload {
  readonly biz_idempotency_key: string;
  /** 通道事件类型（如 PAY_SUCCESS / REFUND_SUCCESS；F1 §3 注释例） */
  readonly event: string;
}

/** 对账差异发现（F1 §6 生产 → H3 工单面，SLA 24h，M2 接线；本批断言到事件出箱为止）。
 *  detail 金额一律 Money 字符串（NUMERIC 禁 float）。 */
export const RECONCILIATION_DIFF_FOUND_TOPIC = 'payment.reconciliation.diff_found';

/** 差异明细项（kind：通道独有行 / 本地独有行 / 双边金额不一致；F1 §4 双向核对三态） */
export interface ReconciliationDiffItem {
  readonly channel: string;
  /** 通道流水号（本地独有行可能无通道流水号 → null） */
  readonly channel_txn_no: string | null;
  readonly kind: 'CHANNEL_ONLY' | 'LOCAL_ONLY' | 'AMOUNT_MISMATCH';
  /** 差异行金额（Money 字符串；本地独有=本地金额，其余=账单行金额） */
  readonly amount: string;
  /** 人读差异原因（与 split_ledgers.diff_reason 同文） */
  readonly reason: string;
}

export interface ReconciliationDiffFoundPayload {
  /** 对账期（ISO date：YYYY-MM-DD） */
  readonly period: string;
  readonly detail: readonly ReconciliationDiffItem[];
}

/** 通道降级（F1 §6 生产 → 告警 sink/切换记录；§8 单通道故障 5min 内切换的观测位）。 */
export const CHANNEL_DEGRADED_TOPIC = 'payment.channel.degraded';

export interface ChannelDegradedPayload {
  /** 降级通道（wechat_ecom | alipay） */
  readonly channel: string;
}

// ---------------------------------------------------------------------------
// F4 权益积分（M1-W3 T2）：3 生产契约（消费：H4/C6 回执均 M2——本批生产方定型契约，
// 出箱即止）。①切片=积分账户+下单冻结核销+退款还原+过期；券/备付=②全量（M2-W2）。
// 载荷口径（简报）：含 user_id/delta/kind/ref 与幂等引用；balance_after=出站时点账户
// 可用余额快照（同 CreditEventEmittedPayload.score_after 形态）。
// ---------------------------------------------------------------------------

/**
 * 积分流水 kind 词汇表（F4 §3 注释逐字 5 值 + ①切片口径归一追加 2 值）：
 *   COMPENSATION/ABSENCE_SHARE/REFUND_RESTORE=正向授予（expires_at 有意义）；
 *   REDEEM/EXPIRE=消耗；FREEZE/UNFREEZE=冻结/解冻留痕行（§5「幂等键=order」在两表模型下
 *   的幂等锚点+审计行——delta 携带冻结额，不参与余额不变量求和口径，core points.service
 *   头注与 V21 迁移头注同口径注明）。
 */
export const POINTS_TXN_KINDS = [
  'COMPENSATION',
  'ABSENCE_SHARE',
  'REDEEM',
  'REFUND_RESTORE',
  'EXPIRE',
  'FREEZE',
  'UNFREEZE',
] as const;

export type PointsTxnKind = (typeof POINTS_TXN_KINDS)[number];

/** 正向授予 kind（PointsGranted 的 kind 值域；REFUND_RESTORE=R-06 退款还原，过期时钟重置） */
export type PointsGrantKind = 'COMPENSATION' | 'ABSENCE_SHARE' | 'REFUND_RESTORE';

/** 积分授予（F4 §6 生产 → H4/C6 回执消费位=M2）。delta>0；ref=幂等引用（points_txns.source_ref 同文）。 */
export const POINTS_GRANTED_TOPIC = 'benefits.points.granted';

export interface PointsGrantedPayload {
  readonly user_id: number;
  /** 本次正向增量（恒 >0） */
  readonly delta: number;
  readonly kind: PointsGrantKind;
  /** 幂等引用（授予=调用方 ref；退款还原=调用方 refund ref） */
  readonly ref: string;
  /** 入账后账户可用余额快照 */
  readonly balance_after: number;
}

/** 积分核销（下单抵扣成功落账；F4 §6 生产 → H4 消费位=M2）。幂等键=order（§5）。 */
export const POINTS_REDEEMED_TOPIC = 'benefits.points.redeemed';

export interface PointsRedeemedPayload {
  readonly user_id: number;
  /** 本次核销增量（恒 <0） */
  readonly delta: number;
  readonly kind: 'REDEEM';
  /** 支付单 id（幂等键=order，F1 支付单表主键） */
  readonly order_id: number;
  /** 幂等引用（=order:{order_id}，source_ref 同文） */
  readonly ref: string;
  /** 核销后账户可用余额快照 */
  readonly balance_after: number;
}

/** 积分过期扣减（F4 §6 生产 → H4 消费位=M2）。POINTS_EXPIRE job 聚合行，逐用户一条。 */
export const POINTS_EXPIRED_TOPIC = 'benefits.points.expired';

export interface PointsExpiredPayload {
  readonly user_id: number;
  /** 本次过期扣减增量（恒 <0） */
  readonly delta: number;
  readonly kind: 'EXPIRE';
  /** EXPIRE 聚合行无业务幂等引用 → null（消费侧按 user_id+event_id 去重） */
  readonly ref: null;
  /** 扣减后账户可用余额快照 */
  readonly balance_after: number;
}

// ---------------------------------------------------------------------------
// A3b 律所进件（M1-W3 T3）：3 生产契约（消费：F3 分账前置=T8、I1 进件状态通知、
// H1 状态视图=T10——本批生产方定型契约，出箱即止）。schema=payment（进件子域归支付网关
// 持有、identity 只读，架构 §3.3-3）； materials（对公账户等）PII 禁入载荷（lj-data-security）。
// ---------------------------------------------------------------------------

/** 律所商户生效（A3b §6 生产 → F3 分账前置解除、H1 状态视图）。任何 →ACTIVE 迁移（首次
 *  进件生效 / 变更完成 / 复验恢复）均发出——「生效」是 R-01 可分账的唯一正向信号。 */
export const FIRM_MERCHANT_ACTIVATED_TOPIC = 'payment.firm_merchant.activated';

export interface FirmMerchantActivatedPayload {
  /** 律所 id（trade/pricing 域引用，bigint 裸引用口径） */
  readonly firm_id: number;
  /** 进件通道（wechat_ecom | alipay） */
  readonly channel: string;
}

/** 律所商户暂停分账（A3b §6 生产 → F3 暂停+挂起待结算、I1 通知律所）。§4「进入 SUSPENDED
 *  即发事件」；R-W3-C2 裁决：ACTIVE→CHANGING（账户变更期）同事务发出本事件（分账暂停语义
 *  与 SUSPENDED 等价，F3 查询态两态同样不可分账）。 */
export const FIRM_MERCHANT_SUSPENDED_TOPIC = 'payment.firm_merchant.suspended';

/** 暂停事由：ACCOUNT_CHANGING=对公账户变更期（R-02 + R-W3-C2）；REVERIFY_OVERDUE=年度复验
 *  到期未复验（R-03，电商法 §27）。 */
export type FirmMerchantSuspensionReason = 'ACCOUNT_CHANGING' | 'REVERIFY_OVERDUE';

export interface FirmMerchantSuspendedPayload {
  readonly firm_id: number;
  readonly channel: string;
  readonly reason: FirmMerchantSuspensionReason;
}

/** 律所复验到期（A3b §6 生产 → I1 通知律所复验、H3 处置提醒位）。FIRM_REVERIFY job 触发且
 *  商户仍 ACTIVE 未复验时发出，与 FirmMerchantSuspended(REVERIFY_OVERDUE) 同事务成对出箱；
 *  复验完成后经 POST /firms/{id}/merchant/reverify → ACTIVE（SUSPENDED→ACTIVE 守卫边）。 */
export const FIRM_MERCHANT_REVERIFIED_DUE_TOPIC = 'payment.firm_merchant.reverified_due';

export interface FirmMerchantReverifiedDuePayload {
  readonly firm_id: number;
  /** 复验到期时刻（ISO 8601 UTC；=firm_merchants.reverify_due 快照） */
  readonly due_at: string;
}
