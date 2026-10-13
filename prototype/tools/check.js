#!/usr/bin/env node
// 原型审查脚本：链接完整性 + 编码声明 + 外链资源 + 基本结构
// 用法：node tools/check.js
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const RESOLVED_ROOT = path.resolve(ROOT);
const issues = [];
const pages = [];

// 路径包含校验：resolve 后必须仍位于原型根内（../ 逃逸或绝对路径注入 → 按断链处理，不读取）
function insideRoot(target) {
  const resolved = path.resolve(target);
  return resolved === RESOLVED_ROOT || resolved.startsWith(RESOLVED_ROOT + path.sep);
}

(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === ".git" || e.name === "tools") continue;
    const p = path.join(dir, e.name);
    if (!insideRoot(p)) continue; // 越界项跳过，不读取
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith(".html")) pages.push(p);
  }
})(ROOT);

for (const p of pages) {
  const rel = path.relative(ROOT, p).replace(/\\/g, "/");
  const text = fs.readFileSync(p, "utf8");
  if (!/charset=["']?utf-8/i.test(text)) issues.push(`[编码] ${rel}: 缺少 utf-8 charset 声明`);
  if (!text.includes("</html>")) issues.push(`[结构] ${rel}: 缺少 </html>`);
  if (!text.includes("</body>")) issues.push(`[结构] ${rel}: 缺少 </body>`);
  // 外链资源
  for (const m of text.matchAll(/(?:src|href)=["'](https?:\/\/[^"']+)["']/g)) {
    issues.push(`[外链] ${rel}: ${m[1]}`);
  }
  // 内部链接存在性
  for (const m of text.matchAll(/href=["']([^"'#][^"']*)["']/g)) {
    const href = m[1];
    if (/^(https?:|javascript:|data:|mailto:)/.test(href)) continue;
    const hrefFile = href.split("#")[0];
    if (!hrefFile) continue;
    const target = path.normalize(path.join(path.dirname(p), hrefFile));
    if (!insideRoot(target)) {
      issues.push(`[越界] ${rel}: -> ${href}（逃逸原型根，按断链处理）`);
      continue;
    }
    if (!fs.existsSync(target)) {
      issues.push(`[断链] ${rel}: -> ${href}`);
    }
  }
  // 引入的本地样式/脚本存在性
  for (const m of text.matchAll(/(?:src|href)=["']([^"']+\.css)["']/g)) {
    const target = path.normalize(path.join(path.dirname(p), m[1]));
    if (!insideRoot(target)) {
      issues.push(`[越界] ${rel}: 样式逃逸原型根 ${m[1]}`);
      continue;
    }
    if (!fs.existsSync(target)) {
      issues.push(`[断链] ${rel}: 样式缺失 ${m[1]}`);
    }
  }
}

console.log(`共检查 ${pages.length} 个 HTML 文件`);
if (issues.length) {
  console.log(`发现 ${issues.length} 个问题：`);
  for (const i of issues) console.log("  " + i);
  process.exit(1);
}
console.log("全部通过：无断链、无外链、结构完整。");
