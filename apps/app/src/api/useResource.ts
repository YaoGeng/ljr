/**
 * 轻量数据装载 hook（M3-W1 T2，⚠W1-3 同款零依赖口径：不引 react-query）。
 *
 * 形态：loading/ready/error 三相 + reload 重取；deps 变化或 reload 触发重装，
 * 卸载/重入后的迟到应答丢弃（alive 守卫）。错误原样抛给 state（AppApiError 交由
 * 视图层按 error-messages 映射展示——fail-visible）。
 */
import { useCallback, useEffect, useState } from 'react';
import { AppApiError } from './client';

export type ResourceState<T> =
  | { readonly phase: 'loading' }
  | { readonly phase: 'ready'; readonly data: T }
  | { readonly phase: 'error'; readonly error: unknown };

export interface Resource<T> {
  readonly state: ResourceState<T>;
  readonly reload: () => void;
}

export function useResource<T>(loader: () => Promise<T>, deps: readonly unknown[]): Resource<T> {
  const [tick, setTick] = useState(0);
  const [state, setState] = useState<ResourceState<T>>({ phase: 'loading' });

  useEffect(() => {
    let alive = true;
    setState({ phase: 'loading' });
    loader().then(
      (data) => {
        if (alive) setState({ phase: 'ready', data });
      },
      (error: unknown) => {
        if (alive) setState({ phase: 'error', error });
      },
    );
    return () => {
      alive = false;
    };
    // deps 由调用方显式给出（数组展开；装载函数随 deps 闭包更新）
  }, [...deps, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { state, reload };
}

/** 错误态展示文案（AppApiError→映射文案已解析在 message；其他→通用兜底） */
export function resourceErrorMessage(error: unknown): string {
  if (error instanceof AppApiError) return error.message;
  return '操作失败，请稍后重试';
}
