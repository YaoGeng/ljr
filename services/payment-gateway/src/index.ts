/**
 * payment-gateway 独立服务骨架（M0-2）。
 * 实现栈随本服务施工时裁决（ADR-0001）。边界预告（架构硬约束）：
 * 资金不过平台账户（持牌机构分账）；生产支付通道禁止封装为 agent 可调用工具。
 */
export const SERVICE_NAME = 'payment-gateway';

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
