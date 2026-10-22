/**
 * B1 时间表 API（M3-W2 T2，契约消费——core time-table.controller 实文为准）：
 *   GET  /lawyer/{id}/schedule        → {version, templates[]}（公开读：用户端选段要读；
 *                                       version=PUT 乐观并发读侧——Task 4 简报自定口径）
 *   PUT  /lawyer/schedule             → 全量替换（Bearer+lawyer；体 {version, templates}；
 *                                       幂等键=lawyer+version，不一致 409 E_CONFLICT）
 *   GET  /lawyer/{id}/slots?from=&to= → [{slot_start, status, ref}]（状态视图：FREE/
 *                                       PENDING_PAYMENT/LOCKED/OCCUPIED——B2 活跃锁实时 join）
 *
 * 注意：B1 文档 §5 路径写作 /lawyer/{id}/schedule，core 实文控制器为 @Controller('lawyer')
 * + ':id/schedule' → 实际路径 /lawyer/:id/schedule（单数 lawyer，非 lawyers）——本层按实文。
 *
 * fail-visible：出参形状（version/模板行字段/时段行字段）本层校验，非法即
 * CLIENT_BAD_RESPONSE；入参本地前置校验（id/日期/模板值域镜像 core normalizeTemplate）
 * 不发坏请求（CLIENT_BAD_REQUEST）。重叠/跨天为表单层防呆（utils/slot-input），core 无此检。
 * 本模块保持平台无关（无 react-native import），bun test 直接可测。
 */
import { AppClientErrorCode, apiFetch, AppApiError } from './client';
import { isValidDateInput, timeToMinutes } from '../utils/slot-input';

/** R-03 单场时长三档（B1 §3 duration_small CHECK 值域逐字） */
export type SlotDuration = 60 | 90 | 120;

export const SLOT_DURATIONS: readonly SlotDuration[] = [60, 90, 120];

/** 模板行视图（GET/PUT 出参元素；start_time 出站归一 'HH:MM:SS'） */
export interface ScheduleTemplateView {
  readonly id: number;
  /** 0=周日..6=周六（core normalizeTemplate 口径） */
  readonly weekday: number;
  readonly start_time: string;
  readonly duration_small: SlotDuration;
  readonly enabled: boolean;
}

export interface ScheduleView {
  readonly version: number;
  readonly templates: readonly ScheduleTemplateView[];
}

/** PUT 模板写入元素（入参；start_time 收 'HH:MM' 或 'HH:MM:SS'，enabled 缺省=true） */
export interface ScheduleTemplateWrite {
  readonly weekday: number;
  readonly start_time: string;
  readonly duration_small: SlotDuration;
  readonly enabled?: boolean;
}

export interface ReplaceScheduleInput {
  readonly version: number;
  readonly templates: readonly ScheduleTemplateWrite[];
}

/** B1 状态视图行（core SlotViewRow 序列化形；slot_start ISO 8601） */
export interface SlotView {
  readonly slot_start: string;
  readonly status: string;
  readonly ref: { readonly ref_type: string; readonly ref_id: number } | null;
}

function badShape(detail: string): AppApiError {
  return new AppApiError({
    code: AppClientErrorCode.BadResponseBody,
    copy: '服务响应异常，请稍后重试',
    serverMessage: `时间表响应形状非法：${detail}`,
  });
}

function badRequest(detail: string): AppApiError {
  return new AppApiError({
    code: AppClientErrorCode.BadRequest,
    copy: '请求参数有误，请返回重试',
    serverMessage: `时间表入参非法：${detail}`,
  });
}

function isNonNegInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

/** 出参模板行校验（宽进严出：weekday/duration 值域越界=core 不变量破坏，属响应形状错） */
function parseTemplateView(raw: unknown): ScheduleTemplateView {
  if (typeof raw !== 'object' || raw === null) throw badShape('模板行非对象');
  const r = raw as Record<string, unknown>;
  if (!isNonNegInt(r['id']) || r['id'] === 0) throw badShape('id 非正整数');
  if (
    !Number.isInteger(r['weekday']) ||
    (r['weekday'] as number) < 0 ||
    (r['weekday'] as number) > 6
  ) {
    throw badShape('weekday 须为 0-6');
  }
  if (typeof r['start_time'] !== 'string' || !/^\d{2}:\d{2}:\d{2}$/.test(r['start_time'])) {
    throw badShape('start_time 非 HH:MM:SS');
  }
  if (!(SLOT_DURATIONS as readonly number[]).includes(r['duration_small'] as number)) {
    throw badShape('duration_small 越三档');
  }
  if (typeof r['enabled'] !== 'boolean') throw badShape('enabled 非布尔');
  return {
    id: r['id'],
    weekday: r['weekday'] as number,
    start_time: r['start_time'],
    duration_small: r['duration_small'] as SlotDuration,
    enabled: r['enabled'],
  };
}

function parseScheduleView(raw: unknown): ScheduleView {
  if (typeof raw !== 'object' || raw === null) throw badShape('响应非对象');
  const r = raw as Record<string, unknown>;
  if (!isNonNegInt(r['version'])) throw badShape('version 非非负整数');
  if (!Array.isArray(r['templates'])) throw badShape('templates 非数组');
  return { version: r['version'], templates: r['templates'].map(parseTemplateView) };
}

/** 入参模板元素校验（镜像 core normalizeTemplate 值域——防呆不发坏请求；400 语义同 core） */
function assertTemplateWrite(t: ScheduleTemplateWrite, index: number): void {
  if (!Number.isInteger(t.weekday) || t.weekday < 0 || t.weekday > 6) {
    throw badRequest(`templates[${index}].weekday 须为 0-6 整数：${String(t.weekday)}`);
  }
  // 'HH:MM' 表单形态与 'HH:MM:SS' 出站归一形态均放行；时刻越界（24:00+）同拒（core 同口径）
  if (typeof t.start_time !== 'string' || timeToMinutes(t.start_time) === null) {
    throw badRequest(
      `templates[${index}].start_time 须为 HH:MM 或 HH:MM:SS 且时刻不越界：${String(t.start_time)}`,
    );
  }
  if (!(SLOT_DURATIONS as readonly number[]).includes(t.duration_small)) {
    throw badRequest(
      `templates[${index}].duration_small 须为 60/90/120（R-03）：${String(t.duration_small)}`,
    );
  }
  if (t.enabled !== undefined && typeof t.enabled !== 'boolean') {
    throw badRequest(`templates[${index}].enabled 须为布尔：${String(t.enabled)}`);
  }
}

function assertLawyerId(lawyerId: number): void {
  if (!Number.isInteger(lawyerId) || lawyerId <= 0 || !Number.isSafeInteger(lawyerId)) {
    throw badRequest(`lawyerId 非正整数：${String(lawyerId)}`);
  }
}

/** GET /lawyer/:id/schedule：模板读（公开面，无 Bearer） */
export async function fetchSchedule(lawyerId: number): Promise<ScheduleView> {
  assertLawyerId(lawyerId);
  return parseScheduleView(await apiFetch<unknown>(`/lawyer/${lawyerId}/schedule`));
}

/** PUT /lawyer/schedule：全量替换（本人；幂等键=lawyer+version——409 E_CONFLICT=别处已改） */
export async function replaceSchedule(input: ReplaceScheduleInput): Promise<ScheduleView> {
  if (!Number.isInteger(input.version) || input.version < 0) {
    throw badRequest(`version 须为非负整数：${String(input.version)}`);
  }
  if (!Array.isArray(input.templates)) {
    throw badRequest('templates 须为数组（全量替换语义，空数组=清空时间表）');
  }
  input.templates.forEach(assertTemplateWrite);
  return parseScheduleView(
    await apiFetch<unknown>('/lawyer/schedule', {
      method: 'PUT',
      auth: true,
      body: { version: input.version, templates: input.templates },
    }),
  );
}

/** GET /lawyer/:id/slots?from=&to=：状态视图（公开面；from/to=YYYY-MM-DD 上海日界） */
export async function fetchSlots(lawyerId: number, from: string, to: string): Promise<SlotView[]> {
  assertLawyerId(lawyerId);
  if (!isValidDateInput(from)) throw badRequest(`from 须为真实日历日 YYYY-MM-DD：${from}`);
  if (!isValidDateInput(to)) throw badRequest(`to 须为真实日历日 YYYY-MM-DD：${to}`);
  const raw = await apiFetch<unknown>(
    `/lawyer/${lawyerId}/slots?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
  );
  if (!Array.isArray(raw)) throw badShape('响应非数组');
  return raw.map((row): SlotView => {
    if (typeof row !== 'object' || row === null) throw badShape('时段行非对象');
    const r = row as Record<string, unknown>;
    if (typeof r['slot_start'] !== 'string' || Number.isNaN(Date.parse(r['slot_start']))) {
      throw badShape('slot_start 非时刻');
    }
    if (typeof r['status'] !== 'string' || r['status'].length === 0) {
      throw badShape('status 非非空字符串');
    }
    const ref = r['ref'];
    if (ref !== null) {
      if (typeof ref !== 'object' || ref === null) throw badShape('ref 非 null/对象');
      const refR = ref as Record<string, unknown>;
      if (typeof refR['ref_type'] !== 'string' || refR['ref_type'].length === 0) {
        throw badShape('ref.ref_type 非非空字符串');
      }
      if (!Number.isInteger(refR['ref_id']) || (refR['ref_id'] as number) <= 0) {
        throw badShape('ref.ref_id 非正整数');
      }
    }
    return {
      slot_start: r['slot_start'],
      status: r['status'],
      ref:
        ref === null
          ? null
          : {
              ref_type: (ref as Record<string, unknown>)['ref_type'] as string,
              ref_id: (ref as Record<string, unknown>)['ref_id'] as number,
            },
    };
  });
}
