import { describe, expect, it } from 'vitest';
import { ConversationHub } from './conversation.hub';

/**
 * D5 广播总线角色定向投递（M2-W3 T4 纯加法=W3-6）：publishTo 只投注册角色命中者——E1 草稿帧
 * 「仅律师端可见」（R-04）的 hub 层用例：律师订阅者收/user 订阅者零收/未登记角色保守不投；
 * publish/publishRaw 全员行为不变（向后兼容）。
 */
describe('ConversationHub.publishTo（W3-6 角色定向投递，纯内存无 DB）', () => {
  it('律师订阅者收、user 订阅者零收、未携 role 订阅者保守不投（R-04 律师端可见性）', () => {
    const hub = new ConversationHub();
    const lawyerFrames: string[] = [];
    const userFrames: string[] = [];
    const legacyFrames: string[] = [];
    hub.subscribe(1, (f) => lawyerFrames.push(f), 'lawyer');
    hub.subscribe(1, (f) => userFrames.push(f), 'user');
    hub.subscribe(1, (f) => legacyFrames.push(f)); // legacy 形态（无 role 登记）

    hub.publishTo(1, ['lawyer'], { type: 'draft', draft_id: 7 });

    expect(lawyerFrames).toHaveLength(1);
    expect(JSON.parse(lawyerFrames[0]!)).toMatchObject({ type: 'draft', draft_id: 7 });
    expect(userFrames).toHaveLength(0); // R-04：user 订阅者零收到草稿帧
    expect(legacyFrames).toHaveLength(0); // 保守面：未登记角色不收角色过滤帧（头注）
  });

  it('publish/publishRaw 全员投递不变（向后兼容）；publishTo 对空 roles 零投递', () => {
    const hub = new ConversationHub();
    const frames: string[] = [];
    hub.subscribe(2, (f) => frames.push(f), 'user');
    hub.publish(2, { type: 'message', conversation_id: 2, message: { seq: 1 } });
    expect(frames).toHaveLength(1);
    hub.publishRaw(2, { type: 'recording_started', conversation_id: 2 });
    expect(frames).toHaveLength(2);
    hub.publishTo(2, [], { type: 'draft' });
    expect(frames).toHaveLength(2);
  });

  it('同订阅者重复订阅幂等（role 覆盖登记）；退订后零投递；订阅者异常不连坐', () => {
    const hub = new ConversationHub();
    const frames: string[] = [];
    const fn = (f: string): void => {
      frames.push(f);
    };
    hub.subscribe(3, fn, 'user');
    hub.subscribe(3, fn, 'lawyer'); // 同引用覆盖：role 以最后一次登记为准
    expect(hub.subscriberCount(3)).toBe(1);

    const throwing = (): void => {
      throw new Error('socket 半开');
    };
    hub.subscribe(3, throwing, 'lawyer');
    hub.publishTo(3, ['lawyer'], { type: 'draft' });
    expect(frames).toHaveLength(1); // 异常订阅者隔离，其余照投

    hub.unsubscribe(3, fn);
    hub.unsubscribe(3, throwing);
    expect(hub.subscriberCount(3)).toBe(0);
    hub.publishTo(3, ['lawyer'], { type: 'draft' });
    expect(frames).toHaveLength(1);
  });
});
