import { describe, expect, it, beforeEach } from 'bun:test';
import { ErrorCode } from '@ljr/shared';
import { setApiBaseUrl } from './config';
import { AppClientErrorCode, __resetClientForTest, setAccessToken } from './client';
import { fetchSchedule, fetchSlots, replaceSchedule } from './schedule';
import { jsonResponse, stubFetch } from './test-helpers';

const SCHEDULE_VIEW = {
  version: 3,
  templates: [
    { id: 11, weekday: 1, start_time: '19:00:00', duration_small: 90, enabled: true },
    { id: 12, weekday: 5, start_time: '20:00:00', duration_small: 60, enabled: false },
  ],
};

const SLOT_ROW = {
  slot_start: '2026-10-19T11:00:00.000Z', // 上海 19:00
  status: 'FREE',
  ref: null,
};

beforeEach(() => {
  __resetClientForTest();
  setApiBaseUrl('http://core.test');
});

describe('GET /lawyer/:id/schedule（B1 读）', () => {
  it('路径拼 id（无需鉴权——公开读），出参 version+templates 逐字段', async () => {
    const seen = stubFetch([jsonResponse(200, SCHEDULE_VIEW)]);
    const view = await fetchSchedule(4);
    expect(seen[0]?.url).toBe('http://core.test/lawyer/4/schedule');
    expect(seen[0]?.init.headers).toEqual({ 'Content-Type': 'application/json' }); // 无 Bearer
    expect(view.version).toBe(3);
    expect(view.templates[1]).toEqual({
      id: 12,
      weekday: 5,
      start_time: '20:00:00',
      duration_small: 60,
      enabled: false,
    });
  });

  it('响应形状非法（version 缺失/duration 越档/weekday 越界）→ CLIENT_BAD_RESPONSE', async () => {
    stubFetch([jsonResponse(200, { templates: [] })]); // 无 version
    let err: unknown = null;
    await fetchSchedule(4).catch((e) => {
      err = e;
    });
    expect((err as { code?: string }).code).toBe(AppClientErrorCode.BadResponseBody);

    stubFetch([
      jsonResponse(200, {
        version: 0,
        templates: [
          { id: 1, weekday: 1, start_time: '19:00:00', duration_small: 45, enabled: true },
        ],
      }),
    ]);
    err = null;
    await fetchSchedule(4).catch((e) => {
      err = e;
    });
    expect((err as { code?: string }).code).toBe(AppClientErrorCode.BadResponseBody);

    stubFetch([
      jsonResponse(200, {
        version: 0,
        templates: [
          { id: 1, weekday: 7, start_time: '19:00:00', duration_small: 60, enabled: true },
        ],
      }),
    ]);
    err = null;
    await fetchSchedule(4).catch((e) => {
      err = e;
    });
    expect((err as { code?: string }).code).toBe(AppClientErrorCode.BadResponseBody);
  });

  it('非正整数 id → 本地拒绝 CLIENT_BAD_REQUEST（请求未发出）', async () => {
    const seen = stubFetch([jsonResponse(200, SCHEDULE_VIEW)]);
    let err: unknown = null;
    await fetchSchedule(0).catch((e) => {
      err = e;
    });
    expect((err as { code?: string }).code).toBe(AppClientErrorCode.BadRequest);
    expect(seen).toHaveLength(0);
  });
});

describe('PUT /lawyer/schedule（B1 全量替换）', () => {
  it('Bearer 注入 + 体形状 {version, templates}（snake_case 契约词汇）；出参为新视图', async () => {
    setAccessToken('lawyer-token');
    const seen = stubFetch([jsonResponse(200, { ...SCHEDULE_VIEW, version: 4 })]);
    const view = await replaceSchedule({
      version: 3,
      templates: [
        { weekday: 1, start_time: '19:00', duration_small: 90, enabled: true },
        { weekday: 2, start_time: '09:30:00', duration_small: 120 }, // enabled 缺省
      ],
    });
    const headers = seen[0]?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer lawyer-token');
    expect(seen[0]?.url).toBe('http://core.test/lawyer/schedule');
    expect(JSON.parse(String(seen[0]?.init.body))).toEqual({
      version: 3,
      templates: [
        { weekday: 1, start_time: '19:00', duration_small: 90, enabled: true },
        { weekday: 2, start_time: '09:30:00', duration_small: 120 },
      ],
    });
    expect(view.version).toBe(4);
  });

  it('409 E_CONFLICT（version 不一致乐观锁）→ AppApiError 透传 shared 码 + 映射文案', async () => {
    setAccessToken('lawyer-token');
    stubFetch([
      jsonResponse(409, {
        code: ErrorCode.Conflict,
        message: '时间表版本不一致（服务端 5，入参 3），请刷新后重试',
      }),
    ]);
    let err: unknown = null;
    await replaceSchedule({ version: 3, templates: [] }).catch((e) => {
      err = e;
    });
    expect((err as { code?: string }).code).toBe(ErrorCode.Conflict);
    expect((err as { httpStatus?: number }).httpStatus).toBe(409);
    expect((err as Error).message).toBe('操作冲突，请刷新后重试');
  });

  it('入参本地前置校验（version 非负整数/元素域检）→ CLIENT_BAD_REQUEST 不发坏请求', async () => {
    setAccessToken('lawyer-token');
    const seen = stubFetch([jsonResponse(200, SCHEDULE_VIEW)]);
    let err: unknown = null;
    await replaceSchedule({ version: -1, templates: [] }).catch((e) => {
      err = e;
    });
    expect((err as { code?: string }).code).toBe(AppClientErrorCode.BadRequest);

    err = null;
    await replaceSchedule({
      version: 0,
      // R-03 三档外（45）——类型上以宽形注入：本地校验须在发出前拒绝
      templates: [{ weekday: 1, start_time: '19:00', duration_small: 45 }] as never,
    }).catch((e) => {
      err = e;
    });
    expect((err as { code?: string }).code).toBe(AppClientErrorCode.BadRequest);

    err = null;
    await replaceSchedule({
      version: 0,
      templates: [{ weekday: 1, start_time: '25:00', duration_small: 60 }],
    }).catch((e) => {
      err = e;
    });
    expect((err as { code?: string }).code).toBe(AppClientErrorCode.BadRequest);
    expect(seen).toHaveLength(0);
  });
});

describe('GET /lawyer/:id/slots（B1 状态视图）', () => {
  it('from/to 编码进查询串；行形状 slot_start/status/ref（ref 带 ref_type+ref_id）', async () => {
    const seen = stubFetch([
      jsonResponse(200, [
        SLOT_ROW,
        {
          slot_start: '2026-10-20T12:00:00.000Z',
          status: 'LOCKED',
          ref: { ref_type: 'groupbuy', ref_id: 77 },
        },
      ]),
    ]);
    const rows = await fetchSlots(4, '2026-10-19', '2026-10-25');
    expect(seen[0]?.url).toBe('http://core.test/lawyer/4/slots?from=2026-10-19&to=2026-10-25');
    expect(rows[0]?.status).toBe('FREE');
    expect(rows[0]?.ref).toBeNull();
    expect(rows[1]?.ref).toEqual({ ref_type: 'groupbuy', ref_id: 77 });
  });

  it('响应非数组 / 行缺字段 → CLIENT_BAD_RESPONSE', async () => {
    stubFetch([jsonResponse(200, { slots: [] })]);
    let err: unknown = null;
    await fetchSlots(4, '2026-10-19', '2026-10-25').catch((e) => {
      err = e;
    });
    expect((err as { code?: string }).code).toBe(AppClientErrorCode.BadResponseBody);

    stubFetch([jsonResponse(200, [{ status: 'FREE', ref: null }])]); // 缺 slot_start
    err = null;
    await fetchSlots(4, '2026-10-19', '2026-10-25').catch((e) => {
      err = e;
    });
    expect((err as { code?: string }).code).toBe(AppClientErrorCode.BadResponseBody);
  });

  it('日期形态非法（2026-02-30 / 2026-10-19 09 格式）→ 本地拒绝不发坏请求', async () => {
    const seen = stubFetch([jsonResponse(200, [])]);
    let err: unknown = null;
    await fetchSlots(4, '2026-02-30', '2026-10-25').catch((e) => {
      err = e;
    });
    expect((err as { code?: string }).code).toBe(AppClientErrorCode.BadRequest);
    expect(seen).toHaveLength(0);
  });
});
