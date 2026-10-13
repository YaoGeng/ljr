// scripts/db/setup-tools.mjs —— portable 轨工具栈下载/解压（M0-3，全程用户态免管理员）
// 组件（版本与 URL 锁定，禁 latest 口径；URL 失效时去官方归档页换新版并同步本清单）：
//   1) PostgreSQL 15 免安装 binaries（EDB 官方 zip）  → .tools/pg15
//   2) Flyway CLI（官方 GitHub release zip）           → .tools/flyway
// 注：Flyway windows-x64 zip 自带 jre/（flyway.cmd 优先用它），无需单独安装 JRE；
//     若改用不含 jre 的发行形态，再补 Temurin 17 JRE zip 解压并设 FLYWAY_JAVA_CMD/JAVA_HOME。
// 下载走 curl（断点续传 -C -，--retry），解压走 Windows 自带 bsdtar（System32\tar.exe）。
// 重跑安全：组件就位即跳过；.tools/ 已 gitignore。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { TOOLS, ROOT, FLYWAY_HOME, FLYWAY_CONF, pgBin, log, die, run } from './lib.mjs';

const SYSTEM32 = 'C:\\Windows\\System32';

const COMPONENTS = [
  {
    name: 'PostgreSQL 15（EDB binaries）',
    version: '15.16-1',
    url: 'https://get.enterprisedb.com/postgresql/postgresql-15.16-1-windows-x64-binaries.zip',
    marker: pgBin('psql'),
    target: path.join(TOOLS, 'pg15'), // zip 顶层 pgsql/ 重命名而来，bin/lib 在其下
    check: () => run(pgBin('psql'), ['--version']),
  },
  {
    name: 'Flyway CLI',
    version: '13.10.0',
    url: 'https://github.com/flyway/flyway/releases/download/flyway-13.10.0/flyway-commandline-13.10.0-windows-x64.zip',
    marker: path.join(FLYWAY_HOME, 'flyway.cmd'),
    target: FLYWAY_HOME, // zip 内为 flyway-13.10.0/（flyway.cmd、jre/、drivers/ 等在其下）
    // 顺带以正式 conf 启动（CWD=services/core），版本输出的同时烟测 conf 可解析
    check: () =>
      run(
        'cmd.exe',
        [
          '/c',
          path.join(FLYWAY_HOME, 'flyway.cmd'),
          `-configFiles=${FLYWAY_CONF}`,
          '-configFileEncoding=UTF-8',
          '-v',
        ],
        { cwd: path.join(ROOT, 'services', 'core') },
      ),
  },
];

// Windows 自带工具解析（Git Bash 的 /usr/bin 下有同名 GNU 工具，须显式用 System32 版本：
// curl 需系统版断点续传行为一致，tar 需 bsdtar 才能解 zip）
function systemTool(name) {
  const full = path.join(SYSTEM32, `${name}.exe`);
  if (fs.existsSync(full)) return full;
  return name;
}

function download(url, file) {
  const r = spawnSync(
    systemTool('curl'),
    [
      '--fail',
      '--location',
      '--retry',
      '5',
      '--retry-delay',
      '3',
      '--continue-at',
      '-',
      '--output',
      file,
      url,
    ],
    { stdio: 'inherit' },
  );
  if (r.error || r.status !== 0) die(`下载失败（可重跑续传）: ${url}`);
}

function extract(zipFile, staging) {
  fs.mkdirSync(staging, { recursive: true });
  run(systemTool('tar'), ['-xf', zipFile, '-C', staging]);
}

// 解压后定位 zip 内唯一顶层目录（各 zip 均为单目录打包）
function singleTopDir(staging, name) {
  const entries = fs.readdirSync(staging).filter((e) => e !== '__MACOSX');
  if (entries.length !== 1 || !fs.statSync(path.join(staging, entries[0])).isDirectory()) {
    die(`${name}: zip 结构非预期（顶层目录应为 1 个，实际 ${entries.length} 个）`);
  }
  return path.join(staging, entries[0]);
}

function install(comp) {
  const downloads = path.join(TOOLS, 'downloads');
  const staging = path.join(TOOLS, `.extract-${comp.name.replace(/[^a-z0-9]+/gi, '-')}`);
  const zipFile = path.join(downloads, comp.url.split('/').pop());

  fs.mkdirSync(downloads, { recursive: true });
  log(`[2/4] 下载 ${comp.name} ${comp.version} …`);
  download(comp.url, zipFile);

  log('[3/4] 解压 …');
  fs.rmSync(staging, { recursive: true, force: true });
  extract(zipFile, staging);
  const inner = singleTopDir(staging, comp.name);
  fs.rmSync(comp.target, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(comp.target), { recursive: true });
  fs.renameSync(inner, comp.target);
  fs.rmSync(staging, { recursive: true, force: true });
}

function main() {
  fs.mkdirSync(TOOLS, { recursive: true });
  for (const comp of COMPONENTS) {
    log(`== ${comp.name} ${comp.version} ==`);
    if (fs.existsSync(comp.marker)) {
      log(`[跳过] 已就位（重装先删除 ${comp.target}）`);
    } else {
      install(comp);
    }
    log('[4/4] 版本：');
    comp.check();
    log('');
  }
  log('portable 栈就绪：PG15 + Flyway CLI（自带 jre）（位于 .tools/，已 gitignore）');
}

main();
