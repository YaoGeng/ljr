import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import type { Pool } from 'pg';
import { ErrorCode, PRICE_VERSION_CREATED_TOPIC } from '@ljr/shared';
import { ensureTestDatabase, truncateAll } from '../../infrastructure/testing/db';
import { IDENTITY_CONFIG, type IdentityConfig } from '../identity/identity.config';
import { CurrentPricingCache } from './pricing.cache';
import { IN_GROUP_PROBE } from './pricing.adapters';
import { PricingConfigModule } from './pricing.module';

/**
 * B3 默认价格与1对1价格配置 e2e（需 PG）：§5 REST 契约（PUT 幂等键=lawyer+base_version 乐观并发
 * 409 E_CONFLICT）+ R-01 二选一（HTTP/DB 双层）+ R-02 区间全矩阵过 HTTP（OUT_OF_RANGE 400）+
 * R-03 版本不可变（旧行逐列不变 + DB 触发器禁 UPDATE/DELETE）+ R-04 在团 409 E_IN_GROUP_CHANGE
 * （适配位临时注入 true，不真造团数据——R-W2-9）+ PriceVersionCreated 经 outbox 同事务 +
 * 当前版本 60s 进程内缓存适配位（写后失效）。用例各自独占 lawyer_id（隔离共享缓存实例）。
 */

const LAWYER_A = 9201;
const LAWYER_B = 9202;
const LAWYER_C = 9203;
const LAWYER_D = 9204;
const LAWYER_E = 9205;
const LAWYER_F = 9206;
const LAWYER_G = 9207;
const LAWYER_H = 9208;
const USER_ID = 601;

const VALID_1V1 = {
  text: { per_round: '250.00' },
  voice: { per_15min: '200.00' },
  video: { per_15min: '300.00' },
};

const testIdentityConfig = (): IdentityConfig => ({
  phoneDataKey: randomBytes(32),
  phoneBlindPepper: randomBytes(32).toString('hex'),
  jwtSecret: randomBytes(32).toString('hex'),
});

describe('B3 默认价格与1对1价格配置（REST 契约 + R-01~R-04 + 缓存适配位，需 PG）', () => {
  let pool: Pool;
  let app: INestApplication;
  let cache: CurrentPricingCache;
  let jwt: JwtService;
  let userToken: string;
  const lawyerTokens = new Map<number, string>();

  const mintToken = async (userId: number, role: 'user' | 'lawyer'): Promise<string> =>
    jwt.signAsync({
      sub: String(userId),
      role,
      roles: role === 'lawyer' ? ['user', 'lawyer'] : ['user'],
    });

  const putPricing = (lawyerId: number, body: unknown) =>
    request(app.getHttpServer())
      .put('/lawyer/pricing')
      .set('Authorization', `Bearer ${lawyerTokens.get(lawyerId) ?? ''}`)
      .send(body as object);

  const getCurrent = (lawyerId: number) =>
    request(app.getHttpServer()).get(`/lawyer/${lawyerId}/pricing`);

  const getHistory = (lawyerId: number) =>
    request(app.getHttpServer()).get(`/lawyer/${lawyerId}/pricing/history`);

  /** 直插一个合法版本行（绕过应用层，模拟外部写方/历史数据） */
  const rawInsert = async (
    lawyerId: number,
    version: number,
    over: { perHead?: string | null; sessionTotal?: string | null } = {},
  ): Promise<void> => {
    await pool.query(
      `INSERT INTO pricing.price_versions
         (lawyer_id, version, per_head, session_total, group_size, accept_min, accept_max,
          room_modes, one_on_one_prices)
       VALUES ($1, $2, $3, $4, 5, 3, 8, ARRAY['text','voice']::varchar[], $5::jsonb)`,
      [
        lawyerId,
        version,
        over.perHead ?? '80.00',
        over.sessionTotal ?? null,
        JSON.stringify(VALID_1V1),
      ],
    );
  };

  const versionsOf = async (lawyerId: number): Promise<number[]> => {
    const res = await pool.query<{ version: number }>(
      'SELECT version FROM pricing.price_versions WHERE lawyer_id = $1 ORDER BY version',
      [lawyerId],
    );
    return res.rows.map((r) => r.version);
  };

  const outboxEventsFor = async (lawyerId: number) => {
    const res = await pool.query<{ topic: string; payload: { version?: number }; status: string }>(
      `SELECT topic, payload, status FROM platform.outbox
        WHERE topic = $1 AND payload->>'lawyer_id' = $2 ORDER BY id`,
      [PRICE_VERSION_CREATED_TOPIC, String(lawyerId)],
    );
    return res.rows;
  };

  beforeAll(async () => {
    pool = await ensureTestDatabase();
    const moduleRef = await Test.createTestingModule({ imports: [PricingConfigModule] })
      .overrideProvider(IDENTITY_CONFIG)
      .useValue(testIdentityConfig())
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
    cache = app.get(CurrentPricingCache);
    jwt = app.get(JwtService);
    for (const id of [LAWYER_A, LAWYER_B, LAWYER_C, LAWYER_D, LAWYER_F, LAWYER_G, LAWYER_H]) {
      lawyerTokens.set(id, await mintToken(id, 'lawyer'));
    }
    userToken = await mintToken(USER_ID, 'user');
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  beforeEach(async () => {
    await truncateAll(pool);
  });
  afterEach(async () => {
    await truncateAll(pool);
  });

  // ---------- §5 PUT /lawyer/pricing：鉴权 + 创建首版本 + 事件同事务 ----------

  it('PUT：未认证 401 / user 角色 403 E_ROLE_FORBIDDEN / 律师本人 base_version=0 → version 1 + PriceVersionCreated 同事务出箱', async () => {
    const body = { base_version: 0, per_head: '80.00', one_on_one_prices: VALID_1V1 };
    const anon = await request(app.getHttpServer())
      .put('/lawyer/pricing')
      .send(body as object);
    expect(anon.status).toBe(401);
    expect(anon.body.code).toBe(ErrorCode.Unauthorized);

    const asUser = await request(app.getHttpServer())
      .put('/lawyer/pricing')
      .set('Authorization', `Bearer ${userToken}`)
      .send(body as object);
    expect(asUser.status).toBe(403);
    expect(asUser.body.code).toBe(ErrorCode.RoleForbidden);

    const ok = await putPricing(LAWYER_A, body);
    expect(ok.status).toBe(200);
    expect(ok.body.version).toBe(1);
    expect(ok.body.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(ok.body.pricing).toEqual({
      per_head: '80.00',
      session_total: null,
      group_size: null,
      accept_min: null,
      accept_max: null,
      room_modes: null,
      one_on_one_prices: VALID_1V1,
    });

    const events = await outboxEventsFor(LAWYER_A);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ topic: 'pricing.price_version.created', status: 'PENDING' });
    expect(events[0]!.payload).toEqual({ lawyer_id: LAWYER_A, version: 1 });
    expect(await versionsOf(LAWYER_A)).toEqual([1]);
  });

  // ---------- §5 GET：当前版本 / history / 形状 ----------

  it('GET 当前版本：无版本 → {version:0, pricing:null}（乐观锁读侧=0）；有版本回显全量且 Money 为字符串', async () => {
    const fresh = await getCurrent(LAWYER_A);
    expect(fresh.status).toBe(200);
    expect(fresh.body).toEqual({ version: 0, created_at: null, pricing: null });

    await putPricing(LAWYER_A, {
      base_version: 0,
      session_total: '1200.00',
      group_size: 5,
      accept_min: 3,
      accept_max: 8,
      room_modes: ['video', 'text'],
      one_on_one_prices: VALID_1V1,
    });
    const read = await getCurrent(LAWYER_A);
    expect(read.status).toBe(200);
    expect(read.body.version).toBe(1);
    expect(read.body.pricing).toEqual({
      per_head: null,
      session_total: '1200.00',
      group_size: 5,
      accept_min: 3,
      accept_max: 8,
      room_modes: ['video', 'text'],
      one_on_one_prices: VALID_1V1,
    });
    // Money 字符串纪律：落库 NUMERIC 出站仍为两位小数字符串（防 float 漂移）
    expect(typeof read.body.pricing.session_total).toBe('string');
    expect(typeof read.body.pricing.one_on_one_prices.text.per_round).toBe('string');
  });

  it('GET history：版本列表新在前；无版本 → []；非法路径 id → 400', async () => {
    expect((await getHistory(LAWYER_H)).body).toEqual([]);

    await putPricing(LAWYER_A, {
      base_version: 0,
      per_head: '80.00',
      one_on_one_prices: VALID_1V1,
    });
    await putPricing(LAWYER_A, {
      base_version: 1,
      per_head: '90.00',
      one_on_one_prices: VALID_1V1,
    });
    const history = await getHistory(LAWYER_A);
    expect(history.status).toBe(200);
    expect(history.body.map((h: { version: number }) => h.version)).toEqual([2, 1]);
    for (const item of history.body) {
      expect(item.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(item.pricing.one_on_one_prices).toEqual(VALID_1V1);
    }

    const badId = await request(app.getHttpServer()).get('/lawyer/not-a-number/pricing');
    expect(badId.status).toBe(400);
    expect(badId.body.code).toBe(ErrorCode.InvalidArgument);
  });

  // ---------- 乐观锁：PUT 幂等键=lawyer+base_version（409 E_CONFLICT，H5 先例口径） ----------

  it('base_version 过期 → 409 E_CONFLICT；匹配 → version+1；并发双 PUT 同 base_version 恰一成功', async () => {
    await putPricing(LAWYER_F, {
      base_version: 0,
      per_head: '80.00',
      one_on_one_prices: VALID_1V1,
    });
    const stale = await putPricing(LAWYER_F, {
      base_version: 0,
      per_head: '85.00',
      one_on_one_prices: VALID_1V1,
    });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe(ErrorCode.Conflict);

    const fresh = await putPricing(LAWYER_F, {
      base_version: 1,
      per_head: '85.00',
      one_on_one_prices: VALID_1V1,
    });
    expect(fresh.status).toBe(200);
    expect(fresh.body.version).toBe(2);

    // 真并发：advisory lock 串行化版本分配，恰一成功一 409，无版本号重复
    const [r1, r2] = await Promise.all([
      putPricing(LAWYER_F, { base_version: 2, per_head: '88.00', one_on_one_prices: VALID_1V1 }),
      putPricing(LAWYER_F, { base_version: 2, per_head: '88.00', one_on_one_prices: VALID_1V1 }),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([200, 409]);
    expect(await versionsOf(LAWYER_F)).toEqual([1, 2, 3]);
  });

  // ---------- R-02：区间校验 HTTP 层全矩阵（外拒内收；400 OUT_OF_RANGE） ----------

  it('R-02 全矩阵：文字 49/50/300/301、语音 99/100/500/501、视频 99/100/500/501 过 HTTP（成功链 base_version 顺延）', async () => {
    const withText = (per_round: string) => ({
      base_version: 0,
      per_head: '80.00',
      one_on_one_prices: { ...VALID_1V1, text: { per_round } },
    });
    const withVoice = (per_15min: string) => ({
      base_version: 0,
      per_head: '80.00',
      one_on_one_prices: { ...VALID_1V1, voice: { per_15min } },
    });
    const withVideo = (per_15min: string) => ({
      base_version: 0,
      per_head: '80.00',
      one_on_one_prices: { ...VALID_1V1, video: { per_15min } },
    });

    expect((await putPricing(LAWYER_C, withText('49.00'))).status).toBe(400);
    expect((await putPricing(LAWYER_C, withText('49.00'))).body.code).toBe(
      ErrorCode.PriceOutOfRange,
    );
    expect((await putPricing(LAWYER_C, withText('50.00'))).status).toBe(200);
    const v2 = await putPricing(LAWYER_C, { ...withText('300.00'), base_version: 1 });
    expect(v2.status).toBe(200);
    expect((await putPricing(LAWYER_C, { ...withText('301.00'), base_version: 2 })).status).toBe(
      400,
    );

    expect((await putPricing(LAWYER_C, { ...withVoice('99.00'), base_version: 2 })).status).toBe(
      400,
    );
    expect((await putPricing(LAWYER_C, { ...withVoice('100.00'), base_version: 2 })).status).toBe(
      200,
    );
    expect((await putPricing(LAWYER_C, { ...withVoice('500.00'), base_version: 3 })).status).toBe(
      200,
    );
    expect((await putPricing(LAWYER_C, { ...withVoice('501.00'), base_version: 4 })).status).toBe(
      400,
    );

    expect((await putPricing(LAWYER_C, { ...withVideo('99.00'), base_version: 4 })).status).toBe(
      400,
    );
    expect((await putPricing(LAWYER_C, { ...withVideo('501.00'), base_version: 4 })).status).toBe(
      400,
    );
    expect((await putPricing(LAWYER_C, { ...withVideo('100.00'), base_version: 4 })).status).toBe(
      200,
    );
    expect((await putPricing(LAWYER_C, { ...withVideo('500.00'), base_version: 5 })).status).toBe(
      200,
    );
    expect(await versionsOf(LAWYER_C)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  // ---------- R-01：二选一 HTTP 层 + 形状错误一律 400/422（不漏 500） ----------

  it('R-01 HTTP 层：per_head 与 session_total 同给/都不给 → 400 E_INVALID_ARGUMENT', async () => {
    const both = await putPricing(LAWYER_B, {
      base_version: 0,
      per_head: '80.00',
      session_total: '1200.00',
      one_on_one_prices: VALID_1V1,
    });
    expect(both.status).toBe(400);
    expect(both.body.code).toBe(ErrorCode.InvalidArgument);

    const neither = await putPricing(LAWYER_B, {
      base_version: 0,
      per_head: null,
      session_total: null,
      one_on_one_prices: VALID_1V1,
    });
    expect(neither.status).toBe(400);

    const totalOnly = await putPricing(LAWYER_B, {
      base_version: 0,
      per_head: null,
      session_total: '1200.00',
      one_on_one_prices: VALID_1V1,
    });
    expect(totalOnly.status).toBe(200);
  });

  it('形状错误 → 400/422 显性拒绝（HTTP 解析器元素级校验，无 500 漏出）', async () => {
    const cases: Array<{ body: object; status: number; code: string }> = [
      {
        body: { base_version: 0, per_head: '80.00' },
        status: 400,
        code: ErrorCode.InvalidArgument,
      }, // 缺 one_on_one_prices
      {
        body: { base_version: 0, per_head: '80.00', one_on_one_prices: 'x' },
        status: 400,
        code: ErrorCode.InvalidArgument,
      },
      {
        body: { base_version: 0, per_head: '80.00', one_on_one_prices: { ...VALID_1V1, text: {} } },
        status: 400,
        code: ErrorCode.InvalidArgument,
      }, // 缺 per_round
      {
        body: { base_version: '0', per_head: '80.00', one_on_one_prices: VALID_1V1 },
        status: 400,
        code: ErrorCode.InvalidArgument,
      },
      {
        body: { base_version: 0, per_head: 80, one_on_one_prices: VALID_1V1 },
        status: 422,
        code: ErrorCode.MoneyInvalidFormat,
      }, // number 即拒
      {
        body: {
          base_version: 0,
          per_head: '80.00',
          room_modes: 'text',
          one_on_one_prices: VALID_1V1,
        },
        status: 400,
        code: ErrorCode.InvalidArgument,
      },
      {
        body: {
          base_version: 0,
          per_head: '80.00',
          room_modes: ['text', 'text'],
          one_on_one_prices: VALID_1V1,
        },
        status: 400,
        code: ErrorCode.InvalidArgument,
      },
      {
        body: {
          base_version: 0,
          per_head: '80.00',
          accept_min: 8,
          accept_max: 3,
          one_on_one_prices: VALID_1V1,
        },
        status: 400,
        code: ErrorCode.InvalidArgument,
      },
    ];
    for (const c of cases) {
      const res = await putPricing(LAWYER_B, c.body);
      expect(res.status).toBe(c.status);
      expect(res.body.code).toBe(c.code);
    }
    expect(await versionsOf(LAWYER_B)).toEqual([]);
  });

  // ---------- R-02/R-01 DB CHECK 兜底层（应用层被绕过时仍拦截） ----------

  it('DB 层：二选一/1对1 区间/accept 顺序/room_modes 值域/缺键 → CHECK 违规 23514', async () => {
    const base1v1 = JSON.stringify(VALID_1V1);
    await expect(
      pool.query(
        `INSERT INTO pricing.price_versions (lawyer_id, version, per_head, session_total, one_on_one_prices)
         VALUES ($1, 1, 80.00, 1200.00, $2::jsonb)`,
        [LAWYER_E, base1v1],
      ),
    ).rejects.toMatchObject({ code: '23514' }); // 二选一：同给
    await expect(
      pool.query(
        `INSERT INTO pricing.price_versions (lawyer_id, version, one_on_one_prices)
         VALUES ($1, 1, $2::jsonb)`,
        [LAWYER_E, base1v1],
      ),
    ).rejects.toMatchObject({ code: '23514' }); // 二选一：都不给
    await expect(
      pool.query(
        `INSERT INTO pricing.price_versions (lawyer_id, version, per_head, one_on_one_prices)
         VALUES ($1, 1, 49.00, $2::jsonb)`,
        [LAWYER_E, JSON.stringify({ ...VALID_1V1, text: { per_round: '49.00' } })],
      ),
    ).rejects.toMatchObject({ code: '23514' }); // R-02 DB 兜底层：文字 49 越界走 ck_1v1_range（per_head 本身无 R-02 区间约束，49.00 人头价合法）
    await expect(
      pool.query(
        `INSERT INTO pricing.price_versions (lawyer_id, version, per_head, one_on_one_prices)
         VALUES ($1, 1, 80.00, $2::jsonb)`,
        [LAWYER_E, JSON.stringify({ ...VALID_1V1, video: { per_15min: '501.00' } })],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      pool.query(
        `INSERT INTO pricing.price_versions (lawyer_id, version, per_head, accept_min, accept_max, one_on_one_prices)
         VALUES ($1, 1, 80.00, 8, 3, $2::jsonb)`,
        [LAWYER_E, base1v1],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      pool.query(
        `INSERT INTO pricing.price_versions (lawyer_id, version, per_head, room_modes, one_on_one_prices)
         VALUES ($1, 1, 80.00, ARRAY['fax']::varchar[], $2::jsonb)`,
        [LAWYER_E, base1v1],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      pool.query(
        `INSERT INTO pricing.price_versions (lawyer_id, version, per_head, one_on_one_prices)
         VALUES ($1, 1, 80.00, $2::jsonb)`,
        [LAWYER_E, JSON.stringify({ text: VALID_1V1.text, voice: VALID_1V1.voice })],
      ),
    ).rejects.toMatchObject({ code: '23514' }); // 缺 video 键（CHECK 防 jsonb 缺键静默通行）
    await expect(
      pool.query(
        `INSERT INTO pricing.price_versions (lawyer_id, version, per_head, one_on_one_prices)
         VALUES ($1, 1, 80.00, $2::jsonb)`,
        [LAWYER_E, JSON.stringify(VALID_1V1)],
      ),
    ).resolves.toMatchObject({ rowCount: 1 }); // 合法行可插（对照组）
  });

  // ---------- R-03：版本不可变（旧行逐列不变 + DB 触发器禁 UPDATE/DELETE） ----------

  it('R-03 应用层：修改产生新版本且旧版本行逐列不变（per_head/session_total/group_size/accept/room_modes/1v1/created_at）', async () => {
    await putPricing(LAWYER_D, {
      base_version: 0,
      per_head: '80.00',
      group_size: 5,
      accept_min: 3,
      accept_max: 8,
      room_modes: ['text'],
      one_on_one_prices: VALID_1V1,
    });
    const v1Before = await pool.query(
      'SELECT * FROM pricing.price_versions WHERE lawyer_id = $1 AND version = 1',
      [LAWYER_D],
    );

    await putPricing(LAWYER_D, {
      base_version: 1,
      session_total: '1500.00',
      group_size: 6,
      accept_min: 2,
      accept_max: 10,
      room_modes: ['video'],
      one_on_one_prices: { ...VALID_1V1, text: { per_round: '260.00' } },
    });
    expect(await versionsOf(LAWYER_D)).toEqual([1, 2]);

    const v1After = await pool.query(
      'SELECT * FROM pricing.price_versions WHERE lawyer_id = $1 AND version = 1',
      [LAWYER_D],
    );
    expect(v1After.rows).toEqual(v1Before.rows); // 全列快照等价（R-03 核心断言）
    const v2 = await pool.query(
      'SELECT per_head::text, session_total::text FROM pricing.price_versions WHERE lawyer_id = $1 AND version = 2',
      [LAWYER_D],
    );
    expect(v2.rows[0]).toEqual({ per_head: null, session_total: '1500.00' });
  });

  it('R-03 DB 层：UPDATE/DELETE 版本行 → 触发器拒绝（P0001）；INSERT 通行', async () => {
    await rawInsert(LAWYER_E, 1);
    await expect(
      pool.query('UPDATE pricing.price_versions SET per_head = 99.00 WHERE lawyer_id = $1', [
        LAWYER_E,
      ]),
    ).rejects.toMatchObject({ code: 'P0001' });
    await expect(
      pool.query('DELETE FROM pricing.price_versions WHERE lawyer_id = $1', [LAWYER_E]),
    ).rejects.toMatchObject({ code: 'P0001' });
    await rawInsert(LAWYER_E, 2); // 新版本照常插入
    expect(await versionsOf(LAWYER_E)).toEqual([1, 2]);
  });

  // ---------- R-04：在团修改 → 409 E_IN_GROUP_CHANGE（R-W2-9 适配位临时注入 true） ----------

  it('R-04：isInGroup=true（临时注入）→ PUT 409 E_IN_GROUP_CHANGE；不落新版本、不出箱事件', async () => {
    await putPricing(LAWYER_H, {
      base_version: 0,
      per_head: '80.00',
      one_on_one_prices: VALID_1V1,
    });
    const probe = app.get<{ isInGroup: (id: number) => Promise<boolean> }>(IN_GROUP_PROBE);
    const original = probe.isInGroup.bind(probe);
    probe.isInGroup = async () => true; // R-W2-9：C1/C2 W3 接线转真前，钉住在团分支
    try {
      const res = await putPricing(LAWYER_H, {
        base_version: 1,
        per_head: '90.00',
        one_on_one_prices: VALID_1V1,
      });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe(ErrorCode.InGroupChange);
    } finally {
      probe.isInGroup = original;
    }
    expect(await versionsOf(LAWYER_H)).toEqual([1]);
    expect(await outboxEventsFor(LAWYER_H)).toHaveLength(1); // 仅 v1 那条，409 路径无新事件
  });

  // ---------- §8/R-W2-8：当前版本 60s 进程内缓存适配位（写后失效 + TTL 兜底语义） ----------

  it('缓存适配位：GET 命中窗口内外部直插新版本仍读旧值 → invalidateLawyer 后可见；HTTP PUT 后写失效立即可见', async () => {
    const fresh = await getCurrent(LAWYER_G); // 空视图入缓存
    expect(fresh.body).toEqual({ version: 0, created_at: null, pricing: null });

    await rawInsert(LAWYER_G, 1); // 外部写方（绕过应用层）
    const stale = await getCurrent(LAWYER_G);
    expect(stale.body.version).toBe(0); // TTL 窗口内旧值（缓存位在路径上的存在性证明）

    expect(cache.invalidateLawyer(LAWYER_G)).toBe(1); // 事件消费失效位（W3 PriceVersionCreated 消费端同口径）
    const refreshed = await getCurrent(LAWYER_G);
    expect(refreshed.body.version).toBe(1);

    // HTTP PUT → 写后失效 → 立即读到新版本（不经 TTL 等待）
    await putPricing(LAWYER_G, {
      base_version: 1,
      per_head: '95.00',
      one_on_one_prices: VALID_1V1,
    });
    expect((await getCurrent(LAWYER_G)).body.version).toBe(2);
  });
});
