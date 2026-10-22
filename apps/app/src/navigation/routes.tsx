/**
 * 路由表（M3-W1 T1）：五 tab 元数据 + 推栈路由登记。
 * tab 屏实现现为占位组件（T2~T4 逐卡替换）；新增推栈页须先在 STACK_ROUTES 登记 key+标题。
 */
import type { ComponentType } from 'react';
import {
  CalendarIcon,
  ChatIcon,
  HomeIcon,
  PublishIcon,
  UserIcon,
  type IconProps,
} from '../components/icons';
import type { TabKey } from './router';

export interface TabRouteDef {
  readonly key: TabKey;
  readonly title: string;
  readonly Icon: ComponentType<IconProps>;
}

/** 五 tab 信息架构（决策：首页/场次/发团/消息/我的） */
export const TAB_ROUTES: readonly TabRouteDef[] = [
  { key: 'home', title: '首页', Icon: HomeIcon },
  { key: 'sessions', title: '场次', Icon: CalendarIcon },
  { key: 'publish', title: '发团', Icon: PublishIcon },
  { key: 'messages', title: '消息', Icon: ChatIcon },
  { key: 'me', title: '我的', Icon: UserIcon },
];

/** 推栈路由登记（push 前 key 必须在此，防散写魔法字符串） */
export const STACK_ROUTES: Readonly<Record<string, { readonly title: string }>> = {
  sessionDetail: { title: '场次详情' },
  enrollmentPlaceholder: { title: '报名' }, // T3 报名支付真流（键沿用 T2 交接，不动）
  realname: { title: '实名认证' }, // A2 实名（402 报名拦截引导落点）
  trainingConsent: { title: '训练数据授权' }, // A2 训练授权独立页
  myEnrollments: { title: '我的报名' }, // T4：GET /enrollments/mine
  myGroupBuys: { title: '我的拼团' }, // T4：发起（公开列表过滤）+ 参与（mine groupbuy 行）
  notificationPrefs: { title: '通知偏好' }, // T4：GET/PUT /notification-prefs
};

export function stackRouteTitle(key: string): string {
  return STACK_ROUTES[key]?.title ?? key;
}
