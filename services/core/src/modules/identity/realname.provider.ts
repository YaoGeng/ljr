/**
 * 实名核验通道适配器（A2 §1「通道 ⚠CTID/三要素」，裁决 D12 默认 + R-W2-5 前置）：
 * 接口=端口（prod 前替换为 CTID/运营商三要素真通道，verify_provider 落通道 kind）；
 * MockRealnameProvider=沙箱 mock（GB 11643 校验位判定 + 随机凭据 token），仅 dev/test。
 *
 * 分层防呆（R-01/§5 400 INVALID_ID vs 核验 FAILED 的边界）：
 *   - 形态层（assertRealnameName / assertRealnameIdNoFormat）：姓名非空、id_no 18 位形态
 *     （末位可 X/x）——不过即 400 INVALID_ID，请求不触达通道；
 *   - 校验位层（isMainlandIdChecksum，mock 通道的「真实性」判定）：形态合法但校验位错
 *     → 通道否决 → 状态 FAILED（可重提），非 400。
 */
import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { AppError, ErrorCode } from '@ljr/shared';

/** 通道绑定 DI 令牌（REALNAME_CONFIG 同款 Symbol 口径）：测试 override 注入计数/可控通道，
 *  prod 换装（CTID/三要素真通道）只改模块工厂，服务与用例不感知实现 */
export const REALNAME_PROVIDER = Symbol('REALNAME_PROVIDER');

export interface RealnameVerifyInput {
  readonly name: string;
  readonly idNo: string;
}

export interface RealnameVerifyVerdict {
  readonly passed: boolean;
  /** 核验凭据原文：调用方只许落 sha256 摘要（verify_token_digest），原文即弃（R-04） */
  readonly token: string;
}

export interface RealnameProvider {
  /** 通道名（落 real_name_infos.verify_provider：CTID|CARRIER3|MOCK…） */
  readonly kind: string;
  verify(input: RealnameVerifyInput): Promise<RealnameVerifyVerdict>;
}

/** 姓名：trim 后非空（纯形态层；上限 64 防滥用）——形态错即 400 INVALID_ID */
export function assertRealnameName(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new AppError(ErrorCode.InvalidId, '姓名必须为字符串');
  }
  const name = raw.trim();
  if (name.length === 0 || name.length > 64) {
    throw new AppError(ErrorCode.InvalidId, '姓名须为 1-64 位非空白字符');
  }
  return name;
}

const ID_NO_PATTERN = /^\d{17}[\dXx]$/;

/** id_no 形态：18 位、前 17 位数字、末位数字或 X/x（x 归一为大写）——形态错即 400 INVALID_ID */
export function assertRealnameIdNoFormat(raw: unknown): string {
  if (typeof raw !== 'string' || !ID_NO_PATTERN.test(raw)) {
    throw new AppError(ErrorCode.InvalidId, '身份证号须为 18 位（末位可为 X）');
  }
  return raw.toUpperCase();
}

const CHECKSUM_WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2] as const;
const CHECK_CODE_MAP = '10X98765432';

/** GB 11643 校验位判定（mock 通道「真实性」判定；形态层之上） */
export function isMainlandIdChecksum(idNo: string): boolean {
  if (!ID_NO_PATTERN.test(idNo)) return false;
  let sum = 0;
  for (let i = 0; i < 17; i += 1) {
    sum += Number(idNo[i]) * CHECKSUM_WEIGHTS[i]!;
  }
  return CHECK_CODE_MAP[sum % 11] === idNo[17];
}

/** 沙箱 mock 通道：校验位合法 → 通过；否则否决（可重提）。凭据=随机 token，无外部副作用。 */
@Injectable()
export class MockRealnameProvider implements RealnameProvider {
  readonly kind = 'MOCK';

  async verify(input: RealnameVerifyInput): Promise<RealnameVerifyVerdict> {
    return {
      passed: isMainlandIdChecksum(input.idNo),
      token: `MOCK-${randomUUID()}`,
    };
  }
}
