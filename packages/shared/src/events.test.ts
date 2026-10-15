import { describe, expect, it } from 'bun:test';
import {
  ACCOUNT_DELETION_EXECUTED_TOPIC,
  AccountDeletionExecutedPayload,
  LAWYER_AUDIT_PASSED_TOPIC,
  LawyerAuditPassedPayload,
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
