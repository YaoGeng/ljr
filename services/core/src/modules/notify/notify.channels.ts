/**
 * 通知通道适配层（I1 §2：App 推送 / SMS / 站内信）。
 *
 * 外部对接后置约定（工作约定 2026-10-14）：推送/SMS 供应商开发期一律 mock 适配器，
 * 接口留供应商位——真实厂商通道在 M2+ 经同一 NotifyChannelAdapter 接口替换；
 * 站内信=落 notify.notifications 表本身（行即消息，SENT 即对用户可见），send 无外部副作用。
 */
import { Inject, Injectable } from '@nestjs/common';
import { AppError, ErrorCode } from '@ljr/shared';

export type NotifyChannel = 'PUSH' | 'SMS' | 'INBOX';

export interface NotifyChannelMessage {
  readonly userId: number;
  readonly templateCode: string;
  /** 模板渲染后的最终文案（话术不出模板中心，通道只管投递） */
  readonly content: string;
  readonly params: Record<string, unknown>;
}

export interface NotifyChannelAdapter {
  readonly channel: NotifyChannel;
  /**
   * 投递语义 at-least-once：下发成功与回执落库非同一原子操作（崩溃窗口内可能重发），
   * 供应商侧去重要求随真实通道接入时对齐（M2+）。
   */
  send(message: NotifyChannelMessage): Promise<void>;
}

/** 通道适配器集合的 DI token（测试可 override 注入失败/桩适配器） */
export const NOTIFY_CHANNEL_ADAPTERS = Symbol('NOTIFY_CHANNEL_ADAPTERS');

/** App 推送 mock：零外部调用，命中即视为触达成功（供应商位=M2+） */
@Injectable()
export class MockPushChannelAdapter implements NotifyChannelAdapter {
  readonly channel = 'PUSH' as const;

  async send(_message: NotifyChannelMessage): Promise<void> {
    // mock：无外部副作用
  }
}

/** SMS mock：零外部调用、零凭据（供应商位=M2+；凭据经 env 注入，禁落源码） */
@Injectable()
export class MockSmsChannelAdapter implements NotifyChannelAdapter {
  readonly channel = 'SMS' as const;

  async send(_message: NotifyChannelMessage): Promise<void> {
    // mock：无外部副作用
  }
}

/** 站内信：notify.notifications 行即消息，标记 SENT 即对用户可见（GET /notifications/mine） */
@Injectable()
export class InboxChannelAdapter implements NotifyChannelAdapter {
  readonly channel = 'INBOX' as const;

  async send(_message: NotifyChannelMessage): Promise<void> {
    // 落表即触达，无外部副作用
  }
}

/** 通道注册表：channel → adapter；缺适配器/重复注册即抛错（不静默吞） */
@Injectable()
export class NotifyChannelRegistry {
  private readonly byChannel = new Map<NotifyChannel, NotifyChannelAdapter>();

  constructor(@Inject(NOTIFY_CHANNEL_ADAPTERS) adapters: NotifyChannelAdapter[]) {
    for (const adapter of adapters) {
      if (this.byChannel.has(adapter.channel)) {
        throw new AppError(ErrorCode.ConfigInvalid, `通知通道适配器重复注册：${adapter.channel}`);
      }
      this.byChannel.set(adapter.channel, adapter);
    }
  }

  get(channel: NotifyChannel): NotifyChannelAdapter {
    const adapter = this.byChannel.get(channel);
    if (!adapter) {
      throw new AppError(ErrorCode.InternalError, `通知通道无适配器：${String(channel)}`);
    }
    return adapter;
  }
}
