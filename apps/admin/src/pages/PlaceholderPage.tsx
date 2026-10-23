/**
 * W3 五页面施工位占位页（M3-W3 T1）：#/lawyers、#/tickets、#/risk、#/rules 的路由位预留——
 * 页面本体随 T2（H1 律师与资质审核）/T3（H3 纠纷工单）/T4（H5 风控）/T5（H7 规则中心）/
 * T6（C6 改价审批台，路由位待 T6 定）落位。占位页只声明施工坐标，不出假数据。
 */
import type { ReactNode } from 'react';

interface PlaceholderPageProps {
  readonly title: string;
  /** 施工坐标（如「H1 律师与资质审核 · M3-W3 T2」） */
  readonly taskNote: string;
  readonly icon: ReactNode;
}

export function PlaceholderPage({ title, taskNote, icon }: PlaceholderPageProps) {
  return (
    <>
      <div className="ad-head">
        <div>
          <div className="h1">{title}</div>
          <div className="sub">M3-W3 T2~T6 施工位</div>
        </div>
      </div>
      <div className="glass-card placeholder-card">
        <span style={{ color: 'var(--ljr-primary-2)' }}>{icon}</span>
        <div style={{ fontSize: 16, fontWeight: 600 }}>{title}</div>
        <div className="small muted">本页随 {taskNote} 落位——当前为骨架批（T1）路由占位。</div>
      </div>
    </>
  );
}
