import 'reflect-metadata';
import request from 'supertest';
import { ErrorCode } from '@ljr/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Pool } from 'pg';
import { ensureTestDatabase, truncateAll } from '../../infrastructure/testing/db';
import { SchedulerService } from '../schedule/scheduler.service';
import { RULE_CURRENT_CACHE, InProcessRuleCurrentCache } from './rule-center.cache';
import { RULE_PUBLISHED_TOPIC } from './rule-center.events';
import { WordDictAutomatonCache } from './word-dict.cache';
import { DICTIONARY_UPDATED_TOPIC } from './word-dict.events';
import { WordDictModule } from './word-dict.module';
import { WordDictService } from './word-dict.service';

/**
 * H5 风控与敏感词管理——W1 词库切片 e2e（需 PG）：
 * R-01 双词库+分级处置 / R-02 统一链路（单 API 入口断言）/ R-03 词库版本化免公示（走 H7）/
 * R-05 专项词表（私下交易引导）+ §9 附加用例（三动作分级、热更新版本号即时失效、同步异步双路
 * 的同步路=本 API；异步复核 M2 后置不建）+ E1 硬拦词集消费接口 + §5 REST 契约。
 *
 * 测试词全部为明显虚构样例（真实运营词库由 M2 后台配置，git 无词库明文——H5 §9 禁止事项口径）。
 * spec 不直连 schedule.* 表（check-schema-refs 规则 A）——job 断言全经 SchedulerService API。
 */

describe('H5 词库切片机制（需 PG）', () => {
  let pool: Pool;
  let app: INestApplication;
  let svc: WordDictService;
  let scheduler: SchedulerService;
  let cache: WordDictAutomatonCache;
  // H7 现行版缓存（进程内）：truncateAll 清 DB 后必须同清，否则版本号比对取到陈旧现行版
  let ruleCache: InProcessRuleCurrentCache;

  const put = (
    dictType: 'illegal_content' | 'legal_industry',
    baseVersion: number,
    words: { word: string; action: 'BLOCK' | 'REVIEW' | 'MARK' }[],
  ) => svc.putDictionary({ dictType, baseVersion, words });

  const ruleRow = async (ruleKey: string, version: number) => {
    const res = await pool.query<{
      id: string;
      content: Record<string, unknown>;
      publish_status: string;
      effective_at: Date | null;
      published_at: Date | null;
    }>(
      `SELECT id, content, publish_status, effective_at, published_at
         FROM ops.rule_definitions WHERE rule_key = $1 AND version = $2`,
      [ruleKey, version],
    );
    return res.rows[0];
  };

  const riskRows = async () => {
    const res = await pool.query<{
      id: string;
      message_id: string | null;
      conversation_id: string | null;
      dict_type: string;
      word_hits: Record<string, unknown>[];
      action: string;
      reviewed_by: string | null;
      reviewed_at: Date | null;
    }>(`SELECT * FROM ops.risk_records ORDER BY id`);
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

  const outboxOf = async (topic: string) => {
    const res = await pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM platform.outbox WHERE topic = $1 ORDER BY id`,
      [topic],
    );
    return res.rows;
  };

  beforeAll(async () => {
    pool = await ensureTestDatabase();
    const moduleRef = await Test.createTestingModule({ imports: [WordDictModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    svc = app.get(WordDictService);
    scheduler = app.get(SchedulerService);
    cache = app.get(WordDictAutomatonCache);
    ruleCache = app.get<InProcessRuleCurrentCache>(RULE_CURRENT_CACHE);
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  beforeEach(async () => {
    await truncateAll(pool);
    cache.clear();
    ruleCache.clear();
  });
  afterEach(async () => {
    await truncateAll(pool);
  });

  it('R-01 双词库+分级处置：一次判定命中两库多词，聚合取最高 severity；REVIEW 命中落 risk_records（每库一行）', async () => {
    await put('illegal_content', 0, [{ word: '诈骗退款', action: 'BLOCK' }]);
    await put('legal_industry', 0, [
      { word: '包赢', action: 'REVIEW' },
      { word: '内部渠道', action: 'MARK' },
    ]);
    const r = await svc.checkRisk({
      conversationId: 11,
      content: '这个方案包赢，走内部渠道，否则诈骗退款',
    });
    // 聚合=命中里最高 severity（BLOCK>REVIEW>MARK）；hits 按 severity 降序、同 severity 按词序
    expect(r.action).toBe('BLOCK');
    expect(r.hits).toEqual([
      { word: '诈骗退款', action: 'BLOCK', dictType: 'illegal_content' },
      { word: '包赢', action: 'REVIEW', dictType: 'legal_industry' },
      { word: '内部渠道', action: 'MARK', dictType: 'legal_industry' },
    ]);
    // §5「无副作用判定+REVIEW 记录」：只落 REVIEW 命中行（legal_industry 一行，带词库版本审计位）
    const rows = await riskRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      message_id: null,
      conversation_id: '11',
      dict_type: 'legal_industry',
      action: 'REVIEW',
      reviewed_by: null,
      reviewed_at: null,
    });
    expect(rows[0]?.word_hits).toEqual([{ word: '包赢', action: 'REVIEW', rule_version: 1 }]);
  });

  it('§9 三动作分级：BLOCK/REVIEW/MARK/PASS 各自聚合正确；仅 REVIEW 落记录', async () => {
    await put('illegal_content', 0, [{ word: '违禁甲', action: 'BLOCK' }]);
    await put('legal_industry', 0, [
      { word: '话术乙', action: 'REVIEW' },
      { word: '话术丙', action: 'MARK' },
    ]);
    expect(await svc.checkRisk({ content: '提到违禁甲的文本' })).toMatchObject({
      action: 'BLOCK',
      hits: [{ word: '违禁甲', action: 'BLOCK', dictType: 'illegal_content' }],
    });
    expect(await svc.checkRisk({ content: '提到话术丙的文本' })).toMatchObject({
      action: 'MARK',
      hits: [{ word: '话术丙', action: 'MARK', dictType: 'legal_industry' }],
    });
    expect((await riskRows()).length).toBe(0); // BLOCK/MARK 不入人审记录

    expect(await svc.checkRisk({ content: '提到话术乙的文本' })).toMatchObject({
      action: 'REVIEW',
    });
    expect((await riskRows()).length).toBe(1);

    expect(await svc.checkRisk({ content: '完全正常的咨询文本' })).toEqual({
      action: 'PASS',
      hits: [],
    });
    expect((await riskRows()).length).toBe(1);
  });

  it('R-02 统一链路=单 API 入口：房间/私聊/1对1 上下文走同一 checkRisk，判定与会话上下文无关；记录按上下文分立', async () => {
    await put('legal_industry', 0, [{ word: '包赢', action: 'REVIEW' }]);
    const contexts = [101, 202, 303]; // 房间/私聊/1对1（W1 仅作上下文锚点，D5 M2 接入真实链路）
    const results = [];
    for (const conversationId of contexts) {
      results.push(await svc.checkRisk({ conversationId, content: '包赢话术样例' }));
    }
    // 同一文本判定一致（链路统一：判定不因会话形态分叉）
    expect(results[0]).toEqual(results[1]);
    expect(results[1]).toEqual(results[2]);
    expect(results[0]?.action).toBe('REVIEW');
    // 每次调用独立落记录（人审队列按会话定位，M2 消费）
    const rows = await riskRows();
    expect(rows.map((r) => r.conversation_id)).toEqual(['101', '202', '303']);
  });

  it('R-03 词库热更新走 H7 版本化：正文落 rule_definitions（wordlist.*）+ lexicon_publish_freeze 审计，无公示事件无生效 job', async () => {
    const t0 = new Date();
    const r = await put('legal_industry', 0, [
      { word: '包赢', action: 'REVIEW' },
      { word: 'GUARANTEED', action: 'BLOCK' },
    ]);
    expect(r.version).toBe(1);
    // 词库正文即 H7 规则内容（R14 裁决：版本化唯一事实源=rule_definitions）
    const row = await ruleRow('wordlist.legal_industry', 1);
    expect(row?.publish_status).toBe('EFFECTIVE');
    expect(row?.published_at).toBeNull(); // 未走公示流
    expect(row?.effective_at?.getTime()).toBeGreaterThanOrEqual(t0.getTime());
    // 正文规范化：小写规范形 + 按 word 升序（集合语义，幂等重放全等判定确定）
    expect(row?.content).toEqual({
      words: [
        { word: 'guaranteed', action: 'BLOCK' },
        { word: '包赢', action: 'REVIEW' },
      ],
    });
    // 免公示通道等价审计：state_transition_log 显式留痕
    expect(await stlOf(Number(row?.id))).toEqual([
      {
        from_status: null,
        to_status: 'EFFECTIVE',
        allowed: true,
        reason: 'lexicon_publish_freeze',
      },
    ]);
    // 免公示语义：无 RulePublished、无 RULE_EFFECTIVE job
    expect(await outboxOf(RULE_PUBLISHED_TOPIC)).toHaveLength(0);
    expect(await scheduler.listJobs({ jobType: 'RULE_EFFECTIVE' })).toHaveLength(0);
  });

  it('R-05 专项词表：私下交易/加微信/个人收款引导词命中即 BLOCK/REVIEW 分级处置', async () => {
    await put('legal_industry', 0, [
      { word: '私下收款', action: 'BLOCK' },
      { word: '加微信', action: 'BLOCK' },
      { word: '个人收款', action: 'REVIEW' },
    ]);
    const r = await svc.checkRisk({ content: '可以加微信私下收款吗' });
    expect(r.action).toBe('BLOCK');
    expect(r.hits).toEqual([
      { word: '加微信', action: 'BLOCK', dictType: 'legal_industry' },
      { word: '私下收款', action: 'BLOCK', dictType: 'legal_industry' },
    ]);
    const r2 = await svc.checkRisk({ content: '建议走个人收款' });
    expect(r2.action).toBe('REVIEW');
    expect((await riskRows()).length).toBe(1);
  });

  it('§9 热更新 1min 内生效（版本号驱动即时失效）：v1 命中 → v2 移除旧词新增新词 → 判定即时切换（无 sleep）', async () => {
    await put('illegal_content', 0, [{ word: '旧违禁词', action: 'BLOCK' }]);
    expect(await svc.checkRisk({ content: '包含旧违禁词的文本' })).toMatchObject({
      action: 'BLOCK',
    });
    // v2：旧词移除、新词加入（base_version=1）
    await put('illegal_content', 1, [{ word: '新违禁词', action: 'BLOCK' }]);
    const r2 = await svc.checkRisk({ content: '包含旧违禁词与新违禁词的文本' });
    expect(r2.action).toBe('BLOCK');
    expect(r2.hits).toEqual([{ word: '新违禁词', action: 'BLOCK', dictType: 'illegal_content' }]); // 旧词即时失效
    // v3：清空词库 → 即时全放行
    await put('illegal_content', 2, []);
    expect(await svc.checkRisk({ content: '包含新违禁词的文本' })).toEqual({
      action: 'PASS',
      hits: [],
    });
  });

  it('§5 幂等键=dict+base_version：重放（内容全等）幂等回读 created:false；内容不等/过期基数 409；词库内重复词 400 E_DUP_WORD', async () => {
    const p1 = await put('legal_industry', 0, [{ word: 'GUARANTEED', action: 'REVIEW' }]);
    expect(p1.created).toBe(true);
    expect(p1.version).toBe(1);
    // 重放（规范化后内容全等，大小写差异不破幂等）→ 回读既有版本
    const replay = await put('legal_industry', 0, [{ word: 'guaranteed', action: 'REVIEW' }]);
    expect(replay.created).toBe(false);
    expect(replay.version).toBe(1);
    const cnt = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ops.rule_definitions WHERE rule_key = 'wordlist.legal_industry'`,
    );
    expect(cnt.rows[0]?.n).toBe(1);

    // 同 base_version 内容不等（丢失更新）→ 409 过期基数
    await expect(
      put('legal_industry', 0, [{ word: 'guaranteed', action: 'BLOCK' }]),
    ).rejects.toMatchObject({ code: ErrorCode.Conflict });
    // 过期基数（当前已是 v1）→ 409
    await expect(put('legal_industry', 5, [])).rejects.toMatchObject({ code: ErrorCode.Conflict });
    // 词库内重复词（大小写不敏感判定）→ 400 E_DUP_WORD
    await expect(
      put('legal_industry', 1, [
        { word: 'Foo', action: 'MARK' },
        { word: 'foo', action: 'BLOCK' },
      ]),
    ).rejects.toMatchObject({ code: ErrorCode.DuplicateWord });
  });

  it('§6 DictionaryUpdated 与词库写入同事务出箱（载荷 rule_version 逐字 + additive 定位字段）', async () => {
    await put('legal_industry', 0, [{ word: '包赢', action: 'REVIEW' }]);
    const evt = await outboxOf(DICTIONARY_UPDATED_TOPIC);
    expect(evt).toHaveLength(1);
    expect(evt[0]?.payload).toMatchObject({
      rule_key: 'wordlist.legal_industry',
      rule_version: 1,
      dict_type: 'legal_industry',
    });
    expect(typeof evt[0]?.payload['effective_at']).toBe('string');
    // 第二库独立出事件（一库一版本线）
    await put('illegal_content', 0, [{ word: '违禁甲', action: 'BLOCK' }]);
    expect(await outboxOf(DICTIONARY_UPDATED_TOPIC)).toHaveLength(2);
  });

  it('E1 硬拦词集消费：currentBlockWords 返回当前生效词库 BLOCK 词集（缺省两库、可按库过滤；无版本=空集）', async () => {
    expect(await svc.currentBlockWords('legal_industry')).toEqual([]); // 尚无版本
    await put('illegal_content', 0, [
      { word: '违禁甲', action: 'BLOCK' },
      { word: '违禁乙', action: 'REVIEW' },
    ]);
    await put('legal_industry', 0, [
      { word: '话术丙', action: 'BLOCK' },
      { word: '话术丁', action: 'MARK' },
    ]);
    // 承诺结果/包赢类硬拦词集（E1 Task 7 消费）= 指定库/两库 BLOCK 词，小写规范形
    expect(await svc.currentBlockWords('legal_industry')).toEqual(['话术丙']);
    expect(await svc.currentBlockWords()).toEqual(['话术丙', '违禁甲']);
    // 词库更新后即时反映（热更新一致性）
    await put('legal_industry', 1, [{ word: '话术戊', action: 'BLOCK' }]);
    expect(await svc.currentBlockWords('legal_industry')).toEqual(['话术戊']);
  });

  it('CHECK_RISK 入参校验：content 须为字符串；conversationId 须为正整数；空文本 PASS 零副作用', async () => {
    await expect(svc.checkRisk({ content: 123 as unknown as string })).rejects.toMatchObject({
      code: ErrorCode.InvalidArgument,
    });
    await expect(svc.checkRisk({ conversationId: -1, content: 'x' })).rejects.toMatchObject({
      code: ErrorCode.InvalidArgument,
    });
    expect(await svc.checkRisk({ content: '' })).toEqual({ action: 'PASS', hits: [] });
    expect((await riskRows()).length).toBe(0);
  });

  it('§8 性能冒烟：2000 词自动机 + 万字文本热路径判定 <50ms（进程内零 DB）', async () => {
    const entries = Array.from({ length: 2000 }, (_, i) => ({
      word: `样例词${i}号`,
      action: (['BLOCK', 'REVIEW', 'MARK'] as const)[i % 3],
    }));
    await put(
      'illegal_content',
      0,
      entries as { word: string; action: 'BLOCK' | 'REVIEW' | 'MARK' }[],
    );
    const text = ('正常咨询内容，不涉及任何风控词汇。'.repeat(700) + '样例词1998号').slice(
      0,
      12000,
    );
    await svc.checkRisk({ content: text }); // warm（首调含词库加载）
    const t0 = Date.now();
    const r = await svc.checkRisk({ content: text });
    const elapsed = Date.now() - t0;
    expect(r.action).toBe('BLOCK'); // 1998 % 3 = 0 → BLOCK
    expect(r.hits.map((h) => h.word)).toEqual(['样例词1998号']);
    expect(elapsed).toBeLessThan(50);
  });
});

describe('H5 词库 REST 契约（§5 /admin/risk/dictionaries，需 PG）', () => {
  let pool: Pool;
  let app: INestApplication;
  let cache: WordDictAutomatonCache;
  let ruleCache: InProcessRuleCurrentCache;

  beforeAll(async () => {
    pool = await ensureTestDatabase();
    const moduleRef = await Test.createTestingModule({ imports: [WordDictModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    cache = app.get(WordDictAutomatonCache);
    ruleCache = app.get<InProcessRuleCurrentCache>(RULE_CURRENT_CACHE);
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  beforeEach(async () => {
    await truncateAll(pool);
    cache.clear();
    ruleCache.clear();
  });
  afterEach(async () => {
    await truncateAll(pool);
  });

  it('PUT 新建 → 重放幂等 created:false → 400 E_DUP_WORD / 400 非法 action / 400 非法 dict_type / 400 base_version', async () => {
    const put1 = await request(app.getHttpServer())
      .put('/admin/risk/dictionaries')
      .send({
        dict_type: 'legal_industry',
        base_version: 0,
        words: [{ word: '包赢', action: 'REVIEW' }],
      });
    expect(put1.status).toBe(200);
    expect(put1.body).toMatchObject({
      dictType: 'legal_industry',
      ruleKey: 'wordlist.legal_industry',
      version: 1,
      wordCount: 1,
      created: true,
    });

    const replay = await request(app.getHttpServer())
      .put('/admin/risk/dictionaries')
      .send({
        dict_type: 'legal_industry',
        base_version: 0,
        words: [{ word: '包赢', action: 'REVIEW' }],
      });
    expect(replay.status).toBe(200);
    expect(replay.body.created).toBe(false);

    const dup = await request(app.getHttpServer())
      .put('/admin/risk/dictionaries')
      .send({
        dict_type: 'legal_industry',
        base_version: 1,
        words: [
          { word: '词一', action: 'MARK' },
          { word: '词一', action: 'BLOCK' },
        ],
      });
    expect(dup.status).toBe(400);
    expect(dup.body.code).toBe('E_DUP_WORD');

    const badAction = await request(app.getHttpServer())
      .put('/admin/risk/dictionaries')
      .send({
        dict_type: 'legal_industry',
        base_version: 1,
        words: [{ word: 'x', action: 'NOPE' }],
      });
    expect(badAction.status).toBe(400);
    expect(badAction.body.code).toBe('E_INVALID_ARGUMENT');

    const badDict = await request(app.getHttpServer())
      .put('/admin/risk/dictionaries')
      .send({ dict_type: 'nope', base_version: 0, words: [] });
    expect(badDict.status).toBe(400);

    const badBase = await request(app.getHttpServer())
      .put('/admin/risk/dictionaries')
      .send({ dict_type: 'legal_industry', base_version: -1, words: [] });
    expect(badBase.status).toBe(400);
  });

  it('GET 当前生效版本视图：缺省两库（无版本库 version=0 words=[]）；?dict_type= 过滤', async () => {
    const empty = await request(app.getHttpServer()).get('/admin/risk/dictionaries');
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual([
      {
        dictType: 'illegal_content',
        ruleKey: 'wordlist.illegal_content',
        version: 0,
        effectiveAt: null,
        words: [],
      },
      {
        dictType: 'legal_industry',
        ruleKey: 'wordlist.legal_industry',
        version: 0,
        effectiveAt: null,
        words: [],
      },
    ]);

    await request(app.getHttpServer())
      .put('/admin/risk/dictionaries')
      .send({
        dict_type: 'legal_industry',
        base_version: 0,
        words: [{ word: '包赢', action: 'REVIEW' }],
      });

    const one = await request(app.getHttpServer()).get(
      '/admin/risk/dictionaries?dict_type=legal_industry',
    );
    expect(one.status).toBe(200);
    expect(one.body).toHaveLength(1);
    expect(one.body[0]).toMatchObject({
      dictType: 'legal_industry',
      version: 1,
      words: [{ word: '包赢', action: 'REVIEW' }],
    });
    expect(typeof one.body[0].effectiveAt).toBe('string');

    const badFilter = await request(app.getHttpServer()).get(
      '/admin/risk/dictionaries?dict_type=nope',
    );
    expect(badFilter.status).toBe(400);
  });
});
