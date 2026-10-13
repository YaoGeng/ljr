/**
 * AppConfigModule（M0-8）：配置装配——@nestjs/config 承载 + CONFIG_PROVIDER 接缝。
 *
 * - ConfigModule.forRoot(load: [() => appConfig])：把三层解析产物注册为 ConfigService 的
 *   internal config，供 Nest 生态（后续模块/三方库）按需消费；
 * - CONFIG_PROVIDER：业务代码统一读取口（LocalConfigProvider→本地分层；Nacos 实现 staging 起按
 *   接口预留位接入），main.ts 的端口即经 require('port') 取得。
 * - @Global：全服务免逐模块 import（core 是单体，配置无作用域隔离需求）。
 *
 * appConfig 在模块装载时解析一次（import 期副作用=读 config/<LJR_ENV>/app.env + process.env；
 * 解析失败=启动即失败，符合 fail-fast）。
 */
import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { loadAppConfig } from './app.config';
import { CONFIG_PROVIDER } from './config-provider.interface';
import { LocalConfigProvider } from './local-config-provider';

const appConfig = loadAppConfig();

@Global()
@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true, load: [() => appConfig] })],
  providers: [{ provide: CONFIG_PROVIDER, useValue: new LocalConfigProvider(appConfig) }],
  exports: [CONFIG_PROVIDER],
})
export class AppConfigModule {}
