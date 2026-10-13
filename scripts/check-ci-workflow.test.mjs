// scripts/check-ci-workflow.test.mjs —— CI workflow 结构断言（M0-5 本机验证口径的固化）
//
// 本机无 docker 且不可达 GitHub Actions：真实运行=推送后首跑（收尾口径）。为让「六项检查都在、
// 工具版本都钉了」（Review Focus #2）不依赖人眼复核，本文件用 js-yaml 解析 .github/workflows/ci.yml
// 并断言结构——ci.yml 的任何改动若丢了检查项/丢了版本钉定，`bun test scripts/` 即刻红
//（该测试同时纳入 CI schema-refs job，形成自指一致性：workflow 定义测试，测试守护 workflow）。
import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as yamlLoad } from 'js-yaml';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CI_PATH = path.resolve(HERE, '..', '.github', 'workflows', 'ci.yml');
const ci = yamlLoad(fs.readFileSync(CI_PATH, 'utf8'));

const job = (id) => ci.jobs[id];
const stepRun = (id, keyword) =>
  job(id).steps.filter((s) => typeof s.run === 'string' && s.run.includes(keyword));

/** 某 job 内是否完成 pnpm 装配（checkout + pnpm 钉版 + node 钉版 + cache） */
function assertPnpmToolchain(id) {
  const steps = job(id).steps;
  const pnpmSetup = steps.find((s) => s.uses?.startsWith('pnpm/action-setup@'));
  expect(String(pnpmSetup?.with?.version)).toBe('12.11.2');
  const nodeSetup = steps.find((s) => s.uses?.startsWith('actions/setup-node@'));
  expect(String(nodeSetup?.with?.['node-version'])).toBe('24');
  expect(nodeSetup?.with?.cache).toBe('pnpm');
  expect(steps.some((s) => s.run === 'pnpm install --frozen-lockfile')).toBe(true);
}

describe('CI workflow：六项检查齐备（job/step 语义映射）', () => {
  test('1 lint：pnpm lint（eslint + prettier --check）', () => {
    expect(job('lint').steps.some((s) => s.run === 'pnpm lint')).toBe(true);
  });

  test('2 typecheck：pnpm typecheck（各包 tsc --noEmit）', () => {
    expect(job('typecheck').steps.some((s) => s.run === 'pnpm typecheck')).toBe(true);
  });

  test('3 test：db-check job 内 pnpm -r test（core vitest 真实 PG）', () => {
    expect(stepRun('db-check', 'pnpm -r test')).toHaveLength(1);
  });

  test('4 build：pnpm build（pnpm -r build）', () => {
    expect(job('build').steps.some((s) => s.run === 'pnpm build')).toBe(true);
  });

  test('5 跨 schema 静态检查：node scripts/check-schema-refs.mjs + bun test scripts/ 自测', () => {
    expect(stepRun('schema-refs', 'node scripts/check-schema-refs.mjs')).toHaveLength(1);
    expect(stepRun('schema-refs', 'bun test scripts/')).toHaveLength(1);
  });

  test('6 迁移检查：migrate + validate + drop 重放演练 + clean（ADR-0002 整库重放口径）', () => {
    const mig = stepRun('db-check', 'flyway migrate');
    expect(mig).toHaveLength(1);
    const run = mig[0].run;
    expect(run).toContain('flyway validate');
    expect(run).toContain('DROP SCHEMA IF EXISTS');
    expect(run).toContain('BUSINESS_SCHEMAS'); // 清单取自 scripts/db/lib.mjs，不在 CI 里复制
    expect(run).toContain('flyway clean');
  });

  test('gitleaks 密钥扫描 job：全历史检出 + 指定配置', () => {
    const steps = job('gitleaks').steps;
    const checkout = steps.find((s) => s.uses?.startsWith('actions/checkout@'));
    expect(checkout?.with?.['fetch-depth']).toBe(0);
    const scan = steps.find((s) => typeof s.run === 'string');
    expect(scan.run).toContain('zricethezav/gitleaks:');
    expect(scan.run).toContain('--config /repo/.gitleaks.toml');
    expect(scan.run).toContain('--exit-code 1');
  });
});

describe('CI workflow：工具与镜像版本钉定（Review Focus #2）', () => {
  test('node 24 / pnpm 12.11.2：所有装包 job（lint/typecheck/build/schema-refs/db-check）一致', () => {
    for (const id of ['lint', 'typecheck', 'build', 'schema-refs', 'db-check']) {
      assertPnpmToolchain(id);
    }
  });

  test('bun 1.3.13：凡跑 bun test 的 job（schema-refs 脚本自测 + db-check 的 pnpm -r test）均钉版', () => {
    for (const id of ['schema-refs', 'db-check']) {
      const bun = job(id).steps.find((s) => s.uses?.startsWith('oven-sh/setup-bun@'));
      expect(String(bun?.with?.['bun-version'])).toBe('1.3.13');
    }
  });

  test('镜像锁 tag：pgvector 0.8.0-pg15（service 与 psql 同）、flyway 13.10.0、gitleaks v8.24.3', () => {
    const pg = job('db-check').services.postgres.image;
    expect(pg).toBe('pgvector/pgvector:0.8.0-pg15'); // 与 docker/dev/docker-compose.yml 同 tag
    const run = stepRun('db-check', 'flyway migrate')[0].run;
    expect(run).toContain('flyway/flyway:13.10.0'); // 与 compose 的 flyway 服务同 tag
    expect(run).toContain('pgvector/pgvector:0.8.0-pg15');
    const gitleaksRun = job('gitleaks').steps.find((s) => typeof s.run === 'string')?.run ?? '';
    expect(gitleaksRun).toContain('zricethezav/gitleaks:v8.24.3');
  });
});

describe('CI workflow：编排卫生', () => {
  test('触发面：push(main) + pull_request；并发取消旧跑；最小权限；job 均有 timeout', () => {
    expect(ci.on ?? ci.true).toMatchObject({ push: { branches: ['main'] } });
    expect(ci.on ?? ci.true).toHaveProperty('pull_request');
    expect(ci.concurrency).toMatchObject({ 'cancel-in-progress': true });
    expect(ci.permissions).toEqual({ contents: 'read' });
    for (const id of Object.keys(ci.jobs)) {
      expect(Number(ci.jobs[id]['timeout-minutes'])).toBeGreaterThan(0);
    }
  });

  test('core 测试连接指到 CI PG（LJR_PG_PORT=5432 service 映射）', () => {
    const env = job('db-check').env;
    expect(env.LJR_PG_PORT).toBe('5432');
    expect(env.LJR_PG_HOST).toBe('127.0.0.1');
    expect(env.LJR_PG_DB).toBe('ljr_dev');
  });

  test('密钥红线：workflow 不引用任何 secrets（无 ${{ secrets.', () => {
    const raw = fs.readFileSync(CI_PATH, 'utf8');
    expect(raw.includes('secrets.')).toBe(false);
  });
});
