/**
 * D5 进程内广播总线（§4 发送链 dev 形态末段：「单事务持久化 → 进程内广播房间成员」）。
 *
 * 形态裁定（⚠W1-2 + 发送链 dev 顺序裁决）：W1=WSS 网关进 core 单进程，广播=内存订阅表
 * （conversation_id → 订阅者集合）；架构 §3.3-1 生产形态=广播先行+MQ 异步持久化，dev 单进程
 * 反序=先持久后广播（正确性不降级：广播丢失由断线补拉 after_seq 收敛）。**换装时序钉在
 * ConversationService.sendMessage 头注**——剥离 rtc-im（V2 演进）时本件随网关迁出，服务侧
 * 只依赖本抽象（publish），订阅面归网关。
 *
 * 隔离纪律：publish 只投递已提交消息（事务后调用）；BLOCKED 消息不可达本层（拦截在持久化前，
 * 「其他成员零收到」由发送链顺序保证）。
 */
import { Injectable } from '@nestjs/common';

/** 订阅者投递面（网关实现：序列化+readyState 检查；同步派发，抛错由订阅方自吞不影响他人） */
export type ConversationSubscriber = (frame: string) => void;

/** 广播帧（序列化前对象；message 形态承载 MessageView，控制帧走 publishRaw） */
export interface HubMessageFrame {
  readonly type: 'message';
  readonly conversation_id: number;
  readonly message: unknown;
}

@Injectable()
export class ConversationHub {
  private readonly subscribers = new Map<number, Set<ConversationSubscriber>>();

  /** 订阅会话（join 时调用；同订阅者重复订阅幂等——订阅函数引用稳定性由调用方保证） */
  subscribe(conversationId: number, subscriber: ConversationSubscriber): void {
    const set = this.subscribers.get(conversationId) ?? new Set();
    set.add(subscriber);
    this.subscribers.set(conversationId, set);
  }

  /** 退订会话（leave/断连时调用；幂等——须传订阅时的同一函数引用） */
  unsubscribe(conversationId: number, subscriber: ConversationSubscriber): void {
    const set = this.subscribers.get(conversationId);
    if (!set) return;
    set.delete(subscriber);
    if (set.size === 0) this.subscribers.delete(conversationId);
  }

  /** 广播消息帧到会话全体订阅者（房间成员=已 join 的连接；单订阅者异常隔离不连坐） */
  publish(conversationId: number, frame: HubMessageFrame): void {
    this.dispatch(conversationId, JSON.stringify(frame));
  }

  /** 广播控制帧（recording_started 等非 message 形态；同订阅面） */
  publishRaw(conversationId: number, frame: Record<string, unknown>): void {
    this.dispatch(conversationId, JSON.stringify(frame));
  }

  /** 观测面（测试/运维：会话在线订阅者计数） */
  subscriberCount(conversationId: number): number {
    return this.subscribers.get(conversationId)?.size ?? 0;
  }

  private dispatch(conversationId: number, payload: string): void {
    const set = this.subscribers.get(conversationId);
    if (!set) return;
    for (const subscriber of set) {
      try {
        subscriber(payload);
      } catch {
        // 单订阅者投递异常（socket 半开等）隔离：不中断其余成员广播；该连接靠心跳/断连收敛
      }
    }
  }
}
