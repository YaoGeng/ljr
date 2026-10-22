/**
 * session 的 React 绑定（M3-W1 T1）：useSyncExternalStore 订阅 session.ts 纯态存储。
 * 放独立文件以保持 session.ts 平台无关（bun test 不引 react）。
 */
import { useSyncExternalStore } from 'react';
import { getSessionSnapshot, subscribeSession } from './session';

export function useSession() {
  return useSyncExternalStore(subscribeSession, getSessionSnapshot, getSessionSnapshot);
}
