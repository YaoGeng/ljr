import { describe, expect, it, beforeEach } from 'bun:test';
import { setApiBaseUrl } from './config';
import { AppClientErrorCode, __resetClientForTest, setAccessToken } from './client';
import {
  fetchAgentHealth,
  fetchAttendanceStats,
  fetchLawyerSettlements,
  fetchResponseStats,
  fetchSessionStats,
  formatPercent,
  formatRate,
  shiftWeekWindow,
  shanghaiWeekWindow,
} from './lawyer-stats';
import { jsonResponse, stubFetch } from './test-helpers';

beforeEach(() => {
  __resetClientForTest();
  setApiBaseUrl('http://core.test');
});

describe('GET /lawyer/sessions/stats（C1 四率——M2-W3 T3 起全真值）', () => {
  it('Bearer 注入 + from/to 查询串；四率 number|null 逐字段（null=缺数据语义）', async () => {
    setAccessToken('lawyer-token');
    const seen = stubFetch([
      jsonResponse(200, {
        enroll_rate: 0.8333,
        group_rate: 0.6667,
        attendance_rate: null,
        ooo_rate: null,
      }),
    ]);
    const stats = await fetchSessionStats({ from: '2026-10-19', to: '2026-10-25' });
    const headers = seen[0]?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer lawyer-token');
    expect(seen[0]?.url).toBe(
      'http://core.test/lawyer/sessions/stats?from=2026-10-19&to=2026-10-25',
    );
    expect(stats.enroll_rate).toBe(0.8333);
    expect(stats.attendance_rate).toBeNull();
  });

  it('率值非 number/null（如字符串）→ CLIENT_BAD_RESPONSE（fail-visible）', async () => {
    setAccessToken('lawyer-token');
    stubFetch([
      jsonResponse(200, { enroll_rate: '83%', group_rate: 1, attendance_rate: 0, ooo_rate: 0 }),
    ]);
    let err: unknown = null;
    await fetchSessionStats({ from: '2026-10-19', to: '2026-10-25' }).catch((e) => {
      err = e;
    });
    expect((err as { code?: string }).code).toBe(AppClientErrorCode.BadResponseBody);
  });
});

describe('GET /lawyer/attendance-stats（D3 准时率）', () => {
  it('{samples, punctual_rate}（samples=0 时 rate=0——core 空窗不除零口径）', async () => {
    setAccessToken('lawyer-token');
    const seen = stubFetch([jsonResponse(200, { samples: 6, punctual_rate: 1 })]);
    const stats = await fetchAttendanceStats({ from: '2026-10-19', to: '2026-10-25' });
    expect(seen[0]?.url).toBe(
      'http://core.test/lawyer/attendance-stats?from=2026-10-19&to=2026-10-25',
    );
    expect(stats.samples).toBe(6);
    expect(stats.punctual_rate).toBe(1);
  });

  it('负 samples → CLIENT_BAD_RESPONSE', async () => {
    setAccessToken('lawyer-token');
    stubFetch([jsonResponse(200, { samples: -1, punctual_rate: 0 })]);
    let err: unknown = null;
    await fetchAttendanceStats({ from: '2026-10-19', to: '2026-10-25' }).catch((e) => {
      err = e;
    });
    expect((err as { code?: string }).code).toBe(AppClientErrorCode.BadResponseBody);
  });
});

describe('GET /lawyer/response-stats（C4 响应时长）', () => {
  it('samples 数组 + avg_confirm_minutes（null=窗内零确认）', async () => {
    setAccessToken('lawyer-token');
    const seen = stubFetch([
      jsonResponse(200, {
        samples: [{ gb_id: 9, confirmed_at: '2026-10-20T08:00:00.000Z', confirm_minutes: 42 }],
        avg_confirm_minutes: 42,
      }),
    ]);
    const stats = await fetchResponseStats({ from: '2026-10-19', to: '2026-10-25' });
    expect(seen[0]?.url).toBe(
      'http://core.test/lawyer/response-stats?from=2026-10-19&to=2026-10-25',
    );
    expect(stats.samples[0]?.confirm_minutes).toBe(42);
  });

  it('samples 非数组 / 行缺 confirmed_at → CLIENT_BAD_RESPONSE；avg null 合法', async () => {
    setAccessToken('lawyer-token');
    stubFetch([jsonResponse(200, { samples: {}, avg_confirm_minutes: null })]);
    let err: unknown = null;
    await fetchResponseStats({ from: '2026-10-19', to: '2026-10-25' }).catch((e) => {
      err = e;
    });
    expect((err as { code?: string }).code).toBe(AppClientErrorCode.BadResponseBody);

    stubFetch([
      jsonResponse(200, { samples: [{ gb_id: 9, confirm_minutes: 1 }], avg_confirm_minutes: null }),
    ]);
    err = null;
    await fetchResponseStats({ from: '2026-10-19', to: '2026-10-25' }).catch((e) => {
      err = e;
    });
    expect((err as { code?: string }).code).toBe(AppClientErrorCode.BadResponseBody);
  });
});

describe('GET /lawyer/settlements（F3 本人结算列表）', () => {
  const SETTLEMENT_ROW = {
    id: 5,
    ref_type: 'session',
    ref_id: 41,
    lawyer_id: 4,
    firm_id: 2,
    gross: '995.00',
    penalty: '0.00',
    platform_fee: '149.25',
    fee_version_id: 1,
    net: '845.75',
    share_mode: 'FULL_TO_LAWYER',
    payment_order_id: null,
    escrow_status: null,
    deduction_detail: null,
    status: 'PENDING',
    hold_reason: null,
    created_at: '2026-10-20T10:00:00.000Z',
    settled_at: null,
  };

  it('裸数组出参 + 金额字段 Money 字符串校验（net 供工作台简版展示）', async () => {
    setAccessToken('lawyer-token');
    const seen = stubFetch([jsonResponse(200, [SETTLEMENT_ROW])]);
    const rows = await fetchLawyerSettlements();
    expect(seen[0]?.url).toBe('http://core.test/lawyer/settlements');
    expect(rows[0]?.net).toBe('845.75');
    expect(rows[0]?.status).toBe('PENDING');
    expect(rows[0]?.settled_at).toBeNull();
  });

  it('金额 number 形态（违反 NUMERIC 字符串契约）→ CLIENT_BAD_RESPONSE', async () => {
    setAccessToken('lawyer-token');
    stubFetch([jsonResponse(200, [{ ...SETTLEMENT_ROW, net: 845.75 }])]);
    let err: unknown = null;
    await fetchLawyerSettlements().catch((e) => {
      err = e;
    });
    expect((err as { code?: string }).code).toBe(AppClientErrorCode.BadResponseBody);
  });
});

describe('GET /agent/health（E1 降级探针——无守卫面）', () => {
  it('无 Bearer（探针面）；ok 态 {status, last_error:null, degraded_count:0}', async () => {
    setAccessToken('lawyer-token'); // 即便会话在也不注入——探针面无守卫
    const seen = stubFetch([
      jsonResponse(200, { status: 'ok', last_error: null, degraded_count: 0 }),
    ]);
    const health = await fetchAgentHealth();
    const headers = seen[0]?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
    expect(health.status).toBe('ok');
  });

  it('degraded 态：status/last_error/degraded_count 逐字段承载', async () => {
    stubFetch([
      jsonResponse(200, {
        status: 'degraded',
        last_error: 'LLM 管线超时（截断）',
        degraded_count: 3,
      }),
    ]);
    const health = await fetchAgentHealth();
    expect(health.status).toBe('degraded');
    expect(health.degraded_count).toBe(3);
  });

  it('status 越值域（running）→ CLIENT_BAD_RESPONSE', async () => {
    stubFetch([jsonResponse(200, { status: 'running', last_error: null, degraded_count: 0 })]);
    let err: unknown = null;
    await fetchAgentHealth().catch((e) => {
      err = e;
    });
    expect((err as { code?: string }).code).toBe(AppClientErrorCode.BadResponseBody);
  });
});

describe('shanghaiWeekWindow（统计窗：上海日历周 周一..周日）', () => {
  it('周中（周五）→ 本周一..周日', () => {
    // 2026-10-23 上海 20:00（UTC 12:00，周五）→ 周一 10-19 .. 周日 10-25
    expect(shanghaiWeekWindow(new Date('2026-10-23T12:00:00.000Z'))).toEqual({
      from: '2026-10-19',
      to: '2026-10-25',
    });
  });

  it('周一 00:30（UTC 前一日 16:30）→ 本周；周日 → 同一周', () => {
    // 2026-10-19 上海 00:30 = UTC 10-18 16:30（周日 UTC）——按上海日历日=周一，属本周
    expect(shanghaiWeekWindow(new Date('2026-10-18T16:30:00.000Z'))).toEqual({
      from: '2026-10-19',
      to: '2026-10-25',
    });
    expect(shanghaiWeekWindow(new Date('2026-10-25T02:00:00.000Z'))).toEqual({
      from: '2026-10-19',
      to: '2026-10-25',
    });
  });

  it('跨年周边界（2027-01-01 周五 → 2026-12-28..2027-01-03）', () => {
    expect(shanghaiWeekWindow(new Date('2027-01-01T04:00:00.000Z'))).toEqual({
      from: '2026-12-28',
      to: '2027-01-03',
    });
  });
});

describe('shiftWeekWindow（时间表周视图翻页：±N 周）', () => {
  it('本周 → 下周/上周（周一锚不变）；跨月/跨年正确', () => {
    const week = { from: '2026-10-19', to: '2026-10-25' };
    expect(shiftWeekWindow(week, 1)).toEqual({ from: '2026-10-26', to: '2026-11-01' });
    expect(shiftWeekWindow(week, -1)).toEqual({ from: '2026-10-12', to: '2026-10-18' });
    expect(shiftWeekWindow(week, 0)).toEqual(week);
    expect(shiftWeekWindow({ from: '2026-12-28', to: '2027-01-03' }, 1)).toEqual({
      from: '2027-01-04',
      to: '2027-01-10',
    });
  });
});

describe('formatRate（比率展示：4 位小数分数 → 百分比文案）', () => {
  it('number → 百分比（最多 1 位小数）；null → —（缺数据语义非 0）', () => {
    expect(formatRate(0.8532)).toBe('85.3%');
    expect(formatRate(1)).toBe('100%');
    expect(formatRate(0)).toBe('0%');
    expect(formatRate(0.0667)).toBe('6.7%');
    expect(formatRate(null)).toBe('—');
  });
});

describe('formatPercent（百分数展示：C6 change_pct numeric(6,3) 文本已是百分数值——评审 I-1 单出口）', () => {
  it('百分数值 → 去尾零百分比（最多 1 位小数）：4.615→4.6%、12.5→12.5%、10→10%、0→0%', () => {
    expect(formatPercent(4.615)).toBe('4.6%'); // 真库实证档：UP 680 vs 650
    expect(formatPercent(12.5)).toBe('12.5%'); // 尾零不补（12.50 ≠ 12.5% 带零形态）
    expect(formatPercent(10)).toBe('10%'); // 整数档无小数点
    expect(formatPercent(0)).toBe('0%'); // 同价改价 0.000
    expect(formatPercent(0.04)).toBe('0%'); // 半值以下舍去
  });

  it('null → —（缺数据语义非 0，与 formatRate 同口径）', () => {
    expect(formatPercent(null)).toBe('—');
  });

  it('与 formatRate 输入域区分钉住：同值 4.615 在两出口语义不同（比率 vs 百分数）', () => {
    expect(formatRate(4.615)).toBe('461.5%'); // 4.615 视作分数 → 461.5%（错误用法即此评审 bug 根源）
    expect(formatPercent(4.615)).toBe('4.6%'); // 4.615 视作百分数值 → 4.6%（C6 change_pct 正确出口）
  });
});
