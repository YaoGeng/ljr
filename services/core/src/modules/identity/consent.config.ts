/**
 * A2 同意管理配置（裁决 R-W2-6：policy_version 当前有效值配置化，⚠决策位默认 v1.0.0）。
 *
 * 读取口径与 notify.config.ts 相同：进程 env > 代码默认。
 * POST /consents/training 传入 policy_version ≠ 当前有效值 → 409 VERSION_MISMATCH（§5）；
 * 授权页「同版本不重复弹」（§8）的版本事实源即此值，运营升版改 env 即换页。
 */
import type { InjectionToken } from '@nestjs/common';
import { AppError, ErrorCode } from '@ljr/shared';

export interface ConsentConfig {
  /** 当前有效训练授权政策版本（POST /consents/training 唯一放行值；默认 v1.0.0） */
  readonly trainingPolicyVersion: string;
}

/** DI 令牌（RULE_CENTER_CONFIG 同款 Symbol 口径，运行时无类型 token 可寻址） */
export const CONSENT_CONFIG: InjectionToken<ConsentConfig> = Symbol('CONSENT_CONFIG');

export const CONSENT_DEFAULT_CONFIG: ConsentConfig = {
  trainingPolicyVersion: 'v1.0.0',
};

export function consentConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ConsentConfig {
  const raw = env['LJR_CONSENT_TRAINING_POLICY_VERSION'];
  const version =
    raw !== undefined && raw !== '' ? raw : CONSENT_DEFAULT_CONFIG.trainingPolicyVersion;
  if (!/^[a-zA-Z0-9.-]{1,16}$/.test(version)) {
    throw new AppError(
      ErrorCode.ConfigInvalid,
      'LJR_CONSENT_TRAINING_POLICY_VERSION 须为 1-16 位字母/数字/点/连字符',
    );
  }
  return { trainingPolicyVersion: version };
}
