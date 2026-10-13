/**
 * 极简 dotenv 解析（M0-8）：config/<env>/app.env 文件层的读取与解析。
 *
 * 刻意不引 dotenv 依赖（@nestjs/config 传递依赖在 pnpm 隔离布局下不可直接 import）：
 * 文件格式由本仓库自制（config/README.md 约束 KEY=VALUE + # 注释），15 行解析即可覆盖，
 * 换取：装载链路零额外依赖 + 解析规则可单测锁定。
 *
 * 规则：跳过空行与 # 注释行；以第一个 = 切分；键值两侧空白裁剪；成对单/双引号剥离；
 *       不做 ${} 展开与多行值（env 文件只放标量默认值，见 config/README.md）。
 */
import fs from 'node:fs';

/** 文件层键值（解析产物；键值均为字符串） */
export type EnvFileVars = Readonly<Record<string, string>>;

export function parseEnvFile(text: string): EnvFileVars {
  const vars: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue; // 无 = 或空键：忽略（非抛错——文件层是默认值载体，坏行不致命）
    const key = line.slice(0, eq).trim();
    const value = unquote(line.slice(eq + 1).trim());
    if (key !== '') vars[key] = value;
  }
  return vars;
}

/** 剥离一层成对引号（"v" / 'v' → v；不成对或混合保持原样） */
function unquote(value: string): string {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

/** 读取 env 文件；文件不存在返回空对象（文件层可选——默认值兜底仍在，见 app.config.ts） */
export function readEnvFile(filePath: string): EnvFileVars {
  if (!fs.existsSync(filePath)) return {};
  return parseEnvFile(fs.readFileSync(filePath, 'utf8'));
}
