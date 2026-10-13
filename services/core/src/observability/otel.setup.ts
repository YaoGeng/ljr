/**
 * OTel SDK 装配（M0-9，docs/plans/M0-9-观测基座说明.md）。
 *
 * 口径：
 *   - 依赖线：@opentelemetry/api@1.9.1 + sdk-node@0.223.0（导出器 0.223.0 / SDK 基座 2.12.0），
 *     auto-instrumentations-node 只取 **http+pg 两件**（按 instrumentationName 过滤，不注册其余
 *     全量插桩——fs/dns/express 等对本服务无观测收益，反而扩大 patch 面）。
 *   - 端点（OTLP 接收端 = docker/dev 的 otel-collector，http/protobuf 4318）走 OTel 标准键
 *     `OTEL_EXPORTER_OTLP_ENDPOINT`，仅进程 env——与密钥同一条注入通路，不入 config 文件层。
 *   - **端点未设且未注入 exporter → 降级为 NoopSpanProcessor**：provider 照常注册（trace 上下文
 *     照常可取，trace-logger 依赖此语义），span 不外发、零网络、零内存增长——本地/单测不炸。
 *     注意：sdk-node 在 spanProcessors 为空数组时**不注册 provider**（已核 dist 源码），必须给
 *     Noop 处理器占位，勿「优化」成空数组。
 *   - 注入 spanExporter（测试口径）：SimpleSpanProcessor 直落内存，无需 shutdown 即可断言；
 *     OTLP 生产路径用 BatchSpanProcessor（异步攒批发送）。
 *   - enabled=false（config observability.enabled，LJR_OBS_ENABLED）：不注册 provider、不插桩、
 *     不查 trace 上下文——进程零观测开销；同时复位全局 provider 位，保证「关闭后 api 侧取到的
 *     span 恒为非记录态」可被确定性断言。
 *   - 重复装配（同一进程多测试文件各装一次）：api 无 unregister，装配前先 trace.disable() 复位
 *     全局位让本次装配独占——生产进程只装一次，此调用为幂等空操作。
 */
import { trace } from '@opentelemetry/api';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import type { Instrumentation } from '@opentelemetry/instrumentation';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import {
  BatchSpanProcessor,
  NoopSpanProcessor,
  SimpleSpanProcessor,
  type SpanExporter,
} from '@opentelemetry/sdk-trace-base';
import { NodeSDK } from '@opentelemetry/sdk-node';

export const DEFAULT_SERVICE_NAME = '@ljr/core';

/** OTLP 接收端 env 键（OTel 标准名，非 LJR_ 前缀——与生态工具语义对齐） */
export const OTLP_ENDPOINT_ENV = 'OTEL_EXPORTER_OTLP_ENDPOINT';

/** 默认插桩面：恰好两件（结构断言防全量插桩漂移） */
export const OBS_INSTRUMENTATIONS = [
  '@opentelemetry/instrumentation-http',
  '@opentelemetry/instrumentation-pg',
] as const;

export interface SetupObservabilityOptions {
  readonly serviceName?: string;
  /** OTLP 接收端（如 http://127.0.0.1:4318）；未给时回落进程 env OTEL_EXPORTER_OTLP_ENDPOINT */
  readonly otlpEndpoint?: string;
  /** 显式注入 span exporter（单测：InMemorySpanExporter）；注入即不走 OTLP exporter */
  readonly spanExporter?: SpanExporter;
  /** 覆盖插桩面（默认 http+pg 两件；传 [] = 不插桩，纯手动 span 场景） */
  readonly instrumentations?: readonly Instrumentation[];
  /** 装配开关（false = 零观测副作用；默认 true） */
  readonly enabled?: boolean;
}

/** 装配产物句柄：enabled=false 时为空壳（shutdown 幂等空操作） */
export interface ObservabilityHandle {
  readonly enabled: boolean;
  readonly serviceName: string;
  /** flush 出口外的 span（OTLP 批处理器在 shutdown/间隔到点时外发） */
  shutdown(): Promise<void>;
}

/** 端点解析：显式入参 > 进程 env > 未设（未设=本地降级口径） */
export function resolveOtlpEndpoint(
  explicit?: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const value = explicit ?? env[OTLP_ENDPOINT_ENV];
  return value !== undefined && value !== '' ? value : undefined;
}

/** 默认插桩面：meta 包全量实例化后按 instrumentationName 过滤出 http+pg */
export function httpPgInstrumentations(): Instrumentation[] {
  const wanted = new Set<string>(OBS_INSTRUMENTATIONS);
  return getNodeAutoInstrumentations().filter((i) => wanted.has(i.instrumentationName));
}

export function setupObservability(options: SetupObservabilityOptions = {}): ObservabilityHandle {
  const serviceName = options.serviceName ?? DEFAULT_SERVICE_NAME;

  if (options.enabled === false) {
    trace.disable(); // 复位全局位：关闭态下 api 取到的 span 恒为非记录态（可确定性断言）
    return { enabled: false, serviceName, shutdown: () => Promise.resolve() };
  }

  const endpoint = resolveOtlpEndpoint(options.otlpEndpoint);
  // 装配前复位全局 provider（见文件头「重复装配」说明）
  trace.disable();

  const sdk = new NodeSDK({
    serviceName,
    // 三态：注入 exporter（Simple，测试即时可断言）> OTLP 端点（Batch，攒批外发）> 都没有（Noop）
    spanProcessors: options.spanExporter
      ? [new SimpleSpanProcessor(options.spanExporter)]
      : endpoint
        ? [new BatchSpanProcessor(new OTLPTraceExporter({ url: endpoint }))]
        : [new NoopSpanProcessor()],
    instrumentations: [...(options.instrumentations ?? httpPgInstrumentations())],
    // 指标经同一条 OTLP 出口 → collector 的 prometheus exporter(8889) 被 prometheus 抓取；
    // 无端点且未注入时不挂 reader（sdk-node 无 reader 即不注册 meter provider，零开销）
    ...(endpoint
      ? {
          metricReaders: [
            new PeriodicExportingMetricReader({
              exporter: new OTLPMetricExporter({ url: endpoint }),
              exportIntervalMillis: 15_000,
            }),
          ],
        }
      : {}),
  });
  sdk.start();

  return { enabled: true, serviceName, shutdown: () => sdk.shutdown() };
}
