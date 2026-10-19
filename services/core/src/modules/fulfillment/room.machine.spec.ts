import { describe, expect, it } from 'vitest';
import { ROOM_MACHINE, ROOM_TERMINAL_STATUSES } from './room.machine';
import type { RoomStatus } from './room.types';

/**
 * D1 房间状态机（§4 迁移矩阵 + M2-W1 T1 简报 + M2-W2 T3 D4 增量）：
 *   OPEN→IN_SERVICE→CLOSED 主链（IN_SERVICE 生产者=D3/W2，本批只声明迁移不接线）；
 *   OPEN→CANCELLED（开房失败行以 CANCELLED 直插=初始态承载，非本机边——platform 取消分支）；
 *   OPEN→CLOSED（close API：律师/任务端结束关闭；§5 409 NOT_OPEN 仅当已终态——OPEN/IN_SERVICE
 *   皆为合法关闭源态）；
 *   IN_SERVICE→CANCELLED（M2-W2 T3 D4：迟到取消的进行中房间终止边——走退款轨道禁双轨）；
 *   CANCELLED/CLOSED 终态无出边。
 * 全部迁移经 StateTransitionGuard+STL（entity_type='room'）——本件钉机器定义，守卫留痕归
 * DB spec（room.spec）。
 */
describe('D1 房间状态机（§4 迁移矩阵，纯机器件）', () => {
  it('states=四态全集（§4 逐字），终态集=CLOSED/CANCELLED', () => {
    expect(ROOM_MACHINE.def.states).toEqual(['OPEN', 'IN_SERVICE', 'CLOSED', 'CANCELLED']);
    expect(ROOM_MACHINE.def.entityType).toBe('room');
    expect([...ROOM_TERMINAL_STATUSES]).toEqual(['CLOSED', 'CANCELLED']);
  });

  it('声明迁移恰 5 条：OPEN 三出边 + IN_SERVICE→CLOSED + IN_SERVICE→CANCELLED（D4 迟到取消）', () => {
    const edges = ROOM_MACHINE.def.transitions.map((t) => `${t.from}→${t.to}`);
    expect(edges).toEqual([
      'OPEN→IN_SERVICE',
      'OPEN→CLOSED',
      'OPEN→CANCELLED',
      'IN_SERVICE→CLOSED',
      'IN_SERVICE→CANCELLED',
    ]);
  });

  it('全迁移矩阵：5 条声明边放行，其余 4×4 全组合（含自环与终态出边）一律拒绝', () => {
    const states = ROOM_MACHINE.def.states;
    const expected = new Set<string>([
      'OPEN→IN_SERVICE',
      'OPEN→CLOSED',
      'OPEN→CANCELLED',
      'IN_SERVICE→CLOSED',
      'IN_SERVICE→CANCELLED',
    ]);
    for (const from of states as readonly RoomStatus[]) {
      for (const to of states as readonly RoomStatus[]) {
        const key = `${from}→${to}`;
        if (expected.has(key)) {
          expect(ROOM_MACHINE.canTransition(from, to)).toBe(true);
          expect(() => ROOM_MACHINE.assertTransition(from, to)).not.toThrow();
        } else {
          expect(ROOM_MACHINE.canTransition(from, to)).toBe(false);
          expect(() => ROOM_MACHINE.assertTransition(from, to)).toThrow('非法状态迁移');
        }
      }
    }
  });

  it('终态（CLOSED/CANCELLED）无出边——重复 close/取消后房间不再迁移', () => {
    for (const terminal of ROOM_TERMINAL_STATUSES) {
      for (const to of ROOM_MACHINE.def.states) {
        expect(ROOM_MACHINE.canTransition(terminal, to)).toBe(false);
      }
    }
  });
});
