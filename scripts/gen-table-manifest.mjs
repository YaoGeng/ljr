// scripts/gen-table-manifest.mjs —— 表归属 manifest 生成（M0-5，跨 schema 静态检查的事实源）
//
// 从 services/core/migrations/*.sql 提取「schema / 表 → 定义所在迁移文件」，生成
// services/core/migrations/table-manifest.json 入库，供 check-schema-refs.mjs 检查与人工对照。
//
// 口径：
//   * 提取 CREATE SCHEMA 与 CREATE TABLE（含 IF NOT EXISTS / UNLOGGED 变体；本仓 DDL 全小写限定名）；
//   * 生成物确定性（不写时间戳/本机路径）——同一迁移集重跑字节级一致，方便 diff 与 CI 新鲜度校验；
//   * 文件按版本号 V<n>__ 数值排序（V10 不会插到 V2 前，字典序陷阱）；
//   * key 排序输出（schema.table 升序），人读与查表两便。
//
// 用法：node scripts/gen-table-manifest.mjs（或 pnpm gen:table-manifest）
// 幂等：重复执行输出一致；新增迁移后需重跑并提交，否则 check-schema-refs 报「manifest 过期」。
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..');
export const MIGRATIONS_DIR = path.join(ROOT, 'services', 'core', 'migrations');
export const MANIFEST_PATH = path.join(MIGRATIONS_DIR, 'table-manifest.json');

const RE_SCHEMA = /CREATE\s+SCHEMA\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)\b/gi;
const RE_TABLE =
  /CREATE\s+(?:UNLOGGED\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)/gi;

/** 版本号提取（V1__x.sql → 1）；无版本前缀的文件按 Infinity 排尾并保留原字典序 */
function versionOf(name) {
  const m = /^V(\d+)__/.exec(name);
  return m ? Number(m[1]) : Number.POSITIVE_INFINITY;
}

/**
 * 纯提取：输入 [{name, text}]（按文件名任意顺序），输出 manifest 对象（确定性）。
 * 导出供 check-schema-refs.mjs 做新鲜度校验与 bun test 自测复用。
 */
export function extractManifest(files) {
  const tables = {};
  const schemas = {};
  for (const f of [...files].sort(
    (a, b) => versionOf(a.name) - versionOf(b.name) || a.name.localeCompare(b.name),
  )) {
    for (const m of f.text.matchAll(RE_SCHEMA)) {
      schemas[m[1]] ??= f.name; // 首个定义处（IF NOT EXISTS 重复建不覆盖）
    }
    for (const m of f.text.matchAll(RE_TABLE)) {
      tables[`${m[1]}.${m[2]}`] ??= f.name;
    }
  }
  const sorted = (obj) =>
    Object.fromEntries(
      Object.keys(obj)
        .sort()
        .map((k) => [k, obj[k]]),
    );
  return {
    note: '表归属 manifest（scripts/gen-table-manifest.mjs 生成，勿手改）：新增迁移后重跑 pnpm gen:table-manifest 并提交',
    schemas: sorted(schemas),
    tables: sorted(tables),
  };
}

/** 读迁移目录 → manifest 对象 */
export function manifestFromDisk() {
  const names = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((n) => n.endsWith('.sql'))
    .sort();
  return extractManifest(
    names.map((name) => ({
      name,
      text: fs.readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8'),
    })),
  );
}

export function renderManifest(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function main() {
  const manifest = manifestFromDisk();
  fs.writeFileSync(MANIFEST_PATH, renderManifest(manifest), 'utf8');
  const nSchemas = Object.keys(manifest.schemas).length;
  const nTables = Object.keys(manifest.tables).length;
  process.stdout.write(
    `table-manifest.json 已生成：${nSchemas} 个 schema / ${nTables} 张表 -> ${path.relative(ROOT, MANIFEST_PATH)}\n`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
