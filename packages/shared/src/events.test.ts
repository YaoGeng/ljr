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
  PRICE_CHANGE_APPROVED_TOPIC,
  PRICE_VERSION_CREATED_TOPIC,
  PriceChangeApprovedPayload,
  PriceChangeKind,
  PriceVersionCreatedPayload,
  REAL_NAME_VERIFIED_TOPIC,
  RESTRICTION_ISSUED_TOPIC,
  RealNameVerifiedPayload,
  RestrictionIssuedPayload,
  REVIEW_SUBMITTED_TOPIC,
  ReviewSubmittedPayload,
  SESSION_CANCELLED_TOPIC,
  SessionCancelledPayload,
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

  it('LawyerRejected：topic=trade.group_buy.lawyer_rejected，{group_id, lawyer_id}', () => {
    expect(LAWYER_REJECTED_TOPIC).toBe('trade.group_buy.lawyer_rejected');
    const payload: LawyerRejectedPayload = { group_id: 11, lawyer_id: 9101 };
    expect(payload).toEqual({ group_id: 11, lawyer_id: 9101 });
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
