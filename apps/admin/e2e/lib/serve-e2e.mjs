// apps/admin/e2e/lib/serve-e2e.mjs —— admin E2E 静态宿 + core 反向代理（M3-W3 T7，W3-1）。
//
// 拷贝来源：apps/app/e2e/lib/serve-e2e.mjs（W1 T5 交付件），W3-1 拍板=admin 自有 serve
// 同款拷贝改根，零触碰 app 编排器。与 app 版的差异点（仅此两处，其余逐字保留）：
//   1. DIST_ROOT 指向 apps/admin/dist（本文件相对位 ../../dist——app 版硬编码 apps/app/dist，
//      admin 不可用；相对位相同纯属两树 e2e/lib 目录同构）；
//   2. 静态产物来源=vite build（app 版=expo export）；CLI 缺省端口 8795（app 版 8792）。
//
// 反代必要性（拷贝保留）：core 无 CORS 装配，浏览器从静态源（:8795）直接 fetch core（:3000）
// 被同源策略拦截——同源反代后浏览器请求全同源，服务端转发保持「admin → 真实 core HTTP 契约」
// 逐字节不变。admin 侧经 VITE_API_BASE 指向本源（构建期注入，见 run-admin-e2e.mjs）。
//
// 路由规则（拷贝保留，hash 路由形态下口径核对无变）：GET/HEAD 且 dist 下存在该文件 → 静态
// 直出（'/' → index.html）；其余 → 转发 core。admin 手写 hash 路由（W3-3）URL 恒 '/'+hash，
// 零 SPA 回退需求；API GET 路径皆无扩展名（/admin/lawyers、/pricing/histories…）——同样
// **不得**把无扩展名 GET 兜底成 index.html（app 版首跑实证 /me 回 HTML 的坑，同因保留）。
import process from 'node:process';
import { createServer, request as httpRequest } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { URL, fileURLToPath } from 'node:url';

const DIST_ROOT = fileURLToPath(new URL('../../dist/', import.meta.url));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

/** 请求 → core 原样转发（host 头改写为目的坐标；体双向 pipe） */
function proxyToCore(req, res, corePort) {
  const upstream = httpRequest(
    {
      host: '127.0.0.1',
      port: corePort,
      method: req.method,
      path: req.url,
      headers: { ...req.headers, host: `127.0.0.1:${corePort}` },
    },
    (ur) => {
      res.writeHead(ur.statusCode ?? 502, ur.headers);
      ur.pipe(res);
    },
  );
  upstream.on('error', (e) => {
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
    }
    res.end(
      JSON.stringify({
        code: 'E_PROXY',
        message: `core 不可达（127.0.0.1:${corePort}）：${String(e?.message ?? e)}`,
      }),
    );
  });
  req.pipe(upstream);
}

/**
 * 起 E2E 服务（run-admin-e2e.mjs 进程内复用；也支持 CLI 独立起服）。
 * @returns {Promise<import('node:http').Server>}
 */
export function startE2EServer({ port, corePort }) {
  const server = createServer(async (req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
    if (req.method === 'GET' || req.method === 'HEAD') {
      // '/' → index.html；带扩展名且 dist 下存在 → 静态直出；其余 GET（=API 面）走反代
      let filePath = null;
      if (urlPath === '/') {
        filePath = join(DIST_ROOT, 'index.html');
      } else if (extname(urlPath) !== '') {
        filePath = join(DIST_ROOT, normalize(urlPath).replace(/^([/\\]|\.\.)+/, ''));
      }
      if (filePath) {
        try {
          const st = await stat(filePath);
          if (st.isFile()) {
            const body = await readFile(filePath);
            res.writeHead(200, {
              'Content-Type': MIME[extname(filePath)] ?? 'application/octet-stream',
              'Content-Length': String(body.length),
            });
            res.end(req.method === 'HEAD' ? undefined : body);
            return;
          }
        } catch {
          // 文件不存在 → 落到反代（core 404 即可，静态缺件不是 API 语义）
        }
      }
    }
    proxyToCore(req, res, corePort);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

// ---- CLI 独立起服（编排器之外的手动联调入口） ----
const isCli = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isCli) {
  const port = Number(process.argv[2] ?? 8795);
  const corePort = Number(process.argv[3] ?? 3000);
  startE2EServer({ port, corePort })
    .then(() => {
      process.stdout.write(
        `admin e2e static+proxy serving ${DIST_ROOT} + -> core:${corePort} at http://127.0.0.1:${port}/\n`,
      );
    })
    .catch((e) => {
      process.stderr.write(`起服失败：${String(e?.message ?? e)}\n`);
      process.exit(1);
    });
}
