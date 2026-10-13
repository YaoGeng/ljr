// scripts/sandbox/first-run.mjs —— 第三方脚本首跑容器包装（M0-7，技能指南 §7-5 第 5 条）
//
// 「第三方技能附带的脚本一律先在无凭据的隔离容器中首跑审行为」——本脚本把该纪律落成可执行
// 动作：审计（三重防御校验）→ 全过则生成最小权限 docker 命令（--dry-run 打印 / 默认真跑），
// 任一 BLOCKER 即拒绝执行、不生成命令。
//
// 隔离参数（最小权限面，buildDockerCommand 是唯一定义处）：
//   docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges
//     --user 65534:65534            # nobody，非 root
//     --tmpfs /tmp:rw,noexec,size=64m
//     -e HOME=/tmp                  # 唯一显式 env 且为字面量：宿主环境变量一律不透传（无凭据环境）
//     -v <脚本所在目录>:/sandbox:ro  # 只读挂载工作目录（挂载源=脚本所在目录，不挂仓库根）
//     --workdir /sandbox
//
// 三重防御校验（任一命中 = BLOCKER，exit 1）：
//   校验 1 路径穿越（PATH_ESCAPE/NOT_FOUND/NOT_A_FILE）：目标脚本必须存在于 --root（默认
//     仓库根）内且为普通文件——绝对路径出 root、.. 逃逸、不存在、非常规文件均拒绝，
//     防审计对象名不副实。
//   校验 2 凭据目录（CRED_DIR/CRED_FILE）：挂载源（脚本所在目录，含自身 basename 与全子树）
//     不得含凭据目录/凭据名文件（清单见 CRED_DIRS/CRED_FILES/CRED_FILE_PATTERNS，含 .npmrc/
//     .pypirc/.yarnrc.yml 等包管理器凭据载体；名称统一小写比较，Windows 大小写不敏感不漏拦）
//     ——挂进容器 = 对 agent 可见 = 违反「凭据相关目录与密钥存储对 agent 文件系统不可见」
//     （§7-5 第 5 条）。
//   校验 3 出站白名单（EGRESS_NOT_ALLOWED）：挂载源内文本文件的 https?:// 引用逐个比对允许
//     域名（DEFAULT_EGRESS_ALLOWLIST：npm registry / GitHub / Docker Hub 拉取链路，演练记录
//     §1 的初始清单）。容器内 --network none 本就无出站，此校验在宿主侧提前暴露「脚本想外传
//     到哪」；白名单外域名须走扩展流程（--allow-domain 临时放行并留痕，永久新增记入演练记录）。
//
// 已知边界（如实声明，不静默放行）：walk 超上限（LIMITS）= SCAN_INCOMPLETE 拒绝（审不动就
//   拒绝，先拷最小闭包到隔离暂存目录再审）；不跟随符号链接目录；仅识别 scheme 显式 URL，
//   npm registry 简写（registry:foo）等不识别；镜像必须锁 tag（IMAGE_UNPINNED，CI 同纪律）。
//
// 用法：
//   node scripts/sandbox/first-run.mjs [--dry-run] [--root <dir>] [--image <ref>]
//          [--allow-domain <host>]... <script> [script-args...]
// 本机无 docker（Ruling-6）：--dry-run 输出将执行的 docker 命令（逻辑自证），真跑留待 docker
// 环境补演练（去掉 --dry-run 即真跑，见 docs/plans/M0-隔离演练记录.md §3）。
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..', '..');
export const MOUNT_DST = '/sandbox';

/** 首跑镜像默认值（锁 tag；与 CI node-version 24 对齐） */
export const DEFAULT_IMAGE = 'node:24-alpine';

/** 出站白名单初始清单（域名一律小写；演练记录 §1 的事实源，测试断言成员集防无意识漂移） */
export const DEFAULT_EGRESS_ALLOWLIST = {
  'registry.npmjs.org': 'npm 官方 registry（依赖安装）',
  'github.com': 'GitHub（依赖仓库/发布件页面）',
  'api.github.com': 'GitHub API（仓库元数据核实，如 license/commit）',
  'registry-1.docker.io': 'Docker Hub 镜像拉取端点',
  'auth.docker.io': 'Docker Hub 拉取认证',
  'production.cloudflare.docker.com': 'Docker Hub 镜像层 CDN',
};

/** 凭据目录名（挂载源自身或子树命中即拒绝；credCodeFor 统一小写比较） */
export const CRED_DIRS = ['.secrets', '.ssh', '.aws', '.kube', '.docker', '.gnupg'];
/**
 * 凭据文件名（精确匹配，统一小写比较——Windows 大小写不敏感，.ENV/_NETRC 同样拦）。
 * .npmrc/.pypirc/.yarnrc.yml：包管理器凭据载体（npm _authToken= / pip index 密码 /
 * yarn npmAuthToken:）——无扩展名/非文本扩展名，不进 TEXT_EXTS 出站扫描，挂进容器零告警，
 * 而 stdio inherit 使脚本 stdout 可直达宿主，故必须在此名单拦截。
 */
export const CRED_FILES = [
  '.env',
  '.git-credentials',
  '.netrc',
  '_netrc',
  'credentials',
  '.npmrc',
  '.pypirc',
  '.yarnrc.yml',
];
/** 凭据文件名模式（输入已小写；含 .env.* 变体与私钥/证书惯用后缀） */
export const CRED_FILE_PATTERNS = [
  /^\.env($|\.)/,
  /\.pem$/,
  /\.key$/,
  /\.p12$/,
  /\.pfx$/,
  /^id_(rsa|dsa|ecdsa|ed25519)/,
];

/** 出站引用扫描覆盖的文本扩展名（脚本本体 .js/.mjs/.cjs/.sh 均在内） */
export const TEXT_EXTS = new Set([
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.mts',
  '.cts',
  '.json',
  '.sh',
  '.bash',
  '.zsh',
  '.py',
  '.yaml',
  '.yml',
  '.toml',
  '.md',
  '.txt',
  '.ini',
  '.cfg',
  '.conf',
  '.xml',
]);

/** walk/扫描上限：超限 = SCAN_INCOMPLETE（拒绝执行，宁拒勿漏） */
export const LIMITS = { walkEntries: 4000, textFiles: 400, fileBytes: 1_000_000, findings: 50 };

/** 脚本类型 → 容器内运行器（默认镜像 node:24-alpine；.py 等其他类型须自备 --image 并本脚本不代跑） */
export const RUNNERS = { '.js': 'node', '.mjs': 'node', '.cjs': 'node', '.sh': 'sh' };

const RE_URL = /https?:\/\/[A-Za-z0-9][A-Za-z0-9.-]*[A-Za-z0-9](?::\d+)?/g;

/**
 * 参数解析（供 bun test 自测复用）。
 * @returns {{error?:string, dryRun:boolean, root:string, image:string,
 *   allowDomains:string[], script:string, scriptArgs:string[]}}
 */
export function parseArgs(argv) {
  const opts = {
    dryRun: false,
    root: ROOT,
    image: DEFAULT_IMAGE,
    allowDomains: [],
    script: '',
    scriptArgs: [],
  };
  const rest = [...argv];
  const value = (flag) => {
    const v = rest.shift();
    if (v === undefined) opts.error = `参数 ${flag} 缺少取值`;
    return v;
  };
  while (rest.length > 0 && !opts.error) {
    const a = rest.shift();
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--root') opts.root = path.resolve(String(value(a)));
    else if (a === '--image') opts.image = String(value(a));
    else if (a === '--allow-domain') opts.allowDomains.push(String(value(a)).toLowerCase());
    else if (a.startsWith('--')) opts.error = `未知参数 ${a}`;
    else if (opts.script === '') opts.script = a;
    else opts.scriptArgs.push(a);
  }
  if (!opts.error && opts.script === '') opts.error = '缺少目标脚本参数（用法见文件头注）';
  return opts;
}

/** 凭据名判定（名称统一小写后比较——Windows 大小写不敏感文件系统下 .ENV/ID_RSA 同样拦）：返回 CRED_DIR / CRED_FILE / null */
export function credCodeFor(name, isDir) {
  const n = name.toLowerCase();
  if (isDir && CRED_DIRS.includes(n)) return 'CRED_DIR';
  if (!isDir && CRED_FILES.includes(n)) return 'CRED_FILE';
  if (!isDir && CRED_FILE_PATTERNS.some((re) => re.test(n))) return 'CRED_FILE';
  return null;
}

/**
 * 审计目标脚本与挂载源（三重防御校验，纯函数，供 bun test 自测复用）。
 * @param {{root:string, image:string, allowDomains:string[], script:string}} opts
 * @returns {{findings:Array<{code:string,message:string}>, scriptAbs:string, scriptBase:string,
 *   mountSrc:string, runner:string|null, ext:string, allow:Set<string>,
 *   stats:{entries:number, textFiles:number, scannedBytes:number, urls:number}}}
 */
export function auditScript(opts) {
  const findings = [];
  const push = (code, message) => {
    if (findings.length < LIMITS.findings) findings.push({ code, message });
  };
  const allow = new Set([...Object.keys(DEFAULT_EGRESS_ALLOWLIST), ...opts.allowDomains]);
  const stats = { entries: 0, textFiles: 0, scannedBytes: 0, urls: 0 };

  // —— 校验 1：存在性 + 路径穿越 ——
  const scriptAbs = path.resolve(opts.script);
  if (!fs.existsSync(scriptAbs)) {
    push('NOT_FOUND', `目标脚本不存在：${scriptAbs}`);
    return {
      findings,
      scriptAbs,
      scriptBase: '',
      mountSrc: '',
      runner: null,
      ext: '',
      allow,
      stats,
    };
  }
  const st = fs.statSync(scriptAbs); // 跟随符号链接：链接本身也须落在 root 内
  if (!st.isFile()) push('NOT_A_FILE', `目标不是普通文件：${scriptAbs}`);
  const relToRoot = path.relative(opts.root, scriptAbs);
  if (relToRoot.startsWith('..') || path.isAbsolute(relToRoot)) {
    push(
      'PATH_ESCAPE',
      `目标脚本越出 --root（${opts.root}）：${scriptAbs}（首跑审计对象必须落在受控根内）`,
    );
  }

  // —— 运行器与镜像（未锁 tag 拒绝） ——
  const ext = path.extname(scriptAbs).toLowerCase();
  const runner = RUNNERS[ext] ?? null;
  if (runner === null) {
    push(
      'UNSUPPORTED_TYPE',
      `不支持的脚本类型 ${ext || '(无扩展名)'}（支持 ${Object.keys(RUNNERS).join('/')}；其他类型须先人工审读并自备运行镜像）`,
    );
  }
  if (!opts.image.includes(':') || /:latest$/i.test(opts.image)) {
    push('IMAGE_UNPINNED', `镜像必须锁定 tag：${opts.image}（与 CI 镜像纪律一致，防审计环境漂移）`);
  }

  // —— 校验 2：挂载源凭据目录（挂载源自身 + 全子树） ——
  const mountSrc = path.dirname(scriptAbs);
  const walk = (dir, relPrefix) => {
    if (stats.entries > LIMITS.walkEntries || findings.length >= LIMITS.findings) return;
    stats.entries += 1;
    const self = credCodeFor(path.basename(dir), true);
    if (self)
      push(
        'CRED_DIR',
        `挂载源命中凭据目录：${relPrefix || path.basename(dir)}（挂进容器即对 agent 可见，违反 §7-5 第 5 条）`,
      );
    let entries;
    try {
      entries = fs
        .readdirSync(dir, { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return; // 无权限子目录：容器内同样读不到，不视作凭据暴露
    }
    for (const e of entries) {
      if (stats.entries > LIMITS.walkEntries) {
        push(
          'SCAN_INCOMPLETE',
          `挂载源路径数超上限 ${LIMITS.walkEntries}（审不动就拒绝：先拷最小闭包到隔离暂存目录再审计）`,
        );
        return;
      }
      stats.entries += 1;
      const rel = relPrefix ? `${relPrefix}/${e.name}` : e.name;
      const full = path.join(dir, e.name);
      // 不跟随符号链接目录（目标指向不在受控面内）
      if (e.isDirectory() && !e.isSymbolicLink()) {
        const code = credCodeFor(e.name, true);
        if (code) {
          // 命中凭据目录即整目录拒绝，不再向内 walk（同一暴露不重复报告）
          push(
            'CRED_DIR',
            `挂载源含凭据目录：${rel}（挂进容器即对 agent 可见，违反 §7-5 第 5 条）`,
          );
          continue;
        }
        walk(full, rel);
      } else if (e.isFile()) {
        const code = credCodeFor(e.name, false);
        if (code)
          push(
            'CRED_FILE',
            `挂载源含凭据名文件：${rel}（挂进容器即对 agent 可见，违反 §7-5 第 5 条）`,
          );
        scanText(full, rel);
      }
    }
  };
  const seenEgress = new Set();
  const scanText = (full, rel) => {
    if (!TEXT_EXTS.has(path.extname(full).toLowerCase())) return;
    if (stats.textFiles >= LIMITS.textFiles) {
      push(
        'SCAN_INCOMPLETE',
        `文本文件数超上限 ${LIMITS.textFiles}（审不动就拒绝：先拷最小闭包到隔离暂存目录再审计）`,
      );
      return;
    }
    let text;
    try {
      const stat = fs.statSync(full);
      if (stat.size > LIMITS.fileBytes) {
        push(
          'SCAN_INCOMPLETE',
          `文本文件超过 ${LIMITS.fileBytes} 字节：${rel}（审不动就拒绝，拆分后再审）`,
        );
        return;
      }
      text = fs.readFileSync(full, 'utf8');
    } catch {
      return;
    }
    stats.textFiles += 1;
    stats.scannedBytes += text.length;
    // —— 校验 3：出站白名单（逐行提取 https?:// 引用） ——
    text.split('\n').forEach((line, i) => {
      for (const m of line.matchAll(RE_URL)) {
        stats.urls += 1;
        const host = m[0]
          .slice(m[0].indexOf('//') + 2)
          .split(':')[0]
          .toLowerCase();
        if (allow.has(host)) continue;
        const key = `${rel}:${i + 1}:${host}`;
        if (seenEgress.has(key)) continue;
        seenEgress.add(key);
        push(
          'EGRESS_NOT_ALLOWED',
          `白名单外域名引用 ${host}（${rel}:${i + 1}）——临时放行走 --allow-domain ${host} 并留痕；永久新增须记入演练记录 §1 并给理由`,
        );
      }
    });
  };
  walk(mountSrc, '');

  return {
    findings,
    scriptAbs,
    scriptBase: path.basename(scriptAbs),
    mountSrc,
    runner,
    ext,
    allow,
    stats,
  };
}

/**
 * 生成最小权限 docker 命令（唯一事实源；dry-run 打印与真跑共用）。
 * @returns {string[]} 完整 argv（首元素 'docker'）
 */
export function buildDockerCommand({ image, mountSrc, runner, scriptBase, scriptArgs }) {
  const mountSrcFwd = mountSrc.replaceAll('\\', '/'); // Docker Desktop（Windows）接受正斜杠盘符路径
  return [
    'docker',
    'run',
    '--rm',
    '--network',
    'none',
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--user',
    '65534:65534',
    '--tmpfs',
    '/tmp:rw,noexec,size=64m',
    '-e',
    'HOME=/tmp',
    '-v',
    `${mountSrcFwd}:${MOUNT_DST}:ro`,
    '--workdir',
    MOUNT_DST,
    image,
    runner,
    scriptBase,
    ...scriptArgs,
  ];
}

/** shell 引用（打印可粘贴命令行用；真跑走 argv 数组不经 shell） */
function shellQuote(arg) {
  return /^[\w./:=,-]+$/.test(arg) ? arg : `"${arg.replaceAll('"', '\\"')}"`;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.error) {
    process.stderr.write(`[first-run] 参数错误：${opts.error}\n`);
    process.exit(2);
  }
  const audit = auditScript(opts);
  const extended = opts.allowDomains.filter((d) => !(d in DEFAULT_EGRESS_ALLOWLIST));
  process.stdout.write(
    `[first-run] 审计目标：${opts.script}（runner=${audit.runner ?? '不支持'}）\n`,
  );
  process.stdout.write(`[first-run] 挂载源：${audit.mountSrc} → ${MOUNT_DST}（只读）\n`);
  process.stdout.write(
    `[first-run] 出站白名单：${Object.keys(DEFAULT_EGRESS_ALLOWLIST).join(', ')}` +
      (extended.length > 0 ? `；本次扩展：${extended.join(', ')}` : '') +
      '\n',
  );
  process.stdout.write(
    `[first-run] 扫描：${audit.stats.entries} 个路径 / ${audit.stats.textFiles} 个文本文件 / ` +
      `${audit.stats.scannedBytes} 字节 / ${audit.stats.urls} 处 URL 引用\n`,
  );
  if (audit.findings.length > 0) {
    process.stdout.write(`[first-run] 审计发现 ${audit.findings.length} 处 BLOCKER，拒绝执行：\n`);
    for (const f of audit.findings) {
      process.stdout.write(`  [${f.code}] ${f.message}\n`);
    }
    process.exit(1);
  }
  const cmd = buildDockerCommand({
    image: opts.image,
    mountSrc: audit.mountSrc,
    runner: audit.runner,
    scriptBase: audit.scriptBase,
    scriptArgs: opts.scriptArgs,
  });
  if (opts.dryRun) {
    process.stdout.write('[first-run] 审计通过，将执行（dry-run 输出，未真跑）：\n');
    process.stdout.write(`MSYS_NO_PATHCONV=1 ${cmd.map(shellQuote).join(' ')}\n`);
    process.stdout.write(
      '[first-run] 真跑=去掉 --dry-run（需本机 docker；本机 Ruling-6 无 docker，真跑留待 docker 环境补演练）\n',
    );
    process.exit(0);
  }
  const probe = spawnSync('docker', ['--version'], { encoding: 'utf8' });
  if (probe.error || probe.status !== 0) {
    process.stderr.write(
      '[first-run] 本机 docker 不可用（Ruling-6）——先 --dry-run 逻辑自证，真跑待 docker 环境补演练\n',
    );
    process.exit(1);
  }
  const res = spawnSync(cmd[0], cmd.slice(1), {
    stdio: 'inherit',
    env: { ...process.env, MSYS_NO_PATHCONV: '1' }, // Git Bash 下防 MSYS 路径改写 /sandbox
  });
  process.exit(res.status ?? 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
