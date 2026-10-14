/**
 * 验证码限频执行计数（I1 R-02，承接 A1 R-01：同号 60s/1 条、1h/5 条、1d/10 条）。
 *
 * - 三滑窗按 send 时刻计数（notify.verify_code_sends），tryAcquire 原子「判定+登记」：
 *   同号经事务级 advisory lock 串行化，杜绝并发判定超发；被拒不落行（失败不烧配额）。
 * - 只存 sha256(phone) 哈希，明文手机号禁落库（lj-data-security 口径）；
 *   A1(W2) 的列加密/HMAC 盲索引落地后可对齐为键控哈希（机制不变，换哈希函数位）。
 * - ⚠决策位：A1 R-01 原文为 Redis 计数器——portable 栈无 Redis（Ruling-6），DB 计数是
 *   dev 等价实现（每号每日 ≤10 行，量级极小）；Redis 适配位随基础设施就位替换，接口不变。
 * - A1(W2) 承接消费：注册登录发送验证码前调 tryAcquire(phone)，拒绝即 429（A1 限频四档口径）。
 */
import { createHash } from 'node:crypto';
import { Injectable, Optional } from '@nestjs/common';
import { AppError, ErrorCode } from '@ljr/shared';
import { PgPoolService } from '../../infrastructure/sql';
import { notifyConfigFromEnv } from './notify.config';

export type VerifyCodeWindow = '60s' | '1h' | '1d';

export type VerifyCodeQuotaResult =
  { allowed: true } | { allowed: false; window: VerifyCodeWindow };

export interface VerifyCodeCaps {
  readonly per60s: number;
  readonly per1h: number;
  readonly per1d: number;
}

/** sha256(phone) hex——确定性去标识，不落明文 */
export function hashPhone(phone: string): string {
  return createHash('sha256').update(phone, 'utf8').digest('hex');
}

@Injectable()
export class VerifyCodeRateLimiter {
  private readonly caps: VerifyCodeCaps;

  constructor(
    private readonly pool: PgPoolService,
    @Optional() caps?: Partial<VerifyCodeCaps>,
  ) {
    const defaults = notifyConfigFromEnv();
    this.caps = {
      per60s: caps?.per60s ?? defaults.verifyMaxPer60s,
      per1h: caps?.per1h ?? defaults.verifyMaxPer1h,
      per1d: caps?.per1d ?? defaults.verifyMaxPer1d,
    };
  }

  /** 原子判定+登记：允许=已计数（本次发送获准）；拒绝=未计数（含最先触顶的窗口） */
  async tryAcquire(phone: string): Promise<VerifyCodeQuotaResult> {
    // 号码格式校验属 A1 职责，本层只做非空/长度防呆（防滥用哈希注入面）
    if (typeof phone !== 'string' || phone.length === 0 || phone.length > 32) {
      throw new AppError(ErrorCode.InvalidArgument, '手机号非法（空或超长）');
    }
    const phoneHash = hashPhone(phone);
    return this.pool.withTransaction(async (uow) => {
      // 同号串行：窗口计数与插入非原子，并发下会双计超发——advisory lock 按哈希锁住同号
      await uow.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [phoneHash]);
      const counted = await uow.query<{ w60: string; w1h: string; w1d: string }>(
        `SELECT count(*) FILTER (WHERE sent_at > now() - interval '60 seconds') AS w60,
                count(*) FILTER (WHERE sent_at > now() - interval '1 hour')   AS w1h,
                count(*) FILTER (WHERE sent_at > now() - interval '24 hours') AS w1d
           FROM notify.verify_code_sends
          WHERE phone_hash = $1`,
        [phoneHash],
      );
      const c = counted.rows[0];
      if (Number(c?.w60 ?? 0) >= this.caps.per60s) return { allowed: false, window: '60s' };
      if (Number(c?.w1h ?? 0) >= this.caps.per1h) return { allowed: false, window: '1h' };
      if (Number(c?.w1d ?? 0) >= this.caps.per1d) return { allowed: false, window: '1d' };

      await uow.query(`INSERT INTO notify.verify_code_sends (phone_hash) VALUES ($1)`, [phoneHash]);
      // 有界清理：窗口最长回看 24h，过期行即无判定价值（表不随时间无界增长）
      await uow.query(
        `DELETE FROM notify.verify_code_sends WHERE sent_at < now() - interval '48 hours'`,
      );
      return { allowed: true };
    });
  }
}
