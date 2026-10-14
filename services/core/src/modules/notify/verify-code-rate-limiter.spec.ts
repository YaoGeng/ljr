import 'reflect-metadata';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { ensureTestDatabase, truncateAll } from '../../infrastructure/testing/db';
import { PgPoolService } from '../../infrastructure/sql';
import { hashPhone, VerifyCodeRateLimiter } from './verify-code-rate-limiter.service';

/**
 * I1 R-02 验证码限频执行计数（承接 A1 R-01：同号 60s/1 条、1h/5 条、1d/10 条）。
 * 限频参数配置化：默认值=A1 R-01 四档（三窗 + 各窗上限），用例以自定义上限隔离单窗行为。
 */
describe('I1 R-02 验证码限频（三滑窗计数，需 PG）', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = await ensureTestDatabase();
  });

  beforeEach(async () => {
    await truncateAll(pool);
  });
  afterEach(async () => {
    await truncateAll(pool);
  });
  afterAll(async () => {
    await pool.end();
  });

  const limiterWith = (caps: { per60s: number; per1h: number; per1d: number }) =>
    new VerifyCodeRateLimiter(new PgPoolService(pool), caps);

  it('默认参数=A1 R-01（60s/1、1h/5、1d/10）：60s 窗第 2 条被拒', async () => {
    const limiter = new VerifyCodeRateLimiter(new PgPoolService(pool));
    const phone = '13800000001';
    expect(await limiter.tryAcquire(phone)).toEqual({ allowed: true });
    expect(await limiter.tryAcquire(phone)).toEqual({ allowed: false, window: '60s' });
  });

  it('默认参数：1h 窗第 6 条被拒（隔离 60s 窗）', async () => {
    const limiter = limiterWith({ per60s: 99, per1h: 5, per1d: 10 });
    const phone = '13800000002';
    for (let i = 0; i < 5; i += 1) {
      expect(await limiter.tryAcquire(phone)).toEqual({ allowed: true });
    }
    expect(await limiter.tryAcquire(phone)).toEqual({ allowed: false, window: '1h' });
  });

  it('默认参数：1d 窗第 11 条被拒（隔离 60s/1h 窗）', async () => {
    const limiter = limiterWith({ per60s: 99, per1h: 99, per1d: 10 });
    const phone = '13800000003';
    for (let i = 0; i < 10; i += 1) {
      expect(await limiter.tryAcquire(phone)).toEqual({ allowed: true });
    }
    expect(await limiter.tryAcquire(phone)).toEqual({ allowed: false, window: '1d' });
  });

  it('不同号码互不影响：A 号耗尽配额，B 号首条放行', async () => {
    const limiter = limiterWith({ per60s: 1, per1h: 1, per1d: 1 });
    expect(await limiter.tryAcquire('13900000001')).toEqual({ allowed: true });
    expect(await limiter.tryAcquire('13900000001')).toEqual({ allowed: false, window: '60s' });
    expect(await limiter.tryAcquire('13900000002')).toEqual({ allowed: true });
  });

  it('被拒不计数：拒绝尝试不烧配额（失败不落行）', async () => {
    const limiter = limiterWith({ per60s: 1, per1h: 1, per1d: 1 });
    const phone = '13700000001';
    expect(await limiter.tryAcquire(phone)).toEqual({ allowed: true });
    for (let i = 0; i < 3; i += 1) {
      expect(await limiter.tryAcquire(phone)).toEqual({ allowed: false, window: '60s' });
    }
    const counted = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM notify.verify_code_sends WHERE phone_hash = $1`,
      [hashPhone(phone)],
    );
    expect(counted.rows[0]?.n).toBe(1);
  });

  it('只存哈希不存明文：表内无手机号原文（lj-data-security 口径）', async () => {
    const limiter = new VerifyCodeRateLimiter(new PgPoolService(pool));
    await limiter.tryAcquire('13600000001');
    const rows = await pool.query<{ phone_hash: string }>(
      `SELECT phone_hash FROM notify.verify_code_sends`,
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.phone_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows.rows[0]?.phone_hash).not.toContain('13600000001');
  });
});
