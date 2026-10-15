import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import type { Pool } from 'pg';
import {
  ATTENDANCE_ADJUDICATED_TOPIC,
  AttendanceAdjudicatedPayload,
  CREDIT_EVENT_EMITTED_TOPIC,
  ErrorCode,
  LAWYER_REJECTED_TOPIC,
  LawyerRejectedPayload,
  PRICE_CHANGE_APPROVED_TOPIC,
  PriceChangeApprovedPayload,
  RESTRICTION_ISSUED_TOPIC,
  RestrictionIssuedPayload,
  REVIEW_SUBMITTED_TOPIC,
  ReviewSubmittedPayload,
  SESSION_CANCELLED_TOPIC,
  SessionCancelledPayload,
} from '@ljr/shared';
import { ensureTestDatabase, truncateAll } from '../../infrastructure/testing/db';
import { OutboxRelayService } from '../../infrastructure/outbox/outbox-relay.service';
import { OutboxService } from '../../infrastructure/outbox/outbox.service';
import type { SqlExecutor } from '../../infrastructure/sql';
import { PgPoolService } from '../../infrastructure/sql';
import { IDENTITY_CONFIG, type IdentityConfig } from '../identity/identity.config';
import {
  SLOT_ABUSE_DETECTED_TOPIC,
  type SlotAbuseDetectedPayload,
} from '../schedule/slot-lock.events';
import { RuleCenterService } from '../ops/rule-center.service';
import { CreditRestrictionCache } from './credit.cache';
import { CreditService } from './credit.service';
import { CreditModule } from './credit.module';
import { CREDIT_RULES_KEY, type CreditAction, type EmitCreditEventInput } from './credit.types';

/**
 * G1 信用体系 e2e（需 PG）：§5 契约（GET /credit/mine JWT 本人 + GET /credit/restrictions
 * 入口校验面 + EMIT_CREDIT_EVENT 内部接口幂等键=ref+action）+ §7 R-01（初始 100/下限 0 钳制/
 * 上限开放）+ R-02（行为时快照版本落 rule_version）+ R-03（流水不可变=DB 触发器+应用只 INSERT）
 * + PRD §8.8 全表矩阵（13 分值行 + 2 窗口行）+ 幂等重放（同事件两投：单条流水+分数只动一次）
 * + 限制令（达阈值发行/同 kind 未到期幂等跳过/到期惰性失效可再发行）+ 30 天连续违规窗口
 * （边界 ±10s 钉方向/窗口外重计）+ 30s 活跃限制令缓存适配位（R-W2-8，发行后失效）+ 六事件
 * 消费面（SlotAbuseDetected=真 topic/载荷契约经 slot-lock.events 编译期绑定；其余五件为
 * W3/M2 生产者的合成事件桩，docs/05 §2）。
 *
 * 种子夹具：credit.rules 生效版本经 H7 免公示通道（RuleCenterService.createLexiconVersion）
 * 直建 EFFECTIVE 行——等价「测试直插 PUBLISHED+已生效行」的 H5 先例，但不跨 schema 直写
 * （check-schema-refs 红线）；生产种子随运营配置（R-W2-10，报告标注）。
 * 回填夹具：窗口边界用例直插 credit.credit_events 旧 created_at 行（本 schema 测试夹具）。
 */

const USER = 601;
const LAWYER = 9101;
const LAWYER_PRICE = 9102;
const LAWYER_CACHE = 9103;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const testIdentityConfig = (): IdentityConfig => ({
  phoneDataKey: randomBytes(32),
  phoneBlindPepper: randomBytes(32).toString('hex'),
  jwtSecret: randomBytes(32).toString('hex'),
});

/** credit.rules 种子（分值=§8.8 全表文档语义的测试承载值；生产值由 H7 运营配置，R-W2-10） */
const ACTIONS_SEED: Record<string, unknown> = {
  user_participated: { delta: 2 },
  user_cancel_early: { delta: -5, violation: true },
  user_cancel_late: { delta: -15, violation: true },
  user_absent: { delta: -30, violation: true },
  user_slot_abuse: { delta: -5 },
  lawyer_participated: { delta: 2 },
  lawyer_cancel_24h_plus: { delta: -10, violation: true },
  lawyer_cancel_under_24h: { delta: -30, violation: true },
  lawyer_absent: { delta: -50, violation: true },
  lawyer_reject_timeout: { delta: -5 },
  lawyer_price_up: { delta: -5 },
  lawyer_price_down_le10: { delta: -15 },
  lawyer_price_down_gt10: { delta: -30, restriction: { kind: 'SUSPEND_TAKE_3D', days: 3 } },
  lawyer_price_abuse: { delta: -20, restriction: { kind: 'SUSPEND_TAKE_3D', days: 3 } },
  review_received: { delta: 2 },
};

const RULES_SEED: Record<string, unknown> = {
  violation: {
    window_days: 30,
    threshold: 2,
    restriction_by_owner: {
      user: { kind: 'BAN_JOIN', days: 7 },
      lawyer: { kind: 'SUSPEND_TAKE_7D', days: 7 },
    },
  },
  actions: ACTIONS_SEED,
};

/** PRD §8.8 全表 13 个分值行（另 2 行=多次缺席/连续 2 次取消缺席的窗口触发，窗口用例覆盖） */
const MATRIX_8_8: ReadonlyArray<{ readonly action: CreditAction; readonly delta: number }> = [
  { action: 'user_participated', delta: 2 },
  { action: 'user_cancel_early', delta: -5 },
  { action: 'user_cancel_late', delta: -15 },
  { action: 'user_absent', delta: -30 },
  { action: 'lawyer_participated', delta: 2 },
  { action: 'lawyer_cancel_24h_plus', delta: -10 },
  { action: 'lawyer_cancel_under_24h', delta: -30 },
  { action: 'lawyer_absent', delta: -50 },
  { action: 'lawyer_reject_timeout', delta: -5 },
  { action: 'lawyer_price_up', delta: -5 },
  { action: 'lawyer_price_down_le10', delta: -15 },
  { action: 'lawyer_price_down_gt10', delta: -30 },
  { action: 'lawyer_price_abuse', delta: -20 },
];

describe('G1 信用体系（REST 契约 + R-01~R-03 + §8.8 矩阵 + 窗口/限制令/消费面，需 PG）', () => {
  let pool: Pool;
  let app: INestApplication;
  let credit: CreditService;
  let rules: RuleCenterService;
  let outbox: OutboxService;
  let relay: OutboxRelayService;
  let cache: CreditRestrictionCache;
  let jwt: JwtService;
  let userToken: string;
  let lawyerToken: string;

  const emit = (input: EmitCreditEventInput) => credit.emit(input);

  /** 种子夹具：经 H7 免公示通道直建 EFFECTIVE 版本（等价「直插 PUBLISHED+已生效行」，见文件头注） */
  const seedRules = (
    version: number,
    content: Record<string, unknown>,
    effectiveAt: Date = new Date(Date.now() - 10 * DAY),
  ): Promise<unknown> =>
    app.get(PgPoolService).withTransaction((uow: SqlExecutor) =>
      rules.createLexiconVersion(uow, {
        ruleKey: CREDIT_RULES_KEY,
        version,
        content,
        effectiveAt,
      }),
    );

  /** 回填夹具：直插本 schema 流水行（窗口边界用例；created_at 用 SQL 表达式锚定 DB 时钟） */
  const rawInsertEvent = async (
    ownerType: 'user' | 'lawyer',
    ownerId: number,
    action: string,
    delta: number,
    refId: number,
    ageSql: string,
  ): Promise<void> => {
    await pool.query(
      `INSERT INTO credit.credit_events
         (owner_type, owner_id, action, delta, rule_version, ref_type, ref_id, created_at)
       VALUES ($1, $2, $3, $4, 1, 'fixture', $5, now() - ${ageSql})`,
      [ownerType, ownerId, action, delta, refId],
    );
  };

  const accountScore = async (ownerType: string, ownerId: number): Promise<number | null> => {
    const res = await pool.query<{ score: number }>(
      'SELECT score FROM credit.credit_accounts WHERE owner_type = $1 AND owner_id = $2',
      [ownerType, ownerId],
    );
    return res.rows[0]?.score ?? null;
  };

  const eventRows = async (ownerType: string, ownerId: number) => {
    const res = await pool.query<{
      action: string;
      delta: number;
      rule_version: number;
      ref_type: string;
      ref_id: string;
    }>(
      `SELECT action, delta, rule_version, ref_type, ref_id FROM credit.credit_events
        WHERE owner_type = $1 AND owner_id = $2 ORDER BY id`,
      [ownerType, ownerId],
    );
    return res.rows;
  };

  const restrictionRows = async (ownerType: string, ownerId: number) => {
    const res = await pool.query<{ id: string; kind: string; until: Date; reason: string }>(
      `SELECT id, kind, until, reason FROM credit.credit_restrictions
        WHERE owner_type = $1 AND owner_id = $2 ORDER BY id`,
      [ownerType, ownerId],
    );
    return res.rows;
  };

  const outboxOf = async (topic: string) => {
    const res = await pool.query<{
      topic: string;
      payload: Record<string, unknown>;
      status: string;
    }>('SELECT topic, payload, status FROM platform.outbox WHERE topic = $1 ORDER BY id', [topic]);
    return res.rows;
  };

  /** 合成事件桩：直写 outbox（生产者落位前 docs/05 §2 口径），relay 手动驱动消费 */
  const recordSynthetic = (topic: string, payload: unknown) =>
    outbox.recordOutbox(app.get(PgPoolService), { type: topic, payload });

  /** relay 清空 PENDING（batch=10，多轮兜底；重试轨道行因退避不会被立即重拾） */
  const drain = async (): Promise<void> => {
    for (let i = 0; i < 5; i += 1) {
      const r = await relay.tick();
      if (r.dispatched === 0) break;
    }
  };

  beforeAll(async () => {
    pool = await ensureTestDatabase();
    const moduleRef = await Test.createTestingModule({ imports: [CreditModule] })
      .overrideProvider(IDENTITY_CONFIG)
      .useValue(testIdentityConfig())
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
    credit = app.get(CreditService);
    rules = app.get(RuleCenterService);
    outbox = app.get(OutboxService);
    relay = app.get(OutboxRelayService);
    cache = app.get(CreditRestrictionCache);
    jwt = app.get(JwtService);
    userToken = await jwt.signAsync({ sub: String(USER), role: 'user', roles: ['user'] });
    lawyerToken = await jwt.signAsync({
      sub: String(LAWYER),
      role: 'lawyer',
      roles: ['user', 'lawyer'],
    });
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  beforeEach(async () => {
    await truncateAll(pool);
    await seedRules(1, RULES_SEED);
  });
  afterEach(async () => {
    await truncateAll(pool);
  });

  // ---------- §5 GET /credit/mine：JWT 本人 + R-01 初始 100 + 双角色账户隔离 ----------

  it('GET /credit/mine：未认证 401；本人初始 {score:100, 空事件, 空限制令}（R-01 初始 100，无账户行回显口径）', async () => {
    const anon = await request(app.getHttpServer()).get('/credit/mine');
    expect(anon.status).toBe(401);
    expect(anon.body.code).toBe(ErrorCode.Unauthorized);

    const mine = await request(app.getHttpServer())
      .get('/credit/mine')
      .set('Authorization', `Bearer ${userToken}`);
    expect(mine.status).toBe(200);
    expect(mine.body).toEqual({ score: 100, recent_events: [], restrictions: [] });
  });

  it('GET /credit/mine：同 id 双角色账户隔离（owner_type 分账户）；事件新在前、活跃限制令在列', async () => {
    await emit({
      owner_type: 'lawyer',
      owner_id: LAWYER,
      action: 'lawyer_absent',
      ref_type: 'attendance',
      ref_id: 1,
    });
    await emit({
      owner_type: 'lawyer',
      owner_id: LAWYER,
      action: 'lawyer_price_down_gt10',
      ref_type: 'price_change',
      ref_id: 2,
    });

    const asLawyer = await request(app.getHttpServer())
      .get('/credit/mine')
      .set('Authorization', `Bearer ${lawyerToken}`);
    expect(asLawyer.status).toBe(200);
    expect(asLawyer.body.score).toBe(100 - 50 - 30); // -50 缺席 -30 降价>10%
    expect(asLawyer.body.recent_events.map((e: { action: string }) => e.action)).toEqual([
      'lawyer_price_down_gt10',
      'lawyer_absent',
    ]);
    expect(asLawyer.body.restrictions).toHaveLength(1);
    expect(asLawyer.body.restrictions[0]).toMatchObject({ kind: 'SUSPEND_TAKE_3D' });
    expect(asLawyer.body.recent_events[0]).toMatchObject({
      delta: -30,
      rule_version: 1,
      ref_type: 'price_change',
      ref_id: 2,
    });

    // 同一账号切换 user 激活角色 → owner_type=user 的独立账户（初始 100，未被 lawyer 流水影响）
    const userSideToken = await jwt.signAsync({
      sub: String(LAWYER),
      role: 'user',
      roles: ['user'],
    });
    const asUser = await request(app.getHttpServer())
      .get('/credit/mine')
      .set('Authorization', `Bearer ${userSideToken}`);
    expect(asUser.body).toEqual({ score: 100, recent_events: [], restrictions: [] });
    expect(await accountScore('user', LAWYER)).toBeNull(); // user 侧账户行从未创建
  });

  // ---------- §5 GET /credit/restrictions：入口校验面（活跃行；参数校验 400） ----------

  it('GET /credit/restrictions：活跃行返回、过期行不返回（惰性失效）；owner_type/owner_id 非法 400', async () => {
    expect(
      (await request(app.getHttpServer()).get('/credit/restrictions?owner_type=user&owner_id=601'))
        .body,
    ).toEqual([]);

    await emit({
      owner_type: 'lawyer',
      owner_id: LAWYER_PRICE,
      action: 'lawyer_price_down_gt10',
      ref_type: 'price_change',
      ref_id: 1,
    });
    // 过期行夹具：直插 until 已过的限制令（本 schema 测试夹具；生产行不可变，到期靠惰性过滤）
    await pool.query(
      `INSERT INTO credit.credit_restrictions (owner_type, owner_id, kind, until, reason)
       VALUES ('lawyer', $1, 'BAN_PUBLISH', now() - interval '1 second', 'expired fixture')`,
      [LAWYER_PRICE],
    );

    const res = await request(app.getHttpServer()).get(
      `/credit/restrictions?owner_type=lawyer&owner_id=${LAWYER_PRICE}`,
    );
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({ kind: 'SUSPEND_TAKE_3D' }); // 过期 BAN_PUBLISH 不返回

    const badType = await request(app.getHttpServer()).get(
      `/credit/restrictions?owner_type=admin&owner_id=${LAWYER_PRICE}`,
    );
    expect(badType.status).toBe(400);
    expect(badType.body.code).toBe(ErrorCode.InvalidArgument);
    const badId = await request(app.getHttpServer()).get(
      '/credit/restrictions?owner_type=lawyer&owner_id=abc',
    );
    expect(badId.status).toBe(400);
    expect(badId.body.code).toBe(ErrorCode.InvalidArgument);
  });

  // ---------- PRD §8.8 全表矩阵（EMIT 内部接口；规则表驱动 R-W2-10） ----------

  it('§8.8 全表矩阵：13 分值行 + review_received 经 credit.rules 种子入账，rule_version 落流水', async () => {
    let userSeq = 0;
    let lawyerSeq = 0;
    for (const entry of MATRIX_8_8) {
      const isLawyer = entry.action.startsWith('lawyer_');
      const ownerId = isLawyer ? 9200 + (lawyerSeq += 1) : 6200 + (userSeq += 1);
      const result = await emit({
        owner_type: isLawyer ? 'lawyer' : 'user',
        owner_id: ownerId,
        action: entry.action,
        ref_type: 'matrix',
        ref_id: ownerId,
      });
      expect(result.deduplicated).toBe(false);
      expect(result.delta).toBe(entry.delta);
      expect(result.score).toBe(100 + entry.delta); // 单事件账户快照
      const rows = await eventRows(isLawyer ? 'lawyer' : 'user', ownerId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ action: entry.action, delta: entry.delta, rule_version: 1 });
    }
    // review_received（§8.8 无行，G2「正向加分」联动——规则表驱动承载，双向词汇）
    for (const ownerType of ['user', 'lawyer'] as const) {
      const result = await emit({
        owner_type: ownerType,
        owner_id: 777,
        action: 'review_received',
        ref_type: 'review',
        ref_id: 1,
      });
      expect(result.score).toBe(102);
    }
  });

  // ---------- R-01：初始 100 / 下限 0 钳制 / 上限开放 ----------

  it('R-01 钳制：扣超下限账户钳 0 而流水记录规则原值；上限开放；DB ck_score 兜底 23514', async () => {
    const owner = 6401;
    const deltas = [70, 40, 10, 0]; // 100 → 四次 -30：10-30 触底钳 0
    for (let i = 0; i < 4; i += 1) {
      const r = await emit({
        owner_type: 'user',
        owner_id: owner,
        action: 'user_absent',
        ref_type: 'attendance',
        ref_id: i + 1,
      });
      expect(r.score).toBe(deltas[i]);
    }
    const rows = await eventRows('user', owner);
    expect(rows).toHaveLength(4);
    expect(rows[3]).toMatchObject({ delta: -30 }); // 流水记录规则原值，不受账户钳制影响（R-03 可审计）

    // 上限开放：连续 +分 无上界
    const upOwner = 6402;
    for (const ref of [1, 2, 3]) {
      const r = await emit({
        owner_type: 'user',
        owner_id: upOwner,
        action: 'user_participated',
        ref_type: 'session',
        ref_id: ref,
      });
      expect(r.score).toBe(100 + 2 * ref);
    }

    // DB 兜底层：直插负分账户行 → ck_credit_accounts_score 23514
    await expect(
      pool.query(
        "INSERT INTO credit.credit_accounts (owner_type, owner_id, score) VALUES ('user', 6403, -1)",
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  // ---------- R-02：行为时快照（版本选择 + rule_version 审计位 + 配置缺口显性化） ----------

  it('R-02 行为时快照：多版本按生效时刻命中（未来预约版不命中），rule_version 落流水（规则表驱动证据：改种子即改分值）', async () => {
    await seedRules(
      2,
      {
        ...RULES_SEED,
        actions: { ...ACTIONS_SEED, lawyer_absent: { delta: -40, violation: true } },
      },
      new Date(Date.now() - DAY),
    );
    await seedRules(
      3,
      {
        ...RULES_SEED,
        actions: { ...ACTIONS_SEED, lawyer_absent: { delta: -99, violation: true } },
      },
      new Date(Date.now() + DAY),
    ); // 预约生效

    const owner = 9501;
    await emit({
      owner_type: 'lawyer',
      owner_id: owner,
      action: 'lawyer_absent',
      ref_type: 'attendance',
      ref_id: 1,
    });
    const rows = await eventRows('lawyer', owner);
    expect(rows[0]).toMatchObject({ delta: -40, rule_version: 2 }); // v1/v2 均已生效取最新 v2；v3 未来不命中
  });

  it('R-02 配置缺口显性化：credit.rules 无生效版本 / 生效版缺该 action → InternalError（不静默零分）', async () => {
    await truncateAll(pool); // 清掉 beforeEach 种子（清场 helper，见 testing/db.ts 豁免面注释——非跨 schema 直写路径）
    await expect(
      emit({
        owner_type: 'user',
        owner_id: 6601,
        action: 'user_absent',
        ref_type: 'attendance',
        ref_id: 1,
      }),
    ).rejects.toMatchObject({ code: ErrorCode.InternalError }); // 无任何生效版本

    // 恢复种子但缺 action：生效版无 lawyer_price_up → 同显性化
    await seedRules(1, {
      ...RULES_SEED,
      actions: { user_absent: { delta: -30, violation: true } },
    });
    await expect(
      emit({
        owner_type: 'lawyer',
        owner_id: 6602,
        action: 'lawyer_price_up',
        ref_type: 'price_change',
        ref_id: 1,
      }),
    ).rejects.toMatchObject({ code: ErrorCode.InternalError });
  });

  // ---------- R-03：流水不可变（DB 触发器 + 应用只 INSERT，旧行逐列不变） ----------

  it('R-03 不可变：UPDATE/DELETE credit_events / credit_restrictions → 触发器 P0001；INSERT 通行', async () => {
    await emit({
      owner_type: 'user',
      owner_id: 6701,
      action: 'user_absent',
      ref_type: 'attendance',
      ref_id: 1,
    });
    await expect(
      pool.query('UPDATE credit.credit_events SET delta = 0 WHERE owner_id = 6701'),
    ).rejects.toMatchObject({ code: 'P0001' });
    await expect(
      pool.query('DELETE FROM credit.credit_events WHERE owner_id = 6701'),
    ).rejects.toMatchObject({
      code: 'P0001',
    });
    await pool.query(
      `INSERT INTO credit.credit_restrictions (owner_type, owner_id, kind, until, reason)
       VALUES ('user', 6701, 'BAN_PUBLISH', now() + interval '1 day', 'insert ok')`,
    ); // INSERT 通行（对照组）
    await expect(
      pool.query('UPDATE credit.credit_restrictions SET until = now() WHERE owner_id = 6701'),
    ).rejects.toMatchObject({ code: 'P0001' });
    await expect(
      pool.query('DELETE FROM credit.credit_restrictions WHERE owner_id = 6701'),
    ).rejects.toMatchObject({ code: 'P0001' });
  });

  it('R-03 应用侧：新事件只追加不改旧行（首行全列快照等价）', async () => {
    await emit({
      owner_type: 'user',
      owner_id: 6702,
      action: 'user_absent',
      ref_type: 'attendance',
      ref_id: 1,
    });
    const before = await pool.query(
      'SELECT * FROM credit.credit_events WHERE owner_id = 6702 AND ref_id = 1',
    );
    await emit({
      owner_type: 'user',
      owner_id: 6702,
      action: 'user_absent',
      ref_type: 'attendance',
      ref_id: 2,
    });
    const after = await pool.query(
      'SELECT * FROM credit.credit_events WHERE owner_id = 6702 AND ref_id = 1',
    );
    expect(after.rows).toEqual(before.rows);
    expect(await eventRows('user', 6702)).toHaveLength(2);
  });

  // ---------- 幂等：EMIT 幂等键=ref+action（重放短路且分数不变） ----------

  it('幂等重放：同 (owner,action,ref) 两投 → 单条流水+分数只动一次+单条出箱事件；different ref 正常入账', async () => {
    const owner = 6801;
    const first = await emit({
      owner_type: 'user',
      owner_id: owner,
      action: 'user_absent',
      ref_type: 'attendance',
      ref_id: 555,
    });
    expect(first.deduplicated).toBe(false);
    expect(first.score).toBe(70);

    const replay = await emit({
      owner_type: 'user',
      owner_id: owner,
      action: 'user_absent',
      ref_type: 'attendance',
      ref_id: 555,
    });
    expect(replay.deduplicated).toBe(true);
    expect(replay.event_id).toBeNull();
    expect(replay.delta).toBeNull();
    expect(replay.score).toBe(70); // 分数不变（简报裁决：重放短路且分数不变）
    expect(replay.restrictions_issued).toEqual([]); // 重放不重复触发窗口/限制令

    const distinct = await emit({
      owner_type: 'user',
      owner_id: owner,
      action: 'user_absent',
      ref_type: 'attendance',
      ref_id: 556,
    });
    expect(distinct.deduplicated).toBe(false);
    expect(distinct.score).toBe(40);

    expect(await eventRows('user', owner)).toHaveLength(2);
    const emitted = await outboxOf(CREDIT_EVENT_EMITTED_TOPIC);
    expect(emitted).toHaveLength(2); // 重放不出箱第二条
    expect(emitted[0]?.payload).toMatchObject({
      owner_type: 'user',
      owner_id: owner,
      action: 'user_absent',
      delta: -30,
      score_after: 70,
      rule_version: 1,
      ref_type: 'attendance',
      ref_id: 555,
    });
  });

  // ---------- 限制令：达阈值发行 + 同 kind 未到期幂等跳过 + 到期后可再发行 ----------

  it('限制令：降价>10% → SUSPEND_TAKE_3D（until≈now+3d）+ RestrictionIssued 出箱；同 kind 未到期重复行为幂等跳过；到期后可再发行', async () => {
    const owner = 9701;
    const first = await emit({
      owner_type: 'lawyer',
      owner_id: owner,
      action: 'lawyer_price_down_gt10',
      ref_type: 'price_change',
      ref_id: 1,
    });
    expect(first.restrictions_issued).toHaveLength(1);
    const issued = first.restrictions_issued[0]!;
    expect(issued.kind).toBe('SUSPEND_TAKE_3D');
    expect(Math.abs(new Date(issued.until).getTime() - (Date.now() + 3 * DAY))).toBeLessThan(
      10_000,
    );
    expect(issued.reason).toBe('action:lawyer_price_down_gt10');

    const events = await outboxOf(RESTRICTION_ISSUED_TOPIC);
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({
      owner_type: 'lawyer',
      owner_id: owner,
      kind: 'SUSPEND_TAKE_3D',
    } satisfies Partial<RestrictionIssuedPayload>);

    // 未到期重复行为（新 ref）→ 幂等跳过：不重复发行、不重复出箱（简报裁决口径）
    const again = await emit({
      owner_type: 'lawyer',
      owner_id: owner,
      action: 'lawyer_price_down_gt10',
      ref_type: 'price_change',
      ref_id: 2,
    });
    expect(again.restrictions_issued).toEqual([]);
    expect(await restrictionRows('lawyer', owner)).toHaveLength(1);
    expect(await outboxOf(RESTRICTION_ISSUED_TOPIC)).toHaveLength(1);

    // 到期后同 kind 可再发行：owner 仅有过期同 kind 行（夹具，惰性失效 until<=now 不再拦截）
    const ownerAfterExpiry = 9702;
    await pool.query(
      `INSERT INTO credit.credit_restrictions (owner_type, owner_id, kind, until, reason)
       VALUES ('lawyer', $1, 'SUSPEND_TAKE_3D', now() - interval '1 second', 'expired fixture')`,
      [ownerAfterExpiry],
    );
    const afterExpiry = await emit({
      owner_type: 'lawyer',
      owner_id: ownerAfterExpiry,
      action: 'lawyer_price_down_gt10',
      ref_type: 'price_change',
      ref_id: 1,
    });
    expect(afterExpiry.restrictions_issued).toHaveLength(1);
    expect(await restrictionRows('lawyer', ownerAfterExpiry)).toHaveLength(2); // 过期夹具行 + 新行（不可变不删）
  });

  // ---------- 连续违规 30 天窗口：≥2 → 窗口限制令；边界 ±10s；窗口外重计 ----------

  it('窗口：31 天前缺席出窗不计数（窗口外重计），30 天内第 2 次 → 律师 SUSPEND_TAKE_7D / 用户 BAN_JOIN', async () => {
    // 律师：31 天前缺席（窗口外）→ 现在第一次计数 1 不触发；再一次计数 2 触发 SUSPEND_TAKE_7D（PRD §8.6）
    await rawInsertEvent('lawyer', 9801, 'lawyer_absent', -50, 900, "interval '31 days'");
    const first = await emit({
      owner_type: 'lawyer',
      owner_id: 9801,
      action: 'lawyer_absent',
      ref_type: 'attendance',
      ref_id: 901,
    });
    expect(first.restrictions_issued).toEqual([]); // 窗口计数=1（31 天前事件已出窗）
    const second = await emit({
      owner_type: 'lawyer',
      owner_id: 9801,
      action: 'lawyer_absent',
      ref_type: 'attendance',
      ref_id: 902,
    });
    expect(second.restrictions_issued).toHaveLength(1);
    expect(second.restrictions_issued[0]).toMatchObject({ kind: 'SUSPEND_TAKE_7D' });
    expect(second.restrictions_issued[0]!.reason).toBe('violation_window:30d');
    expect((await outboxOf(RESTRICTION_ISSUED_TOPIC)).length).toBe(1);

    // 用户：同窗口机制 → BAN_JOIN（PRD §8.8 多次缺席 限制发起/参与拼单）
    await emit({
      owner_type: 'user',
      owner_id: 6802,
      action: 'user_cancel_early',
      ref_type: 'session',
      ref_id: 1,
    });
    const userSecond = await emit({
      owner_type: 'user',
      owner_id: 6802,
      action: 'user_absent',
      ref_type: 'attendance',
      ref_id: 2,
    });
    expect(userSecond.restrictions_issued).toHaveLength(1);
    expect(userSecond.restrictions_issued[0]).toMatchObject({ kind: 'BAN_JOIN' });
  });

  it('窗口边界（含端点口径 created_at >= now()-30d，±10s 容差钉方向）：恰在窗口内侧计入、外侧不计', async () => {
    // 内侧：30 天前又 10 秒内（窗口内 10 秒余量）→ 第 2 次触发
    await rawInsertEvent(
      'user',
      6901,
      'user_absent',
      -30,
      801,
      'make_interval(days => 30, secs => -10)',
    );
    const inside = await emit({
      owner_type: 'user',
      owner_id: 6901,
      action: 'user_absent',
      ref_type: 'attendance',
      ref_id: 802,
    });
    expect(inside.restrictions_issued).toHaveLength(1);
    expect(inside.restrictions_issued[0]).toMatchObject({ kind: 'BAN_JOIN' });

    // 外侧：30 天前再早 10 秒（窗口外 10 秒余量）→ 计数 1 不触发
    await rawInsertEvent(
      'user',
      6902,
      'user_absent',
      -30,
      811,
      'make_interval(days => 30, secs => 10)',
    );
    const outside = await emit({
      owner_type: 'user',
      owner_id: 6902,
      action: 'user_absent',
      ref_type: 'attendance',
      ref_id: 812,
    });
    expect(outside.restrictions_issued).toEqual([]);
  });

  // ---------- §8 缓存适配位（R-W2-8）：30s 进程内缓存 + 发行后失效 ----------

  it('缓存适配位：GET 命中窗口内绕过发行的外部直插不可见 → invalidateOwner 后可见；emit 发行后主动失效立即可见', async () => {
    const owner = LAWYER_CACHE;
    const url = `/credit/restrictions?owner_type=lawyer&owner_id=${owner}`;
    expect((await request(app.getHttpServer()).get(url)).body).toEqual([]); // 空数组入缓存（防穿透）

    // 外部写方（绕过 emit，无失效钩子）：TTL 窗口内不可见（缓存位存在性证明）
    await pool.query(
      `INSERT INTO credit.credit_restrictions (owner_type, owner_id, kind, until, reason)
       VALUES ('lawyer', $1, 'BAN_PUBLISH', now() + interval '1 day', 'external fixture')`,
      [owner],
    );
    expect((await request(app.getHttpServer()).get(url)).body).toEqual([]);

    expect(cache.invalidateOwner({ ownerType: 'lawyer', ownerId: owner })).toBe(1);
    const refreshed = await request(app.getHttpServer()).get(url);
    expect(refreshed.body).toHaveLength(1);
    expect(refreshed.body[0]).toMatchObject({ kind: 'BAN_PUBLISH' });

    // emit 发行路径主动失效：新 kind 限制令立即可见（不经 TTL 等待）
    await emit({
      owner_type: 'lawyer',
      owner_id: owner,
      action: 'lawyer_price_down_gt10',
      ref_type: 'price_change',
      ref_id: 1,
    });
    const afterEmit = await request(app.getHttpServer()).get(url);
    expect(afterEmit.body.map((r: { kind: string }) => r.kind).sort()).toEqual([
      'BAN_PUBLISH',
      'SUSPEND_TAKE_3D',
    ]);
  });

  // ---------- 消费面：SlotAbuseDetected（真 topic/载荷契约）+ 五件合成事件桩（W3/M2 生产者） ----------

  it('消费 SlotAbuseDetected（B2 真事件源）：→ user_slot_abuse 入账；载荷缺 user_id → 重试轨道不静默', async () => {
    const payload: SlotAbuseDetectedPayload = {
      user_id: 7001,
      lawyer_id: LAWYER,
      limit: 'PER_LAWYER',
    };
    await recordSynthetic(SLOT_ABUSE_DETECTED_TOPIC, payload);
    await drain();
    const rows = await eventRows('user', 7001);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'user_slot_abuse',
      delta: -5,
      ref_type: 'outbox_event',
    });
    expect((await outboxOf(SLOT_ABUSE_DETECTED_TOPIC))[0]?.status).toBe('SENT');

    // 载荷漂移（缺 user_id）：抛错进重试轨道（PENDING + 退避），不静默丢弃、不落流水
    await recordSynthetic(SLOT_ABUSE_DETECTED_TOPIC, { lawyer_id: LAWYER, limit: 'GLOBAL' });
    const tick = await relay.tick();
    expect(tick.retried).toBe(1);
    const total = await pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM credit.credit_events',
    );
    expect(total.rows[0]?.n).toBe(1); // 仅首条入账
  });

  it('消费 at-least-once 重投：同一事件（同 outbox 行）重驱动 → 幂等键短路：单条流水+分数只动一次', async () => {
    const payload: SlotAbuseDetectedPayload = { user_id: 7002, lawyer_id: LAWYER, limit: 'GLOBAL' };
    await recordSynthetic(SLOT_ABUSE_DETECTED_TOPIC, payload);
    await drain();
    expect(await eventRows('user', 7002)).toHaveLength(1);
    expect(await accountScore('user', 7002)).toBe(95);

    // 同一事件重投（outbox 运维重驱动语义：SENT 行回置 PENDING，relay 再次认领投递）：
    // ref=(outbox_event, 行 id) 不变 → uq_credit_events_idem 短路，分数不变、无新流水
    await pool.query(
      "UPDATE platform.outbox SET status = 'PENDING', next_retry_at = now() WHERE topic = $1",
      [SLOT_ABUSE_DETECTED_TOPIC],
    );
    await drain();
    expect(await eventRows('user', 7002)).toHaveLength(1); // 单条流水
    expect(await accountScore('user', 7002)).toBe(95); // 快照只动一次（简报 at-least-once 用例口径）
    const statuses = (await outboxOf(SLOT_ABUSE_DETECTED_TOPIC)).map((e) => e.status);
    expect(statuses).toEqual(['SENT']); // 重投后仍 SENT（消费幂等）
  });

  it('消费 LawyerRejected（C2B 拒绝/超时桩）→ lawyer_reject_timeout -5', async () => {
    const payload: LawyerRejectedPayload = { group_id: 21, lawyer_id: 7101 };
    await recordSynthetic(LAWYER_REJECTED_TOPIC, payload);
    await drain();
    expect((await eventRows('lawyer', 7101))[0]).toMatchObject({
      action: 'lawyer_reject_timeout',
      delta: -5,
      ref_type: 'group',
      ref_id: '21',
    });
  });

  it('消费 PriceChangeApproved（C6 桩）：三档 kind → 三 action 分值，GT10 档带 SUSPEND_TAKE_3D 限制令', async () => {
    const cases: Array<{
      kind: PriceChangeApprovedPayload['kind'];
      action: string;
      delta: number;
      ref: number;
    }> = [
      { kind: 'PRICE_UP', action: 'lawyer_price_up', delta: -5, ref: 1 },
      { kind: 'PRICE_DOWN_LE10', action: 'lawyer_price_down_le10', delta: -15, ref: 2 },
      { kind: 'PRICE_DOWN_GT10', action: 'lawyer_price_down_gt10', delta: -30, ref: 3 },
    ];
    for (const c of cases) {
      await recordSynthetic(PRICE_CHANGE_APPROVED_TOPIC, {
        lawyer_id: 7201,
        price_change_id: c.ref,
        kind: c.kind,
      } satisfies PriceChangeApprovedPayload);
    }
    await drain();
    const rows = await eventRows('lawyer', 7201);
    expect(rows.map((r) => [r.action, r.delta])).toEqual(cases.map((c) => [c.action, c.delta]));
    expect(await restrictionRows('lawyer', 7201)).toHaveLength(1); // 仅 GT10 档
  });

  it('消费 AttendanceAdjudicated（D3 桩）：normal/absent 入信用；late 无 §8.8 分值行不产生信用事件；owner_type 非法重试', async () => {
    const mk = (over: Partial<AttendanceAdjudicatedPayload>): AttendanceAdjudicatedPayload => ({
      adjudication_id: 1,
      session_id: 31,
      owner_type: 'user',
      owner_id: 7301,
      result: 'normal',
      ...over,
    });
    await recordSynthetic(
      ATTENDANCE_ADJUDICATED_TOPIC,
      mk({ adjudication_id: 1, result: 'normal' }),
    );
    await recordSynthetic(
      ATTENDANCE_ADJUDICATED_TOPIC,
      mk({ adjudication_id: 2, result: 'late', owner_id: 7302 }),
    );
    await recordSynthetic(
      ATTENDANCE_ADJUDICATED_TOPIC,
      mk({ adjudication_id: 3, result: 'absent', owner_id: 7303 }),
    );
    await recordSynthetic(
      ATTENDANCE_ADJUDICATED_TOPIC,
      mk({ adjudication_id: 4, result: 'absent', owner_type: 'admin' as 'user' }),
    );
    await drain();
    expect((await eventRows('user', 7301))[0]).toMatchObject({
      action: 'user_participated',
      delta: 2,
    });
    expect(await eventRows('user', 7302)).toHaveLength(0); // late：§8.5 迟到无信用分值行（报告标注）
    expect((await eventRows('user', 7303))[0]).toMatchObject({ action: 'user_absent', delta: -30 });
    // 非法 owner_type：事件留重试轨道（不静默丢弃）
    const pending = await pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM platform.outbox WHERE topic = $1 AND status = 'PENDING'",
      [ATTENDANCE_ADJUDICATED_TOPIC],
    );
    expect(pending.rows[0]?.n).toBe(1);
  });

  it('消费 SessionCancelled（D4 档位桩）：用户 2h 边界（恰 2h=提前档）、律师 24h 边界（恰 24h=≥24h 档）、platform 跳过', async () => {
    const start = '2026-10-20T20:00:00.000Z';
    const ev = (
      sessionId: number,
      cancelledBy: SessionCancelledPayload['cancelled_by'],
      cancelledAt: string,
      actorId: number | null,
    ): SessionCancelledPayload => ({
      session_id: sessionId,
      cancelled_by: cancelledBy,
      cancelled_by_user_id: actorId,
      cancelled_at: cancelledAt,
      session_start_at: start,
    });
    await recordSynthetic(
      SESSION_CANCELLED_TOPIC,
      ev(41, 'user', '2026-10-20T18:00:00.000Z', 7401),
    ); // 恰提前 2h → early
    await recordSynthetic(
      SESSION_CANCELLED_TOPIC,
      ev(42, 'user', '2026-10-20T18:00:00.001Z', 7402),
    ); // 2h-1ms → late
    await recordSynthetic(
      SESSION_CANCELLED_TOPIC,
      ev(43, 'lawyer', '2026-10-19T20:00:00.000Z', 7403),
    ); // 恰 24h → ≥24h 档
    await recordSynthetic(
      SESSION_CANCELLED_TOPIC,
      ev(44, 'lawyer', '2026-10-19T20:00:00.001Z', 7404),
    ); // 24h-1ms → <24h 档
    await recordSynthetic(
      SESSION_CANCELLED_TOPIC,
      ev(45, 'platform', '2026-10-20T19:00:00.000Z', null),
    ); // platform 无信用影响
    await drain();

    const res = await pool.query<{
      owner_type: string;
      owner_id: string;
      action: string;
      ref_id: string;
    }>('SELECT owner_type, owner_id, action, ref_id FROM credit.credit_events ORDER BY id');
    expect(res.rows.map((r) => [r.ref_id, r.owner_type, r.owner_id, r.action])).toEqual([
      ['41', 'user', '7401', 'user_cancel_early'],
      ['42', 'user', '7402', 'user_cancel_late'],
      ['43', 'lawyer', '7403', 'lawyer_cancel_24h_plus'],
      ['44', 'lawyer', '7404', 'lawyer_cancel_under_24h'],
    ]);
  });

  it('消费 ReviewSubmitted（G2 桩）：direction 定位被评方 owner，review_received 规则表分值', async () => {
    await recordSynthetic(REVIEW_SUBMITTED_TOPIC, {
      session_id: 51,
      direction: 'user_to_lawyer',
      dims: { professional: 5, response: 4, attitude: 5, overall: 5 },
      reviewee_user_id: 7501,
    } satisfies ReviewSubmittedPayload);
    await recordSynthetic(REVIEW_SUBMITTED_TOPIC, {
      session_id: 51,
      direction: 'lawyer_to_user',
      dims: { professional: 4, response: 4, attitude: 4, overall: 4 },
      reviewee_user_id: USER,
    } satisfies ReviewSubmittedPayload);
    await drain();
    expect((await eventRows('lawyer', 7501))[0]).toMatchObject({
      action: 'review_received',
      delta: 2,
      ref_type: 'review',
      ref_id: '51',
    });
    expect((await eventRows('user', USER))[0]).toMatchObject({
      action: 'review_received',
      delta: 2,
    });
  });

  // ---------- EMIT 入参校验（内部接口防线的最小面） ----------

  it('EMIT 入参校验：action 越词汇表 / owner_type 非法 / ref 非正整数 → InvalidArgument', async () => {
    await expect(
      emit({
        owner_type: 'user',
        owner_id: 1,
        action: 'hacker_action' as CreditAction,
        ref_type: 'x',
        ref_id: 1,
      }),
    ).rejects.toMatchObject({ code: ErrorCode.InvalidArgument });
    await expect(
      emit({
        owner_type: 'admin' as 'user',
        owner_id: 1,
        action: 'user_absent',
        ref_type: 'x',
        ref_id: 1,
      }),
    ).rejects.toMatchObject({ code: ErrorCode.InvalidArgument });
    await expect(
      emit({ owner_type: 'user', owner_id: 1, action: 'user_absent', ref_type: 'x', ref_id: 0 }),
    ).rejects.toMatchObject({ code: ErrorCode.InvalidArgument });
  });
});
