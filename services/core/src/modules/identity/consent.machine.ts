/**
 * 同意状态机（A2 §4：ABSENT → GRANTED → REVOKED，可再次 GRANTED=新行）。
 *
 * 「状态字段禁裸写」（架构 §1.3/§4.1）：迁移全部经 infrastructure/state-machine 守卫并落
 * state_transition_log。ABSENT=consents 无行（创建即带状态，行随迁移同事务 INSERT）；
 * entityId=identity.users.id（现行状态=同 user+scope 最新行 status，reason 携带 scope/policy
 * 消歧——STL 是审计留痕不是实体表，scope 多值并存以 reason 区分，见报告迁移矩阵）。
 * 迁移矩阵（§4 原文三边）：
 *   - ABSENT→GRANTED：首次授权（同版本已 GRANTED 走幂等短路，不经守卫）
 *   - GRANTED→REVOKED：撤回（原行原位 UPDATE，R-03 撤回链路起点）
 *   - REVOKED→GRANTED：撤回后再授权（同版本或新版本均=新行，§3 注）
 */
import { createStateMachine } from '../../infrastructure/state-machine/state-machine';

export type ConsentStatus = 'ABSENT' | 'GRANTED' | 'REVOKED';

/** scope 三值（§3 CHECK realname|training|recording；本批写入面仅 training） */
export type ConsentScope = 'realname' | 'training' | 'recording';

export const CONSENT_MACHINE = createStateMachine<ConsentStatus>({
  entityType: 'identity_consent',
  states: ['ABSENT', 'GRANTED', 'REVOKED'],
  transitions: [
    { from: 'ABSENT', to: 'GRANTED' },
    { from: 'GRANTED', to: 'REVOKED' },
    { from: 'REVOKED', to: 'GRANTED' },
  ],
});
