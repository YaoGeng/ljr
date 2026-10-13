/**
 * LocalConfigProvider（M0-8）：ConfigProvider 的本地实现。
 *
 * 数据源 = loadAppConfig() 的三层解析产物（AppConfig 只读视图）：
 * dev 用它即达成验收（env>文件>默认），不依赖任何外部配置中心——
 * Nacos 实现自 staging 起按 config-provider.interface.ts 预留位接入。
 */
import { AppError, ErrorCode } from '@ljr/shared';
import type { ConfigProvider } from './config-provider.interface';

export class LocalConfigProvider implements ConfigProvider {
  /** 接受任意对象字面量/AppConfig（接口无索引签名，取值统一经 getByPath 收窄） */
  constructor(private readonly source: object) {}

  get<T = unknown>(key: string): T | undefined {
    return getByPath(this.source, key) as T | undefined;
  }

  require<T = unknown>(key: string): T {
    const value = this.get<T>(key);
    if (value === undefined) {
      throw new AppError(
        ErrorCode.ConfigMissing,
        `配置键 ${key} 缺失（进程 env / config 文件 / 默认值三层均未提供；密钥类只走进程环境注入）`,
      );
    }
    return value;
  }
}

/** 点路径游走：任一跳缺失或非对象 → undefined（与 require 的 fail-fast 语义配合） */
function getByPath(source: object, dottedKey: string): unknown {
  let node: unknown = source;
  for (const part of dottedKey.split('.')) {
    if (node === null || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return node;
}
