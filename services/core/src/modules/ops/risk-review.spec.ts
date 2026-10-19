import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { JwtService } from '@nestjs/jwt';
import { ErrorCode } from '@ljr/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Pool } from 'pg';
import { ensureTestDatabase, truncateAll } from '../../infrastructure/testing/db';
import { IDENTITY_CONFIG, type IdentityConfig } from '../identity/identity.config';
import { deleteTemplateRaw, listNotificationsRaw, seedTemplateRaw } from '../notify/notify-fixture';
import { RULE_CURRENT_CACHE, InProcessRuleCurrentCache } from './rule-center.cache';
import { RiskReviewService } from './risk-review.service';
import { WordDictAutomatonCache } from './word-dict.cache';
import { WordDictModule } from './word-dict.module';
import { WordDictService } from './word-dict.service';

/**
 * H5 人审闭环 e2e（M2-W2 T7，需 PG）：§4「队列 → 处置（三分支） → 审计」/ §5 queue+review
 * （409 DONE 幂等键=record）。记录 fixture 走 W1 真链（putDictionary → checkRisk REVIEW 命中
 * 落 risk_records），不内联造行——机审落库面即队列事实源。
 *
 * 覆盖（任务简报 TDD 清单）：三 verdict 处置流转 / 重复处置 409 DONE（不翻案+恰一次审计）/
 * 未处置可见+处置后跌出 / 审计双面（risk_records 行内+ops.audit_logs 行）/ reviewed_note
 * 500 校验（不静默截断）/ verdict 非法 400 / 分页与筛选 / REST 鉴权三态。
 * 异步复核=后置（⚠W2-7）不建用例；测试词全部虚构样例（H5 §9：词库明文禁入 git）。
 */

/** risk_records 行内回填面（verdict/reviewed_note V45 列） */
interface RiskRow {
  readonly id: string;
  readonly dict_type: string;
  readonly word_hits: Record<string, unknown>[];
  readonly action: string;
  readonly verdict: string | null;
  readonly reviewed_note: string | null;
  readonly reviewed_by: string | null;
  readonly reviewed_at: Date | null;
  readonly created_at: Date;
}

describe('H5 人审闭环（需 PG）', () => {
  let pool: Pool;
  let app: INestApplication;
  let svc: RiskReviewService;
  let dicts: WordDictService;
  let cache: WordDictAutomatonCache;
  let ruleCache: InProcessRuleCurrentCache;
  let adminToken: string;
  let userToken: string;
  const ADMIN_ID = 990021;

  // ---------- 夹具：词库（虚构样例词）+ 记录（checkRisk REVIEW 命中真链落行） ----------

  const seedDicts = async () => {
    await dicts.putDictionary({
      dictType: 'legal_industry',
      baseVersion: 0,
      words: [
        { word: '包赢', action: 'REVIEW' },
        { word: '稳过', action: 'REVIEW' },
      ],
    });
    await dicts.putDictionary({
      dictType: 'illegal_content',
      baseVersion: 0,
      words: [{ word: '违禁甲', action: 'REVIEW' }],
    });
  };

  /** checkRisk 命中 legal_industry 一行（conversationId 递增锚——每调一次落一行） */
  const makeRecord = (conversationId: number) =>
    dicts.checkRisk({ conversationId, content: '这个方案包赢' });

  const riskRows = async () => {
    const res = await pool.query<RiskRow>(`SELECT * FROM ops.risk_records ORDER BY id`);
    return res.rows;
  };

  const auditRows = async (targetId: number) => {
    const res = await pool.query<{
      actor_user_id: string;
      action: string;
      target_type: string;
      target_id: string;
      detail: Record<string, unknown> | null;
    }>(
      `SELECT actor_user_id, action, target_type, target_id, detail FROM ops.audit_logs
        WHERE target_type = 'risk_record' AND target_id = $1 ORDER BY id`,
      [targetId],
    );
    return res.rows;
  };

  const review = (recordId: number, verdict: string, note?: string) =>
    svc.reviewRecord({
      recordId,
      operatorId: ADMIN_ID,
      verdict: verdict as never,
      note,
    });

  beforeAll(async () => {
    pool = await ensureTestDatabase();
    const jwtSecret = randomBytes(32).toString('hex');
    const identityConfig: IdentityConfig = {
      phoneDataKey: randomBytes(32),
      phoneBlindPepper: randomBytes(32).toString('hex'),
      jwtSecret,
    };
    const moduleRef = await Test.createTestingModule({ imports: [WordDictModule] })
      .overrideProvider(IDENTITY_CONFIG)
      .useValue(identityConfig)
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
    svc = app.get(RiskReviewService);
    dicts = app.get(WordDictService);
    cache = app.get(WordDictAutomatonCache);
    ruleCache = app.get<InProcessRuleCurrentCache>(RULE_CURRENT_CACHE);
    const jwt = new JwtService({ secret: jwtSecret });
    adminToken = await jwt.signAsync({
      sub: String(ADMIN_ID),
      role: 'user',
      roles: ['user', 'admin'],
    });
    userToken = await jwt.signAsync({ sub: '990022', role: 'user', roles: ['user'] });
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
    // 参照数据纪律（notify-fixture 头注）：自插模板用后必删
    await deleteTemplateRaw(pool, 'RISK_FALSE_POSITIVE');
  });

  // ===========================================================================
  // 队列（§5 GET /admin/risk/queue：待处置面+倒序分页筛选）
  // ===========================================================================

  it('未处置记录队列可见（message_id/word_hits/created_at 数据位）；处置后跌出', async () => {
    await seedDicts();
    await makeRecord(11);
    const rows = await riskRows();
    expect(rows).toHaveLength(1);

    const queue = await svc.listQueue();
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({
      id: Number(rows[0]!.id),
      message_id: null, // V1 现状：checkRisk 先于消息落库，D5 接入后补关联
      conversation_id: 11,
      dict_type: 'legal_industry',
      action: 'REVIEW',
    });
    expect(queue[0]!.word_hits).toEqual([{ word: '包赢', action: 'REVIEW', rule_version: 1 }]);
    expect(typeof queue[0]!.created_at).toBe('string'); // ISO 出站口径

    await review(Number(rows[0]!.id), 'MARK_ONLY');
    expect(await svc.listQueue()).toEqual([]); // 处置后不可见（reviewed_at IS NULL 面）
  });

  it('倒序+分页+筛选：created_at DESC（同刻 id DESC 锚）；limit/offset 翻页；dict_type/action 过滤，非法筛选 400', async () => {
    await seedDicts();
    for (const cid of [21, 22, 23]) await makeRecord(cid);
    await dicts.checkRisk({ conversationId: 24, content: '提到违禁甲的文本' }); // illegal 库一行
    expect((await riskRows()).length).toBe(4);

    // 倒序：新记录在前（同事务连插 created_at 同刻 → id DESC 确定性锚）
    const all = await svc.listQueue();
    expect(all.map((r) => r.conversation_id)).toEqual([24, 23, 22, 21]);

    // 分页：limit=2 首页最新两条；offset=2 翻页余量
    expect((await svc.listQueue({ limit: 2 })).map((r) => r.conversation_id)).toEqual([24, 23]);
    expect((await svc.listQueue({ limit: 2, offset: 2 })).map((r) => r.conversation_id)).toEqual([
      22, 21,
    ]);

    // 筛选：dict_type（illegal 库一行）；action=REVIEW（W1 落行全量）
    expect(
      (await svc.listQueue({ dictType: 'illegal_content' })).map((r) => r.conversation_id),
    ).toEqual([24]);
    expect(await svc.listQueue({ dictType: 'legal_industry', action: 'REVIEW' })).toHaveLength(3);

    // 非法筛选 400（词汇校验）
    await expect(svc.listQueue({ dictType: 'unknown' })).rejects.toMatchObject({
      code: ErrorCode.InvalidArgument,
    });
    await expect(svc.listQueue({ action: 'PASS' })).rejects.toMatchObject({
      code: ErrorCode.InvalidArgument,
    });
  });

  // ===========================================================================
  // 处置（§5 POST /admin/risk/records/{id}/review：三 verdict 流转+409 DONE+审计双面）
  // ===========================================================================

  it('三 verdict 处置流转：行内 verdict/reviewed_note/reviewed_by/reviewed_at（DB 钟）回填', async () => {
    await seedDicts();
    for (const cid of [31, 32, 33]) await makeRecord(cid);
    const rows = await riskRows();

    const c1 = await review(Number(rows[0]!.id), 'CONFIRM_BLOCK', '确属违规话术');
    expect(c1).toMatchObject({
      record_id: Number(rows[0]!.id),
      verdict: 'CONFIRM_BLOCK',
      reviewed_by: ADMIN_ID,
    });
    expect(new Date(c1.reviewed_at).getTime()).toBeGreaterThan(0);

    const c2 = await review(Number(rows[1]!.id), 'FALSE_POSITIVE');
    expect(c2.verdict).toBe('FALSE_POSITIVE');
    const c3 = await review(Number(rows[2]!.id), 'MARK_ONLY', '仅标记留档');
    expect(c3.verdict).toBe('MARK_ONLY');

    const after = await riskRows();
    expect(after.map((r) => [r.id, r.verdict, r.reviewed_note, r.reviewed_by])).toEqual([
      [rows[0]!.id, 'CONFIRM_BLOCK', '确属违规话术', String(ADMIN_ID)],
      [rows[1]!.id, 'FALSE_POSITIVE', null, String(ADMIN_ID)],
      [rows[2]!.id, 'MARK_ONLY', '仅标记留档', String(ADMIN_ID)],
    ]);
    for (const r of after) expect(r.reviewed_at).not.toBeNull();
  });

  it('重复处置 409 DONE：不翻案（首 verdict 保留）+恰一次审计（audit_logs 不再追加）', async () => {
    await seedDicts();
    await makeRecord(41);
    const id = Number((await riskRows())[0]!.id);

    await review(id, 'CONFIRM_BLOCK', '首判');
    await expect(review(id, 'FALSE_POSITIVE', '翻案尝试')).rejects.toMatchObject({
      code: ErrorCode.Conflict,
      message: expect.stringContaining('DONE'),
    });

    const after = (await riskRows())[0]!;
    expect(after.verdict).toBe('CONFIRM_BLOCK'); // 不翻案
    expect(after.reviewed_note).toBe('首判');
    expect(await auditRows(id)).toHaveLength(1); // 恰一次审计
  });

  it('审计双面：risk_records 行内回填（事实源）+ ops.audit_logs 操作审计行（actor/action/detail）', async () => {
    await seedDicts();
    await makeRecord(51);
    const id = Number((await riskRows())[0]!.id);

    await review(id, 'FALSE_POSITIVE', '误报，放行');

    const record = (await riskRows())[0]!;
    expect(record).toMatchObject({
      verdict: 'FALSE_POSITIVE',
      reviewed_note: '误报，放行',
      reviewed_by: String(ADMIN_ID),
    }); // 行内面
    const audits = await auditRows(id);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toEqual({
      actor_user_id: String(ADMIN_ID),
      action: 'risk.record.review',
      target_type: 'risk_record',
      target_id: String(id),
      detail: { verdict: 'FALSE_POSITIVE' }, // note 已在行内，audit 面不重复存
    });
  });

  it('reviewed_note 校验不静默截断：501 字 400 / 500 字通过 / 空串与非字符串 400', async () => {
    await seedDicts();
    await makeRecord(61);
    const id = Number((await riskRows())[0]!.id);

    await expect(review(id, 'MARK_ONLY', '长'.repeat(501))).rejects.toMatchObject({
      code: ErrorCode.InvalidArgument,
    });
    // 校验失败不落任何痕迹（行内未回填+零审计）
    expect((await riskRows())[0]!.verdict).toBeNull();
    expect(await auditRows(id)).toHaveLength(0);

    const ok = await review(id, 'MARK_ONLY', '长'.repeat(500));
    expect(ok.verdict).toBe('MARK_ONLY');
    expect((await riskRows())[0]!.reviewed_note).toBe('长'.repeat(500)); // 原文全量留痕

    const id2 = (await (async () => {
      await makeRecord(62);
      return Number((await riskRows())[1]!.id);
    })())!;
    await expect(review(id2, 'MARK_ONLY', '  ')).rejects.toMatchObject({
      code: ErrorCode.InvalidArgument,
    });
    await expect(review(id2, 'MARK_ONLY', 123 as never)).rejects.toMatchObject({
      code: ErrorCode.InvalidArgument,
    });
  });

  it('verdict 非法 400（服务层词汇守卫）；记录不存在 404', async () => {
    await seedDicts();
    await makeRecord(71);
    const id = Number((await riskRows())[0]!.id);

    await expect(review(id, 'CONFIRM')).rejects.toMatchObject({ code: ErrorCode.InvalidArgument });
    await expect(review(999999, 'MARK_ONLY')).rejects.toMatchObject({ code: ErrorCode.NotFound });
    expect((await riskRows())[0]!.verdict).toBeNull(); // 拒绝零痕迹
  });

  it('FALSE_POSITIVE 通知位 V1 直发桩：模板未 seed 跳过不阻断；seed 在册亦不阻断（user 锚点缺失，零登记）', async () => {
    await seedDicts();
    await makeRecord(81);
    const id = Number((await riskRows())[0]!.id);

    // 分支一：模板未 seed（I1 域待落）——跳过+告警，处置主流程不受阻
    const miss = await review(id, 'FALSE_POSITIVE');
    expect(miss.verdict).toBe('FALSE_POSITIVE');

    // 分支二：模板在册（RISK_FALSE_POSITIVE seed 夹具）——V1 无 user 锚点，跳过真发不阻断
    await seedTemplateRaw(pool, 'RISK_FALSE_POSITIVE', '您之前的消息经人工复核确认无违规');
    await makeRecord(82);
    const id2 = Number((await riskRows())[1]!.id);
    const hit = await review(id2, 'FALSE_POSITIVE');
    expect(hit.verdict).toBe('FALSE_POSITIVE');
    expect(await listNotificationsRaw(pool, 0, 'RISK_FALSE_POSITIVE')).toEqual([]); // 零登记（桩未触达）
  });

  // ===========================================================================
  // REST 契约（§5：鉴权三态 + queue/review 端点形状）
  // ===========================================================================

  it('GET /admin/risk/queue：401 未认证 / 403 未持 admin / admin 200（形状+筛选）', async () => {
    const anon = await request(app.getHttpServer()).get('/admin/risk/queue');
    expect(anon.status).toBe(401);
    expect(anon.body.code).toBe(ErrorCode.Unauthorized);

    const forbidden = await request(app.getHttpServer())
      .get('/admin/risk/queue')
      .set('Authorization', `Bearer ${userToken}`);
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.code).toBe(ErrorCode.RoleForbidden);

    const empty = await request(app.getHttpServer())
      .get('/admin/risk/queue')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual({ items: [] });

    await seedDicts();
    await makeRecord(91);
    const list = await request(app.getHttpServer())
      .get('/admin/risk/queue?dict_type=legal_industry&action=REVIEW&limit=10&offset=0')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0]).toMatchObject({
      conversation_id: 91,
      dict_type: 'legal_industry',
      action: 'REVIEW',
    });

    const badFilter = await request(app.getHttpServer())
      .get('/admin/risk/queue?dict_type=nope')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(badFilter.status).toBe(400);
    expect(badFilter.body.code).toBe(ErrorCode.InvalidArgument);
  });

  it('POST /admin/risk/records/{id}/review：200 回填 + 重放 409 DONE + verdict 非法/note 超长 400 + 404', async () => {
    await seedDicts();
    await makeRecord(101);
    const id = Number((await riskRows())[0]!.id);

    const ok = await request(app.getHttpServer())
      .post(`/admin/risk/records/${id}/review`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ verdict: 'CONFIRM_BLOCK', note: 'REST 处置' });
    expect(ok.status).toBe(200); // 动作端点 @HttpCode(200)
    expect(ok.body).toMatchObject({
      record_id: id,
      verdict: 'CONFIRM_BLOCK',
      reviewed_by: ADMIN_ID, // reviewed_by=claims userId（守卫面注入）
    });

    const replay = await request(app.getHttpServer())
      .post(`/admin/risk/records/${id}/review`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ verdict: 'MARK_ONLY' });
    expect(replay.status).toBe(409);
    expect(replay.body.code).toBe(ErrorCode.Conflict);
    expect(replay.body.message).toContain('DONE');

    const badVerdict = await request(app.getHttpServer())
      .post(`/admin/risk/records/${id}/review`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ verdict: 'APPROVE' });
    expect(badVerdict.status).toBe(400);

    await makeRecord(102);
    const id2 = Number((await riskRows())[1]!.id);
    const longNote = await request(app.getHttpServer())
      .post(`/admin/risk/records/${id2}/review`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ verdict: 'MARK_ONLY', note: 'x'.repeat(501) });
    expect(longNote.status).toBe(400);
    expect(longNote.body.code).toBe(ErrorCode.InvalidArgument);

    const missing = await request(app.getHttpServer())
      .post('/admin/risk/records/999999/review')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ verdict: 'MARK_ONLY' });
    expect(missing.status).toBe(404);
  });
});
