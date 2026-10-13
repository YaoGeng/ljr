/**
 * 状态机守卫基座（M0-4 锁定接口）：createStateMachine(def).assertTransition(from, to)。
 *
 * - def 防呆：transitions 只能引用已声明 states；重复迁移声明构造即抛（防复制粘贴事故）。
 * - assertTransition 是纯校验（不碰 DB）：非法迁移抛 AppError(StateIllegalTransition, 409)。
 * - 「非法迁移写 state_transition_log」由 StateTransitionGuardService 组合完成
 *   （留痕需要 DB 执行器，纯工厂无法持有 uow；见 state-transition-guard.service.ts）。
 */
import { AppError, ErrorCode } from '@ljr/shared';

export interface TransitionRule<S extends string> {
  readonly from: S;
  readonly to: S;
}

export interface StateMachineDef<S extends string> {
  /** 留痕用的实体类型名（对应 state_transition_log.entity_type），如 demo_order */
  readonly entityType: string;
  readonly states: readonly S[];
  readonly transitions: readonly TransitionRule<S>[];
}

export interface StateMachine<S extends string> {
  readonly def: StateMachineDef<S>;
  canTransition(from: S, to: S): boolean;
  /** 纯校验：合法放行；非法抛 AppError(StateIllegalTransition, 409) */
  assertTransition(from: S, to: S): void;
}

export function createStateMachine<S extends string>(def: StateMachineDef<S>): StateMachine<S> {
  const states = new Set<string>(def.states);
  if (states.size === 0) {
    throw new AppError(ErrorCode.InvalidArgument, `${def.entityType}: states 不能为空`);
  }
  const allowed = new Set<string>();
  for (const rule of def.transitions) {
    if (!states.has(rule.from) || !states.has(rule.to)) {
      throw new AppError(
        ErrorCode.InvalidArgument,
        `${def.entityType}: 迁移 ${rule.from} → ${rule.to} 引用了未声明状态（states=${[...def.states].join(',')}）`,
      );
    }
    const key = `${rule.from}→${rule.to}`;
    if (allowed.has(key)) {
      throw new AppError(ErrorCode.InvalidArgument, `${def.entityType}: 重复迁移声明 ${key}`);
    }
    allowed.add(key);
  }

  return {
    def,
    canTransition: (from, to) => allowed.has(`${from}→${to}`),
    assertTransition(from, to) {
      if (!allowed.has(`${from}→${to}`)) {
        throw new AppError(
          ErrorCode.StateIllegalTransition,
          `${def.entityType}: 非法状态迁移 ${from} → ${to}（允许：${[...allowed].join(' ')}）`,
        );
      }
    },
  };
}
