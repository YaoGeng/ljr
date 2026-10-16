import { describe, expect, it } from 'bun:test';
import {
  ACCOUNT_DELETION_EXECUTED_TOPIC,
  AccountDeletionExecutedPayload,
  ATTENDANCE_ADJUDICATED_TOPIC,
  AttendanceAdjudicatedPayload,
  CREDIT_EVENT_EMITTED_TOPIC,
  CreditEventEmittedPayload,
  LAWYER_AUDIT_PASSED_TOPIC,
  LawyerAuditPassedPayload,
  LAWYER_REJECTED_TOPIC,
  LawyerRejectedPayload,
  PAYMENT_CALLBACK_INBOXED_TOPIC,
  PaymentCallbackInboxedPayload,
  POINTS_EXPIRED_TOPIC,
  POINTS_GRANTED_TOPIC,
  POINTS_REDEEMED_TOPIC,
  PointsExpiredPayload,
  PointsGrantedPayload,
  PointsRedeemedPayload,
  PointsTxnKind,
  PRICE_CHANGE_APPROVED_TOPIC,
  PRICE_VERSION_CREATED_TOPIC,
  PriceChangeApprovedPayload,
  PriceChangeKind,
  PriceVersionCreatedPayload,
  REAL_NAME_VERIFIED_TOPIC,
  RECONCILIATION_DIFF_FOUND_TOPIC,
  ReconciliationDiffFoundPayload,
  CHANNEL_DEGRADED_TOPIC,
  ChannelDegradedPayload,
  FIRM_MERCHANT_ACTIVATED_TOPIC,
  FirmMerchantActivatedPayload,
  FIRM_MERCHANT_REVERIFIED_DUE_TOPIC,
  FirmMerchantReverifiedDuePayload,
  FIRM_MERCHANT_SUSPENDED_TOPIC,
  FirmMerchantSuspensionReason,
  FirmMerchantSuspendedPayload,
  RESTRICTION_ISSUED_TOPIC,
  RealNameVerifiedPayload,
  RestrictionIssuedPayload,
  REVIEW_SUBMITTED_TOPIC,
  ReviewSubmittedPayload,
  SESSION_CANCELLED_TOPIC,
  SessionCancelledPayload,
  SESSION_CREATED_TOPIC,
  SessionCreatedPayload,
  SESSION_FAILED_TOPIC,
  SessionFailedPayload,
  SESSION_FULL_TOPIC,
  SessionFullPayload,
  GROUP_BUY_PUBLISHED_TOPIC,
  GroupBuyPublishedPayload,
  GROUP_BUY_REACHED_TOPIC,
  GroupBuyReachedPayload,
  GROUP_BUY_EXPIRED_TOPIC,
  GroupBuyExpiredPayload,
  TRAINING_CONSENT_GRANTED_TOPIC,
  TRAINING_CONSENT_REVOKED_TOPIC,
  TrainingConsentGrantedPayload,
  TrainingConsentRevokedPayload,
  USER_REGISTERED_TOPIC,
  UserRegisteredPayload,
} from './events';

describe('A1 身份事件契约（M1-W2）：topic 命名 + 载荷形状（PII 禁入载荷）', () => {
  it('UserRegistered：topic=identity.user.registered，{user_id, utm?}', () => {
    expect(USER_REGISTERED_TOPIC).toBe('identity.user.registered');
    const payload: UserRegisteredPayload = { user_id: 1 };
    expect(payload.user_id).toBe(1);
    expect(payload.utm).toBeUndefined();
  });

  it('LawyerAuditPassed：topic=identity.lawyer.audit.passed，{lawyer_user_id, firm_id}', () => {
    expect(LAWYER_AUDIT_PASSED_TOPIC).toBe('identity.lawyer.audit.passed');
    const payload: LawyerAuditPassedPayload = { lawyer_user_id: 2, firm_id: 3 };
    expect(payload).toEqual({ lawyer_user_id: 2, firm_id: 3 });
  });

  it('AccountDeletionExecuted：topic=identity.account.deletion.executed，{user_id}', () => {
    expect(ACCOUNT_DELETION_EXECUTED_TOPIC).toBe('identity.account.deletion.executed');
    const payload: AccountDeletionExecutedPayload = { user_id: 4 };
    expect(payload.user_id).toBe(4);
  });
});

describe('A2 实名与同意事件契约（M1-W2）：topic 命名 + 载荷形状（PII 禁入载荷）', () => {
  it('RealNameVerified：topic=identity.realname.verified，{user_id} 最小化', () => {
    expect(REAL_NAME_VERIFIED_TOPIC).toBe('identity.realname.verified');
    const payload: RealNameVerifiedPayload = { user_id: 5 };
    expect(payload).toEqual({ user_id: 5 });
  });

  it('TrainingConsentGranted：topic=identity.consent.training.granted，{user_id, policy_version, room_ids?}', () => {
    expect(TRAINING_CONSENT_GRANTED_TOPIC).toBe('identity.consent.training.granted');
    const withRooms: TrainingConsentGrantedPayload = {
      user_id: 6,
      policy_version: 'v1.0.0',
      room_ids: [101, 102],
    };
    expect(withRooms.room_ids).toEqual([101, 102]);
    const global: TrainingConsentGrantedPayload = { user_id: 6, policy_version: 'v1.0.0' };
    expect(global.room_ids).toBeUndefined();
  });

  it('TrainingConsentRevoked：topic=identity.consent.training.revoked，{user_id, revoked_at(ISO)}', () => {
    expect(TRAINING_CONSENT_REVOKED_TOPIC).toBe('identity.consent.training.revoked');
    const payload: TrainingConsentRevokedPayload = {
      user_id: 7,
      revoked_at: '2026-10-16T12:00:00.000Z',
    };
    expect(payload.revoked_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe('B3 价格版本事件契约（M1-W2）：topic 命名 + 载荷形状', () => {
  it('PriceVersionCreated：topic=pricing.price_version.created，{lawyer_id, version}', () => {
    expect(PRICE_VERSION_CREATED_TOPIC).toBe('pricing.price_version.created');
    const payload: PriceVersionCreatedPayload = { lawyer_id: 9101, version: 3 };
    expect(payload).toEqual({ lawyer_id: 9101, version: 3 });
  });
});

describe('G1 信用体系事件契约（M1-W2）：生产 2 + 消费 5（消费端钉契约，生产方 W3/M2 对齐）', () => {
  it('CreditEventEmitted：topic=credit.event.emitted，{owner, action, delta, score_after, rule_version, ref}', () => {
    expect(CREDIT_EVENT_EMITTED_TOPIC).toBe('credit.event.emitted');
    const payload: CreditEventEmittedPayload = {
      owner_type: 'lawyer',
      owner_id: 9101,
      action: 'lawyer_absent',
      delta: -50,
      score_after: 50,
      rule_version: 1,
      ref_type: 'attendance',
      ref_id: 77,
    };
    expect(payload.score_after).toBe(50);
  });

  it('RestrictionIssued：topic=credit.restriction.issued，{owner, kind, until(ISO)}', () => {
    expect(RESTRICTION_ISSUED_TOPIC).toBe('credit.restriction.issued');
    const payload: RestrictionIssuedPayload = {
      owner_type: 'lawyer',
      owner_id: 9101,
      kind: 'SUSPEND_TAKE_7D',
      until: '2026-10-23T12:00:00.000Z',
    };
    expect(payload.until).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('LawyerRejected：topic=trade.group_buy.lawyer_rejected，{group_id, lawyer_id, via_timeout}（M-1 定型：via_timeout 判别字段，docs/04 §6 LawyerRejected(Timeout) 变体注记的载荷承载）', () => {
    expect(LAWYER_REJECTED_TOPIC).toBe('trade.group_buy.lawyer_rejected');
    // 显式拒绝（C4=M2 生产）：via_timeout=false
    const explicit: LawyerRejectedPayload = { group_id: 11, lawyer_id: 9101, via_timeout: false };
    expect(explicit).toEqual({ group_id: 11, lawyer_id: 9101, via_timeout: false });
    // 12h 超时自动拒（C2 C2B_CONFIRM_TIMEOUT 生产）：via_timeout=true
    const timedOut: LawyerRejectedPayload = { group_id: 12, lawyer_id: 9101, via_timeout: true };
    expect(timedOut.via_timeout).toBe(true);
  });

  it('PriceChangeApproved：topic=pricing.price_change.approved，{price_change_id, lawyer_id, kind 三档}', () => {
    expect(PRICE_CHANGE_APPROVED_TOPIC).toBe('pricing.price_change.approved');
    const kinds: PriceChangeKind[] = ['PRICE_UP', 'PRICE_DOWN_LE10', 'PRICE_DOWN_GT10'];
    const payload: PriceChangeApprovedPayload = {
      price_change_id: 21,
      lawyer_id: 9101,
      kind: kinds[2]!,
    };
    expect(payload.kind).toBe('PRICE_DOWN_GT10');
  });

  it('AttendanceAdjudicated：topic=fulfillment.attendance.adjudicated，{adjudication_id, session_id, owner, result}', () => {
    expect(ATTENDANCE_ADJUDICATED_TOPIC).toBe('fulfillment.attendance.adjudicated');
    const payload: AttendanceAdjudicatedPayload = {
      adjudication_id: 31,
      session_id: 32,
      owner_type: 'user',
      owner_id: 601,
      result: 'absent',
    };
    expect(payload.result).toBe('absent');
  });

  it('SessionCancelled：topic=fulfillment.session.cancelled，{session_id, cancelled_by, cancelled_by_user_id, cancelled_at, session_start_at}', () => {
    expect(SESSION_CANCELLED_TOPIC).toBe('fulfillment.session.cancelled');
    const payload: SessionCancelledPayload = {
      session_id: 41,
      cancelled_by: 'lawyer',
      cancelled_by_user_id: 9101,
      cancelled_at: '2026-10-16T10:00:00.000Z',
      session_start_at: '2026-10-18T20:00:00.000Z',
    };
    expect(payload.cancelled_by).toBe('lawyer');
    expect(payload.cancelled_by_user_id).toBe(9101);
    const platform: SessionCancelledPayload = {
      session_id: 42,
      cancelled_by: 'platform',
      cancelled_by_user_id: null,
      cancelled_at: '2026-10-16T10:00:00.000Z',
      session_start_at: '2026-10-18T20:00:00.000Z',
    };
    expect(platform.cancelled_by_user_id).toBeNull();
  });

  it('ReviewSubmitted：topic=review.review.submitted，{session_id, direction, dims, reviewee_user_id}', () => {
    expect(REVIEW_SUBMITTED_TOPIC).toBe('review.review.submitted');
    const payload: ReviewSubmittedPayload = {
      session_id: 51,
      direction: 'user_to_lawyer',
      dims: { professional: 5, response: 4, attitude: 5, overall: 5 },
      reviewee_user_id: 9101,
    };
    expect(payload.dims.overall).toBe(5);
  });
});

describe('F1 支付网关事件契约（M1-W3）：生产 3（消费：C3=T7 接收件、H3=M2 接工单；告警 sink=mock，M2+ 换装）。F1 §6 消费：无——出箱即止', () => {
  it('PaymentCallbackInboxed：topic=payment.callback.inboxed，{biz_idempotency_key, event}（§6 载荷逐字）', () => {
    expect(PAYMENT_CALLBACK_INBOXED_TOPIC).toBe('payment.callback.inboxed');
    const payload: PaymentCallbackInboxedPayload = {
      biz_idempotency_key: 'payment/order-1/pay:PAY_SUCCESS',
      event: 'PAY_SUCCESS',
    };
    expect(payload).toEqual({
      biz_idempotency_key: 'payment/order-1/pay:PAY_SUCCESS',
      event: 'PAY_SUCCESS',
    });
  });

  it('ReconciliationDiffFound：topic=payment.reconciliation.diff_found，{period, detail[]}', () => {
    expect(RECONCILIATION_DIFF_FOUND_TOPIC).toBe('payment.reconciliation.diff_found');
    const payload: ReconciliationDiffFoundPayload = {
      period: '2026-10-15',
      detail: [
        {
          channel: 'wechat_ecom',
          channel_txn_no: 'MOCK-WECHAT-000009',
          kind: 'CHANNEL_ONLY',
          amount: '12.00',
          reason: '通道账单有行、本地无对应支付单',
        },
      ],
    };
    expect(payload.detail[0]!.kind).toBe('CHANNEL_ONLY');
    expect(payload.detail[0]!.amount).toBe('12.00'); // 金额字符串往返（NUMERIC 禁 float）
  });

  it('ChannelDegraded：topic=payment.channel.degraded，{channel}', () => {
    expect(CHANNEL_DEGRADED_TOPIC).toBe('payment.channel.degraded');
    const payload: ChannelDegradedPayload = { channel: 'wechat_ecom' };
    expect(payload).toEqual({ channel: 'wechat_ecom' });
  });
});

describe('F4 权益积分事件契约（M1-W3 T2）：生产 3（消费：H4/C6 回执均 M2——生产方定型，出箱即止）。载荷含 user_id/delta/kind/ref 与幂等引用', () => {
  it('PointsGranted：topic=benefits.points.granted，{user_id, delta>0, kind, ref, balance_after}', () => {
    expect(POINTS_GRANTED_TOPIC).toBe('benefits.points.granted');
    const granted: PointsGrantedPayload = {
      user_id: 601,
      delta: 500,
      kind: 'COMPENSATION',
      ref: 'price_change:21',
      balance_after: 500,
    };
    expect(granted.delta).toBeGreaterThan(0);
    const restored: PointsGrantedPayload = {
      user_id: 601,
      delta: 300,
      kind: 'REFUND_RESTORE',
      ref: 'refund:order-9:1',
      balance_after: 800,
    };
    expect(restored.kind).toBe('REFUND_RESTORE'); // R-06 退款还原走同事件，kind 区分
  });

  it('PointsRedeemed：topic=benefits.points.redeemed，{user_id, delta<0, kind, order_id, ref, balance_after}（幂等键=order）', () => {
    expect(POINTS_REDEEMED_TOPIC).toBe('benefits.points.redeemed');
    const payload: PointsRedeemedPayload = {
      user_id: 601,
      delta: -300,
      kind: 'REDEEM',
      order_id: 9,
      ref: 'order:9',
      balance_after: 500,
    };
    expect(payload.delta).toBeLessThan(0);
    expect(payload.order_id).toBe(9);
  });

  it('PointsExpired：topic=benefits.points.expired，{user_id, delta<0, kind, ref(null), balance_after}', () => {
    expect(POINTS_EXPIRED_TOPIC).toBe('benefits.points.expired');
    const payload: PointsExpiredPayload = {
      user_id: 601,
      delta: -200,
      kind: 'EXPIRE',
      ref: null, // EXPIRE 聚合行无业务幂等引用（消费侧按 user_id+event_id 去重）
      balance_after: 300,
    };
    expect(payload.delta).toBeLessThan(0);
    expect(payload.ref).toBeNull();
  });

  it('PointsTxnKind 词汇表：F4 §3 逐字 5 值 + ①切片 FREEZE/UNFREEZE 口径归一 2 值', () => {
    const kinds: PointsTxnKind[] = [
      'COMPENSATION',
      'ABSENCE_SHARE',
      'REDEEM',
      'REFUND_RESTORE',
      'EXPIRE',
      'FREEZE',
      'UNFREEZE',
    ];
    expect(kinds).toHaveLength(7);
  });
});

describe('A3b 律所进件事件契约（M1-W3 T3）：生产 3（消费：F3 分账前置=T8、I1 通知、H1 视图=T10——生产方定型，出箱即止）', () => {
  it('FirmMerchantActivated：topic=payment.firm_merchant.activated，{firm_id, channel}', () => {
    expect(FIRM_MERCHANT_ACTIVATED_TOPIC).toBe('payment.firm_merchant.activated');
    const payload: FirmMerchantActivatedPayload = { firm_id: 12, channel: 'wechat_ecom' };
    expect(payload).toEqual({ firm_id: 12, channel: 'wechat_ecom' });
  });

  it('FirmMerchantSuspended：topic=payment.firm_merchant.suspended，{firm_id, channel, reason}（reason 两值词汇表）', () => {
    expect(FIRM_MERCHANT_SUSPENDED_TOPIC).toBe('payment.firm_merchant.suspended');
    const changing: FirmMerchantSuspendedPayload = {
      firm_id: 12,
      channel: 'wechat_ecom',
      reason: 'ACCOUNT_CHANGING', // R-W3-C2：变更期即分账暂停语义
    };
    const overdue: FirmMerchantSuspendedPayload = {
      firm_id: 12,
      channel: 'wechat_ecom',
      reason: 'REVERIFY_OVERDUE', // R-03 年度复验到期未复验
    };
    expect(changing.reason).toBe('ACCOUNT_CHANGING');
    expect(overdue.reason).toBe('REVERIFY_OVERDUE');
    const reasons: FirmMerchantSuspensionReason[] = ['ACCOUNT_CHANGING', 'REVERIFY_OVERDUE'];
    expect(reasons).toHaveLength(2);
  });

  it('FirmMerchantReverifiedDue：topic=payment.firm_merchant.reverified_due，{firm_id, due_at}', () => {
    expect(FIRM_MERCHANT_REVERIFIED_DUE_TOPIC).toBe('payment.firm_merchant.reverified_due');
    const payload: FirmMerchantReverifiedDuePayload = {
      firm_id: 12,
      due_at: '2027-10-16T00:00:00.000Z',
    };
    expect(payload.due_at).toBe('2027-10-16T00:00:00.000Z');
  });
});

describe('C1 B2C 开团事件契约（M1-W3 T4）：3 生产契约（Full→C3=T7 消费位、Failed→F2 批量退款=T6 接线）', () => {
  it('SessionCreated：topic=trade.session.created，{id, lawyer_id, slot_start, enroll_deadline}（C1 §6 逐字）', () => {
    expect(SESSION_CREATED_TOPIC).toBe('trade.session.created');
    const payload: SessionCreatedPayload = {
      id: 61,
      lawyer_id: 9101,
      slot_start: '2026-10-18T12:00:00.000Z',
      enroll_deadline: '2026-10-17T12:00:00.000Z',
    };
    expect(payload).toEqual({
      id: 61,
      lawyer_id: 9101,
      slot_start: '2026-10-18T12:00:00.000Z',
      enroll_deadline: '2026-10-17T12:00:00.000Z',
    });
  });

  it('SessionFull：topic=trade.session.full，退款所需 ref 最小集（价格快照 Money 字符串禁 float）', () => {
    expect(SESSION_FULL_TOPIC).toBe('trade.session.full');
    const payload: SessionFullPayload = {
      id: 61,
      lawyer_id: 9101,
      slot_start: '2026-10-18T12:00:00.000Z',
      price_mode: 'per_head',
      unit_price: '50.00',
      session_total: '300.00',
    };
    expect(payload.unit_price).toBe('50.00');
    expect(payload.session_total).toBe('300.00');
  });

  it('SessionFailed：topic=trade.session.failed，同一 ref 最小集（流标全额退款 T6 F2 消费）', () => {
    expect(SESSION_FAILED_TOPIC).toBe('trade.session.failed');
    const payload: SessionFailedPayload = {
      id: 61,
      lawyer_id: 9101,
      slot_start: '2026-10-18T12:00:00.000Z',
      price_mode: 'session_total',
      unit_price: '33.34',
      session_total: '100.01',
      reason: 'ENROLL_DEADLINE_PASSED',
    };
    expect(payload.reason).toBe('ENROLL_DEADLINE_PASSED');
  });
});

describe('C2 C2B 发起拼团事件契约（M1-W3 T5）：3 生产契约（Expired→F2 退款指令面=T6 接线，本批断言出箱；Reached 消费位=I2 12h job 由 C2 同事务直写承接）', () => {
  it('GroupBuyPublished：topic=trade.group_buy.published，{id, lawyer_id, slot_start, sub_min, share_price}（C2 §6 逐字）', () => {
    expect(GROUP_BUY_PUBLISHED_TOPIC).toBe('trade.group_buy.published');
    const payload: GroupBuyPublishedPayload = {
      id: 71,
      lawyer_id: 9101,
      slot_start: '2026-10-18T12:00:00.000Z',
      sub_min: 3,
      share_price: '33.34', // R-02 分摊额快照（Money 字符串禁 float）
    };
    expect(payload).toEqual({
      id: 71,
      lawyer_id: 9101,
      slot_start: '2026-10-18T12:00:00.000Z',
      sub_min: 3,
      share_price: '33.34',
    });
  });

  it('GroupBuyReached：topic=trade.group_buy.reached，{id}（C2 §6 逐字最小集；12h 确认 job 由 C2 守卫同事务预写）', () => {
    expect(GROUP_BUY_REACHED_TOPIC).toBe('trade.group_buy.reached');
    const payload: GroupBuyReachedPayload = { id: 71 };
    expect(payload).toEqual({ id: 71 });
  });

  it('GroupBuyExpired：topic=trade.group_buy.expired，{id, lawyer_id, initiator_id, share_price, sub_min, reason}（退款指令面=T6 F2；reason 两值词汇表）', () => {
    expect(GROUP_BUY_EXPIRED_TOPIC).toBe('trade.group_buy.expired');
    const byDeadline: GroupBuyExpiredPayload = {
      id: 71,
      lawyer_id: 9101,
      initiator_id: 601,
      share_price: '33.34',
      sub_min: 3,
      reason: 'DEADLINE_PASSED',
    };
    expect(byDeadline.reason).toBe('DEADLINE_PASSED');
    const byCancel: GroupBuyExpiredPayload = {
      id: 72,
      lawyer_id: 9101,
      initiator_id: 601,
      share_price: '50.00',
      sub_min: 2,
      reason: 'INITIATOR_CANCELLED',
    };
    expect(byCancel.reason).toBe('INITIATOR_CANCELLED');
  });
});
