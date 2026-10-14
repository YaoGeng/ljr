/**
 * 通知状态机（I1 §3 status：QUEUED|SENT|FAILED|SKIPPED(prefs)）。
 *
 * 「状态字段禁裸写」（架构 §1.3/§4.1）：QUEUED 的三条出边全部经 infrastructure/state-machine
 * 守卫迁移并落 state_transition_log；三个终态（SENT/FAILED/SKIPPED）无出边，不可复活。
 * 创建（INSERT status='QUEUED'）非迁移，无需守卫（demo 同口径）。
 */
import { createStateMachine } from '../../infrastructure/state-machine/state-machine';

export type NotificationStatus = 'QUEUED' | 'SENT' | 'FAILED' | 'SKIPPED';

export const NOTIFICATION_MACHINE = createStateMachine<NotificationStatus>({
  entityType: 'notify_notification',
  states: ['QUEUED', 'SENT', 'FAILED', 'SKIPPED'],
  transitions: [
    { from: 'QUEUED', to: 'SENT' },
    { from: 'QUEUED', to: 'FAILED' },
    { from: 'QUEUED', to: 'SKIPPED' },
  ],
});
