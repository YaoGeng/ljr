/**
 * 首页轻量指标条（M3-W3 T1，W3-5）：GET /admin/dashboard/metrics?group=core 数字卡横排。
 * H4 数据看板全页（图表/窗口筛选/健康组）=M4 范畴不越界。
 * 三态如实承载：loading / error（显式错误+重试，不假装数据）/ ok（数字卡+口径注记透传）。
 * 401（会话失效）由 client 统一拦截回登录页，本页只展示非 401 错误文案。
 */
import { useCallback, useEffect, useState } from 'react';
import {
  fetchCoreMetrics,
  formatMetricValue,
  metricTitle,
  type CoreMetricsResponse,
} from '../api/dashboard';
import { isAdminApiError } from '../api/client';
import { IconRefresh } from '../components/icons';

type MetricsState =
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | { phase: 'ok'; data: CoreMetricsResponse };

export function HomePage() {
  const [state, setState] = useState<MetricsState>({ phase: 'loading' });

  const load = useCallback(async () => {
    setState({ phase: 'loading' });
    try {
      setState({ phase: 'ok', data: await fetchCoreMetrics() });
    } catch (err) {
      setState({
        phase: 'error',
        message: isAdminApiError(err) ? err.message : '操作失败，请稍后重试',
      });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <>
      <div className="ad-head">
        <div>
          <div className="h1">数据看板</div>
          <div className="sub">
            核心组指标（轻量指标条）· 口径映射 PRD §12 · 指标管道自事件流聚合（H4）——完整看板=M4
            范畴
          </div>
        </div>
        <button
          type="button"
          className="btn btn-o btn-sm"
          onClick={() => void load()}
          disabled={state.phase === 'loading'}
        >
          <IconRefresh size={13} />
          刷新
        </button>
      </div>

      {state.phase === 'loading' ? (
        <div className="glass-card" style={{ padding: '36px 20px', textAlign: 'center' }}>
          <span className="muted">指标加载中…</span>
        </div>
      ) : null}

      {state.phase === 'error' ? (
        <div
          className="glass-card"
          style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 12 }}
        >
          <div className="error-banner" role="alert">
            <span>指标加载失败：{state.message}</span>
          </div>
          <div>
            <button type="button" className="btn btn-g btn-sm" onClick={() => void load()}>
              重试
            </button>
          </div>
        </div>
      ) : null}

      {state.phase === 'ok' ? (
        state.data.metrics.length === 0 ? (
          <div className="notice">
            <span>窗口内暂无指标数据。</span>
          </div>
        ) : (
          <div className="kpis">
            {state.data.metrics.map((m) => (
              <div key={m.key} className="glass-card kpi">
                <div className="k">{metricTitle(m.key)}</div>
                <div className="v">{formatMetricValue(m.key, m.value)}</div>
                {m.stub !== null ? (
                  <div className="stub" title={m.stub}>
                    口径注记：{m.stub}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        )
      ) : null}
    </>
  );
}
