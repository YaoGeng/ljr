/**
 * agent-assist 独立服务骨架（M0-2）。
 * 实现栈随本服务施工时裁决（ADR-0001）。边界预告（架构硬约束）：
 * Agent 输出永不直接进入房间公屏；用户原文进 LLM 前必须过实时脱敏层。
 */
export const SERVICE_NAME = 'agent-assist';

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
