// scripts/check-schema-refs.mjs —— 跨 schema 引用静态检查（M0-5，架构 §2.1/§3.2 边界纪律的 CI 执行面）
//
// 「一个功能模块只写一个架构 schema 的表；跨模块取数走接口或事件」——本脚本把这条红线
// 变成 exit 1：扫描 services/core 源码（.ts，含 SQL 模板串）与迁移 SQL（.sql）中的
// `schema.table` 引用，按下述规则判违规：
//
//   规则 A（模块代码）：src/modules/<module>/**.ts 的 owner = <module>（目录名，连字符归一化
//     为下划线，对齐 V1 偏离声明 agent-assist→agent_assist）。引用「业务 schema 的 manifest
//     在册表」且 schema ≠ owner = 违规。
//     —— 同时要求表在 manifest（schema.tables）在册：事件 topic 字符串如
//     'trade.order.completed' 中的 trade.order 不是表（order ∉ manifest），不误报；
//     代价是拼错表名不在检测范围（运行期由 DB role 授权兜底）。
//   规则 B（基座/应用壳）：src/ 下不在 modules/ 的 .ts（infrastructure/、main/app 壳）owner=null，
//     引用任何业务 schema 的在册表 = 违规——横切基座不得直连业务表（业务模块经基座服务
//     访问 infra 表是合法反向，见白名单 platform 条目）。
//   规则 C（迁移 SQL）：migrations/*.sql 引用「白名单 ∪ 迁移已知 schema」以外的 schema = 违规
//     （防拼错/私接未知 schema）。已知局限：迁移文件内跨模块 DDL（如 FK 引他域表）不做逐文件
//     归属判定——ALTER-only 迁移无 CREATE 可锚定归属；该风险由规则 A/B（代码侧引用点）+
//     V1/V2 的 role 授权收紧（业务 role 无他域 USAGE）双层兜底。
//   规则 D（manifest 新鲜度）：入库的 table-manifest.json 必须与 migrations 现算一致，
//     过期 = exit 1（提示重跑 pnpm gen:table-manifest）——生成物不许烂尾。
//
// 白名单（WHITELIST，写死并附理由——业务/元数据/演示三层，非业务 schema 一律不放行）：
//   platform           infra 横切（Ruling-4/V2 头注）：outbox/死信/state_transition_log。
//                      业务模块经基座服务（OutboxService/守卫）访问属设计内合法跨域；
//                      「不经基座直连」由 DB 授权兜底（platform 表权限只授 ljr_platform）。
//   flyway             迁移元数据 schema（flyway.conf defaultSchema=flyway）。
//   demo               M0-4 验收脚手架 schema（可抛弃，M1 起可整体下线）。
//   pg_catalog         PG 系统目录（内省查询）。
//   information_schema PG 信息模式（内省查询，如 information_schema.tables）。
//
// 用法：node scripts/check-schema-refs.mjs（或 pnpm check:schema-refs）。违规/过期 exit 1。
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { MANIFEST_PATH, MIGRATIONS_DIR, manifestFromDisk } from './gen-table-manifest.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..');
export const CORE_SRC = path.join(ROOT, 'services', 'core', 'src');

/** 13 个业务 schema（事实源=V1/架构 §3.2；与 V1 增删须同步，main() 有 drift 断言） */
export const BUSINESS_SCHEMAS = [
  'identity',
  'schedule',
  'pricing',
  'trade',
  'fulfillment',
  'payment',
  'settlement',
  'credit',
  'review',
  'notify',
  'benefits',
  'agent_assist',
  'ops',
];

/** 白名单：schema → 放行理由（头注「规则 D」上方详述） */
export const WHITELIST = {
  platform: 'infra 横切（Ruling-4）：outbox/死信/守卫留痕，业务经基座服务访问，DB 授权兜底',
  flyway: '迁移元数据 schema（flyway.conf defaultSchema）',
  demo: 'M0-4 验收脚手架（可抛弃，M1 起可下线）',
  pg_catalog: 'PG 系统目录（内省查询）',
  information_schema: 'PG 信息模式（内省查询）',
};

const RE_REF = /([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)/g;

/**
 * 测试夹具豁免（文件级，M1-W1 I1 起需要）：testing/db.ts 的 TEST_DB_TABLES 是 TRUNCATE 清场清单，
 * 职责即枚举全部业务表（每模块施工迁移动必追加，core/AGENTS.md WHERE TO LOOK 明文口径）——
 * test-only 清场动作，不是运行时数据访问路径，规则 B 的「横切基座不得直连业务表」不适用于此。
 * 运行时直连（outbox/guard/app 壳等）照常违规，豁免面只有列出的文件。
 */
export const TEST_HELPER_FILES = new Set(['services/core/src/infrastructure/testing/db.ts']);

/** 模块目录名 → schema 名（agent-assist → agent_assist，对齐 V1 偏离声明） */
export function moduleDirToSchema(dir) {
  return dir.replaceAll('-', '_');
}

/** 从 .ts 相对路径判 owner：src/modules/<m>/... → schema 名；否则 null（基座/应用壳） */
export function ownerFromTsPath(relPath) {
  const m = /(?:^|[/\\])modules[/\\]([^/\\]+)[/\\]/.exec(relPath);
  return m ? moduleDirToSchema(m[1]) : null;
}

/** 提取全文 `schema.table` 引用（带行号） */
export function extractRefs(text) {
  const refs = [];
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    for (const m of line.matchAll(RE_REF)) {
      refs.push({ line: i + 1, schema: m[1], table: m[2] });
    }
  });
  return refs;
}

/**
 * 纯分析（供 bun test 自测复用）。
 * @param {Array<{path:string, text:string}>} files 相对仓库根的 path；.ts 判 owner，.sql 走规则 C
 * @param {{tables: Record<string,string>, schemas: Record<string,string>}} manifest
 * @returns {{violations: Array<{path:string,line:number,schema:string,table:string,rule:string,message:string}>}}
 */
export function analyzeFiles(files, manifest) {
  const business = new Set(BUSINESS_SCHEMAS);
  const whitelist = new Set(Object.keys(WHITELIST));
  const knownSchemas = new Set([...Object.keys(manifest.schemas), ...business, ...whitelist]);
  const tablesBySchema = {};
  for (const key of Object.keys(manifest.tables)) {
    const [schema, table] = key.split('.');
    (tablesBySchema[schema] ??= new Set()).add(table);
  }
  const violations = [];

  for (const f of files) {
    const isSql = f.path.endsWith('.sql');
    const owner = isSql ? null : ownerFromTsPath(f.path);
    if (!isSql && TEST_HELPER_FILES.has(f.path)) continue; // 测试夹具豁免（见 TEST_HELPER_FILES 头注）
    for (const ref of extractRefs(f.text)) {
      const { schema, table } = ref;
      if (whitelist.has(schema)) continue; // 白名单放行（含 .sql）
      if (isSql) {
        // 规则 C：迁移 DDL 只允许白名单与迁移已知 schema（见头注已知局限）
        if (!knownSchemas.has(schema)) {
          violations.push({
            path: f.path,
            line: ref.line,
            schema,
            table,
            rule: 'C',
            message: `SQL 引用未知 schema ${schema}.${table}（不在迁移已知 schema 与白名单内，疑似拼写错误或私接）`,
          });
        }
        continue;
      }
      // 规则 A/B：仅当命中「业务 schema 的在册表」才算跨界引用（topic 字符串豁免，见头注）
      if (!business.has(schema) || !tablesBySchema[schema]?.has(table)) continue;
      if (owner === schema) continue; // 同域引用
      violations.push({
        path: f.path,
        line: ref.line,
        schema,
        table,
        rule: owner === null ? 'B' : 'A',
        message:
          owner === null
            ? `基座/应用壳代码直连业务表 ${schema}.${table}（横切层不得直连业务表）`
            : `模块 ${owner} 代码跨域引用业务表 ${schema}.${table}（跨模块取数走接口或事件，架构 §3.2）`,
      });
    }
  }
  return { violations };
}

function walk(dir, exts, acc = []) {
  for (const entry of fs
    .readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, exts, acc);
    else if (exts.some((e) => entry.name.endsWith(e))) acc.push(full);
  }
  return acc;
}

/** 真实仓库扫描（相对根路径 + 文本） */
export function scanRepo() {
  const files = [...walk(CORE_SRC, ['.ts']), ...walk(MIGRATIONS_DIR, ['.sql'])].map((full) => ({
    path: path.relative(ROOT, full).replaceAll('\\', '/'),
    text: fs.readFileSync(full, 'utf8'),
  }));
  return files;
}

/** 入库 manifest 与现算是否一致（规则 D） */
export function manifestStale() {
  if (!fs.existsSync(MANIFEST_PATH))
    return 'table-manifest.json 缺失（先跑 pnpm gen:table-manifest）';
  const committed = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  const fresh = manifestFromDisk();
  if (JSON.stringify(committed) !== JSON.stringify(fresh)) {
    return 'table-manifest.json 与 migrations 不一致（migrations 变更后重跑 pnpm gen:table-manifest 并提交）';
  }
  return null;
}

function main() {
  const stale = manifestStale();
  if (stale) {
    process.stderr.write(`[manifest 过期] ${stale}\n`);
    process.exit(1);
  }
  const manifest = manifestFromDisk();
  // 配置漂移断言：V1 已建的 13 业务 schema 必须都在 manifest.schemas（反之 V1 多建/漏建即停）
  const missing = BUSINESS_SCHEMAS.filter((s) => !(s in manifest.schemas));
  if (missing.length > 0) {
    process.stderr.write(
      `[配置漂移] V1 未创建业务 schema：${missing.join(', ')}（脚本 BUSINESS_SCHEMAS 与 V1 须同步）\n`,
    );
    process.exit(1);
  }

  const files = scanRepo();
  const { violations } = analyzeFiles(files, manifest);
  const nRefs = files.reduce((n, f) => n + extractRefs(f.text).length, 0);
  if (violations.length > 0) {
    process.stderr.write(`跨 schema 检查不通过（${violations.length} 处违规，exit 1）：\n`);
    for (const v of violations) {
      process.stderr.write(`  [${v.rule}] ${v.path}:${v.line} ${v.message}\n`);
    }
    process.exit(1);
  }
  process.stdout.write(
    `跨 schema 检查通过：${files.length} 个文件 / ${nRefs} 处 schema.table 引用，0 违规` +
      `（白名单：${Object.keys(WHITELIST).join(', ')}）\n`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
