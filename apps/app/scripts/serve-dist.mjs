/**
 * expo export web 产物静态服务（M3-W1 T1 截图自检 / T5 E2E 静态宿）：
 *   node apps/app/scripts/serve-dist.mjs [port]   （默认 8791）
 * 零依赖（node:http），只服务 apps/app/dist；仅绑 127.0.0.1 回环（T6 评审 S4：
 * 静态自检/E2E 宿不对外暴露）。
 */
import process from 'node:process';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { URL, fileURLToPath } from 'node:url';

const distRoot = fileURLToPath(new URL('../dist/', import.meta.url));
const port = Number(process.argv[2] ?? 8791);
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

createServer(async (req, res) => {
  const urlPath = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
  let filePath = join(distRoot, normalize(urlPath).replace(/^([/\\]|\.\.)+/, ''));
  if (extname(filePath) === '') filePath = join(distRoot, 'index.html'); // SPA 兜底
  try {
    const body = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
  }
}).listen(port, '127.0.0.1', () => {
  process.stdout.write(`serving ${distRoot} -> http://localhost:${port}/\n`);
});
