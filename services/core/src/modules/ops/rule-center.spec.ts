import 'reflect-metadata';
import request from 'supertest';
import { ErrorCode } from '@ljr/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Pool } from 'pg';
import { ensureTestDatabase, truncateAll } from '../../infrastructure/testing/db';
import { PgPoolService } from '../../infrastructure/sql';
import { SchedulerService } from '../schedule/scheduler.service';
import { RULE_CURRENT_CACHE, InProcessRuleCurrentCache } from './rule-center.cache';
import { RULE_CENTER_DEFAULT_CONFIG } from './rule-center.config';
import { RULE_PUBLISHED_TOPIC } from './rule-center.events';
import { RULE_PUBLISH_MACHINE } from './rule-center.machine';
import { RuleCenterModule } from './rule-center.module';
import { RuleCenterService } from './rule-center.service';

/**
 * H7 规则中心 e2e（需 PG）：R-01 版本化+公示≥7日+行为时快照 / R-02 房间须知内容块 /
 * R-03 词库免公示通道 / §9 附加用例（7 日边界时间注入、快照跨版本、须知拉取、未公示直接
 * EFFECTIVE 被守卫拒绝）+ REST 契约（§5）。
 *
 * 时间注入口径：公示时刻经 submitForPublication 的 opts.now 注入（勿 sleep）——effective_at 与
 * RULE_EFFECTIVE dueAt 都由该时刻推导，注入过去时刻即模拟「时间已流逝」；tick 手动驱动
 * （SchedulerWorker 不自启动，测试隔离同 I2/B2 口径）。spec 不直连 schedule.* 表
 * （check-schema-refs 规则 A：modules/ops owner=ops）——job 读写全经 SchedulerService API。
 */

const DAY = 86_400_000;
const MIN = 60_000;

describe('H7 规则中心机制（需 PG）', () => {
  let pool: Pool;
  let app: INestApplication;
  let svc: RuleCenterService;
  let scheduler: SchedulerService;
  let poolSvc: PgPoolService;
  let cache: InProcessRuleCurrentCache;

  const ruleRow = async (ruleKey: string, version: number) => {
    const res = await pool.query<{
      id: string;
      publish_status: string;
      effective_at: Date | null;
      published_at: Date | null;
    }>(
      `SELECT id, publish_status, effective_at, published_at
         FROM ops.rule_definitions WHERE rule_key = $1 AND version = $2`,
      [ruleKey, version],
    );
    return res.rows[0];
  };

  const outboxOf = async (topic: string) => {
    const res = await pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM platform.outbox WHERE topic = $1 ORDER BY id`,
      [topic],
    );
    return res.rows;
  };

  const stlOf = async (entityId: number) => {
    const res = await pool.query<{
      from_status: string | null;
      to_status: string;
      allowed: boolean;
      reason: string | null;
    }>(
      `SELECT from_status, to_status, allowed, reason FROM platform.state_transition_log
        WHERE entity_type = 'rule_definition' AND entity_id = $1 ORDER BY id`,
      [entityId],
    );
    return res.rows;
  };

  const ruleJobs = async () => scheduler.listJobs({ jobType: 'RULE_EFFECTIVE' });

  beforeAll(async () => {
    pool = await ensureTestDatabase();
    const moduleRef = await Test.createTestingModule({ imports: [RuleCenterModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    svc = app.get(RuleCenterService);
    scheduler = app.get(SchedulerService);
    poolSvc = app.get(PgPoolService);
    cache = app.get<InProcessRuleCurrentCache>(RULE_CURRENT_CACHE);
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  beforeEach(async () => {
    await truncateAll(pool);
    cache.clear();
  });
  afterEach(async () => {
    await truncateAll(pool);
  });

  it('R-01 提交公示：DRAFT→PUBLISHED（守卫留痕）+ effective_at=+7d + RULE_EFFECTIVE job + RulePublished 同事务出箱', async () => {
    await svc.createDraft({
      ruleKey: 'price_change.rate',
      version: 1,
      content: { rate: '0.08' },
    });
    const t0 = new Date('2026-10-15T02:00:00.000Z');
    const r = await svc.submitForPublication('price_change.rate', 1, { now: t0 });

    expect(r).toMatchObject({
      ruleKey: 'price_change.rate',
      version: 1,
      deduplicated: false,
    });
    expect(r.effectiveAt.getTime()).toBe(t0.getTime() + RULE_CENTER_DEFAULT_CONFIG.publicationMs);
    const row = await ruleRow('price_change.rate', 1);
    expect(row?.publish_status).toBe('PUBLISHED');
    expect(row?.published_at?.getTime()).toBe(t0.getTime());
    expect(row?.effective_at?.getTime()).toBe(
      t0.getTime() + RULE_CENTER_DEFAULT_CONFIG.publicationMs,
    );
    // DRAFT→PUBLISHED 守卫放行留痕
    expect(await stlOf(Number(row?.id))).toEqual([
      { from_status: 'DRAFT', to_status: 'PUBLISHED', allowed: true, reason: 'submit_publication' },
    ]);
    // RULE_EFFECTIVE job 同事务注册：dueAt = effective_at + 缓冲（⚠ 双钟漂移防护，见 config 注释）
    const jobs = await ruleJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      jobType: 'RULE_EFFECTIVE',
      refType: 'rule_definition',
      status: 'PENDING',
    });
    expect(jobs[0]?.refId).toBe(Number(row?.id));
    expect(jobs[0]?.dueAt.getTime()).toBe(
      t0.getTime() +
        RULE_CENTER_DEFAULT_CONFIG.publicationMs +
        RULE_CENTER_DEFAULT_CONFIG.effectiveJobDelayMs,
    );
    // RulePublished 同事务出箱（§6 载荷逐字）
    const evt = await outboxOf(RULE_PUBLISHED_TOPIC);
    expect(evt).toHaveLength(1);
    expect(evt[0]?.payload).toEqual({
      rule_key: 'price_change.rate',
      version: 1,
      effective_at: new Date(t0.getTime() + RULE_CENTER_DEFAULT_CONFIG.publicationMs).toISOString(),
    });
  });

  it('§10/R-01 公示 7 日边界（时间注入）：6d23h 后 job 未到期 → 仍 PUBLISHED、快照不命中', async () => {
    await svc.createDraft({ ruleKey: 'credit.rules', version: 1, content: { max: 5 } });
    // 注入「6 天 23 小时前」提交 → effective_at = 现在 + 1h（job 未到期）
    const t0 = new Date(Date.now() - (7 * DAY - 60 * MIN));
    await svc.submitForPublication('credit.rules', 1, { now: t0 });

    const tick = await scheduler.tick('normal');
    expect(tick).toMatchObject({ done: 0 });

    expect((await ruleRow('credit.rules', 1))?.publish_status).toBe('PUBLISHED');
    expect(await svc.snapshotAt('credit.rules', new Date())).toBeNull();
    expect((await ruleJobs())[0]?.status).toBe('PENDING');
  });

  it('§10/R-01 公示期满自动生效：7d+ 后 tick → EFFECTIVE（守卫留痕 + 快照命中 + 现行版缓存失效）', async () => {
    await svc.createDraft({ ruleKey: 'cancellation.rules', version: 1, content: { free: 1 } });
    // 注入「7 天 + 5 分钟前」提交 → effective_at = 现在 - 5min（job 已到期：dueAt=+60s 缓冲）
    const t0 = new Date(Date.now() - 7 * DAY - 5 * MIN);
    await svc.submitForPublication('cancellation.rules', 1, { now: t0 });

    const tick = await scheduler.tick('normal');
    expect(tick).toMatchObject({ done: 1 });

    expect((await ruleRow('cancellation.rules', 1))?.publish_status).toBe('EFFECTIVE');
    expect((await ruleJobs())[0]?.status).toBe('DONE');
    // 全程留痕：提交公示（DRAFT→PUBLISHED）+ 期满生效（PUBLISHED→EFFECTIVE）
    expect(await stlOf(Number((await ruleRow('cancellation.rules', 1))?.id))).toEqual([
      { from_status: 'DRAFT', to_status: 'PUBLISHED', allowed: true, reason: 'submit_publication' },
      {
        from_status: 'PUBLISHED',
        to_status: 'EFFECTIVE',
        allowed: true,
        reason: 'rule_effective_due',
      },
    ]);
    const snap = await svc.snapshotAt('cancellation.rules', new Date());
    expect(snap).toMatchObject({
      ruleKey: 'cancellation.rules',
      version: 1,
      publishStatus: 'EFFECTIVE',
    });
    expect(snap?.content).toEqual({ free: 1 });
    // 生效迁移使现行版缓存失效：下一次 currentVersion 回源（miss 后回填）
    expect(await svc.currentVersion('cancellation.rules')).toMatchObject({ version: 1 });
    expect(cache.stats.invalidations).toBeGreaterThanOrEqual(1);
  });

  it('§9 未公示直接 EFFECTIVE 被守卫拒绝：状态机无 DRAFT→EFFECTIVE 边；到期 job 打 DRAFT 行 → recheck 判过期 CANCELLED 无操作', async () => {
    // 纯单元：机器层拒绝
    expect(() => RULE_PUBLISH_MACHINE.assertTransition('DRAFT', 'EFFECTIVE')).toThrowError(
      expect.objectContaining({ code: ErrorCode.StateIllegalTransition }),
    );
    // e2e：伪造到期 RULE_EFFECTIVE job 指向 DRAFT 行（调度误触发/重放路径）→ 不生效
    const draft = await svc.createDraft({
      ruleKey: 'disclaimer.rules',
      version: 1,
      content: { t: 1 },
    });
    await poolSvc.withTransaction(async (uow) => {
      await scheduler.registerJob(uow, {
        jobType: 'RULE_EFFECTIVE',
        refType: 'rule_definition',
        refId: draft.id,
        dueAt: new Date(Date.now() - MIN),
      });
    });
    const tick = await scheduler.tick('normal');
    expect(tick).toMatchObject({ cancelled: 1, done: 0 });
    expect((await ruleRow('disclaimer.rules', 1))?.publish_status).toBe('DRAFT');
    // 无 EFFECTIVE 放行留痕（拒绝语义=recheck 过期，非守卫拒绝，不落 allowed=false）
    expect(await stlOf(draft.id)).toEqual([]);
  });

  it('R-01/Important-2 生效窗口未到：job 提前到期 → DONE+outcome=window_not_due（不与被取代混同），规则保持 PUBLISHED 不提前生效', async () => {
    await svc.createDraft({ ruleKey: 'credit.rules', version: 1, content: { max: 5 } });
    await svc.submitForPublication('credit.rules', 1, { now: new Date() }); // effective_at = 现在+7d
    const ruleId = Number((await ruleRow('credit.rules', 1))?.id);
    // 换 job：取消原在册（due=+7d+缓冲），伪造提前到期（模拟应用钟快于 DB 钟的漂移）
    await poolSvc.withTransaction(async (uow) => {
      await scheduler.cancelJob(uow, {
        jobType: 'RULE_EFFECTIVE',
        refType: 'rule_definition',
        refId: ruleId,
      });
      await scheduler.registerJob(uow, {
        jobType: 'RULE_EFFECTIVE',
        refType: 'rule_definition',
        refId: ruleId,
        dueAt: new Date(Date.now() - MIN),
      });
    });
    // Important-2：不再 CANCELLED（与被取代混同）——走执行路径 DONE，痕迹落 job log detail
    //（schedule_job_log 断言在 rule-effective.joblog.spec——job log 归 schedule 域，跨界直查
    // 违反 check-schema-refs 规则 A；本侧断言行为面）
    const tick = await scheduler.tick('normal');
    expect(tick).toMatchObject({ done: 1, cancelled: 0 });
    expect((await ruleRow('credit.rules', 1))?.publish_status).toBe('PUBLISHED'); // 窗口未到不生效
  });

  it('R-01 行为时快照跨版本正确：按行为时刻取当时生效版本；只命中 EFFECTIVE（PUBLISHED 不命中）', async () => {
    const draftV1 = await svc.createDraft({
      ruleKey: 'price_change.rate',
      version: 1,
      content: { rate: '0.08' },
    });
    await svc.submitForPublication('price_change.rate', 1, {
      now: new Date(Date.now() - 20 * DAY), // effective_at = 13 天前
    });
    await scheduler.tick('normal');
    const draftV2 = await svc.createDraft({
      ruleKey: 'price_change.rate',
      version: 2,
      content: { rate: '0.10' },
    });
    expect(draftV2.id).toBeGreaterThan(draftV1.id);
    await svc.submitForPublication('price_change.rate', 2, {
      now: new Date(Date.now() - 10 * DAY), // effective_at = 3 天前
    });
    await scheduler.tick('normal');
    // v3 只提交未到期：保持 PUBLISHED，快照不得命中
    await svc.createDraft({ ruleKey: 'price_change.rate', version: 3, content: { rate: '0.12' } });
    await svc.submitForPublication('price_change.rate', 3, { now: new Date() });

    // 行为时刻在 v1 生效前 → 无版本
    expect(await svc.snapshotAt('price_change.rate', new Date(Date.now() - 15 * DAY))).toBeNull();
    // v1 生效后、v2 生效前 → v1
    expect(await svc.snapshotAt('price_change.rate', new Date(Date.now() - 5 * DAY))).toMatchObject(
      {
        version: 1,
        content: { rate: '0.08' },
      },
    );
    // v2 生效后 → v2（ORDER BY version DESC LIMIT 1）
    expect(await svc.snapshotAt('price_change.rate', new Date(Date.now() - DAY))).toMatchObject({
      version: 2,
      content: { rate: '0.10' },
    });
    // 现在 → 仍是 v2（v3 PUBLISHED 未生效，不命中）
    expect(await svc.snapshotAt('price_change.rate', new Date())).toMatchObject({ version: 2 });
  });

  it('§5 幂等键=key+version：草案重放（内容全等）幂等回读；内容不等 409 E_RULE_PUBLISHING；提交重放不重复出事件/注册', async () => {
    const first = await svc.createDraft({
      ruleKey: 'credit.rules',
      version: 1,
      content: { max: 5 },
    });
    const replay = await svc.createDraft({
      ruleKey: 'credit.rules',
      version: 1,
      content: { max: 5 },
    });
    expect(replay.created).toBe(false);
    expect(replay.id).toBe(first.id);
    const rows = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ops.rule_definitions WHERE rule_key = 'credit.rules'`,
    );
    expect(rows.rows[0]?.n).toBe(1);

    await expect(
      svc.createDraft({ ruleKey: 'credit.rules', version: 1, content: { max: 6 } }),
    ).rejects.toMatchObject({ code: ErrorCode.RulePublishConflict });

    await svc.submitForPublication('credit.rules', 1, { now: new Date(Date.now() - 8 * DAY) });
    const again = await svc.submitForPublication('credit.rules', 1, { now: new Date() });
    expect(again.deduplicated).toBe(true);
    expect(await outboxOf(RULE_PUBLISHED_TOPIC)).toHaveLength(1); // 不重复出事件
    expect(await ruleJobs()).toHaveLength(1); // 不重复注册 job
  });

  it('DRAFT 废弃 → ABANDONED 终态留痕；PUBLISHED 废弃被守卫拒绝（allowed=false 留痕）；废弃后提交 409', async () => {
    await svc.createDraft({ ruleKey: 'credit.rules', version: 1, content: { max: 5 } });
    const abandoned = await svc.abandonDraft('credit.rules', 1);
    expect(abandoned.publishStatus).toBe('ABANDONED');
    expect(await stlOf(abandoned.id)).toEqual([
      { from_status: 'DRAFT', to_status: 'ABANDONED', allowed: true, reason: 'abandon_draft' },
    ]);

    // PUBLISHED 不可废弃（守卫拒绝 + 拒绝留痕走独立连接）
    await svc.createDraft({ ruleKey: 'credit.rules', version: 2, content: { max: 6 } });
    await svc.submitForPublication('credit.rules', 2, { now: new Date() });
    const pub = await ruleRow('credit.rules', 2);
    await expect(svc.abandonDraft('credit.rules', 2)).rejects.toMatchObject({
      code: ErrorCode.StateIllegalTransition,
    });
    const stl = await stlOf(Number(pub?.id));
    expect(stl.at(-1)).toMatchObject({
      from_status: 'PUBLISHED',
      to_status: 'ABANDONED',
      allowed: false,
    });

    // 废弃后再提交 → 409 E_RULE_PUBLISHING
    await expect(
      svc.submitForPublication('credit.rules', 1, { now: new Date() }),
    ).rejects.toMatchObject({
      code: ErrorCode.RulePublishConflict,
    });
  });

  it('R-02/§10 房间须知内容块：无生效版 404 → v1 生效拉到 v1 → v2 生效拉到新版（缓存失效）；非法结构拒收；历史脏数据显性化', async () => {
    const key = RULE_CENTER_DEFAULT_CONFIG.noticeRuleKey;
    // 无生效版本 → NotFound
    await expect(svc.noticeContent()).rejects.toMatchObject({ code: ErrorCode.NotFound });

    // 非法结构草案：创建期校验拒收（缺 disclosures）
    await expect(
      svc.createDraft({ ruleKey: key, version: 1, content: { title: '须知', paragraphs: [] } }),
    ).rejects.toMatchObject({ code: ErrorCode.InvalidArgument });

    await svc.createDraft({
      ruleKey: key,
      version: 1,
      content: {
        title: '咨询前须知',
        paragraphs: ['请提前准备材料'],
        disclosures: ['法律意见由执业律师作出，平台提供信息技术撮合'],
      },
    });
    await svc.submitForPublication(key, 1, { now: new Date(Date.now() - 8 * DAY) });
    await scheduler.tick('normal');
    const v1 = await svc.noticeContent();
    expect(v1).toMatchObject({ ruleKey: key, version: 1 });
    expect(v1.content.disclosures).toEqual(['法律意见由执业律师作出，平台提供信息技术撮合']);

    // v2 变更 → 生效后拉到新版（现行版缓存已失效）
    await svc.createDraft({
      ruleKey: key,
      version: 2,
      content: {
        title: '咨询前须知（新版）',
        paragraphs: ['请提前准备材料', '迟到超过 15 分钟视为缺席'],
        disclosures: ['法律意见由执业律师作出，平台提供信息技术撮合'],
      },
    });
    await svc.submitForPublication(key, 2, { now: new Date(Date.now() - 8 * DAY) });
    await scheduler.tick('normal');
    const v2 = await svc.noticeContent();
    expect(v2.version).toBe(2);
    expect(v2.content.paragraphs).toHaveLength(2);

    // 历史脏数据（结构破坏）→ InternalError 显性化（不静默透传；先清缓存直打读取路径）
    await pool.query(
      `UPDATE ops.rule_definitions SET content = '{"oops":1}'::jsonb WHERE rule_key = $1 AND version = 2`,
      [key],
    );
    cache.clear();
    await expect(svc.noticeContent()).rejects.toMatchObject({ code: ErrorCode.InternalError });
  });

  it('R-03 词库免公示通道：创建即 EFFECTIVE（审计留痕）、无公示事件无生效 job、快照立即命中、同键冲突 409、预约生效', async () => {
    const t0 = new Date();
    const view = await poolSvc.withTransaction((uow) =>
      svc.createLexiconVersion(uow, {
        ruleKey: 'wordlist.industry',
        version: 1,
        content: { words: ['违规词A'] },
      }),
    );
    expect(view.publishStatus).toBe('EFFECTIVE');
    expect(view.publishedAt).toBeNull(); // 未走公示流
    expect(view.effectiveAt?.getTime()).toBeGreaterThanOrEqual(t0.getTime());
    // 等价审计：state_transition_log 显式留痕（创建即 EFFECTIVE，R-03）
    expect(await stlOf(view.id)).toEqual([
      {
        from_status: null,
        to_status: 'EFFECTIVE',
        allowed: true,
        reason: 'lexicon_publish_freeze',
      },
    ]);
    // 免公示语义：无 RulePublished、无 RULE_EFFECTIVE job
    expect(await outboxOf(RULE_PUBLISHED_TOPIC)).toHaveLength(0);
    expect(await ruleJobs()).toHaveLength(0);
    // 立即可被行为时快照/现行版命中
    expect(await svc.snapshotAt('wordlist.industry', new Date())).toMatchObject({ version: 1 });
    expect(await svc.currentVersion('wordlist.industry')).toMatchObject({ version: 1 });

    // 幂等键=key+version：同键冲突（通道同样受 UNIQUE 约束）
    await expect(
      poolSvc.withTransaction(async (uow) =>
        svc.createLexiconVersion(uow, {
          ruleKey: 'wordlist.industry',
          version: 1,
          content: { words: [] },
        }),
      ),
    ).rejects.toMatchObject({ code: ErrorCode.RulePublishConflict });

    // 预约生效：effective_at 在未来 → 行为时刻快照不提前命中
    const future = new Date(Date.now() + 10 * MIN);
    await poolSvc.withTransaction((uow) =>
      svc.createLexiconVersion(uow, {
        ruleKey: 'wordlist.industry',
        version: 2,
        content: { words: ['违规词B'] },
        effectiveAt: future,
      }),
    );
    expect(await svc.snapshotAt('wordlist.industry', new Date())).toMatchObject({ version: 1 });
    expect(
      await svc.snapshotAt('wordlist.industry', new Date(Date.now() + 20 * MIN)),
    ).toMatchObject({
      version: 2,
    });
  });

  it('GET /rules/current：current=现行生效版 + pending=公示中版本（App 规则页「即将生效」）', async () => {
    expect(await svc.currentWithPending('price_change.rate')).toEqual({
      current: null,
      pending: null,
    });
    await svc.createDraft({ ruleKey: 'price_change.rate', version: 1, content: { rate: '0.08' } });
    await svc.submitForPublication('price_change.rate', 1, { now: new Date(Date.now() - 8 * DAY) });
    await scheduler.tick('normal');
    await svc.createDraft({ ruleKey: 'price_change.rate', version: 2, content: { rate: '0.10' } });
    await svc.submitForPublication('price_change.rate', 2, { now: new Date() });

    const view = await svc.currentWithPending('price_change.rate');
    expect(view.current).toMatchObject({ version: 1, publishStatus: 'EFFECTIVE' });
    expect(view.pending).toMatchObject({ version: 2, publishStatus: 'PUBLISHED' });
  });

  it('缓存（§8 版本号失效）：现行版读命中缓存；写路径逐 key 失效', async () => {
    await svc.createDraft({ ruleKey: 'credit.rules', version: 1, content: { max: 5 } });
    await svc.submitForPublication('credit.rules', 1, { now: new Date(Date.now() - 8 * DAY) });
    await scheduler.tick('normal');
    cache.clear();

    expect(await svc.currentVersion('credit.rules')).toMatchObject({ version: 1 });
    expect(await svc.currentVersion('credit.rules')).toMatchObject({ version: 1 });
    expect(cache.stats.hits).toBe(1); // 第二次读命中（负缓存同口径）
    expect(cache.stats.misses).toBe(1);

    await svc.createDraft({ ruleKey: 'credit.rules', version: 2, content: { max: 6 } });
    await svc.submitForPublication('credit.rules', 2, { now: new Date() }); // 写路径失效 credit.rules
    expect(cache.stats.invalidations).toBe(1);
    expect(cache.get('credit.rules')).toBeUndefined(); // 已失效
  });
});

describe('H7 REST 契约（§5，需 PG）', () => {
  let pool: Pool;
  let app: INestApplication;
  let svc: RuleCenterService;
  let cache: InProcessRuleCurrentCache;

  beforeAll(async () => {
    pool = await ensureTestDatabase();
    const moduleRef = await Test.createTestingModule({ imports: [RuleCenterModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    svc = app.get(RuleCenterService);
    cache = app.get<InProcessRuleCurrentCache>(RULE_CURRENT_CACHE);
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  beforeEach(async () => {
    await truncateAll(pool);
    cache.clear();
  });
  afterEach(async () => {
    await truncateAll(pool);
  });

  it('POST /admin/rules 建草案 → 重放幂等 created:false；内容不等 409 E_RULE_PUBLISHING', async () => {
    const create = await request(app.getHttpServer())
      .post('/admin/rules')
      .send({ rule_key: 'credit.rules', version: 1, content: { max: 5 } });
    expect(create.status).toBe(200);
    expect(create.body).toMatchObject({
      ruleKey: 'credit.rules',
      version: 1,
      publishStatus: 'DRAFT',
      created: true,
    });

    const replay = await request(app.getHttpServer())
      .post('/admin/rules')
      .send({ rule_key: 'credit.rules', version: 1, content: { max: 5 } });
    expect(replay.status).toBe(200);
    expect(replay.body.created).toBe(false);

    const conflict = await request(app.getHttpServer())
      .post('/admin/rules')
      .send({ rule_key: 'credit.rules', version: 1, content: { max: 6 } });
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe('E_RULE_PUBLISHING');

    const bad = await request(app.getHttpServer())
      .post('/admin/rules')
      .send({ rule_key: 'BAD KEY!', version: 1, content: {} });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('E_INVALID_ARGUMENT');
  });

  it('POST /admin/rules/:key/publish → 200 effectiveAt；未知 404；已生效 409', async () => {
    await svc.createDraft({ ruleKey: 'credit.rules', version: 1, content: { max: 5 } });
    const publish = await request(app.getHttpServer())
      .post('/admin/rules/credit.rules/publish')
      .send({ version: 1 });
    expect(publish.status).toBe(200);
    expect(publish.body).toMatchObject({
      ruleKey: 'credit.rules',
      version: 1,
      deduplicated: false,
    });
    expect(Date.parse(publish.body.effectiveAt) - Date.now()).toBeGreaterThan(6.9 * DAY);

    const missing = await request(app.getHttpServer())
      .post('/admin/rules/credit.rules/publish')
      .send({ version: 99 });
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('E_NOT_FOUND');

    // 生效后再提交 → 409（时间注入 + tick：8 天前提交 → 已过公示期）
    await svc.createDraft({ ruleKey: 'credit.rules', version: 2, content: { max: 6 } });
    await svc.submitForPublication('credit.rules', 2, { now: new Date(Date.now() - 8 * DAY) });
    await app.get(SchedulerService).tick('normal');
    const again = await request(app.getHttpServer())
      .post('/admin/rules/credit.rules/publish')
      .send({ version: 2 });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('E_RULE_PUBLISHING');
  });

  it('POST /admin/rules/:key/abandon → 200；404；PUBLISHED 409', async () => {
    await svc.createDraft({ ruleKey: 'credit.rules', version: 1, content: { max: 5 } });
    const ok = await request(app.getHttpServer())
      .post('/admin/rules/credit.rules/abandon')
      .send({ version: 1 });
    expect(ok.status).toBe(200);
    expect(ok.body.publishStatus).toBe('ABANDONED');

    const missing = await request(app.getHttpServer())
      .post('/admin/rules/credit.rules/abandon')
      .send({ version: 9 });
    expect(missing.status).toBe(404);

    await svc.createDraft({ ruleKey: 'credit.rules', version: 2, content: { max: 6 } });
    await svc.submitForPublication('credit.rules', 2, { now: new Date() });
    const conflict = await request(app.getHttpServer())
      .post('/admin/rules/credit.rules/abandon')
      .send({ version: 2 });
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe('E_STATE_ILLEGAL_TRANSITION');
  });

  it('GET /admin/rules 列表与筛选；GET /admin/rules/:key 版本列表（version DESC）', async () => {
    await svc.createDraft({ ruleKey: 'credit.rules', version: 1, content: { max: 5 } });
    await svc.createDraft({ ruleKey: 'credit.rules', version: 2, content: { max: 6 } });
    await svc.createDraft({
      ruleKey: 'room_notice',
      version: 1,
      content: { title: '须知', paragraphs: [], disclosures: ['披露'] },
    });
    await svc.submitForPublication('credit.rules', 1, { now: new Date(Date.now() - 8 * DAY) });
    await app.get(SchedulerService).tick('normal'); // v1 已过公示期 → EFFECTIVE
    await svc.submitForPublication('credit.rules', 2, { now: new Date() });

    const all = await request(app.getHttpServer()).get('/admin/rules');
    expect(all.status).toBe(200);
    expect(all.body).toHaveLength(3);

    const byKey = await request(app.getHttpServer()).get('/admin/rules/credit.rules');
    expect(byKey.status).toBe(200);
    expect(byKey.body.map((r: { version: number }) => r.version)).toEqual([2, 1]);

    const byStatus = await request(app.getHttpServer()).get('/admin/rules?status=PUBLISHED');
    expect(byStatus.body).toHaveLength(1);
    expect(byStatus.body[0]).toMatchObject({ ruleKey: 'credit.rules', version: 2 });

    const badStatus = await request(app.getHttpServer()).get('/admin/rules?status=NOPE');
    expect(badStatus.status).toBe(400);
  });

  it('GET /rules/current、GET /rules/snapshot（行为时快照 + 非法 at 400）', async () => {
    const empty = await request(app.getHttpServer()).get('/rules/current?key=credit.rules');
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual({ current: null, pending: null });

    await svc.createDraft({ ruleKey: 'credit.rules', version: 1, content: { max: 5 } });
    await svc.submitForPublication('credit.rules', 1, { now: new Date(Date.now() - 8 * DAY) });
    await app.get(SchedulerService).tick('normal');
    await svc.createDraft({ ruleKey: 'credit.rules', version: 2, content: { max: 6 } });
    await svc.submitForPublication('credit.rules', 2, { now: new Date() });

    const current = await request(app.getHttpServer()).get('/rules/current?key=credit.rules');
    expect(current.status).toBe(200);
    expect(current.body.current).toMatchObject({ version: 1 });
    expect(current.body.pending).toMatchObject({ version: 2 });

    const snap = await request(app.getHttpServer()).get(
      `/rules/snapshot?key=credit.rules&at=${encodeURIComponent(new Date(Date.now() - DAY).toISOString())}`,
    );
    expect(snap.status).toBe(200);
    expect(snap.body.version).toBe(1);

    const badAt = await request(app.getHttpServer()).get(
      '/rules/snapshot?key=credit.rules&at=not-a-date',
    );
    expect(badAt.status).toBe(400);

    const badKey = await request(app.getHttpServer()).get('/rules/current?key=');
    expect(badKey.status).toBe(400);
  });

  it('GET /rooms/notice-content：200 内容结构 / 404 无生效版', async () => {
    const missing = await request(app.getHttpServer()).get('/rooms/notice-content');
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('E_NOT_FOUND');

    await svc.createDraft({
      ruleKey: 'room_notice',
      version: 1,
      content: { title: '须知', paragraphs: ['p1'], disclosures: ['披露'] },
    });
    await svc.submitForPublication('room_notice', 1, { now: new Date(Date.now() - 8 * DAY) });
    await app.get(SchedulerService).tick('normal');

    const res = await request(app.getHttpServer()).get('/rooms/notice-content?key=room_notice');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ruleKey: 'room_notice',
      version: 1,
      content: { title: '须知', paragraphs: ['p1'], disclosures: ['披露'] },
    });
  });
});
