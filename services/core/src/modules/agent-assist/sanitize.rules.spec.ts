/**
 * E1 实时脱敏层——纯引擎单测（无需 PG）：回归集全命中/0 漏杀、负样本不误杀、确定性、
 * R-02 分离铁律（占位符映射与脱敏文本结构分离、原文不残留）、占位符编号、码点偏移、
 * 各规则边界（证件号校验位/Luhn/号段/姓名姓氏边界/地址动词前缀）、跨规则优先级。
 * 施工规格：docs/modules/E-AI辅助/E1-Agent草稿气泡管线.md §7 R-02、§9 TDD、§10 验收①。
 */
import { describe, expect, it } from 'vitest';
import { SANITIZE_REGRESSION_NEGATIVE, SANITIZE_REGRESSION_POSITIVE } from './sanitize.regression';
import { SANITIZE_RULESET_VERSION, sanitizeText } from './sanitize.rules';

/** 断言一批命中后：每个 value 不残留（0 漏杀）、类型计数精确、映射值=原文码点切片 */
function assertCase(text: string, expectCounts: Record<string, number>, values: readonly string[]) {
  const r = sanitizeText(text);
  const byType: Record<string, number> = {};
  for (const h of r.hits) byType[h.type] = (byType[h.type] ?? 0) + 1;
  expect(byType).toEqual(expectCounts);
  // 0 漏杀：脱敏文本不得残留任何 value
  for (const v of values) expect(r.sanitized).not.toContain(v);
  // 映射完整性：每个 value 都在 placeholders 中，且经码点偏移可从原文重建
  expect(r.placeholders.map((p) => p.value).sort()).toEqual([...values].sort());
  expect(r.hits).toHaveLength(r.placeholders.length);
  const cps = Array.from(text);
  for (const h of r.hits) {
    expect(cps.slice(h.start, h.end).join('')).toBe(
      r.placeholders.find((p) => p.token === h.placeholder)!.value,
    );
  }
  return r;
}

describe('E1 脱敏引擎：PII 回归集（§9 漏杀回归 / §10 验收①）', () => {
  it('正样本全命中 0 漏杀：每类型 ≥3 变体 + 五类型混合，类型计数精确且原文不残留', () => {
    for (const c of SANITIZE_REGRESSION_POSITIVE) {
      assertCase(c.text, c.expect as Record<string, number>, c.values);
    }
  });

  it('负样本零命中不误杀：普通咨询文本与形似 PII 干扰串原样通过', () => {
    for (const text of SANITIZE_REGRESSION_NEGATIVE) {
      const r = sanitizeText(text);
      expect(r.hits).toEqual([]);
      expect(r.placeholders).toEqual([]);
      expect(r.sanitized).toBe(text);
    }
  });

  it('同文本确定性：同输入同输出（两次调用全等）', () => {
    const text = SANITIZE_REGRESSION_POSITIVE.at(-1)!.text;
    expect(JSON.stringify(sanitizeText(text))).toBe(JSON.stringify(sanitizeText(text)));
  });

  it('规则集版本常量随行（审计锚点）：semver 形态', () => {
    expect(SANITIZE_RULESET_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe('R-02 分离铁律：占位符映射仅供律师端还原，与脱敏文本结构分离', () => {
  it('sanitized 与 hits 的序列化不含任何原文值；原文只能经 placeholders.value 取得', () => {
    for (const c of SANITIZE_REGRESSION_POSITIVE) {
      const r = sanitizeText(c.text);
      const leakSurface = r.sanitized + JSON.stringify(r.hits) + r.ruleVersion;
      for (const v of c.values) expect(leakSurface).not.toContain(v);
      // 结构分离：hits 只带类型/占位符/偏移，无 value 字段
      for (const h of r.hits) {
        expect(Object.keys(h).sort()).toEqual(['end', 'placeholder', 'start', 'type']);
      }
    }
  });

  it('码点偏移口径（与 knowledge_chunks.metadata 一致）：emoji 代理对不破坏偏移重建', () => {
    const text = '🙂请查证我身份证11010519491231002X的真伪';
    const r = sanitizeText(text);
    expect(r.hits).toHaveLength(1);
    const cps = Array.from(text);
    expect(cps.slice(r.hits[0]!.start, r.hits[0]!.end).join('')).toBe('11010519491231002X');
    expect(r.sanitized.startsWith('🙂请查证我身份证[证件号]的真伪')).toBe(true);
  });
});

describe('占位符编号：同类型第 1 次命中=[电话]，第 k 次=[电话k]（按出现顺序确定性编号）', () => {
  it('两个电话+两个姓名 → [电话]/[电话2]/[姓名]/[姓名2]', () => {
    const r = sanitizeText('我叫王振宇手机13800138000，我叫李慧敏手机13912345678，请回电。');
    expect(r.hits.map((h) => h.type)).toEqual(['name', 'phone', 'name', 'phone']);
    expect(r.hits.map((h) => h.placeholder)).toEqual(['[姓名]', '[电话]', '[姓名2]', '[电话2]']);
    expect(r.sanitized).toBe('我叫[姓名]手机[电话]，我叫[姓名2]手机[电话2]，请回电。');
    expect(r.placeholders.map((p) => p.value)).toEqual([
      '王振宇',
      '13800138000',
      '李慧敏',
      '13912345678',
    ]);
  });
});

describe('各规则边界（每条规则至少 1 个独立用例）', () => {
  it('证件号：18 位校验位算法把门——校验位不符不拦（长数字单号不误杀）；15 位日期段非法不拦', () => {
    // 同基址、校验位错（应为 X）
    const bad18 = sanitizeText('110105194912310021');
    expect(bad18.hits).toEqual([]);
    expect(bad18.sanitized).toBe('110105194912310021');
    // 15 位但出生日期段非法（月=00）
    expect(sanitizeText('订单号202403150001234有争议').hits).toEqual([]);
  });

  it('银行卡：Luhn 合法才拦；非 Luhn 13-19 位数字串（单号）不拦；空格分组可命中', () => {
    expect(sanitizeText('4111111111119').hits[0]?.type).toBe('bank_card'); // 13 位合法
    expect(sanitizeText('3024567890123').hits).toEqual([]); // 13 位非 Luhn
    const spaced = sanitizeText('卡 6217 0000 1001 2348 冻结');
    expect(spaced.hits[0]?.type).toBe('bank_card');
    expect(spaced.placeholders[0]?.value).toBe('6217 0000 1001 2348');
  });

  it('电话：11 位 1[3-9] 号段命中；位长越界（12 位）与非号段（12 开头）不拦', () => {
    expect(sanitizeText('号码13712345678收到').hits[0]?.type).toBe('phone');
    expect(sanitizeText('138001380001越界').hits).toEqual([]);
    expect(sanitizeText('12345678901非号段').hits).toEqual([]);
  });

  it('姓名：关键词+姓氏边界；非姓氏开头不拦；尾随连接词不吞（回退）', () => {
    expect(sanitizeText('我叫周女士来电').placeholders[0]?.value).toBe('周女士');
    expect(sanitizeText('我是外地户口，想问社保转移').hits).toEqual([]);
    const trail = sanitizeText('当事人李慧敏在试用期被辞退');
    expect(trail.placeholders[0]?.value).toBe('李慧敏'); // 在 不被吞进姓名
    expect(trail.sanitized).toBe('当事人[姓名]在试用期被辞退');
  });

  it('地址：动词/否定前缀不吞（住在/不在 之外的地址本体）；否定语义字面不被卷入占位符', () => {
    const a = sanitizeText('住在北京市的网友咨询');
    expect(a.sanitized.startsWith('住在')).toBe(true);
    expect(a.placeholders[0]?.value).toBe('北京市');
    const b = sanitizeText('我不在北京市，是外地咨询');
    expect(b.placeholders[0]?.value).toBe('北京市');
    expect(b.sanitized.startsWith('我不在')).toBe(true);
  });

  it('跨规则优先级：带空格分隔的 18 位证件号只出一个 id_card 命中，不再切出电话/银行卡', () => {
    const r = sanitizeText('身份证440301 19900307 751X请核验');
    expect(r.hits).toHaveLength(1);
    expect(r.hits[0]?.type).toBe('id_card');
    expect(r.sanitized).toBe('身份证[证件号]请核验');
  });
});
