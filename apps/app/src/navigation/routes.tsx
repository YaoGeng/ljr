/**
 * 路由表（M3-W1 T1 建/M3-W2 T1 扩 role 感知）：tab 元数据（user 五 tab ↔ lawyer 四 tab）
 * + 推栈路由登记。律师四 tab 对照原型 TABS.lawyer（工作台 l-work/场次管理 l-sess/
 * 接单大厅 l-hall/我的 l-me）；tab 屏实现律师侧现为占位组件（T2~T6 逐卡替换）。
 * 新增推栈页须先在 STACK_ROUTES 登记 key+标题。
 */
import type { ComponentType } from 'react';
import {
  CalendarIcon,
  ChatIcon,
  DashboardIcon,
  HomeIcon,
  PublishIcon,
  UserIcon,
  UsersIcon,
  type IconProps,
} from '../components/icons';
import type { AppRole, TabKey } from './navigation-state';

export interface TabRouteDef {
  readonly key: TabKey;
  readonly title: string;
  readonly Icon: ComponentType<IconProps>;
}

/** 用户五 tab 信息架构（决策：首页/场次/发团/消息/我的） */
const USER_TAB_ROUTES: readonly TabRouteDef[] = [
  { key: 'home', title: '首页', Icon: HomeIcon },
  { key: 'sessions', title: '场次', Icon: CalendarIcon },
  { key: 'publish', title: '发团', Icon: PublishIcon },
  { key: 'messages', title: '消息', Icon: ChatIcon },
  { key: 'me', title: '我的', Icon: UserIcon },
];

/** 律师四 tab（对照原型 TABS.lawyer；视图 T2~T6 逐卡填实） */
const LAWYER_TAB_ROUTES: readonly TabRouteDef[] = [
  { key: 'lawyerWork', title: '工作台', Icon: DashboardIcon },
  { key: 'lawyerSessions', title: '场次管理', Icon: CalendarIcon },
  { key: 'lawyerHall', title: '接单大厅', Icon: UsersIcon },
  { key: 'lawyerMe', title: '我的', Icon: UserIcon },
];

/** role → tab 路由单源（与 navigation-state TABS_BY_ROLE 键序一一对应，禁散建第二份） */
export const TAB_ROUTES_BY_ROLE: Readonly<Record<AppRole, readonly TabRouteDef[]>> = {
  user: USER_TAB_ROUTES,
  lawyer: LAWYER_TAB_ROUTES,
};

export function tabRoutesForRole(role: AppRole): readonly TabRouteDef[] {
  return TAB_ROUTES_BY_ROLE[role];
}

/** 推栈路由登记（push 前 key 必须在此，防散写魔法字符串） */
export const STACK_ROUTES: Readonly<Record<string, { readonly title: string }>> = {
  sessionDetail: { title: '场次详情' },
  enrollmentPlaceholder: { title: '报名' }, // T3 报名支付真流（键沿用 T2 交接，不动）
  realname: { title: '实名认证' }, // A2 实名（402 报名拦截引导落点）
  trainingConsent: { title: '训练数据授权' }, // A2 训练授权独立页
  myEnrollments: { title: '我的报名' }, // T4：GET /enrollments/mine
  myGroupBuys: { title: '我的拼团' }, // T4：发起（公开列表过滤）+ 参与（mine groupbuy 行）
  notificationPrefs: { title: '通知偏好' }, // T4：GET/PUT /notification-prefs
  // ---- 律师端（M3-W2 T2/T3 落位） ----
  lawyerSchedule: { title: '时间表管理' }, // T2：B1 读/写/slots
  lawyerCreateSession: { title: '开团配置' }, // T3：C1 七键+B2 锁错误态；FREE 时段预选经 params.slot_start
  lawyerPricing: { title: '价格配置' }, // T3：B3 默认价格与 1对1 + C6 改价申请面
  lawyerBoard: { title: '场次看板' }, // T5：D1/D3 只读聚合（详情任意态+出席/公告/消息）+关房/取消；params={id}
  lawyerDrafts: { title: 'AI 草稿审查' }, // T6：E1 草稿气泡审查（列表+三动作）；params={room_id}（看板跳转带入，可缺省）
};

export function stackRouteTitle(key: string): string {
  return STACK_ROUTES[key]?.title ?? key;
}
