/**
 * rtc-im 独立服务骨架（M0-2）。
 * 实现栈随本服务施工时裁决（ADR-0001：独立伸缩/发布节奏），本包仅占位 + 启动约定。
 */
export const SERVICE_NAME = 'rtc-im';

export interface ServiceBootstrap {
  /** 启动服务（占位：无副作用，立即返回） */
  start(): Promise<void>;
  /** 停止服务（占位：无副作用，立即返回） */
  stop(): Promise<void>;
}

export function createServiceSkeleton(): ServiceBootstrap {
  return {
    async start() {},
    async stop() {},
  };
}
