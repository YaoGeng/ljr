/**
 * otel.setup 单测（M0-9）：SDK 装配三态的内存断言（不真连 collector）。
 *
 * ① span 产生且 trace_id 可取（显式注入 InMemorySpanExporter）
 * ② 端点未设：装配降级 noop 处理器——不炸、span 照常记录、trace 上下文可用
 * ③ enabled=false：不注册 provider——api 侧 span 恒为非记录态（日志侧不注入 trace_id 的依据）
 */
import { trace } from '@opentelemetry/api';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import { afterEach, describe, expect, it } from 'vitest';
import {
  httpPgInstrumentations,
  OBS_INSTRUMENTATIONS,
  OTLP_ENDPOINT_ENV,
  resolveOtlpEndpoint,
  setupObservability,
  type ObservabilityHandle,
} from './otel.setup';

/** span 落 exporter 的毫秒级迟滞轮询（见用例内注释） */
async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<boolean> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return true;
}

describe('setupObservability（内存 exporter 断言口径）', () => {
  let handle: ObservabilityHandle | undefined;

  afterEach(async () => {
    await handle?.shutdown();
    handle = undefined;
    delete process.env[OTLP_ENDPOINT_ENV]; // 防上一用例的端点泄漏到下一用例
  });

  it('① span 产生且 trace_id 可取：注入 exporter 收到 span，traceId 为 32 位小写 hex', async () => {
    const exporter = new InMemorySpanExporter();
    handle = setupObservability({ spanExporter: exporter });

    expect(handle.enabled).toBe(true);
    await trace.getTracer('otel.setup.spec').startActiveSpan('demo.op', async (span) => {
      expect(span.isRecording()).toBe(true);
      expect(span.spanContext().traceId).toMatch(/^[0-9a-f]{32}$/);
      span.end();
    });

    // vitest 的 ESM/CJS 双实例interop下 span 落 exporter 有毫秒级迟滞——轮询而非即时断言
    //（生产构建为纯 CJS 单实例，SimpleSpanProcessor 同步直落）
    const arrived = await waitFor(() => exporter.getFinishedSpans().length > 0);
    expect(arrived, 'span 未落内存 exporter').toBe(true);
    const finished = exporter.getFinishedSpans();
    expect(finished[0]?.name).toBe('demo.op');
    expect(finished[0]?.spanContext().traceId).toMatch(/^[0-9a-f]{32}$/);
  });

  it('② 端点未设且未注入 exporter：装配不炸（noop 处理器），span 照常记录、上下文照常可取', async () => {
    handle = setupObservability({ instrumentations: [] });

    await trace.getTracer('otel.setup.spec').startActiveSpan('no-export.op', async (span) => {
      expect(span.isRecording()).toBe(true);
      expect(span.spanContext().traceId).toMatch(/^[0-9a-f]{32}$/);
      span.end();
    });
    await expect(handle.shutdown()).resolves.toBeUndefined();
  });

  it('③ enabled=false：不注册 provider——api 取到的 span 非记录态、trace_id 全零', () => {
    handle = setupObservability({ enabled: false });

    expect(handle.enabled).toBe(false);
    const span = trace.getTracer('otel.setup.spec').startSpan('disabled.op');
    expect(span.isRecording()).toBe(false);
    expect(span.spanContext().traceId).toBe('0'.repeat(32)); // currentTraceId 据此判「无 trace」
    span.end();
  });

  it('插桩面恰为 http+pg 两件（防全量插桩漂移）', () => {
    const names = httpPgInstrumentations().map((i) => i.instrumentationName);
    expect([...names].sort()).toEqual([...OBS_INSTRUMENTATIONS].slice().sort());
  });

  it('端点解析：显式入参 > 进程 env > 未设（空串视为未设）', () => {
    expect(
      resolveOtlpEndpoint('http://explicit:4318', { [OTLP_ENDPOINT_ENV]: 'http://env:4318' }),
    ).toBe('http://explicit:4318');
    expect(resolveOtlpEndpoint(undefined, { [OTLP_ENDPOINT_ENV]: 'http://env:4318' })).toBe(
      'http://env:4318',
    );
    expect(resolveOtlpEndpoint(undefined, {})).toBeUndefined();
    expect(resolveOtlpEndpoint(undefined, { [OTLP_ENDPOINT_ENV]: '' })).toBeUndefined();
  });
});
