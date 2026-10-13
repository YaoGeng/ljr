import { describe, expect, it } from 'bun:test';
import { CONTRACT_VERSION, type DomainEvent, type ErrorCode, type Money } from './index';

describe('@ljr/shared 契约骨架', () => {
  it('入口可加载，占位类型可用', () => {
    expect(CONTRACT_VERSION).toMatch(/^\d+\.\d+\.\d+$/);

    const code: ErrorCode = 'E_PLACEHOLDER';
    const amount: Money = '100.00';
    const event: DomainEvent = { type: 'placeholder.created', payload: null };

    expect(code).toBe('E_PLACEHOLDER');
    expect(amount).toBe('100.00');
    expect(event.type).toBe('placeholder.created');
  });
});
