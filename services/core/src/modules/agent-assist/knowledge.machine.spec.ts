import { describe, expect, it } from 'vitest';
import { AppError, ErrorCode } from '@ljr/shared';
import { KNOWLEDGE_DOC_MACHINE } from './knowledge.machine';

/**
 * E3 knowledge_docs.process_status 状态机（终审 Important-1）：纯件断言（无需 PG）——
 * 「状态字段禁裸写」的机器定义面：合法边集 PENDING→READY / PENDING→FAILED；终态无出边；
 * 任何未声明迁移 assertTransition 拒绝（StateIllegalTransition 409）。DB 侧留痕断言见
 * knowledge.spec.ts（READY/FAILED 各留 STL 行）。
 */
describe('E3 KNOWLEDGE_DOC 状态机（终审 Important-1）', () => {
  it('合法边集：PENDING→READY、PENDING→FAILED 放行；留痕实体名=knowledge_doc', () => {
    expect(KNOWLEDGE_DOC_MACHINE.def.entityType).toBe('knowledge_doc');
    expect([...KNOWLEDGE_DOC_MACHINE.def.states]).toEqual(['PENDING', 'READY', 'FAILED']);
    expect(KNOWLEDGE_DOC_MACHINE.canTransition('PENDING', 'READY')).toBe(true);
    expect(KNOWLEDGE_DOC_MACHINE.canTransition('PENDING', 'FAILED')).toBe(true);
  });

  it('非法迁移被拒：终态无出边/自环 assertTransition 抛 StateIllegalTransition(409)', () => {
    const illegal = [
      ['PENDING', 'PENDING'],
      ['READY', 'READY'],
      ['READY', 'FAILED'],
      ['READY', 'PENDING'],
      ['FAILED', 'READY'],
      ['FAILED', 'FAILED'],
      ['FAILED', 'PENDING'], // requeue 边随 M2 重处理位一并补，当前必须拒绝
    ] as const;
    for (const [from, to] of illegal) {
      expect(() => KNOWLEDGE_DOC_MACHINE.assertTransition(from, to)).toThrowError(AppError);
      try {
        KNOWLEDGE_DOC_MACHINE.assertTransition(from, to);
        expect.unreachable(`应拒绝 ${from} → ${to}`);
      } catch (e) {
        expect((e as AppError).code).toBe(ErrorCode.StateIllegalTransition);
      }
    }
  });
});
