/**
 * 双 token 服务（A1 §2/§5；裁决 R-W2-3/R-W2-4）。
 *
 * - access_token：JWT（@nestjs/jwt，HS256），claims={sub, role, roles}，2h——claims.role 为
 *   「当前激活角色」（R-03 接口级校验的事实源；switch-role 重签）。
 * - refresh_token：不透明随机 32B hex，仅落 sha256 哈希（identity.refresh_tokens.token_hash），
 *   明文只在签发响应出现一次；14d 有效，吊销=revoked_at。
 * - 吊销即时生效（R-W2-4）：刷新时查库校验 revoked_at/expires_at——dev 无 Redis 的等价实现；
 *   Redis 黑名单为 prod 换装适配位（语义不变：吊销后首个刷新请求即被拒）。
 */
import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { SqlExecutor } from '../../infrastructure/sql';
import { PgPoolService } from '../../infrastructure/sql';
import {
  ACCESS_TTL_SEC,
  IDENTITY_CONFIG,
  REFRESH_TTL_SEC,
  type IdentityConfig,
} from './identity.config';
import type { UserRole } from './identity.machine';

const REFRESH_TOKEN_BYTES = 32;

function sha256Hex(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export interface AccessTokenInput {
  readonly userId: number;
  /** 当前激活角色（R-03 接口级校验依据） */
  readonly role: UserRole;
  /** 持有的全部角色（R-02 双角色同账号） */
  readonly roles: UserRole[];
}

@Injectable()
export class IdentityTokenService {
  private readonly jwtSecret: string;

  constructor(
    private readonly jwt: JwtService,
    private readonly pool: PgPoolService,
    @Inject(IDENTITY_CONFIG) config: IdentityConfig,
  ) {
    this.jwtSecret = config.jwtSecret;
  }

  /** 签发 access（2h）：claims 只含身份与角色，PII 禁入（lj-data-security） */
  async signAccessToken(input: AccessTokenInput): Promise<string> {
    return this.jwt.signAsync(
      { sub: String(input.userId), role: input.role, roles: input.roles },
      { secret: this.jwtSecret, expiresIn: ACCESS_TTL_SEC },
    );
  }

  /** 签发 refresh（14d）：明文仅返回一次；台账落哈希。uow 传入时与业务同事务（verify 注册链路） */
  async issueRefreshToken(userId: number, uow?: SqlExecutor): Promise<string> {
    const token = randomBytes(REFRESH_TOKEN_BYTES).toString('hex');
    const exec = uow ?? this.pool;
    await exec.query(
      `INSERT INTO identity.refresh_tokens (user_id, token_hash, expires_at)
       VALUES ($1, $2, now() + ($3::bigint * interval '1 second'))`,
      [userId, sha256Hex(token), REFRESH_TTL_SEC],
    );
    return token;
  }

  /** 刷新时查库校验（R-W2-4 吊销即时生效）：无效/过期/已吊销 → null（调用方映射 401） */
  async resolveRefreshToken(token: string): Promise<{ userId: number } | null> {
    const row = await this.pool.query<{ user_id: string }>(
      `SELECT user_id FROM identity.refresh_tokens
        WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()`,
      [sha256Hex(token)],
    );
    const hit = row.rows[0];
    return hit ? { userId: Number(hit.user_id) } : null;
  }

  /** 吊销（R-W2-B 登出）：幂等——重复吊销/未知 token 返回 false，不抛错 */
  async revokeRefreshToken(token: string): Promise<boolean> {
    const res = await this.pool.query(
      `UPDATE identity.refresh_tokens SET revoked_at = now()
        WHERE token_hash = $1 AND revoked_at IS NULL`,
      [sha256Hex(token)],
    );
    return (res.rowCount ?? 0) > 0;
  }
}
