/**
 * ObservabilityModule 装配级测试（M0-9）：/healthz 链路 span 产生 + 装配可关 + 可注入。
 *
 * 口径：经 overrideProvider(OBSERVABILITY_OPTIONS) 注入 InMemorySpanExporter——测试不真连
 * collector；http span 由 HttpInstrumentation 产生（M0-9 交付的「/healthz→span」证据位，
 * collector→jaeger 段为【待 docker 环境补端到端演练】，见 docs/plans/M0-9-观测基座说明.md）。
 */
import 'reflect-metadata';
import request from 'supertest';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { AppModule } from '../app.module';
import { OBSERVABILITY, OBSERVABILITY_OPTIONS, TRACE_LOGGER } from './observability.module';
import type { ObservabilityHandle } from './otel.setup';
import { TraceLogger } from './trace-logger';

/** http server span 在响应 finish 事件后异步收口——轮询等待而非硬 sleep */
async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<boolean> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return true;
}

describe('ObservabilityModule（AppModule 装配级）', () => {
  it('GET /healthz 产生 http span：trace_id 可取（内存 exporter 断言）', async () => {
    const exporter = new InMemorySpanExporter();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(OBSERVABILITY_OPTIONS)
      .useValue({ spanExporter: exporter })
      .compile();
    const app = moduleRef.createNestApplication();
    await app.init();

    const res = await request(app.getHttpServer()).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');

    const arrived = await waitFor(() => exporter.getFinishedSpans().length > 0);
    const names = exporter
      .getFinishedSpans()
      .map((s) => s.name)
      .join(', ');
    expect(arrived, `http span 未收口，已收 span：[${names}]`).toBe(true);

    // http 插桩 span 名为方法或 方法+路由（版本差异），以属性/名称双口径认领
    const spans = exporter.getFinishedSpans();
    const http = spans.find(
      (s) =>
        s.name.includes('/healthz') ||
        s.attributes['http.route'] === '/healthz' ||
        s.attributes['url.path'] === '/healthz',
    );
    expect(http, `未找到 /healthz 相关 span，实际：[${names}]`).toBeDefined();
    expect(http?.spanContext().traceId).toMatch(/^[0-9a-f]{32}$/);

    await app.close(); // → ObservabilityModule.onApplicationShutdown → sdk.shutdown
  });

  it('装配可关：enabled=false 时句柄为关闭态，TRACE_LOGGER 可注入且不查上下文', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(OBSERVABILITY_OPTIONS)
      .useValue({ enabled: false })
      .compile();
    const app = moduleRef.createNestApplication();
    await app.init();

    const observability = app.get<ObservabilityHandle>(OBSERVABILITY);
    expect(observability.enabled).toBe(false);
    expect(app.get(TRACE_LOGGER)).toBeInstanceOf(TraceLogger);

    await app.close();
    await expect(observability.shutdown()).resolves.toBeUndefined(); // 幂等
  });

  it('TRACE_LOGGER 默认装配（未 override）：句柄 enabled=true（配置开关缺省口径）', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();
    expect(app.get<ObservabilityHandle>(OBSERVABILITY).enabled).toBe(true);
    await app.close();
  });
});
