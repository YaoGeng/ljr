/**
 * 金额契约（骨架占位）。架构硬约束：金额一律 NUMERIC(12,2) 禁 float，走 pg NUMERIC 字符串往返。
 * M0-4 锁定：assertMoney(v): Money（两位小数校验，非法抛 AppError）。
 */
export type Money = string;
