// scripts/env-example-scope.test.mjs —— .env.example 豁免面收敛回归锁（M0-7 修复环）
//
// 背景（评审 Important #1）：.gitleaks.toml 的 .env.example 豁免曾泛化为 (^|/)\.env\.example$
// （任意深度）——未来嵌套目录的 .env.example 若含真密钥会静默逃过 gitleaks；.gitignore 的
// !.env.example 同样不限层级（嵌套示例文件可能入库）。修复=两层都精确到两条路径：
//   gitleaks 豁免：^\.env\.example$ 与 ^docker/dev/\.env\.example$（全锚定）
//   gitignore 反豁免：!/.env.example 与 !docker/dev/.env.example（嵌套 .env.example 被 .env.* 忽略）
// 修复中另发现并修正：全局豁免须用单表 [allowlist]（gitleaks v8.24 README「Global Allowlists」），
// 顶层 [[allowlists]] 被 v8.24.3 静默忽略=整段豁免失效（种子密钥双向演练证实，负例=root
// .env.example 带真实样态值仍被捕获）——本文件一并锁死语法形态。
// gitleaks 二进制真跑的正反例验证见 task-6-report.md 修复环与 docs/plans/M0-隔离演练记录.md §2.3
// ——CI 不依赖本机二进制，以本文件守住配置口径。
import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** .gitleaks.toml 全文（语法形态断言用） */
function gitleaksText() {
  return fs.readFileSync(path.join(ROOT, '.gitleaks.toml'), 'utf8');
}

/** 提取 .gitleaks.toml 全部 paths 数组中的原始正则串（'''…''' 内文） */
function gitleaksPathPatterns() {
  const out = [];
  for (const block of gitleaksText().matchAll(/paths\s*=\s*\[([^\]]*)\]/gs)) {
    for (const p of block[1].matchAll(/'''([^']+)'''/g)) out.push(p[1]);
  }
  return out;
}

describe('gitleaks 豁免面：.env.example 恰两条精确路径（修复 Important #1）', () => {
  const patterns = gitleaksPathPatterns();

  test('全局豁免用有效语法 [allowlist]（单表）；顶层 [[allowlists]] 为 v8.24.3 静默忽略的失效写法', () => {
    const text = gitleaksText();
    expect(/^\[allowlist\]$/m.test(text)).toBe(true);
    expect(/^\[\[allowlists\]\]$/m.test(text)).toBe(false);
  });
  test('豁免恰为两条全锚定路径（根 + docker/dev），不多不少', () => {
    expect(patterns).toContain('^\\.env\\.example$');
    expect(patterns).toContain('^docker/dev/\\.env\\.example$');
    expect(patterns.filter((p) => p.includes('example'))).toHaveLength(2);
  });
  test('负例：嵌套 .env.example 不被任何豁免路径正则匹配（防再泛化回任意深度）', () => {
    for (const p of patterns) {
      const re = new RegExp(p);
      expect(re.test('packages/foo/.env.example')).toBe(false);
      expect(re.test('services/core/.env.example')).toBe(false);
      expect(re.test('docker/dev/sub/.env.example')).toBe(false);
    }
  });
  test('.secrets 零豁免（凭据目录不得出现在任何豁免面）', () => {
    expect(patterns.some((p) => p.includes('secrets'))).toBe(false);
  });
});

describe('.gitignore 反豁免同口径（嵌套 .env.example 不入库）', () => {
  const lines = fs
    .readFileSync(path.join(ROOT, '.gitignore'), 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));

  test('反豁免精确两条：!/.env.example 与 !docker/dev/.env.example，无裸 !.env.example', () => {
    expect(lines).toContain('!/.env.example');
    expect(lines).toContain('!docker/dev/.env.example');
    expect(lines).not.toContain('!.env.example');
  });
});
