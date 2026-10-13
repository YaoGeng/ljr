/**
 * 幂等键契约（M0-4 锁定）：键规范 `domain/entity/event`，三段小写、`/` 分隔。
 *
 *   例：demo/order-42/completed、payment/order-123/refund
 *   —— 实体段携带实例标识（id），使「同域同类动作按实体粒度幂等」。
 *
 * withIdempotency(key, fn)：进程内同键短路 —— 首访执行 fn 并缓存其结果（含失败），
 * 重复键不再执行 fn、直接返回首访结果。
 * 注意：这是进程级短路，进程重启即失效；持久幂等由 DB 唯一约束承担
 * （架构 §4.4 payment_orders.idempotency_key 唯一约束 / core 基座的守卫+outbox 同事务写入）。
 */
import { AppError, ErrorCode } from './error-codes';

/** 每段 1-32 个字符：小写字母开头，后续小写字母/数字/下划线/连字符/点 */
const IDEMPOTENCY_KEY_PATTERN = /^[a-z][a-z0-9_.-]{0,31}(\/[a-z][a-z0-9_.-]{0,31}){2}$/;

export function isValidIdempotencyKey(key: string): boolean {
  return IDEMPOTENCY_KEY_PATTERN.test(key);
}

const inflight = new Map<string, Promise<unknown>>();

export function withIdempotency<T>(key: string, fn: () => T | Promise<T>): Promise<T> {
  if (!isValidIdempotencyKey(key)) {
    throw new AppError(
      ErrorCode.IdempotencyKeyInvalid,
      `非法幂等键：${JSON.stringify(key)}（规范 domain/entity/event，如 demo/order-42/completed）`,
    );
  }
  const existing = inflight.get(key) as Promise<T> | undefined;
  if (existing) return existing;

  const first = Promise.resolve().then(fn);
  // 失败结果同样缓存（「返回首访结果」口径：重复键拿到同一 rejection）；
  // 若需失败重试语义，调用方换新键或走 DB 级幂等。
  inflight.set(key, first);
  first.catch(() => undefined); // 防止未捕获 rejection 告警（缓存已持有该 rejection）
  return first;
}
