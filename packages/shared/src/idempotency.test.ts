import { describe, expect, it } from 'bun:test';
import { AppError, ErrorCode } from './error-codes';
import { isValidIdempotencyKey, withIdempotency } from './idempotency';

describe('幂等键规范 domain/entity/event（架构 §4.4 业务幂等号）', () => {
  it.each(['demo/order-42/completed', 'trade/session.100/full', 'payment/order/refund'])(
    '合法键：%s',
    (key) => {
      expect(isValidIdempotencyKey(key)).toBe(true);
    },
  );

  it.each([
    'demo/order', // 少一段
    'demo/a/b/c', // 多一段
    '/order/completed', // 空段
    'demo//completed', // 空段
    'Demo/order/completed', // 大写
    'de mo/order/completed', // 空格
    '', // 空串
  ])('非法键：%s', (key) => {
    expect(isValidIdempotencyKey(key)).toBe(false);
  });

  it('非法键调用 withIdempotency 抛 AppError(IdempotencyKeyInvalid, 400)，fn 不执行', async () => {
    let called = false;
    let err: unknown;
    try {
      await withIdempotency('not-a-key', () => {
        called = true;
        return 1;
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe(ErrorCode.IdempotencyKeyInvalid);
    expect((err as AppError).httpStatus).toBe(400);
    expect(called).toBe(false);
  });
});

describe('withIdempotency 同键重复短路（首访结果复用，fn 不再执行）', () => {
  it('第二次调用不再执行 fn，返回首访结果', async () => {
    let executions = 0;
    const fn = (): number => {
      executions += 1;
      return 41 + 1;
    };
    const key = 'test/entity/event';
    const first = await withIdempotency(key, fn);
    const second = await withIdempotency(key, fn);
    const third = await withIdempotency(key, fn);
    expect(executions).toBe(1);
    expect(second).toBe(first);
    expect(third).toBe(first);
  });

  it('并发同键（首访 promise 未落定）也只执行一次', async () => {
    let executions = 0;
    const fn = async (): Promise<string> => {
      executions += 1;
      await new Promise((r) => setTimeout(r, 20));
      return 'once';
    };
    const key = 'test/concurrent/event';
    const [a, b] = await Promise.all([withIdempotency(key, fn), withIdempotency(key, fn)]);
    expect(executions).toBe(1);
    expect(a).toBe('once');
    expect(b).toBe('once');
  });

  it('不同键互不影响，各自执行', async () => {
    let executions = 0;
    const fn = (): number => {
      executions += 1;
      return executions;
    };
    const a = await withIdempotency('test/entity/event-a', fn);
    const b = await withIdempotency('test/entity/event-b', fn);
    expect(executions).toBe(2);
    expect(a).toBe(1);
    expect(b).toBe(2);
  });

  it('首访失败同样短路：重复键拿到同一 rejection（首访结果口径）', async () => {
    let executions = 0;
    const fn = (): Promise<never> => {
      executions += 1;
      return Promise.reject(new AppError(ErrorCode.Conflict, '首次就炸'));
    };
    const key = 'test/entity/event-reject';
    await expect(withIdempotency(key, fn)).rejects.toThrow(AppError);
    await expect(withIdempotency(key, fn)).rejects.toThrow('首次就炸');
    expect(executions).toBe(1);
  });
});
