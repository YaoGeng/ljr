/**
 * trace-logger（M0-9）：日志行带 trace_id。
 *
 * - 行格式 = 单行 JSON（ts/level/svc/trace_id?/msg/…fields），机器可解析、可被日志栈按 trace_id
 *   聚合关联；trace_id 仅在存在**真实** active span 时注入（未装配/开关关闭时不输出全零占位）。
 * - traceIdEnabled 接 T7 配置模块的 observability.enabled（LJR_OBS_ENABLED）：总开关关闭时
 *   不查 active span（纯文本行），与「关闭=零观测开销」口径一致。
 * - 兼容 Nest LoggerService（log/verbose 别名）：main.ts 经 app.useLogger 挂为全局 logger 后，
 *   Nest 自身日志同享 trace_id 注入。
 * - 红线：日志永不反噬业务——sink 抛异常、字段序列化失败均吞掉降级为字符串。
 */
import { trace } from '@opentelemetry/api';

export type TraceLogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface TraceLoggerOptions {
  /** 服务名（日志行 svc 字段；默认 '@ljr/core'） */
  readonly service?: string;
  /** trace_id 注入开关（接 config observability.enabled；默认 true） */
  readonly traceIdEnabled?: boolean;
  /** 输出接缝（默认 console.log；测试注入捕获数组） */
  readonly sink?: (line: string) => void;
}

const ZERO_TRACE_ID = '0'.repeat(32);

/** 当前 active span 的 trace_id；无真实 trace 时 undefined（全零视为无 trace，不外发占位） */
export function currentTraceId(): string | undefined {
  const context = trace.getActiveSpan()?.spanContext();
  if (!context || context.traceId === ZERO_TRACE_ID) return undefined;
  return context.traceId;
}

/** 字段安全序列化：Error 取 message+name，其余 JSON 往返失败则降级 String（防循环引用炸日志） */
function serializeField(value: unknown): unknown {
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (typeof value === 'string') return value;
  try {
    JSON.stringify(value);
    return value;
  } catch {
    return String(value);
  }
}

export interface LogLineContext {
  readonly service: string;
  readonly traceId?: string;
}

/**
 * fields 入参形态：结构化字段对象，或 Nest LoggerService 的**位置参数字符串**。
 * Nest 调自定义 logger 是 log(message, context)/error(message, stack, context)——第二参是
 * 字符串（context/stack），不是字段对象；字符串若直接进 Object.entries 会被 splat 成
 * 索引-单字符对（{"0":"I","1":"n",…}），必须在归一层拦截。
 */
export type LogFields = Record<string, unknown> | string;

/** Nest 位置参数归一：字符串 → { context }（error 的 stack 形态在方法层另行装配） */
function normalizeFields(fields: LogFields | undefined): Record<string, unknown> | undefined {
  if (fields === undefined) return undefined;
  if (typeof fields === 'string') return { context: fields };
  return fields;
}

/** msg 序列化：Error 取 name+message；对象 JSON 化（失败降级 String，防 [object Object] 丢信息） */
function messageToString(message: unknown): string {
  if (message instanceof Error) return `${message.name}: ${message.message}`;
  if (typeof message === 'string') return message;
  try {
    const json = JSON.stringify(message);
    return json === undefined ? String(message) : json;
  } catch {
    return String(message);
  }
}

/** 单行格式化（纯函数，单测直接断言键序与缺省行为；字符串 fields 归一为 context） */
export function formatLogLine(
  level: TraceLogLevel,
  message: unknown,
  fields: LogFields | undefined,
  context: LogLineContext,
): string {
  const entry: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    svc: context.service,
    ...(context.traceId === undefined ? {} : { trace_id: context.traceId }),
    msg: messageToString(message),
  };
  for (const [key, value] of Object.entries(normalizeFields(fields) ?? {})) {
    entry[key] = serializeField(value);
  }
  return JSON.stringify(entry);
}

export class TraceLogger {
  /** Nest LoggerService 兼容层（log=info / verbose=debug） */
  private readonly service: string;
  private readonly traceIdEnabled: boolean;
  private readonly sink: (line: string) => void;

  constructor(options: TraceLoggerOptions = {}) {
    this.service = options.service ?? '@ljr/core';
    this.traceIdEnabled = options.traceIdEnabled ?? true;
    this.sink = options.sink ?? ((line) => console.log(line));
  }

  debug(message: unknown, fields?: LogFields): void {
    this.write('debug', message, fields);
  }

  info(message: unknown, fields?: LogFields): void {
    this.write('info', message, fields);
  }

  warn(message: unknown, fields?: LogFields): void {
    this.write('warn', message, fields);
  }

  /** Nest LoggerService.error(message, stack, context) 位置参数形态：字符串第二参是 stack */
  error(message: unknown, fieldsOrStack?: LogFields, context?: string): void {
    const fields =
      typeof fieldsOrStack === 'string'
        ? { stack: fieldsOrStack, ...(context === undefined ? {} : { context }) }
        : context === undefined
          ? fieldsOrStack
          : { ...(fieldsOrStack ?? {}), context };
    this.write('error', message, fields);
  }

  log(message: unknown, fields?: LogFields): void {
    this.write('info', message, fields);
  }

  verbose(message: unknown, fields?: LogFields): void {
    this.write('debug', message, fields);
  }

  private write(level: TraceLogLevel, message: unknown, fields?: LogFields): void {
    try {
      const line = formatLogLine(level, message, fields, {
        service: this.service,
        traceId: this.traceIdEnabled ? currentTraceId() : undefined,
      });
      this.sink(line);
    } catch {
      // 日志永不反噬业务：sink 异常/字段异常均已内层兜底，此处为最终防线
    }
  }
}
