/**
 * A2 实名配置（⚠决策位：密文留存开关取 R-04 文档口径默认值，env 可覆盖；随批次集中汇报）。
 *
 * 读取口径与 notify.config.ts 相同：进程 env > 代码默认。
 * R-04 密文最小化：默认仅存核验结果 + 凭据摘要（name_enc/id_no_enc=NULL）；留存开关仅为
 * 「纠纷处理目的留存」（§3 列注释）预留——开启后新核验写入密文列，受控解密（审批+双人复核）
 * 才是唯一读出口。存量 NULL 行不受开关影响（解密时按行判定）。
 */
import type { InjectionToken } from '@nestjs/common';
import { AppError, ErrorCode } from '@ljr/shared';

export interface RealnameConfig {
  /**
   * 实名密文留存开关（R-04 默认关=仅存摘要；true=新核验同时落 name_enc/id_no_enc 密文列）。
   * env：LJR_IDENTITY_REALNAME_RETAIN_ENC（'true'/'false'，非法值 fail-fast——与 publicationMs
   * 同口径：合规姿态参数不容错回落，防「显式设置被静默吞成默认」）。
   */
  readonly retainIdentityText: boolean;
}

/** DI 令牌（RULE_CENTER_CONFIG 同款 Symbol 口径，运行时无类型 token 可寻址） */
export const REALNAME_CONFIG: InjectionToken<RealnameConfig> = Symbol('REALNAME_CONFIG');

export const REALNAME_DEFAULT_CONFIG: RealnameConfig = {
  retainIdentityText: false,
};

export function realnameConfigFromEnv(env: NodeJS.ProcessEnv = process.env): RealnameConfig {
  const raw = env['LJR_IDENTITY_REALNAME_RETAIN_ENC'];
  if (raw === undefined || raw === '') {
    return { ...REALNAME_DEFAULT_CONFIG };
  }
  if (raw !== 'true' && raw !== 'false') {
    throw new AppError(
      ErrorCode.ConfigInvalid,
      'LJR_IDENTITY_REALNAME_RETAIN_ENC 须为 true/false，收到非布尔值',
    );
  }
  return { retainIdentityText: raw === 'true' };
}
