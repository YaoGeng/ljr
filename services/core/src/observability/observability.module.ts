/**
 * ObservabilityModule（M0-9）：OTel 装配 + trace logger 的 Nest 接缝。
 *
 * - OBSERVABILITY_OPTIONS：装配选项注入位（默认 {} 走配置开关——测试经 overrideProvider
 *   注入 InMemorySpanExporter / enabled:false，不真连 collector）。
 * - OBSERVABILITY：setupObservability 句柄；app.close() → onApplicationShutdown → sdk.shutdown()
 *   （flush 批处理器、解除插桩）。
 * - TRACE_LOGGER：TraceLogger 实例（main.ts 挂为 Nest 全局 logger）；traceIdEnabled 与 SDK
 *   装配共用 observability.enabled 开关（LJR_OBS_ENABLED，三层配置解析）。
 * - @Global：与 AppConfigModule 同口径，业务模块免逐个 import。
 */
import {
  Global,
  Inject,
  Module,
  type InjectionToken,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { AppConfigModule } from '../config/config.module';
import { CONFIG_PROVIDER, type ConfigProvider } from '../config/config-provider.interface';
import {
  setupObservability,
  type ObservabilityHandle,
  type SetupObservabilityOptions,
} from './otel.setup';
import { TraceLogger } from './trace-logger';

export const OBSERVABILITY_OPTIONS: InjectionToken = Symbol('OBSERVABILITY_OPTIONS');
export const OBSERVABILITY: InjectionToken = Symbol('OBSERVABILITY');
export const TRACE_LOGGER: InjectionToken = Symbol('TRACE_LOGGER');

/** 配置开关解析（observability.enabled 三层缺省 true）；显式入参最高 */
function enabledFrom(options: Partial<SetupObservabilityOptions>, config: ConfigProvider): boolean {
  return options.enabled ?? config.get<boolean>('observability.enabled') ?? true;
}

@Global()
@Module({
  imports: [AppConfigModule],
  providers: [
    { provide: OBSERVABILITY_OPTIONS, useValue: {} as Partial<SetupObservabilityOptions> },
    {
      provide: OBSERVABILITY,
      inject: [OBSERVABILITY_OPTIONS, CONFIG_PROVIDER],
      useFactory: (options: Partial<SetupObservabilityOptions>, config: ConfigProvider) =>
        setupObservability({ ...options, enabled: enabledFrom(options, config) }),
    },
    {
      provide: TRACE_LOGGER,
      inject: [OBSERVABILITY_OPTIONS, CONFIG_PROVIDER],
      useFactory: (options: Partial<SetupObservabilityOptions>, config: ConfigProvider) =>
        new TraceLogger({
          service: options.serviceName,
          traceIdEnabled: enabledFrom(options, config),
        }),
    },
  ],
  exports: [OBSERVABILITY, TRACE_LOGGER],
})
export class ObservabilityModule implements OnApplicationShutdown {
  constructor(@Inject(OBSERVABILITY) private readonly observability: ObservabilityHandle) {}

  async onApplicationShutdown(): Promise<void> {
    await this.observability.shutdown();
  }
}
