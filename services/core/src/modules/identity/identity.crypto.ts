/**
 * A1 手机号加密与盲索引（裁决 R-W2-11/R-W2-12，lj-data-security 执行层）。
 *
 * - 列加密：AES-256-GCM（node:crypto），信封=「01 版本位 + iv(12B) + auth tag(16B) + 密文」；
 *   mock KMS 口径——数据密钥经 env 注入（dev-only 派生默认），prod 前整体换装真 KMS
 *   （DEK 由 KMS 包裹），本接口形态不变（适配位）。
 * - 盲索引：HMAC-SHA256(phone, pepper) hex64——加密列不可查询场景下的唯一等值检索入口
 *   （ux_users_phone）。pepper 与数据密钥分离：密文泄露不放大盲索引撞库面，反之亦然。
 * - 明文手机号禁落库/落日志/落事件载荷（本模块所有出口只允许密文、盲索引或掩码形态）。
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { AppError, ErrorCode } from '@ljr/shared';
import { IDENTITY_CONFIG, type IdentityConfig } from './identity.config';

/** 大陆手机号口径（R-W2-12：入参按大陆 11 位校验，PRD §7.1.1） */
export const MAINLAND_PHONE_PATTERN = /^1[3-9]\d{9}$/;

/** 密文格式版本位（换装真 KMS / 轮换密钥时的前向区分位） */
const ENC_VERSION = 0x01;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** R-W2-12：非大陆 11 位手机号 → 400 E_INVALID_ARGUMENT（原样回显号码不落日志） */
export function assertMainlandPhone(raw: unknown): string {
  if (typeof raw !== 'string' || !MAINLAND_PHONE_PATTERN.test(raw)) {
    throw new AppError(ErrorCode.InvalidArgument, '手机号必须为大陆 11 位格式（1[3-9] 开头）');
  }
  return raw;
}

/** 验证码哈希（sha256(code + ':' + blind_idx) hex64）：码值不落明文，盲索引作上下文防跨号碰撞 */
export function hashCodeValue(code: string, blindIdx: string): string {
  return createHash('sha256').update(`${code}:${blindIdx}`, 'utf8').digest('hex');
}

@Injectable()
export class IdentityCryptoService {
  constructor(@Inject(IDENTITY_CONFIG) private readonly config: IdentityConfig) {}

  /** 盲索引：HMAC-SHA256(phone, pepper) hex64 */
  blindIndex(phone: string): string {
    return createHmac('sha256', this.config.phoneBlindPepper).update(phone, 'utf8').digest('hex');
  }

  /** 列加密：01 + iv(12) + tag(16) + AES-256-GCM 密文（每次加密独立 iv） */
  encryptPhone(phone: string): Buffer {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.config.phoneDataKey, iv);
    const ct = Buffer.concat([cipher.update(phone, 'utf8'), cipher.final()]);
    return Buffer.concat([Buffer.from([ENC_VERSION]), iv, cipher.getAuthTag(), ct]);
  }

  /** 列解密：版本位/长度不符即 E_INTERNAL（数据损坏或非本模块密文，不静默） */
  decryptPhone(blob: Buffer): string {
    if (blob.length < 1 + IV_BYTES + TAG_BYTES || blob[0] !== ENC_VERSION) {
      throw new AppError(ErrorCode.InternalError, 'phone_enc 密文格式非法（版本位/长度不符）');
    }
    const iv = blob.subarray(1, 1 + IV_BYTES);
    const tag = blob.subarray(1 + IV_BYTES, 1 + IV_BYTES + TAG_BYTES);
    const ct = blob.subarray(1 + IV_BYTES + TAG_BYTES);
    const decipher = createDecipheriv('aes-256-gcm', this.config.phoneDataKey, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  }

  /** 掩码（/me phone_masked）：138****5678 形态 */
  maskPhone(phone: string): string {
    return `${phone.slice(0, 3)}****${phone.slice(-4)}`;
  }

  /** 验证码恒时比较（防时序侧信道）：sha256(code:blind) 与库内哈希比对 */
  codeMatches(code: string, blindIdx: string, storedHash: string): boolean {
    const computed = Buffer.from(hashCodeValue(code, blindIdx), 'hex');
    let stored: Buffer;
    try {
      stored = Buffer.from(storedHash, 'hex');
    } catch {
      return false;
    }
    return computed.length === stored.length && timingSafeEqual(computed, stored);
  }
}
