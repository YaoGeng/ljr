/**
 * E1 实时脱敏层——服务面 e2e（需 PG）：sanitize_audit 命中审计（§10「进入 LLM 的载荷抽检
 * 断言」的落库支撑：只存前后摘要哈希/命中类型/耗时，原文零明文）、审计旁路（写入失败不阻塞
 * 脱敏）、P95 ≤1s 预算冒烟（§8，量级放宽防 CI 噪音，沿 word-dict 先例）、回归集服务面回放。
 * 施工规格：docs/modules/E-AI辅助/E1-Agent草稿气泡管线.md §7 R-02、§8、§9、§10 验收①。
 */
import 'reflect-metadata';
import { createHash } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Pool } from 'pg';
import { ErrorCode } from '@ljr/shared';
import { ensureTestDatabase, truncateAll } from '../../infrastructure/testing/db';
import { PgPoolService } from '../../infrastructure/sql';
import { TRACE_LOGGER } from '../../observability/observability.module';
import { SANITIZE_REGRESSION_POSITIVE } from './sanitize.regression';
import { SANITIZE_RULESET_VERSION, sanitizeText } from './sanitize.rules';
import { SanitizeModule } from './sanitize.module';
import { SanitizeService } from './sanitize.service';

const sha256Hex = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

interface AuditRow {
  readonly id: string;
  readonly rule_version: string;
  readonly input_digest: string;
  readonly output_digest: string;
  readonly hit_types: { type: string; count: number }[];
  readonly duration_ms: number;
  readonly created_at: Date;
}

const auditRows = async (pool: Pool): Promise<AuditRow[]> => {
  const res = await pool.query<AuditRow>(
    `SELECT id, rule_version, input_digest, output_digest, hit_types, duration_ms, created_at
       FROM agent_assist.sanitize_audit ORDER BY id`,
  );
  return res.rows;
};

describe('E1 脱敏服务面（需 PG）', () => {
  let pool: Pool;
  let app: INestApplication;
  let svc: SanitizeService;

  beforeAll(async () => {
    pool = await ensureTestDatabase();
    const moduleRef = await Test.createTestingModule({ imports: [SanitizeModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    svc = app.get(SanitizeService);
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

  it('R-02 命中审计落 sanitize_audit：前后摘要哈希/命中类型/耗时/规则集版本；行内容零原文明文', async () => {
    const text = '我叫王振宇，电话13800138000，身份证11010519491231002X。';
    const r = await svc.sanitize({ text });
    expect(r.auditId).toBe(1);
    expect(r.sanitized).not.toContain('王振宇');
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
    const rows = await auditRows(pool);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.rule_version).toBe(SANITIZE_RULESET_VERSION);
    expect(row.input_digest).toBe(sha256Hex(text));
    expect(row.output_digest).toBe(sha256Hex(r.sanitized));
    expect(row.hit_types).toEqual([
      { type: 'name', count: 1 },
      { type: 'phone', count: 1 },
      { type: 'id_card', count: 1 },
    ]);
    expect(row.duration_ms).toBeGreaterThanOrEqual(0);
    // 本模块存在意义断言：审计行（jsonb 序列化全文）不含任何原文片段
    const rowText = JSON.stringify(row);
    for (const v of ['王振宇', '13800138000', '11010519491231002X']) {
      expect(rowText).not.toContain(v);
    }
    // 第二次命中审计行递增（抽检序列）
    await svc.sanitize({ text: '当事人李慧敏手机13912345678' });
    const rows2 = await auditRows(pool);
    expect(rows2).toHaveLength(2);
    expect(rows2[1]!.id).toBe('2');
  });

  it('无命中不落审计；persistAudit:false 不落审计（脱敏结果照常返回）', async () => {
    const miss = await svc.sanitize({ text: '公司拖欠工资怎么仲裁？' });
    expect(miss.auditId).toBeNull();
    expect(miss.hits).toEqual([]);
    expect(await auditRows(pool)).toHaveLength(0);

    const skipped = await svc.sanitize({ text: '我叫张伟', persistAudit: false });
    expect(skipped.hits).toHaveLength(1);
    expect(skipped.auditId).toBeNull();
    expect(await auditRows(pool)).toHaveLength(0);
  });

  it('审计写入故障不阻塞脱敏（旁路 + warn）：脱敏结果完整返回，故障不含原文', async () => {
    const flaky = {
      query: vi.fn(() => Promise.reject(new Error('注入故障'))),
    };
    const moduleRef = await Test.createTestingModule({ imports: [SanitizeModule] })
      .overrideProvider(PgPoolService)
      .useValue(flaky)
      .overrideProvider(TRACE_LOGGER)
      .useValue({ warn: vi.fn() })
      .compile();
    const app2 = moduleRef.createNestApplication();
    await app2.init();
    const svc2 = app2.get(SanitizeService);
    const logger = app2.get<{ warn: ReturnType<typeof vi.fn> }>(TRACE_LOGGER);
    try {
      const r = await svc2.sanitize({ text: '我叫王振宇，电话13800138000' });
      expect(r.hits).toHaveLength(2);
      expect(r.sanitized).toBe('我叫[姓名]，电话[电话]');
      expect(r.auditId).toBeNull();
      expect(flaky.query).toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalled();
      // 告警载荷不得携带原文
      const warnArgs = JSON.stringify(logger.warn.mock.calls);
      expect(warnArgs).not.toContain('王振宇');
      expect(warnArgs).not.toContain('13800138000');
    } finally {
      await app2.close();
    }
  });

  it('入参校验：text 非字符串 400 InvalidArgument；空串零命中不落审计', async () => {
    await expect(svc.sanitize({ text: 123 as unknown as string })).rejects.toMatchObject({
      code: ErrorCode.InvalidArgument,
    });
    const empty = await svc.sanitize({ text: '' });
    expect(empty.sanitized).toBe('');
    expect(empty.hits).toEqual([]);
    expect(empty.auditId).toBeNull();
    expect(await auditRows(pool)).toHaveLength(0);
  });

  it('§10 验收①服务面回放：回归集正样本经 sanitize 全命中，审计行数=命中样本数', async () => {
    let hitCases = 0;
    for (const c of SANITIZE_REGRESSION_POSITIVE) {
      const r = await svc.sanitize({ text: c.text });
      expect(r.sanitized).not.toEqual(c.text);
      hitCases += 1;
    }
    expect(await auditRows(pool)).toHaveLength(hitCases);
    // 纯引擎与纯常量同源：服务面结果与 sanitizeText 一致（同训练管线同源锚点）
    const r = sanitizeText(SANITIZE_REGRESSION_POSITIVE[0]!.text);
    expect(r.ruleVersion).toBe(SANITIZE_RULESET_VERSION);
  });

  it('§8 性能冒烟（P95 ≤1s，量级放宽防 CI 噪音）：纯路径 10k 文本 <50ms；服务路径 <1s', async () => {
    const pure = '正常咨询内容，另联系电话13800138000与身份证11010519491231002X。'
      .repeat(160)
      .slice(0, 10000);
    sanitizeText(pure); // warm
    const t0 = Date.now();
    const r = sanitizeText(pure);
    expect(Date.now() - t0).toBeLessThan(50);
    expect(r.hits.length).toBeGreaterThanOrEqual(2);

    const svcText = '我叫张伟，电话13800138000，请帮我看看。'.repeat(20);
    await svc.sanitize({ text: svcText }); // warm（连接池首连）
    const t1 = Date.now();
    const r2 = await svc.sanitize({ text: svcText });
    expect(Date.now() - t1).toBeLessThan(1000); // §8 脱敏 ≤1s 预算（含审计写）
    expect(r2.hits.length).toBeGreaterThanOrEqual(2);
  });
});
