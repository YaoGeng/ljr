/**
 * C6 改价引擎纯函数层（施工规格 docs/modules/C-交易/C6-改价与补偿.md §4/§7：R-01 三档矩阵、
 * R-05 补偿计算 + §11/D17 分母口径）。无 IO、无时钟——DB/事件/通知编排在 price-change.service。
 *
 * 金额纪律：全程整数分域（1 元=100 分；积分 100 积分=1 元 → 1 积分=1 分，points==cents），
 * 乘除经 BigInt 精确运算禁 float（C6 §9「补偿金额 float」禁令的执行位）。
 * 档位判定走整数精确比较（delta×10 ≤ old ⇔ 降幅 ≤10%），存储列 change_pct 只作审计展示
 * （三位小数向下取整——非十进整除时展示值可差 ≤0.001%，不影响任何判定，报告注明）。
 */
import type { PriceChangeKind } from '@ljr/shared';
import { AppError, ErrorCode } from '@ljr/shared';

/** 改价方向（§3 direction 值域 UP|DOWN） */
export type ChangeDirection = 'UP' | 'DOWN';

/** 引擎判定出参（§4 流程第 1-2 步的纯判定面） */
export interface ChangeClassification {
  readonly direction: ChangeDirection;
  /** G1 已钉三档词汇（shared PriceChangeKind；出箱 PriceChangeApproved.kind 同值） */
  readonly kind: PriceChangeKind;
  /** |新-旧|/旧，numeric(6,3) 文本（如 "10.000"；审计展示位——档位判定不走本列） */
  readonly changePct: string;
  /** 档位信用惩罚快照（PRD §8.2 在团场景表：UP -5 / LE10 -15 / GT10 -30）；不在团恒 0（自由改价） */
  readonly creditPenalty: number;
  /** 档位本身是否需审批（R-01：在团降价需审批；不在团任何方向不需审批） */
  readonly tierRequiresApproval: boolean;
}

/** R-01 档位信用惩罚（PRD §8.2 在团场景表逐字；不在团=0） */
const TIER_PENALTY: Record<PriceChangeKind, number> = {
  PRICE_UP: -5,
  PRICE_DOWN_LE10: -15,
  PRICE_DOWN_GT10: -30,
};

/** 降价 ≤10% 档边界：delta×10 ≤ old ⇔ delta/old ≤ 0.1（整数精确，10.0% 恰档含端点） */
function isDownLe10(oldCents: number, deltaCents: number): boolean {
  return deltaCents * 10 <= oldCents;
}

/** 百分比（3 位小数）审计文本：BigInt 向下取整（pctMilli = floor(delta/old × 100000)） */
function changePctText(oldCents: number, deltaCents: number): string {
  const pctMilli = (BigInt(deltaCents) * 100_000n) / BigInt(oldCents);
  const whole = pctMilli / 1_000n;
  const frac = (pctMilli % 1_000n).toString().padStart(3, '0');
  return `${whole}.${frac}`;
}

/**
 * R-01 三档判定（§4 输入 old/new 价 + has_active_group）：
 *   - UP → 生效档（在团信用 -5；不在团 0）；DOWN ≤10% → LE10 档；DOWN >10% → GT10 档；
 *   - 不在团：任何方向不需审批、信用 0（PRD「无进行中拼团=自由改价」；补偿对象集同因空集
 *     而无补偿——PRD §8.2 惩罚/补偿两表均为在团场景）。
 * 新旧同价/旧价非正/新价为负 = 契约违例显性拒绝（不静默归零）。
 */
export function classifyChange(
  oldCents: number,
  newCents: number,
  hasActiveGroup: boolean,
): ChangeClassification {
  if (!Number.isSafeInteger(oldCents) || !Number.isSafeInteger(newCents)) {
    throw new AppError(ErrorCode.InternalError, '改价引擎入参越安全整数域（不应触达）');
  }
  if (oldCents <= 0) {
    throw new AppError(ErrorCode.InvalidArgument, `改价基线价须为正（分）：${String(oldCents)}`);
  }
  if (newCents < 0) {
    throw new AppError(ErrorCode.InvalidArgument, `新价不得为负（分）：${String(newCents)}`);
  }
  if (newCents === oldCents) {
    throw new AppError(ErrorCode.InvalidArgument, '新旧价格相同，不构成改价');
  }
  const direction: ChangeDirection = newCents > oldCents ? 'UP' : 'DOWN';
  const delta = Math.abs(newCents - oldCents);
  const kind: PriceChangeKind =
    direction === 'UP'
      ? 'PRICE_UP'
      : isDownLe10(oldCents, delta)
        ? 'PRICE_DOWN_LE10'
        : 'PRICE_DOWN_GT10';
  return {
    direction,
    kind,
    changePct: changePctText(oldCents, delta),
    creditPenalty: hasActiveGroup ? TIER_PENALTY[kind] : 0,
    tierRequiresApproval: hasActiveGroup && direction === 'DOWN',
  };
}

// ---------------------------------------------------------------------------
// R-05 补偿计算（D17 已裁决口径：占比分母=paid_amount 全额=cash+points/100）
// ---------------------------------------------------------------------------

/** 补偿对象（已支付且未完成服务用户；paidCents=paid_amount 全额整化分=cash 分+points） */
export interface CompensationRecipient {
  readonly user_id: number;
  readonly paidCents: number;
}

/** 单用户补偿授予（points 域；1 积分=1 分） */
export interface CompensationItem {
  readonly user_id: number;
  readonly points: number;
}

/**
 * 补偿 =（原-新）× 用户支付占比；占比分母 = Σ 用户 paid_amount 全额（D17 裁决：含积分部分
 * 按 100 积分=1 元整化，全积分用户同权分摊）。向下取整（分）：Σ补偿 ≤ delta（零头不付出，
 * 平台不超付——资损保守侧，报告注明）；取整到 0 的用户不产生授予（F4 grant 域为正整数）。
 * Σpaid=0（无有效支付）/空集 → 无补偿。前提：oldCents > newCents（DOWN）。
 */
export function computeCompensations(
  recipients: readonly CompensationRecipient[],
  oldCents: number,
  newCents: number,
): CompensationItem[] {
  if (oldCents <= newCents) {
    throw new AppError(ErrorCode.InternalError, '补偿计算前提违例：仅 DOWN 档有补偿（不应触达）');
  }
  const delta = BigInt(oldCents - newCents);
  const totalPaid = recipients.reduce((sum, r) => sum + BigInt(r.paidCents), 0n);
  if (totalPaid <= 0n) return [];
  const items: CompensationItem[] = [];
  for (const r of recipients) {
    if (!Number.isSafeInteger(r.paidCents) || r.paidCents < 0) {
      throw new AppError(
        ErrorCode.InternalError,
        `补偿对象 paid_amount 越安全整数域/为负（不应触达）：user=${r.user_id}`,
      );
    }
    const points = Number((delta * BigInt(r.paidCents)) / totalPaid); // BigInt 精确整除=floor
    if (points > 0) items.push({ user_id: r.user_id, points });
  }
  return items;
}
