// skills/manifest.json 校验/再生成脚本（M0-6 修复环入库，Node >=20，零依赖）。
//
// 哈希口径（与 manifest.json $schema_note 逐字一致，本脚本是该口径的唯一可执行定义）：
//   对 manifest.skills 中每个技能目录（skills/<name>/）递归收集全部文件；
//   每个文件取相对路径 rel = '<dirFullPath 相对 skills/ 的路径>'（正斜杠，形如 /<name>/<file>）；
//   将全部文件按 rel 的字典序（JS 默认字符串比较，升序）排序；
//   对每个文件先算 hex = sha256(文件字节) 的十六进制小写；
//   依次把字符串 rel + '\n' + hex + '\n' 以 UTF-8 编码送入同一个 sha256 上下文；
//   最终摘要的十六进制前 16 位即该技能的 sha256 字段；count = 该目录文件总数。
//
// 用法：
//   node skills/verify-manifest.mjs           # 校验：逐技能比对 count/sha256，全部吻合 exit 0
//   node skills/verify-manifest.mjs --update  # 再生成：回写全部 count/sha256（其余字段不动），随后自动校验
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const skillsRoot = join(dirname(fileURLToPath(import.meta.url)));
const manifestPath = join(skillsRoot, 'manifest.json');

const listFiles = (dir) => {
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, name.name);
      if (name.isDirectory()) walk(p);
      else out.push(p);
    }
  };
  walk(dir);
  return out
    .map((p) => p.slice(skillsRoot.length).replace(/\\/g, '/'))
    .sort()
    .map((rel) => ({ rel, abs: join(skillsRoot, rel) }));
};

const compute = (name) => {
  const files = listFiles(join(skillsRoot, name));
  const h = createHash('sha256');
  for (const { rel, abs } of files) {
    h.update(rel + '\n' + createHash('sha256').update(readFileSync(abs)).digest('hex') + '\n');
  }
  return { count: files.length, sha256: h.digest('hex').slice(0, 16) };
};

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
let failed = 0;
for (const [name, entry] of Object.entries(manifest.skills)) {
  const actual = compute(name);
  if (process.argv.includes('--update')) {
    entry.count = actual.count;
    entry.sha256 = actual.sha256;
  }
  const ok = entry.count === actual.count && entry.sha256 === actual.sha256;
  if (!ok) failed += 1;
  console.log(
    `${ok ? 'OK ' : 'NG '} ${name}: manifest=${entry.count} files/${entry.sha256} 实算=${actual.count} files/${actual.sha256}`,
  );
}

if (process.argv.includes('--update')) {
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  console.log('manifest.json 已回写（仅 count/sha256 字段）');
}

const total = Object.keys(manifest.skills).length;
console.log(`${total - failed}/${total} 吻合`);
process.exit(failed === 0 ? 0 : 1);
