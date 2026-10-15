/**
 * A1 注册登录与双角色领域服务（docs/modules/A-身份与账号/A1 §4/§5/§7）。
 *
 * 关键流程（§4）：
 *   登录/注册：requestSms（限频 R-01 承接 I1 limiter → 码签发落哈希 → mock SMS 通道）
 *              → verify（一次性消费码 → 盲索引查 users → 不存在则建号（R-04 年龄声明）
 *              → UserRegistered 同事务 outbox → 签发双 token）
 *   刷新/登出：refresh（R-W2-4 查库校验吊销即时生效）/ logout（R-W2-B 吊销 refresh）
 *   切换角色：switch-role（user_roles 含目标角色校验 → 重签 claims.role，R-02）
 *
 * PII 红线：明文手机号只存在于请求入参与 SMS 通道入参（供应商 mock），不出现在日志、
 * 事件载荷、JWT claims 与任何落库文本列（列加密/盲索引/哈希/掩码是唯一落库形态）。
 */
import { randomInt } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import {
  AppError,
  ErrorCode,
  USER_REGISTERED_TOPIC,
  type UserRegisteredPayload,
} from '@ljr/shared';
import { OutboxService } from '../../infrastructure/outbox/outbox.service';
import type { SqlExecutor } from '../../infrastructure/sql';
import { PgPoolService } from '../../infrastructure/sql';
import { NotifyChannelRegistry } from '../notify/notify.channels';
import { VerifyCodeRateLimiter } from '../notify/verify-code-rate-limiter.service';
import { CODE_TTL_SEC } from './identity.config';
import { IdentityCryptoService, assertMainlandPhone, hashCodeValue } from './identity.crypto';
import type { UserRole, UserStatus } from './identity.machine';
import { IdentityTokenService } from './identity.token.service';

/** 验证码 SMS 通道的模板占位码（模板中心无验证码话术；短信文案由本模块按 PRD §7.1.1 组装） */
const SMS_VERIFY_TEMPLATE = 'VERIFY_CODE';

/** verify 入参（R-W2-C：age_declared 可选；新建号必须 true） */
export interface VerifyInput {
  readonly phone: string;
  readonly code: string;
  readonly ageDeclared?: boolean;
}

export interface VerifyResult {
  readonly userId: number;
  /** true=本次为新建号（注册），false=已有账号登录 */
  readonly isNew: boolean;
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly roles: UserRole[];
}

export interface MeView {
  readonly id: number;
  readonly roles: UserRole[];
  readonly status: UserStatus;
  /** 掩码形态（138****5678），明文不出 /me */
  readonly phoneMasked: string;
}

interface UserRow {
  readonly id: string;
  readonly status: UserStatus;
}

/** 6 位数字验证码形态（防呆在服务层：非 6 位数字即 CODE_INVALID，不区分「格式错」与「码错」） */
const CODE_PATTERN = /^\d{6}$/;

/** refresh_token 形态（签发=32B hex64；非此形态直接按失效处理，不区分「伪造」与「过期」） */
const REFRESH_TOKEN_PATTERN = /^[0-9a-f]{64}$/;

function assertCodeFormat(code: unknown): string {
  if (typeof code !== 'string' || !CODE_PATTERN.test(code)) {
    throw new AppError(ErrorCode.CodeInvalid, '验证码无效或已过期');
  }
  return code;
}

function assertRefreshToken(raw: unknown): string {
  if (typeof raw !== 'string' || !REFRESH_TOKEN_PATTERN.test(raw)) {
    throw new AppError(ErrorCode.RefreshExpired);
  }
  return raw;
}

function assertUserRole(raw: unknown): UserRole {
  if (raw !== 'user' && raw !== 'lawyer') {
    throw new AppError(ErrorCode.InvalidArgument, 'target_role 必须是 user|lawyer');
  }
  return raw;
}

/** 注册并发窗口的约束败退（23505）→ 409 Conflict：DB 唯一约束是事实源，映射领域错误不外泄驱动错误 */
function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: string }).code === '23505';
}

@Injectable()
export class IdentityService {
  private readonly logger = new Logger(IdentityService.name);

  constructor(
    private readonly pool: PgPoolService,
    private readonly outbox: OutboxService,
    private readonly tokens: IdentityTokenService,
    private readonly crypto: IdentityCryptoService,
    /** I1 已交付限频器（R-01 三滑窗 1/5/10 = I1 R-02 同源），拒绝映射 429（裁决 W2-2 不自建） */
    private readonly limiter: VerifyCodeRateLimiter,
    private readonly channels: NotifyChannelRegistry,
  ) {}

  /** POST /auth/sms：限频 → 生成 6 位码（哈希落库 60s）→ mock SMS 通道 → {ttl} */
  async requestSms(rawPhone: unknown): Promise<{ ttl: number }> {
    const phone = assertMainlandPhone(rawPhone);
    const verdict = await this.limiter.tryAcquire(phone);
    if (!verdict.allowed) {
      // 日志只带盲索引前缀，明文手机号禁落日志（lj-data-security）
      this.logger.warn(
        `sms 限频拒绝：窗口=${verdict.window}，idx=${this.crypto.blindIndex(phone).slice(0, 8)}…`,
      );
      throw new AppError(
        ErrorCode.RateLimited,
        `验证码发送过于频繁（${verdict.window} 窗口限频），请稍后再试`,
      );
    }
    const blind = this.crypto.blindIndex(phone);
    const code = String(randomInt(100_000, 1_000_000));
    await this.pool.query(
      `INSERT INTO identity.verify_codes (phone_blind_idx, code_hash, expires_at)
       VALUES ($1, $2, now() + ($3::bigint * interval '1 second'))`,
      [blind, hashCodeValue(code, blind), CODE_TTL_SEC],
    );
    await this.channels.get('SMS').send({
      // userId=0：注册前置发送，账号尚不存在（供应商位=M2+ 真通道时由适配器承担手机号路由）
      userId: 0,
      templateCode: SMS_VERIFY_TEMPLATE,
      content: `【律聚人】验证码 ${code}，${CODE_TTL_SEC} 秒内有效，请勿泄露。`,
      params: { code },
    });
    return { ttl: CODE_TTL_SEC };
  }

  /** POST /auth/verify：一次性消费码 → 盲索引建号/登录（R-04）→ 双 token */
  async verify(input: VerifyInput): Promise<VerifyResult> {
    const phone = assertMainlandPhone(input.phone);
    const code = assertCodeFormat(input.code);
    return this.pool.withTransaction(async (uow) => {
      const blind = this.crypto.blindIndex(phone);

      // 1) 一次性消费最新未消费未过期码（行锁防并发同码双用；校验失败回滚不烧码）
      const picked = await uow.query<{ id: string; code_hash: string }>(
        `SELECT id, code_hash FROM identity.verify_codes
          WHERE phone_blind_idx = $1 AND consumed_at IS NULL AND expires_at > now()
          ORDER BY id DESC LIMIT 1 FOR UPDATE`,
        [blind],
      );
      const codeRow = picked.rows[0];
      if (!codeRow || !this.crypto.codeMatches(code, blind, codeRow.code_hash)) {
        throw new AppError(ErrorCode.CodeInvalid, '验证码无效或已过期');
      }
      await uow.query('UPDATE identity.verify_codes SET consumed_at = now() WHERE id = $1', [
        codeRow.id,
      ]);

      // 2) 盲索引查 users：不存在则建号（R-04），存在则校验可登录状态
      const found = await uow.query<UserRow>(
        'SELECT id, status FROM identity.users WHERE phone_blind_idx = $1',
        [blind],
      );
      const user = found.rows[0];
      let userId: number;
      let isNew = false;
      if (!user) {
        if (input.ageDeclared !== true) {
          throw new AppError(ErrorCode.AgeDeclarationRequired);
        }
        userId = await this.createUser(uow, phone, blind);
        isNew = true;
      } else {
        userId = Number(user.id);
        if (user.status !== 'ACTIVE') {
          throw new AppError(ErrorCode.AccountBanned, `账号当前不可登录（${user.status}）`);
        }
      }

      const roles = await this.rolesOf(userId, uow);
      const accessToken = await this.tokens.signAccessToken({
        userId,
        role: this.defaultRole(roles),
        roles,
      });
      const refreshToken = await this.tokens.issueRefreshToken(userId, uow);
      return { userId, isNew, accessToken, refreshToken, roles };
    });
  }

  /** POST /auth/refresh：查库校验（吊销/过期即时生效 R-W2-4）→ 新 access（激活角色回默认 user） */
  async refresh(rawToken: unknown): Promise<{ accessToken: string }> {
    const token = assertRefreshToken(rawToken);
    const resolved = await this.tokens.resolveRefreshToken(token);
    if (!resolved) throw new AppError(ErrorCode.RefreshExpired);
    const row = await this.pool.query<{ status: UserStatus }>(
      'SELECT status FROM identity.users WHERE id = $1',
      [resolved.userId],
    );
    const status = row.rows[0]?.status;
    if (status !== 'ACTIVE') {
      throw new AppError(ErrorCode.AccountBanned, `账号当前不可登录（${status ?? '不存在'}）`);
    }
    const roles = await this.rolesOf(resolved.userId, this.pool);
    return {
      accessToken: await this.tokens.signAccessToken({
        userId: resolved.userId,
        role: this.defaultRole(roles),
        roles,
      }),
    };
  }

  /** POST /auth/logout（R-W2-B 最小满足）：吊销 refresh（幂等），明文 token 不落日志 */
  async logout(rawToken: unknown): Promise<{ ok: true; revoked: boolean }> {
    const token = assertRefreshToken(rawToken);
    return { ok: true, revoked: await this.tokens.revokeRefreshToken(token) };
  }

  /**
   * POST /auth/switch-role：账号状态闸（终审 I-1，与 verify/refresh 同款）→ user_roles 含目标
   * 角色 → 重签 access（claims.role=目标）。状态闸前置：BANNED/DELETING 不得凭未过期 token
   * 反复换签续期（铸 token 三入口统一过状态闸，guards 头注不变量）。
   */
  async switchRole(userId: number, rawTarget: unknown): Promise<{ accessToken: string }> {
    const target = assertUserRole(rawTarget);
    const row = await this.pool.query<{ status: UserStatus }>(
      'SELECT status FROM identity.users WHERE id = $1',
      [userId],
    );
    const status = row.rows[0]?.status;
    if (status !== 'ACTIVE') {
      throw new AppError(ErrorCode.AccountBanned, `账号当前不可登录（${status ?? '不存在'}）`);
    }
    const roles = await this.rolesOf(userId, this.pool);
    if (!roles.includes(target)) {
      throw new AppError(ErrorCode.RoleNotHeld, `目标角色未授予：${target}`);
    }
    return { accessToken: await this.tokens.signAccessToken({ userId, role: target, roles }) };
  }

  /** GET /me：DB 实时的角色/状态 + 掩码手机号（明文不出本模块） */
  async me(userId: number): Promise<MeView> {
    const row = await this.pool.query<{ id: string; status: UserStatus; phone_enc: Buffer }>(
      'SELECT id, status, phone_enc FROM identity.users WHERE id = $1',
      [userId],
    );
    const user = row.rows[0];
    if (!user) throw new AppError(ErrorCode.NotFound, `用户 ${userId} 不存在`);
    return {
      id: Number(user.id),
      roles: await this.rolesOf(userId, this.pool),
      status: user.status,
      phoneMasked: this.crypto.maskPhone(this.crypto.decryptPhone(user.phone_enc)),
    };
  }

  /** 建号（ACTIVE/age_declared=true）+ user 角色 + UserRegistered 同事务（§6 →H8/H4） */
  private async createUser(uow: SqlExecutor, phone: string, blind: string): Promise<number> {
    let userId: number;
    try {
      const inserted = await uow.query<{ id: string }>(
        `INSERT INTO identity.users (phone_enc, phone_blind_idx, status, age_declared)
         VALUES ($1, $2, 'ACTIVE', true) RETURNING id`,
        [this.crypto.encryptPhone(phone), blind],
      );
      userId = Number(inserted.rows[0]!.id);
    } catch (e) {
      if (isUniqueViolation(e)) {
        throw new AppError(ErrorCode.Conflict, '注册并发冲突，请重试');
      }
      throw e;
    }
    await uow.query(
      "INSERT INTO identity.user_roles (user_id, role) VALUES ($1, 'user') ON CONFLICT DO NOTHING",
      [userId],
    );
    await this.outbox.recordOutbox(uow, {
      type: USER_REGISTERED_TOPIC,
      payload: { user_id: userId } satisfies UserRegisteredPayload,
    });
    this.logger.log(`identity: 用户注册完成 user_id=${userId}`); // 无明文
    return userId;
  }

  /** 持有角色（R-02：lawyer 账号默认具备 user 身份，两行并存） */
  private async rolesOf(userId: number, exec: SqlExecutor): Promise<UserRole[]> {
    const rows = await exec.query<{ role: UserRole }>(
      'SELECT role FROM identity.user_roles WHERE user_id = $1 ORDER BY role',
      [userId],
    );
    return rows.rows.map((r) => r.role);
  }

  /** 默认激活角色（R-02：默认 user 身份；登录/刷新签发取默认，激活角色变更走 switch-role） */
  private defaultRole(roles: UserRole[]): UserRole {
    if (roles.includes('user')) return 'user';
    if (roles.includes('lawyer')) return 'lawyer';
    throw new AppError(ErrorCode.InternalError, '账号无任何角色（不应触达）');
  }
}
