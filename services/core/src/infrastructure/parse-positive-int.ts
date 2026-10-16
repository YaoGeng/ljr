/**
 * 横切十进制正整数字符串解析（G-B 收敛批做项4）：B1/B3 的 parseLawyerId 与 G1 的 parseOwnerId
 * 三处模块实现统一收口于此——此前 Number() 宽解析会误收 0x10/1e2/科学计数形态，且无
 * MAX_SAFE_INTEGER 上限（超长数字静默精度丢失后下游 PG 越界 22003→500）。
 *
 * 口径：仅接受纯十进制整数字符串（^\d+$），值 ∈ [1, Number.MAX_SAFE_INTEGER]；
 * 其余一律 400 E_INVALID_ARGUMENT（非法入参不出 500）。
 */
import { AppError, ErrorCode } from '@ljr/shared';

const DECIMAL_POSITIVE_INT = /^\d+$/;

/** 十进制正整数字符串 → 数值；非法形态/0/超安全整数上限 → 400（field=错误消息里的参数名） */
export function parsePositiveInt(raw: unknown, field: string): number {
  if (typeof raw !== 'string' || !DECIMAL_POSITIVE_INT.test(raw)) {
    throw new AppError(
      ErrorCode.InvalidArgument,
      `${field} 须为十进制正整数：${JSON.stringify(raw)}`,
    );
  }
  const value = Number(raw);
  if (value === 0) {
    throw new AppError(ErrorCode.InvalidArgument, `${field} 须为正整数：${raw}`);
  }
  if (!Number.isSafeInteger(value)) {
    throw new AppError(
      ErrorCode.InvalidArgument,
      `${field} 超出安全整数上限（须 ≤ ${Number.MAX_SAFE_INTEGER}）：${raw}`,
    );
  }
  return value;
}
