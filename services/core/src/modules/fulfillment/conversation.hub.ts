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
 *
 * 角色定向投递（M2-W3 T4 纯加法，W3-6）：订阅登记可携 role（WSS join 时的 JWT claims.role）
 * ——publishTo(conversationId, roles, frame) 只投给注册角色命中者。承载 E1 草稿帧的
 * R-04「草稿标注仅律师端可见」：agent-assist 侧 publishTo(..., ['lawyer'], ...)，user 订阅者
 * 零收到。未携 role 的订阅者（legacy 形态/非网关注册）不收角色过滤帧——保守面（宁可漏投
 * 不可越权投），漏投由 HTTP 补拉面（GET /agent/drafts）收敛。
 */
import { Injectable } from '@nestjs/common';

/** 订阅者投递面（网关实现：序列化+readyState 检查；同步派发，抛错由订阅方自吞不影响他人） */
export type ConversationSubscriber = (frame: string) => void;

/** 订阅者角色（W3-6：publishTo 角色过滤的登记面；undefined=未登记（不收角色过滤帧）） */
export type SubscriberRole = 'user' | 'lawyer';

/** 广播帧（序列化前对象；message 形态承载 MessageView，控制帧走 publishRaw） */
export interface HubMessageFrame {
  readonly type: 'message';
  readonly conversation_id: number;
  readonly message: unknown;
}

@Injectable()
export class ConversationHub {
  /** conversation_id → 订阅者→role（Map 键=稳定函数引用，与 Set 同幂等语义） */
  private readonly subscribers = new Map<
    number,
    Map<ConversationSubscriber, SubscriberRole | undefined>
  >();

  /** 订阅会话（join 时调用；同订阅者重复订阅幂等——引用稳定性由调用方保证；role=W3-6 可选，
   *  向后兼容：既有调用（无 role）行为不变——publish/publishRaw 仍全员投递） */
  subscribe(
    conversationId: number,
    subscriber: ConversationSubscriber,
    role?: SubscriberRole,
  ): void {
    const map = this.subscribers.get(conversationId) ?? new Map();
    map.set(subscriber, role);
    this.subscribers.set(conversationId, map);
  }

  /** 退订会话（leave/断连时调用；幂等——须传订阅时的同一函数引用） */
  unsubscribe(conversationId: number, subscriber: ConversationSubscriber): void {
    const map = this.subscribers.get(conversationId);
    if (!map) return;
    map.delete(subscriber);
    if (map.size === 0) this.subscribers.delete(conversationId);
  }

  /** 广播消息帧到会话全体订阅者（房间成员=已 join 的连接；单订阅者异常隔离不连坐） */
  publish(conversationId: number, frame: HubMessageFrame): void {
    this.dispatch(conversationId, JSON.stringify(frame));
  }

  /** 广播控制帧（recording_started 等非 message 形态；同订阅面） */
  publishRaw(conversationId: number, frame: Record<string, unknown>): void {
    this.dispatch(conversationId, JSON.stringify(frame));
  }

  /**
   * 角色定向控制帧（W3-6，M2-W3 T4 纯加法）：只投给注册角色∈roles 的订阅者——E1 草稿/
   * 拦截/降级帧的 R-04 律师端可见性承载。未携 role 的订阅者不收（保守面，头注「角色定向
   * 投递」段）；单订阅者异常隔离与 publish 同款。
   */
  publishTo(
    conversationId: number,
    roles: readonly SubscriberRole[],
    frame: Record<string, unknown>,
  ): void {
    const map = this.subscribers.get(conversationId);
    if (!map) return;
    const payload = JSON.stringify(frame);
    for (const [subscriber, role] of map) {
      if (role === undefined || !roles.includes(role)) continue;
      try {
        subscriber(payload);
      } catch {
        // 单订阅者投递异常隔离（publish 同款）：不中断其余订阅者；该连接靠心跳/断连收敛
      }
    }
  }

  /** 观测面（测试/运维：会话在线订阅者计数） */
  subscriberCount(conversationId: number): number {
    return this.subscribers.get(conversationId)?.size ?? 0;
  }

  private dispatch(conversationId: number, payload: string): void {
    const map = this.subscribers.get(conversationId);
    if (!map) return;
    for (const subscriber of map.keys()) {
      try {
        subscriber(payload);
      } catch {
        // 单订阅者投递异常（socket 半开等）隔离：不中断其余成员广播；该连接靠心跳/断连收敛
      }
    }
  }
}
