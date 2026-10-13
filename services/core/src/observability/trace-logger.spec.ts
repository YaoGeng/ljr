/**
 * trace-logger 单测（M0-9）：日志行 trace_id 注入的内存断言。
 * SDK 装配用本地降级口径（无端点、无 exporter——只借 provider 注册取 trace 上下文）。
 */
import { trace } from '@opentelemetry/api';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupObservability, type ObservabilityHandle } from './otel.setup';
import { currentTraceId, formatLogLine, TraceLogger } from './trace-logger';

describe('TraceLogger：日志行带 trace_id', () => {
  let handle: ObservabilityHandle;
  const lines: string[] = [];
  const logger = new TraceLogger({ service: '@ljr/core-test', sink: (l) => lines.push(l) });
  const lastLine = (): Record<string, unknown> => JSON.parse(lines[lines.length - 1] as string);

  beforeAll(() => {
    handle = setupObservability({ instrumentations: [] }); // 纯上下文，无插桩无 exporter
  });
  afterAll(async () => {
    await handle.shutdown();
  });

  it('active span 内：行含 trace_id 且与 span 一致；level/svc/msg/扩展字段就位', async () => {
    await trace.getTracer('trace-logger.spec').startActiveSpan('log.op', async (span) => {
      const traceId = span.spanContext().traceId;
      logger.info('订单完成', { orderId: 42 });
      span.end();

      const entry = lastLine();
      expect(entry.trace_id).toBe(traceId);
      expect(currentTraceId()).toBe(traceId);
      expect(entry.level).toBe('info');
      expect(entry.svc).toBe('@ljr/core-test');
      expect(entry.msg).toBe('订单完成');
      expect(entry.orderId).toBe(42);
      expect(entry.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });

  it('span 外：行不含 trace_id 键（不输出全零占位）；currentTraceId 为 undefined', () => {
    logger.warn('无上下文');
    const entry = lastLine();
    expect('trace_id' in entry).toBe(false);
    expect(entry.level).toBe('warn');
    expect(currentTraceId()).toBeUndefined();
  });

  it('开关关闭（traceIdEnabled=false）：span 内也不注入 trace_id', async () => {
    const off = new TraceLogger({
      service: 'off',
      traceIdEnabled: false,
      sink: (l) => lines.push(l),
    });
    await trace.getTracer('trace-logger.spec').startActiveSpan('masked.op', async (span) => {
      off.info('屏蔽上下文');
      span.end();
    });
    expect('trace_id' in lastLine()).toBe(false);
  });

  it('formatLogLine 纯函数：Error message / Error 字段 / 非字符串 msg 的安全序列化', () => {
    expect(formatLogLine('error', new Error('boom'), undefined, { service: 'x' })).toContain(
      'boom',
    );
    const line = formatLogLine('info', '失败', { err: new Error('bad') }, { service: 'x' });
    expect(JSON.parse(line).err).toContain('Error: bad');
    expect(
      JSON.parse(formatLogLine('info', { weird: 'obj' }, undefined, { service: 'x' })).msg,
    ).toContain('weird');
  });

  // Nest LoggerService 位置参数形态（评审修复环 1/5）：字符串第二参是 context/stack，
  // 不是字段对象——不得被 Object.entries splat 成索引-单字符对（{"0":"I","1":"n",…}）
  it('Nest 字符串 context 调用形态：log(msg, context) → context 字段就位，无单字符垃圾键', () => {
    logger.log('Nest 启动', 'InstanceLoader');
    const entry = lastLine();
    expect(entry.msg).toBe('Nest 启动');
    expect(entry.context).toBe('InstanceLoader');
    expect(Object.keys(entry).filter((k) => /^\d+$/.test(k))).toEqual([]);
    // 纯函数同口径：字符串 fields 归一为 context
    expect(JSON.parse(formatLogLine('info', 'm', 'Ctx', { service: 'x' })).context).toBe('Ctx');
  });

  it('error(message, stack, context) 三参形态：stack 与 context 均入行、不被 splat', () => {
    logger.error('初始化失败', 'Error: boom\n    at bootstrap (main.ts:21:5)', 'Bootstrap');
    const entry = lastLine();
    expect(entry.level).toBe('error');
    expect(entry.msg).toBe('初始化失败');
    expect(entry.stack).toContain('Error: boom');
    expect(entry.context).toBe('Bootstrap');
    expect(Object.keys(entry).filter((k) => /^\d+$/.test(k))).toEqual([]);
  });

  it('sink 抛异常不外冒（日志永不反噬业务）', () => {
    const boom = new TraceLogger({
      service: 'x',
      sink: () => {
        throw new Error('sink down');
      },
    });
    expect(() => boom.error('still fine')).not.toThrow();
  });
});
