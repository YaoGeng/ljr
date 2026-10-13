// scripts/check-schema-refs.test.mjs —— 跨 schema 检查脚本自测（M0-5 Review Focus #3：内置违规样例集）
//
// 四类必备用例（证明不漏报不误报）：
//   ① 合法同域引用（demo 模块引 demo 表 / trade 模块引 trade 表）
//   ② 业务跨域违规（settlement 引 trade 表 = exit 1 语义；含 topic 字符串豁免与基座直连两个补充面）
//   ③ infra 白名单放行（platform/flyway/demo/pg_catalog/information_schema）
//   ④ SQL 文件内引用（.sql 在扫描面内：白名单放行 + 未知 schema 违规；DDL 跨域不判的语义锁定）
// 另含真实仓库回归（当前应零违规）与 manifest 新鲜度/提取确定性。
import { describe, expect, test } from 'bun:test';
import path from 'node:path';
import {
  analyzeFiles,
  extractRefs,
  manifestStale,
  moduleDirToSchema,
  ownerFromTsPath,
  scanRepo,
  BUSINESS_SCHEMAS,
} from './check-schema-refs.mjs';
import { extractManifest, manifestFromDisk, renderManifest } from './gen-table-manifest.mjs';

/** 样例 manifest：业务表 trade.orders + demo 三表（贴近 V3 后的真实形态） */
const MANIFEST = extractManifest([
  {
    name: 'V1__schemas_roles.sql',
    text: 'CREATE SCHEMA IF NOT EXISTS trade;\nCREATE SCHEMA IF NOT EXISTS settlement;\nCREATE SCHEMA IF NOT EXISTS demo;\n',
  },
  {
    name: 'V9__trade_orders.sql',
    text: 'CREATE TABLE IF NOT EXISTS trade.orders (id bigserial PRIMARY KEY);\n',
  },
  {
    name: 'V3__state_transition_log.sql',
    text: `CREATE TABLE IF NOT EXISTS demo.orders (id bigserial PRIMARY KEY);
CREATE TABLE IF NOT EXISTS demo.order_actions (idempotency_key varchar(128) PRIMARY KEY);
CREATE TABLE IF NOT EXISTS demo.consumed_events (event_id uuid PRIMARY KEY);\n`,
  },
]);

const violationsOf = (files) => analyzeFiles(files, MANIFEST).violations;

describe('① 合法同域引用（不误报）', () => {
  test('demo 模块引 demo 表：0 违规', () => {
    const v = violationsOf([
      {
        path: 'services/core/src/modules/demo/demo-order.service.ts',
        text: 'await uow.query(`INSERT INTO demo.orders (title) VALUES ($1)`);',
      },
    ]);
    expect(v).toEqual([]);
  });

  test('trade 模块引 trade 在册表：0 违规（同名表不同域才是跨界）', () => {
    const v = violationsOf([
      {
        path: 'services/core/src/modules/trade/order.repo.ts',
        text: 'SELECT id FROM trade.orders WHERE id = $1',
      },
    ]);
    expect(v).toEqual([]);
  });

  test('未知 schema 的引用不触发业务规则（非业务面不归本检查管）', () => {
    const v = violationsOf([
      {
        path: 'services/core/src/modules/demo/demo-order.service.ts',
        text: "const u = pool.query('SELECT * FROM other_schema.t');\nconst x = row.status;",
      },
    ]);
    expect(v).toEqual([]);
  });
});

describe('② 业务跨域违规（不漏报，exit 1 语义）', () => {
  test('settlement 模块引 trade.orders：1 违规（规则 A）', () => {
    const v = violationsOf([
      {
        path: 'services/core/src/modules/settlement/settle.service.ts',
        text: 'SELECT amount FROM trade.orders WHERE id = $1',
      },
    ]);
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ schema: 'trade', table: 'orders', rule: 'A', line: 1 });
    expect(v[0].message).toContain('settlement');
  });

  test('违规带行号（多处引用逐行报告）', () => {
    const v = violationsOf([
      {
        path: 'services/core/src/modules/settlement/settle.service.ts',
        text: 'const a = 1;\nUPDATE trade.orders SET x = 1;\nconst b = 2;\nDELETE FROM trade.orders;\n',
      },
    ]);
    expect(v.map((x) => x.line)).toEqual([2, 4]);
  });

  test('事件 topic 字符串豁免：trade.order.completed 的 order 非在册表，不误报', () => {
    const v = violationsOf([
      {
        path: 'services/core/src/modules/credit/consumer.ts',
        text: "const TOPIC = 'trade.order.completed';\nawait bus.subscribe(TOPIC, handler);",
      },
    ]);
    expect(v).toEqual([]);
  });

  test('基座/应用壳直连业务表：违规（规则 B，owner=null）', () => {
    const v = violationsOf([
      {
        path: 'services/core/src/infrastructure/outbox/outbox.service.ts',
        text: 'SELECT count(*) FROM trade.orders',
      },
      {
        path: 'services/core/src/app.module.ts',
        text: 'SELECT 1 FROM trade.orders',
      },
    ]);
    expect(v).toHaveLength(2);
    expect(v.every((x) => x.rule === 'B')).toBe(true);
  });

  test('连字符模块目录归一化：agent-assist 目录的 owner=agent_assist', () => {
    expect(moduleDirToSchema('agent-assist')).toBe('agent_assist');
    expect(ownerFromTsPath('services/core/src/modules/agent-assist/x.ts')).toBe('agent_assist');
    const v = violationsOf([
      {
        path: 'services/core/src/modules/agent-assist/x.ts',
        text: 'SELECT * FROM trade.orders',
      },
    ]);
    expect(v).toHaveLength(1);
    expect(v[0].message).toContain('agent_assist');
  });
});

describe('③ infra 白名单放行（不误报）', () => {
  test('模块代码引 platform/flyway/demo/系统目录：0 违规', () => {
    const v = violationsOf([
      {
        path: 'services/core/src/modules/demo/demo-order.service.ts',
        text: `INSERT INTO platform.outbox (event_id) VALUES ($1);
SELECT * FROM flyway.schema_history;
INSERT INTO demo.consumed_events (event_id) VALUES ($1);
SELECT count(*) FROM information_schema.tables WHERE table_schema = 'demo';
SELECT relname FROM pg_catalog.pg_class LIMIT 1;`,
      },
    ]);
    expect(v).toEqual([]);
  });
});

describe('④ SQL 文件内引用（扫描面含 .sql）', () => {
  test('SQL 引白名单 schema：0 违规', () => {
    const v = violationsOf([
      {
        path: 'services/core/migrations/V9__demo.sql',
        text: 'INSERT INTO platform.outbox (topic) VALUES ($1);\nINSERT INTO demo.orders (id) VALUES (1);\n',
      },
    ]);
    expect(v).toEqual([]);
  });

  test('SQL 引未知 schema：违规（规则 C，防拼写错误/私接）', () => {
    const v = violationsOf([
      {
        path: 'services/core/migrations/V10__bad.sql',
        text: 'INSERT INTO gh0st.venues (id) VALUES (1);',
      },
    ]);
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ schema: 'gh0st', table: 'venues', rule: 'C' });
  });

  test('SQL 引迁移已知业务 schema：放行（DDL 跨域不判的既定语义，防未来悄悄变严）', () => {
    const v = violationsOf([
      {
        path: 'services/core/migrations/V11__note.sql',
        text: '-- 注释引用 trade.orders：ALTER-only 迁移无 CREATE 可锚定归属，规则 C 放行（头注已知局限）',
      },
    ]);
    expect(v).toEqual([]);
  });
});

describe('真实仓库回归与 manifest 完整性', () => {
  test('当前仓库 0 违规（CI 每跑必断，新增跨域引用即刻红）', () => {
    const { violations } = analyzeFiles(scanRepo(), manifestFromDisk());
    expect(violations).toEqual([]);
  });

  test('入库 manifest 新鲜（规则 D：生成物不许烂尾）', () => {
    expect(manifestStale()).toBeNull();
  });

  test('manifest 提取确定性（同一输入重算字节一致）', () => {
    const m = manifestFromDisk();
    expect(renderManifest(extractManifest(diskFiles()))).toBe(renderManifest(m));
    expect(Object.keys(JSON.parse(renderManifest(m)).tables)).toContain('platform.outbox');
  });

  test('BUSINESS_SCHEMAS 与 V1 一致（13 个业务 schema 全在 manifest.schemas）', () => {
    const schemas = manifestFromDisk().schemas;
    for (const s of BUSINESS_SCHEMAS) expect(schemas).toHaveProperty(s);
  });

  test('extractRefs 带行号', () => {
    const refs = extractRefs('a\nINSERT INTO demo.orders\nb');
    expect(refs).toEqual([{ line: 2, schema: 'demo', table: 'orders' }]);
  });
});

function diskFiles() {
  return scanRepo()
    .filter((f) => f.path.endsWith('.sql'))
    .map((f) => ({ name: path.basename(f.path), text: f.text }));
}
