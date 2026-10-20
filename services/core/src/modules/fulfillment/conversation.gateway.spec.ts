import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Pool } from 'pg';
import { WsAdapter } from '@nestjs/platform-ws';
import { PRESENCE_JOINED_TOPIC, PRESENCE_LEFT_TOPIC, MESSAGE_SENT_TOPIC } from '@ljr/shared';
import { ensureTestDatabase, truncateAll } from '../../infrastructure/testing/db';
import {
  ARTIFACT_STORE,
  LocalFsArtifactStore,
} from '../../infrastructure/artifacts/artifact-store';
import { IDENTITY_CONFIG, type IdentityConfig } from '../identity/identity.config';
import { IdentityTokenService } from '../identity/identity.token.service';
import { RULE_CURRENT_CACHE, InProcessRuleCurrentCache } from '../ops/rule-center.cache';
import { WordDictAutomatonCache } from '../ops/word-dict.cache';
import { WordDictService } from '../ops/word-dict.service';
import { seedPaidEnrollmentRaw, seedSessionAtRaw } from '../trade/trade-fixture';
import { FulfillmentModule } from './fulfillment.module';
import { ConversationService } from './conversation.service';
import { WSS_AUTH_TIMEOUT_MS } from './conversation.gateway';
import { MockRtcProvider } from './rtc-provider';
import { seedOooOrderRaw } from './one-on-one-fixture';

/**
 * D5 WSS 网关集成（需 PG；真实 ws 客户端连 ws://127.0.0.1:<临时端口>/ws——简报指定形态）：
 *   鉴权（⚠W1-6 首帧 auth/未 auth 拒/坏 token 关/10s 超时关——超时经 WSS_AUTH_TIMEOUT_MS override
 *   缩短）、发送链顺序（BLOCKED 拒：403 回执+其他成员零收到+零落库）、seq 广播一致、
 *   客户端幂等（msg_client_id 持久回执去重——V50 message_receipts，M2-W3 T5 换装）、迟到 join 回填 200、presence 出箱（join/leave/断连）、
 *   room 型 join 门（OPEN 放行/终态拒 + C-1 成员门：非成员拒/场次律师放行）、
 *   C-1 发送门（PAID 成员可 send/非成员 403）、I-1 帧与长度上限（>64KB 连接被拒/超 8000 字符 400）、
 *   I-3 join 顺序（presence 失败→error 帧+零订阅残留）、伪造 sender_role 拒（agent/system/越权
 *   lawyer）、recording-consent（room 型 403/one_on_one 单方回执零启动）。
 */

const USER_A = 7101;
const LAWYER_B = 7203;
/** 成员门外人（无 PAID 报名非律师） */
const USER_B_GUEST = 7299;
/** 成员房间用例的场次属主律师（JWT 不查库——trade 侧律师 id 直用） */
const ROOM_LAWYER = 9101;

const testIdentityConfig = (): IdentityConfig => ({
  phoneDataKey: randomBytes(32),
  phoneBlindPepper: randomBytes(32).toString('hex'),
  jwtSecret: randomBytes(32).toString('hex'),
});

interface WssFrame {
  readonly type: string;
  readonly message?: unknown;
  readonly backfill?: unknown;
  readonly messages?: unknown;
  readonly seq?: unknown;
  readonly [key: string]: unknown;
}

/** 测试 ws 客户端：帧队列+next() 等待面+静默断言面（expectSilence） */
class TestClient {
  private readonly queue: WssFrame[] = [];
  private readonly waiters: ((f: WssFrame) => void)[] = [];
  readonly closed: Promise<number | undefined>;
  private closeCode: number | undefined;
  private closedResolve!: (code: number | undefined) => void;

  private constructor(readonly ws: WebSocket) {
    this.closed = new Promise((resolve) => {
      this.closedResolve = resolve;
    });
    ws.on('message', (data) => {
      const frame = JSON.parse(data.toString()) as WssFrame;
      const waiter = this.waiters.shift();
      if (waiter) waiter(frame);
      else this.queue.push(frame);
    });
    ws.on('close', (code) => {
      this.closeCode = code;
      this.closedResolve(code);
    });
  }

  static connect(url: string): Promise<TestClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.once('open', () => resolve(new TestClient(ws)));
      ws.once('error', reject);
    });
  }

  send(frame: Record<string, unknown>): void {
    this.ws.send(JSON.stringify(frame));
  }

  /** 原始字节发送（I-1 超大帧用例——绕过 JSON 封装直打 ws 层 maxPayload） */
  sendRaw(data: Buffer): void {
    this.ws.send(data);
  }

  async next(timeoutMs = 3_000): Promise<WssFrame> {
    const queued = this.queue.shift();
    if (queued) return queued;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('等帧超时')), timeoutMs);
      this.waiters.push((f) => {
        clearTimeout(timer);
        resolve(f);
      });
    });
  }

  /**
   * 收齐目标类型帧（顺序不敏感——服务端广播（sendMessage 内 hub.publish）与网关 ack
   * （send 返回后）的到达序不保证，断言只认类型集不认先后）。
   */
  async collect(want: readonly string[], timeoutMs = 3_000): Promise<Record<string, WssFrame>> {
    const found: Record<string, WssFrame> = {};
    const deadline = Date.now() + timeoutMs;
    while (want.some((t) => !(t in found))) {
      const remaining = want.filter((t) => !(t in found));
      const hit = this.queue.findIndex((f) => remaining.includes(f.type));
      if (hit >= 0) {
        found[this.queue[hit]!.type] = this.queue.splice(hit, 1)[0]!;
        continue;
      }
      if (Date.now() > deadline) throw new Error(`等帧超时：${remaining.join(',')}`);
      const frame = await this.next(Math.max(1, deadline - Date.now()));
      if (remaining.includes(frame.type)) found[frame.type] = frame;
      else this.queue.push(frame); // 非目标帧放回（silence 断言仍可消费）
    }
    return found;
  }

  /** 静默断言：窗口内无新帧（广播前拦截——其他成员零收到的确定性证据） */
  async expectSilence(ms = 250): Promise<void> {
    await new Promise((r) => setTimeout(r, ms));
    expect(this.queue).toHaveLength(0);
    expect(this.waiters).toHaveLength(0);
  }

  get closeEvent(): number | undefined {
    return this.closeCode;
  }

  terminate(): void {
    this.ws.terminate();
  }
}

describe('D5 WSS 网关（首帧 auth/send 链/join 回填/presence/幂等/consent 信令，需 PG）', () => {
  let pool: Pool;
  let app: INestApplication;
  let conversations: ConversationService;
  let words: WordDictService;
  let tokens: IdentityTokenService;
  let rtc: MockRtcProvider;
  let dictCache: WordDictAutomatonCache;
  let ruleCache: InProcessRuleCurrentCache;
  let url: string;

  const outboxPayloads = async (topic: string): Promise<Record<string, unknown>[]> => {
    const res = await pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM platform.outbox WHERE topic = $1 ORDER BY id`,
      [topic],
    );
    return res.rows.map((r) => r.payload);
  };

  const messageCount = async (conversationId: number): Promise<number> => {
    const res = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM fulfillment.messages WHERE conversation_id = $1`,
      [conversationId],
    );
    return res.rows[0]!.n;
  };

  const seedRoomRow = async (status: string, sessionRef: number): Promise<number> => {
    const res = await pool.query<{ id: string }>(
      `INSERT INTO fulfillment.rooms
         (session_id, mode, scheduled_start, opened_at, grace_end, status)
       VALUES ($1, 'text', now() - interval '1 hour', now(), now() + interval '5 minutes', $2)
       RETURNING id`,
      [sessionRef, status],
    );
    return Number(res.rows[0]!.id);
  };

  /**
   * 真链成员房间（C-1 成员门锚）：场次（属主律师 ROOM_LAWYER）+ member PAID 报名 + room 行 +
   * room 会话——成员资格经 trade 导出面（PAID 报名/场次律师）。
   */
  const seedMemberRoom = async (status = 'OPEN', member = USER_A): Promise<number> => {
    const sessionId = await seedSessionAtRaw(
      pool,
      ROOM_LAWYER,
      'CONFIRMED',
      new Date(Date.now() - 3_600_000),
      'text',
    );
    await seedPaidEnrollmentRaw(pool, 'session', sessionId, {
      userId: member,
      cash: '60.00',
      points: 0,
      unitPrice: '60.00',
    });
    const roomId = await seedRoomRow(status, sessionId);
    const conv = await conversations.ensureConversation('room', roomId);
    return conv.conversation_id;
  };

  /** 轮询等待 outbox 行数（presence 写与 joined 帧异步竞态——帧先行、出箱随后） */
  const waitForOutbox = async (
    topic: string,
    least: number,
  ): Promise<Record<string, unknown>[]> => {
    for (let i = 0; i < 30; i += 1) {
      const rows = await outboxPayloads(topic);
      if (rows.length >= least) return rows;
      await new Promise((r) => setTimeout(r, 50));
    }
    return outboxPayloads(topic);
  };

  const authed = async (userId: number, role: 'user' | 'lawyer'): Promise<TestClient> => {
    const client = await TestClient.connect(url);
    const token = await tokens.signAccessToken({ userId, role, roles: [role] });
    client.send({ type: 'auth', token });
    const frame = await client.next();
    expect(frame).toMatchObject({ type: 'auth_ok', user_id: userId, role });
    return client;
  };

  const join = async (client: TestClient, conversationId: number): Promise<WssFrame> => {
    client.send({ type: 'join', conversation_id: conversationId });
    return client.next();
  };

  beforeAll(async () => {
    pool = await ensureTestDatabase();
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'ljr-d5-gw-'));
    const moduleRef = await Test.createTestingModule({ imports: [FulfillmentModule] })
      .overrideProvider(IDENTITY_CONFIG)
      .useValue(testIdentityConfig())
      .overrideProvider(ARTIFACT_STORE)
      .useValue(new LocalFsArtifactStore(tmpDir))
      .overrideProvider(WSS_AUTH_TIMEOUT_MS)
      .useValue(400) // 鉴权超时缩短（默认 10s 不等——覆盖同一分支）
      .compile();
    app = moduleRef.createNestApplication();
    app.useWebSocketAdapter(new WsAdapter(app));
    await app.init();
    await app.listen(0); // 临时端口承载 ws upgrade（/ws 路径）
    const port = (app.getHttpServer().address() as AddressInfo).port;
    url = `ws://127.0.0.1:${port}/ws`;
    conversations = app.get(ConversationService);
    words = app.get(WordDictService);
    tokens = app.get(IdentityTokenService);
    rtc = app.get(MockRtcProvider);
    dictCache = app.get(WordDictAutomatonCache);
    ruleCache = app.get<InProcessRuleCurrentCache>(RULE_CURRENT_CACHE);
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });
  beforeEach(async () => {
    await truncateAll(pool);
    dictCache.clear();
    ruleCache.clear();
  });
  afterEach(async () => {
    await truncateAll(pool);
    dictCache.clear();
    ruleCache.clear();
  });

  // --------------------------------------------------------------------------
  // 鉴权（⚠W1-6：连接后首帧 auth；禁 query 串携带 token）
  // --------------------------------------------------------------------------

  it('首帧 auth：合法 token → auth_ok；坏 token → auth_failed+close；未 auth 先 send → 拒+close', async () => {
    const client = await TestClient.connect(url);
    const token = await tokens.signAccessToken({ userId: USER_A, role: 'user', roles: ['user'] });
    client.send({ type: 'auth', token });
    await expect(client.next()).resolves.toMatchObject({
      type: 'auth_ok',
      user_id: USER_A,
      role: 'user',
    });
    client.terminate();

    const bad = await TestClient.connect(url);
    bad.send({ type: 'auth', token: 'not-a-jwt' });
    await expect(bad.next()).resolves.toMatchObject({ type: 'auth_failed' });
    await bad.closed;

    const impatient = await TestClient.connect(url);
    impatient.send({ type: 'send', conversation_id: 1, message: { content: '先发后鉴' } });
    const rejected = await impatient.next();
    expect(rejected).toMatchObject({ type: 'error', code: 'E_UNAUTHORIZED' });
    await impatient.closed;
  });

  it('auth 超时（10s 默认，override 400ms 验分支）：无任何帧 → 服务端主动 close', async () => {
    const silent = await TestClient.connect(url);
    const code = await silent.closed;
    expect(code).toBe(4401);
  });

  it('伪造 sender_role：user 发 agent/system/lawyer 均拒（403 E_ROLE_FORBIDDEN）；零落库零广播', async () => {
    const conv = await conversations.ensureConversation('private', 601);
    const member = await authed(LAWYER_B, 'lawyer');
    await join(member, conv.conversation_id);
    const attacker = await authed(USER_A, 'user');

    for (const forged of ['agent', 'system', 'lawyer']) {
      attacker.send({
        type: 'send',
        conversation_id: conv.conversation_id,
        message: { content: `伪造 ${forged}`, sender_role: forged },
      });
      const frame = await attacker.next();
      expect(frame).toMatchObject({ type: 'error', code: 'E_ROLE_FORBIDDEN', reply_to: 'send' });
    }
    expect(await messageCount(conv.conversation_id)).toBe(0);
    await member.expectSilence(); // 其他成员零收到（广播前拒绝）
    expect(await outboxPayloads(MESSAGE_SENT_TOPIC)).toHaveLength(0);
  });

  // --------------------------------------------------------------------------
  // 发送链（§4：checkRisk→BLOCKED 拒→单事务持久化→进程内广播）
  // --------------------------------------------------------------------------

  it('send+广播：成员双收同 seq；ack 携 seq；DB 落行 sender_role=user', async () => {
    const conv = await conversations.ensureConversation('private', 602);
    const user = await authed(USER_A, 'user');
    const lawyer = await authed(LAWYER_B, 'lawyer');
    await join(user, conv.conversation_id);
    await join(lawyer, conv.conversation_id);

    user.send({
      type: 'send',
      conversation_id: conv.conversation_id,
      message: { content: '您好' },
    });
    // 到达序不保证（服务端广播先于网关 ack 发出）——按类型集收齐
    const mine = await user.collect(['sent', 'message']);
    expect(mine.sent).toMatchObject({
      type: 'sent',
      conversation_id: conv.conversation_id,
      seq: 1,
    });
    expect(mine.message).toMatchObject({ type: 'message', conversation_id: conv.conversation_id });
    const toLawyer = await lawyer.next();
    expect(toLawyer).toMatchObject({ type: 'message', conversation_id: conv.conversation_id });
    expect((mine.message as { message: { seq: number } }).message.seq).toBe(1);
    expect((toLawyer as { message: { seq: number } }).message.seq).toBe(1);
    expect(await messageCount(conv.conversation_id)).toBe(1);
    expect(await outboxPayloads(MESSAGE_SENT_TOPIC)).toHaveLength(1);
  });

  it('BLOCKED 拦截顺序（R-01/§4）：403 BLOCKED_BY_RISK 回执；发送者/其他成员零 message 帧；零落库零事件', async () => {
    await words.putDictionary({
      dictType: 'illegal_content',
      baseVersion: 0,
      words: [{ word: 'blockword', action: 'BLOCK' }],
    });
    const conv = await conversations.ensureConversation('private', 603);
    const user = await authed(USER_A, 'user');
    const lawyer = await authed(LAWYER_B, 'lawyer');
    await join(user, conv.conversation_id);
    await join(lawyer, conv.conversation_id);

    user.send({
      type: 'send',
      conversation_id: conv.conversation_id,
      message: { content: '带 blockword 的消息' },
    });
    const rejection = await user.next();
    expect(rejection).toMatchObject({
      type: 'error',
      code: 'E_BLOCKED_BY_RISK',
      reply_to: 'send',
    });
    await user.expectSilence(); // 发送者无广播回声
    await lawyer.expectSilence(); // 其他成员零收到（广播前拦截）
    expect(await messageCount(conv.conversation_id)).toBe(0);
    expect(await outboxPayloads(MESSAGE_SENT_TOPIC)).toHaveLength(0);
  });

  it('客户端幂等（§5 msg_client_id）：同 id 重发 → 二次回执 deduplicated=true；仅一行一广播', async () => {
    const conv = await conversations.ensureConversation('private', 604);
    const user = await authed(USER_A, 'user');
    const lawyer = await authed(LAWYER_B, 'lawyer');
    await join(user, conv.conversation_id);
    await join(lawyer, conv.conversation_id);

    const frame = {
      type: 'send',
      conversation_id: conv.conversation_id,
      msg_client_id: 'client-abc-1',
      message: { content: '幂等消息' },
    };
    user.send(frame);
    const mine = await user.collect(['sent', 'message']); // 到达序不保证——按类型集收齐
    expect(mine.sent).toMatchObject({ type: 'sent', seq: 1, deduplicated: false });
    await lawyer.next(); // 对端广播恰一帧

    user.send(frame); // 网络重试语义：同 msg_client_id
    const second = await user.next();
    expect(second).toMatchObject({ type: 'sent', seq: 1, deduplicated: true });
    await user.expectSilence();
    await lawyer.expectSilence();
    expect(await messageCount(conv.conversation_id)).toBe(1);
  });

  it('T5 持久回执面：换连接（进程重启语义——判重态全在 DB 非内存）同 msg_client_id 重发 → 仍 deduplicated=true 回放原 seq；回执行在册恰一', async () => {
    const conv = await conversations.ensureConversation('private', 605);
    const first = await authed(USER_A, 'user');
    await join(first, conv.conversation_id);
    first.send({
      type: 'send',
      conversation_id: conv.conversation_id,
      msg_client_id: 'client-restart-1',
      message: { content: '首访消息' },
    });
    const mine = await first.collect(['sent', 'message']);
    expect(mine.sent).toMatchObject({ type: 'sent', seq: 1, deduplicated: false });
    first.terminate(); // 断连（连接态随生命周期回收——LRU 时代判重态即丢失）

    // 新连接（等价于新 gateway 实例重建 states 后的判重路径）：持久面仍命中
    const second = await authed(USER_A, 'user');
    await join(second, conv.conversation_id);
    second.send({
      type: 'send',
      conversation_id: conv.conversation_id,
      msg_client_id: 'client-restart-1',
      message: { content: '首访消息（重发）' },
    });
    const replay = await second.next();
    expect(replay).toMatchObject({
      type: 'sent',
      seq: 1,
      msg_client_id: 'client-restart-1',
      deduplicated: true,
    });
    expect(await messageCount(conv.conversation_id)).toBe(1); // 恰一行
    const receipt = await pool.query<{ n: number; message_seq: number }>(
      `SELECT count(*)::int AS n, max(message_seq)::int AS message_seq
         FROM fulfillment.message_receipts WHERE conversation_id = $1 AND dedup_key = $2`,
      [conv.conversation_id, 'client-restart-1'],
    );
    expect(receipt.rows[0]).toEqual({ n: 1, message_seq: 1 }); // 回执恰一、seq 锚=首访
  });

  // --------------------------------------------------------------------------
  // join/leave/presence/回填（§2：迟到回填 N=200；room OPEN 门）
  // --------------------------------------------------------------------------

  it('迟到 join 回填：最近 200 条自动推送（第 6..205 条）；PresenceJoined 出箱载荷逐字', async () => {
    const conversationId = await seedMemberRoom('OPEN', USER_A); // C-1：PAID 成员方可 join
    await pool.query(
      `INSERT INTO fulfillment.messages
         (conversation_id, seq, sender_id, sender_role, type, content, risk_flag)
       SELECT $1, g, $2, 'user', 'text', 'bulk-' || g, 'PASS' FROM generate_series(1, 205) AS g`,
      [conversationId, USER_A],
    );
    const late = await authed(USER_A, 'user');
    const joined = await join(late, conversationId);
    expect(joined).toMatchObject({ type: 'joined', conversation_id: conversationId });
    const backfill = (joined as { backfill: { seq: number }[] }).backfill;
    expect(backfill).toHaveLength(200);
    expect(backfill[0]!.seq).toBe(6);
    expect(backfill.at(-1)!.seq).toBe(205);

    const presence = await waitForOutbox(PRESENCE_JOINED_TOPIC, 1);
    expect(presence).toHaveLength(1);
    expect(Object.keys(presence[0]!).sort()).toEqual([
      'at',
      'conversation_id',
      'ref_id',
      'role',
      'user_id',
    ]);
    expect(presence[0]).toMatchObject({
      conversation_id: conversationId,
      user_id: USER_A,
      role: 'user',
    });
    expect(Number.isNaN(Date.parse(presence[0]!.at as string))).toBe(false);
  });

  it('I-3 join 顺序：presence 出箱失败 → error 帧且零订阅残留（后续广播零收到）', async () => {
    const conv = await conversations.ensureConversation('private', 607);
    const unlucky = await authed(USER_A, 'user');
    // 注入首 join 的 presence 出箱失败（recordPresence 先行——失败即止，不订阅不回填）
    const spy = vi
      .spyOn(conversations, 'recordPresence')
      .mockRejectedValueOnce(new Error('presence-outbox-down'));
    unlucky.send({ type: 'join', conversation_id: conv.conversation_id });
    const rejected = await unlucky.next();
    expect(rejected).toMatchObject({ type: 'error', reply_to: 'join' });
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();

    // 零订阅残留：另一成员正常 join 后发送，失败方零收到
    const member = await authed(LAWYER_B, 'lawyer');
    await join(member, conv.conversation_id);
    member.send({
      type: 'send',
      conversation_id: conv.conversation_id,
      message: { content: '在场广播' },
    });
    await member.collect(['sent', 'message']);
    await unlucky.expectSilence(); // 未订阅——广播不可达
  });

  it('presence leave/断连：leave 帧 → PresenceLeft 出箱；socket 终止 → 断连侧同样出箱（隐式离场）', async () => {
    const conv = await conversations.ensureConversation('private', 605);
    const user = await authed(USER_A, 'user');
    await join(user, conv.conversation_id);
    user.send({ type: 'leave', conversation_id: conv.conversation_id });
    await expect(user.next()).resolves.toMatchObject({
      type: 'left',
      conversation_id: conv.conversation_id,
    });
    expect(await waitForOutbox(PRESENCE_LEFT_TOPIC, 1)).toHaveLength(1);

    const lawyer = await authed(LAWYER_B, 'lawyer');
    await join(lawyer, conv.conversation_id);
    lawyer.terminate(); // 断线（无 leave 帧）
    const left = await waitForOutbox(PRESENCE_LEFT_TOPIC, 2);
    expect(left).toHaveLength(2); // 断连=隐式 leave（D3 快照收敛依赖）
    expect(left[1]).toMatchObject({
      conversation_id: conv.conversation_id,
      user_id: LAWYER_B,
      role: 'lawyer',
    });
  });

  it('room 型 join 门：OPEN+成员放行；CLOSED 拒（E_CONFLICT）；未知会话拒（E_NOT_FOUND）；one_on_one 无房间门', async () => {
    const openConvId = await seedMemberRoom('OPEN', USER_A); // C-1：PAID 成员的 OPEN 房间
    const user = await authed(USER_A, 'user');
    await expect(join(user, openConvId)).resolves.toMatchObject({
      type: 'joined',
      conversation_id: openConvId,
    });

    const closedConv = await conversations.ensureConversation(
      'room',
      await seedRoomRow('CLOSED', 703),
    );
    user.send({ type: 'join', conversation_id: closedConv.conversation_id });
    await expect(user.next()).resolves.toMatchObject({
      type: 'error',
      code: 'E_CONFLICT',
      reply_to: 'join',
    });

    user.send({ type: 'join', conversation_id: 987654 });
    await expect(user.next()).resolves.toMatchObject({
      type: 'error',
      code: 'E_NOT_FOUND',
      reply_to: 'join',
    });

    // one_on_one 型：无房间状态门（joinableConversation 仅 room 型查 OPEN）+订单双方成员门
    // （#43 M2-W3 T3——USER_A=订单 user 侧放行；房间锚仅订单行存在性要求）
    const oooRoomId = await seedRoomRow('OPEN', 903);
    const oooOrderId = await seedOooOrderRaw(pool, {
      roomId: oooRoomId,
      userId: USER_A,
      lawyerId: LAWYER_B,
    });
    const ooo = await conversations.ensureConversation('one_on_one', oooOrderId);
    await expect(join(user, ooo.conversation_id)).resolves.toMatchObject({
      type: 'joined',
      conversation_id: ooo.conversation_id,
    });
  });

  it('C-1 join 成员门（room 型）：非成员 user join 拒（403 E_ROLE_FORBIDDEN）；场次律师可 join', async () => {
    const conversationId = await seedMemberRoom('OPEN', USER_A); // 成员=USER_A；律师=ROOM_LAWYER
    const outsider = await authed(USER_B_GUEST, 'user');
    outsider.send({ type: 'join', conversation_id: conversationId });
    await expect(outsider.next()).resolves.toMatchObject({
      type: 'error',
      code: 'E_ROLE_FORBIDDEN',
      reply_to: 'join',
    });
    // 场次属主律师放行（成员资格另一半边）
    const owner = await authed(ROOM_LAWYER, 'lawyer');
    await expect(join(owner, conversationId)).resolves.toMatchObject({
      type: 'joined',
      conversation_id: conversationId,
    });
  });

  it('C-1 send 成员门（room 型）：PAID 成员可 send；非成员 403 零落库', async () => {
    const conversationId = await seedMemberRoom('OPEN', USER_A);
    const member = await authed(USER_A, 'user');
    await join(member, conversationId); // 在场（广播可收）
    member.send({
      type: 'send',
      conversation_id: conversationId,
      message: { content: '成员发言' },
    });
    const mine = await member.collect(['sent', 'message']);
    expect(mine.sent).toMatchObject({ type: 'sent', seq: 1 });

    const outsider = await authed(USER_B_GUEST, 'user');
    outsider.send({
      type: 'send',
      conversation_id: conversationId,
      message: { content: '非成员发言' },
    });
    await expect(outsider.next()).resolves.toMatchObject({
      type: 'error',
      code: 'E_ROLE_FORBIDDEN',
      reply_to: 'send',
    });
    expect(await messageCount(conversationId)).toBe(1); // 仅成员一条
  });

  // --------------------------------------------------------------------------
  // pull（§5 WSS pull(seq)：断线增量）
  // --------------------------------------------------------------------------

  it('pull 帧：after_seq 独占下界升序返回（断线补拉同源读路径）', async () => {
    const conv = await conversations.ensureConversation('private', 606);
    await pool.query(
      `INSERT INTO fulfillment.messages
         (conversation_id, seq, sender_id, sender_role, type, content, risk_flag)
       SELECT $1, g, $2, 'user', 'text', 'bulk-' || g, 'PASS' FROM generate_series(1, 5) AS g`,
      [conv.conversation_id, USER_A],
    );
    const user = await authed(USER_A, 'user');
    user.send({ type: 'pull', conversation_id: conv.conversation_id, after_seq: 3 });
    const frame = await user.next();
    expect(frame).toMatchObject({ type: 'messages', conversation_id: conv.conversation_id });
    expect((frame as { messages: { seq: number }[] }).messages.map((m) => m.seq)).toEqual([4, 5]);
  });

  // --------------------------------------------------------------------------
  // recording-consent（R-03 信令面）
  // --------------------------------------------------------------------------

  it('recording-consent 信令：room 型 403 E_KIND_POLICY（D10 拼单不录制）；one_on_one 单方回执零启动', async () => {
    const roomConv = await conversations.ensureConversation('room', await seedRoomRow('OPEN', 704));
    const user = await authed(USER_A, 'user');
    user.send({
      type: 'recording-consent',
      conversation_id: roomConv.conversation_id,
      accept: true,
    });
    await expect(user.next()).resolves.toMatchObject({
      type: 'error',
      code: 'E_KIND_POLICY',
      reply_to: 'recording-consent',
    });
    expect(rtc.recordingCalls).toHaveLength(0);

    // one_on_one 单方回执（#43 M2-W3 T3：consent party 须∈订单双方——USER_A=订单 user 侧）
    const oooRoomId = await seedRoomRow('OPEN', 904);
    const oooOrderId = await seedOooOrderRaw(pool, {
      roomId: oooRoomId,
      userId: USER_A,
      lawyerId: LAWYER_B,
    });
    const ooo = await conversations.ensureConversation('one_on_one', oooOrderId);
    user.send({ type: 'recording-consent', conversation_id: ooo.conversation_id, accept: true });
    await expect(user.next()).resolves.toMatchObject({
      type: 'recording_consent',
      conversation_id: ooo.conversation_id,
      recorded: true,
      both: false,
    });
    expect(rtc.recordingCalls).toHaveLength(0); // 单方零启动（双门全量断言在 conversation.spec）
  });

  it('I-1 帧上限（gateway maxPayload=64KB）：超大帧（>64KB）→ ws 层拒收断连（1009）', async () => {
    const user = await authed(USER_A, 'user');
    user.sendRaw(Buffer.alloc(70 * 1024, 0x61)); // 70KB 单帧（超 64KB 上限）
    const code = await user.closed;
    expect(code).toBe(1009); // ws 层 message-too-big 关闭码
  });

  it('I-1 content 长度上限（>8000 字符经 WSS）：400 E_INVALID_ARGUMENT 回执零落库', async () => {
    const conv = await conversations.ensureConversation('private', 608);
    const user = await authed(USER_A, 'user');
    user.send({
      type: 'send',
      conversation_id: conv.conversation_id,
      message: { content: 'z'.repeat(8_001) },
    });
    await expect(user.next()).resolves.toMatchObject({
      type: 'error',
      code: 'E_INVALID_ARGUMENT',
      reply_to: 'send',
    });
    expect(await messageCount(conv.conversation_id)).toBe(0);
  });
});
