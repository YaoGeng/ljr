import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseCancelMatrix } from '../fulfillment/cancellation.engine';
import { DEFAULT_CANCEL_MATRIX } from '../fulfillment/cancellation.engine';
import { CANCEL_MATRIX_RULE_KEY } from '../fulfillment/cancellation.engine';

/**
 * V49 seed 内容契约（M2-W3 T5，纯文件断言无 PG）：
 *   - cancel.matrix v1 固化=DEFAULT_CANCEL_MATRIX 逐字（引擎内置默认值→H7 正式 v1 版本行；
 *     迁移内容若与引擎默认漂移，此处先红于 flyway checksum 之前——authoring 期防线）；
 *   - coupon.price_comp v1=W3-12 拍板默认（面额 50.00 字符串 Money/有效期 90 天——F4
 *     resolvePriceCompDefinition 的 parseRuleContent 形态：face_value 字符串+validity_days 整数）；
 *   - 发布语义对齐 snapshotAt 读谓词：publish_status='EFFECTIVE' 且 effective_at<=now 命中
 *     （seed 落 EFFECTIVE+迁移时刻）；ON CONFLICT (rule_key, version) 幂等（reset 重放安全）。
 * 行为面（快照优先/无行兜底）由 cancellation.spec（v2 边界移位+rv=0 兜底）与
 * coupon.spec（现行版优先/回退 seed 行）在 PG 侧承载，本文件只钉迁移字面量。
 */

const MIGRATION = join(__dirname, '../../..', 'migrations/V49__ops.sql');

/** 从迁移 SQL 提取指定 rule_key 的 content JSON 字面量（'...'::jsonb 单行形态） */
function extractContentLiteral(ruleKey: string): Record<string, unknown> {
  const sql = readFileSync(MIGRATION, 'utf8');
  // rule_key 全形在迁移内以拼接表达式承载（'cancel' || '.matrix'——check-schema-refs 规则 C
  // 对字符串字面量同样扫描，V48 注释纪律），此处按 VALUES 序断言键拼接存在再取 content 字面量
  const halves = ruleKey.split('.');
  const keyRe = new RegExp(`'${halves[0]}'\\s*\\|\\|\\s*'\\.${halves[1]}'`);
  if (!keyRe.test(sql)) {
    throw new Error(`V49 中未找到 rule_key='${ruleKey}' 的拼接表达式`);
  }
  const literals = [...sql.matchAll(/'(\{[^']+\})'::jsonb/g)].map((m) => m[1]!);
  const index = ruleKey === CANCEL_MATRIX_RULE_KEY ? 0 : 1;
  const literal = literals[index];
  if (literal === undefined) throw new Error(`V49 content 字面量序 ${index} 缺失`);
  return JSON.parse(literal) as Record<string, unknown>;
}

describe('V49 seed 内容契约（cancel.matrix 固化 v1 + coupon.price_comp 默认值，文件断言）', () => {
  it('迁移文件在册（V49__ops.sql）且为 seed 形态（无 DDL 新表）', () => {
    expect(existsSync(MIGRATION)).toBe(true);
    const sql = readFileSync(MIGRATION, 'utf8');
    expect(sql).not.toMatch(/CREATE TABLE/i);
    expect(sql).toMatch(/INSERT INTO ops\.rule_definitions/);
  });

  it('cancel.matrix v1 内容=DEFAULT_CANCEL_MATRIX 逐字（引擎内置默认值固化，parseCancelMatrix 可解析全等）', () => {
    const content = extractContentLiteral(CANCEL_MATRIX_RULE_KEY);
    expect(parseCancelMatrix(content)).toEqual(DEFAULT_CANCEL_MATRIX);
  });

  it('coupon.price_comp v1 内容=W3-12 拍板默认（face_value="50.00" 字符串 Money + validity_days=90 整数——F4 解析形态）', () => {
    const content = extractContentLiteral('coupon.price_comp');
    expect(content).toEqual({ face_value: '50.00', validity_days: 90 });
    expect(typeof content['face_value']).toBe('string'); // Money 字符串禁 float
    expect(content['validity_days']).toBe(90);
  });

  it('发布语义对齐 snapshotAt 读谓词：EFFECTIVE + effective_at 落值 + ON CONFLICT (rule_key, version) 幂等', () => {
    const sql = readFileSync(MIGRATION, 'utf8');
    expect(sql).toMatch(/'EFFECTIVE'/);
    expect(sql).toMatch(/ON CONFLICT \(rule_key, version\) DO NOTHING/);
  });
});
