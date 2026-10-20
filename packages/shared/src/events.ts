/**
 * 领域事件契约（骨架占位）。
 * 事件流是模块协作唯一通道（架构 §2.1 Outbox），具名清单以 docs/04 §6 为准，M0-4 起逐批充实。
 * topic 命名 = `<schema>.<entity>.<过去式动词>`（W1 起惯例，如 identity.user.registered）。
 */
import type { Money } from './money';

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

/**
 * C2B 律师拒绝/超时（C2/C4 §6 生产 → G1 消费扣分 -5 档；docs/04 §6 LawyerRejected(Timeout)）。
 * M-1 定型（W2 G-C 交接欠账，M1-W3 T5 简报裁决）：补 via_timeout 判别字段——docs/04 §6 以
 * 「LawyerRejected(Timeout)」括注区分超时变体，载荷以 boolean 承载该变体标记（命名最贴文档口径，
 * 任务报告注明）。生产方：C2 C2B_CONFIRM_TIMEOUT 超时自动拒=via_timeout=true（M1-W3 T5 落位）；
 * C4 显式拒绝=via_timeout=false（M2 落位）。G1 消费端兼容性：现按 topic 消费两档同 -5，
 * 不读取该字段——W1 旧载荷形状（无 via_timeout）运行时照常入账（credit.spec 兼容性用例钉住）。
 */
export const LAWYER_REJECTED_TOPIC = 'trade.group_buy.lawyer_rejected';

export interface LawyerRejectedPayload {
  readonly group_id: number;
  readonly lawyer_id: number;
  /** true=12h 确认超时自动拒（C2 生产）；false=律师显式拒绝（C4=M2 生产） */
  readonly via_timeout: boolean;
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

// ---------------------------------------------------------------------------
// C1 B2C 开团（M1-W3 T4）：3 生产契约（交易域 trade 首件）。消费位：SessionCreated →
// I2 预写 job 由 C1 同事务直写 registerJob 承接（事件本身=审计/通知扇出位）；SessionFull →
// C3（T7 接线）；SessionFailed → F2 批量退款（T6 接线，本批断言出箱）。
// 金额一律 Money 字符串（NUMERIC 禁 float）；时间一律 ISO 8601 UTC。
// ---------------------------------------------------------------------------

/** B2C 场次创建完成（C1 §6 生产；§6 载荷逐字 → I2 预写 ENROLL_DEADLINE、REMIND 系列、ROOM_OPEN job）。 */
export const SESSION_CREATED_TOPIC = 'trade.session.created';

export interface SessionCreatedPayload {
  /** 场次 id（trade.sessions.id） */
  readonly id: number;
  readonly lawyer_id: number;
  /** 约定开始时刻（ISO 8601；REMIND_* 锚 slot_start、ROOM_OPEN 锚 slot_start） */
  readonly slot_start: string;
  /** 报名截止时刻（ISO 8601；ENROLL_DEADLINE job 锚点） */
  readonly enroll_deadline: string;
}

/** 价格快照公共切面（SessionFull/SessionFailed 载荷共用：下游退款/违约金计算所需 ref 最小集，简报裁量） */
export interface SessionPriceRefPayload {
  readonly id: number;
  readonly lawyer_id: number;
  readonly slot_start: string;
  /** per_head | session_total */
  readonly price_mode: 'per_head' | 'session_total';
  /** 快照单价（per_head 单价 或 total÷capacity 分摊；Money 字符串） */
  readonly unit_price: string;
  /** R-04 场次总价基数（违约金计算锚点；Money 字符串） */
  readonly session_total: string;
}

/** 满员成团（C1 §6 生产 → C3 消费位=T7；FULL 推进在 C3 守卫路径，事件由 C1 markFull 出箱）。 */
export const SESSION_FULL_TOPIC = 'trade.session.full';

export type SessionFullPayload = SessionPriceRefPayload;

/** 流标（C1 §6 生产 → F2 批量退款=T6 接线；ENROLL_DEADLINE 执行器判 CREATED 且 joined<capacity）。 */
export const SESSION_FAILED_TOPIC = 'trade.session.failed';

export interface SessionFailedPayload extends SessionPriceRefPayload {
  /** 流标事由（本批唯一值：ENROLL_DEADLINE_PASSED=截止未满；后续档位随 D4/M2 扩展） */
  readonly reason: 'ENROLL_DEADLINE_PASSED';
}

// ---------------------------------------------------------------------------
// C2 C2B 发起拼团（M1-W3 T5）：3 生产契约。消费位：GroupBuyPublished → I2 截止 job 与
// B2 PENDING_PAYMENT 发布锁由 C2 同事务直写承接（事件本身=审计/通知扇出位）；GroupBuyReached
// → I2 12h 确认 job 由 C2 守卫同事务直写承接（C2 §6）；GroupBuyExpired → F2 批量退款=T6
// 接线（本批断言出箱）。金额一律 Money 字符串（NUMERIC 禁 float）；时间一律 ISO 8601 UTC。
// ---------------------------------------------------------------------------

/** C2B 拼团发布完成（C2 §6 生产；载荷逐字 → I2 截止 job + B2 PENDING_PAYMENT 发布锁）。 */
export const GROUP_BUY_PUBLISHED_TOPIC = 'trade.group_buy.published';

export interface GroupBuyPublishedPayload {
  /** 拼团任务 id（trade.group_buys.id） */
  readonly id: number;
  readonly lawyer_id: number;
  /** 约定开始时刻（ISO 8601；B2 发布锁 slot 锚） */
  readonly slot_start: string;
  /** 子范围下限（达此人数即锁人，R-05） */
  readonly sub_min: number;
  /** R-02 分摊额快照（发布时固化；Money 字符串） */
  readonly share_price: string;
}

/** 达 sub_min 锁人（C2 §6 生产；载荷逐字 {id}；12h 确认 job 与锁人同事务由 C2 直写预写）。 */
export const GROUP_BUY_REACHED_TOPIC = 'trade.group_buy.reached';

export interface GroupBuyReachedPayload {
  readonly id: number;
}

/**
 * 拼团终止·退款指令锚（C2 §4 EXPIRED 终态迁移同事务出箱 → F2 批量退款=T6 接线，本批断言出箱）。
 * reason 词汇表：DEADLINE_PASSED=截止未成（ENROLL_DEADLINE 执行器）；INITIATOR_CANCELLED=发起人
 * 取消（R-W3-L：仅无任何已支付加入者可取消，状态机无 PUBLISHED→CANCELLED 边——EXPIRED+来源
 * 注记口径，任务报告偏差节注明）。已支付加入者按 share_price 快照原路退（F2/T6 语义）。
 */
export const GROUP_BUY_EXPIRED_TOPIC = 'trade.group_buy.expired';

export type GroupBuyExpiredReason = 'DEADLINE_PASSED' | 'INITIATOR_CANCELLED';

export interface GroupBuyExpiredPayload {
  readonly id: number;
  readonly lawyer_id: number;
  /** 发起人（identity 侧用户 id；F2 退款定位第一支付人） */
  readonly initiator_id: number;
  /** R-02 分摊额快照（退款金额锚；Money 字符串） */
  readonly share_price: string;
  /** 子范围下限（F2 差额/台账语义参考） */
  readonly sub_min: number;
  readonly reason: GroupBuyExpiredReason;
}

// ---------------------------------------------------------------------------
// C3 报名与支付成团（M1-W3 T7）：1 生产契约。EnrollmentPaid = 成团原子守卫支付事务内
// 同箱出箱（§6 逐字载荷 {ref_type, ref_id, user_id, amounts}；先席位 UPDATE 后报名 PAID
// 的顺序铁律见 C3 §4/§9）——消费位：I1 成团通知（M2 接线，出箱即止）与审计扇出。
// 金额一律 Money 字符串（NUMERIC 禁 float）。
// ---------------------------------------------------------------------------

/** 支付完成·席位生效（C3 §6 生产；成团守卫事务 PENDING→PAID 同箱出箱）。 */
export const ENROLLMENT_PAID_TOPIC = 'trade.enrollment.paid';

/** 报名所属业务实体类型（B2 占用锁 ref_type 同词汇：session|groupbuy） */
export type EnrollmentRefType = 'session' | 'groupbuy';

export interface EnrollmentPaidPayload {
  /** 报名所属业务实体类型（session=B2C 场次；groupbuy=C2B 拼团） */
  readonly ref_type: EnrollmentRefType;
  /** 业务实体 id（trade.sessions.id / trade.group_buys.id） */
  readonly ref_id: number;
  /** 付款人（identity 侧用户 id） */
  readonly user_id: number;
  /** 金额拆分（paid=应付总额、cash=现金部分，Money 字符串；points=积分部分，100 积分=1 元） */
  readonly amounts: { readonly paid: Money; readonly cash: Money; readonly points: number };
}

// ---------------------------------------------------------------------------
// F2 退款处理（M1-W3 T6）：2 生产契约。消费位：RefundCompleted → C3 状态推进（T7）、
// I1 通知、H4 指标（F2 §6；I1 消费接线=M2 联调，T6 出箱即止）；RefundFailed → H3 工单
// （M2 接线）。金额一律 Money 字符串（NUMERIC 禁 float）。
// ---------------------------------------------------------------------------

/** 退款完成（F2 §6 生产 → C3 状态推进、I1、H4）。REFUND_SUCCESS 回调推进 PROCESSING→DONE 同事务出箱。 */
export const REFUND_COMPLETED_TOPIC = 'payment.refund.completed';

export interface RefundCompletedPayload {
  readonly refund_id: number;
  readonly order_id: number;
  /** 退款金额拆分（cash=原路退现金 Money 字符串；points=还原积分额，R-03 不退现） */
  readonly amounts: { readonly cash: Money; readonly points: number };
}

/** 退款失败（F2 §6 生产 → H3 工单，M2 接线；本批断言到事件出箱为止）。下发重试 3 次耗尽时出箱。 */
export const REFUND_FAILED_TOPIC = 'payment.refund.failed';

export interface RefundFailedPayload {
  readonly refund_id: number;
  readonly order_id: number;
  /** F2 §2 退款原因枚举（受理原值透传） */
  readonly reason: string;
  /** 实际下发尝试次数（耗尽值=3） */
  readonly attempts: number;
  /** 最近一次失败摘要（H3 工单记账锚点） */
  readonly last_error: string;
}

// ---------------------------------------------------------------------------
// F3 分账结算（M1-W3 T8）：3 生产契约（消费：H4 指标、F4 备付台账②全量、I1 通知=M2 联调——
// 本批生产方定型契约，出箱即止；G1 消费 SettlementDebtIncurred 发暂停接单限制令=M2 联调）。
// schema=settlement（分账状态域，架构 §3.2）。金额一律 Money 字符串（NUMERIC 禁 float）。
// 消费契约（消费方定型，R-W2-A 口径；生产方 D1/D6/D3/H3=M2 import 同一契约联调对齐）：
//   RoomClosed / TicketResolved 两件 W3 无生产方=合成事件桩（测试直投 outbox 沿 T2/T6 先例）；
//   OneOnOneSettled 已由 D6 于 M2-W3 T2 转真生产（构成基语义 M2-W4 #45-① 翻转见下方 payload
//   注记）；AttendanceAdjudicated/SessionCancelled 契约已在 D3/D4 段定型
//   （D4 调用方经 F3 内部命令 APPLY_PENALTY 扣减——R-W3-A：W3 带金额入参，快照回查=M2 换装位）；
//   FirmMerchantActivated/Suspended 为 A3b 真事件（上方段）。
// ---------------------------------------------------------------------------

/** 分账完成（F3 §6 生产 → H4/F4/I1 消费位=M2 联调；唯一解冻节点 READY→SETTLED 同事务出箱）。 */
export const SPLIT_SETTLED_TOPIC = 'settlement.split.settled';

/** 分账构成明细项（payee_type 词汇与 F1 SplitItem 对齐：lawyer_firm→律所对公；platform→平台
 *  服务费/缺席 30% 备付，无业务实体位 payee_id=0 哨兵）。 */
export interface SettlementSplitItem {
  readonly payee_type: 'lawyer_firm' | 'platform';
  readonly payee_id: number;
  readonly amount: Money;
}

export interface SplitSettledPayload {
  readonly settlement_id: number;
  readonly ref_type: 'session' | 'one_on_one';
  readonly ref_id: number;
  /** F3 §6 逐字兼容位：ref_type='session' 时=ref_id；one_on_one 时=null（订单号即 ref_id） */
  readonly session_id: number | null;
  /** 分账净额 = gross − penalty（恒等式：Σsplits === net，构成校验锚点；fee 为 splits 中平台服务费构成项） */
  readonly net: Money;
  /** 平台服务费（fee_versions 版本化；R-06 0% 起步，D20 ⚠W3 默认 0.0000） */
  readonly fee: Money;
  /** 构成全明细：律所份额 + 平台服务费 + 缺席 30% 备付份额（F4 ②全量按此记账备付台账，M2 联调） */
  readonly splits: readonly SettlementSplitItem[];
}

/** 结算挂起（F3 §6 生产 → H4/I1 消费位=M2 联调）。PENDING→HOLD（24h 冻结期，R-02）与
 *  HOLD/READY→SUSPENDED（进件非 ACTIVE 挂起，R-07）同构出箱。 */
export const SETTLEMENT_HELD_TOPIC = 'settlement.settlement.held';

export interface SettlementHeldPayload {
  readonly settlement_id: number;
  readonly ref_type: 'session' | 'one_on_one';
  readonly ref_id: number;
  readonly session_id: number | null;
  /** 挂起事由（settlements.hold_reason 同文）：HOLD_24H | OPEN_TICKETS | MERCHANT_NOT_ACTIVE */
  readonly reason: string;
}

/** 结算释放（F3 §6 生产 → H4/I1 消费位=M2 联调）。HOLD→READY：24h 到期或工单关闭后释放、
 *  进件恢复重驱动（唯一解冻分账节点 READY→SETTLED 的前置）。 */
export const SETTLEMENT_RELEASED_TOPIC = 'settlement.settlement.released';

export interface SettlementReleasedPayload {
  readonly settlement_id: number;
  readonly ref_type: 'session' | 'one_on_one';
  readonly ref_id: number;
  readonly session_id: number | null;
  /** 释放事由：HOLD_EXPIRED（24h 到期）| TICKET_RESOLVED（工单关闭释放）| MERCHANT_RECOVERED（进件恢复） */
  readonly reason: string;
}

/** 违约欠款挂账（F3 §6 生产，R-04 扣减不足时出箱 → G1 消费发 SUSPEND_TAKE 类限制令（M2 联调）、
 *  I1/H4 扇出；F3 侧只出箱——架构 §4.4「不足挂欠款+暂停接单」）。 */
export const SETTLEMENT_DEBT_INCURRED_TOPIC = 'settlement.deduction.debt_incurred';

export interface SettlementDebtIncurredPayload {
  readonly lawyer_id: number;
  /** 律所（有结算行锚定时携带；无行可锚=全部走保证金亦不足时为 null） */
  readonly firm_id: number | null;
  /** 未能收回的欠款额（待结算余额与保证金专户均不足部分） */
  readonly amount: Money;
  /** 违约基数引用（C3 价格快照实体；APPLY_PENALTY base_ref 透传） */
  readonly ref_type: string;
  readonly ref_id: number;
}

/** 房间关闭（D1 §6 生产，M2 落位 → F3 结算进 PENDING（R-01 链头）、F2 无人到场退款、H2。
 *  W3=F3 合成事件桩（测试直投 outbox）；契约由消费方 F3 定型（R-W2-A）：载荷携带结算构成
 *  所需最小集——F3 禁跨 schema 读 trade/F1（架构 §3.2），gross 为入账总额快照、
 *  payment_order_id 为 F1 分账指令定位（W3 单单绑定；多单会话=M2 D1 联调换装位）。 */
export const ROOM_CLOSED_TOPIC = 'fulfillment.room.closed';

export interface RoomClosedPayload {
  readonly session_id: number;
  readonly lawyer_id: number;
  readonly firm_id: number;
  /** 入账总额快照（F1 冻结额口径；F3 结算基数） */
  readonly gross: Money;
  /** F1 支付单 id（RUN_SETTLE 的 /pay/split 指令定位；R-07 assertSplittable 取通道） */
  readonly payment_order_id: number;
}

/** 1对1 结算完成（D6 §6 生产 → F3 结算进 PENDING；M2-W3 T2 已转真生产——W3 合成桩口径作废）。
 *  载荷 {order_id, gross, net} 为 F3 §3 逐字 + lawyer_id/firm_id/payment_order_id 增补
 *  （结算行归属与 F1 分账指令定位，契约定型注记）。构成基语义 M2-W4 #45-① 翻转：net=结算
 *  构成基（实结净额/取消②③保留额——F3 构成与平台费按此计算，settlements.gross 列承载），
 *  gross=预付全额参考（多退少补/取消退差在 D6/F2 完成，不参与构成；payload shape 不变=
 *  非破坏性对齐）。 */
export const ONE_ON_ONE_SETTLED_TOPIC = 'fulfillment.one_on_one.settled';

export interface OneOnOneSettledPayload {
  readonly order_id: number;
  readonly lawyer_id: number;
  readonly firm_id: number;
  /** 预付全额（参考快照：不参与 F3 构成——构成基=net，W4 #45-①） */
  readonly gross: Money;
  /** 结算构成基（实结净额/取消②③保留额：F3 构成计算与平台费基数，W4 #45-①） */
  readonly net: Money;
  readonly payment_order_id: number;
}

/** 纠纷工单关闭（H3 §6 生产，M2 落位 → F3 HOLD 释放（R-02 工单挂起解除）；W3=F3 合成事件桩）。
 *  ref=纠纷关联的结算实体（settlements.ref 词汇）。 */
export const TICKET_RESOLVED_TOPIC = 'ops.ticket.resolved';

export interface TicketResolvedPayload {
  readonly ticket_id: number;
  readonly ref_type: 'session' | 'one_on_one';
  readonly ref_id: number;
}

// ---------------------------------------------------------------------------
// C6 改价与补偿（M1-W3 T9）：3 生产契约。PriceChangeApproved 已在 G1 段由消费端 W2 钉形
// （上方 PRICE_CHANGE_APPROVED_TOPIC——C6 生产方 import 同一契约，不重定义，R-W2-A 口径）。
// 消费位：PriceChangeRejected/PriceRevoked 出箱即止（审计+I1 通知扇出位，I1/C1=M2 联调）；
// PriceCouponInstructed → F4 券发放=②全量（M2-W2 消费；积分补偿不走本事件——F4 ①切片已暴露
// PointsService.grant COMPENSATION 授予原语，C6 直调真链，幂等键=(user_id, COMPENSATION,
// price_change:{id})，简报 T9「真链优先」裁决）。
// ---------------------------------------------------------------------------

/** 改价审批否决（C6 §6 生产 → 审计/I1 通知扇出位；版本不生效、不出信用事件——approved=false）。
 *  载荷与 PriceChangeApproved 三字段同形对称（kind=被否决改价的档位归类，审计口径）。 */
export const PRICE_CHANGE_REJECTED_TOPIC = 'pricing.price_change.rejected';

export interface PriceChangeRejectedPayload {
  readonly price_change_id: number;
  readonly lawyer_id: number;
  readonly kind: PriceChangeKind;
}

/** 改价撤销（C6 §6/R-04 生产 → 审计+受影响用户通知扇出位=M2 联调）。撤销不扣信用：
 *  载荷无 kind 档位字段（G1 不消费本事件；受影响用户恢复原价，无信用/补偿语义）。 */
export const PRICE_REVOKED_TOPIC = 'pricing.price_change.revoked';

export interface PriceRevokedPayload {
  readonly price_change_id: number;
  readonly lawyer_id: number;
}

/** 券补偿发放指令（C6 §6/R-01 降价>10% 档生产 → F4 券=②全量 M2-W2 消费）。券面额/有效期
 *  PRD §8.2 未定义（⚠04 待澄清）——载荷不发明金额字段，F4 ②按 H7 规则配置落值；coupon_kind
 *  为发放口径标记（PRICE_COMP=改价补偿券），幂等锚=(price_change_id, user_id)。 */
export const PRICE_COUPON_INSTRUCTED_TOPIC = 'pricing.price_coupon.instructed';

export interface PriceCouponInstructedPayload {
  readonly price_change_id: number;
  readonly lawyer_id: number;
  /** 受影响用户（identity 侧用户 id；=补偿对象 PAID enrollment 付款人） */
  readonly user_id: number;
  readonly coupon_kind: 'PRICE_COMP';
}

// ---------------------------------------------------------------------------
// M2-W1 通信与房间（T0 契约冻结）：D1 3 生产 + D5 6 生产 + OneOnOnePaid 消费钉形 +
// D2 1 生产 + I3 2 生产。RoomClosed 已在上方 F3 段定型（消费方钉形先例 R-W2-A），
// 本批不重定义；D5 消费 OneOnOnePaid（生产方 D6=W3，本批合成事件桩验证、W4 转正）。
// 载荷铁律：MessageSent 载荷不含 content（D5 §9「明文 PII 落 MQ 载荷」禁令——消费者
// 按需回查 messages 表）；全部时刻字段 ISO 8601 UTC 即时串。
// ---------------------------------------------------------------------------

/** 房间开启（D1 §6 生产 → D2 宽限开始房间内提醒、H2 监控）。grace_end 锚定约定开始时刻
 *  scheduled_start+5min（R-01：不随 opened_at 漂移——载荷直载该锚点，消费者免二次推算）。 */
export const ROOM_OPENED_TOPIC = 'fulfillment.room.opened';

export interface RoomOpenedPayload {
  readonly room_id: number;
  readonly session_id: number;
  /** 宽限截止时刻（ISO 8601 UTC；= scheduled_start + 5min，锚定约定开始时刻） */
  readonly grace_end: string;
}

/** 宽限期结束（D1 §6 生产 → D3 到场判定（W2 消费）、D2 结束前 1min 提醒锚点）。
 *  W1 executor 落 D1（发事件即止，判定禁前置——D1 §9）；catalog GRACE_END executor
 *  字段语义=最终判定方 D3=W2 事件消费。 */
export const GRACE_PERIOD_ENDED_TOPIC = 'fulfillment.grace_period.ended';

export interface GracePeriodEndedPayload {
  readonly room_id: number;
  readonly session_id: number;
}

/** 开房失败（D1 §6 生产 → D4 平台取消分支（W2 消费）、F2 全额退款（W2）、H2）。
 *  reason=开放词汇审计口径（mock 适配器错误码/RTC 回调失败因），非 PII。 */
export const ROOM_OPEN_FAILED_TOPIC = 'fulfillment.room.open_failed';

export interface RoomOpenFailedPayload {
  readonly session_id: number;
  readonly reason: string;
}

/** 消息已发送（D5 §6 生产 → E1 草稿管线（W3）、H5 二次模型复核（REVIEW 命中筛））。
 *  载荷不含 content（PII 铁律）：E1/H5 按 conversation_id+seq 回查 messages 表；
 *  risk_flag=PASS|BLOCKED|REVIEW（BLOCKED 消息不出箱——拒发即无事件，本事件仅 PASS/REVIEW）。 */
export const MESSAGE_SENT_TOPIC = 'fulfillment.conversation.message_sent';

export interface MessageSentPayload {
  readonly conversation_id: number;
  readonly seq: number;
  readonly risk_flag: 'PASS' | 'REVIEW';
}

/** 在场加入（D5 §6 生产 → D3 宽限结束时点快照（W2 消费）；架构 §3.3-1 presence 权威链路：
 *  at-least-once + 房间时刻戳）。at=服务器接收时刻（DB 钟口径），D3 判定以宽限结束快照为准。 */
export const PRESENCE_JOINED_TOPIC = 'fulfillment.presence.joined';

/** 在场离开（D5 §6 生产 → D3（W2 消费）；口径同 PresenceJoined）。 */
export const PRESENCE_LEFT_TOPIC = 'fulfillment.presence.left';

export interface PresencePayload {
  readonly conversation_id: number;
  /** 会话锚定的房间/订单引用（room 会话=rooms.id） */
  readonly ref_id: number;
  readonly user_id: number;
  readonly role: 'user' | 'lawyer';
  /** 房间时刻戳（ISO 8601 UTC） */
  readonly at: string;
}

/** 录制同意已给出（D5 §6 生产 → H9 审计；双门判定在 D5 同步完成——双方齐才调 RTC 云录制，
 *  本事件为审计留痕非门控信号）。拼单房间默认不录制（D10 边界声明，consent 门仅 1对1）。 */
export const RECORDING_CONSENT_GIVEN_TOPIC = 'fulfillment.recording.consent_given';

export interface RecordingConsentGivenPayload {
  readonly conversation_id: number;
  /** 给出同意的一方（identity 侧用户 id） */
  readonly party_id: number;
}

/** 训练语料删除执行回执（D5+I3 §6 生产 → A2 授权状态回写、H9 监督；消费
 *  TrainingConsentRevoked 后执行）。hot_count=messages 语料标记删除数、cold_count=I3 冷存
 *  物理删除数（D5 管标记、I3 管冷存物理删除——I3 §7 R-03 分工）。 */
export const TRAINING_DATA_PURGED_TOPIC = 'fulfillment.training_data.purged';

export interface TrainingDataPurgedPayload {
  readonly user_id: number;
  readonly hot_count: number;
  readonly cold_count: number;
}

/** 1对1 会话已创建（D5 §6 生产（消费 OneOnOnePaid 后）→ D6 流程推进、H4）。
 *  W1 D5 消费端以合成事件桩验证（05 §6.1 W1 行），生产真链=D6 W3 落位、W4 转正。 */
export const ONE_ON_ONE_CONVERSATION_CREATED_TOPIC = 'fulfillment.one_on_one.conversation_created';

export interface OneOnOneConversationCreatedPayload {
  readonly conversation_id: number;
  readonly order_id: number;
  readonly user_id: number;
  readonly lawyer_id: number;
}

/** 1对1 预付完成（D6 §6 生产=W3 → D5 建 one_on_one 会话、F1/F3、I2 超时 job、H4）。
 *  契约由 W1 消费方 D5 钉形（R-W2-A 口径）：载荷取 D5 建会话最小集；D6 W3 落位时
 *  可向后兼容扩字段（amount 等由 D6/F3 侧按需增补），W1 不预发明。 */
export const ONE_ON_ONE_PAID_TOPIC = 'fulfillment.one_on_one.paid';

export interface OneOnOnePaidPayload {
  readonly order_id: number;
  readonly user_id: number;
  readonly lawyer_id: number;
}

/** 提醒已分发（D2 §6 生产 → H4 到达率统计（W2 管道））。kind=I2 jobType 词汇
 *  （REMIND_24H|REMIND_1H|REMIND_10MIN|REMIND_1MIN）；ref=enrollment/session 双锚。 */
export const REMINDER_DISPATCHED_TOPIC = 'notify.reminder.dispatched';

export interface ReminderDispatchedPayload {
  readonly ref_type: 'enrollment' | 'session';
  readonly ref_id: number;
  readonly user_id: number;
  readonly kind: 'REMIND_24H' | 'REMIND_1H' | 'REMIND_10MIN' | 'REMIND_1MIN';
}

/** 录音归档完成（I3 §6 生产 → H9 存证审计）。hash_sha256 不入载荷（artifacts 表可查，
 *  最小化）；evidence_id=存证平台凭证（dev=mock 适配器生成，D-P9 至信链真对接后换装）。 */
export const RECORDING_ARCHIVED_TOPIC = 'platform.artifact.recording_archived';

export interface RecordingArchivedPayload {
  readonly artifact_id: number;
  readonly evidence_id: string;
  /** 关联订单/会话引用（1对1 订单锚） */
  readonly ref_type: string;
  readonly ref_id: number;
}

/** 存档到期处置完成（I3 §6 生产 → H9 审计）。kind=artifacts.kind 词汇。 */
export const ARTIFACT_PURGED_TOPIC = 'platform.artifact.purged';

export interface ArtifactPurgedPayload {
  readonly artifact_id: number;
  readonly kind: 'recording' | 'export' | 'credential' | 'cold_message' | 'recon_file';
}

// ---------------------------------------------------------------------------
// M2-W2 判定与违约批（T0 契约冻结，执行计划附录 A.1）：本段按任务逐条追加——T1 落
// ops.ticket.created（H3）；T2/T4/T5/T6 的 topic 随各自任务在本段追加（生产/消费方注记
// 见附录 A.1 表）。载荷铁律延续：禁明文内容/凭据（PII 红线）。
// ---------------------------------------------------------------------------

/** 工单类型词汇（H3 §2/§3 七值全集；ops 侧 DDL ck 与服务层枚举的契约锚）。
 *  dispute=用户申诉纠纷 / refund_review=退款审核 / price_change=改价审批 /
 *  cancel_lt24h=律师 <24h 取消审批 / reconciliation=对账差异 / dead_letter=死信 /
 *  export_recording=录制调取。 */
export const TICKET_CATEGORIES = [
  'dispute',
  'refund_review',
  'price_change',
  'cancel_lt24h',
  'reconciliation',
  'dead_letter',
  'export_recording',
] as const;

export type TicketCategory = (typeof TICKET_CATEGORIES)[number];

/** 工单创建（H3 §6 生产，M2-W2 T1 → H4 指标管道、I1 分派通知位（联调后置））。
 *  SLA 口径（H3 §2）：sla_due 锚=建单时刻（DB 钟），reconciliation=24h 硬 / 其余=48h 软；
 *  ref_* 缺省=人工工单无幂等锚（⚠W2-9：事件工单幂等键=category+ref，DB 部分唯一兜底）。 */
export const TICKET_CREATED_TOPIC = 'ops.ticket.created';

export interface TicketCreatedPayload {
  readonly ticket_id: number;
  readonly category: TicketCategory;
  /** 关联实体类型（session/recon_period/refund/pricing_history 等开放词汇；人工工单缺省） */
  readonly ref_type?: string;
  readonly ref_id?: number;
  /** SLA 到期时刻（ISO 8601 UTC） */
  readonly sla_due: string;
  /** 优先级（1-5，缺省 3；PRD 未定义档位语义=占位值） */
  readonly priority: number;
}

/** 房间进入服务（D3 §6 生产，M2-W2 T2 → H4 房间时点口径、H2 监控位；附录 A.1 冻结形状）。
 *  触发=grace_end 判定「律师在场且 ≥1 用户在场」→ room OPEN→IN_SERVICE（守卫+STL）同事务出箱；
 *  载荷最小集 {room_id, session_id}（消费方按需回查，禁 PII——同段载荷铁律）。
 *  AttendanceAdjudicated/SessionCancelled 既有契约本批不重定义（shared 已定型=M1 消费面
 *  （G1/F3）在用形状；D3 §6 文档形 {room_id,user_id,role,status} 与 shared 冲突时以 shared
 *  既有为准——adjudication_id=attendances 行 id，禁双写漂移，任务裁定口径）。 */
export const ROOM_IN_SERVICE_TOPIC = 'fulfillment.room.in_service';

export interface RoomInServicePayload {
  readonly room_id: number;
  readonly session_id: number;
}

/** 律师确认拼团（C4 §6 生产，M2-W2 T4 → I1 通知（联调后置）、H4 管道；附录 A.1 冻结形状）。
 *  确认事务=PENDING_LAWYER→CONFIRMED + 同事务生成 mode='C2B' 履约 Session + 参与者报名行
 *  迁移（新建行+prev 回链+旧行 CONVERTED_OUT）；session_id=该履约 Session（R-04 rooms 锚）。 */
export const GROUP_BUY_LAWYER_CONFIRMED_TOPIC = 'trade.group_buy.lawyer_confirmed';

export interface GroupBuyLawyerConfirmedPayload {
  readonly gb_id: number;
  readonly session_id: number;
  readonly lawyer_id: number;
}

/** 认领转化 C2B→B2C（C4 §6 生产，M2-W2 T4 → I1 24h 窗通知（联调后置）、F2 CONVERT_WINDOW
 *  受理（R-03 用户 24h 退款窗）、H4 管道；附录 A.1 冻结形状）。capacity=转化后 B2C 场次容量
 *  （默认=sub_max）；migrated_users=被迁移参与者 user_id 清单（快照价迁移，R-02）。 */
export const GROUP_BUY_CONVERTED_TOPIC = 'trade.group_buy.converted';

export interface GroupBuyConvertedPayload {
  readonly gb_id: number;
  readonly session_id: number;
  readonly capacity: number;
  /** 被迁移参与者（原 groupbuy PAID 报名的 user_id；空数组=零参与转化） */
  readonly migrated_users: readonly number[];
}

/** 改期申请（C5 §6 生产，M2-W2 T5 → I1 通知律师（联调后置）、H4 管道；附录 A.1 冻结形状）。
 *  申请事务=PENDING 行落库+RESCHEDULE_CONFIRM_TIMEOUT job 预写（due=requested_at+12h）+
 *  本事件出箱同事务；user_id=报名属主（幂等键=enrollment：已有 PENDING 请求幂等返回）。 */
export const RESCHEDULE_REQUESTED_TOPIC = 'trade.reschedule.requested';

export interface RescheduleRequestedPayload {
  readonly request_id: number;
  readonly enrollment_id: number;
  readonly user_id: number;
  readonly target_session_id: number;
}

/** 改期确认（C5 §6 生产，M2-W2 T5 → D2 提醒重投消费（防御复核）、I1 通知用户（联调后置）、
 *  H4 管道；附录 A.1 冻结形状）。确认事务=目标空位守卫+旧报名 RESCHEDULED_OUT+新建行
 *  （快照复制 R-03+prev 回链）+目标 joined+1+本事件出箱同事务；session_id=目标场次
 *  （target_session_id——D2 消费按此复核迁移链）。 */
export const RESCHEDULE_CONFIRMED_TOPIC = 'trade.reschedule.confirmed';

export interface RescheduleConfirmedPayload {
  readonly old_enrollment_id: number;
  readonly new_enrollment_id: number;
  readonly session_id: number;
  readonly user_id: number;
}

/** 券发放（F4 §6 生产，M2-W2 T6 → I1 通知（联调后置）、H4 管道；附录 A.1 冻结形状）。
 *  发放事务=coupon_grants ACTIVE 行落库（UNIQUE(source,source_ref)=C6 指令幂等兜底）+
 *  本事件出箱同事务；face_value=发放时点券定义快照（Money 字符串；定义源=H7 配置
 *  coupon.price_comp 现行版，无现行版回退 V43 seed 行——面额 PRD 未定义 ⚠待产品拍板）；
 *  expires_at=granted_at+validity_days（ISO 8601 UTC 即时串）。 */
export const COUPON_GRANTED_TOPIC = 'benefits.coupon.granted';

export interface CouponGrantedPayload {
  readonly grant_id: number;
  readonly user_id: number;
  readonly coupon_id: number;
  /** 券面额快照（元；Money 字符串禁 float） */
  readonly face_value: Money;
  /** 到期时刻（ISO 8601 UTC） */
  readonly expires_at: string;
}

/** 备付对平差异（F4 §8 生产，M2-W2 T6 → H3 工单消费（category=reconciliation，R-03 SLA
 *  24h 硬）；**附录 A.1 之外的任务增量 topic**——控制者已裁定工单类目复用 reconciliation
 *  +title 区分「备付对平差异」，但 ReconciliationDiffFound 载荷为 payment 对账形状
 *  （channel/amount）且其消费幂等锚=recon_period，复用将混淆两期口径；经事件面接线是为
 *  规避模块环（Benefits→Ticket→PricingChange→Benefits——ReconciliationDiffFound 先例
 *  同为事件面建单）。period=对平轮次上海日（工单幂等锚=yyyymmdd 数值化）；三个金额口径
 *  一律 int 分（points_outstanding=Σ账户 balance+frozen；reserve_net=Σ台账 amount×100；
 *  diff=前者-后者，非零即不平）。 */
export const RESERVE_DIFF_FOUND_TOPIC = 'benefits.reserve.diff_found';

export interface ReserveDiffFoundPayload {
  /** 对平轮次（YYYY-MM-DD，上海日） */
  readonly period: string;
  /** 未兑付积分余额（分；Σpoints_accounts.balance+frozen） */
  readonly points_outstanding_cents: number;
  /** 备付台账净额（分；Σreserve_ledgers.amount×100） */
  readonly reserve_net_cents: number;
  /** 差额（分；=points_outstanding-reserve_net，非零即不平） */
  readonly diff_cents: number;
}

/** 缺席分成悬空（F4 §8 生产，M2-W2 T6 修复环 I-3 → H3 工单消费（category=reconciliation，
 *  title 区分「分成悬空」）；**A.1 外任务增量 topic（控制者修复环裁定）**——RESERVE_RECONCILE
 *  日终对平的附带核对：AttendanceAdjudicated 判定流静默超 48h 的场次、存在到场用户、
 *  该场全部缺席判定在册，但 benefits 积分流水无对应 ABSENCE_SHARE 授予（absence:{session_id}
 *  锚）→ 应发未发检出（判定完成门经事件留痕重放——不跨域读 fulfillment attendances）。
 *  幂等锚=工单 (reconciliation, absence_session, session_id)——一场一工单；载荷禁 PII 延续。 */
export const ABSENCE_SHARE_DANGLING_TOPIC = 'benefits.absence.share_dangling';

export interface AbsenceShareDanglingPayload {
  readonly session_id: number;
  /** 判定为缺席的用户数（事件留痕去重） */
  readonly absent_users: number;
  /** 判定为到场/旁听的用户数（受领人非空——pool 有受领面） */
  readonly attending_users: number;
}

// ---------------------------------------------------------------------------
// M2-W3 1对1 与 AI 管线批（T0 契约冻结，执行计划附录 A.1）：本段 D6 五新 topic（E1 两 topic
// 随 T4 在本段追加）；OneOnOnePaid（D5 W1 消费钉形）/ OneOnOneSettled（F3 W2 定型）既有契约
// 不重定义——D6 本批转真生产（OneOnOneSettled 构成基语义于 M2-W4 T1 翻转：net=构成基/
// gross=预付参考，见 F3 段 payload 注记）。载荷铁律延续：金额 Money 字符串禁 float、禁明文内容/凭据。
// ---------------------------------------------------------------------------

/** 律师接单（D6 §6 生产 → I1 通知（联调后置）、H4 管道；附录 A.1 冻结形状）。
 *  conversation_id 可空（W3-13 回填锚）：会话由 D5 消费 OneOnOnePaid 异步建——accept 早于
 *  D5 消费落地时为 null，后续消息面/查询面回填（订单 conversation_id 列 NULL 同款取舍）。 */
export const ONE_ON_ONE_ACCEPTED_TOPIC = 'fulfillment.one_on_one.accepted';

export interface OneOnOneAcceptedPayload {
  readonly order_id: number;
  readonly conversation_id: number | null;
  readonly lawyer_id: number;
}

/** 接单超时（D6 §6 生产 → F2 全额退款 OOO_TIMEOUT 受理、H4；附录 A.1 冻结形状）。
 *  payment_order_id 增补（任务 T2 裁定）：F2 消费定位 F1 预付单的资金面免跨域查锚。 */
export const ONE_ON_ONE_LAWYER_TIMEOUT_TOPIC = 'fulfillment.one_on_one.lawyer_timeout';

export interface OneOnOneLawyerTimeoutPayload {
  readonly order_id: number;
  readonly user_id: number;
  readonly payment_order_id: number;
}

/** 服务完成（D6 §6 生产 → I1 实结确认提醒（联调后置）、H4；附录 A.1 冻结形状）。
 *  consumed_units=系统计量值（finish 声明仅校验回执——advisory 口径，不采信虚报）；
 *  settle_amount=完成时点暂估实结（unit_price×consumed_units；双方确认值可后置于 SETTLING 落定）。 */
export const ONE_ON_ONE_FINISHED_TOPIC = 'fulfillment.one_on_one.finished';

export interface OneOnOneFinishedPayload {
  readonly order_id: number;
  readonly user_id: number;
  readonly lawyer_id: number;
  readonly consumed_units: number;
  readonly settle_amount: Money;
}

/** 补差待付（D6 §6 生产 → I1 补差支付提醒（联调后置）、H4；附录 A.1 冻结形状）。
 *  diff_amount=实结−预付的差额（Money 字符串）；补差单未经用户确认支付不扣款（R-02）。 */
export const ONE_ON_ONE_DIFF_PENDING_TOPIC = 'fulfillment.one_on_one.diff_pending';

export interface OneOnOneDiffPendingPayload {
  readonly order_id: number;
  readonly user_id: number;
  readonly diff_amount: Money;
}

/** 补差超时未付（D6 §6 生产 → G1 信用记录（档位=W3-11 对齐既有档位）、H4；附录 A.1 冻结形状）。
 *  触发=DIFF_PENDING 15min 未付→按已服务比例结算（settle=prepaid，订单已同事务 SETTLED）。 */
export const ONE_ON_ONE_DIFF_UNPAID_TOPIC = 'fulfillment.one_on_one.diff_unpaid';

export interface OneOnOneDiffUnpaidPayload {
  readonly order_id: number;
  readonly user_id: number;
}

// —— E1 两 topic（M2-W3 T4；附录 A.1 冻结形状）——
// 载荷 PII 铁律（E1 铁律延续）：question_digest 已脱敏、草稿正文/原文禁入载荷——消费者按需
// 经 fulfillment 导出接口回查（原文只在进程内传递）。

/** 草稿生成（E1 §6 生产 → H4 草稿延迟+采用率分母；附录 A.1 冻结形状）。
 *  latency_ms=四段（脱敏/意图/检索/生成）总耗时；segment_ms=各段打点（§8 预算口径：
 *  sanitize≤1s / intent≤1s / rag≤2s / llm≤4s，总 P95≤8s）。 */
export const DRAFT_GENERATED_TOPIC = 'agent_assist.draft.generated';

export interface DraftGeneratedPayload {
  readonly draft_id: number;
  readonly room_id: number;
  readonly conversation_id: number;
  readonly target_user_id: number;
  readonly latency_ms: number;
  readonly segment_ms: Readonly<{
    sanitize: number;
    intent: number;
    rag: number;
    llm: number;
  }>;
}

/** 草稿动作（E1 §6 生产 → H4 采用率分子（send|edit_send）、E2 待办（M4）；附录 A.1 冻结形状）。
 *  action=律师三动作；review_ms=草稿 created_at→动作时刻耗时（§8 审查耗时）。 */
export const DRAFT_ACTIONED_TOPIC = 'agent_assist.draft.actioned';

export interface DraftActionedPayload {
  readonly draft_id: number;
  readonly room_id: number;
  readonly action: 'send' | 'edit_send' | 'discard';
  readonly review_ms: number;
}
