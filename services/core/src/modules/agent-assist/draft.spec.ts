import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { WsAdapter } from '@nestjs/platform-ws';
import type { Pool } from 'pg';
import { AppError, ErrorCode, MESSAGE_SENT_TOPIC } from '@ljr/shared';
import { ensureTestDatabase, truncateAll } from '../../infrastructure/testing/db';
import { OutboxRelayService } from '../../infrastructure/outbox/outbox-relay.service';
import { IDENTITY_CONFIG, type IdentityConfig } from '../identity/identity.config';
import { seedPaidEnrollmentRaw, seedSessionAtRaw } from '../trade/trade-fixture';
import { ConversationHub } from '../fulfillment/conversation.hub';
import { ConversationService } from '../fulfillment/conversation.service';
import { seedRoomRaw } from '../fulfillment/one-on-one-fixture';
import { conversationMessagesRaw, fulfillmentCountsRaw } from '../fulfillment/fulfillment-fixture';
import { WordDictService } from '../ops/word-dict.service';
import { createDraftMessageSentHandler } from './draft.consumer';
import { CapturingLlmAdapter, draftRowsRaw, reviewLogRowsRaw } from './draft-fixture';
import { DraftModule } from './draft.module';
import { DraftService } from './draft.service';
import { LLM_ADAPTER } from './llm.adapter';

/**
 * E1 Agent 草稿气泡管线领域集成（需 PG；M2-W3 T4——§4 管线 + §7 R-01~R-07 + §9 TDD 附加 +
 * §10 验收②~⑥）：真链驱动——用户消息经 ConversationService.sendMessage 落库出箱
 * MessageSent → relay.tick 扇出（本模块消费器+他域消费器并存）→ 管线（脱敏→硬拦→意图→
 * RAG→LLM→drafts 落库→气泡帧 publishTo）。覆盖：
 *   脱敏段复用回归（进入 LLM 载荷=脱敏后文本+placeholders 禁入——R-02 抽检断言）/硬拦
 *   （legal_industry BLOCK 命中→零草稿零事件+律师收 draft_blocked）/三动作（send/edit_send
 *   经 sendMessage 真链：messages 落行 sender_role='lawyer'+风控 PASS；edit 存编辑稿；
 *   discard）/409 EXPIRED/幂等重放（UNIQUE(draft_id,action)）/R-06 去重（同 (room,user)
 *   连续两问=旧 EXPIRED 新 PENDING 恰 1+1；多用户并行各自 PENDING）/降级（LLM 故障注入→
 *   agent_degraded 帧+无草稿+不烧 relay 重试+health 透出+恢复）/延迟预算（segment_ms 四段
 *   打点+latency≈分段和）/律师可见性（气泡帧仅律师订阅者——R-04）/隔离架构级断言
 *   （行为面：管线全程 fulfillment 零新增行、action 后 messages 恰+1；源面：agent-assist
 *   源文件零 fulfillment 写 SQL 形态）/消费过滤（律师·系统·非 room 型零管线）/载荷漂移
 *   （消息不可读=warn 跳过不抛；载荷非法=进重试轨道）。
 *
 * owner 纪律：本 spec 直查面=agent_assist 两新表（owner）+ platform.outbox（白名单）；
 * fulfillment 域断言一律经 fulfillment-fixture（跨域只 import 不内联他域表名）。
 */

const MODULE_DIR = __dirname; // app.config.ts 同款 CJS 形态（tsconfig NodeNext+无 type:module）

function testIdentityConfig(): IdentityConfig {
  return {
    phoneDataKey: randomBytes(32),
    phoneBlindPepper: randomBytes(32).toString('hex'),
    jwtSecret: randomBytes(32).toString('hex'),
  };
}

describe('E1 Agent 草稿气泡管线（脱敏→硬拦→意图→RAG→LLM→气泡→三动作，需 PG）', () => {
  let pool: Pool;
  let app: INestApplication;
  let conversations: ConversationService;
  let drafts: DraftService;
  let dict: WordDictService;
  let hub: ConversationHub;
  let relay: OutboxRelayService;
  let llm: CapturingLlmAdapter;
  /** 本 spec 注册的订阅函数（afterEach 统一退订——truncate RESTART IDENTITY 后会话 id 重放，
   *  不退订则旧订阅者收到新会话同 id 帧（跨用例污染）） */
  const registered: Array<{ conversationId: number; fn: (frame: string) => void }> = [];
  let userSeq = 7100;
  let lawyerSeq = 9800;

  const nextUser = (): number => {
    userSeq += 1;
    return userSeq;
  };
  const nextLawyer = (): number => {
    lawyerSeq += 1;
    return lawyerSeq;
  };

  /** 房间+成员锚（session/room 直插 + 用户 PAID 报名——开房全链归 D1 spec） */
  const seedRoom = async (): Promise<{
    roomId: number;
    sessionId: number;
    lawyerId: number;
    conversationId: number;
  }> => {
    const lawyerId = nextLawyer();
    const sessionId = await seedSessionAtRaw(
      pool,
      lawyerId,
      'OPEN',
      new Date(Date.now() + 3_600_000),
    );
    const roomId = await seedRoomRaw(pool, sessionId);
    const conversation = await conversations.ensureConversation('room', roomId);
    return {
      roomId,
      sessionId,
      lawyerId,
      conversationId: conversation.conversation_id,
    };
  };

  const enroll = (sessionId: number, userId: number): Promise<number> =>
    seedPaidEnrollmentRaw(pool, 'session', sessionId, {
      userId,
      cash: '100.00',
      points: 0,
      unitPrice: '100.00',
    });

  /** 用户发言→relay 投递（MessageSent→E1 管线） */
  const ask = async (conversationId: number, userId: number, content: string): Promise<void> => {
    await conversations.sendMessage({
      conversationId,
      senderId: userId,
      senderRole: 'user',
      content,
    });
    await relay.tick();
  };

  /** 双角色订阅（律师/用户）——返回两侧收到的帧数组（登记入 registered，afterEach 统一退订） */
  const subscribeBoth = (
    conversationId: number,
  ): { lawyer: Record<string, unknown>[]; user: Record<string, unknown>[] } => {
    const lawyer: Record<string, unknown>[] = [];
    const user: Record<string, unknown>[] = [];
    const lawyerFn = (f: string): void => {
      lawyer.push(JSON.parse(f));
    };
    const userFn = (f: string): void => {
      user.push(JSON.parse(f));
    };
    hub.subscribe(conversationId, lawyerFn, 'lawyer');
    hub.subscribe(conversationId, userFn, 'user');
    registered.push({ conversationId, fn: lawyerFn }, { conversationId, fn: userFn });
    return { lawyer, user };
  };

  const outboxPayloads = async (topic: string): Promise<Record<string, unknown>[]> => {
    const res = await pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM platform.outbox WHERE topic = $1 ORDER BY id`,
      [topic],
    );
    return res.rows.map((r) => r.payload);
  };

  const outboxStatuses = async (topic: string): Promise<string[]> => {
    const res = await pool.query<{ status: string }>(
      `SELECT status FROM platform.outbox WHERE topic = $1`,
      [topic],
    );
    return res.rows.map((r) => r.status);
  };

  beforeAll(async () => {
    pool = await ensureTestDatabase();
    llm = new CapturingLlmAdapter();
    const moduleRef = await Test.createTestingModule({ imports: [DraftModule] })
      .overrideProvider(IDENTITY_CONFIG)
      .useValue(testIdentityConfig())
      .overrideProvider(LLM_ADAPTER)
      .useValue(llm)
      .compile();
    app = moduleRef.createNestApplication();
    app.useWebSocketAdapter(new WsAdapter(app));
    await app.init(); // onModuleInit：E1 消费器注册（与 D5/D6 消费器同 topic 扇出并存）
    conversations = app.get(ConversationService);
    drafts = app.get(DraftService);
    dict = app.get(WordDictService);
    hub = app.get(ConversationHub);
    relay = app.get(OutboxRelayService);
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  beforeEach(async () => {
    await truncateAll(pool);
  });
  afterEach(async () => {
    for (const { conversationId, fn } of registered.splice(0)) {
      hub.unsubscribe(conversationId, fn);
    }
    await truncateAll(pool);
  });

  // ===========================================================================
  // 管线主干：脱敏复用 + 气泡可见性 + 延迟打点 + 事件契约 + 隔离行为面（R-02/R-04/§8）
  // ===========================================================================

  it('出稿主干：question_digest=脱敏后（PII 零残留）；气泡帧仅律师订阅者收；segment_ms 四段+latency≈分段和；DraftGenerated 载荷无正文（PII 铁律）；管线全程 fulfillment 零新增行（R-01 行为面）', async () => {
    const room = await seedRoom();
    const userId = nextUser();
    await enroll(room.sessionId, userId);
    const frames = subscribeBoth(room.conversationId);

    const countsBeforeMessage = await fulfillmentCountsRaw(pool);
    await conversations.sendMessage({
      conversationId: room.conversationId,
      senderId: userId,
      senderRole: 'user',
      content: '我叫周梅，手机 138 0013 8000，公司拖欠三个月工资该怎么办？',
    });
    const countsAfterMessage = await fulfillmentCountsRaw(pool);
    await relay.tick(); // MessageSent → E1 管线（脱敏→硬拦→意图→RAG→LLM→落库→气泡）

    // 草稿行：PENDING + 脱敏后摘要 + 占位符映射 + 打点
    const rows = await draftRowsRaw(pool, { roomId: room.roomId });
    expect(rows).toHaveLength(1);
    const draft = rows[0]!;
    expect(draft['status']).toBe('PENDING');
    expect(String(draft['question_digest'])).not.toContain('138 0013 8000'); // 原文 PII 零残留
    expect(String(draft['question_digest'])).not.toContain('13800138000');
    expect(String(draft['question_digest'])).toContain('[电话'); // 占位符形态（R-02）
    expect(String(draft['content'])).toContain('【AI 辅助，仅供参考】'); // R-04 标记
    const placeholders = draft['placeholders'] as Record<string, string>;
    expect(Object.values(placeholders)).toContain('138 0013 8000'); // 律师端还原映射在册
    const seg = draft['segment_ms'] as Record<string, number>;
    for (const key of ['sanitize', 'intent', 'rag', 'llm']) {
      expect(seg[key]).toBeDefined();
      expect(seg[key]).toBeGreaterThanOrEqual(0);
    }
    const sum = seg['sanitize']! + seg['intent']! + seg['rag']! + seg['llm']!;
    expect(draft['latency_ms']).toBeGreaterThanOrEqual(sum); // 分段和 ≤ 总（含段间开销）
    expect(Number(draft['latency_ms']) - sum).toBeLessThan(5_000); // ≈ 总（mock 期毫秒级）
    expect(Number(draft['latency_ms'])).toBeLessThan(8_000); // §8 总预算冒烟

    // R-02 抽检断言：进入 LLM 的载荷=脱敏后文本；placeholders 禁入 adapter
    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0]!.questionDigest).not.toContain('138 0013 8000');
    expect(llm.calls[0]!.questionDigest).toContain('[电话');
    expect(JSON.stringify(llm.calls[0]!.raw)).not.toContain('138 0013 8000'); // 全载荷零 PII
    expect(llm.calls[0]!.intent).toBe('general'); // E3 问题树 version=0 ⇒ general
    expect(llm.calls[0]!.hitCount).toBe(0); // 空知识库容忍

    // 气泡帧：仅律师订阅者（R-04）；user 零收（含 message 广播帧之外的草稿类帧）
    const lawyerDrafts = frames.lawyer.filter((f) => f['type'] === 'draft');
    expect(lawyerDrafts).toHaveLength(1);
    expect(lawyerDrafts[0]).toMatchObject({
      conversation_id: room.conversationId,
      room_id: room.roomId,
      target_user_id: userId,
      question_digest: String(draft['question_digest']),
    });
    expect(
      frames.user.filter(
        (f) => String(f['type']).startsWith('draft') || f['type'] === 'agent_degraded',
      ),
    ).toHaveLength(0);

    // DraftGenerated 载荷契约：六键钉死，无 content/question_digest/placeholders（PII 铁律）
    const events = await outboxPayloads('agent_assist.draft.generated');
    expect(events).toHaveLength(1);
    expect(Object.keys(events[0]!).sort()).toEqual(
      [
        'conversation_id',
        'draft_id',
        'latency_ms',
        'room_id',
        'segment_ms',
        'target_user_id',
      ].sort(),
    );

    // 隔离行为面（R-01）：管线全程 fulfillment 零新增（用户消息行本身除外）
    const countsAfterPipeline = await fulfillmentCountsRaw(pool);
    expect(countsAfterPipeline).toEqual(countsAfterMessage);
    expect(countsAfterMessage.messages).toBe(countsBeforeMessage.messages + 1); // 仅用户消息 1 行

    expect(drafts.health()).toMatchObject({ status: 'ok', degraded_count: 0 });
  });

  it('R-06 去重：同 (room,user) 连续两问→旧 EXPIRED 新 PENDING 恰 1+1；多用户并行各自 PENDING；被顶替草稿 action=409 EXPIRED', async () => {
    const room = await seedRoom();
    const userA = nextUser();
    const userB = nextUser();
    await enroll(room.sessionId, userA);
    await enroll(room.sessionId, userB);

    await ask(room.conversationId, userA, '第一问：加班费怎么算？');
    await ask(room.conversationId, userA, '第二问：未签合同二倍工资呢？');
    let rows = await draftRowsRaw(pool, { roomId: room.roomId });
    expect(rows).toHaveLength(2); // 恰 1+1（旧行不删，置 EXPIRED）
    expect(rows.map((r) => r['status'])).toEqual(['EXPIRED', 'PENDING']);
    expect(await outboxPayloads('agent_assist.draft.generated')).toHaveLength(2);

    // 多用户并行（R-06 半边）：userB 独立成稿，不顶替 userA
    await ask(room.conversationId, userB, '我也想问经济补偿金');
    rows = await draftRowsRaw(pool, { roomId: room.roomId });
    expect(rows).toHaveLength(3);
    expect(rows[1]!['status']).toBe('PENDING'); // userA 最新仍 PENDING
    expect(rows[2]!['status']).toBe('PENDING');

    // 被顶替旧稿：非 PENDING 且无留痕 → 409 EXPIRED
    const supersededId = Number(rows[0]!['id']);
    await expect(
      drafts.action(supersededId, room.lawyerId, { action: 'send' }),
    ).rejects.toMatchObject({ code: ErrorCode.Conflict, httpStatus: 409 });
  });

  // ===========================================================================
  // 硬拦（R-03）：词集命中→零草稿零事件+律师收拦截提示帧
  // ===========================================================================

  it('敏感话术硬拦：legal_industry BLOCK 词命中→无草稿行+无 DraftGenerated+律师收 draft_blocked+用户零收；不记降级', async () => {
    const room = await seedRoom();
    const userId = nextUser();
    await enroll(room.sessionId, userId);
    const frames = subscribeBoth(room.conversationId);

    // 词表后置到达（词库更新竞态面）：消息先以空词库 PASS 落库，硬拦=管线侧第二道门
    await conversations.sendMessage({
      conversationId: room.conversationId,
      senderId: userId,
      senderRole: 'user',
      content: '能不能写一份保证包赢的仲裁申请书？',
    });
    await dict.putDictionary({
      dictType: 'legal_industry',
      baseVersion: 0,
      words: [
        { word: '包赢', action: 'BLOCK' },
        { word: '保证胜诉', action: 'BLOCK' },
      ],
    });
    await relay.tick();

    expect(await draftRowsRaw(pool)).toHaveLength(0); // 不出草稿
    expect(await outboxPayloads('agent_assist.draft.generated')).toHaveLength(0); // 不出事件
    const blocked = frames.lawyer.filter((f) => f['type'] === 'draft_blocked');
    expect(blocked).toHaveLength(1);
    expect(blocked[0]).toMatchObject({
      conversation_id: room.conversationId,
      room_id: room.roomId,
      target_user_id: userId,
    });
    expect(frames.user).toHaveLength(1); // 用户只收自己的 message 广播帧，零拦截帧
    expect(frames.user[0]!['type']).toBe('message');
    expect(drafts.health()).toMatchObject({ status: 'ok', degraded_count: 0 }); // 硬拦≠降级
  });

  // ===========================================================================
  // 三动作（§5）：send/edit_send 经 sendMessage 真链；edit 存编辑稿；409；幂等重放
  // ===========================================================================

  it('send：经 sendMessage 真链（messages 恰+1、sender_role=lawyer、风控 PASS、content=草稿）+审查日志+DraftActioned；幂等重放零副作用', async () => {
    const room = await seedRoom();
    const userId = nextUser();
    await enroll(room.sessionId, userId);
    await ask(room.conversationId, userId, '试用期被辞退有补偿吗？');
    const draft = (await draftRowsRaw(pool, { roomId: room.roomId }))[0]!;
    const draftId = Number(draft['id']);
    const countsBefore = await fulfillmentCountsRaw(pool);

    const result = await drafts.action(draftId, room.lawyerId, { action: 'send' });
    expect(result).toMatchObject({ draft_id: draftId, status: 'SENT', deduplicated: false });

    // R-01：发送唯一路径=律师链路——messages 恰 +1，sender_role='lawyer'，risk_flag=PASS
    const countsAfter = await fulfillmentCountsRaw(pool);
    expect(countsAfter.messages).toBe(countsBefore.messages + 1);
    expect(countsAfter.conversations).toBe(countsBefore.conversations);
    const messages = await conversationMessagesRaw(pool, room.conversationId);
    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({
      sender_role: 'lawyer',
      risk_flag: 'PASS',
      content: String(draft['content']),
    });

    // 审查日志：UNIQUE(draft_id,action) 一行 + review_ms + sent_at
    const logs = await reviewLogRowsRaw(pool, { draftId });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      action: 'send',
      edited_content: null,
      sent_at: expect.any(Date) as Date,
    });
    expect(Number(logs[0]!['draft_id'])).toBe(draftId); // bigint 列字符串形态
    expect(Number(logs[0]!['lawyer_id'])).toBe(room.lawyerId);
    expect(Number(logs[0]!['review_ms'])).toBeGreaterThanOrEqual(0);

    // DraftActioned 出箱（载荷四键——A.1 冻结形状）
    const actioned = await outboxPayloads('agent_assist.draft.actioned');
    expect(actioned).toHaveLength(1);
    expect(Object.keys(actioned[0]!).sort()).toEqual(
      ['action', 'draft_id', 'review_ms', 'room_id'].sort(),
    );

    // 幂等重放：同动作再调=deduplicated 返回，零新消息/零新日志/零新事件
    const replay = await drafts.action(draftId, room.lawyerId, { action: 'send' });
    expect(replay).toMatchObject({ draft_id: draftId, status: 'SENT', deduplicated: true });
    expect((await fulfillmentCountsRaw(pool)).messages).toBe(countsBefore.messages + 1);
    expect(await reviewLogRowsRaw(pool, { draftId })).toHaveLength(1);
    expect(await outboxPayloads('agent_assist.draft.actioned')).toHaveLength(1);
  });

  it('edit_send：编辑稿经 sendMessage 发出+存审查日志；discard：零消息落行+sent_at NULL', async () => {
    const room = await seedRoom();
    const userId = nextUser();
    await enroll(room.sessionId, userId);

    // edit_send
    await ask(room.conversationId, userId, '单位不缴社保怎么办？');
    const draftA = (await draftRowsRaw(pool, { roomId: room.roomId }))[0]!;
    const idA = Number(draftA['id']);
    const edited = '【律师答复】单位未缴社保可要求补缴并可据此解除合同主张经济补偿（编辑稿）。';
    const resultA = await drafts.action(idA, room.lawyerId, {
      action: 'edit_send',
      editedContent: edited,
    });
    expect(resultA).toMatchObject({ status: 'EDITED_SENT', deduplicated: false });
    const messages = await conversationMessagesRaw(pool, room.conversationId);
    expect(messages[1]).toMatchObject({ sender_role: 'lawyer', content: edited }); // 编辑稿发出
    const logA = (await reviewLogRowsRaw(pool, { draftId: idA }))[0]!;
    expect(logA).toMatchObject({ action: 'edit_send', edited_content: edited }); // R-05 审查留痕

    // discard：状态终态化但零消息
    await ask(room.conversationId, userId, '还有年假没休呢？');
    const draftB = (await draftRowsRaw(pool, { roomId: room.roomId })).at(-1)!;
    const idB = Number(draftB['id']);
    const before = (await fulfillmentCountsRaw(pool)).messages;
    const resultB = await drafts.action(idB, room.lawyerId, { action: 'discard' });
    expect(resultB).toMatchObject({ status: 'DISCARDED', deduplicated: false });
    expect((await fulfillmentCountsRaw(pool)).messages).toBe(before); // 零消息落行
    const logB = (await reviewLogRowsRaw(pool, { draftId: idB }))[0]!;
    expect(logB).toMatchObject({ action: 'discard', edited_content: null, sent_at: null });
  });

  // ===========================================================================
  // 降级（W3-7）：LLM 故障注入→降级帧+无草稿+不烧 relay 重试+health 透出+恢复
  // ===========================================================================

  it('降级：LLM 故障→agent_degraded 帧仅律师收+无草稿无事件+relay SENT 不烧重试；health degraded 透出；下一条消息恢复出稿+health 回 ok', async () => {
    const room = await seedRoom();
    const userId = nextUser();
    await enroll(room.sessionId, userId);
    const frames = subscribeBoth(room.conversationId);

    llm.fail = true; // 故障注入（W3-7）
    await ask(room.conversationId, userId, '工伤认定流程是什么？');

    expect(await draftRowsRaw(pool)).toHaveLength(0); // 无草稿
    expect(await outboxPayloads('agent_assist.draft.generated')).toHaveLength(0);
    const degraded = frames.lawyer.filter((f) => f['type'] === 'agent_degraded');
    expect(degraded).toHaveLength(1);
    expect(degraded[0]).toMatchObject({
      conversation_id: room.conversationId,
      room_id: room.roomId,
    });
    expect(frames.user.filter((f) => f['type'] === 'agent_degraded')).toHaveLength(0); // 仅律师端
    expect(await outboxStatuses(MESSAGE_SENT_TOPIC)).toEqual(['SENT']); // 不烧 relay 重试（W3-7）
    const health = drafts.health();
    expect(health.status).toBe('degraded');
    expect(health.degraded_count).toBeGreaterThanOrEqual(1);
    expect(health.last_error).toContain('故障注入');

    llm.fail = false; // 恢复：下一条用户消息自然重跑
    await ask(room.conversationId, userId, '那赔偿标准呢？');
    const rows = await draftRowsRaw(pool, { roomId: room.roomId });
    expect(rows).toHaveLength(1);
    expect(rows[0]!['status']).toBe('PENDING');
    expect(frames.lawyer.filter((f) => f['type'] === 'draft')).toHaveLength(1);
    const recovered = drafts.health();
    expect(recovered.status).toBe('ok'); // 恢复清 last_error
    expect(recovered.degraded_count).toBeGreaterThanOrEqual(1); // 计数单调累计
  });

  // ===========================================================================
  // 消费过滤与载荷漂移（W3-5/W3-7）：律师/系统/非 room 型零管线；漂移跳过不抛
  // ===========================================================================

  it('消费过滤（W3-5）：律师消息/系统消息/private 会话用户消息零草稿；载荷漂移=跳过不抛、载荷非法=进重试轨道', async () => {
    const room = await seedRoom();
    const userId = nextUser();
    await enroll(room.sessionId, userId);

    await conversations.sendMessage({
      conversationId: room.conversationId,
      senderId: room.lawyerId,
      senderRole: 'lawyer',
      content: '律师先答一句',
    });
    await relay.tick();
    await conversations.postInternalMessage({
      conversationId: room.conversationId,
      senderRole: 'system',
      content: '系统须知',
    });
    await relay.tick();
    const privateConv = await conversations.ensureConversation('private', 424_242);
    await conversations.sendMessage({
      conversationId: privateConv.conversation_id,
      senderId: userId,
      senderRole: 'user',
      content: '私聊消息不出稿',
    });
    await relay.tick();
    expect(await draftRowsRaw(pool)).toHaveLength(0);

    // 载荷漂移：消息不可读（已冷存/不存在）=warn 跳过不抛（W3-7）
    const handler = createDraftMessageSentHandler(drafts, conversations);
    await expect(
      handler(
        {
          id: 1,
          eventId: 'e-drift',
          topic: MESSAGE_SENT_TOPIC,
          payload: { conversation_id: room.conversationId, seq: 9_999 },
          retryCount: 0,
        },
        {} as never,
      ),
    ).resolves.toBeUndefined();
    // 载荷非法：缺最小集=AppError（进重试轨道，不静默丢弃）
    await expect(
      handler(
        { id: 2, eventId: 'e-bad', topic: MESSAGE_SENT_TOPIC, payload: {}, retryCount: 0 },
        {} as never,
      ),
    ).rejects.toBeInstanceOf(AppError);
  });

  // ===========================================================================
  // 评审修复环（T4 修复波）：I-1 R-04 标记强制 / I-2 listDrafts 越权门 / I-3 action 并发串行化
  // ＋ E1 PIA 评审（M2-W4 T3）I-3：action 三动作成员门（discard 此前全程无门）
  // ===========================================================================

  it('I-1 R-04 标记强制：适配器输出缺「AI 辅助，仅供参考」标记→降级不出稿（零草稿零事件+agent_degraded 帧仅律师+health 透出）；恢复后照常出稿', async () => {
    const room = await seedRoom();
    const userId = nextUser();
    await enroll(room.sessionId, userId);
    const frames = subscribeBoth(room.conversationId);

    llm.noMarker = true; // 违约注入：输出无 R-04 标记（真供应商换装输出形态不可控的模拟面）
    await ask(room.conversationId, userId, '违约适配器输出测试：经济补偿金月工资基数怎么算？');

    expect(await draftRowsRaw(pool)).toHaveLength(0); // 无标记草稿零落库
    expect(await outboxPayloads('agent_assist.draft.generated')).toHaveLength(0); // 零事件
    const degraded = frames.lawyer.filter((f) => f['type'] === 'agent_degraded');
    expect(degraded).toHaveLength(1); // 降级帧推律师端（标记缺失=管线段失败语义）
    expect(frames.user.filter((f) => f['type'] === 'agent_degraded')).toHaveLength(0);
    const health = drafts.health();
    expect(health.status).toBe('degraded');
    expect(health.last_error).toContain('标记'); // R-04 违约摘要透出（不含原文）

    llm.noMarker = false; // 恢复：带标记输出照常出稿
    await ask(room.conversationId, userId, '那代通知金呢？');
    const rows = await draftRowsRaw(pool, { roomId: room.roomId });
    expect(rows).toHaveLength(1);
    expect(String(rows[0]!['content'])).toContain('【AI 辅助，仅供参考】');
    expect(drafts.health().status).toBe('ok');
  });

  it('I-2 listDrafts 越权门：非该房参与方律师拉他人房间草稿→403 RoleForbidden（fail-closed）；房内场次律师正常拉（placeholders 含 PII 原文映射仅成员可见）', async () => {
    const room = await seedRoom();
    const userId = nextUser();
    await enroll(room.sessionId, userId);
    await ask(room.conversationId, userId, '我是周梅，手机 138 0013 8000，被调岗降薪怎么办？');
    expect(await draftRowsRaw(pool, { roomId: room.roomId })).toHaveLength(1);

    // 场次律师（房内）：正常拉，placeholders 的 PII 原文映射可见（律师端还原显示面）
    const own = await drafts.listDrafts(room.lawyerId, { roomId: room.roomId });
    expect(own).toHaveLength(1);
    expect(own[0]!.status).toBe('PENDING');
    expect(Object.values(own[0]!.placeholders)).toContain('138 0013 8000');

    // 外部律师（非场次律师且无 PAID 报名）：403 RoleForbidden（fail-closed——成员门经
    // fulfillment 导出面 assertAccess，任何非成员即拒）
    const outsider = nextLawyer();
    await expect(drafts.listDrafts(outsider, { roomId: room.roomId })).rejects.toMatchObject({
      code: ErrorCode.RoleForbidden,
      httpStatus: 403,
    });
  });

  it('I-3 action 并发串行化（行锁先于一切判定）：同动作双发→messages 恰+1+一者 deduplicated；异动作并发→恰一成一举 409 EXPIRED（终态唯一）', async () => {
    const room = await seedRoom();
    const userId = nextUser();
    await enroll(room.sessionId, userId);

    // —— 同动作双发：两请求并发 send，行锁串行化——先到者发消息+留痕，后到者幂等短路 ——
    await ask(room.conversationId, userId, '未提前三十日通知解除怎么算？');
    const draftA = (await draftRowsRaw(pool, { roomId: room.roomId }))[0]!;
    const idA = Number(draftA['id']);
    const before = (await fulfillmentCountsRaw(pool)).messages;
    const twin = await Promise.allSettled([
      drafts.action(idA, room.lawyerId, { action: 'send' }),
      drafts.action(idA, room.lawyerId, { action: 'send' }),
    ]);
    expect(twin.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    const outcomes = twin.map(
      (r) => (r as PromiseFulfilledResult<{ deduplicated: boolean }>).value,
    );
    expect(outcomes.map((o) => o.deduplicated).sort()).toEqual([false, true]); // 恰一真发+一幂等
    expect((await fulfillmentCountsRaw(pool)).messages).toBe(before + 1); // messages 恰 +1
    expect(await reviewLogRowsRaw(pool, { draftId: idA })).toHaveLength(1); // 留痕恰一行
    expect(await outboxPayloads('agent_assist.draft.actioned')).toHaveLength(1); // 事件恰一份

    // —— 异动作并发（send vs discard）：行锁串行化——恰一成一一 409，终态唯一 ——
    await ask(room.conversationId, userId, '再问一个：仲裁时效是多久？');
    const draftB = (await draftRowsRaw(pool, { roomId: room.roomId })).at(-1)!;
    const idB = Number(draftB['id']);
    const beforeB = (await fulfillmentCountsRaw(pool)).messages;
    const clash = await Promise.allSettled([
      drafts.action(idB, room.lawyerId, { action: 'send' }),
      drafts.action(idB, room.lawyerId, { action: 'discard' }),
    ]);
    const fulfilled = clash.filter((r) => r.status === 'fulfilled');
    const rejected = clash.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1); // 恰一成举
    expect(rejected).toHaveLength(1); // 恰一 409 EXPIRED（后到者见终态）
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      code: ErrorCode.Conflict,
      httpStatus: 409,
    });
    const winner = (fulfilled[0] as PromiseFulfilledResult<{ status: string }>).value.status;
    // send 胜=恰 1 消息；discard 胜=0 消息（双路均合法——锁序决定，断言按胜者收口）
    expect((await fulfillmentCountsRaw(pool)).messages).toBe(beforeB + (winner === 'SENT' ? 1 : 0));
    const finalB = (await draftRowsRaw(pool, { roomId: room.roomId })).at(-1)!;
    expect(finalB['status']).toBe(winner === 'SENT' ? 'SENT' : 'DISCARDED'); // 终态唯一
    expect(await reviewLogRowsRaw(pool, { draftId: idB })).toHaveLength(1); // 留痕恰一行（胜者）
  });

  it('PIA 评审 I-3 action 三动作成员门：非会话成员律师 send/edit_send/discard 统一 403 RoleForbidden（fail-closed，listDrafts 同款）——零状态变化/零审计行/零消息/零事件；门先于幂等与状态判定（外部者不可探测草稿态）；房内律师照常可动作', async () => {
    const room = await seedRoom();
    const userId = nextUser();
    await enroll(room.sessionId, userId);
    const outsider = nextLawyer(); // 持律师 JWT 但非场次律师且无 PAID 报名（跨房外部者）

    // 三动作逐一注入：每轮 ask 出一新 PENDING 稿（R-06 同 (room,user) 顶替前稿）作攻击锚
    for (const input of [
      { action: 'discard' },
      { action: 'send' },
      { action: 'edit_send', editedContent: '越权编辑稿（PIA I-3 注入）' },
    ] as const) {
      await ask(room.conversationId, userId, `越权动作注入 ${input.action}：经济补偿怎么算？`);
      const draft = (await draftRowsRaw(pool, { roomId: room.roomId })).at(-1)!;
      const draftId = Number(draft['id']);
      const messagesBefore = (await fulfillmentCountsRaw(pool)).messages;
      await expect(drafts.action(draftId, outsider, input)).rejects.toMatchObject({
        code: ErrorCode.RoleForbidden,
        httpStatus: 403,
      });
      // 零状态变化（草稿仍 PENDING，discard 不可销毁他人草稿）+零审计行（agent_review_logs
      // 无 outsider lawyer_id——归属污染消除）+零消息落行+零事件
      const after = (await draftRowsRaw(pool, { roomId: room.roomId })).at(-1)!;
      expect(after['id']).toBe(draft['id']); // 锚同一行
      expect(after['status']).toBe('PENDING');
      expect(await reviewLogRowsRaw(pool, { draftId })).toHaveLength(0);
      expect((await fulfillmentCountsRaw(pool)).messages).toBe(messagesBefore);
      expect(await outboxPayloads('agent_assist.draft.actioned')).toHaveLength(0);
    }

    // 门先于状态判定：被 R-06 顶替的 EXPIRED 稿——外部者 action=403 而非 409（草稿态不可探测）
    const superseded = (await draftRowsRaw(pool, { roomId: room.roomId }))[0]!;
    expect(superseded['status']).toBe('EXPIRED');
    await expect(
      drafts.action(Number(superseded['id']), outsider, { action: 'discard' }),
    ).rejects.toMatchObject({ code: ErrorCode.RoleForbidden, httpStatus: 403 });

    // 成员回归：房内场次律师对最新 PENDING 照常 discard 成（门不误伤成员）
    const latest = (await draftRowsRaw(pool, { roomId: room.roomId })).at(-1)!;
    const latestId = Number(latest['id']);
    await expect(
      drafts.action(latestId, room.lawyerId, { action: 'discard' }),
    ).resolves.toMatchObject({ draft_id: latestId, status: 'DISCARDED', deduplicated: false });
  });

  // ===========================================================================
  // 隔离源面静态断言（§9：agent-assist 零 fulfillment 写面——SQL 形态扫描）
  // ===========================================================================

  it('隔离源面（§9/R-01）：agent-assist 目录源文件零「写 fulfillment 表」SQL 形态（INSERT/UPDATE/DELETE）', () => {
    const files = readdirSync(MODULE_DIR)
      .filter((f) => f.endsWith('.ts'))
      .map((f) => join(MODULE_DIR, f))
      .filter((f) => f !== join(__dirname, 'draft.spec.ts'));
    expect(files.length).toBeGreaterThan(10); // 扫描面存在性（目录文件数下界）
    // 形态分段构造规避自匹配（'INS'+'ERT INTO' 不构成字面命中）
    const patterns = (['INS' + 'ERT INTO', 'UPD' + 'ATE', 'DEL' + 'ETE FROM'] as const).map(
      (kw) => new RegExp(`${kw.replace(' ', '\\s+')}\\s+fulfillment`, 'i'),
    );
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const pattern of patterns) {
        expect(pattern.test(text), `${file} 命中 ${String(pattern)}`).toBe(false);
      }
    }
  });
});
