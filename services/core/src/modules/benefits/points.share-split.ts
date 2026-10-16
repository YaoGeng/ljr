/**
 * R-04 缺席 30% 分摊取整纯函数（F4 §7 R-04 逐字口径；「分摊计算与取整由本模块唯一定义」——
 * 消费方 D3 仅发 AttendanceAdjudicated 事件，M2 接线时 import 本函数，不得重复实现）。
 *
 * 口径（Task 2 简报裁决逐字）：
 *   每用户分配额 = 30% 总额 × (本人 paid_amount ÷ 到场 paid_amount 合计)，向下取整到分，
 *   余数归 user_id 升序首名；积分化 ×100。
 *
 * 单位口径：全程 int 域（分）——30% 池先 floor 到分，再按占比 floor 分配，余数（30% 池
 * 减 Σ分配额）整份额加给 user_id 升序首名。积分化：1 分 = 0.01 元 = 1 积分（100 积分=1 元），
 * 故 points === share_cents（恒等式即「元 ×100」的 int 域等价形态，spec 矩阵钉死）。
 * 极端占比下 pool30 × paid_i 可超 2^53（NUMERIC(12,2) 上限池 × 上限 paid），乘法走 BigInt。
 *
 * 纯函数无 IO 无状态：本切片只落定义+全边界单测（D3=M2 消费），不接事件不落表。
 */
import { AppError, ErrorCode } from '@ljr/shared';

/** 单用户分摊结果（share_cents=金额份额；points=积分份额，恒等于 share_cents） */
export interface AbsenceShareAllocation {
  readonly user_id: number;
  readonly share_cents: number;
  readonly points: number;
}

export interface AbsenceShareParticipant {
  readonly user_id: number;
  /** 本人在场期间实付金额（分；R-07 口径 = cash + points/100 全额，由调用方 F3/D3 整化传入） */
  readonly paid_cents: number;
}

/**
 * 缺席 30% 分摊（R-04）：pool_cents=待分总额（分，缺席者支付池全额，30% 在函数内计算）；
 * 输出按 user_id 升序（余数归首名的确定性口径的可观察面）。
 */
export function splitAbsenceShare(
  pool_cents: number,
  participants: readonly AbsenceShareParticipant[],
): AbsenceShareAllocation[] {
  if (!Number.isInteger(pool_cents) || pool_cents < 0 || pool_cents > Number.MAX_SAFE_INTEGER) {
    throw new AppError(ErrorCode.InvalidArgument, `pool_cents 须为非负整数：${String(pool_cents)}`);
  }
  if (!Array.isArray(participants) || participants.length === 0) {
    throw new AppError(ErrorCode.InvalidArgument, 'participants 须为非空数组');
  }
  const seen = new Set<number>();
  let totalPaid = 0;
  for (const p of participants) {
    if (!Number.isInteger(p.user_id) || p.user_id <= 0) {
      throw new AppError(ErrorCode.InvalidArgument, `user_id 须为正整数：${String(p.user_id)}`);
    }
    if (!Number.isInteger(p.paid_cents) || p.paid_cents < 0) {
      throw new AppError(ErrorCode.InvalidArgument, `paid_cents 须为非负整数：${String(p.paid_cents)}`);
    }
    if (seen.has(p.user_id)) {
      throw new AppError(ErrorCode.InvalidArgument, `user_id 重复：${String(p.user_id)}`);
    }
    seen.add(p.user_id);
    totalPaid += p.paid_cents;
  }
  if (totalPaid <= 0) {
    // 占比分母为 0：比例无定义，显性拒绝（不静默把池归首名）
    throw new AppError(ErrorCode.InvalidArgument, '到场用户 paid_cents 合计须 > 0（占比分母）');
  }

  // 30% 池 floor 到分（pool×3 ≤ 3×2^53 安全；更大数据由调用方分片）
  const pool30 = Math.floor((pool_cents * 3) / 10);
  // 占比分配：BigInt 域做乘法防 2^53 溢出（结果 share ≤ pool30 < 2^53 回 Number 安全）
  const bigTotal = BigInt(totalPaid);
  const sorted = [...participants].sort((a, b) => a.user_id - b.user_id);
  const shares = sorted.map((p) => Number((BigInt(pool30) * BigInt(p.paid_cents)) / bigTotal));
  // 余数 = 30% 池 - Σfloor 份额，整份额归升序首名
  const remainder = pool30 - shares.reduce((s, v) => s + v, 0);
  shares[0] = (shares[0] ?? 0) + remainder;

  return sorted.map((p, i) => ({
    user_id: p.user_id,
    share_cents: shares[i]!,
    points: shares[i]!, // 1 分 = 1 积分（= 元 ×100 的 int 域恒等形态）
  }));
}
