import { describe, expect, it } from 'bun:test';
import {
  ACCOUNT_DELETION_EXECUTED_TOPIC,
  AccountDeletionExecutedPayload,
  LAWYER_AUDIT_PASSED_TOPIC,
  LawyerAuditPassedPayload,
  PRICE_VERSION_CREATED_TOPIC,
  PriceVersionCreatedPayload,
  REAL_NAME_VERIFIED_TOPIC,
  RealNameVerifiedPayload,
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
