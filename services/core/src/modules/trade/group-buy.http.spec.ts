import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Pool } from 'pg';
import { ErrorCode } from '@ljr/shared';
import { ensureTestDatabase, truncateAll } from '../../infrastructure/testing/db';
import { PgPoolService } from '../../infrastructure/sql';
import { SpecialtyConfigService } from '../agent-assist/specialty.service';
import { SpecialtyKnowledgeModule } from '../agent-assist/specialty.module';
import { CreditRestrictionCache } from '../credit/credit.cache';
import { CreditService } from '../credit/credit.service';
import { CREDIT_RULES_KEY } from '../credit/credit.types';
import { IDENTITY_CONFIG, type IdentityConfig } from '../identity/identity.config';
import { seedLawyerProfile } from '../identity/lawyer-fixture';
import { IdentityTokenService } from '../identity/identity.token.service';
import { RuleCenterService } from '../ops/rule-center.service';
import { PricingConfigService } from '../pricing/pricing.service';
import { GroupBuyListCache } from './group-buy.cache';
import { TradeModule } from './trade.module';

/**
 * C2 REST 契约（§5 表逐字 + Task 5 简报）：
 *   POST /group-buys {lawyer_id, specialty, slot_start, sub_min, sub_max, question_tags, deadline?}
 *     → {group_buy, share_price, payment_order}；409 SLOT_TAKEN/E_GROUP_BUY_DUP_KEY、403 RESTRICTED。
 *   GET /group-buys?specialty= 列表（已加入数/倒计时 deadline/分摊额；公开无鉴权，沿 C1 列表口径）。
 *   POST /group-buys/{id}/cancel → {status}；POST /group-buys/{id}/recreate → 新任务 ID。
 * 鉴权：发起/取消/重发起 @RequireRole('user')+@CurrentIdentity（发起人=用户，lawyer_id 取 body）；
 * GET 列表公开（§5 鉴权「否」）。E3 GET /specialty/question-tree?key= 消费面校验（引导页数据源）。
 * 错误体形态：infrastructure AppHttpExceptionFilter {code, message}。
 */

const HOUR = 3_600_000;

const testIdentityConfig = (): IdentityConfig => ({
  phoneDataKey: randomBytes(32),
  phoneBlindPepper: randomBytes(32).toString('hex'),
  jwtSecret: randomBytes(32).toString('hex'),
});

const RULES_SEED_BAN_JOIN: Record<string, unknown> = {
  violation: {
    window_days: 30,
    threshold: 2,
    restriction_by_owner: {
      user: { kind: 'BAN_JOIN', days: 7 },
      lawyer: { kind: 'SUSPEND_TAKE_7D', days: 7 },
    },
  },
  actions: {
    user_absent: { delta: -50, restriction: { kind: 'BAN_JOIN', days: 7 }, violation: true },
  },
};

const TREE_V1 = {
  root: 'q1',
  nodes: [
    { id: 'q1', label: '争议类型', children: ['q2', 'q3'] },
    { id: 'q2', label: '拖欠工资', children: [] },
    { id: 'q3', label: '违法解除', children: [] },
  ],
};

describe('C2 HTTP 契约（§5，需 PG）', () => {
  let pool: Pool;
  let app: INestApplication;
  let credit: CreditService;
  let rules: RuleCenterService;
  let creditCache: CreditRestrictionCache;
  let listCache: GroupBuyListCache;
  let tokens: IdentityTokenService;
  let specialty: SpecialtyConfigService;

  const userToken = (userId: number): Promise<string> =>
    tokens.signAccessToken({ userId, role: 'user', roles: ['user'] });
  const lawyerToken = (userId: number): Promise<string> =>
    tokens.signAccessToken({ userId, role: 'lawyer', roles: ['lawyer'] });

  const postGroupBuy = (token: string | null, body: Record<string, unknown>) => {
    const req = request(app.getHttpServer())
      .post('/group-buys')
      .set('Content-Type', 'application/json');
    if (token !== null) req.set('Authorization', `Bearer ${token}`);
    return req.send(body);
  };

  const bodyOf = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    lawyer_id: 9401,
    specialty: 'labor_arbitration',
    slot_start: new Date(Date.now() + 25 * HOUR).toISOString(),
    sub_min: 3,
    sub_max: 6,
    question_tags: ['劳动仲裁时效'],
    ...over,
  });

  beforeAll(async () => {
    pool = await ensureTestDatabase();
    const moduleRef = await Test.createTestingModule({
      imports: [TradeModule, SpecialtyKnowledgeModule],
    })
      .overrideProvider(IDENTITY_CONFIG)
      .useValue(testIdentityConfig())
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
    credit = app.get(CreditService);
    rules = app.get(RuleCenterService);
    creditCache = app.get(CreditRestrictionCache);
    listCache = app.get(GroupBuyListCache);
    tokens = app.get(IdentityTokenService);
    specialty = app.get(SpecialtyConfigService);
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });
  beforeEach(async () => {
    await truncateAll(pool);
    creditCache.invalidateOwner({ ownerType: 'user', ownerId: 9501 });
  });
  afterEach(async () => {
    await truncateAll(pool);
  });

  it('POST /group-buys：{group_buy, share_price, payment_order} 三键出参；幂等重放同单；同键异载荷 409；lawyer token 403 / 无 token 401（§5 鉴权列）', async () => {
    const app1 = app.get(PricingConfigService);
    await app1.putPricing(9401, {
      base_version: 0,
      per_head: null,
      session_total: '100.00',
      group_size: null,
      accept_min: 2,
      accept_max: 8,
      room_modes: null,
      one_on_one_prices: {
        text: { per_round: '50.00' },
        voice: { per_15min: '100.00' },
        video: { per_15min: '100.00' },
      },
    });
    const token = await userToken(9501);
    const body = bodyOf(); // 同键=user+slot_start：重放/异载荷用例必须复用同一 slot_start
    const ok = await postGroupBuy(token, body);
    expect(ok.status).toBe(201);
    expect(Object.keys(ok.body).sort()).toEqual(['group_buy', 'payment_order', 'share_price']);
    expect(ok.body.group_buy.status).toBe('PUBLISHED');
    expect(ok.body.share_price).toBe('33.33'); // 100.00÷3 亚半 HALF_UP
    expect(ok.body.payment_order.biz_type).toBe('enroll');

    const replay = await postGroupBuy(token, body);
    expect(replay.status).toBe(201);
    expect(replay.body.group_buy.id).toBe(ok.body.group_buy.id); // 幂等键=user+slot_start

    const conflict = await postGroupBuy(token, { ...body, sub_min: 4 });
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe(ErrorCode.GroupBuyDuplicateKey);

    const asLawyer = await postGroupBuy(await lawyerToken(9401), bodyOf({ lawyer_id: 9402 }));
    expect(asLawyer.status).toBe(403);
    expect(asLawyer.body.code).toBe(ErrorCode.RoleForbidden); // 守卫双向：lawyer token 打用户面

    const anon = await postGroupBuy(null, bodyOf());
    expect(anon.status).toBe(401);
    expect(anon.body.code).toBe(ErrorCode.Unauthorized);
  });

  it('POST /group-buys：入参校验 400（子范围越界/标签形态/缺律师接受范围 E_ACCEPT_RANGE_UNSET）；RESTRICTED 403（BAN_JOIN）', async () => {
    const pricing = app.get(PricingConfigService);
    const seed = (lawyerId: number, acceptMin: number | null, acceptMax: number | null) =>
      pricing.putPricing(lawyerId, {
        base_version: 0,
        per_head: null,
        session_total: '100.00',
        group_size: null,
        accept_min: acceptMin,
        accept_max: acceptMax,
        room_modes: null,
        one_on_one_prices: {
          text: { per_round: '50.00' },
          voice: { per_15min: '100.00' },
          video: { per_15min: '100.00' },
        },
      });
    const token = await userToken(9501);
    await seed(9401, 3, 8);

    const outOfRange = await postGroupBuy(token, bodyOf({ sub_min: 2, sub_max: 6 })); // min-1
    expect(outOfRange.status).toBe(400);
    expect(outOfRange.body.code).toBe(ErrorCode.PriceOutOfRange);

    const badTags = await postGroupBuy(token, bodyOf({ question_tags: 'not-array' }));
    expect(badTags.status).toBe(400);
    expect(badTags.body.code).toBe(ErrorCode.InvalidArgument);

    // 律师未配置接受范围 → 400 E_ACCEPT_RANGE_UNSET（⚠W3-5）
    await seed(9402, null, null);
    const unset = await postGroupBuy(token, bodyOf({ lawyer_id: 9402 }));
    expect(unset.status).toBe(400);
    expect(unset.body.code).toBe(ErrorCode.AcceptRangeUnset);

    // BAN_JOIN → 403 E_RESTRICTED
    const pg = app.get(PgPoolService);
    await pg.withTransaction((uow) =>
      rules.createLexiconVersion(uow, {
        ruleKey: CREDIT_RULES_KEY,
        version: 1,
        content: RULES_SEED_BAN_JOIN,
        effectiveAt: new Date(Date.now() - 10 * HOUR),
      }),
    );
    await credit.emit({
      owner_type: 'user',
      owner_id: 9501,
      action: 'user_absent',
      ref_type: 'attendance',
      ref_id: 1,
    });
    const restricted = await postGroupBuy(token, bodyOf({ lawyer_id: 9401 }));
    expect(restricted.status).toBe(403);
    expect(restricted.body.code).toBe(ErrorCode.Restricted);
  });

  it('GET /group-buys?specialty=：公开无鉴权；仅 PUBLISHED+PASSED 律师；joined=null 桩+deadline/share_price 出参；30s 缓存适配位（新建失效）', async () => {
    await seedLawyerProfile(pool, 9601, 'PASSED', 't5-http-passed');
    await seedLawyerProfile(pool, 9602, 'SUBMITTED', 't5-http-submitted');
    const pricing = app.get(PricingConfigService);
    for (const id of [9601, 9602]) {
      await pricing.putPricing(id, {
        base_version: 0,
        per_head: null,
        session_total: '90.00',
        group_size: null,
        accept_min: 2,
        accept_max: 8,
        room_modes: null,
        one_on_one_prices: {
          text: { per_round: '50.00' },
          voice: { per_15min: '100.00' },
          video: { per_15min: '100.00' },
        },
      });
    }
    const token = await userToken(9701);
    await postGroupBuy(token, { ...bodyOf(), lawyer_id: 9601, sub_min: 2, sub_max: 4 });
    await postGroupBuy(
      await userToken(9702),
      bodyOf({ lawyer_id: 9602, slot_start: new Date(Date.now() + 26 * HOUR).toISOString() }),
    );

    const list1 = await request(app.getHttpServer()).get('/group-buys?specialty=labor_arbitration');
    expect(list1.status).toBe(200);
    expect(list1.body.map((g: { lawyer_id: number }) => g.lawyer_id)).toEqual([9601]); // 仅 PASSED
    expect(list1.body[0]!.joined).toBeNull(); // 桩：C3=T7
    expect(list1.body[0]!.share_price).toBe('45.00'); // 分摊额（90.00÷2）
    expect(typeof list1.body[0]!.deadline).toBe('string'); // 倒计时=客户端算+服务端 deadline
    expect(listCache.size).toBe(1); // 缓存适配位命中载体

    const other = await request(app.getHttpServer()).get('/group-buys?specialty=contract');
    expect(other.body).toEqual([]); // specialty 过滤真实生效
  });

  it('GET /group-buys?specialty= 超长 400：查询参上界 32=列宽对齐（T11.5-① 收口；>32 原得空集，边界 32 放行）', async () => {
    const tooLong = await request(app.getHttpServer()).get(
      `/group-buys?specialty=${'a'.repeat(33)}`,
    );
    expect(tooLong.status).toBe(400);
    expect(tooLong.body.code).toBe(ErrorCode.InvalidArgument);

    const boundary = await request(app.getHttpServer()).get(
      `/group-buys?specialty=${'a'.repeat(32)}`,
    );
    expect(boundary.status).toBe(200); // 边界长度放行，走过滤空集语义
    expect(boundary.body).toEqual([]);
  });

  it('POST /group-buys/{id}/cancel：{status:"EXPIRED"}；非本人 404；无 token 401', async () => {
    const pricing = app.get(PricingConfigService);
    await pricing.putPricing(9401, {
      base_version: 0,
      per_head: null,
      session_total: '100.00',
      group_size: null,
      accept_min: 2,
      accept_max: 8,
      room_modes: null,
      one_on_one_prices: {
        text: { per_round: '50.00' },
        voice: { per_15min: '100.00' },
        video: { per_15min: '100.00' },
      },
    });
    const token = await userToken(9501);
    const created = await postGroupBuy(token, bodyOf());
    const gbId = created.body.group_buy.id as number;

    const cancelled = await request(app.getHttpServer())
      .post(`/group-buys/${gbId}/cancel`)
      .set('Authorization', `Bearer ${token}`);
    expect(cancelled.status).toBe(201);
    expect(cancelled.body).toEqual({ status: 'EXPIRED' }); // §5 出参 {status}

    const again = await request(app.getHttpServer())
      .post(`/group-buys/${gbId}/cancel`)
      .set('Authorization', `Bearer ${token}`);
    expect(again.status).toBe(409); // 非 PUBLISHED 不可取消

    const notMine = await request(app.getHttpServer())
      .post(`/group-buys/${gbId}/cancel`)
      .set('Authorization', `Bearer ${await userToken(9502)}`);
    expect(notMine.status).toBe(404);

    const anon = await request(app.getHttpServer()).post(`/group-buys/${gbId}/cancel`);
    expect(anon.status).toBe(401);
  });

  it('POST /group-buys/{id}/recreate：{group_buy_id} 新任务 ID；同 source 重放幂等；无 token 401', async () => {
    const pricing = app.get(PricingConfigService);
    await pricing.putPricing(9401, {
      base_version: 0,
      per_head: null,
      session_total: '100.00',
      group_size: null,
      accept_min: 2,
      accept_max: 8,
      room_modes: null,
      one_on_one_prices: {
        text: { per_round: '50.00' },
        voice: { per_15min: '100.00' },
        video: { per_15min: '100.00' },
      },
    });
    const token = await userToken(9501);
    const created = await postGroupBuy(token, bodyOf());
    const gbId = created.body.group_buy.id as number;
    await request(app.getHttpServer())
      .post(`/group-buys/${gbId}/cancel`)
      .set('Authorization', `Bearer ${token}`);

    const recreated = await request(app.getHttpServer())
      .post(`/group-buys/${gbId}/recreate`)
      .set('Authorization', `Bearer ${token}`);
    expect(recreated.status).toBe(201);
    expect(typeof recreated.body.group_buy_id).toBe('number');
    expect(recreated.body.group_buy_id).not.toBe(gbId);

    const replay = await request(app.getHttpServer())
      .post(`/group-buys/${gbId}/recreate`)
      .set('Authorization', `Bearer ${token}`);
    expect(replay.body.group_buy_id).toBe(recreated.body.group_buy_id); // 幂等键=source_id

    const anon = await request(app.getHttpServer()).post(`/group-buys/${gbId}/recreate`);
    expect(anon.status).toBe(401);
  });

  it('E3 消费面校验：GET /specialty/question-tree?key=labor_arbitration → 树+version（C2 引导页数据源）；未配置 404；缺 key 400', async () => {
    const missing = await request(app.getHttpServer()).get(
      '/specialty/question-tree?key=labor_arbitration',
    );
    expect(missing.status).toBe(404);

    await specialty.putQuestionTree({
      specialty: 'labor_arbitration',
      tree: TREE_V1,
      baseVersion: 0,
    });
    const ok = await request(app.getHttpServer()).get(
      '/specialty/question-tree?key=labor_arbitration',
    );
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ specialty: 'labor_arbitration', version: 1, questionTree: TREE_V1 });

    const noKey = await request(app.getHttpServer()).get('/specialty/question-tree');
    expect(noKey.status).toBe(400);
  });
});
