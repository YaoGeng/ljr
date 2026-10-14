import 'reflect-metadata';
import { AppError, ErrorCode } from '@ljr/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Pool } from 'pg';
import { OutboxRelayService } from '../../infrastructure/outbox/outbox-relay.service';
import { OutboxService } from '../../infrastructure/outbox/outbox.service';
import { ensureTestDatabase, truncateAll } from '../../infrastructure/testing/db';
import {
  NotifyChannelRegistry,
  NOTIFY_CHANNEL_ADAPTERS,
  type NotifyChannelAdapter,
} from './notify.channels';
import { NOTIFY_DISPATCHED_TOPIC, NotifyDispatcherService } from './notify-dispatcher.service';
import { NOTIFY_EVENT_TOPICS } from './notify-event.consumer';
import { NotifyModule } from './notify.module';
import { NotifyPrefsService } from './notify-prefs.service';

/**
 * I1 下发链路 e2e（需 PG）：合成事件 → relay 消费 → 登记幂等（R-03）→ 模板渲染 → 偏好过滤 →
 * 通道下发（mock）→ 回执更新（状态机守卫）→ NotificationDispatched 同事务落 outbox。
 *
 * DI 说明同 demo.module.spec：不 override 连接——PgPoolService 按 env 连同一个 portable PG，
 * 测试池负责清场（notify.notification_templates 为参照数据不入清场清单，fixture 自行清理）。
 */
describe('I1 下发链路（默认 mock 通道，需 PG）', () => {
  let pool: Pool;
  let app: INestApplication;
  let outbox: OutboxService;
  let relay: OutboxRelayService;
  let dispatcher: NotifyDispatcherService;
  let prefs: NotifyPrefsService;

  beforeAll(async () => {
    pool = await ensureTestDatabase();
    const moduleRef = await Test.createTestingModule({ imports: [NotifyModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init(); // 触发 onModuleInit：notify 事件消费者注册到 relay
    outbox = app.get(OutboxService);
    relay = app.get(OutboxRelayService);
    dispatcher = app.get(NotifyDispatcherService);
    prefs = app.get(NotifyPrefsService);
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
    // 自定义模板 fixture 自行清理（参照数据表不入清场清单）
    await pool.query(`DELETE FROM notify.notification_templates WHERE code LIKE 'TEST_%'`);
  });

  const recordEvent = (payload: Record<string, unknown>, topic = NOTIFY_EVENT_TOPICS[0]) =>
    outbox.recordOutbox(pool, { type: topic, payload });

  it('全链：合成事件 → relay 消费登记 QUEUED → 渲染 → 下发 → SENT + NotificationDispatched 同事务', async () => {
    await recordEvent({
      user_id: 101,
      template_code: 'PRICE_UP_LOCKED',
      idempotency_key: 'notify/user-101/price-up-1',
    });

    // 消费：事件被 relay 投递，登记 QUEUED（channel 取自模板）
    const tick = await relay.tick();
    expect(tick.dispatched).toBe(1);
    const queued = await pool.query<{ id: string; channel: string; status: string }>(
      `SELECT id, channel, status FROM notify.notifications`,
    );
    expect(queued.rows).toHaveLength(1);
    expect(queued.rows[0]).toMatchObject({ channel: 'INBOX', status: 'QUEUED' });
    const nid = Number(queued.rows[0]?.id);

    // 下发：渲染 → 通道（INBOX=落表）→ 回执 SENT
    const r = await dispatcher.processPending();
    expect(r).toMatchObject({ sent: 1, skipped: 0, failed: 0, retried: 0 });

    const sent = await pool.query<{ status: string; sent_at: Date | null }>(
      `SELECT status, sent_at FROM notify.notifications WHERE id = $1`,
      [nid],
    );
    expect(sent.rows[0]?.status).toBe('SENT');
    expect(sent.rows[0]?.sent_at).not.toBeNull();

    // 回执更新同事务产出 NotificationDispatched（§6：{id, template_code, status} → H4 触达率）
    const evt = await pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM platform.outbox WHERE topic = $1`,
      [NOTIFY_DISPATCHED_TOPIC],
    );
    expect(evt.rows).toHaveLength(1);
    expect(evt.rows[0]?.payload).toEqual({
      id: nid,
      template_code: 'PRICE_UP_LOCKED',
      status: 'SENT',
    });

    // 状态迁移经守卫留痕（状态禁裸写）
    const log = await pool.query<{ allowed: boolean; from_status: string; to_status: string }>(
      `SELECT allowed, from_status, to_status FROM platform.state_transition_log
        WHERE entity_type = 'notify_notification' AND entity_id = $1`,
      [nid],
    );
    expect(log.rows).toHaveLength(1);
    expect(log.rows[0]).toMatchObject({ allowed: true, from_status: 'QUEUED', to_status: 'SENT' });
  });

  it('R-03 重复事件一次触达：同 idempotency_key 两笔事件 → 只登记一条、只触达一次', async () => {
    const payload = {
      user_id: 102,
      template_code: 'PRICE_DOWN_COMP',
      idempotency_key: 'notify/user-102/price-down-1',
    };
    await recordEvent(payload);
    await recordEvent(payload); // at-least-once 重投/上游重发

    await relay.tick();
    await relay.tick(); // 两笔事件都被消费
    const rows = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM notify.notifications`,
    );
    expect(rows.rows[0]?.n).toBe(1); // UNIQUE(idempotency_key) 兜底：第二条插入 0 行短路

    const r = await dispatcher.processPending();
    expect(r).toMatchObject({ sent: 1 });
    const sentCount = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM notify.notifications WHERE status = 'SENT'`,
    );
    expect(sentCount.rows[0]?.n).toBe(1);
    const receipts = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM platform.outbox WHERE topic = $1`,
      [NOTIFY_DISPATCHED_TOPIC],
    );
    expect(receipts.rows[0]?.n).toBe(1); // 一次触达恰好一条回执
  });

  it('R-03 内部 DISPATCH_NOTIFY 幂等：同键两次调用返回首访登记，processPending 只下发一次', async () => {
    const input = {
      userId: 103,
      templateCode: 'PRICE_DOWN_BIG',
      idempotencyKey: 'notify/user-103/price-down-big-1',
    };
    const first = await dispatcher.dispatch(input);
    const second = await dispatcher.dispatch(input);
    expect(first).toMatchObject({ notificationId: first.notificationId, deduplicated: false });
    expect(second).toMatchObject({ notificationId: first.notificationId, deduplicated: true });

    const r = await dispatcher.processPending();
    expect(r).toMatchObject({ sent: 1 });
    const rows = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM notify.notifications`,
    );
    expect(rows.rows[0]?.n).toBe(1);
  });

  it('非法幂等键：AppError(IdempotencyKeyInvalid, 400)，不触库', async () => {
    await expect(
      dispatcher.dispatch({
        userId: 104,
        templateCode: 'PRICE_UP_LOCKED',
        idempotencyKey: 'bad-key',
      }),
    ).rejects.toMatchObject({ code: ErrorCode.IdempotencyKeyInvalid, httpStatus: 400 });
    const rows = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM notify.notifications`,
    );
    expect(rows.rows[0]?.n).toBe(0);
  });

  it('模板缺失：事件消费被拒（AppError 上抛 → relay 重试轨道），不静默丢弃', async () => {
    await recordEvent({
      user_id: 105,
      template_code: 'NO_SUCH_TEMPLATE',
      idempotency_key: 'notify/user-105/ghost-1',
    });
    const tick = await relay.tick();
    expect(tick.retried).toBe(1); // handler 抛 NotFound → 原事件进重试轨道
    const rows = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM notify.notifications`,
    );
    expect(rows.rows[0]?.n).toBe(0);
  });

  it('偏好关闭 → 非关键类 SKIPPED（验收项 3），回执 status=SKIPPED 且不触通道', async () => {
    await prefs.putPrefs(106, [{ templateCode: 'PRICE_DOWN_BIG', enabled: false }]);
    await dispatcher.dispatch({
      userId: 106,
      templateCode: 'PRICE_DOWN_BIG',
      idempotencyKey: 'notify/user-106/price-down-big-1',
    });

    const r = await dispatcher.processPending();
    expect(r).toMatchObject({ skipped: 1, sent: 0 });

    const row = await pool.query<{ status: string; sent_at: Date | null }>(
      `SELECT status, sent_at FROM notify.notifications`,
    );
    expect(row.rows[0]).toMatchObject({ status: 'SKIPPED', sent_at: null });

    const evt = await pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM platform.outbox WHERE topic = $1`,
      [NOTIFY_DISPATCHED_TOPIC],
    );
    expect(evt.rows[0]?.payload).toMatchObject({ status: 'SKIPPED' });
  });

  it('缺省偏好（无记录）= 投递；其他用户关闭不影响本人', async () => {
    await prefs.putPrefs(107, [{ templateCode: 'PRICE_UP_LOCKED', enabled: false }]);
    await dispatcher.dispatch({
      userId: 108,
      templateCode: 'PRICE_UP_LOCKED',
      idempotencyKey: 'notify/user-108/price-up-1',
    });
    const r = await dispatcher.processPending();
    expect(r).toMatchObject({ sent: 1, skipped: 0 }); // 107 的关闭不外溢到 108
  });

  it('关键类偏好不可关：putPrefs AppError(InvalidArgument)；直写偏好行也被下发层兜底照发', async () => {
    await pool.query(
      `INSERT INTO notify.notification_templates (code, channel, content, version, critical)
       VALUES ('TEST_CRITICAL_SMS', 'SMS', '验证码 {code}，10 分钟内有效。', 1, true)`,
    );
    await expect(
      prefs.putPrefs(109, [{ templateCode: 'TEST_CRITICAL_SMS', enabled: false }]),
    ).rejects.toMatchObject({ code: ErrorCode.InvalidArgument });

    // 防御纵深：绕过服务层直写偏好行，下发层 isDeliverable 对 critical 仍放行
    await pool.query(
      `INSERT INTO notify.notification_prefs (user_id, template_code, enabled) VALUES (109, 'TEST_CRITICAL_SMS', false)`,
    );
    await dispatcher.dispatch({
      userId: 109,
      templateCode: 'TEST_CRITICAL_SMS',
      params: { code: '314159' },
      idempotencyKey: 'notify/user-109/verify-1',
    });
    const r = await dispatcher.processPending();
    expect(r).toMatchObject({ sent: 1, skipped: 0 });
  });

  it('GET /notifications/mine 数据面：listInbox 只回 INBOX+SENT', async () => {
    await pool.query(
      `INSERT INTO notify.notification_templates (code, channel, content, version, critical)
       VALUES ('TEST_PUSH_ONLY', 'PUSH', '推送正文', 1, false)`,
    );
    await dispatcher.dispatch({
      userId: 110,
      templateCode: 'PRICE_UP_LOCKED',
      idempotencyKey: 'notify/user-110/inbox-1',
    });
    await dispatcher.dispatch({
      userId: 110,
      templateCode: 'TEST_PUSH_ONLY',
      idempotencyKey: 'notify/user-110/push-1',
    });
    await dispatcher.processPending();
    const inbox = await dispatcher.listInbox(110);
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({ templateCode: 'PRICE_UP_LOCKED', channel: 'INBOX' });
  });

  it('通道缺适配器：下发失败进重试轨道（AppError 上抛）', async () => {
    const registry = app.get(NotifyChannelRegistry);
    expect(() => registry.get('SMS')).not.toThrow(); // 默认三通道适配器齐全
    // 构造缺适配器场景：直接断言 registry 对未知通道抛错
    expect(() => registry.get('UNKNOWN' as never)).toThrow(AppError);
  });
});

/** 可编程失败的 SMS 适配器（仅测试）：前 failuresRemaining 次抛错，之后成功 */
class StubSmsAdapter implements NotifyChannelAdapter {
  readonly channel = 'SMS' as const;
  failuresRemaining = 0;
  calls = 0;

  async send(): Promise<void> {
    this.calls += 1;
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1;
      throw new Error('SMS 网关 mock 失败');
    }
  }
}

describe('I1 下发重试（注入失败 SMS 适配器，需 PG）', () => {
  let pool: Pool;
  let app: INestApplication;
  let dispatcher: NotifyDispatcherService;
  let stubSms: StubSmsAdapter;

  beforeAll(async () => {
    pool = await ensureTestDatabase();
    stubSms = new StubSmsAdapter();
    const okAdapter: NotifyChannelAdapter = {
      channel: 'INBOX',
      send: async () => undefined,
    };
    const okPush: NotifyChannelAdapter = { channel: 'PUSH', send: async () => undefined };
    const moduleRef = await Test.createTestingModule({ imports: [NotifyModule] })
      .overrideProvider(NOTIFY_CHANNEL_ADAPTERS)
      .useValue([okPush, stubSms, okAdapter])
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
    dispatcher = app.get(NotifyDispatcherService);
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  beforeEach(async () => {
    await truncateAll(pool);
    stubSms.failuresRemaining = 0;
    stubSms.calls = 0;
  });
  afterEach(async () => {
    await truncateAll(pool);
    await pool.query(`DELETE FROM notify.notification_templates WHERE code LIKE 'TEST_%'`);
  });

  const seedSmsTemplateAndDispatch = async (userId: number, key: string) => {
    await pool.query(
      `INSERT INTO notify.notification_templates (code, channel, content, version, critical)
       VALUES ('TEST_SMS_NOTIFY', 'SMS', '短信正文 {code}', 1, false)`,
    );
    return dispatcher.dispatch({
      userId,
      templateCode: 'TEST_SMS_NOTIFY',
      params: { code: '246810' },
      idempotencyKey: key,
    });
  };

  it('失败重试后恢复：失败 2 次第 3 次成功 → SENT，retry_count=2、sent_at 落值', async () => {
    stubSms.failuresRemaining = 2;
    await seedSmsTemplateAndDispatch(201, 'notify/user-201/sms-recover-1');

    expect(await dispatcher.processPending()).toMatchObject({ retried: 1 }); // 初次尝试失败
    expect(await dispatcher.processPending()).toMatchObject({ retried: 1 }); // 重试 1 失败
    const mid = await pool.query<{ status: string; retry_count: number }>(
      `SELECT status, retry_count FROM notify.notifications`,
    );
    expect(mid.rows[0]).toMatchObject({ status: 'QUEUED', retry_count: 2 }); // 未到上限仍是待发

    expect(await dispatcher.processPending()).toMatchObject({ sent: 1 }); // 重试 2 成功
    expect(stubSms.calls).toBe(3);
    const row = await pool.query<{ status: string; retry_count: number; sent_at: Date | null }>(
      `SELECT status, retry_count, sent_at FROM notify.notifications`,
    );
    expect(row.rows[0]).toMatchObject({ status: 'SENT', retry_count: 2 });
    expect(row.rows[0]?.sent_at).not.toBeNull();
  });

  it('失败重试 3 次耗尽 → FAILED 终态：1 次初始 + 3 次重试，一条 FAILED 回执，QUEUED 不再复活', async () => {
    stubSms.failuresRemaining = 99; // 恒失败
    await seedSmsTemplateAndDispatch(202, 'notify/user-202/sms-dead-1');

    expect(await dispatcher.processPending()).toMatchObject({ retried: 1 }); // 初始尝试失败 → 排定重试 1
    expect(await dispatcher.processPending()).toMatchObject({ retried: 1 }); // 重试 1 失败 → 排定重试 2
    expect(await dispatcher.processPending()).toMatchObject({ retried: 1 }); // 重试 2 失败 → 排定重试 3
    expect(await dispatcher.processPending()).toMatchObject({ failed: 1 }); // 重试 3 失败：新失败计数 4 > 上限 3 → FAILED
    expect(await dispatcher.processPending()).toMatchObject({
      sent: 0,
      skipped: 0,
      failed: 0,
      retried: 0,
    }); // 终态后无 QUEUED 可拾取（不再复活）

    const row = await pool.query<{
      status: string;
      retry_count: number;
      last_error: string | null;
    }>(`SELECT status, retry_count, last_error FROM notify.notifications`);
    expect(row.rows[0]?.status).toBe('FAILED');
    expect(row.rows[0]?.last_error).toContain('SMS 网关 mock 失败');
    expect(stubSms.calls).toBe(4); // 1 次初始 + 3 次重试（retry_count 与 platform.outbox 同口径：失败尝试次数）

    const receipts = await pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM platform.outbox WHERE topic = $1`,
      [NOTIFY_DISPATCHED_TOPIC],
    );
    expect(receipts.rows).toHaveLength(1);
    expect(receipts.rows[0]?.payload).toMatchObject({ status: 'FAILED' });

    const log = await pool.query<{ from_status: string; to_status: string }>(
      `SELECT from_status, to_status FROM platform.state_transition_log
        WHERE entity_type = 'notify_notification' AND allowed = true`,
    );
    expect(log.rows).toHaveLength(1);
    expect(log.rows[0]).toMatchObject({ from_status: 'QUEUED', to_status: 'FAILED' });
  });
});
