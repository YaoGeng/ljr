/**
 * ConfigProvider 契约（M0-8）：配置读取的统一接缝。
 *
 * 实现位规划（docs/plans/M0-8-环境与配置说明.md §5）：
 *   - LocalConfigProvider（本目录 local-config-provider.ts）：dev 全量分层解析结果，
 *     env > config/<env>/app.env > 默认值，进程内静态——M0 验收口径（不为 dev 强接 nacos-sdk）。
 *   - NacosConfigProvider：**接口预留空位，staging 起接入**（nacos 容器已在 docker/dev 就位；
 *     届时实现本接口：serverAddr/namespace/group/dataId 走 env 注入，密钥走平台 secrets）。
 *     接缝保证：调用方只依赖本接口，Nacos 落地不改任何调用点。
 */
import type { InjectionToken } from '@nestjs/common';

export interface ConfigProvider {
  /** 取配置值（点路径，如 'pg.host'）；缺失返回 undefined，调用方自行兜底 */
  get<T = unknown>(key: string): T | undefined;

  /**
   * 取必须存在的配置值；缺失抛 AppError(E_CONFIG_MISSING)（启动期 fail-fast，
   * 不允许带着缺失关键配置进入服务态）。
   */
  require<T = unknown>(key: string): T;
}

/** DI 令牌（实现可替换：Local → Nacos），模块内以 provide: CONFIG_PROVIDER 装配 */
export const CONFIG_PROVIDER: InjectionToken = Symbol('CONFIG_PROVIDER');
