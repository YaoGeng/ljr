import { describe, expect, it } from 'bun:test';
import {
  AppError,
  CONTRACT_VERSION,
  ErrorCode,
  type DomainEvent,
  type Money,
  assertMoney,
} from './index';

describe('@ljr/shared 契约入口', () => {
  it('入口可加载，基座三件可用（M0-4 起占位转正）', () => {
    expect(CONTRACT_VERSION).toBe('0.2.0');

    const code: ErrorCode = ErrorCode.Conflict;
    const amount: Money = assertMoney('100.00');
    const event: DomainEvent = { type: 'placeholder.created', payload: null };

    const err = new AppError(code, '冲突');
    expect(err.httpStatus).toBe(409);
    expect(amount).toBe('100.00');
    expect(event.type).toBe('placeholder.created');
  });
});
