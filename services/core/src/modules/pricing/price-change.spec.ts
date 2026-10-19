import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import type { Pool } from 'pg';
import {
  ErrorCode,
  POINTS_GRANTED_TOPIC,
  PRICE_CHANGE_APPROVED_TOPIC,
  PRICE_CHANGE_REJECTED_TOPIC,
  PRICE_COUPON_INSTRUCTED_TOPIC,
  PRICE_REVOKED_TOPIC,
  PRICE_VERSION_CREATED_TOPIC,
} from '@ljr/shared';
import { ensureTestDatabase, truncateAll } from '../../infrastructure/testing/db';
import {
  MockChannelAdapter,
  PAYMENT_CHANNEL_ADAPTERS,
  type PaymentChannelAdapter,
} from '../payment/payment.channels';
import {
  PAYMENT_CONFIG,
  PAYMENT_SWITCH_WINDOW_MS_DEFAULT,
  type PaymentConfig,
} from '../payment/payment.config';
import { FIRM_MERCHANT_CONFIG, type FirmMerchantConfig } from '../payment/firm-merchant.config';
import { IDENTITY_CONFIG, type IdentityConfig } from '../identity/identity.config';
import { NotifyDispatcherService } from '../notify/notify-dispatcher.service';
import { NotifyTemplateService } from '../notify/notify-template.service';
import { PointsService } from '../benefits/points.service';
import { deleteTemplateRaw, listNotificationsRaw, seedTemplateRaw } from '../notify/notify-fixture';
import { PricingConfigService } from './pricing.service';
import {
  seedGroupBuyRaw,
  type SeedPaidEnrollmentOptions,
  seedSessionRaw,
} from '../trade/trade-fixture';
import { PricingChangeModule } from './price-change.module';
import { PriceChangePatrolService } from './price-change.patrol';
import { seedCompSnapshotRaw, seedPriceHistoryRaw } from './price-change.fixture';

/**
 * C6 改价与补偿 e2e（§4 引擎判定 + §5 接口契约 + §7 R-01~R-06 + §9 测试矩阵 + §10 验收清单；
 * 需 PG）。覆盖：
 *   - 三档全矩阵（10.0% 边界恰档）与在团判定（C1/C2 导出 hasActiveSessions/hasActiveGroupBuys）；
 *   - 频率 R-03 DB 滑窗（⚠W3-7）：30 天第 4 次 → 审批（无论方向/在团）；429 FREQ_EXCEEDED
 *     契约位保留不用（§5 表内档位、PRD §8.2 无滥用 429 明确定义——本 spec 以行为钉住：超限
 *     是 PENDING_APPROVAL 200 而非 429）；
 *   - 审批①人工兜底（approval_source=MANUAL）：approve true/false 双向 + 幂等键=history +
 *     版本链漂移 409；
 *   - 撤销 R-04：24h 边界（含端点）/恢复上一版本经 B3/PriceRevoked/通知受影响用户/幂等；
 *   - 补偿 R-05/D17：分母=paid_amount 全额（cash+points/100），F4 真链 grant（COMPENSATION）
 *     + 券指令事件（F4 ②全量消费位，本批断言出箱）；
 *   - I1 三档话术真消费（V4 seed 模板，通知 QUEUED→processPending→SENT）。
 * 会话/拼团/报名夹具直插（被测=C6 消费面；trade 侧行为归各自 spec 持有）。
 */

const LAWYER_UP = 9401; // 在团涨价：EFFECTED + 信用事件 + 锁价话术
const LAWYER_LE10 = 9402; // 在团降价≤10%（恰 10.0%）：PENDING→approve→补偿真链
const LAWYER_GT10 = 9403; // 在团降价>10%：PENDING→approve→补偿+券指令
const LAWYER_FREE = 9404; // 不在团降价：自由改价 EFFECTED（无惩罚无事件）
const LAWYER_REVOKE = 9405; // 撤销链路（approve 后 24h 内/超窗/幂等）
const LAWYER_FREQ = 9406; // 频率滑窗
const LAWYER_STALE = 9407; // 审批时版本链漂移
const LAWYER_ISOLATED = 9408; // 在团判定负例（仅终态场次）
const LAWYER_AGGR = 9409; // F-1 同用户多笔 PAID 聚合
const LAWYER_DUP = 9410; // F-3 幂等键=lawyer+new_version（PENDING 面）
const LAWYER_REV2 = 9411; // F-4 撤销 head 复核
const LAWYER_SNAP = 9412; // #39 快照持久化（M2-W2 T6）
const USER_A = 701;
const USER_B = 702;
const USER_C = 703;

/** 巡检⑤窗口龄（>24h——#39 回归用例的候选窗注入） */
const AGO_30H_MS = 30 * 3_600_000;

const VALID_1V1 = {
  text: { per_round: '250.00' },
  voice: { per_15min: '200.00' },
  video: { per_15min: '300.00' },
};

function testPaymentConfig(): PaymentConfig {
  return {
    primary: { channel: 'wechat_ecom', merchantId: 'mock-wechat-mch', secret: 'test-secret-w' },
    backup: { channel: 'alipay', merchantId: 'mock-alipay-mch', secret: 'test-secret-a' },
    switchWindowMs: PAYMENT_SWITCH_WINDOW_MS_DEFAULT,
  };
}

const MERCHANT_CONFIG: FirmMerchantConfig = { depositAmount: '500.00', reverifyDays: 365 };

const testIdentityConfig = (): IdentityConfig => ({
  phoneDataKey: randomBytes(32),
  phoneBlindPepper: randomBytes(32).toString('hex'),
  jwtSecret: randomBytes(32).toString('hex'),
});

describe('C6 改价与补偿（§4/§5/§7/§9/§10，需 PG）', () => {
  let pool: Pool;
  let app: INestApplication;
  let jwt: JwtService;
  let dispatcher: NotifyDispatcherService;
  let templates: NotifyTemplateService;
  let b3: PricingConfigService;
  let points: PointsService;
  const lawyerTokens = new Map<number, string>();
  /** G-A 同批接线（TODO(H1-W3-T10) 收尾）：DB 预置 admin 形态 token（roles 持 admin 旗标） */
  let adminToken: string;
  let slotSeq = 0;

  const mintToken = async (userId: number, role: 'user' | 'lawyer'): Promise<string> =>
    jwt.signAsync({
      sub: String(userId),
      role,
      roles: role === 'lawyer' ? ['user', 'lawyer'] : ['user'],
    });

  const postChange = (lawyerId: number, body: unknown) =>
    request(app.getHttpServer())
      .post('/lawyer/pricing/change')
      .set('Authorization', `Bearer ${lawyerTokens.get(lawyerId) ?? ''}`)
      .send({ new_version_draft: body } as object);

  const approve = (historyId: number, body: unknown) =>
    request(app.getHttpServer())
      .post(`/pricing/change/${historyId}/approve`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send(body as object);

  const revoke = (historyId: number, token?: string) =>
    request(app.getHttpServer())
      .post(`/pricing/change/${historyId}/revoke`)
      .set('Authorization', `Bearer ${token ?? lawyerTokens.get(LAWYER_REVOKE) ?? ''}`);

  const histories = (lawyerId: number) =>
    request(app.getHttpServer()).get(`/pricing/histories?lawyer_id=${lawyerId}`);

  // ---------- 夹具：B3 版本行 / trade 场次·拼团·报名 / 时间旅行 ----------

  const seedVersion = async (lawyerId: number, perHead: string, version = 1): Promise<void> => {
    await pool.query(
      `INSERT INTO pricing.price_versions
         (lawyer_id, version, per_head, session_total, group_size, accept_min, accept_max,
          room_modes, one_on_one_prices)
       VALUES ($1, $2, $3, NULL, 5, 3, 8, ARRAY['text']::varchar[], $4::jsonb)`,
      [lawyerId, version, perHead, JSON.stringify(VALID_1V1)],
    );
  };

  const seedSession = async (
    lawyerId: number,
    status: string,
    userId?: number,
    paid: SeedPaidEnrollmentOptions = { userId: 0, cash: '100.00', points: 0, unitPrice: '100.00' },
  ): Promise<number> => {
    slotSeq += 1;
    return seedSessionRaw(
      pool,
      lawyerId,
      status,
      slotSeq,
      userId === undefined ? undefined : { ...paid, userId },
    );
  };

  const seedGroupBuy = (lawyerId: number, status: string): Promise<number> =>
    seedGroupBuyRaw(pool, lawyerId, status);

  const timeTravel = async (lawyerId: number, interval: string): Promise<void> => {
    await pool.query(
      `UPDATE pricing.pricing_histories SET created_at = created_at - ($1::text)::interval
        WHERE lawyer_id = $2`,
      [interval, lawyerId],
    );
  };

  const histRows = async (lawyerId: number) => {
    const res = await pool.query<Record<string, unknown>>(
      `SELECT * FROM pricing.pricing_histories WHERE lawyer_id = $1 ORDER BY id`,
      [lawyerId],
    );
    return res.rows;
  };

  const versionsOf = async (lawyerId: number): Promise<number[]> => {
    const res = await pool.query<{ version: number; per_head: string | null }>(
      `SELECT version, per_head::text AS per_head FROM pricing.price_versions
        WHERE lawyer_id = $1 ORDER BY version`,
      [lawyerId],
    );
    return res.rows.map((r) => r.version);
  };

  const headPerHead = async (lawyerId: number): Promise<string | null> => {
    const res = await pool.query<{ per_head: string | null }>(
      `SELECT per_head::text AS per_head FROM pricing.price_versions
        WHERE lawyer_id = $1 ORDER BY version DESC LIMIT 1`,
      [lawyerId],
    );
    return res.rows[0]?.per_head ?? null;
  };

  const outboxOf = async (topic: string) => {
    const res = await pool.query<{ topic: string; payload: Record<string, unknown> }>(
      `SELECT topic, payload FROM platform.outbox WHERE topic = $1 ORDER BY id`,
      [topic],
    );
    return res.rows;
  };

  const notificationsOf = (userId: number, templateCode?: string) =>
    listNotificationsRaw(pool, userId, templateCode);

  const stlRows = async (historyId: number) => {
    const res = await pool.query<{
      from_status: string | null;
      to_status: string;
      allowed: boolean;
    }>(
      `SELECT from_status, to_status, allowed FROM platform.state_transition_log
        WHERE entity_type = 'pricing_history' AND entity_id = $1 ORDER BY id`,
      [historyId],
    );
    return res.rows;
  };

  const balanceOf = (userId: number): Promise<number> =>
    points.getMine(userId).then((m) => m.balance);

  const seedRevokeTemplate = (): Promise<void> =>
    seedTemplateRaw(
      pool,
      'PRICE_REVOKED',
      '您参与的服务价格调整已撤销，价格已恢复为您锁定的原价。',
    );

  beforeAll(async () => {
    pool = await ensureTestDatabase();
    const wechat = new MockChannelAdapter('wechat_ecom', 'mock-wechat-mch', 'test-secret-w');
    const alipay = new MockChannelAdapter('alipay', 'mock-alipay-mch', 'test-secret-a');
    const moduleRef = await Test.createTestingModule({ imports: [PricingChangeModule] })
      .overrideProvider(IDENTITY_CONFIG)
      .useValue(testIdentityConfig())
      .overrideProvider(PAYMENT_CONFIG)
      .useValue(testPaymentConfig())
      .overrideProvider(PAYMENT_CHANNEL_ADAPTERS)
      .useValue([wechat, alipay] as readonly PaymentChannelAdapter[])
      .overrideProvider(FIRM_MERCHANT_CONFIG)
      .useValue(MERCHANT_CONFIG)
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
    jwt = app.get(JwtService);
    dispatcher = app.get(NotifyDispatcherService);
    templates = app.get(NotifyTemplateService);
    b3 = app.get(PricingConfigService);
    points = app.get(PointsService);
    for (const id of [
      LAWYER_UP,
      LAWYER_LE10,
      LAWYER_GT10,
      LAWYER_FREE,
      LAWYER_REVOKE,
      LAWYER_FREQ,
      LAWYER_STALE,
      LAWYER_ISOLATED,
      LAWYER_AGGR,
      LAWYER_DUP,
      LAWYER_REV2,
      LAWYER_SNAP,
    ]) {
      lawyerTokens.set(id, await mintToken(id, 'lawyer'));
    }
    adminToken = await jwt.signAsync({
      sub: '990001',
      role: 'user',
      roles: ['user', 'admin'],
    });
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });
  beforeEach(async () => {
    await truncateAll(pool);
  });
  afterEach(async () => {
    // 自插模板夹具自行清理（不得污染 V4 参照数据，db.ts 头注口径）
    await deleteTemplateRaw(pool, 'PRICE_REVOKED');
    await truncateAll(pool);
  });

  // ===========================================================================
  // §5 POST /lawyer/pricing/change：鉴权 + 三档矩阵（R-01）+ 在团判定（C1/C2 导出）
  // ===========================================================================

  it('鉴权：未认证 401 / user 角色 403 / 律师本人放行；畸形 draft → 400/422', async () => {
    const draft = { base_version: 0, per_head: '120.00', one_on_one_prices: VALID_1V1 };
    const anon = await request(app.getHttpServer())
      .post('/lawyer/pricing/change')
      .send({ new_version_draft: draft });
    expect(anon.status).toBe(401);
    expect(anon.body.code).toBe(ErrorCode.Unauthorized);

    const userToken = await mintToken(USER_A, 'user');
    const asUser = await request(app.getHttpServer())
      .post('/lawyer/pricing/change')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ new_version_draft: draft });
    expect(asUser.status).toBe(403);
    expect(asUser.body.code).toBe(ErrorCode.RoleForbidden);

    await seedVersion(LAWYER_FREE, '100.00');
    const ok = await postChange(LAWYER_FREE, { ...draft, base_version: 1 });
    expect(ok.status).toBe(201);

    const badShape = await postChange(LAWYER_FREE, { per_head: '120.00' });
    expect(badShape.status).toBe(400);
    expect(badShape.body.code).toBe(ErrorCode.InvalidArgument);

    const moneyNumber = await postChange(LAWYER_FREE, {
      base_version: 2,
      per_head: 120,
      one_on_one_prices: VALID_1V1,
    });
    expect(moneyNumber.status).toBe(422);
    expect(moneyNumber.body.code).toBe(ErrorCode.MoneyInvalidFormat);
  });

  it('G-A 同批接线收尾（TODO(H1-W3-T10)）：approve 未认证 401 / 律师 token（未持 admin 旗标）403 / admin 可达', async () => {
    await seedVersion(LAWYER_LE10, '100.00');
    await seedSession(LAWYER_LE10, 'CREATED', USER_A); // 在团降价 → PENDING_APPROVAL
    const res = await postChange(LAWYER_LE10, {
      base_version: 1,
      per_head: '90.00',
      one_on_one_prices: VALID_1V1,
    });
    expect(res.body.result).toBe('PENDING_APPROVAL');
    const historyId = res.body.history_id as number;

    const anon = await request(app.getHttpServer())
      .post(`/pricing/change/${historyId}/approve`)
      .send({ approved: true, approval_id: 8951 });
    expect(anon.status).toBe(401);
    expect(anon.body.code).toBe(ErrorCode.Unauthorized);

    const asLawyer = await request(app.getHttpServer())
      .post(`/pricing/change/${historyId}/approve`)
      .set('Authorization', `Bearer ${lawyerTokens.get(LAWYER_UP) ?? ''}`)
      .send({ approved: true, approval_id: 8951 });
    expect(asLawyer.status).toBe(403);
    expect(asLawyer.body.code).toBe(ErrorCode.RoleForbidden);

    const ok = await approve(historyId, { approved: true, approval_id: 8951 });
    expect(ok.status).toBe(201);
    expect(ok.body.result).toBe('EFFECTED');
  });

  it('R-01① 在团涨价：EFFECTED 直效（经 B3 落版）+ 信用事件 kind=PRICE_UP + 已锁定用户 PRICE_UP_LOCKED 话术（PRD 逐字）', async () => {
    await seedVersion(LAWYER_UP, '100.00');
    await seedSession(LAWYER_UP, 'CREATED', USER_A); // 进行中场次 → 在团

    const res = await postChange(LAWYER_UP, {
      base_version: 1,
      per_head: '120.00',
      one_on_one_prices: VALID_1V1,
    });
    expect(res.status).toBe(201);
    expect(res.body.result).toBe('EFFECTED');
    const historyId = res.body.history_id as number;
    expect(historyId).toBeGreaterThan(0);

    // 版本经 B3 版本服务落版（R-W3-P 单写者）：v2=120.00
    expect(await versionsOf(LAWYER_UP)).toEqual([1, 2]);
    expect(await headPerHead(LAWYER_UP)).toBe('120.00');

    const [row] = await histRows(LAWYER_UP);
    expect(row).toMatchObject({
      old_version: 1,
      new_version: 2,
      direction: 'UP',
      has_active_group: true,
      result: 'EFFECTED',
      credit_penalty: -5,
      approval_id: null,
      approval_source: null,
      revoked_at: null,
    });
    expect(String(row!['change_pct'])).toBe('20.000');

    // 信用事件（G1 消费端按档扣分；C6 只出箱）
    const approved = await outboxOf(PRICE_CHANGE_APPROVED_TOPIC);
    expect(approved).toHaveLength(1);
    expect(approved[0]!.payload).toEqual({
      price_change_id: historyId,
      lawyer_id: LAWYER_UP,
      kind: 'PRICE_UP',
    });

    // I1 真消费：已锁定用户登记 → worker 下发 SENT，文案=V4 seed 逐字
    const queued = await notificationsOf(USER_A, 'PRICE_UP_LOCKED');
    expect(queued).toHaveLength(1);
    expect(queued[0]!.status).toBe('QUEUED');
    await dispatcher.processPending();
    const sent = await notificationsOf(USER_A, 'PRICE_UP_LOCKED');
    expect(sent[0]!.status).toBe('SENT');
    const rendered = await templates.render('PRICE_UP_LOCKED', {});
    expect(rendered.content).toBe(
      '您已锁定原价，当前律师已调价，您享受的是涨价前的价格，不受影响。',
    );

    // B3 版本事件照发（B3 版本服务出箱面）
    const ver = await outboxOf(PRICE_VERSION_CREATED_TOPIC);
    expect(ver.some((e) => e.payload['version'] === 2)).toBe(true);
  });

  it('R-01② 在团降价恰 10.0% 边界：PENDING_APPROVAL（版本不落、无信用事件）；approve(true) 人工兜底生效：approval_source=MANUAL + 补偿真链（D17 分母=paid_amount 全额）', async () => {
    await seedVersion(LAWYER_LE10, '100.00');
    await seedSession(LAWYER_LE10, 'CREATED', USER_A, {
      cash: '50.00',
      points: 1000, // paid 全额 = 5000 分 + 1000 积分（1 积分=1 分）= 6000 分
      unitPrice: '100.00',
    });
    await seedSession(LAWYER_LE10, 'IN_SERVICE', USER_B, {
      cash: '40.00',
      points: 0,
      unitPrice: '100.00',
    });
    await seedSession(LAWYER_LE10, 'FINISHED', USER_C, {
      cash: '30.00',
      points: 0,
      unitPrice: '100.00',
    }); // 已完成服务 → 不在补偿对象

    const res = await postChange(LAWYER_LE10, {
      base_version: 1,
      per_head: '90.00', // 恰 10.0%
      one_on_one_prices: VALID_1V1,
    });
    expect(res.status).toBe(201);
    expect(res.body.result).toBe('PENDING_APPROVAL');
    const historyId = res.body.history_id as number;
    expect(await versionsOf(LAWYER_LE10)).toEqual([1]); // 版本不落
    expect(await outboxOf(PRICE_CHANGE_APPROVED_TOPIC)).toHaveLength(0);
    expect(await notificationsOf(USER_A)).toHaveLength(0); // 未生效不通知

    const [pending] = await histRows(LAWYER_LE10);
    expect(pending).toMatchObject({
      direction: 'DOWN',
      result: 'PENDING_APPROVAL',
      credit_penalty: -15,
      approval_id: null,
    });
    expect(String(pending!['change_pct'])).toBe('10.000');

    // 幂等键=history：重复 approve 同载荷短路（先否决再通过=键冲突路径见 approve(false) 用例）
    const ok = await approve(historyId, { approved: true, approval_id: 8801 });
    expect(ok.status).toBe(201);
    expect(ok.body.result).toBe('EFFECTED');
    expect(ok.body.approval_source).toBe('MANUAL');

    // 生效经 B3：v2=90.00；历史行落 approval_id/source
    expect(await versionsOf(LAWYER_LE10)).toEqual([1, 2]);
    expect(await headPerHead(LAWYER_LE10)).toBe('90.00');
    const [row] = await histRows(LAWYER_LE10);
    expect(row).toMatchObject({
      result: 'EFFECTED',
      approval_id: '8801', // bigint 裸引用出库=字符串（pg numeric/bigint 口径）
      approval_source: 'MANUAL',
    });

    // 信用事件 kind=PRICE_DOWN_LE10（G1 消费 -15）
    const approved = await outboxOf(PRICE_CHANGE_APPROVED_TOPIC);
    expect(approved).toHaveLength(1);
    expect(approved[0]!.payload).toMatchObject({ kind: 'PRICE_DOWN_LE10', lawyer_id: LAWYER_LE10 });

    // 补偿真链（F4 ①切片 grant COMPENSATION）：(100-90)×占比——分母=全额 10000 分
    //   USER_A 6000/10000 → 600 分；USER_B 4000/10000 → 400 分；USER_C 已完成服务 → 无
    expect(await balanceOf(USER_A)).toBe(600);
    expect(await balanceOf(USER_B)).toBe(400);
    expect(await balanceOf(USER_C)).toBe(0);
    const granted = await outboxOf(POINTS_GRANTED_TOPIC);
    expect(granted.map((g) => g.payload['user_id']).sort()).toEqual([USER_A, USER_B]);
    expect(granted[0]!.payload).toMatchObject({ kind: 'COMPENSATION', delta: expect.any(Number) });

    const renderedComp = await templates.render('PRICE_DOWN_COMP', {});
    expect(renderedComp.content).toBe(
      '您参与的服务价格有所调整，您已锁定的原价不受影响。为感谢您的信任，我们已为您申请平台积分补偿，将在 24 小时内到账。',
    );
    // 降价≤10% 无券指令；I1 降价话术 PRICE_DOWN_COMP 送达（含积分受偿用户）
    expect(await outboxOf(PRICE_COUPON_INSTRUCTED_TOPIC)).toHaveLength(0);
    await dispatcher.processPending();
    expect((await notificationsOf(USER_A, 'PRICE_DOWN_COMP'))[0]!.status).toBe('SENT');
    expect((await notificationsOf(USER_B, 'PRICE_DOWN_COMP'))[0]!.status).toBe('SENT');
    expect(await notificationsOf(USER_C)).toHaveLength(0);

    // approve 幂等：重复 approve(true) 幂等键=history 短路——版本/事件/补偿零重复
    const replay = await approve(historyId, { approved: true, approval_id: 8801 });
    expect(replay.status).toBe(201);
    expect(replay.body.result).toBe('EFFECTED');
    expect(await versionsOf(LAWYER_LE10)).toEqual([1, 2]);
    expect(await outboxOf(PRICE_CHANGE_APPROVED_TOPIC)).toHaveLength(1);
    expect(await balanceOf(USER_A)).toBe(600);
    expect(await outboxOf(POINTS_GRANTED_TOPIC)).toHaveLength(2);
  });

  it('R-01③ 在团降价>10%：approve(true) → 补偿 + PRICE_COUPON_INSTRUCTED 券指令出箱（F4 ②全量消费位，②补验）', async () => {
    await seedVersion(LAWYER_GT10, '100.00');
    await seedSession(LAWYER_GT10, 'CREATED', USER_A, {
      cash: '100.00',
      points: 0,
      unitPrice: '100.00',
    });

    const res = await postChange(LAWYER_GT10, {
      base_version: 1,
      per_head: '80.00',
      one_on_one_prices: VALID_1V1,
    });
    expect(res.body.result).toBe('PENDING_APPROVAL');
    const historyId = res.body.history_id as number;
    const [pending] = await histRows(LAWYER_GT10);
    expect(pending).toMatchObject({ direction: 'DOWN', credit_penalty: -30 });
    expect(String(pending!['change_pct'])).toBe('20.000');

    const ok = await approve(historyId, { approved: true, approval_id: 8802 });
    expect(ok.body.result).toBe('EFFECTED');
    expect(await headPerHead(LAWYER_GT10)).toBe('80.00');

    const approved = await outboxOf(PRICE_CHANGE_APPROVED_TOPIC);
    expect(approved[0]!.payload).toMatchObject({ kind: 'PRICE_DOWN_GT10' });
    const coupons = await outboxOf(PRICE_COUPON_INSTRUCTED_TOPIC);
    expect(coupons).toHaveLength(1);
    expect(coupons[0]!.payload).toEqual({
      price_change_id: historyId,
      lawyer_id: LAWYER_GT10,
      user_id: USER_A,
      coupon_kind: 'PRICE_COMP',
    });
    expect(await balanceOf(USER_A)).toBe(2000); // (100-80)×100% = 20 元 = 2000 分
    const renderedBig = await templates.render('PRICE_DOWN_BIG', {});
    expect(renderedBig.content).toBe(
      '您参与的服务价格大幅调整。您已锁定的原价不受影响，我们已为您申请积分补偿 + 额外平台优惠券，将在 24 小时内到账。感谢您的信任与支持。',
    );
    await dispatcher.processPending();
    expect((await notificationsOf(USER_A, 'PRICE_DOWN_BIG'))[0]!.status).toBe('SENT');
  });

  it('approve(false)：PriceChangeRejected 出箱 + 版本不生效 + 无补偿无信用事件；再 approve 同键异载荷 → 幂等短路不翻案', async () => {
    await seedVersion(LAWYER_LE10, '100.00');
    await seedSession(LAWYER_LE10, 'CREATED', USER_A);
    const res = await postChange(LAWYER_LE10, {
      base_version: 1,
      per_head: '90.00',
      one_on_one_prices: VALID_1V1,
    });
    const historyId = res.body.history_id as number;

    const rej = await approve(historyId, { approved: false, approval_id: 8803 });
    expect(rej.status).toBe(201);
    expect(rej.body.result).toBe('REJECTED');
    expect(await versionsOf(LAWYER_LE10)).toEqual([1]); // 版本不生效
    const rejected = await outboxOf(PRICE_CHANGE_REJECTED_TOPIC);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.payload).toEqual({
      price_change_id: historyId,
      lawyer_id: LAWYER_LE10,
      kind: 'PRICE_DOWN_LE10',
    });
    expect(await outboxOf(PRICE_CHANGE_APPROVED_TOPIC)).toHaveLength(0);
    expect(await balanceOf(USER_A)).toBe(0);
    expect(await notificationsOf(USER_A)).toHaveLength(0);
    const [row] = await histRows(LAWYER_LE10);
    expect(row).toMatchObject({
      result: 'REJECTED',
      approval_id: '8803',
      approval_source: 'MANUAL',
    });

    // 同 history 再 approve(true)：幂等键=history，终态不翻案（H3 侧以 TicketResolved 重驱动=M2）
    const flip = await approve(historyId, { approved: true, approval_id: 8803 });
    expect(flip.status).toBe(201);
    expect(flip.body.result).toBe('REJECTED');
    expect(await versionsOf(LAWYER_LE10)).toEqual([1]);
    expect(await outboxOf(PRICE_CHANGE_APPROVED_TOPIC)).toHaveLength(0);
  });

  it('审批时版本链漂移：PENDING 期间 B3 直改占号 → approve 409（审批作废，重发起）', async () => {
    await seedVersion(LAWYER_STALE, '100.00');
    await seedSession(LAWYER_STALE, 'CREATED'); // 在团（B3 直改走 InGroupProbe 桩恒 false，可占号）
    const res = await postChange(LAWYER_STALE, {
      base_version: 1,
      per_head: '90.00',
      one_on_one_prices: VALID_1V1,
    });
    expect(res.body.result).toBe('PENDING_APPROVAL');
    const historyId = res.body.history_id as number;

    await b3.putPricing(LAWYER_STALE, {
      base_version: 1,
      per_head: '105.00',
      one_on_one_prices: VALID_1V1,
    }); // v2 被占
    const conflict = await approve(historyId, { approved: true, approval_id: 8804 });
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe(ErrorCode.Conflict);
    const [row] = await histRows(LAWYER_STALE);
    expect(row).toMatchObject({ result: 'PENDING_APPROVAL' }); // 原审批保持待定（不静默翻案）
  });

  it('R-01④ 不在团降价：自由改价 EFFECTED（credit_penalty=0、无信用事件、无通知）；在团判定含拼团链（PUBLISHED 拼团=在团）；仅终态场次=不在团', async () => {
    await seedVersion(LAWYER_FREE, '100.00');
    await seedSession(LAWYER_FREE, 'FINISHED'); // 终态 → 不在团
    const res = await postChange(LAWYER_FREE, {
      base_version: 1,
      per_head: '88.00',
      one_on_one_prices: VALID_1V1,
    });
    expect(res.body.result).toBe('EFFECTED');
    expect(await headPerHead(LAWYER_FREE)).toBe('88.00');
    // R-02 快照保护面：版本行 append-only，基线行内容原样（已锁定用户的快照事实源不被触碰）
    const v1 = await pool.query(
      'SELECT per_head::text AS per_head FROM pricing.price_versions WHERE lawyer_id = $1 AND version = 1',
      [LAWYER_FREE],
    );
    expect(v1.rows[0]!.per_head).toBe('100.00');
    const [row] = await histRows(LAWYER_FREE);
    expect(row).toMatchObject({
      direction: 'DOWN',
      has_active_group: false,
      result: 'EFFECTED',
      credit_penalty: 0,
    });
    expect(await outboxOf(PRICE_CHANGE_APPROVED_TOPIC)).toHaveLength(0); // 不在团自由改价不emit信用事件（PRD 惩罚表=在团场景）

    // 拼团链在团判定：PUBLISHED 拼团 → has_active_group=true（降价 → 审批档）
    await seedVersion(LAWYER_ISOLATED, '100.00');
    await seedGroupBuy(LAWYER_ISOLATED, 'PUBLISHED');
    const withGroup = await postChange(LAWYER_ISOLATED, {
      base_version: 1,
      per_head: '95.00',
      one_on_one_prices: VALID_1V1,
    });
    expect(withGroup.body.result).toBe('PENDING_APPROVAL');
    const [gbRow] = await histRows(LAWYER_ISOLATED);
    expect(gbRow).toMatchObject({ has_active_group: true, credit_penalty: -15 });

    // 终态拼团不构成在团：EXPIRED 拼团 + 无活跃场次 → 自由改价
    await seedVersion(LAWYER_FREQ, '100.00');
    await seedGroupBuy(LAWYER_FREQ, 'EXPIRED');
    const expiredOnly = await postChange(LAWYER_FREQ, {
      base_version: 1,
      per_head: '99.00',
      one_on_one_prices: VALID_1V1,
    });
    expect(expiredOnly.body.result).toBe('EFFECTED');
    const [exRow] = await histRows(LAWYER_FREQ);
    expect(exRow).toMatchObject({ has_active_group: false, credit_penalty: 0 });
  });

  it('R-03 频率 DB 滑窗（⚠W3-7）：30 天第 4 次 → PENDING_APPROVAL（无论方向/在团；429 FREQ_EXCEEDED 契约位保留不用——行为钉住为 200 审批档）；窗滑出（31 天前）恢复自由', async () => {
    await seedVersion(LAWYER_FREQ, '100.00');
    // 三次自由改价（不在团 UP：EFFECTED）
    for (const [v, price] of [
      [1, '101.00'],
      [2, '102.00'],
      [3, '103.00'],
    ] as const) {
      const r = await postChange(LAWYER_FREQ, {
        base_version: v,
        per_head: price,
        one_on_one_prices: VALID_1V1,
      });
      expect(r.body.result).toBe('EFFECTED');
    }
    expect(await versionsOf(LAWYER_FREQ)).toEqual([1, 2, 3, 4]);

    const fourth = await postChange(LAWYER_FREQ, {
      base_version: 4,
      per_head: '104.00',
      one_on_one_prices: VALID_1V1,
    });
    expect(fourth.status).toBe(201); // 非桶 429：审批兜底档
    expect(fourth.body.result).toBe('PENDING_APPROVAL');
    const [fourthRow, ...rest] = await histRows(LAWYER_FREQ);
    expect(rest).toHaveLength(3);
    expect(fourthRow).toMatchObject({ direction: 'UP', has_active_group: false });

    // F-3 语义：同草案再提交=重放原待审行（待审请求是活请求，窗口滑出不使其变成新请求）
    await timeTravel(LAWYER_FREQ, '31 days');
    const replay = await postChange(LAWYER_FREQ, {
      base_version: 4,
      per_head: '104.00',
      one_on_one_prices: VALID_1V1,
    });
    expect(replay.body.result).toBe('PENDING_APPROVAL');
    expect(replay.body.history_id).toBe(fourth.body.history_id);
    // 审批终结待审行（窗口已滑出，人工兜底按当下口径放行）→ head 前移释放槽位
    await approve(fourth.body.history_id as number, { approved: true, approval_id: 8810 });
    // 新草案请求：窗内计数 0 → 恢复直效（滑窗验证面）
    const sixth = await postChange(LAWYER_FREQ, {
      base_version: 5,
      per_head: '105.00',
      one_on_one_prices: VALID_1V1,
    });
    expect(sixth.body.result).toBe('EFFECTED');
    expect(await versionsOf(LAWYER_FREQ)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  // ===========================================================================
  // R-04 撤销（24h 边界 / 恢复上一版本 / 通知 / 幂等 / 越权）
  // ===========================================================================

  it('R-04 撤销：24h 内恢复上一版本（经 B3 落新版本=旧版内容）+ revoked_at + PriceRevoked + 通知受影响用户；重复撤销幂等', async () => {
    await seedVersion(LAWYER_REVOKE, '100.00');
    await seedSession(LAWYER_REVOKE, 'CREATED', USER_A);
    const res = await postChange(LAWYER_REVOKE, {
      base_version: 1,
      per_head: '90.00',
      one_on_one_prices: VALID_1V1,
    });
    expect(res.body.result).toBe('PENDING_APPROVAL');
    const historyId = res.body.history_id as number;
    await approve(historyId, { approved: true, approval_id: 8805 });
    expect(await headPerHead(LAWYER_REVOKE)).toBe('90.00');
    const balanceBefore = await balanceOf(USER_A); // 600（补偿已发，撤销不回收——R-04 无回收语义）

    // 通知受影响用户（⚠决策位：撤销话术 PRD §8.2 未定义——PRICE_REVOKED 模板 seed 归 I1 域；
    // 本 spec 自插夹具验证扇出链路：模板须在撤销事务登记时在册）
    await seedRevokeTemplate();
    const rv = await revoke(historyId);
    expect(rv.status).toBe(201);
    expect(rv.body.status).toBe('REVOKED');
    expect(rv.body.restored_version).toBe(3);

    // 恢复上一版本经 B3：v3 = old_version(v1) 内容（版本行不可变，恢复=新版本承载旧内容）
    expect(await versionsOf(LAWYER_REVOKE)).toEqual([1, 2, 3]);
    expect(await headPerHead(LAWYER_REVOKE)).toBe('100.00');
    const [row] = await histRows(LAWYER_REVOKE);
    expect(row).toMatchObject({ result: 'EFFECTED' });
    expect(row!['revoked_at']).not.toBeNull();

    // 通知受影响用户（⚠决策位：撤销话术 PRD §8.2 未定义——PRICE_REVOKED 模板 seed 归 I1 域；
    // 本 spec 自插夹具验证扇出链路，生产无模板时台账 FAILED 显性化）
    const revoked = await outboxOf(PRICE_REVOKED_TOPIC);
    expect(revoked).toHaveLength(1);
    expect(revoked[0]!.payload).toEqual({ price_change_id: historyId, lawyer_id: LAWYER_REVOKE });
    expect(await balanceOf(USER_A)).toBe(balanceBefore); // 撤销不扣信用/不回收补偿
    await dispatcher.processPending();
    const revNotice = await notificationsOf(USER_A, 'PRICE_REVOKED');
    expect(revNotice).toHaveLength(1);
    expect(revNotice[0]!.status).toBe('SENT');

    // 幂等：重复撤销同 history → 短路返回，零新版本/事件
    const replay = await revoke(historyId);
    expect(replay.status).toBe(201);
    expect(replay.body.status).toBe('REVOKED');
    expect(await versionsOf(LAWYER_REVOKE)).toEqual([1, 2, 3]);
    expect(await outboxOf(PRICE_REVOKED_TOPIC)).toHaveLength(1);
  });

  it('R-04 超窗：窗内（23h）可撤销；超窗（24h+1min）→ 409 E_PAST_24H；PENDING 行不可撤销 409；他人撤销 → 404', async () => {
    await seedVersion(LAWYER_REVOKE, '100.00');
    await seedSession(LAWYER_REVOKE, 'CREATED', USER_A);
    const res = await postChange(LAWYER_REVOKE, {
      base_version: 1,
      per_head: '90.00',
      one_on_one_prices: VALID_1V1,
    });
    const historyId = res.body.history_id as number;
    await approve(historyId, { approved: true, approval_id: 8806 });

    // 窗内（恰端点语义=谓词 created_at >= now()-24h 含端点；墙上时钟精确 24h 点不可测——
    // 以 23h 确定性窗内值验证「可撤销」侧，报告注明）
    await timeTravel(LAWYER_REVOKE, '23 hours');
    const boundary = await revoke(historyId);
    expect(boundary.status).toBe(201);
    expect(boundary.body.status).toBe('REVOKED');

    // 超窗 24h+1min
    const res2 = await postChange(LAWYER_REVOKE, {
      base_version: 3,
      per_head: '92.00',
      one_on_one_prices: VALID_1V1,
    });
    expect(res2.body.result).toBe('PENDING_APPROVAL'); // 窗内 2 次（30 天窗内第 2 次，未超 R-03）
    const historyId2 = res2.body.history_id as number;
    await approve(historyId2, { approved: true, approval_id: 8807 });
    await timeTravel(LAWYER_REVOKE, '24 hours');
    await pool.query(
      `UPDATE pricing.pricing_histories SET created_at = created_at - interval '1 minute'
        WHERE id = $1`,
      [historyId2],
    );
    const late = await revoke(historyId2);
    expect(late.status).toBe(409);
    expect(late.body.code).toBe(ErrorCode.Past24h);
    const rows = await histRows(LAWYER_REVOKE);
    expect(rows[1]!['revoked_at']).toBeNull();

    // PENDING 行不可撤销（在团降价 → 审批档；断言先钉 PENDING 结果再撤销）
    const res3 = await postChange(LAWYER_REVOKE, {
      base_version: 4,
      per_head: '91.00', // 92→91 DOWN（若误传涨价将直效，PENDING 前置不成立）
      one_on_one_prices: VALID_1V1,
    });
    expect(res3.body.result).toBe('PENDING_APPROVAL');
    const historyId3 = res3.body.history_id as number;
    const pendingRevoke = await revoke(historyId3);
    expect(pendingRevoke.status).toBe(409);
    expect(pendingRevoke.body.code).toBe(ErrorCode.Conflict);

    // 越权：他人 token 撤销 → 404（不暴露他人 history 存在性）
    const other = await revoke(historyId3, lawyerTokens.get(LAWYER_UP));
    expect(other.status).toBe(404);

    // 不存在的 history
    const missing = await revoke(999999);
    expect(missing.status).toBe(404);
  });

  // ===========================================================================
  // §5 GET /pricing/histories?lawyer_id= + DB CHECK 兜底层
  // ===========================================================================

  it('GET /pricing/histories：§5 列表契约字段全回显；无记录=空数组；缺失 lawyer_id → 400', async () => {
    await seedVersion(LAWYER_FREE, '100.00');
    await postChange(LAWYER_FREE, {
      base_version: 1,
      per_head: '97.00',
      one_on_one_prices: VALID_1V1,
    });

    const list = await histories(LAWYER_FREE);
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0]).toMatchObject({
      lawyer_id: LAWYER_FREE,
      old_version: 1,
      new_version: 2,
      direction: 'DOWN',
      change_pct: '3.000',
      has_active_group: false,
      result: 'EFFECTED',
      credit_penalty: 0,
      approval_id: null,
      approval_source: null,
      revoked_at: null,
    });
    expect(list.body[0].created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(list.body[0].history_id).toBeGreaterThan(0);

    expect(await histories(LAWYER_GT10).then((r) => r.body)).toEqual([]);
    const missing = await request(app.getHttpServer()).get('/pricing/histories');
    expect(missing.status).toBe(400);
  });

  // ===========================================================================
  // 评审修复轮（R-W3-Q）：F-1 聚合 / F-2 STL / F-3 幂等键 / F-4 撤销 head 复核
  // ===========================================================================

  it('F-1 同用户多笔活跃 PAID 报名聚合：补偿恰一笔（两场 paid 合计占比）+ GT10 券恰一张；approve 不因 grant 幂等键冲突失败', async () => {
    await seedVersion(LAWYER_AGGR, '100.00');
    // USER_A 同律师两场各 1 笔 PAID（cash 30.00 ×2 = 6000 分合计），USER_B 一场 2000 分
    await seedSession(LAWYER_AGGR, 'CREATED', USER_A, {
      cash: '30.00',
      points: 0,
      unitPrice: '100.00',
    });
    await seedSession(LAWYER_AGGR, 'IN_SERVICE', USER_A, {
      cash: '30.00',
      points: 0,
      unitPrice: '100.00',
    });
    await seedSession(LAWYER_AGGR, 'CREATED', USER_B, {
      cash: '20.00',
      points: 0,
      unitPrice: '100.00',
    });

    const res = await postChange(LAWYER_AGGR, {
      base_version: 1,
      per_head: '70.00', // GT10：补偿 + 券
      one_on_one_prices: VALID_1V1,
    });
    expect(res.body.result).toBe('PENDING_APPROVAL');
    const historyId = res.body.history_id as number;
    const ok = await approve(historyId, { approved: true, approval_id: 8901 });
    expect(ok.status).toBe(201); // 未聚合实现此处 grant 幂等键冲突 500

    // 占比：USER_A 6000/8000 → floor(3000×6000/8000)=2250；USER_B 2000/8000 → 750
    expect(await balanceOf(USER_A)).toBe(2250);
    expect(await balanceOf(USER_B)).toBe(750);
    const granted = await outboxOf(POINTS_GRANTED_TOPIC);
    expect(granted.filter((g) => g.payload['user_id'] === USER_A)).toHaveLength(1); // 恰一笔
    expect(granted.filter((g) => g.payload['user_id'] === USER_B)).toHaveLength(1);
    // 券指令按聚合后 recipients 去重：恰两张，一人一张
    const coupons = await outboxOf(PRICE_COUPON_INSTRUCTED_TOPIC);
    expect(coupons).toHaveLength(2);
    expect(coupons.map((c) => c.payload['user_id']).sort()).toEqual([USER_A, USER_B]);
  });

  it('F-2 result 迁移经 STL：PENDING_APPROVAL→EFFECTED/REJECTED 与 EFFECTED→REVOKED 留痕可查；幂等重放零新痕', async () => {
    await seedVersion(LAWYER_LE10, '100.00');
    await seedSession(LAWYER_LE10, 'CREATED', USER_A);
    const res = await postChange(LAWYER_LE10, {
      base_version: 1,
      per_head: '90.00',
      one_on_one_prices: VALID_1V1,
    });
    const historyId = res.body.history_id as number;
    expect((await stlRows(historyId)).filter((r) => r.allowed)).toHaveLength(0); // 出生态无迁移痕

    await approve(historyId, { approved: true, approval_id: 8902 });
    expect(await stlRows(historyId)).toEqual([
      { from_status: 'PENDING_APPROVAL', to_status: 'EFFECTED', allowed: true },
    ]);

    // 撤销：EFFECTED→REVOKED 痕（revoked_at 物化标记，result 列词汇不变——machine 头注对照）
    await seedRevokeTemplate();
    const rv = await revoke(historyId, lawyerTokens.get(LAWYER_LE10));
    expect(rv.status).toBe(201);
    expect(await stlRows(historyId)).toEqual([
      { from_status: 'PENDING_APPROVAL', to_status: 'EFFECTED', allowed: true },
      { from_status: 'EFFECTED', to_status: 'REVOKED', allowed: true },
    ]);

    // 否决路径：PENDING_APPROVAL→REJECTED 痕
    const res2 = await postChange(LAWYER_LE10, {
      base_version: 3,
      per_head: '91.00',
      one_on_one_prices: VALID_1V1,
    });
    const historyId2 = res2.body.history_id as number;
    await approve(historyId2, { approved: false, approval_id: 8903 });
    expect(await stlRows(historyId2)).toEqual([
      { from_status: 'PENDING_APPROVAL', to_status: 'REJECTED', allowed: true },
    ]);

    // 幂等重放（终态再 approve）不产生新痕
    const replay = await approve(historyId, { approved: true, approval_id: 8902 });
    expect(replay.body.result).toBe('EFFECTED');
    expect(await stlRows(historyId)).toHaveLength(2);
  });

  it('F-3 幂等键=lawyer+new_version（PENDING 面）：同键同草案重放原行；异草案 409；REJECTED 释放槽位后可再发起', async () => {
    await seedVersion(LAWYER_DUP, '100.00');
    await seedSession(LAWYER_DUP, 'CREATED', USER_A); // 在团 → 降价进审批档
    const draft = { base_version: 1, per_head: '90.00', one_on_one_prices: VALID_1V1 };
    const first = await postChange(LAWYER_DUP, draft);
    expect(first.body.result).toBe('PENDING_APPROVAL');
    const historyId = first.body.history_id as number;

    // 同键同草案 → 幂等重放原行（不落新行）
    const replay = await postChange(LAWYER_DUP, { ...draft });
    expect(replay.body.history_id).toBe(historyId);
    expect(replay.body.result).toBe('PENDING_APPROVAL');
    expect(await histRows(LAWYER_DUP)).toHaveLength(1);

    // 同键异草案 → 409（V30 PENDING 面唯一索引 + 应用侧载荷比对）
    const conflict = await postChange(LAWYER_DUP, {
      base_version: 1,
      per_head: '85.00',
      one_on_one_prices: VALID_1V1,
    });
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe(ErrorCode.Conflict);
    expect(await histRows(LAWYER_DUP)).toHaveLength(1);

    // 否决释放槽位 → 同号（head 未动，仍 v2 槽）可再发起为新行
    await approve(historyId, { approved: false, approval_id: 8904 });
    const resubmit = await postChange(LAWYER_DUP, draft);
    expect(resubmit.status).toBe(201);
    expect(resubmit.body.result).toBe('PENDING_APPROVAL');
    expect(resubmit.body.history_id).not.toBe(historyId);
    expect(resubmit.body.new_version).toBe(first.body.new_version); // 同槽复用
    expect(await histRows(LAWYER_DUP)).toHaveLength(2);
  });

  it('F-4 撤销 head 复核：非当前最新生效版本 → 409（历史档撤销语义 ⚠待澄清 M2）；最新档可撤', async () => {
    await seedVersion(LAWYER_REV2, '100.00');
    await seedSession(LAWYER_REV2, 'CREATED', USER_A);
    const r1 = await postChange(LAWYER_REV2, {
      base_version: 1,
      per_head: '90.00',
      one_on_one_prices: VALID_1V1,
    });
    const h1 = r1.body.history_id as number;
    await approve(h1, { approved: true, approval_id: 8905 }); // v2=90
    const r2 = await postChange(LAWYER_REV2, {
      base_version: 2,
      per_head: '85.00',
      one_on_one_prices: VALID_1V1,
    });
    const h2 = r2.body.history_id as number;
    await approve(h2, { approved: true, approval_id: 8906 }); // v3=85（h1 已非最新）

    const stale = await revoke(h1, lawyerTokens.get(LAWYER_REV2));
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe(ErrorCode.Conflict);
    expect((await histRows(LAWYER_REV2))[0]!['revoked_at']).toBeNull(); // 历史档未被误撤

    const latest = await revoke(h2, lawyerTokens.get(LAWYER_REV2));
    expect(latest.status).toBe(201);
    expect(latest.body.status).toBe('REVOKED');
    // 恢复上一版本=该行 old_version 内容（v2=90.00，change2 的基线）为新 head；非逐级回滚到最初价
    expect(await headPerHead(LAWYER_REV2)).toBe('90.00');
  });

  it('DB 层 CHECK 兜底：direction 越域 / change_pct<0 / credit_penalty>0 / result 越域 → 23514', async () => {
    const insert = (sql: string, params: readonly unknown[]) =>
      pool.query(sql, params as unknown[]);
    await expect(
      insert(
        `INSERT INTO pricing.pricing_histories
           (lawyer_id, old_version, new_version, direction, change_pct, has_active_group, result, new_version_draft)
         VALUES ($1::int, $2::int, $3::int, 'SIDEWAYS', $4::numeric, $5::boolean, $6::text, '{}'::jsonb)`,
        [9409, 1, 2, '0.1', false, 'EFFECTED'],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      insert(
        `INSERT INTO pricing.pricing_histories
           (lawyer_id, old_version, new_version, direction, change_pct, has_active_group, result, new_version_draft)
         VALUES ($1::int, $2::int, $3::int, 'UP', -0.1, $4::boolean, $5::text, '{}'::jsonb)`,
        [9409, 1, 2, false, 'EFFECTED'],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      insert(
        `INSERT INTO pricing.pricing_histories
           (lawyer_id, old_version, new_version, direction, change_pct, has_active_group, result, credit_penalty, new_version_draft)
         VALUES ($1::int, $2::int, $3::int, 'UP', $4::numeric, $5::boolean, $6::text, 5, '{}'::jsonb)`,
        [9409, 1, 2, '0.1', false, 'EFFECTED'],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      insert(
        `INSERT INTO pricing.pricing_histories
           (lawyer_id, old_version, new_version, direction, change_pct, has_active_group, result, new_version_draft)
         VALUES ($1::int, $2::int, $3::int, 'UP', $4::numeric, $5::boolean, 'VOID', '{}'::jsonb)`,
        [9409, 1, 2, '0.1', false],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      insert(
        `INSERT INTO pricing.pricing_histories
           (lawyer_id, old_version, new_version, direction, change_pct, has_active_group, result, new_version_draft)
         VALUES ($1::int, $2::int, $3::int, 'UP', $4::numeric, $5::boolean, $6::text, '{}'::jsonb)`,
        [9409, 1, 2, '0.1', false, 'EFFECTED'],
      ),
    ).resolves.toMatchObject({ rowCount: 1 }); // 合法行可插（对照组）
  });

  // ---------- #39 收口（M2-W2 T6）：补偿「应发」快照持久化 + 巡检⑤对照改快照 ----------

  it('#39 快照持久化：approve DOWN 生效事务内 comp_snapshots 全量落位——零发放对象也落 granted=true 零分行；grant 同事务（余额与快照原子）；approve 重放幂等不双计', async () => {
    const USER_TINY = 704;
    await seedVersion(LAWYER_SNAP, '100.00');
    // 两受影响用户：USER_A paid=99.98 元（9998 分）+ USER_TINY paid=0.02 元（2 分），Σpaid=10000 分
    await seedSession(LAWYER_SNAP, 'CREATED', USER_A, {
      cash: '99.98',
      points: 0,
      unitPrice: '100.00',
    });
    await seedSession(LAWYER_SNAP, 'CREATED', USER_TINY, {
      cash: '0.02',
      points: 0,
      unitPrice: '100.00',
    });

    const res = await postChange(LAWYER_SNAP, {
      base_version: 1,
      per_head: '80.00',
      one_on_one_prices: VALID_1V1,
    });
    const historyId = res.body.history_id as number;
    const ok = await approve(historyId, { approved: true, approval_id: 8803 });
    expect(ok.body.result).toBe('EFFECTED');

    // 快照=recipients 全量（零发放 USER_TINY 也落行，granted=true——「零欠付即无未决」）
    const snaps = await pool.query<{
      user_id: string;
      points: number;
      kind: string;
      granted: boolean;
    }>(
      `SELECT user_id::text AS user_id, points, kind, granted FROM pricing.comp_snapshots
        WHERE price_change_id = $1 ORDER BY user_id`,
      [historyId],
    );
    expect(snaps.rows).toEqual([
      { user_id: String(USER_A), points: 1999, kind: 'COMPENSATION', granted: true },
      { user_id: String(USER_TINY), points: 0, kind: 'COMPENSATION', granted: true },
    ]);
    // grant 与快照同事务：>0 用户入账 1999（2000×9998/10000 floor）；零发放用户无积分入账
    // （断言走 F4 导出面 getMine——跨域不直读 benefits 表）
    expect(await balanceOf(USER_A)).toBe(1999);
    expect(await balanceOf(USER_TINY)).toBe(0);

    // approve 幂等重放：终态短路——快照/余额/事件零新副作用
    const replay = await approve(historyId, { approved: true, approval_id: 8804 });
    expect(replay.body).toMatchObject({ result: 'EFFECTED' });
    const snaps2 = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pricing.comp_snapshots WHERE price_change_id = $1`,
      [historyId],
    );
    expect(snaps2.rows[0]!.n).toBe(2);
    expect(await balanceOf(USER_A)).toBe(1999);
  });

  it('#39 巡检⑤零假阳回归：EFFECTED DOWN 在团超窗但快照零行（生效时点无补偿对象）→ 零候选；granted=false 行 → 候选检出', async () => {
    const patrolService = app.get(PriceChangePatrolService);
    // 原假阳形态：零已支付行（无 recipients → 无快照）——「pricing_histories 推算应发」旧形态
    // 必检出 CRITICAL，收口后零候选
    const bareId = await seedPriceHistoryRaw(pool, {
      lawyerId: 9413,
      createdAtAgoMs: AGO_30H_MS,
    });
    await expect(
      patrolService.findUnpaidCompensationCandidates({ windowMs: 24 * 3_600_000 }),
    ).resolves.toHaveLength(0);

    // 真未发：granted=false 快照行 → 候选（COMPENSATION_DISPATCH 异步路径/回归 Bug 检出锚）
    await seedCompSnapshotRaw(pool, {
      priceChangeId: bareId,
      userId: 705,
      points: 100,
      granted: false,
    });
    const candidates = await patrolService.findUnpaidCompensationCandidates({
      windowMs: 24 * 3_600_000,
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ historyId: bareId, lawyerId: 9413 });
  });
});
