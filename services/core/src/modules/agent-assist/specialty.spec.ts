import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { ErrorCode } from '@ljr/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import type { Pool } from 'pg';
import { ensureTestDatabase, truncateAll } from '../../infrastructure/testing/db';
import { IDENTITY_CONFIG, type IdentityConfig } from '../identity/identity.config';
import { SpecialtyKnowledgeModule } from './specialty.module';
import { SpecialtyConfigService } from './specialty.service';
import { QUESTION_TREE_UPDATED_TOPIC } from './specialty.events';
import { KNOWLEDGE_CONFIG, KNOWLEDGE_DEFAULT_CONFIG } from './knowledge.config';
import type { PromptTemplates, QuestionTree } from './specialty.types';

/**
 * E3 专项配置包 e2e（需 PG）：R-01 配置包按专项收敛 / R-03 提示词版本化 / R-04 V1 仅
 * labor_arbitration + §5 管理面/公开面 REST 契约 + §9 树结构校验 + §6 QuestionTreeUpdated
 * 同事务出箱。知识库（docs/chunks/检索/异步向量化）见 knowledge.spec.ts。
 */

const TREE_V1: QuestionTree = {
  root: 'q1',
  nodes: [
    { id: 'q1', label: '争议类型', children: ['q2', 'q3'] },
    { id: 'q2', label: '拖欠工资', children: [] },
    { id: 'q3', label: '违法解除', children: [] },
  ],
};

const TREE_V2: QuestionTree = {
  root: 'r',
  nodes: [
    { id: 'r', label: '仲裁阶段', children: ['a'] },
    { id: 'a', label: '立案', children: [] },
  ],
};

const PROMPTS_V1: PromptTemplates = {
  templates: { draft_style: '以劳动仲裁请求为主线输出草稿。' },
};

const outboxOf = async (pool: Pool, topic: string) => {
  const res = await pool.query<{ payload: Record<string, unknown>; topic: string }>(
    `SELECT payload, topic FROM platform.outbox WHERE topic = $1 ORDER BY id`,
    [topic],
  );
  return res.rows;
};

describe('E3 专项配置包机制（需 PG）', () => {
  let pool: Pool;
  let app: INestApplication;
  let configs: SpecialtyConfigService;

  beforeAll(async () => {
    pool = await ensureTestDatabase();
    const moduleRef = await Test.createTestingModule({ imports: [SpecialtyKnowledgeModule] })
      .overrideProvider(KNOWLEDGE_CONFIG)
      .useValue(KNOWLEDGE_DEFAULT_CONFIG)
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
    configs = app.get(SpecialtyConfigService);
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

  it('R-04 V1 仅 labor_arbitration：其他专项 key 管理面写入 400 E_SPECIALTY_UNSUPPORTED；公开面未知/未配置 404', async () => {
    await expect(
      configs.putQuestionTree({ specialty: 'trade', tree: TREE_V1, baseVersion: 0 }),
    ).rejects.toMatchObject({ code: ErrorCode.SpecialtyUnsupported });
    await expect(
      configs.putPrompts({ specialty: 'traffic', prompts: PROMPTS_V1, baseVersion: 0 }),
    ).rejects.toMatchObject({ code: ErrorCode.SpecialtyUnsupported });
    // 公开读面：未配置/不存在的专项 → 404（资源语义，不向公网暴露在册专项清单口径）
    await expect(configs.getQuestionTree('trade')).rejects.toMatchObject({
      code: ErrorCode.NotFound,
    });
  });

  it('R-01 配置包按专项收敛：问题树/提示词/知识库三面共用 specialty key（V1=labor_arbitration 唯一行）', async () => {
    const tree = await configs.putQuestionTree({
      specialty: 'labor_arbitration',
      tree: TREE_V1,
      baseVersion: 0,
    });
    const prompts = await configs.putPrompts({
      specialty: 'labor_arbitration',
      prompts: PROMPTS_V1,
      baseVersion: 0,
    });
    expect(tree.specialty).toBe('labor_arbitration');
    expect(prompts.specialty).toBe('labor_arbitration');
    const view = await configs.getQuestionTree('labor_arbitration');
    expect(view).toMatchObject({ specialty: 'labor_arbitration', version: 1 });
    expect(view.questionTree).toEqual(TREE_V1);
    // 双版本线独立：树 v2 不影响 prompts v1
    const tree2 = await configs.putQuestionTree({
      specialty: 'labor_arbitration',
      tree: TREE_V2,
      baseVersion: 1,
    });
    expect(tree2.version).toBe(2);
    expect(
      (await app.get(SpecialtyConfigService).getQuestionTree('labor_arbitration')).version,
    ).toBe(2);
  });

  it('§5 PUT question-tree 幂等键=key+base_version：v1 创建 → 重放 created:false → 内容不等/过期基数 409', async () => {
    const v1 = await configs.putQuestionTree({
      specialty: 'labor_arbitration',
      tree: TREE_V1,
      baseVersion: 0,
    });
    expect(v1).toEqual({ specialty: 'labor_arbitration', version: 1, created: true });
    // 重放（同 base_version 同树）→ 幂等回读
    const replay = await configs.putQuestionTree({
      specialty: 'labor_arbitration',
      tree: TREE_V1,
      baseVersion: 0,
    });
    expect(replay).toEqual({ specialty: 'labor_arbitration', version: 1, created: false });
    // 同 base_version 内容不等（丢失更新）→ 409
    await expect(
      configs.putQuestionTree({ specialty: 'labor_arbitration', tree: TREE_V2, baseVersion: 0 }),
    ).rejects.toMatchObject({ code: ErrorCode.Conflict });
    // 过期基数（当前 v1）→ 409
    await expect(
      configs.putQuestionTree({ specialty: 'labor_arbitration', tree: TREE_V1, baseVersion: 5 }),
    ).rejects.toMatchObject({ code: ErrorCode.Conflict });
    // 正常推进 → v2；重放 v2
    const v2 = await configs.putQuestionTree({
      specialty: 'labor_arbitration',
      tree: TREE_V2,
      baseVersion: 1,
    });
    expect(v2.version).toBe(2);
    expect(
      (
        await configs.putQuestionTree({
          specialty: 'labor_arbitration',
          tree: TREE_V2,
          baseVersion: 1,
        })
      ).created,
    ).toBe(false);
    // 幂等重放不重复出事件
    expect(await outboxOf(pool, QUESTION_TREE_UPDATED_TOPIC)).toHaveLength(2); // v1、v2 各一条
  });

  it('§9 树结构校验（400 E_INVALID_TREE）：root 不在册/子引用缺失/环/不可达节点/重复 id/非法 id/结构类型；空树合法（清空语义）', async () => {
    const bad = (tree: unknown) =>
      configs.putQuestionTree({
        specialty: 'labor_arbitration',
        tree: tree as QuestionTree,
        baseVersion: 0,
      });
    // root 不在节点集
    await expect(
      bad({ root: 'x', nodes: [{ id: 'a', label: '甲', children: [] }] }),
    ).rejects.toMatchObject({
      code: ErrorCode.InvalidQuestionTree,
    });
    // 子引用不存在
    await expect(
      bad({ root: 'a', nodes: [{ id: 'a', label: '甲', children: ['ghost'] }] }),
    ).rejects.toMatchObject({ code: ErrorCode.InvalidQuestionTree });
    // 环（a→b→a：边数 2 ≠ n-1）
    await expect(
      bad({
        root: 'a',
        nodes: [
          { id: 'a', label: '甲', children: ['b'] },
          { id: 'b', label: '乙', children: ['a'] },
        ],
      }),
    ).rejects.toMatchObject({ code: ErrorCode.InvalidQuestionTree });
    // root 不可达节点（孤儿）
    await expect(
      bad({
        root: 'a',
        nodes: [
          { id: 'a', label: '甲', children: [] },
          { id: 'orphan', label: '孤', children: [] },
        ],
      }),
    ).rejects.toMatchObject({ code: ErrorCode.InvalidQuestionTree });
    // 重复 id
    await expect(
      bad({
        root: 'a',
        nodes: [
          { id: 'a', label: '甲', children: ['b'] },
          { id: 'b', label: '乙', children: [] },
          { id: 'b', label: '丙', children: [] },
        ],
      }),
    ).rejects.toMatchObject({ code: ErrorCode.InvalidQuestionTree });
    // 非法 id / 空 label / 结构类型
    await expect(
      bad({ root: 'A*', nodes: [{ id: 'A*', label: '甲', children: [] }] }),
    ).rejects.toMatchObject({
      code: ErrorCode.InvalidQuestionTree,
    });
    await expect(
      bad({ root: 'a', nodes: [{ id: 'a', label: '  ', children: [] }] }),
    ).rejects.toMatchObject({
      code: ErrorCode.InvalidQuestionTree,
    });
    await expect(bad({ root: 'a' })).rejects.toMatchObject({ code: ErrorCode.InvalidQuestionTree });
    await expect(bad(null)).rejects.toMatchObject({ code: ErrorCode.InvalidQuestionTree });
    // 空树合法（seed/清空语义）：先 v1 再清空 → v2 且 GET 回空树
    await configs.putQuestionTree({
      specialty: 'labor_arbitration',
      tree: TREE_V1,
      baseVersion: 0,
    });
    const cleared = await configs.putQuestionTree({
      specialty: 'labor_arbitration',
      tree: { root: '', nodes: [] },
      baseVersion: 1,
    });
    expect(cleared.version).toBe(2);
    expect((await configs.getQuestionTree('labor_arbitration')).questionTree).toEqual({
      root: '',
      nodes: [],
    });
  });

  it('R-03 提示词模板版本化：变更记 version（只影响后续生成的版本锚点）；§5 幂等键=key+base_version；§6 无提示词事件', async () => {
    const v1 = await configs.putPrompts({
      specialty: 'labor_arbitration',
      prompts: PROMPTS_V1,
      baseVersion: 0,
    });
    expect(v1).toEqual({ specialty: 'labor_arbitration', version: 1, created: true });
    const v2 = await configs.putPrompts({
      specialty: 'labor_arbitration',
      prompts: { templates: { draft_style: ' v2 更新后的模板。' } },
      baseVersion: 1,
    });
    expect(v2.version).toBe(2);
    // 重放与冲突口径与树一致
    await expect(
      configs.putPrompts({ specialty: 'labor_arbitration', prompts: PROMPTS_V1, baseVersion: 0 }),
    ).rejects.toMatchObject({ code: ErrorCode.Conflict });
    const replay = await configs.putPrompts({
      specialty: 'labor_arbitration',
      prompts: { templates: { draft_style: ' v2 更新后的模板。' } },
      baseVersion: 1,
    });
    expect(replay.created).toBe(false);
    // §6 领域事件只有两个：prompts 变更不出事件（无 PromptsUpdated）
    expect(await outboxOf(pool, 'agent_assist.specialty.prompts.updated')).toHaveLength(0);
    expect(await outboxOf(pool, QUESTION_TREE_UPDATED_TOPIC)).toHaveLength(0);
  });

  it('§9 提示词结构校验（400 E_INVALID_ARGUMENT）：templates 非对象/非法 key/空内容/超限', async () => {
    const put = (prompts: unknown) =>
      configs.putPrompts({
        specialty: 'labor_arbitration',
        prompts: prompts as PromptTemplates,
        baseVersion: 0,
      });
    await expect(put({})).rejects.toMatchObject({ code: ErrorCode.InvalidArgument });
    await expect(put({ templates: [] })).rejects.toMatchObject({ code: ErrorCode.InvalidArgument });
    await expect(put({ templates: { 'BAD KEY!': '内容' } })).rejects.toMatchObject({
      code: ErrorCode.InvalidArgument,
    });
    await expect(put({ templates: { ok_key: '   ' } })).rejects.toMatchObject({
      code: ErrorCode.InvalidArgument,
    });
    // 空 templates 合法（清空语义）
    const emptied = await put({ templates: {} });
    expect(emptied.created).toBe(true);
  });

  it('§6 QuestionTreeUpdated 与树写入同事务出箱（载荷 specialty/version 逐字）', async () => {
    await configs.putQuestionTree({
      specialty: 'labor_arbitration',
      tree: TREE_V1,
      baseVersion: 0,
    });
    const rows = await outboxOf(pool, QUESTION_TREE_UPDATED_TOPIC);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload).toEqual({ specialty: 'labor_arbitration', version: 1 });
    await configs.putQuestionTree({
      specialty: 'labor_arbitration',
      tree: TREE_V2,
      baseVersion: 1,
    });
    const rows2 = await outboxOf(pool, QUESTION_TREE_UPDATED_TOPIC);
    expect(rows2).toHaveLength(2);
    expect(rows2[1]!.payload).toEqual({ specialty: 'labor_arbitration', version: 2 });
  });
});

describe('E3 专项配置 REST 契约（§5，需 PG）', () => {
  let pool: Pool;
  let app: INestApplication;
  let adminToken: string;
  let userToken: string;

  const adminPut = (url: string) =>
    request(app.getHttpServer()).put(url).set('Authorization', `Bearer ${adminToken}`);

  beforeAll(async () => {
    pool = await ensureTestDatabase();
    const jwtSecret = randomBytes(32).toString('hex');
    const identityConfig: IdentityConfig = {
      phoneDataKey: randomBytes(32),
      phoneBlindPepper: randomBytes(32).toString('hex'),
      jwtSecret,
    };
    const moduleRef = await Test.createTestingModule({ imports: [SpecialtyKnowledgeModule] })
      .overrideProvider(KNOWLEDGE_CONFIG)
      .useValue(KNOWLEDGE_DEFAULT_CONFIG)
      .overrideProvider(IDENTITY_CONFIG)
      .useValue(identityConfig)
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
    const jwt = new JwtService({ secret: jwtSecret });
    adminToken = await jwt.signAsync({ sub: '990011', role: 'user', roles: ['user', 'admin'] });
    userToken = await jwt.signAsync({ sub: '990012', role: 'user', roles: ['user'] });
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

  it('PUT /admin/specialty/{key}/question-tree：200 {specialty,version,created}；400 E_INVALID_TREE/E_SPECIALTY_UNSUPPORTED/E_INVALID_ARGUMENT', async () => {
    const ok = await adminPut('/admin/specialty/labor_arbitration/question-tree').send({
      tree: TREE_V1,
      base_version: 0,
    });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ specialty: 'labor_arbitration', version: 1, created: true });

    const replay = await adminPut('/admin/specialty/labor_arbitration/question-tree').send({
      tree: TREE_V1,
      base_version: 0,
    });
    expect(replay.status).toBe(200);
    expect(replay.body.created).toBe(false);

    const badTree = await adminPut('/admin/specialty/labor_arbitration/question-tree').send({
      tree: { root: 'ghost', nodes: [] },
      base_version: 1,
    });
    expect(badTree.status).toBe(400);
    expect(badTree.body.code).toBe('E_INVALID_TREE');

    const unsupported = await adminPut('/admin/specialty/trade/question-tree').send({
      tree: TREE_V1,
      base_version: 0,
    });
    expect(unsupported.status).toBe(400);
    expect(unsupported.body.code).toBe('E_SPECIALTY_UNSUPPORTED');

    const badBase = await adminPut('/admin/specialty/labor_arbitration/question-tree').send({
      tree: TREE_V1,
      base_version: -1,
    });
    expect(badBase.status).toBe(400);
    expect(badBase.body.code).toBe('E_INVALID_ARGUMENT');
  });

  it('PUT /admin/specialty/{key}/prompts：200 {specialty,version,created}；409 过期基数', async () => {
    const ok = await adminPut('/admin/specialty/labor_arbitration/prompts').send({
      prompts: PROMPTS_V1,
      base_version: 0,
    });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ specialty: 'labor_arbitration', version: 1, created: true });

    const stale = await adminPut('/admin/specialty/labor_arbitration/prompts').send({
      prompts: PROMPTS_V1,
      base_version: 7,
    });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('E_CONFLICT');
  });

  it('GET /specialty/question-tree?key= 公开只读：树结构（C2 消费）；未配置 404；缺 key 400', async () => {
    const missing = await request(app.getHttpServer()).get(
      '/specialty/question-tree?key=labor_arbitration',
    );
    expect(missing.status).toBe(404);

    await adminPut('/admin/specialty/labor_arbitration/question-tree').send({
      tree: TREE_V1,
      base_version: 0,
    });

    const ok = await request(app.getHttpServer()).get(
      '/specialty/question-tree?key=labor_arbitration',
    );
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ specialty: 'labor_arbitration', version: 1, questionTree: TREE_V1 });

    const unknown = await request(app.getHttpServer()).get('/specialty/question-tree?key=trade');
    expect(unknown.status).toBe(404);

    const noKey = await request(app.getHttpServer()).get('/specialty/question-tree');
    expect(noKey.status).toBe(400);
  });

  it('G-A 精神同款机械接线（评审 Important-1）：/admin/specialty 未认证 401 / 未持 admin 旗标 403 / admin 200', async () => {
    const anon = await request(app.getHttpServer())
      .put('/admin/specialty/labor_arbitration/prompts')
      .send({ prompts: PROMPTS_V1, base_version: 0 });
    expect(anon.status).toBe(401);
    expect(anon.body.code).toBe('E_UNAUTHORIZED');

    const asUser = await request(app.getHttpServer())
      .put('/admin/specialty/labor_arbitration/prompts')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ prompts: PROMPTS_V1, base_version: 0 });
    expect(asUser.status).toBe(403);
    expect(asUser.body.code).toBe('E_ROLE_FORBIDDEN');

    const ok = await adminPut('/admin/specialty/labor_arbitration/prompts').send({
      prompts: PROMPTS_V1,
      base_version: 0,
    });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ specialty: 'labor_arbitration', version: 1, created: true });
  });
});
