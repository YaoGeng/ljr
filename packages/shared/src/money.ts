/**
 * 金额契约（M0-4 锁定）。架构硬约束（§1.3/§4.3）：金额一律 NUMERIC(12,2) 禁 float，
 * pg NUMERIC 往返字符串 —— Money 类型即 string，严禁 number。
 *
 * assertMoney(v): Money —— 两位小数校验，非法抛 AppError(MoneyInvalidFormat, 422)。
 */
import { AppError, ErrorCode } from './error-codes';

export type Money = string;

/** NUMERIC(12,2)：整数位最多 10 位；两位小数必填；非负（方向由 split_ledgers.direction 等业务列表达） */
const MONEY_PATTERN = /^(0|[1-9][0-9]{0,9})\.[0-9]{2}$/;

export function isValidMoney(v: unknown): v is Money {
  return typeof v === 'string' && MONEY_PATTERN.test(v);
}

export function assertMoney(v: string): Money {
  if (!isValidMoney(v)) {
    throw new AppError(
      ErrorCode.MoneyInvalidFormat,
      `非法金额：${JSON.stringify(v)}（要求非负 NUMERIC(12,2) 两位小数字符串，如 "199.00"）`,
    );
  }
  return v;
}
