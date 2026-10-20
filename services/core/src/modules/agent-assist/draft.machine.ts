/**
 * 草稿状态机（E1 §3 status：PENDING|SENT|EDITED_SENT|DISCARDED|EXPIRED；M2-W3 T4）。
 *
 * 「状态字段禁裸写」（架构 §1.3/§4.1）：drafts.status 的全部迁移经 infrastructure/state-machine
 * 守卫迁移并落 state_transition_log（entity_type='draft'）。边表（§4 管线 + R-06 去重 + §5 三动作）：
 *   - PENDING→SENT：律师动作 send（草稿原文经 sendMessage 律师链路发出）；
 *   - PENDING→EDITED_SENT：律师动作 edit_send（编辑稿发出）；
 *   - PENDING→DISCARDED：律师动作 discard；
 *   - PENDING→EXPIRED：R-06 每用户最新去重——同 (room_id,target_user_id) 新问题到达，
 *     旧 PENDING 同事务置 EXPIRED 再建新行（合并语义=「最新问题」胜出）。
 * 后四态均为终态无出边（审查日志不可变，动作不可撤销/重做——重复同动作走幂等返回非状态迁移）。
 */
import { createStateMachine } from '../../infrastructure/state-machine/state-machine';

export type DraftMachineStatus = 'PENDING' | 'SENT' | 'EDITED_SENT' | 'DISCARDED' | 'EXPIRED';

export const DRAFT_MACHINE = createStateMachine<DraftMachineStatus>({
  entityType: 'draft',
  states: ['PENDING', 'SENT', 'EDITED_SENT', 'DISCARDED', 'EXPIRED'],
  transitions: [
    { from: 'PENDING', to: 'SENT' },
    { from: 'PENDING', to: 'EDITED_SENT' },
    { from: 'PENDING', to: 'DISCARDED' },
    { from: 'PENDING', to: 'EXPIRED' },
  ],
});
