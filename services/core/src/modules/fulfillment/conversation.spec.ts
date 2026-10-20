import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Pool } from 'pg';
import { WsAdapter } from '@nestjs/platform-ws';
import {
  ErrorCode,
  MESSAGE_SENT_TOPIC,
  ONE_ON_ONE_CONVERSATION_CREATED_TOPIC,
  ONE_ON_ONE_PAID_TOPIC,
  RECORDING_CONSENT_GIVEN_TOPIC,
  TRAINING_CONSENT_REVOKED_TOPIC,
  TRAINING_DATA_PURGED_TOPIC,
} from '@ljr/shared';
import { ensureTestDatabase, truncateAll } from '../../infrastructure/testing/db';
import { PgPoolService } from '../../infrastructure/sql';
import {
  ARTIFACT_STORE,
  LocalFsArtifactStore,
} from '../../infrastructure/artifacts/artifact-store';
import { ArtifactsService } from '../../infrastructure/artifacts/artifacts.service';
import { OutboxRelayService } from '../../infrastructure/outbox/outbox-relay.service';
import { RULE_CURRENT_CACHE, InProcessRuleCurrentCache } from '../ops/rule-center.cache';
import { RuleCenterService } from '../ops/rule-center.service';
import { WordDictAutomatonCache } from '../ops/word-dict.cache';
import { WordDictService } from '../ops/word-dict.service';
import { IDENTITY_CONFIG, type IdentityConfig } from '../identity/identity.config';
import { IdentityTokenService } from '../identity/identity.token.service';
import { grantUserRoles, seedLawyerProfile, seedUserShell } from '../identity/lawyer-fixture';
import { seedPaymentOrderRaw } from '../payment/order-fixture';
import { SchedulerService } from '../schedule/scheduler.service';
import { enrollmentOrderKey } from '../trade/enrollment.types';
import { seedPaidEnrollmentRaw, seedSessionAtRaw } from '../trade/trade-fixture';
import { FulfillmentModule } from './fulfillment.module';
import { MockRtcProvider } from './rtc-provider';
import { ConversationService } from './conversation.service';
import { seedOooOrderRaw } from './one-on-one-fixture';

/**
 * D5 会话与消息服务面（需 PG；M2-W1 T3——D5 §10 五项 + §9 铁律的服务层承载）：
 *   发送链（checkRisk→BLOCKED 拒/REVIEW 标记→单事务发号+落库+MessageSent 出箱——载荷无 content
 *   PII 铁律）、seq 并发无洞（⚠W1-3 PG 发号）、断线补拉 after_seq/limit 收窄/回填 200 上限、
 *   录制 consent 双门（R-03：单方零调用/双方齐恰一次/room 型 403）、@mention 标记（sender_role
 *   仍=user——提及非代发）、系统消息内部写入面（D2 导出面）、撤回删除消费（R-04：语料行物理删+
 *   TrainingDataPurged 回执、重放零行仍回执）、OneOnOnePaid 合成事件桩（建会话+出箱+重放幂等）、
 *   冷存 COLD_ARCHIVE（>90d 转 I3 cold_message+热删、近 90d 不动、二次扫描零动作）、
 *   开房即建 room 会话（D1 集成）、HTTP 面（GET messages/notice 薄代理）。
 * 驱动：relay 手动 tick；调度器不自启动（开房用例手动 priority tick）。
 */

const FIRM_ID = 8801;
const USER_A = 7101;
const USER_B = 7202;
const LAWYER_B = 7203;
const DAY_MS = 86_400_000;

const testIdentityConfig = (): IdentityConfig => ({
  phoneDataKey: randomBytes(32),
  phoneBlindPepper: randomBytes(32).toString('hex'),
  jwtSecret: randomBytes(32).toString('hex'),
});

describe('D5 会话与消息服务面（发送链/seq/补拉/consent 双门/撤回删除/OneOnOnePaid 桩/冷存，需 PG）', () => {
  let pool: Pool;
  let app: INestApplication;
  let conversations: ConversationService;
  let words: WordDictService;
  let relay: OutboxRelayService;
  let rtc: MockRtcProvider;
  let scheduler: SchedulerService;
  let poolSvc: PgPoolService;
  let artifacts: ArtifactsService;
  let rules: RuleCenterService;
  let tokens: IdentityTokenService;
  let dictCache: WordDictAutomatonCache;
  let ruleCache: InProcessRuleCurrentCache;
  let tmpDir: string;
  /** MockRtcProvider 进程级单例：TRUNCATE 不重置其内存调用轨迹——用例以基线偏移断言 */
  let rtcBase = 0;

  const outboxPayloads = async (topic: string): Promise<Record<string, unknown>[]> => {
    const res = await pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM platform.outbox WHERE topic = $1 ORDER BY id`,
      [topic],
    );
    return res.rows.map((r) => r.payload);
  };

  const insertSyntheticEvent = async (topic: string, payload: unknown): Promise<string> => {
    const res = await pool.query<{ event_id: string }>(
      `INSERT INTO platform.outbox (event_id, topic, payload, status)
       VALUES (gen_random_uuid(), $1, $2::jsonb, 'PENDING') RETURNING event_id::text AS event_id`,
      [topic, JSON.stringify(payload)],
    );
    return res.rows[0]!.event_id;
  };

  const send = (conversationId: number, content: string, mention?: 'agent' | 'lawyer') =>
    conversations.sendMessage({
      conversationId,
      senderId: USER_A,
      senderRole: 'user',
      content,
      mention,
    });

  /** 直插 room 行（会话/consent 用例的房间锚——非 room 生命周期断言面，直接本域 INSERT） */
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

  /** 直插批量消息（读路径用例；绕过发送链聚焦 seq 补拉语义——seq 自会话现水位续号） */
  const seedBulkMessages = async (
    conversationId: number,
    count: number,
    opts?: { readonly ageDays?: number; readonly senderId?: number; readonly corpus?: boolean },
  ): Promise<void> => {
    await pool.query(
      `INSERT INTO fulfillment.messages
         (conversation_id, seq, sender_id, sender_role, type, content, risk_flag, source_msg_id, created_at)
       SELECT $1,
              COALESCE((SELECT max(seq) FROM fulfillment.messages WHERE conversation_id = $1), 0) + g,
              $2, 'user', 'text', 'bulk-' || g, 'PASS', $4,
              now() - ($3::bigint * interval '1 day')
         FROM generate_series(1, $5::bigint) AS g`,
      [
        conversationId,
        opts?.senderId ?? USER_A,
        opts?.ageDays ?? 0,
        opts?.corpus ? randomUUID() : null,
        count,
      ],
    );
  };

  /**
   * 真链成员房间（C-1 成员门用例锚）：场次（属主律师 9101）+ USER_A PAID 报名 + room 行 +
   * room 会话——成员资格=PAID 报名或场次律师（trade 导出面 isSessionParticipant 事实源）。
   */
  const seedMemberRoom = async (
    status = 'OPEN',
    member = USER_A,
  ): Promise<{ conversationId: number; roomId: number; sessionId: number; lawyerId: number }> => {
    const lawyerId = 9101;
    const sessionId = await seedSessionAtRaw(
      pool,
      lawyerId,
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
    return { conversationId: conv.conversation_id, roomId, sessionId, lawyerId };
  };

  beforeAll(async () => {
    pool = await ensureTestDatabase();
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'ljr-d5-conv-'));
    const moduleRef = await Test.createTestingModule({ imports: [FulfillmentModule] })
      .overrideProvider(IDENTITY_CONFIG)
      .useValue(testIdentityConfig())
      .overrideProvider(ARTIFACT_STORE)
      .useValue(new LocalFsArtifactStore(tmpDir))
      .compile();
    app = moduleRef.createNestApplication();
    app.useWebSocketAdapter(new WsAdapter(app)); // 网关注册前置（仅初始化，不 listen）
    await app.init();
    conversations = app.get(ConversationService);
    words = app.get(WordDictService);
    relay = app.get(OutboxRelayService);
    rtc = app.get(MockRtcProvider);
    scheduler = app.get(SchedulerService);
    poolSvc = app.get(PgPoolService);
    artifacts = app.get(ArtifactsService);
    rules = app.get(RuleCenterService);
    tokens = app.get(IdentityTokenService);
    dictCache = app.get(WordDictAutomatonCache);
    ruleCache = app.get<InProcessRuleCurrentCache>(RULE_CURRENT_CACHE);
    // D5 回执事件消费方（A2 授权回写/H9 监督/D6 流程推进）=W2/W3 落位——spec 内 noop 承接
    // 防「同轮批处理把回执事件打进重试轨道」的计数噪声（w1-smoke noop 先例）；MessageSent
    // 消费方 E1/H5=W3，保持 PENDING 不承接（与 room.spec 的 RoomOpened 同口径）。
    relay.registerHandler(TRAINING_DATA_PURGED_TOPIC, async () => undefined);
    relay.registerHandler(ONE_ON_ONE_CONVERSATION_CREATED_TOPIC, async () => undefined);
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });
  beforeEach(async () => {
    await truncateAll(pool);
    dictCache.clear();
    ruleCache.clear();
    rtcBase = rtc.recordingCalls.length;
  });
  afterEach(async () => {
    await truncateAll(pool);
    dictCache.clear();
    ruleCache.clear();
  });

  /** 本用例内的录制调用（进程级单例轨迹的基线偏移切片） */
  const recordingCalls = () => rtc.recordingCalls.slice(rtcBase);

  // ===========================================================================
  // 发送链（D5 §4 顺序铁律 / §9 PII 禁令 / R-01 同链路）
  // ===========================================================================

  it('发送链 PASS：单事务发号+落库+MessageSent 出箱（载荷无 content——PII 铁律键集断言）', async () => {
    const conv = await conversations.ensureConversation('private', 501);
    const msg = await send(conv.conversation_id, '你好，我想咨询劳动仲裁流程');
    expect(msg.seq).toBe(1);
    expect(msg.risk_flag).toBe('PASS');
    expect(msg.sender_role).toBe('user');

    const events = await outboxPayloads(MESSAGE_SENT_TOPIC);
    expect(events).toHaveLength(1);
    // 载荷键集恰三键（无 content——D5 §9「明文 PII 落 MQ 载荷」禁令，附录 A.1 冻结形状）
    expect(Object.keys(events[0]!).sort()).toEqual(['conversation_id', 'risk_flag', 'seq']);
    expect(events[0]).toEqual({ conversation_id: conv.conversation_id, seq: 1, risk_flag: 'PASS' });
  });

  it('R-01 违规拦截：BLOCK 词 → 403 E_BLOCKED_BY_RISK；messages 零行；outbox 零 MessageSent（拒发即无事件）', async () => {
    await words.putDictionary({
      dictType: 'illegal_content',
      baseVersion: 0,
      words: [{ word: 'blockword', action: 'BLOCK' }],
    });
    const conv = await conversations.ensureConversation('private', 502);
    await expect(send(conv.conversation_id, '正常消息先行')).resolves.toBeTruthy();
    await expect(send(conv.conversation_id, '这有一条 blockword 违规')).rejects.toMatchObject({
      code: ErrorCode.BlockedByRisk,
      httpStatus: 403,
    });
    const rows = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM fulfillment.messages WHERE conversation_id = $1`,
      [conv.conversation_id],
    );
    expect(rows.rows[0]!.n).toBe(1); // 仅正常消息
    expect(await outboxPayloads(MESSAGE_SENT_TOPIC)).toHaveLength(1);
  });

  it('REVIEW 命中：放行+risk_flag=REVIEW+MessageSent(REVIEW)（risk_records 落记录面=ops 域 word-dict.spec 自证，禁跨域直查）', async () => {
    await words.putDictionary({
      dictType: 'legal_industry',
      baseVersion: 0,
      words: [{ word: 'reviewword', action: 'REVIEW' }],
    });
    // private 会话（成员门不设限——本用例断言判定面非成员门；room 门=C-1 专测）
    const conv = await conversations.ensureConversation('private', 601);
    const msg = await send(conv.conversation_id, '内容含 reviewword 触发复核');
    expect(msg.risk_flag).toBe('REVIEW');
    const events = await outboxPayloads(MESSAGE_SENT_TOPIC);
    expect(events[events.length - 1]).toMatchObject({ seq: msg.seq, risk_flag: 'REVIEW' });
    // checkRisk 的 REVIEW 副作用（ops 域 risk_records 落行，含 conversation_id 关联）由 H5
    // word-dict.spec「REVIEW 命中落记录」用例自证——本域禁直查他域表（check-schema-refs 规则 A）
  });

  it('@mention：mention 落列（agent|lawyer）；@Agent 消息 sender_role 仍=user（提及非代发）；非法 mention 400', async () => {
    const conv = await conversations.ensureConversation('private', 503);
    const atAgent = await send(conv.conversation_id, '@Agent 请给我流程指引', 'agent');
    expect(atAgent.mention).toBe('agent');
    expect(atAgent.sender_role).toBe('user'); // 隔离铁律半边：提及≠代发
    const atLawyer = await send(conv.conversation_id, '@律师 请看材料', 'lawyer');
    expect(atLawyer.mention).toBe('lawyer');
    await expect(send(conv.conversation_id, 'x', 'other' as 'agent')).rejects.toMatchObject({
      code: ErrorCode.InvalidArgument,
    });
  });

  it('入参校验：空 content 400；未知会话 404', async () => {
    const conv = await conversations.ensureConversation('private', 504);
    await expect(send(conv.conversation_id, '')).rejects.toMatchObject({
      code: ErrorCode.InvalidArgument,
    });
    await expect(send(987654, 'hello')).rejects.toMatchObject({ code: ErrorCode.NotFound });
  });

  it('I-1 content 长度上限（MESSAGE_MAX_LEN=8000，W1 防滥用裁量）：超限 400；内部系统消息同护栏', async () => {
    const conv = await conversations.ensureConversation('private', 514);
    await expect(send(conv.conversation_id, 'x'.repeat(8_001))).rejects.toMatchObject({
      code: ErrorCode.InvalidArgument,
    });
    await expect(
      conversations.postInternalMessage({
        conversationId: conv.conversation_id,
        senderRole: 'system',
        content: 'y'.repeat(8_001),
      }),
    ).rejects.toMatchObject({ code: ErrorCode.InvalidArgument });
    const ok = await send(conv.conversation_id, 'x'.repeat(8_000)); // 恰上限放行
    expect(ok.seq).toBe(1);
  });

  it('C-1 四口成员门（room 型）：非成员 send/list 403；PAID 成员可 send；场次律师可 send（trade 导出面）', async () => {
    const room = await seedMemberRoom();
    // 非成员 USER_B：send 拒（403 E_ROLE_FORBIDDEN）
    await expect(
      conversations.sendMessage({
        conversationId: room.conversationId,
        senderId: USER_B,
        senderRole: 'user',
        content: '非成员发言',
      }),
    ).rejects.toMatchObject({ code: ErrorCode.RoleForbidden, httpStatus: 403 });
    // 非成员 USER_B：list 拒
    await expect(
      conversations.listMessages({ conversationId: room.conversationId, asUserId: USER_B }),
    ).rejects.toMatchObject({ code: ErrorCode.RoleForbidden, httpStatus: 403 });
    // 非成员 USER_B：HTTP GET 403（四口之一）
    const tokenB = await tokens.signAccessToken({ userId: USER_B, role: 'user', roles: ['user'] });
    const denied = await request(app.getHttpServer())
      .get(`/conversations/${room.conversationId}/messages`)
      .set('Authorization', `Bearer ${tokenB}`);
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe(ErrorCode.RoleForbidden);
    // PAID 成员 USER_A：send 放行
    const asMember = await conversations.sendMessage({
      conversationId: room.conversationId,
      senderId: USER_A,
      senderRole: 'user',
      content: '成员发言',
    });
    expect(asMember.seq).toBe(1);
    // 场次属主律师：send 放行
    const asLawyer = await conversations.sendMessage({
      conversationId: room.conversationId,
      senderId: room.lawyerId,
      senderRole: 'lawyer',
      content: '律师发言',
    });
    expect(asLawyer.seq).toBe(2);
    // 成员读放行（asUserId=成员）
    const readable = await conversations.listMessages({
      conversationId: room.conversationId,
      asUserId: USER_A,
    });
    expect(readable).toHaveLength(2);
    // private 型：#7 私信通道决策未决——维持开放（04§8 #43 注记收口范围=one_on_one）
    const priv = await conversations.ensureConversation('private', 515);
    await expect(
      conversations.listMessages({ conversationId: priv.conversation_id, asUserId: USER_B }),
    ).resolves.toHaveLength(0);
  });

  it('C-1 四口成员门（one_on_one 型，#43 M2-W3 T3）：非双方第三者 join/send/pull/GET 四口全 403；订单双方正向放行（不要求订单状态）；订单行缺失=409 数据漂移', async () => {
    // 订单锚（ parties=USER_A×LAWYER_B；终态 SETTLED 造行——历史会话可回看口径）
    const roomId = await seedRoomRow('OPEN', 610);
    const orderId = await seedOooOrderRaw(pool, {
      roomId,
      userId: USER_A,
      lawyerId: LAWYER_B,
      status: 'SETTLED',
    });
    const conv = await conversations.ensureConversation('one_on_one', orderId);
    const conversationId = conv.conversation_id;

    // 第三者 USER_B 四口逐口拒（join=assertAccess 单点——WSS handleJoin 同一入口）
    await expect(conversations.assertAccess(conversationId, USER_B)).rejects.toMatchObject({
      code: ErrorCode.RoleForbidden,
      httpStatus: 403,
    });
    await expect(
      conversations.sendMessage({
        conversationId,
        senderId: USER_B,
        senderRole: 'user',
        content: '第三者发言',
      }),
    ).rejects.toMatchObject({ code: ErrorCode.RoleForbidden, httpStatus: 403 });
    await expect(
      conversations.listMessages({ conversationId, asUserId: USER_B }),
    ).rejects.toMatchObject({ code: ErrorCode.RoleForbidden, httpStatus: 403 });
    const tokenB = await tokens.signAccessToken({ userId: USER_B, role: 'user', roles: ['user'] });
    const denied = await request(app.getHttpServer())
      .get(`/conversations/${conversationId}/messages`)
      .set('Authorization', `Bearer ${tokenB}`);
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe(ErrorCode.RoleForbidden);

    // 双方正向：user 侧 send + lawyer 侧 send/pull（SETTLED 终态仍可回看——成员资格随 parties）
    const asUser = await conversations.sendMessage({
      conversationId,
      senderId: USER_A,
      senderRole: 'user',
      content: '用户问',
    });
    expect(asUser.seq).toBe(1);
    const asLawyer = await conversations.sendMessage({
      conversationId,
      senderId: LAWYER_B,
      senderRole: 'lawyer',
      content: '律师答',
    });
    expect(asLawyer.seq).toBe(2);
    const pulled = await conversations.listMessages({ conversationId, asUserId: LAWYER_B });
    expect(pulled).toHaveLength(2);

    // 订单行缺失（会话在册而订单被清）=数据漂移显性 409 不静默放行
    const orphan = await conversations.ensureConversation('one_on_one', 999_999);
    await expect(conversations.assertAccess(orphan.conversation_id, USER_A)).rejects.toMatchObject({
      code: ErrorCode.Conflict,
      httpStatus: 409,
    });
  });

  it('⚠W1-3 seq 并发无洞：两个发送方交错并发 12 条 → seq 恰为 1..12 无重复（行锁发号+UNIQUE 兜底）', async () => {
    const conv = await conversations.ensureConversation('private', 505);
    const jobs = Array.from({ length: 12 }, (_, i) =>
      conversations.sendMessage({
        conversationId: conv.conversation_id,
        senderId: i % 2 === 0 ? USER_A : USER_B,
        senderRole: i % 2 === 0 ? 'user' : 'lawyer',
        content: `并发-${i}`,
      }),
    );
    const results = await Promise.all(jobs);
    const seqs = results.map((m) => m.seq).sort((a, b) => a - b);
    expect(seqs).toEqual(Array.from({ length: 12 }, (_, i) => i + 1)); // 严格递增无洞无重
    expect(new Set(seqs).size).toBe(12);
    const rows = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM fulfillment.messages WHERE conversation_id = $1`,
      [conv.conversation_id],
    );
    expect(rows.rows[0]!.n).toBe(12);
  });

  // ===========================================================================
  // 读路径（§5 GET /conversations/{id}/messages + §2 回填 N=200）
  // ===========================================================================

  it('断线补拉：after_seq 独占下界按 seq 升序；limit 缺省 50、上限 200（超出收窄）；未知会话 404', async () => {
    const conv = await conversations.ensureConversation('private', 506);
    await seedBulkMessages(conv.conversation_id, 205);
    const page = await conversations.listMessages({
      conversationId: conv.conversation_id,
      asUserId: USER_A,
      afterSeq: 200,
      limit: 2,
    });
    expect(page.map((m) => m.seq)).toEqual([201, 202]);
    const rest = await conversations.listMessages({
      conversationId: conv.conversation_id,
      asUserId: USER_A,
      afterSeq: 202,
    });
    expect(rest.map((m) => m.seq)).toEqual([203, 204, 205]);
    const capped = await conversations.listMessages({
      conversationId: conv.conversation_id,
      asUserId: USER_A,
      limit: 999,
    });
    expect(capped).toHaveLength(200); // 上限收窄
    const tail = await conversations.recentMessages(conv.conversation_id);
    expect(tail).toHaveLength(200); // 回填 N=200（D5 §2）
    expect(tail[0]!.seq).toBe(6); // 最近 200 条=seq 6..205
    await expect(
      conversations.listMessages({ conversationId: 987654, asUserId: USER_A, afterSeq: 0 }),
    ).rejects.toMatchObject({ code: ErrorCode.NotFound });
  });

  it('迟到回填：join 语义取最近 BACKFILL_LIMIT 条升序（服务面 recentMessages 承载；网关回填同源）', async () => {
    const conv = await conversations.ensureConversation('private', 507);
    await seedBulkMessages(conv.conversation_id, 205);
    const backfill = await conversations.recentMessages(conv.conversation_id, 200);
    expect(backfill.at(-1)!.seq).toBe(205);
    expect(backfill[0]!.seq).toBe(6);
  });

  // ===========================================================================
  // 录制 consent 双门（R-03：仅 one_on_one；拼单默认不录制 D10）
  // ===========================================================================

  it('R-03 consent 双门：单方落记录零启动；双方齐 startRecording 恰一次；重复信令幂等；room 型 403 E_KIND_POLICY', async () => {
    // 订单锚（#43 M2-W3 T3：consent party 须∈订单双方——901 系裸 ref 直建会话已不可达）
    const roomId901 = await seedRoomRow('OPEN', 901);
    const order901 = await seedOooOrderRaw(pool, {
      roomId: roomId901,
      userId: USER_A,
      lawyerId: LAWYER_B,
    });
    const ooo = await conversations.ensureConversation('one_on_one', order901);
    // 单方（user）
    const first = await conversations.recordConsent({
      conversationId: ooo.conversation_id,
      partyId: USER_A,
      accept: true,
    });
    expect(first.recorded).toBe(true);
    expect(first.bothPartiesConsented).toBe(false);
    expect(recordingCalls()).toHaveLength(0); // 单方不启动
    expect(await outboxPayloads(RECORDING_CONSENT_GIVEN_TOPIC)).toEqual([
      { conversation_id: ooo.conversation_id, party_id: USER_A },
    ]);
    // 对方（lawyer）→ 双门齐，恰一次启动
    const second = await conversations.recordConsent({
      conversationId: ooo.conversation_id,
      partyId: LAWYER_B,
      accept: true,
    });
    expect(second.recorded).toBe(true);
    expect(second.bothPartiesConsented).toBe(true);
    expect(recordingCalls()).toHaveLength(1);
    expect(recordingCalls()[0]).toEqual({ conversationId: ooo.conversation_id });
    // 同方重复信令：UNIQUE 幂等——零新事件零新启动
    const replay = await conversations.recordConsent({
      conversationId: ooo.conversation_id,
      partyId: USER_A,
      accept: true,
    });
    expect(replay.recorded).toBe(false);
    expect(recordingCalls()).toHaveLength(1);
    expect(await outboxPayloads(RECORDING_CONSENT_GIVEN_TOPIC)).toHaveLength(2);
    // 拼单房间（room 型）：D10 边界——信令面直接 403
    const roomConv = await conversations.ensureConversation('room', await seedRoomRow('OPEN', 602));
    await expect(
      conversations.recordConsent({
        conversationId: roomConv.conversation_id,
        partyId: USER_A,
        accept: true,
      }),
    ).rejects.toMatchObject({ code: ErrorCode.KindPolicy, httpStatus: 403 });
    expect(recordingCalls()).toHaveLength(1); // 仍一次
  });

  it('consent 前置校验：未知会话 404；accept=false 不落记录不判门（W1 无撤回语义，回执直达）', async () => {
    const roomId902 = await seedRoomRow('OPEN', 902);
    const order902 = await seedOooOrderRaw(pool, {
      roomId: roomId902,
      userId: USER_A,
      lawyerId: LAWYER_B,
    });
    const ooo = await conversations.ensureConversation('one_on_one', order902);
    await expect(
      conversations.recordConsent({ conversationId: 987654, partyId: USER_A, accept: true }),
    ).rejects.toMatchObject({ code: ErrorCode.NotFound });
    const declined = await conversations.recordConsent({
      conversationId: ooo.conversation_id,
      partyId: USER_A,
      accept: false,
    });
    expect(declined.recorded).toBe(false);
    expect(declined.bothPartiesConsented).toBe(false);
    expect(recordingCalls()).toHaveLength(0);
  });

  it('consent 身份核验（#43 评审 I-4，M2-W3 T3）：第三者 party 403（同意/拒结名义两分支均拒）零落行零启动；订单双方各一正向→双门齐恰一次启动', async () => {
    const roomId903 = await seedRoomRow('OPEN', 903);
    const order903 = await seedOooOrderRaw(pool, {
      roomId: roomId903,
      userId: USER_A,
      lawyerId: LAWYER_B,
    });
    const ooo = await conversations.ensureConversation('one_on_one', order903);

    // 第三者（USER_B 非订单双方）：给出同意 403；拒结名义同样拒（成员门先于拒结名义分支）
    await expect(
      conversations.recordConsent({
        conversationId: ooo.conversation_id,
        partyId: USER_B,
        accept: true,
      }),
    ).rejects.toMatchObject({ code: ErrorCode.RoleForbidden, httpStatus: 403 });
    await expect(
      conversations.recordConsent({
        conversationId: ooo.conversation_id,
        partyId: USER_B,
        accept: false,
      }),
    ).rejects.toMatchObject({ code: ErrorCode.RoleForbidden, httpStatus: 403 });
    const rows = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM fulfillment.consent_records WHERE ref_id = $1`,
      [ooo.conversation_id],
    );
    expect(rows.rows[0]!.n).toBe(0); // 零落行
    expect(recordingCalls()).toHaveLength(0); // 零启动

    // 双方各一正向（user 侧→单门；lawyer 侧→双门齐恰一次启动——同 R-03 双门口径）
    const asUser = await conversations.recordConsent({
      conversationId: ooo.conversation_id,
      partyId: USER_A,
      accept: true,
    });
    expect(asUser.recorded).toBe(true);
    expect(asUser.bothPartiesConsented).toBe(false);
    const asLawyer = await conversations.recordConsent({
      conversationId: ooo.conversation_id,
      partyId: LAWYER_B,
      accept: true,
    });
    expect(asLawyer.recorded).toBe(true);
    expect(asLawyer.bothPartiesConsented).toBe(true);
    expect(recordingCalls()).toEqual([{ conversationId: ooo.conversation_id }]);
  });

  it('C-2 consent 并发串行化：双方 Promise.recordConsent 并发 → 恰一方 both=true、startRecording 恰一次、双方回执齐', async () => {
    const roomId905 = await seedRoomRow('OPEN', 905);
    const order905 = await seedOooOrderRaw(pool, {
      roomId: roomId905,
      userId: USER_A,
      lawyerId: LAWYER_B,
    });
    const ooo = await conversations.ensureConversation('one_on_one', order905);
    const [asUser, asLawyer] = await Promise.all([
      conversations.recordConsent({
        conversationId: ooo.conversation_id,
        partyId: USER_A,
        accept: true,
      }),
      conversations.recordConsent({
        conversationId: ooo.conversation_id,
        partyId: LAWYER_B,
        accept: true,
      }),
    ]);
    // 双方各自落行（UNIQUE 不同 party 无冲突）；FOR UPDATE 串行化 → 后到者必见已提交对侧行
    expect(asUser.recorded).toBe(true);
    expect(asLawyer.recorded).toBe(true);
    const bothFlags = [asUser.bothPartiesConsented, asLawyer.bothPartiesConsented];
    expect(bothFlags.filter(Boolean)).toHaveLength(1); // 恰一方判双门齐（最终一致）
    expect(recordingCalls()).toHaveLength(1); // startRecording 恰一次
    expect(recordingCalls()[0]).toEqual({ conversationId: ooo.conversation_id });
    expect(await outboxPayloads(RECORDING_CONSENT_GIVEN_TOPIC)).toHaveLength(2); // 双方回执齐
    // 落库终态：两 distinct party 在册
    const rows = await pool.query<{ parties: number }>(
      `SELECT count(DISTINCT party_id)::int AS parties FROM fulfillment.consent_records
        WHERE ref_type = 'recording' AND ref_id = $1`,
      [ooo.conversation_id],
    );
    expect(rows.rows[0]!.parties).toBe(2);
  });

  // ===========================================================================
  // 系统消息内部写入面（D2/E1 接线位；隔离铁律：system/agent 不经 WSS）
  // ===========================================================================

  it('postInternalMessage（D2 房间内提醒导出面）：sender_role=system、type=system、共 seq 序列、MessageSent 出箱', async () => {
    // private 会话（本用例断言系统写入面，非 room 成员门——C-1 专测覆盖 room 型）
    const conv = await conversations.ensureConversation('private', 603);
    const userMsg = await send(conv.conversation_id, '用户消息');
    const sysMsg = await conversations.postInternalMessage({
      conversationId: conv.conversation_id,
      senderRole: 'system',
      content: '【提醒】场次将于 15 分钟后开始',
    });
    expect(sysMsg.sender_role).toBe('system');
    expect(sysMsg.type).toBe('system');
    expect(sysMsg.seq).toBe(userMsg.seq + 1); // 与用户消息共用会话 seq 序列
    expect(await outboxPayloads(MESSAGE_SENT_TOPIC)).toHaveLength(2);
  });

  // ===========================================================================
  // 撤回删除（R-04：TrainingConsentRevoked 消费 → 物理删 hot 语料 + TrainingDataPurged 回执）
  // ===========================================================================

  it('R-04 撤回删除：仅该用户语料行（source_msg_id 非空）物理删；TrainingDataPurged{hot,cold:0} 出箱；重放零行仍回执', async () => {
    const conv = await conversations.ensureConversation('private', 508);
    await seedBulkMessages(conv.conversation_id, 3, { corpus: true }); // 语料行 @USER_A
    await seedBulkMessages(conv.conversation_id, 2); // 普通行 @USER_A（不删）
    const other = await conversations.ensureConversation('private', 509);
    await seedBulkMessages(other.conversation_id, 1, { corpus: true, senderId: USER_B }); // 他人语料（不删）

    const eventId = await insertSyntheticEvent(TRAINING_CONSENT_REVOKED_TOPIC, {
      user_id: USER_A,
      revoked_at: new Date().toISOString(),
    });
    const ticked = await relay.tick();
    // dispatched：合成事件+回执事件（noop 承接，beforeAll 注册）≥1；零重试零死信为硬断言
    expect(ticked.dispatched).toBeGreaterThanOrEqual(1);
    expect(ticked).toMatchObject({ retried: 0, dead: 0 });

    const remaining = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM fulfillment.messages`,
    );
    expect(remaining.rows[0]!.n).toBe(3); // 2 普通行 + 1 他人语料行；3 条本用户语料已删
    const purged = await outboxPayloads(TRAINING_DATA_PURGED_TOPIC);
    expect(purged).toEqual([{ user_id: USER_A, hot_count: 3, cold_count: 0 }]);

    // at-least-once 重投（同 event_id 复位）：零行删除仍出回执（回执语义），不炸不重复删
    await pool.query(
      `UPDATE platform.outbox SET status = 'PENDING', sent_at = NULL WHERE event_id = $1::uuid`,
      [eventId],
    );
    const reTicked = await relay.tick();
    expect(reTicked.dispatched).toBeGreaterThanOrEqual(1);
    expect(reTicked).toMatchObject({ retried: 0, dead: 0 });
    const purged2 = await outboxPayloads(TRAINING_DATA_PURGED_TOPIC);
    expect(purged2).toHaveLength(2);
    expect(purged2[1]).toEqual({ user_id: USER_A, hot_count: 0, cold_count: 0 });
    const stillThere = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM fulfillment.messages`,
    );
    expect(stillThere.rows[0]!.n).toBe(3);
  });

  it('撤回消费防御：载荷缺 user_id → 进重试轨道不静默丢弃（retried=1，零删零回执）', async () => {
    await conversations.ensureConversation('private', 510);
    await insertSyntheticEvent(TRAINING_CONSENT_REVOKED_TOPIC, {
      revoked_at: new Date().toISOString(),
    });
    const ticked = await relay.tick();
    expect(ticked).toMatchObject({ retried: 1, dead: 0 });
    expect(await outboxPayloads(TRAINING_DATA_PURGED_TOPIC)).toHaveLength(0);
  });

  // ===========================================================================
  // OneOnOnePaid 合成事件桩（D6=W3 真生产；W1 直投 outbox 驱动）
  // —— 真链转正=M2-W3 T3 集成用例锚（one-on-one.spec「真链两端到端」：真订单 PAY_SUCCESS
  //    出箱→本消费面落 conversations 行；本单点消费者桩保留验证消费器幂等，不删不改断言）
  // ===========================================================================

  it('OneOnOnePaid 桩：消费建 one_on_one 会话+OneOnOneConversationCreated 出箱；重放幂等（created=false 零新事件）', async () => {
    const eventId = await insertSyntheticEvent(ONE_ON_ONE_PAID_TOPIC, {
      order_id: 8101,
      user_id: USER_A,
      lawyer_id: LAWYER_B,
    });
    const firstTick = await relay.tick();
    expect(firstTick.dispatched).toBeGreaterThanOrEqual(1);
    expect(firstTick).toMatchObject({ retried: 0, dead: 0 });
    const conv = await pool.query<{ id: string; type: string; ref_id: string }>(
      `SELECT id, type, ref_id FROM fulfillment.conversations WHERE type = 'one_on_one' AND ref_id = 8101`,
    );
    expect(conv.rows).toHaveLength(1);
    const conversationId = Number(conv.rows[0]!.id);
    expect(await outboxPayloads(ONE_ON_ONE_CONVERSATION_CREATED_TOPIC)).toEqual([
      { conversation_id: conversationId, order_id: 8101, user_id: USER_A, lawyer_id: LAWYER_B },
    ]);

    await pool.query(
      `UPDATE platform.outbox SET status = 'PENDING', sent_at = NULL WHERE event_id = $1::uuid`,
      [eventId],
    );
    const replayTick = await relay.tick();
    expect(replayTick.dispatched).toBeGreaterThanOrEqual(1);
    expect(replayTick).toMatchObject({ retried: 0, dead: 0 });
    expect(await outboxPayloads(ONE_ON_ONE_CONVERSATION_CREATED_TOPIC)).toHaveLength(1); // 幂等：不重复出箱
    const convAfter = await pool.query(
      `SELECT id FROM fulfillment.conversations WHERE type = 'one_on_one'`,
    );
    expect(convAfter.rows).toHaveLength(1);
  });

  // ===========================================================================
  // 冷存 COLD_ARCHIVE（R-05：热存 90 天→I3 冷存；recheckAnchor=扫描时刻水位）
  // ===========================================================================

  it('冷存：>90d 按会话分组转 I3 cold_message（JSON-lines 可读回）+同事务热删；近 90d 不动；二次扫描零动作', async () => {
    const convOld = await conversations.ensureConversation('private', 511);
    const convKeep = await conversations.ensureConversation('private', 512);
    await seedBulkMessages(convOld.conversation_id, 3, { ageDays: 91 }); // 冷存面
    await seedBulkMessages(convOld.conversation_id, 2); // 近 90d（不动）
    await seedBulkMessages(convKeep.conversation_id, 1, { ageDays: 120 }); // 另一会话冷存面

    const result = await conversations.archiveColdMessages();
    expect(result.conversations).toBe(2);
    expect(result.messages).toBe(4);
    expect(result.failed).toBe(0);
    expect(new Date(result.cutoff).getTime()).toBeGreaterThan(Date.now() - 91 * DAY_MS - 5_000);

    const artifactRows = await pool.query<{
      id: string;
      kind: string;
      ref_type: string;
      ref_id: string;
    }>(
      `SELECT id, kind, ref_type, ref_id FROM platform.artifacts WHERE kind = 'cold_message' ORDER BY id`,
    );
    expect(artifactRows.rows).toHaveLength(2);
    expect(artifactRows.rows.every((r) => r.ref_type === 'conversation')).toBe(true);

    // 热行删净：convOld 仅剩 2 条新消息；convKeep 0 条
    const hot = await pool.query<{ conversation_id: string; n: number }>(
      `SELECT conversation_id, count(*)::int AS n FROM fulfillment.messages GROUP BY conversation_id`,
    );
    const byConv = new Map(hot.rows.map((r) => [Number(r.conversation_id), r.n]));
    expect(byConv.get(convOld.conversation_id)).toBe(2);
    expect(byConv.get(convKeep.conversation_id)).toBeUndefined();

    // 冷对象可读回：JSON-lines=表头行+消息行（parquet=OSS 换装缝头注）
    const artifact = await artifacts.getArtifact(Number(artifactRows.rows[0]!.id));
    const lines = Buffer.from(artifact.bytes)
      .toString('utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    const header = lines[0] as { conversation_id: number };
    expect(header.conversation_id).toBe(convOld.conversation_id);
    const messageLines = lines.slice(1) as { seq: number; content: string }[];
    expect(messageLines).toHaveLength(3);
    expect(messageLines.map((m) => m.seq)).toEqual([1, 2, 3]);

    // 二次扫描：零冷存面零新对象（水位推进后收敛）
    const again = await conversations.archiveColdMessages();
    expect(again).toMatchObject({ conversations: 0, messages: 0, failed: 0 });
    const artifactCount = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM platform.artifacts WHERE kind = 'cold_message'`,
    );
    expect(artifactCount.rows[0]!.n).toBe(2);
  });

  // ===========================================================================
  // D1 集成：开房成功 → 同事务建 room 会话（join 前置）
  // ===========================================================================

  it('开房即建 room 会话：ROOM_OPEN 真链开房后 conversations(type=room, ref_id=rooms.id) 在位；失败分支无会话', async () => {
    const lawyerId = await seedUserShell(pool, 'd5-conv-open');
    await grantUserRoles(pool, lawyerId, ['lawyer']);
    await seedLawyerProfile(pool, lawyerId, 'PASSED', 'd5-conv-open', undefined, FIRM_ID);
    const slotStart = new Date(Date.now() - 5_000);
    const sessionId = await seedSessionAtRaw(pool, lawyerId, 'CONFIRMED', slotStart, 'text');
    const e1 = await seedPaidEnrollmentRaw(pool, 'session', sessionId, {
      userId: USER_A,
      cash: '60.00',
      points: 0,
      unitPrice: '60.00',
    });
    await seedPaymentOrderRaw(pool, {
      idempotencyKey: enrollmentOrderKey(e1),
      bizId: e1,
      cash: '60.00',
      points: 0,
    });
    await poolSvc.withTransaction((uow) =>
      scheduler.registerJob(uow, {
        jobType: 'ROOM_OPEN',
        refType: 'session',
        refId: sessionId,
        dueAt: slotStart,
      }),
    );
    expect(await scheduler.tick('priority')).toMatchObject({ done: 1 });

    const room = await pool.query<{ id: string }>(
      `SELECT id FROM fulfillment.rooms WHERE session_id = $1`,
      [sessionId],
    );
    const roomId = Number(room.rows[0]!.id);
    const conv = await conversations.getConversation(
      Number(
        (
          await pool.query<{ id: string }>(
            `SELECT id FROM fulfillment.conversations WHERE type = 'room' AND ref_id = $1`,
            [roomId],
          )
        ).rows[0]!.id,
      ),
    );
    expect(conv).toMatchObject({ type: 'room', ref_id: roomId });

    // 开房失败分支（RTC mock 注入失败）：无 room 会话（cancel 分支不建）
    rtc.failNextRoom('mock-rtc-down');
    const lawyer2 = await seedUserShell(pool, 'd5-conv-fail');
    await grantUserRoles(pool, lawyer2, ['lawyer']);
    await seedLawyerProfile(pool, lawyer2, 'PASSED', 'd5-conv-fail', undefined, FIRM_ID);
    const slot2 = new Date(Date.now() - 5_000);
    const session2 = await seedSessionAtRaw(pool, lawyer2, 'CONFIRMED', slot2, 'text');
    const e2 = await seedPaidEnrollmentRaw(pool, 'session', session2, {
      userId: USER_B,
      cash: '60.00',
      points: 0,
      unitPrice: '60.00',
    });
    await seedPaymentOrderRaw(pool, {
      idempotencyKey: enrollmentOrderKey(e2),
      bizId: e2,
      cash: '60.00',
      points: 0,
    });
    await poolSvc.withTransaction((uow) =>
      scheduler.registerJob(uow, {
        jobType: 'ROOM_OPEN',
        refType: 'session',
        refId: session2,
        dueAt: slot2,
      }),
    );
    expect(await scheduler.tick('priority')).toMatchObject({ done: 1 });
    const failedRoom = await pool.query<{ id: string }>(
      `SELECT id FROM fulfillment.rooms WHERE session_id = $1 AND status = 'CANCELLED'`,
      [session2],
    );
    expect(failedRoom.rows).toHaveLength(1);
    const convCount = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM fulfillment.conversations WHERE ref_id = $1`,
      [Number(failedRoom.rows[0]!.id)],
    );
    expect(convCount.rows[0]!.n).toBe(0); // 失败分支零会话
  });

  // ===========================================================================
  // HTTP 面（§5：GET /conversations/{id}/messages + GET /rooms/{id}/notice 薄代理）
  // ===========================================================================

  it('GET /conversations/{id}/messages：Bearer 鉴权+after_seq/limit 透传；无 token 401；路径参非法 400', async () => {
    const conv = await conversations.ensureConversation('private', 513);
    await seedBulkMessages(conv.conversation_id, 5);
    const token = await tokens.signAccessToken({ userId: USER_A, role: 'user', roles: ['user'] });

    const ok = await request(app.getHttpServer())
      .get(`/conversations/${conv.conversation_id}/messages?after_seq=3&limit=2`)
      .set('Authorization', `Bearer ${token}`);
    expect(ok.status).toBe(200);
    expect(ok.body).toHaveLength(2);
    expect(ok.body.map((m: { seq: number }) => m.seq)).toEqual([4, 5]);
    expect(Object.keys(ok.body[0]).sort()).toEqual(
      [
        'content',
        'conversation_id',
        'created_at',
        'mention',
        'message_id',
        'risk_flag',
        'seq',
        'sender_id',
        'sender_role',
        'source_msg_id',
        'type',
      ].sort(),
    );

    const noAuth = await request(app.getHttpServer()).get(
      `/conversations/${conv.conversation_id}/messages`,
    );
    expect(noAuth.status).toBe(401);
    const badParam = await request(app.getHttpServer())
      .get('/conversations/abc/messages')
      .set('Authorization', `Bearer ${token}`);
    expect(badParam.status).toBe(400);
    expect(badParam.body.code).toBe(ErrorCode.InvalidArgument);
    const badLimit = await request(app.getHttpServer())
      .get(`/conversations/${conv.conversation_id}/messages?limit=many`)
      .set('Authorization', `Bearer ${token}`);
    expect(badLimit.status).toBe(400);
  });

  it('GET /rooms/{id}/notice：房间在位→透传 H7 须知内容块；房间缺失 404（先于 H7 查询）；无生效版 404', async () => {
    const roomId = await seedRoomRow('OPEN', 604);
    // 无生效版：H7 面NotFound 透传（404 E_NOT_FOUND）
    const noVersion = await request(app.getHttpServer()).get(`/rooms/${roomId}/notice`);
    expect(noVersion.status).toBe(404);
    expect(noVersion.body.code).toBe(ErrorCode.NotFound);

    // 须知版本落位（H7 免公示通道）→ 200 内容块
    await poolSvc.withTransaction((uow) =>
      rules.createLexiconVersion(uow, {
        ruleKey: 'room_notice',
        version: 1,
        content: {
          title: '咨询前须知',
          paragraphs: ['请提前准备材料'],
          disclosures: ['法律意见由执业律师作出'],
        },
      }),
    );
    ruleCache.clear(); // 免公示通道写路径已失效缓存；显式清确保现行版回源
    const ok = await request(app.getHttpServer()).get(`/rooms/${roomId}/notice`);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({
      ruleKey: 'room_notice',
      version: 1,
      content: { title: '咨询前须知', disclosures: ['法律意见由执业律师作出'] },
    });

    // 房间缺失：薄代理的存在性校验先行（404 不触 H7 面）
    const missingRoom = await request(app.getHttpServer()).get('/rooms/987654/notice');
    expect(missingRoom.status).toBe(404);
    const badParam = await request(app.getHttpServer()).get('/rooms/x/notice');
    expect(badParam.status).toBe(400);
  });
});
