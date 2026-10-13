import { describe, expect, it } from 'vitest';
import { configFilePath } from './app.config';
import { parseEnvFile, readEnvFile } from './env-file';

describe('parseEnvFile（文件层解析规则锁定）', () => {
  it('基本键值：切首个 =、裁剪空白', () => {
    expect(parseEnvFile('A=1\n  B = 2 \nC=x=y')).toEqual({ A: '1', B: '2', C: 'x=y' });
  });

  it('跳过空行与 # 注释行；无 = 或空键的行被忽略（不抛错）', () => {
    expect(parseEnvFile('# 注释\n\n   \nBROKEN_LINE\n=1\nOK=1')).toEqual({ OK: '1' });
  });

  it('成对单/双引号剥离一层；不成对保持原样', () => {
    expect(parseEnvFile(`A="v"\nB='v'\nC="v`)).toEqual({ A: 'v', B: 'v', C: '"v' });
  });

  it('不做 ${} 展开与多行值（文件层只放标量默认值）', () => {
    expect(parseEnvFile('A=${OTHER}')).toEqual({ A: '${OTHER}' });
  });
});

describe('readEnvFile（文件层存在性）', () => {
  it('文件缺失返回空对象（文件层可选，默认值兜底仍在）', () => {
    expect(readEnvFile('Z:/definitely/not/a/real/path/app.env')).toEqual({});
  });

  it('真实 dev 文件可解析出 LJR_PG_PORT（config/dev/app.env 随仓库交付）', () => {
    const vars = readEnvFile(configFilePath('dev'));
    expect(vars['LJR_PG_PORT']).toBe('5435');
  });
});
