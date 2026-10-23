/**
 * 后台侧栏（M3-W3 T1）：ADMIN_NAV 四组对照 prototype/index.html（概览/供给管理/交易与履约/
 * 平台治理）——W3 落位路由（数据看板+五页面 T2~T6 全落位：律师/工单/改价审批/风控/规则）
 * 可点；其余导航项禁用态+「M4」徽标（W3-5：a-monitor/a-settle/a-match/a-kb/a-recruit/
 * a-comp/a-sys=M4 批范畴，不建空页）。改价审批=T6（交易与履约组、纠纷工单之后——审批台
 * 独立成页，非 a-tickets 工单兜底语境内嵌）。焦点态左侧 3px 豆沙红条=极小面积点缀（原型
 * .ad-nav.on::before 同款）。
 */
import type { ComponentType } from 'react';
import type { AdminRouteKey } from '../navigation/router-state';
import {
  IconAlert,
  IconBan,
  IconBrief,
  IconChart,
  IconCoin,
  IconFile,
  IconFlag,
  IconGear,
  IconRoom,
  IconScale,
  IconShield,
  IconUsers,
  IconWallet,
} from './icons';

export interface NavItem {
  readonly key: string;
  readonly title: string;
  /** 在册路由键（缺省=M4 占位禁用项） */
  readonly route?: AdminRouteKey;
  readonly icon: ComponentType<{ size?: number }>;
}

export interface NavGroup {
  readonly title: string;
  readonly items: readonly NavItem[];
}

/** 四组导航单表（sidebar 渲染与路由放行同源，禁散写第二份） */
export const ADMIN_NAV: readonly NavGroup[] = [
  {
    title: '概览',
    items: [{ key: 'home', title: '数据看板', route: 'home', icon: IconChart }],
  },
  {
    title: '供给管理',
    items: [
      { key: 'lawyers', title: '律师与资质', route: 'lawyers', icon: IconBrief },
      { key: 'kb', title: '专项与知识库', icon: IconFile },
      { key: 'recruit', title: '招募归因', icon: IconFlag },
    ],
  },
  {
    title: '交易与履约',
    items: [
      { key: 'monitor', title: '场次实时监控', icon: IconRoom },
      { key: 'tickets', title: '纠纷工单', route: 'tickets', icon: IconAlert },
      { key: 'pricing', title: '改价审批', route: 'pricing-approvals', icon: IconCoin },
      { key: 'settle', title: '结算管理', icon: IconWallet },
    ],
  },
  {
    title: '平台治理',
    items: [
      { key: 'risk', title: '风控与敏感词', route: 'risk', icon: IconBan },
      { key: 'match', title: '人工撮合', icon: IconUsers },
      { key: 'rules', title: '规则中心', route: 'rules', icon: IconScale },
      { key: 'comp', title: '合规审计', icon: IconShield },
      { key: 'sys', title: '系统支撑', icon: IconGear },
    ],
  },
];

interface AdminSidebarProps {
  readonly activeRoute: AdminRouteKey;
  onNavigate(route: AdminRouteKey): void;
}

export function AdminSidebar({ activeRoute, onNavigate }: AdminSidebarProps) {
  return (
    <aside className="ad-side glass-card">
      {ADMIN_NAV.map((group) => (
        <div key={group.title}>
          <div className="grp">{group.title}</div>
          {group.items.map((item) => {
            const Icon = item.icon;
            if (item.route === undefined) {
              return (
                <button
                  key={item.key}
                  className="ad-nav"
                  type="button"
                  disabled
                  title="M4 批次落位"
                >
                  <Icon size={16} />
                  <span className="grow">{item.title}</span>
                  <span className="m4-badge">M4</span>
                </button>
              );
            }
            return (
              <button
                key={item.key}
                type="button"
                className={`ad-nav${activeRoute === item.route ? ' on' : ''}`}
                onClick={() => onNavigate(item.route as AdminRouteKey)}
              >
                <Icon size={16} />
                <span className="grow">{item.title}</span>
              </button>
            );
          })}
        </div>
      ))}
    </aside>
  );
}
