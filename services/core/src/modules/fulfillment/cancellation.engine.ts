/**
 * D4 取消规则引擎（纯函数，无 IO 无状态——§8「规则表驱动+判定 P95≤100ms」的结构保证面：
 * 单次快照读在 service 层，判定本身=纯计算）。施工规格：docs/modules/D-履约/D4-取消与违约
 * 处理.md §4 判定矩阵/§7 R-01~R-06；参数版本化=H7 规则中心 rule_definitions 表 rule_key='cancel.matrix'
 * （W2-4 决策位），无生效版本→代码内置默认兜底（行为时快照，版本入 STL reason）。
 *
 * 边界语义（PRD §8.7/§8.6「≥2h/≥24h」含端点；G1 credit.consumer 同口径——两侧档位判定
 * 必须一致，退款档与信用档不漂移）：距约定开始 msUntilStart ≥ 窗口 → 免费/通知档；
 * 恰在锚点=免费/通知档（含端点）。
 *
 * 占比分配（R-04/§11 分位余数=首用户）：splitCompensationPool=违约金/赔付池按用户支付额
 * 占比 floor 到分、余数归 user_id 升序首名——F4 splitAbsenceShare 同形（30% 池步骤外置：
 * 调用方先 pctOf 算池，本函数只做占比分配；唯一定义口径=F4 R-04/W2 计划注记，D4 侧不
 * 重复实现 30% 语义）。BigInt 乘法防 2^53 溢出（同 splitAbsenceShare）。
 */
import { AppError, ErrorCode } from '@ljr/shared';
import type {
  CancelMatrixParams,
  CancelRole,
  CompensationAllocation,
  CompensationParticipant,
} from './cancellation.types';

/** rule_definitions 版本化载体键（W2-4；H7 快照读面复用） */
export const CANCEL_MATRIX_RULE_KEY = 'cancel.matrix';

/** 内置默认矩阵（无生效版本兜底；seed 值=W2 计划 T3 行逐字） */
export const DEFAULT_CANCEL_MATRIX: CancelMatrixParams = {
  userFreeCancelHours: 2,
  userLateRefundPct: 50,
  lawyerNoticeHours: 24,
  lawyerLatePenaltyCredit: 30,
  lawyerLatePenaltyPct: 20,
  lawyerAbsencePenaltyCredit: 50,
  lawyerAbsenceCompensationPct: 50,
  suspendWindowDays: 30,
  suspendCount: 2,
  suspendDays: 7,
} as const;

/** 矩阵判定出参（branch 词汇=cancellation.types；附加档位参数回显供 STL/响应） */
export interface MatrixVerdict {
  readonly branch: 'USER_FREE' | 'USER_LATE' | 'LAWYER_NOTICE' | 'LAWYER_LT24H';
  /** USER_LATE：退款比例（%=matrix.userLateRefundPct 回显）；其余档=null */
  readonly userLateRefundPct: number | null;
  /** LAWYER_LT24H：审批工单类目（H3 ticket category）；其余档=null */
  readonly ticketCategory: 'cancel_lt24h' | null;
}

/** 整数字段校验（正整数上界 1e9 防配置恶意大数；drift=InternalError 显性化——credit.rules 同口径） */
function requirePositiveInt(content: Record<string, unknown>, field: string): number {
  const v = content[field];
  if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0 || v > 1_000_000_000) {
    throw new AppError(
      ErrorCode.InternalError,
      `cancel.matrix 内容结构漂移（H7 配置须符合 D4 契约，不应触达）：${field} 须为正整数：${JSON.stringify(v)}`,
    );
  }
  return v;
}

function requirePct(content: Record<string, unknown>, field: string): number {
  const v = requirePositiveInt(content, field);
  if (v > 100) {
    throw new AppError(
      ErrorCode.InternalError,
      `cancel.matrix 内容结构漂移：${field} 须为 1-100（%）：${String(v)}`,
    );
  }
  return v;
}

/**
 * 解析并收窄 cancel.matrix content（H7 快照内容 → CancelMatrixParams）。形态漂移=
 * InternalError（宁炸读端不降级，parseCreditRules 同纪律）；十键全量必填（部分发布=
 * 配置缺口显性化，静默回退默认值会让版本审计失真）。
 */
export function parseCancelMatrix(content: Record<string, unknown>): CancelMatrixParams {
  return {
    userFreeCancelHours: requirePositiveInt(content, 'userFreeCancelHours'),
    userLateRefundPct: requirePct(content, 'userLateRefundPct'),
    lawyerNoticeHours: requirePositiveInt(content, 'lawyerNoticeHours'),
    lawyerLatePenaltyCredit: requirePositiveInt(content, 'lawyerLatePenaltyCredit'),
    lawyerLatePenaltyPct: requirePct(content, 'lawyerLatePenaltyPct'),
    lawyerAbsencePenaltyCredit: requirePositiveInt(content, 'lawyerAbsencePenaltyCredit'),
    lawyerAbsenceCompensationPct: requirePct(content, 'lawyerAbsenceCompensationPct'),
    suspendWindowDays: requirePositiveInt(content, 'suspendWindowDays'),
    suspendCount: requirePositiveInt(content, 'suspendCount'),
    suspendDays: requirePositiveInt(content, 'suspendDays'),
  };
}

const HOUR_MS = 3_600_000;

/**
 * 矩阵判定（§4 全表；R-01/R-02）：
 *   user：msUntilStart ≥ userFreeCancelHours·h → USER_FREE（全退/改期一次）；< → USER_LATE
 *   lawyer：msUntilStart ≥ lawyerNoticeHours·h → LAWYER_NOTICE（全退+G1 -10）；< →
 *     LAWYER_LT24H（H3 审批；category=cancel_lt24h——H3 §3 七值词汇）
 * 恰在锚点=免费/通知档（含端点，PRD ≥ 语义；G1 credit.consumer aheadMs≥HORIZON 同口径）。
 */
export function judgeCancelMatrix(input: {
  readonly role: CancelRole;
  /** 距约定开始毫秒（=scheduled_start−now；负值=已开场，判 <2h/<24h 档） */
  readonly msUntilStart: number;
  readonly matrix: CancelMatrixParams;
}): MatrixVerdict {
  if (!Number.isFinite(input.msUntilStart)) {
    throw new AppError(ErrorCode.InternalError, `msUntilStart 须为有限数值`);
  }
  const m = input.matrix;
  if (input.role === 'user') {
    if (input.msUntilStart >= m.userFreeCancelHours * HOUR_MS) {
      return { branch: 'USER_FREE', userLateRefundPct: null, ticketCategory: null };
    }
    return { branch: 'USER_LATE', userLateRefundPct: m.userLateRefundPct, ticketCategory: null };
  }
  if (input.msUntilStart >= m.lawyerNoticeHours * HOUR_MS) {
    return { branch: 'LAWYER_NOTICE', userLateRefundPct: null, ticketCategory: null };
  }
  return { branch: 'LAWYER_LT24H', userLateRefundPct: null, ticketCategory: 'cancel_lt24h' };
}

/**
 * 比例池（整数分，floor；BigInt 域防溢出）：baseCents×pct/100——R-04 违约金/赔付基数的
 * 百分步（20%/50%）；pct 1-100。结果 ≤ base（floor 不放大）。
 */
export function pctOfCents(baseCents: number, pct: number): number {
  if (!Number.isInteger(baseCents) || baseCents < 0 || baseCents > Number.MAX_SAFE_INTEGER) {
    throw new AppError(ErrorCode.InvalidArgument, `baseCents 须为非负整数：${String(baseCents)}`);
  }
  if (!Number.isInteger(pct) || pct <= 0 || pct > 100) {
    throw new AppError(ErrorCode.InvalidArgument, `pct 须为 1-100 整数：${String(pct)}`);
  }
  return Number((BigInt(baseCents) * BigInt(pct)) / 100n);
}

/**
 * 违约金/赔付占比分配（R-04/§11 分位余数=首用户）：pool_cents 按参与方 paid_cents 占比
 * floor 到分，余数（pool−Σfloor）整份归 user_id 升序首名——输出按 user_id 升序（确定性
 * 口径的可观察面）。约束：participants 非空、user_id 唯一正整数、paid_cents 非负整数、
 * 占比分母（Σpaid）>0（比例无定义显性拒绝，splitAbsenceShare 同口径）。
 */
export function splitCompensationPool(
  poolCents: number,
  participants: readonly CompensationParticipant[],
): CompensationAllocation[] {
  if (!Number.isInteger(poolCents) || poolCents < 0 || poolCents > Number.MAX_SAFE_INTEGER) {
    throw new AppError(ErrorCode.InvalidArgument, `pool_cents 须为非负整数：${String(poolCents)}`);
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
      throw new AppError(
        ErrorCode.InvalidArgument,
        `paid_cents 须为非负整数：${String(p.paid_cents)}`,
      );
    }
    if (seen.has(p.user_id)) {
      throw new AppError(ErrorCode.InvalidArgument, `user_id 重复：${String(p.user_id)}`);
    }
    seen.add(p.user_id);
    totalPaid += p.paid_cents;
  }
  if (totalPaid <= 0) {
    throw new AppError(ErrorCode.InvalidArgument, '参与方 paid_cents 合计须 > 0（占比分母）');
  }

  const bigTotal = BigInt(totalPaid);
  const sorted = [...participants].sort((a, b) => a.user_id - b.user_id);
  const shares = sorted.map((p) => Number((BigInt(poolCents) * BigInt(p.paid_cents)) / bigTotal));
  const remainder = poolCents - shares.reduce((s, v) => s + v, 0);
  shares[0] = (shares[0] ?? 0) + remainder; // 余数归升序首名（§11 实现约定）

  return sorted.map((p, i) => ({ user_id: p.user_id, amount_cents: shares[i]! }));
}
