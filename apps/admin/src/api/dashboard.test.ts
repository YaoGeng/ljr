import { beforeEach, describe, expect, it } from 'bun:test';
import { setApiBaseUrl } from './config';
import { getAccessToken, setAccessToken, __resetClientForTest } from './client';
import { fetchCoreMetrics, formatMetricValue, metricTitle } from './dashboard';

// bun test 同进程串文件：隔离他文件残留的 env 基址，保证「同源相对路径」断言确定
beforeEach(() => {
  __resetClientForTest();
  setApiBaseUrl();
  delete process.env.VITE_API_BASE;
});

describe('admin 指标条数据面（M3-W3 T1：GET /admin/dashboard/metrics?group=core）', () => {
  it('fetchCoreMetrics：同源相对路径 + Bearer 注入（受保护面）+ 契约形状透传', async () => {
    __resetClientForTest();
    setAccessToken('jwt-admin');
    const seen: Array<{ url: string; init: RequestInit }> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), init: init ?? ({} as RequestInit) });
      return new Response(
        JSON.stringify({
          group: 'core',
          from: null,
          to: null,
          metrics: [
            { key: 'group_buy_rate_b2c', value: 0.3533, stub: null },
            { key: 'lawyer_room_avg_duration_min', value: null, stub: '占位' },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as typeof fetch;

    const data = await fetchCoreMetrics();
    expect(seen[0]?.url).toBe('/admin/dashboard/metrics?group=core');
    const headers = seen[0]?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer jwt-admin');
    expect(data.metrics[0]).toEqual({ key: 'group_buy_rate_b2c', value: 0.3533, stub: null });
    expect(data.metrics[1]?.value).toBeNull();
    expect(getAccessToken()).toBe('jwt-admin');
  });

  it('formatMetricValue：比率=百分比、满意度=均值、计数=整数、null=占位破折号', () => {
    expect(formatMetricValue('group_buy_rate_b2c', 0.3533)).toBe('35.33%');
    expect(formatMetricValue('repurchase_rate', 1)).toBe('100.00%');
    expect(formatMetricValue('satisfaction_avg_overall', 4.5321)).toBe('4.53');
    expect(formatMetricValue('lawyer_room_count', 12.0)).toBe('12');
    expect(formatMetricValue('lawyer_room_avg_duration_min', 45.4)).toBe('45 分钟');
    expect(formatMetricValue('lawyer_room_avg_duration_min', null)).toBe('—');
    expect(formatMetricValue('future_new_key', 7)).toBe('7'); // 未登记口径=原值透传
  });

  it('metricTitle：目录副本优先，未登记 key 原样透传（不吞不造）', () => {
    expect(metricTitle('group_buy_rate_b2c')).toBe('拼单成团率（B2C）');
    expect(metricTitle('draft_adoption_rate')).toBe('Agent草稿采用率');
    expect(metricTitle('unknown_key')).toBe('unknown_key');
  });
});
