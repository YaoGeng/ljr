/**
 * 领域事件契约（骨架占位）。
 * 事件流是模块协作唯一通道（架构 §2.1 Outbox），具名清单以 docs/04 §6 为准，M0-4 起逐批充实。
 */
export interface DomainEvent {
  /** 事件类型（具名以 docs/04 §6 领域事件清单为准） */
  readonly type: string;
  /** 事件体（占位，随各事件具名定义细化） */
  readonly payload: unknown;
}
