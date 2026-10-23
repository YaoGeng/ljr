/**
 * admin 会话的 React 绑定（M3-W3 T1）：useSyncExternalStore 订阅 session.ts 纯态存储。
 * 放独立文件以保持 session.ts 无 react import（bun test 直测纯模块，app 侧 useSession 同形态）。
 */
import { useSyncExternalStore } from 'react';
import { getAdminSessionSnapshot, subscribeAdminSession } from './session';

export function useAdminSession() {
  return useSyncExternalStore(
    subscribeAdminSession,
    getAdminSessionSnapshot,
    getAdminSessionSnapshot,
  );
}
