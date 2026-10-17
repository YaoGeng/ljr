import 'reflect-metadata';
import { createHmac, randomBytes } from 'node:crypto';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  CREDIT_EVENT_EMITTED_TOPIC,
  ENROLLMENT_PAID_TOPIC,
  ErrorCode,
  FIRM_MERCHANT_ACTIVATED_TOPIC,
  FIRM_MERCHANT_SUSPENDED_TOPIC,
  GROUP_BUY_PUBLISHED_TOPIC,
  GROUP_BUY_REACHED_TOPIC,
  LAWYER_AUDIT_PASSED_TOPIC,
  PAYMENT_CALLBACK_INBOXED_TOPIC,
  POINTS_EXPIRED_TOPIC,
  POINTS_GRANTED_TOPIC,
  POINTS_REDEEMED_TOPIC,
  PRICE_COUPON_INSTRUCTED_TOPIC,
  PRICE_VERSION_CREATED_TOPIC,
  REAL_NAME_VERIFIED_TOPIC,
  REFUND_COMPLETED_TOPIC,
  RESTRICTION_ISSUED_TOPIC,
  ROOM_CLOSED_TOPIC,
  SESSION_CREATED_TOPIC,
  SESSION_FAILED_TOPIC,
  SESSION_FULL_TOPIC,
  SETTLEMENT_HELD_TOPIC,
  SETTLEMENT_RELEASED_TOPIC,
  SPLIT_SETTLED_TOPIC,
  USER_REGISTERED_TOPIC,
} from '@ljr/shared';
import type { Pool } from 'pg';
import { OutboxRelayService } from '../../infrastructure/outbox/outbox-relay.service';
import { OutboxService } from '../../infrastructure/outbox/outbox.service';
import { PgPoolService } from '../../infrastructure/sql';
import { ensureTestDatabase, truncateAll } from '../../infrastructure/testing/db';
import { getPointsAccount, seedPointsBalance } from '../benefits/points-fixture';
import { IDENTITY_CONFIG, type IdentityConfig } from '../identity/identity.config';
import { IdentityTokenService } from '../identity/identity.token.service';
import { grantUserRoles } from '../identity/lawyer-fixture';
import {
  PAYMENT_CONFIG,
  PAYMENT_SWITCH_WINDOW_MS_DEFAULT,
  type PaymentConfig,
} from '../payment/payment.config';
import { PaymentGatewayService } from '../payment/payment.gateway.service';
import { FirmMerchantService } from '../payment/firm-merchant.service';
import { MockPatrolAlertSink } from '../ops/patrol.alerts';
import { PatrolModule } from '../ops/patrol.module';
import { PatrolService } from '../ops/patrol.service';
import { RuleCenterService } from '../ops/rule-center.service';
import { CREDIT_RULES_KEY } from '../credit/credit.types';
import { SchedulerService, SCHEDULE_JOB_FIRED_TOPIC } from '../schedule/scheduler.service';
import { TimeTableModule } from '../schedule/time-table.module';
import { backdatePriceHistorySince } from '../pricing/price-change.fixture';
import { travelHoldCreated } from '../settlement/settlement-fixture';
import { SettlementModule } from '../settlement/settlement.module';
import {
  type NotifyChannelAdapter,
  type NotifyChannelMessage,
  NOTIFY_CHANNEL_ADAPTERS,
} from '../notify/notify.channels';
import { IdentityModule } from '../identity/identity.module';
import { LawyerQualificationModule } from '../identity/lawyer-qualification.module';
import { LawyerAdminModule } from '../ops/lawyer-admin.module';

/**
 * M1-W4 链 1 现金闭环 E2E 正式验收 spec（Task 2；docs/05 §5.1 W4 行/§5.2 验收口径）：
 * M1 退出硬条件①「链 1 ①段 API 级贯通」（w3-smoke 冻结形态重建，段 1~11 断言逐字复刻——
 * w3-smoke.spec.ts 已冻结不改，本 spec 为其链路构造的独立重建快照）+ 退出判据「资损巡检
 * 正常链路零违例」（段 13：PatrolService.runOnce 零 findings 清零并验，W4 T1 交付的并验段
 * 消费方）。
 *
 * 段 1~11（W3 冻结形态重建，tick 计数/幂等收口四断言/23 topic 计数逐字同源）：
 *   admin→H1 通过→A3b ACTIVE→C1 开团×2→C3 报名成团 FULL→C2 REACHED→流标退款→F3 SETTLED
 *   →幂等收口（回调重放恰一次/退款重放恰一笔/outbox 全 SENT+死信 0/关键实体 STL 可查）。
 *
 * 段 12（W4 增量·巡检⑤类检测面覆盖段）：C6 改价真链——链内律师在团（S1 FULL+G1
 *   PENDING_LAWYER 均活跃）降 session_total 120.00→100.00（DOWN 16.67%>10%）→PENDING_APPROVAL
 *   →admin approve→EFFECTED+F4 补偿真链直发（user1/user2 各 +1000 积分=（原-新）×paid 占比，
 *   ref=price_change:{id}）→owner 侧 fixture 回拨 created_at 25h（>⑤类 24h 窗；时间注入=
 *   travelHoldCreated 同款先例）→该行入巡检候选集且「应发已发」成立（非空集清零实证）。
 *
 * 段 13（巡检并验）：链数据对五类检测面的触达与清零——
 *   ① PAID_NOT_REFUNDED  checked=0：正常链按设计不产生「PAID×退款应发起终态」行（S2 流标同
 *      事务即 REFUNDED——①类近-miss 形态在场：终态场次+已退报名+退款 DONE 不误报；正向检出
 *      由 patrol.spec 故障注入证非空转）；
 *   ② STALE_LOCK         checked=2：S1 LOCKED（slot +72h）+ G1 PENDING_PAYMENT（TTL 未来）两把
 *      活跃锁未来段位不误报；S2 FAILED 同事务锁释放（终态+活跃锁形态不在场=正确处理）；
 *   ③ SCHED_BACKLOG      checked=1（聚合面）：REMIND×8/ROOM_OPEN×2/ENROLL_DEADLINE/C2B_
 *      CONFIRM_TIMEOUT/SLOT_TTL 等在册 PENDING 全未来 → 零逾期；
 *   ④ SPLIT_UNCONFIRMED  checked=0：mock 通道同步确认（许可桩清单 W4 增量语义注记）——链内
 *      SPLIT/REFUND 指令行均 CONFIRMED，无 ISSUED 残留；
 *   ⑤ COMPENSATION_UNPAID checked=1：段 12 回拨行入候选集→F4 授予流水核对通过→零违例
 *      （候选→已发→不检出全路径实证，非空表空转）。
 *   断言能失败锚：patrol.spec 五类故障注入（T1，先红后绿）证检测器非空转；本 spec ②⑤
 *   checked>0 证本轮扫描真跑了数据；findings=0 若为「永远零发现」空转形态将与其冲突。
 *
 * 放置位置与断言面说明（check-schema-refs owner 纪律，w3-smoke 同款）：链 1 以 trade 为主场
 * （本 spec 归 trade——链主实体在此、与 w3-smoke 同目录），直查断言面=trade.*（sessions 物化
 * 双维度）+ platform 白名单（outbox/死信/STL）；巡检断言全走 PatrolService.runOnce() 导出面
 * （PatrolRunSummary.checkedCounts）+ MockPatrolAlertSink（供应商位内存记录）——不直查 ops.*
 * （patrol 两表 owner=ops，patrol.spec 自证）；identity/payment/settlement/benefits/pricing
 * 断言全走 REST 面/导出服务面/行为断言，禁直查他域表。跨域夹具归 owner 侧（identity/
 * lawyer-fixture、benefits/points-fixture、settlement/settlement-fixture、pricing/
 * price-change.fixture——本批新增 backdatePriceHistorySince 时间注入件）。
 *
 * noop 承接（w3-smoke 同款纪律 + W4 增量三条）：USER_REGISTERED/REAL_NAME_VERIFIED/SESSION_
 * CREATED/SESSION_FULL/GROUP_BUY_PUBLISHED/GROUP_BUY_REACHED/ENROLLMENT_PAID/SETTLEMENT_
 * HELD/SETTLEMENT_RELEASED/SPLIT_SETTLED/POINTS_GRANTED/POINTS_REDEEMED/POINTS_EXPIRED/
 * PRICE_VERSION_CREATED（消费方=H4 等 M2）+ schedule.job.fired（执行器内联承接）；
 * W4 增量：PRICE_COUPON_INSTRUCTED（F4 ②券面=M2 消费）、CREDIT_EVENT_EMITTED/RESTRICTION_
 * ISSUED（H4 限制令执行点消费=M2——段 12 C6 审批经 G1 信用消费级联产生）。
 *
 * 时间锚定：全部动态计算（slot_start/deadline 相对 Date.now()；无硬编码日期）。账号：admin/
 * 律师/用户×3 五账号全经 A1 真 /auth 链注册（虚构手机号，TRUNCATE 清场隔离）。
 */

/** 下一天（Asia/Shanghai 墙钟恒 UTC+8）：+N 天的 |ISO 时刻（动态锚定，禁硬编码日期） */
const HOUR_MS = 3_600_000;
const hoursFromNow = (h: number): Date => new Date(Date.now() + h * HOUR_MS);

/** 18 位证件号（校验位合法——A2 沙箱 MockRealnameProvider 按 GB 11643 校验位判定） */
function validIdNo(seed: string): string {
  const base = `110101199001${seed}`.slice(0, 17);
  const w = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const map = '10X98765432';
  let s = 0;
  for (let i = 0; i < 17; i += 1) s += Number(base[i]!) * w[i]!;
  return base + map[s % 11];
}

/** 烟测常量：五账号手机号（虚构）+ 律所 id（A3b firm 语义=外部律所标识，正整数即可） */
const ADMIN_PHONE = '13900006001';
const LAWYER_PHONE = '13900006002';
const USER1_PHONE = '13900006003'; // 纯现金报名 + 拼团加入者
const USER2_PHONE = '13900006004'; // 带积分报名（S1 冻结核销 + S2 流标还原）+ 拼团加入者
const USER3_PHONE = '13900006005'; // 拼团发起人
const FIRM_ID = 6701;

/** 测试密钥：randomBytes 派生——密钥零字面量出测试（w2/w3-smoke 同款） */
const testIdentityConfig = (): IdentityConfig => ({
  phoneDataKey: randomBytes(32),
  phoneBlindPepper: randomBytes(32).toString('hex'),
  jwtSecret: randomBytes(32).toString('hex'),
});
const testPaymentConfig = (): PaymentConfig => ({
  primary: {
    channel: 'wechat_ecom',
    merchantId: 'mock-wechat-mch',
    secret: randomBytes(32).toString('hex'),
  },
  backup: {
    channel: 'alipay',
    merchantId: 'mock-alipay-app',
    secret: randomBytes(32).toString('hex'),
  },
  switchWindowMs: PAYMENT_SWITCH_WINDOW_MS_DEFAULT,
});

/** 捕获式 SMS 适配器：/auth 链验证码明文取自 mock 通道捕获（w2/w3-smoke 同款） */
class CapturingSmsAdapter implements NotifyChannelAdapter {
  readonly channel = 'SMS' as const;
  readonly messages: NotifyChannelMessage[] = [];

  async send(message: NotifyChannelMessage): Promise<void> {
    this.messages.push(message);
  }

  lastCode(): string {
    const last = this.messages[this.messages.length - 1];
    const code = last?.params['code'];
    if (typeof code !== 'string') throw new Error('捕获适配器未取得验证码');
    return code;
  }
}

describe('M1-W4 链 1 正式验收（w3-smoke 冻结链重建 + C6 ⑤面覆盖段 + 巡检清零并验，需 PG）', () => {
  let pool: Pool;
  let app: INestApplication;
  let capture: CapturingSmsAdapter;
  let relay: OutboxRelayService;
  let outbox: OutboxService;
  let poolSvc: PgPoolService;
  let tokens: IdentityTokenService;
  let scheduler: SchedulerService;
  let payment: PaymentGatewayService;
  let merchants: FirmMerchantService;
  let patrol: PatrolService;
  let patrolSink: MockPatrolAlertSink;
  let paySecret: string;
  let adminToken = '';

  /** A1 全链注册（/auth/sms→/auth/verify；断言 R-02 默认 user 身份与双 token 契约） */
  async function registerBySms(phone: string): Promise<{ userId: number; token: string }> {
    const sms = await request(app.getHttpServer()).post('/auth/sms').send({ phone });
    expect(sms.status).toBe(201);
    expect(sms.body).toEqual({ ttl: 60 });
    const verify = await request(app.getHttpServer())
      .post('/auth/verify')
      .send({ phone, code: capture.lastCode(), age_declared: true });
    expect(verify.status).toBe(201);
    expect(verify.body.roles).toEqual(['user']);
    expect(verify.body.access_token.split('.')).toHaveLength(3);
    return {
      userId: Number(claimsOf(verify.body.access_token)['sub']),
      token: verify.body.access_token as string,
    };
  }

  /** 由 access_token 解 claims（w2/w3 同款） */
  function claimsOf(token: string): Record<string, unknown> {
    return JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString());
  }

  /** mock 通道回调驱动器（T1 测试件形态）：HMAC 签名覆盖发送字节原文，打真实 HTTP 入口 */
  const postCallback = (body: Record<string, unknown>): Promise<request.Response> => {
    const raw = JSON.stringify(body);
    return request(app.getHttpServer())
      .post('/callbacks/wechat_ecom')
      .set('x-payment-signature', createHmac('sha256', paySecret).update(raw).digest('hex'))
      .set('Content-Type', 'application/json')
      .send(raw);
  };

  /** platform.outbox 单 topic 行（event_id/载荷/状态；platform 白名单直查，w2 同款） */
  const outboxRowsOf = async (topic: string) => {
    const res = await pool.query<{ id: string; payload: Record<string, unknown>; status: string }>(
      `SELECT id::text AS id, payload, status FROM platform.outbox WHERE topic = $1 ORDER BY platform.outbox.id`,
      [topic],
    );
    return res.rows;
  };

  /** 关键实体状态迁移留痕（platform.state_transition_log 白名单；entity_id 十进制文本比对） */
  const stlOf = async (entityType: string, entityId: number | string) => {
    const res = await pool.query<{ from_status: string | null; to_status: string; reason: string }>(
      `SELECT from_status, to_status, reason FROM platform.state_transition_log
        WHERE entity_type = $1 AND entity_id::text = $2 ORDER BY id`,
      [entityType, String(entityId)],
    );
    return res.rows;
  };

  /** 合成事件直投（D1=M2 桩等价物；platform.outbox 白名单经基座服务同事务写入） */
  const recordEvent = async (topic: string, payload: Record<string, unknown>): Promise<void> => {
    await poolSvc.withTransaction((uow) => outbox.recordOutbox(uow, { type: topic, payload }));
  };

  /** I2 预写行为断言（deduplicated:true=同 (type,ref) 在册 PENDING/RUNNING 行存在——C1 已预写） */
  const expectJobPrewritten = async (
    jobType: string,
    refId: number,
    refType: 'session' | 'groupbuy' = 'session',
  ): Promise<void> => {
    const probe = await scheduler.registerJob(pool, {
      jobType: jobType as Parameters<SchedulerService['registerJob']>[1]['jobType'],
      refType,
      refId,
      dueAt: hoursFromNow(72),
    });
    expect(probe.deduplicated).toBe(true);
  };

  /** relay 排空（tick 至 dispatched=0；每轮 dead=0——段 12 级联链 noop 承接全绿证据） */
  const drainRelay = async (): Promise<void> => {
    for (let i = 0; i < 6; i += 1) {
      const tick = await relay.tick();
      expect(tick.dead).toBe(0);
      if (tick.dispatched === 0 && tick.retried === 0) return;
    }
    throw new Error('relay 六轮未排空（级联链异常）');
  };

  beforeAll(async () => {
    pool = await ensureTestDatabase();
    capture = new CapturingSmsAdapter();
    const payCfg = testPaymentConfig();
    paySecret = payCfg.primary.secret;
    const moduleRef = await Test.createTestingModule({
      // 全链装配（w3-smoke 同款五模块）+ PatrolModule（W4 T1：巡检执行器+五域检测件+mock sink；
      // 巡检断言经 PatrolService/MockPatrolAlertSink 导出面，禁直查 ops.*）
      imports: [
        IdentityModule,
        LawyerQualificationModule,
        LawyerAdminModule,
        TimeTableModule,
        SettlementModule,
        PatrolModule,
      ],
    })
      .overrideProvider(NOTIFY_CHANNEL_ADAPTERS)
      .useValue([capture])
      .overrideProvider(IDENTITY_CONFIG)
      .useValue(testIdentityConfig())
      .overrideProvider(PAYMENT_CONFIG)
      .useValue(payCfg)
      .compile();
    app = moduleRef.createNestApplication({ rawBody: true }); // F1 回调验签要求字节级原文
    await app.init(); // onModuleInit：A1/A3b/F2/F3/C3 消费端与执行器注册（topic 两两不冲突）
    relay = app.get(OutboxRelayService);
    outbox = app.get(OutboxService);
    poolSvc = app.get(PgPoolService);
    tokens = app.get(IdentityTokenService);
    scheduler = app.get(SchedulerService);
    payment = app.get(PaymentGatewayService);
    merchants = app.get(FirmMerchantService);
    patrol = app.get(PatrolService);
    patrolSink = app.get(MockPatrolAlertSink);

    // noop 承接（头注「noop 承接」；w3-smoke 同款——真实消费方落位时移除对应行）
    const noop = async (): Promise<void> => undefined;
    // TODO(H8/H4): USER_REGISTERED 消费方落位时移除
    relay.registerHandler(USER_REGISTERED_TOPIC, noop);
    // TODO(H4/H8): REAL_NAME_VERIFIED 消费方落位时移除
    relay.registerHandler(REAL_NAME_VERIFIED_TOPIC, noop);
    // TODO(H4/D1): SESSION_CREATED/SESSION_FULL 消费方落位时移除
    relay.registerHandler(SESSION_CREATED_TOPIC, noop);
    relay.registerHandler(SESSION_FULL_TOPIC, noop);
    // TODO(H4/C4): GROUP_BUY_PUBLISHED/GROUP_BUY_REACHED 消费方落位时移除
    relay.registerHandler(GROUP_BUY_PUBLISHED_TOPIC, noop);
    relay.registerHandler(GROUP_BUY_REACHED_TOPIC, noop);
    // TODO(H4/I1): ENROLLMENT_PAID 消费方落位时移除
    relay.registerHandler(ENROLLMENT_PAID_TOPIC, noop);
    // TODO(H4/对账): SETTLEMENT_HELD/SETTLEMENT_RELEASED/SPLIT_SETTLED 消费方落位时移除
    relay.registerHandler(SETTLEMENT_HELD_TOPIC, noop);
    relay.registerHandler(SETTLEMENT_RELEASED_TOPIC, noop);
    relay.registerHandler(SPLIT_SETTLED_TOPIC, noop);
    // TODO(H4): POINTS_GRANTED/POINTS_REDEEMED/POINTS_EXPIRED 消费方落位时移除
    relay.registerHandler(POINTS_GRANTED_TOPIC, noop);
    relay.registerHandler(POINTS_REDEEMED_TOPIC, noop);
    relay.registerHandler(POINTS_EXPIRED_TOPIC, noop);
    // TODO(H4/检索): PRICE_VERSION_CREATED 消费方落位时移除
    relay.registerHandler(PRICE_VERSION_CREATED_TOPIC, noop);
    // 执行模块消费形态：fired 事件由执行方（I2 执行器）同步内联承接——noop 承接保持 relay 全绿
    // TODO(D1/D2/D4): 生产执行域消费者落位注册同 topic 时移除（w1-smoke 同款纪律）
    relay.registerHandler(SCHEDULE_JOB_FIRED_TOPIC, noop);
    // W4 增量三条（段 12 C6 审批级联面；w3-smoke 链内不产出，段 12 起产出）
    // TODO(F4-②): PRICE_COUPON_INSTRUCTED 券面消费方落位时移除（M2）
    relay.registerHandler(PRICE_COUPON_INSTRUCTED_TOPIC, noop);
    // TODO(H4): CREDIT_EVENT_EMITTED/RESTRICTION_ISSUED 消费方落位时移除
    relay.registerHandler(CREDIT_EVENT_EMITTED_TOPIC, noop);
    relay.registerHandler(RESTRICTION_ISSUED_TOPIC, noop);
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  beforeEach(async () => {
    capture.messages.length = 0;
    await truncateAll(pool);
  });
  afterEach(async () => {
    await truncateAll(pool);
  });

  it('链 1 ①段贯通（冻结重建）→ C6 ⑤面覆盖（在团降档+补偿真发+超窗回拨）→ 巡检 runOnce 零 findings 清零并验', async () => {
    // =======================================================================
    // 段 1/2：五账号 A1 真 /auth 链注册；admin 旗标 DB 级预置（⚠W3-8）后重签 admin token
    // =======================================================================
    const admin = await registerBySms(ADMIN_PHONE);
    const lawyerReg = await registerBySms(LAWYER_PHONE);
    const user1 = await registerBySms(USER1_PHONE);
    const user2 = await registerBySms(USER2_PHONE);
    const user3 = await registerBySms(USER3_PHONE);
    expect(
      new Set([admin.userId, lawyerReg.userId, user1.userId, user2.userId, user3.userId]).size,
    ).toBe(5); // 五账号互异（断言能失败：注册串号即红）

    await grantUserRoles(pool, admin.userId, ['user', 'admin']); // admin=DB 级预置权限旗标（identity 夹具）
    adminToken = await tokens.signAccessToken({
      userId: admin.userId,
      role: 'user',
      roles: ['user', 'admin'],
    });
    expect(claimsOf(adminToken)['roles']).toEqual(expect.arrayContaining(['user', 'admin']));

    // tick#1：USER_REGISTERED×5（noop 承接）恰一次
    expect(await relay.tick()).toMatchObject({ dispatched: 5, retried: 0, dead: 0 });

    // =======================================================================
    // 段 3：H1 审核通过律师（workbench 领取→claim→approve）→A1 授 lawyer 角色
    // =======================================================================
    const submit = await request(app.getHttpServer())
      .post('/lawyer/qualification')
      .set('Authorization', `Bearer ${lawyerReg.token}`)
      .send({
        license_no: '110101199001015678',
        firm_name: '北京链验收律师事务所',
        files: [{ kind: '执业证照片', ref: 'smoke/w4-license.jpg' }],
      });
    expect(submit.status).toBe(201);
    expect(submit.body).toEqual({ status: 'SUBMITTED' });

    // G-A 接线断言（R-W3-H）：admin 面未认证 401；workbench 领取 {id}=lawyer_profiles.id
    const anonList = await request(app.getHttpServer()).get('/admin/lawyers');
    expect(anonList.status).toBe(401);
    const workbench = await request(app.getHttpServer())
      .get('/admin/lawyers')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(workbench.status).toBe(200);
    const mine = workbench.body['items'].find(
      (i: Record<string, unknown>) => i['lawyer_user_id'] === lawyerReg.userId,
    );
    expect(mine).toBeDefined(); // 断言能失败：工作台无该提交即红
    expect(mine['audit_status']).toBe('SUBMITTED');
    const profileId = mine['id'] as number;

    const claim = await request(app.getHttpServer())
      .post(`/admin/lawyers/${profileId}/audit`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ action: 'claim' });
    expect(claim.status).toBe(201);
    expect(claim.body).toEqual({ status: 'IN_REVIEW' });
    const approveAudit = await request(app.getHttpServer())
      .post(`/admin/lawyers/${profileId}/audit`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ action: 'approve' });
    expect(approveAudit.status).toBe(201);
    expect(approveAudit.body).toEqual({ status: 'PASSED' });

    // LawyerAuditPassed 同事务出箱（A3b 进件前 firm_id=null）
    const lapRows = await outboxRowsOf(LAWYER_AUDIT_PASSED_TOPIC);
    expect(lapRows).toHaveLength(1);
    expect(lapRows[0]?.payload).toMatchObject({
      lawyer_user_id: lawyerReg.userId,
      firm_id: null,
    });

    // tick#2：LAP 恰一次（双 handler 扇出：A1 授 lawyer 角色 + A3b 建进件行[firm_id=null 跳过]）
    expect(await relay.tick()).toMatchObject({ dispatched: 1, retried: 0, dead: 0 });

    // 既有 /auth 链重签：switch-role 取 DB roles（R-02 user+lawyer 双行语义）
    const switched = await request(app.getHttpServer())
      .post('/auth/switch-role')
      .set('Authorization', `Bearer ${lawyerReg.token}`)
      .send({ target_role: 'lawyer' });
    expect(switched.status).toBe(201);
    expect(claimsOf(switched.body.access_token)['role']).toBe('lawyer');
    const lawyerToken = switched.body.access_token as string;

    // =======================================================================
    // 段 4：A3b 进件 ACTIVE（admin 面→mock 通道同步 APPROVED）+ FirmMerchantActivated 出箱附验
    // =======================================================================
    const anonMerchant = await request(app.getHttpServer())
      .post(`/firms/${FIRM_ID}/merchant/submit`)
      .send({ channel: 'wechat_ecom', materials: { account: 'fixture' } });
    expect(anonMerchant.status).toBe(401); // G-A：进件面 admin 守卫
    const merchantSubmit = await request(app.getHttpServer())
      .post(`/firms/${FIRM_ID}/merchant/submit`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        channel: 'wechat_ecom',
        materials: { 对公账户: '验收-0000', 开户许可: 'smoke/w4-permit.jpg' },
      });
    expect(merchantSubmit.status).toBe(201);
    expect(merchantSubmit.body).toEqual({ status: 'ACTIVE' }); // mock 同步审核通过

    const fmaRows = await outboxRowsOf(FIRM_MERCHANT_ACTIVATED_TOPIC);
    expect(fmaRows).toHaveLength(1);
    expect(fmaRows[0]?.payload).toMatchObject({ firm_id: FIRM_ID });
    // tick#3：FirmMerchantActivated（F3 resumeForFirm 空集无操作）
    expect(await relay.tick()).toMatchObject({ dispatched: 1, retried: 0, dead: 0 });

    // =======================================================================
    // 段 5：C1 开团 ×2（B2 真加锁 + I2 预写行为断言 + SessionCreated 出箱）
    // =======================================================================
    const createSession = (body: Record<string, unknown>): Promise<request.Response> =>
      request(app.getHttpServer())
        .post('/sessions')
        .set('Authorization', `Bearer ${lawyerToken}`)
        .send(body);

    // S1 主链场：capacity 2 / per_head 100.00（开始 +72h，缺省截止=开始前 24h）
    const s1 = await createSession({
      slot_start: hoursFromNow(72).toISOString(),
      price_mode: 'per_head',
      unit_price: '100.00',
      capacity: 2,
      room_mode: 'text',
    });
    expect(s1.status).toBe(201);
    expect(s1.body.session).toMatchObject({
      status: 'CREATED',
      joined: 0,
      capacity: 2,
      session_total: '200.00', // R-04：100.00×2
      specialty: 'labor_arbitration', // 序 11.5：双维度出参增列（V33）
      city: '北京', // 律师提交未携带 city → 执业城市缺省北京（A3a 登记面）
    });
    const s1Id = s1.body.session.id as number;

    // S2 流标场：capacity 5 / 80.00（开始 +240h；报名不满流标）
    const s2 = await createSession({
      slot_start: hoursFromNow(240).toISOString(),
      price_mode: 'per_head',
      unit_price: '80.00',
      capacity: 5,
      room_mode: 'voice',
    });
    expect(s2.status).toBe(201);
    const s2Id = s2.body.session.id as number;
    expect(s2Id).not.toBe(s1Id);

    // 断言① 开团幂等（键=lawyer+slot_start）：同键同载荷重放原单（201 同 id，不重复加锁/出事件）
    const s1Replay = await createSession({
      slot_start: s1.body.session.slot_start,
      price_mode: 'per_head',
      unit_price: '100.00',
      capacity: 2,
      room_mode: 'text',
    });
    expect(s1Replay.status).toBe(201);
    expect(s1Replay.body.session.id).toBe(s1Id);
    // 断言② 同键异载荷 → 409 E_SESSION_DUP_KEY（进行中场次占段，幂等键冲突面）
    const dupKey = await createSession({
      slot_start: s1.body.session.slot_start,
      price_mode: 'per_head',
      unit_price: '100.00',
      capacity: 3, // 异载荷
      room_mode: 'text',
    });
    expect(dupKey.status).toBe(409);
    expect(dupKey.body.code).toBe(ErrorCode.SessionDuplicateKey);

    // 断言② I2 预写行为附验（deduplicated:true=在册行存在；schedule_jobs 经 I2 服务面，禁跨域直查）
    await expectJobPrewritten('ENROLL_DEADLINE', s1Id);
    await expectJobPrewritten('REMIND_24H', s1Id);
    await expectJobPrewritten('REMIND_1H', s1Id);
    await expectJobPrewritten('REMIND_10MIN', s1Id);
    await expectJobPrewritten('REMIND_1MIN', s1Id);
    await expectJobPrewritten('ROOM_OPEN', s1Id);

    // SessionCreated ×2 出箱
    const createdRows = await outboxRowsOf(SESSION_CREATED_TOPIC);
    expect(createdRows).toHaveLength(2);
    expect(createdRows.map((r) => r.payload['id'])).toEqual([s1Id, s2Id]);
    // tick#4：SESSION_CREATED×2（noop）+ SLOT_LOCKED×2（B1 缓存消费）
    expect(await relay.tick()).toMatchObject({ dispatched: 4, retried: 0, dead: 0 });

    // isAuditPassed 翻转→C1 公开列表可见性（R-02 前置）
    const listed = await request(app.getHttpServer()).get('/sessions');
    expect(listed.status).toBe(200);
    expect(listed.body.map((s: Record<string, unknown>) => s['id'])).toEqual(
      expect.arrayContaining([s1Id, s2Id]),
    );

    // 双维度物化与过滤（序 11.5 V33）：①DB 行 specialty/city 物化（该律师登记面未携带 city →
    // 兜底北京）；②?city=北京 命中该场；③?city=上海 空集（过滤真生效）
    const dimRows = await pool.query<{ specialty: string; city: string }>(
      `SELECT specialty, city FROM trade.sessions WHERE id IN ($1, $2) ORDER BY id`,
      [s1Id, s2Id],
    );
    expect(dimRows.rows).toEqual([
      { specialty: 'labor_arbitration', city: '北京' },
      { specialty: 'labor_arbitration', city: '北京' },
    ]);
    const cityHit = await request(app.getHttpServer()).get('/sessions').query({ city: '北京' });
    expect(cityHit.status).toBe(200);
    expect(cityHit.body.map((s: Record<string, unknown>) => s['id'])).toEqual(
      expect.arrayContaining([s1Id, s2Id]),
    );
    expect(cityHit.body[0]).toMatchObject({ specialty: 'labor_arbitration', city: '北京' });
    const cityMiss = await request(app.getHttpServer()).get('/sessions').query({ city: '上海' });
    expect(cityMiss.status).toBe(200);
    expect(cityMiss.body).toEqual([]); // 空集=城市过滤真生效（非形态收口摆设）

    // =======================================================================
    // 段 6：C3 报名支付成团（A2 沙箱实名→纯现金+带积分报名→回调真入 Inbox→FULL）
    // =======================================================================
    // user1/user2 实名（A2 沙箱；校验位合法证件号——MockRealnameProvider GB 11643 判定）
    for (const [name, seed, token] of [
      ['周验一', '01011', user1.token],
      ['周验二', '01022', user2.token],
    ] as const) {
      const rn = await request(app.getHttpServer())
        .post('/realname')
        .set('Authorization', `Bearer ${token}`)
        .send({ name, id_no: validIdNo(seed) });
      expect(rn.status).toBe(201);
      expect(rn.body).toEqual({ status: 'VERIFIED' });
    }

    // G1 无限制断言（admin 查询面）：两名用户均无生效限制令
    for (const uid of [user1.userId, user2.userId]) {
      const restrictions = await request(app.getHttpServer())
        .get('/credit/restrictions')
        .set('Authorization', `Bearer ${adminToken}`)
        .query({ owner_type: 'user', owner_id: String(uid) });
      expect(restrictions.status).toBe(200);
      expect(restrictions.body).toEqual([]);
    }

    // user2 积分种子（benefits 夹具；5000=50% 上限边界由 R-01 在 F4 内校验）
    await seedPointsBalance(pool, user2.userId, 20000);

    // user1 纯现金报名；user2 带积分报名（5000 积分=50.00 元，50% 边界恰触顶）
    const enroll = (uid: { token: string }, sid: number, body: Record<string, unknown>) =>
      request(app.getHttpServer())
        .post(`/sessions/${sid}/enroll`)
        .set('Authorization', `Bearer ${uid.token}`)
        .send(body);
    const e1 = await enroll(user1, s1Id, {});
    expect(e1.status).toBe(201);
    expect(e1.body.enrollment).toMatchObject({
      ref_id: s1Id,
      paid_amount: '100.00',
      cash_amount: '100.00',
      points_amount: 0,
    });
    expect(e1.body.payment_order).toMatchObject({
      biz_type: 'enroll',
      cash_amount: '100.00',
      points_amount: 0,
      total: '100.00',
      status: 'CREATED',
    });
    expect(e1.body.pay_params['mock_pay_url']).toContain('mockpay://');
    const e1Id = e1.body.enrollment.id as number;
    const o1 = e1.body.payment_order.id as number;

    const e2 = await enroll(user2, s1Id, { points_to_use: 5000 });
    expect(e2.status).toBe(201);
    expect(e2.body.enrollment).toMatchObject({
      paid_amount: '100.00',
      cash_amount: '50.00', // R-04 100:1：100.00 − 5000 分 = 50.00
      points_amount: 5000,
    });
    const o2 = e2.body.payment_order.id as number;

    // 报名幂等（键=user+ref）：同键同载荷重放原支付单（不重复 INSERT/冻结/出箱）
    const e1Replay = await enroll(user1, s1Id, {});
    expect(e1Replay.status).toBe(201);
    expect(e1Replay.body.enrollment.id).toBe(e1Id);
    expect(e1Replay.body.payment_order.id).toBe(o1);

    // mock 通道回调驱动（HTTP 真入口，HMAC 字节级验签）→ Inbox → PaymentCallbackInboxed 出箱
    const cb1 = await postCallback({
      order_id: o1,
      event_type: 'PAY_SUCCESS',
      channel_txn_no: 'MOCK-WECHAT-W4-000001',
    });
    expect(cb1.status).toBe(200);
    expect(cb1.body).toMatchObject({ inboxed: true });
    const cb2 = await postCallback({
      order_id: o2,
      event_type: 'PAY_SUCCESS',
      channel_txn_no: 'MOCK-WECHAT-W4-000002',
    });
    expect(cb2.status).toBe(200);
    expect(cb2.body).toMatchObject({ inboxed: true });

    // tick#5（游标口径链内级联，w2 同款）：4 原始（RNV×2 noop + PCI×2 真消费：markFrozen→onPaySuccess）
    // + 4 级联（成团守卫同事务出箱：SessionFull + POINTS_REDEEMED + EnrollmentPaid×2，noop 承接）
    expect(await relay.tick()).toMatchObject({ dispatched: 8, retried: 0, dead: 0 });
    expect(await relay.tick()).toMatchObject({ dispatched: 0, retried: 0, dead: 0 }); // 级联清空无残留

    // 成团断言：joined=2=capacity→FULL（R-02 满员即成团）；报名 PAID
    const s1Detail = await request(app.getHttpServer()).get(`/sessions/${s1Id}`);
    expect(s1Detail.status).toBe(200);
    expect(s1Detail.body).toMatchObject({ status: 'FULL', joined: 2, remaining: 0 });

    const fullRows = await outboxRowsOf(SESSION_FULL_TOPIC);
    expect(fullRows).toHaveLength(1);
    expect(fullRows[0]?.payload).toMatchObject({ id: s1Id, session_total: '200.00' });
    const paidRows = await outboxRowsOf(ENROLLMENT_PAID_TOPIC);
    expect(paidRows).toHaveLength(2);
    expect((await stlOf('session', s1Id)).map((r) => `${r.from_status}→${r.to_status}`)).toEqual([
      'CREATED→FULL',
    ]);

    // =======================================================================
    // 段 7：F1 业务确认（D-域 FINISHED=M2，markPaid 为合成桩等价前置——settlement.consumer.spec
    // createPaidOrder 同款形态；FROZEN→PAID 后 RoomClosed 进结算的 /pay/split 才合法）
    // =======================================================================
    const paid = await payment.markPaid(o1);
    expect(paid.status).toBe('PAID');

    // =======================================================================
    // 段 8：C2 支线（B3 配置→发布拼团 PENDING_PAYMENT 锁→加入支付达 sub_min→REACHED）
    // =======================================================================
    const putPricing = await request(app.getHttpServer())
      .put('/lawyer/pricing')
      .set('Authorization', `Bearer ${lawyerToken}`)
      .send({
        base_version: 0,
        session_total: '120.00',
        accept_min: 1,
        accept_max: 3,
        one_on_one_prices: {
          text: { per_round: '80.00' }, // R-02 通道区间：50-300 元/次
          voice: { per_15min: '100.00' }, // 100-500 元/15min
          video: { per_15min: '150.00' }, // 100-500 元/15min
        },
      });
    expect(putPricing.status).toBe(200);
    expect(putPricing.body).toMatchObject({ version: 1 });

    // 断言③ B2 真加锁跨域行为证明：S1 已锁段上经 C2B 发布（他域入口直撞 B2 唯一防线）
    // → 409 E_SLOT_TAKEN（发布事务被 23505 毒化整回滚，零业务行——W1 前置②口径）
    const onTakenSlot = await request(app.getHttpServer())
      .post('/group-buys')
      .set('Authorization', `Bearer ${user1.token}`)
      .send({
        lawyer_id: lawyerReg.userId,
        specialty: '劳动仲裁',
        slot_start: s1.body.session.slot_start,
        sub_min: 2,
        sub_max: 3,
        question_tags: ['加班费'],
      });
    expect(onTakenSlot.status).toBe(409);
    expect(onTakenSlot.body.code).toBe(ErrorCode.SlotTaken);

    const publish = await request(app.getHttpServer())
      .post('/group-buys')
      .set('Authorization', `Bearer ${user3.token}`)
      .send({
        lawyer_id: lawyerReg.userId,
        specialty: '劳动仲裁',
        slot_start: hoursFromNow(120).toISOString(),
        sub_min: 2,
        sub_max: 3,
        question_tags: ['加班费'],
      });
    expect(publish.status).toBe(201);
    expect(publish.body).toMatchObject({
      group_buy: { status: 'PUBLISHED', sub_min: 2, share_price: '60.00' }, // R-02：总价÷sub_min 固化
      share_price: '60.00',
    });
    const g1Id = publish.body.group_buy.id as number;
    expect(publish.body.payment_order.status).toBe('CREATED'); // 发起人 PENDING_PAYMENT 锁挂单

    // 断言④ 发布锁（PENDING_PAYMENT）占段：他人同段发布 → 409 E_SLOT_TAKEN（B2 唯一防线）
    const gbSlotTaken = await request(app.getHttpServer())
      .post('/group-buys')
      .set('Authorization', `Bearer ${user1.token}`)
      .send({
        lawyer_id: lawyerReg.userId,
        specialty: '劳动仲裁',
        slot_start: publish.body.group_buy.slot_start,
        sub_min: 2,
        sub_max: 3,
        question_tags: ['加班费'],
      });
    expect(gbSlotTaken.status).toBe(409);
    expect(gbSlotTaken.body.code).toBe(ErrorCode.SlotTaken);

    // user1/user2 相继加入（share_price 60.00 纯现金）→ 支付回调 → PAID 计数达 sub_min=2 → REACHED
    const join = async (uid: { token: string }, seq: number): Promise<number> => {
      const res = await request(app.getHttpServer())
        .post(`/group-buys/${g1Id}/join`)
        .set('Authorization', `Bearer ${uid.token}`)
        .send({});
      expect(res.status).toBe(201);
      expect(res.body.enrollment).toMatchObject({
        ref_type: 'groupbuy',
        ref_id: g1Id,
        cash_amount: '60.00',
        points_amount: 0,
      });
      const orderId = res.body.payment_order.id as number;
      const cb = await postCallback({
        order_id: orderId,
        event_type: 'PAY_SUCCESS',
        channel_txn_no: `MOCK-WECHAT-W4-${String(seq).padStart(6, '0')}`,
      });
      expect(cb.status).toBe(200);
      expect(cb.body).toMatchObject({ inboxed: true });
      return orderId;
    };
    await join(user1, 3);
    await join(user2, 4); // 第二笔 PAID 达 sub_min → REACHED 锁人

    // user3 实名（第三人资格，供 REACHED 拒绝断言用）
    const rn3 = await request(app.getHttpServer())
      .post('/realname')
      .set('Authorization', `Bearer ${user3.token}`)
      .send({ name: '周验三', id_no: validIdNo('01033') });
    expect(rn3.status).toBe(201);
    expect(rn3.body).toEqual({ status: 'VERIFIED' });

    // tick（游标级联）：PRICE_VERSION_CREATED + GroupBuyPublished（noop）+ SLOT_LOCKED（发布锁，B1）
    // + RNV（noop）+ PCI×2（加入支付真消费）+ 3 级联（EnrollmentPaid×2 + GroupBuyReached，noop）
    expect(await relay.tick()).toMatchObject({ dispatched: 9, retried: 0, dead: 0 });
    expect(await relay.tick()).toMatchObject({ dispatched: 0, retried: 0, dead: 0 });

    // REACHED 断言：PUBLISHED→REACHED→PENDING_LAWYER 双边留痕 + 12h job 预写附验 + 锁人拒新加入
    expect((await stlOf('group_buy', g1Id)).map((r) => `${r.from_status}→${r.to_status}`)).toEqual([
      'PUBLISHED→REACHED',
      'REACHED→PENDING_LAWYER',
    ]);
    await expectJobPrewritten('C2B_CONFIRM_TIMEOUT', g1Id, 'groupbuy');
    const gbDetail = await request(app.getHttpServer())
      .get('/group-buys')
      .query({ specialty: '劳动仲裁' });
    expect(gbDetail.status).toBe(200);
    expect(gbDetail.body).toEqual([]); // 公开列表仅 PUBLISHED——REACHED 锁人后不可见
    const reachedLocked = await request(app.getHttpServer())
      .post(`/group-buys/${g1Id}/join`)
      .set('Authorization', `Bearer ${user2.token}`)
      .send({});
    expect(reachedLocked.status).toBe(409);
    expect(reachedLocked.body.code).toBe(ErrorCode.ReachedLocked);

    // =======================================================================
    // 段 9：流标支线（S2 不满→ENROLL_DEADLINE 真执行→F2 批量退款→REFUND_RESTORE→DONE）
    // =======================================================================
    const e4 = await enroll(user2, s2Id, { points_to_use: 2000 }); // 积分场：流标断言还原额
    expect(e4.status).toBe(201);
    expect(e4.body.enrollment).toMatchObject({ cash_amount: '60.00', points_amount: 2000 });
    const o5 = e4.body.payment_order.id as number;
    const cb5 = await postCallback({
      order_id: o5,
      event_type: 'PAY_SUCCESS',
      channel_txn_no: 'MOCK-WECHAT-W4-000005',
    });
    expect(cb5.status).toBe(200);
    // tick（游标级联）：PCI o5（真消费）+ 2 级联（EnrollmentPaid + POINTS_REDEEMED 积分核销，noop）
    expect(await relay.tick()).toMatchObject({ dispatched: 3, retried: 0, dead: 0 });
    expect(await relay.tick()).toMatchObject({ dispatched: 0, retried: 0, dead: 0 });

    // ENROLL_DEADLINE 时间注入（I2 API cancel+按过去时刻重注册——schedule_jobs 禁直改先例）+ 真执行
    const cancelled = await scheduler.cancelJob(pool, {
      jobType: 'ENROLL_DEADLINE',
      refType: 'session',
      refId: s2Id,
    });
    expect(cancelled.cancelled).toBe(true);
    const reinjected = await scheduler.registerJob(pool, {
      jobType: 'ENROLL_DEADLINE',
      refType: 'session',
      refId: s2Id,
      dueAt: new Date(Date.now() - 1_000),
    });
    expect(reinjected.deduplicated).toBe(false);
    expect(await scheduler.tick('normal')).toMatchObject({
      channel: 'normal',
      done: 1,
      cancelled: 0,
      retried: 0,
      failed: 0,
    });

    // 流标断言：CREATED→FAILED + SessionFailed 出箱（reason=ENROLL_DEADLINE_PASSED）+ 锁释放
    const s2Detail = await request(app.getHttpServer()).get(`/sessions/${s2Id}`);
    expect(s2Detail.body).toMatchObject({ status: 'FAILED', joined: 1 });
    const failedRows = await outboxRowsOf(SESSION_FAILED_TOPIC);
    expect(failedRows).toHaveLength(1);
    expect(failedRows[0]?.payload).toMatchObject({ id: s2Id, reason: 'ENROLL_DEADLINE_PASSED' });

    // tick#11：SLOT_RELEASED（failOnDeadline 同事务锁释放）+ SESSION_FAILED（双 handler：
    // F2 批量退款真链受理[F1 refund 无出箱事件] + C3 PENDING 清场[无 PENDING→0]，无级联；
    // schedule.job.fired 由 noop 承接——ENROLL_DEADLINE 真执行的机制出箱
    expect(await relay.tick()).toMatchObject({ dispatched: 3, retried: 0, dead: 0 });

    // REFUND_SUCCESS 回调（通道驱动器）→ F2 收敛 DONE + RefundCompleted + R-03 还原
    const cbRefund = await postCallback({
      order_id: o5,
      event_type: 'REFUND_SUCCESS',
      channel_txn_no: 'MOCK-WECHAT-W4-000005R',
    });
    expect(cbRefund.status).toBe(200);
    expect(cbRefund.body).toMatchObject({ inboxed: true });
    // tick（游标级联）：PCI REFUND_SUCCESS（F2 收敛真消费）+ 2 级联（RefundCompleted +
    // POINTS_GRANTED=R-03 还原，noop 承接）
    expect(await relay.tick()).toMatchObject({ dispatched: 3, retried: 0, dead: 0 });
    expect(await relay.tick()).toMatchObject({ dispatched: 0, retried: 0, dead: 0 });

    // 用户面断言：/refunds/mine 恰一笔 DONE；/enrollments/mine S2=REFUNDED、S1=PAID；
    // F4 REFUND_RESTORE 还原额=2000（20000−5000 核销−2000 核销+2000 还原），冻结清零
    const refundsMine = await request(app.getHttpServer())
      .get('/refunds/mine')
      .set('Authorization', `Bearer ${user2.token}`);
    expect(refundsMine.status).toBe(200);
    expect(refundsMine.body).toHaveLength(1);
    expect(refundsMine.body[0]).toMatchObject({
      order_id: o5,
      cash_amount: '60.00',
      points_amount: 2000,
      reason: 'GROUP_FAIL',
      status: 'DONE',
      eta_text: '已原路退回',
    });
    const refundId = refundsMine.body[0]['refund_id'] as number;
    const mineList = await request(app.getHttpServer())
      .get('/enrollments/mine')
      .set('Authorization', `Bearer ${user2.token}`);
    expect(mineList.status).toBe(200);
    const byRef = new Map(
      mineList.body.map((m: Record<string, unknown>) => [`${m['ref_type']}:${m['ref_id']}`, m]),
    );
    expect(byRef.get(`session:${s2Id}`)).toMatchObject({
      status: 'REFUNDED',
      refund_status: 'REFUNDED',
    });
    expect(byRef.get(`session:${s1Id}`)).toMatchObject({ status: 'PAID', refund_status: 'NONE' });
    const pointsMine = await request(app.getHttpServer())
      .get('/points/mine')
      .set('Authorization', `Bearer ${user2.token}`);
    expect(pointsMine.status).toBe(200);
    expect(pointsMine.body['balance']).toBe(15000); // 断言能失败：R-03 还原缺失即 13000
    expect(await getPointsAccount(pool, user2.userId)).toEqual({ balance: 15000, frozen: 0 });

    // =======================================================================
    // 段 10：F3 附验（合成 RoomClosed→HOLD→A3b 挂起/恢复→时间注入→READY→SETTLED）
    // =======================================================================
    const adminSettlements = (status?: string) =>
      request(app.getHttpServer())
        .get('/admin/settlements')
        .set('Authorization', `Bearer ${adminToken}`)
        .query(status === undefined ? {} : { status });
    const anonSettlements = await request(app.getHttpServer()).get('/admin/settlements');
    expect(anonSettlements.status).toBe(401); // G-A：后台结算视图 admin 守卫
    expect((await adminSettlements()).body).toEqual([]); // 前置空态（断言能失败）

    // D1=M2 合成桩等价物：RoomClosed 直投 → 进结算 PENDING→HOLD（R-02 24h 冻结）+ job 预写。
    // gross=该支付单实际托管额（o1=user1 纯现金席 100.00）——RoomClosed 载荷与 F1 escrow 一致，
    // /pay/split 求和 ≤ 可分金额（F1 守恒）才可达 SETTLED
    await recordEvent(ROOM_CLOSED_TOPIC, {
      session_id: s1Id,
      lawyer_id: lawyerReg.userId,
      firm_id: FIRM_ID,
      gross: '100.00',
      payment_order_id: o1,
    });
    // tick（游标级联）：ROOM_CLOSED（进结算真消费）+ 1 级联（SETTLEMENT_HELD，noop 承接）
    expect(await relay.tick()).toMatchObject({ dispatched: 2, retried: 0, dead: 0 });
    const held = await adminSettlements('HOLD');
    expect(held.status).toBe(200);
    expect(held.body).toHaveLength(1);
    expect(held.body[0]).toMatchObject({
      ref_type: 'session',
      ref_id: s1Id,
      status: 'HOLD',
      hold_reason: 'HOLD_24H',
      gross: '100.00',
      platform_fee: '0.00', // fee_versions 0% 起步（D20）
      net: '100.00',
      share_mode: 'FULL_TO_LAWYER',
      payment_order_id: o1,
    });
    const settlementId = held.body[0]['id'] as number;

    // A3b 挂起分支附验：账户变更→CHANGING（分账暂停语义）→FirmMerchantSuspended→结算 SUSPENDED
    const change = await request(app.getHttpServer())
      .post(`/firms/${FIRM_ID}/merchant/change`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ materials: { 对公账户: '验收-变更-0001' } });
    expect(change.status).toBe(201);
    expect(change.body).toEqual({ status: 'CHANGING' });
    // tick（游标级联）：FIRM_MERCHANT_SUSPENDED（挂起传导真消费）+ 1 级联（SETTLEMENT_HELD noop）
    expect(await relay.tick()).toMatchObject({ dispatched: 2, retried: 0, dead: 0 });
    const suspended = await adminSettlements('SUSPENDED');
    expect(suspended.body).toHaveLength(1);
    expect(suspended.body[0]).toMatchObject({
      status: 'SUSPENDED',
      hold_reason: 'MERCHANT_NOT_ACTIVE',
    });

    // 机构应答恢复（mock merchantReview=APPROVED；F1 通道抽象服务面=机构回调承接位）→ 回 HOLD
    const refreshed = await merchants.refreshFromChannel({
      firm_id: FIRM_ID,
      channel: 'wechat_ecom',
    });
    expect(refreshed.status).toBe('ACTIVE');
    const merchantId = refreshed.id;
    // tick：FIRM_MERCHANT_ACTIVATED#2（恢复但冻结期未满 → SUSPENDED→HOLD，回hold无级联事件）
    expect(await relay.tick()).toMatchObject({ dispatched: 1, retried: 0, dead: 0 });
    const reheld = await adminSettlements('HOLD');
    expect(reheld.body).toHaveLength(1); // 恢复但冻结期未满 → SUSPENDED→HOLD（锚仍=created_at）
    expect(await adminSettlements('SUSPENDED')).toMatchObject({ body: [] });

    // 时间注入：created_at 回拨（settlement 夹具）+ job 按 I2 API 重注册为已到期 → tick 真执行
    await travelHoldCreated(pool, settlementId);
    const cancelledHold = await scheduler.cancelJob(pool, {
      jobType: 'SETTLE_HOLD_RELEASE',
      refType: 'settlement',
      refId: settlementId,
    });
    expect(cancelledHold.cancelled).toBe(true);
    await scheduler.registerJob(pool, {
      jobType: 'SETTLE_HOLD_RELEASE',
      refType: 'settlement',
      refId: settlementId,
      dueAt: new Date(Date.now() - 1_000),
    });
    expect(await scheduler.tick('normal')).toMatchObject({ done: 1, failed: 0 });
    // tick（游标级联）：SETTLEMENT_RELEASED + SPLIT_SETTLED（执行器链内 READY→split→SETTLED 出箱）
    // + schedule.job.fired（noop 承接）
    expect(await relay.tick()).toMatchObject({ dispatched: 3, retried: 0, dead: 0 });

    // SETTLED 断言：唯一解冻节点已分账（F1 单 PAID→SPLIT）+ SplitSettled 出箱 + STL 全程留痕
    const settled = await adminSettlements('SETTLED');
    expect(settled.body).toHaveLength(1);
    expect(settled.body[0]).toMatchObject({
      id: settlementId,
      status: 'SETTLED',
      escrow_status: 'SPLIT',
    });
    expect(settled.body[0]['settled_at']).not.toBeNull();
    const orderAfter = await payment.findOrderById(o1);
    expect(orderAfter?.status).toBe('SPLIT'); // R-01 唯一解冻分账节点（F1 导出只读面）
    const splitRows = await outboxRowsOf(SPLIT_SETTLED_TOPIC);
    expect(splitRows).toHaveLength(1);
    expect(splitRows[0]?.payload).toMatchObject({
      settlement_id: settlementId,
      ref_type: 'session',
      ref_id: s1Id,
      net: '100.00',
      fee: '0.00',
    });
    expect(
      (await stlOf('settlement', settlementId)).map((r) => `${r.from_status}→${r.to_status}`),
    ).toEqual(['PENDING→HOLD', 'HOLD→SUSPENDED', 'SUSPENDED→HOLD', 'HOLD→READY', 'READY→SETTLED']);

    // =======================================================================
    // 段 11：幂等收口四断言（w3-smoke 冻结形态逐字重建）
    // =======================================================================
    // ① 同一支付回调重放恰一次：重复报文 inboxed:false（双唯一去重），无新事件、席位/STL/事件不增
    const replayCb = await postCallback({
      order_id: o1,
      event_type: 'PAY_SUCCESS',
      channel_txn_no: 'MOCK-WECHAT-W4-000001',
    });
    expect(replayCb.status).toBe(200);
    expect(replayCb.body).toMatchObject({ inboxed: false, inbox_id: null });
    expect(await relay.tick()).toMatchObject({ dispatched: 0, retried: 0, dead: 0 });
    const s1AfterReplay = await request(app.getHttpServer()).get(`/sessions/${s1Id}`);
    expect(s1AfterReplay.body).toMatchObject({ status: 'FULL', joined: 2 }); // 席位不双计
    expect(await outboxRowsOf(SESSION_FULL_TOPIC)).toHaveLength(1); // 事件不增
    expect(await outboxRowsOf(ENROLLMENT_PAID_TOPIC)).toHaveLength(5);
    expect(await outboxRowsOf(PAYMENT_CALLBACK_INBOXED_TOPIC)).toHaveLength(6); // 回调事件不增

    // ② 同键退款重放恰一笔：SESSION_FAILED 重驱动（at-least-once 崩溃窗口模拟）→ F2 幂等受理重放
    await pool.query(
      `UPDATE platform.outbox SET status = 'PENDING', sent_at = NULL WHERE topic = $1`,
      [SESSION_FAILED_TOPIC],
    );
    expect(await relay.tick()).toMatchObject({ dispatched: 1, retried: 0, dead: 0 }); // 确实重投
    const refundsAfterReplay = await request(app.getHttpServer())
      .get('/refunds/mine')
      .set('Authorization', `Bearer ${user2.token}`);
    expect(refundsAfterReplay.body).toHaveLength(1); // 恰一笔（F2 原因+实体幂等键挡下二次受理）
    expect(refundsAfterReplay.body[0]).toMatchObject({ refund_id: refundId, status: 'DONE' });
    expect((await stlOf('refund', refundId)).map((r) => `${r.from_status}→${r.to_status}`)).toEqual(
      ['REQUESTED→PROCESSING', 'PROCESSING→DONE'],
    ); // STL 不增
    expect(await outboxRowsOf(REFUND_COMPLETED_TOPIC)).toHaveLength(1); // RefundCompleted 不重复

    // ③ outbox 全 SENT + 死信 0（游标口径：逐 topic 精确计数——冻结形态时点快照）
    const dead = await pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM platform.outbox_dead_letter',
    );
    expect(dead.rows[0]?.n).toBe(0);
    const allOutbox = await pool.query<{ topic: string; status: string }>(
      'SELECT topic, status FROM platform.outbox ORDER BY id',
    );
    const topicCounts = new Map<string, number>();
    for (const row of allOutbox.rows) {
      topicCounts.set(row.topic, (topicCounts.get(row.topic) ?? 0) + 1);
      expect(row.status).toBe('SENT'); // 全 SENT：无残留 PENDING/重试/死信
    }
    expect(Object.fromEntries(topicCounts)).toEqual({
      [USER_REGISTERED_TOPIC]: 5,
      [REAL_NAME_VERIFIED_TOPIC]: 3,
      [PRICE_VERSION_CREATED_TOPIC]: 1,
      [SESSION_CREATED_TOPIC]: 2,
      [SESSION_FULL_TOPIC]: 1,
      [SESSION_FAILED_TOPIC]: 1,
      [ENROLLMENT_PAID_TOPIC]: 5,
      [GROUP_BUY_PUBLISHED_TOPIC]: 1,
      [GROUP_BUY_REACHED_TOPIC]: 1,
      [LAWYER_AUDIT_PASSED_TOPIC]: 1,
      [FIRM_MERCHANT_ACTIVATED_TOPIC]: 2,
      [FIRM_MERCHANT_SUSPENDED_TOPIC]: 1,
      [PAYMENT_CALLBACK_INBOXED_TOPIC]: 6,
      [REFUND_COMPLETED_TOPIC]: 1,
      [POINTS_GRANTED_TOPIC]: 1,
      [POINTS_REDEEMED_TOPIC]: 2,
      [SETTLEMENT_HELD_TOPIC]: 2,
      [SETTLEMENT_RELEASED_TOPIC]: 1,
      [SPLIT_SETTLED_TOPIC]: 1,
      [ROOM_CLOSED_TOPIC]: 1,
      'schedule.slot.locked': 3,
      'schedule.slot.released': 1,
      'schedule.job.fired': 2, // ENROLL_DEADLINE + SETTLE_HOLD_RELEASE 真执行的机制出箱（noop 承接）
    });

    // ④ 关键实体 STL 可查（session FULL/FAILED、group_buy REACHED、settlement SETTLED、
    //    refund DONE——前三者上文已断言序列，此处收口 payment_order/firm_merchant 全程）
    expect(
      (await stlOf('payment_order', o1)).map((r) => `${r.from_status}→${r.to_status}`),
    ).toEqual(['CREATED→FROZEN', 'FROZEN→PAID', 'PAID→SPLIT']);
    expect(
      (await stlOf('payment_order', o5)).map((r) => `${r.from_status}→${r.to_status}`),
    ).toEqual(['CREATED→FROZEN', 'FROZEN→REFUNDING', 'REFUNDING→REFUNDED']);
    expect(
      (await stlOf('firm_merchant', merchantId)).map((r) => `${r.from_status}→${r.to_status}`),
    ).toEqual(['SUBMITTING→IN_REVIEW', 'IN_REVIEW→ACTIVE', 'ACTIVE→CHANGING', 'CHANGING→ACTIVE']);
    expect(
      (await stlOf('enrollment', e4.body.enrollment.id as number)).map((r) => r.to_status),
    ).toEqual(['PAID', 'REFUNDED']);

    // =======================================================================
    // 段 12（W4 增量·巡检⑤类检测面覆盖段）：C6 改价真链——在团降档→审批→补偿真发→超窗回拨
    // =======================================================================
    // 前置：credit.rules 运营配置种子（H7 免公示通道 createLexiconVersion——credit.spec seedRules
    // 同款；测试库 TRUNCATE 后无生效版本，credit.emit 将显性化抛「H7 运营配置缺口」进重试轨道，
    // 生产等价物=H7 运营配置 EFFECTIVE 版本）。段 12 C6 审批→PCA→G1 信用消费真链（-30 档附
    // SUSPEND_TAKE_3D 限制令+CREDIT_EVENT_EMITTED/RESTRICTION_ISSUED 级联，noop 承接）所需。
    await poolSvc.withTransaction((uow) =>
      app.get(RuleCenterService).createLexiconVersion(uow, {
        ruleKey: CREDIT_RULES_KEY,
        version: 1,
        content: {
          violation: {
            window_days: 30,
            threshold: 2,
            restriction_by_owner: {
              user: { kind: 'BAN_JOIN', days: 7 },
              lawyer: { kind: 'SUSPEND_TAKE_7D', days: 7 },
            },
          },
          actions: {
            lawyer_price_up: { delta: -5 },
            lawyer_price_down_le10: { delta: -15 },
            lawyer_price_down_gt10: {
              delta: -30,
              restriction: { kind: 'SUSPEND_TAKE_3D', days: 3 },
            },
          },
        },
        effectiveAt: new Date(Date.now() - 10 * 24 * HOUR_MS),
      }),
    );

    // 在团基线：S1=FULL + G1=PENDING_LAWYER（均非终态，活跃）→ hasActiveGroup=true；
    // v1 session_total 120.00 → 100.00（DOWN 16.67% > 10%）→ 在团降档=PENDING_APPROVAL（①期人工兜底）
    const changeReq = await request(app.getHttpServer())
      .post('/lawyer/pricing/change')
      .set('Authorization', `Bearer ${lawyerToken}`)
      .send({
        new_version_draft: {
          base_version: 1,
          session_total: '100.00',
          accept_min: 1,
          accept_max: 3,
          one_on_one_prices: {
            text: { per_round: '80.00' },
            voice: { per_15min: '100.00' },
            video: { per_15min: '150.00' },
          },
        },
      });
    expect(changeReq.status).toBe(201);
    expect(changeReq.body).toMatchObject({ result: 'PENDING_APPROVAL', new_version: 2 });
    const historyId = changeReq.body.history_id as number;

    // 审计面读回（GET /pricing/histories 公开读面）：恰一行 PENDING_APPROVAL/DOWN/在团
    const pendingView = await request(app.getHttpServer()).get(
      `/pricing/histories?lawyer_id=${lawyerReg.userId}`,
    );
    expect(pendingView.status).toBe(200);
    expect(pendingView.body).toEqual([
      expect.objectContaining({
        history_id: historyId,
        result: 'PENDING_APPROVAL',
        direction: 'DOWN',
        has_active_group: true,
      }),
    ]);

    // admin 审批通过（G-A 接线面）→ EFFECTED（版本链复核过，B3 落版 v2）+ 补偿真链直发
    const approval = await request(app.getHttpServer())
      .post(`/pricing/change/${historyId}/approve`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ approved: true, approval_id: 1 });
    expect(approval.status).toBe(201);
    expect(approval.body).toEqual({
      history_id: historyId,
      result: 'EFFECTED',
      approval_source: 'MANUAL',
    });

    // 补偿真发断言（F4 真链 grant COMPENSATION ref=price_change:{id}——巡检⑤类「已发」前置实证；
    // 补偿对象=user1/user2（Σpaid 各 160.00：S1 席 100 + G1 加入 60；发起人 user3 未支付不在册）：
    // （12000−10000）×16000/32000 = 1000 积分/人（floor，D17 占比分母=paid 全额口径）
    const pts1 = await request(app.getHttpServer())
      .get('/points/mine')
      .set('Authorization', `Bearer ${user1.token}`);
    expect(pts1.status).toBe(200);
    expect(pts1.body['balance']).toBe(1000);
    const pts2 = await request(app.getHttpServer())
      .get('/points/mine')
      .set('Authorization', `Bearer ${user2.token}`);
    expect(pts2.status).toBe(200);
    expect(pts2.body['balance']).toBe(16000); // 15000（段 9 终态）+1000

    // relay 排空（PCA→G1 信用消费级联 CREDIT_EVENT_EMITTED[±RESTRICTION_ISSUED] + PCI×2 券指令
    // noop + POINTS_GRANTED×2 补偿 noop——每轮 dead=0）
    await drainRelay();

    // ⑤面候选窗时间注入（owner 侧 fixture）：created_at 回拨 25h（>⑤类 24h 默认窗）——真链改价行
    // 入巡检候选集；补偿已发=不变量满足（回拨仅模拟 24h SLA 窗已过，travelHoldCreated 同款先例）
    await backdatePriceHistorySince(pool, historyId, 25 * HOUR_MS);

    // =======================================================================
    // 段 13：巡检并验（M1 退出判据「资损巡检正常链路零违例」）——五类检测面全被链数据触达，
    // runOnce 零 findings/零告警；正常链不应触发任何巡检（若触发=发现真问题，如实上报）
    // =======================================================================
    const patrolSummary = await patrol.runOnce();

    expect(patrolSummary.status).toBe('DONE');
    expect(patrolSummary.findingCount).toBe(0); // 清零并验：五类零违例
    expect(patrolSink.alerts).toEqual([]); // 零 CRITICAL 告警（dev 供应商位内存记录）
    const cc = patrolSummary.checkedCounts;
    expect(Object.keys(cc).sort()).toEqual([
      'COMPENSATION_UNPAID',
      'PAID_NOT_REFUNDED',
      'SCHED_BACKLOG',
      'SPLIT_UNCONFIRMED',
      'STALE_LOCK',
    ]);
    for (const stat of Object.values(cc)) {
      expect(stat.err).toBeUndefined(); // 五类零类级失败（单类失败隔离面未触发）
      expect(stat.findings).toBe(0); // 零违例判定
      expect(stat.inserted).toBe(0); // 零入账
    }
    // 逐类覆盖计数（清零非空转证据——正常链语义下各检测面的期望读数，头注「段 13」逐类注）
    expect(cc.PAID_NOT_REFUNDED?.checked).toBe(0); // 正常链无 PAID×退款应发起终态行（S2 流标同事务即 REFUNDED）
    expect(cc.STALE_LOCK?.checked).toBe(2); // S1 LOCKED + G1 PENDING_PAYMENT 两把活跃锁（未来段位不误报）
    expect(cc.SCHED_BACKLOG?.checked).toBe(1); // 聚合面恒 1：在册 PENDING job 全未来=零逾期
    expect(cc.SPLIT_UNCONFIRMED?.checked).toBe(0); // mock 同步确认：SPLIT/REFUND 指令均 CONFIRMED
    expect(cc.COMPENSATION_UNPAID?.checked).toBe(1); // 回拨行入候选→F4 授予流水核对通过（全路径实证）

    // 收口：巡检后 outbox 无新残留 + 死信仍 0（巡检只读不产事件；C6 段级联全绿）
    const deadFinal = await pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM platform.outbox_dead_letter',
    );
    expect(deadFinal.rows[0]?.n).toBe(0);
    const unsent = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM platform.outbox WHERE status <> 'SENT'`,
    );
    expect(unsent.rows[0]?.n).toBe(0);
  });
});
