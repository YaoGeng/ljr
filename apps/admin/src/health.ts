export const ADMIN_APP_NAME = '律聚人 · 运营后台';

/** 骨架占位健康状态：真实依赖检查（DB/Redis 等）随 M0-9 观测基座接入 */
export function healthStatus(): 'ok' {
  return 'ok';
}
