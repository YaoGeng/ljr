import { describe, expect, it } from 'vitest';
import { ErrorCode } from '@ljr/shared';
import { parseCreditRules } from './credit.rules';
import { RESTRICTION_KINDS } from './credit.types';

/**
 * G1 规则内容解析纯函数单测（credit.rules content jsonb 结构契约的守门层）：
 * 合法内容归一 + 各形态漂移显性化（InternalError——库内配置脏数据宁炸读端不降级，
 * parseNoticeContent 同口径）+ restriction kind 值域 + violation 结构完整性。
 */

const VALID = {
  violation: {
    window_days: 30,
    threshold: 2,
    restriction_by_owner: {
      user: { kind: 'BAN_JOIN', days: 7 },
      lawyer: { kind: 'SUSPEND_TAKE_7D', days: 7 },
    },
  },
  actions: {
    user_absent: { delta: -30, violation: true },
    lawyer_price_down_gt10: { delta: -30, restriction: { kind: 'SUSPEND_TAKE_3D', days: 3 } },
    lawyer_absent: { delta: -50 },
  },
};

describe('G1 credit.rules content 解析（结构契约守门）', () => {
  it('合法内容归一：violation 窗口 + actions 映射（restriction/violation 可选项保留）', () => {
    const parsed = parseCreditRules(VALID, 3);
    expect(parsed.violation).toEqual(VALID.violation);
    expect(parsed.actions['user_absent']).toEqual({ delta: -30, violation: true });
    expect(parsed.actions['lawyer_price_down_gt10']?.restriction).toEqual({
      kind: 'SUSPEND_TAKE_3D',
      days: 3,
    });
    expect(parsed.actions['lawyer_absent']).toEqual({ delta: -50 });
  });

  it('非对象/数组/null content → InternalError；顶层缺 violation/actions → InternalError', () => {
    expect(() => parseCreditRules(null as unknown as Record<string, unknown>, 1)).toThrowError(
      expect.objectContaining({ code: ErrorCode.InternalError }),
    );
    expect(() => parseCreditRules([] as unknown as Record<string, unknown>, 1)).toThrowError(
      expect.objectContaining({ code: ErrorCode.InternalError }),
    );
    expect(() => parseCreditRules({} as Record<string, unknown>, 1)).toThrowError(
      expect.objectContaining({ code: ErrorCode.InternalError }),
    );
    expect(() =>
      parseCreditRules({ actions: VALID.actions } as Record<string, unknown>, 1),
    ).toThrowError(expect.objectContaining({ code: ErrorCode.InternalError }));
  });

  it('violation 结构漂移：window_days/threshold 非正整数、restriction_by_owner 缺 user/lawyer、kind 越域、days 非正整数 → InternalError', () => {
    const broken = (mutate: (v: typeof VALID) => unknown): Record<string, unknown> =>
      mutate(structuredClone(VALID)) as Record<string, unknown>;

    expect(() =>
      parseCreditRules(
        broken((v) => ({ ...v, violation: { ...v.violation, window_days: 0 } })),
        1,
      ),
    ).toThrowError(expect.objectContaining({ code: ErrorCode.InternalError }));
    expect(() =>
      parseCreditRules(
        broken((v) => ({ ...v, violation: { ...v.violation, threshold: 1.5 } })),
        1,
      ),
    ).toThrowError(expect.objectContaining({ code: ErrorCode.InternalError }));
    expect(() =>
      parseCreditRules(
        broken((v) => ({
          ...v,
          violation: {
            ...v.violation,
            restriction_by_owner: { user: v.violation.restriction_by_owner.user },
          },
        })),
        1,
      ),
    ).toThrowError(expect.objectContaining({ code: ErrorCode.InternalError }));
    expect(() =>
      parseCreditRules(
        broken((v) => ({
          ...v,
          violation: {
            ...v.violation,
            restriction_by_owner: {
              user: { kind: 'BAN_EVERYTHING', days: 7 },
              lawyer: v.violation.restriction_by_owner.lawyer,
            },
          },
        })),
        1,
      ),
    ).toThrowError(expect.objectContaining({ code: ErrorCode.InternalError }));
    expect(() =>
      parseCreditRules(
        broken((v) => ({
          ...v,
          violation: {
            ...v.violation,
            restriction_by_owner: {
              user: { kind: 'BAN_JOIN', days: 0 },
              lawyer: v.violation.restriction_by_owner.lawyer,
            },
          },
        })),
        1,
      ),
    ).toThrowError(expect.objectContaining({ code: ErrorCode.InternalError }));
  });

  it('actions 漂移：缺 delta/非整数、restriction kind 越域（值域=RESTRICTION_KINDS 四值）、violation 非布尔 → InternalError', () => {
    expect(() =>
      parseCreditRules(
        { violation: VALID.violation, actions: { user_absent: { violation: true } } } as Record<
          string,
          unknown
        >,
        1,
      ),
    ).toThrowError(expect.objectContaining({ code: ErrorCode.InternalError }));
    expect(() =>
      parseCreditRules(
        { violation: VALID.violation, actions: { user_absent: { delta: -1.5 } } } as Record<
          string,
          unknown
        >,
        1,
      ),
    ).toThrowError(expect.objectContaining({ code: ErrorCode.InternalError }));
    expect(() =>
      parseCreditRules(
        {
          violation: VALID.violation,
          actions: {
            lawyer_absent: { delta: -50, restriction: { kind: 'FIRE', days: 3 } },
          },
        } as Record<string, unknown>,
        1,
      ),
    ).toThrowError(expect.objectContaining({ code: ErrorCode.InternalError }));
    expect(() =>
      parseCreditRules(
        {
          violation: VALID.violation,
          actions: { user_absent: { delta: -30, violation: 'yes' } },
        } as Record<string, unknown>,
        1,
      ),
    ).toThrowError(expect.objectContaining({ code: ErrorCode.InternalError }));
  });

  it('值域常量：RESTRICTION_KINDS 恒为 §3 四值（DB CHECK 同字面守门）', () => {
    expect(RESTRICTION_KINDS).toEqual([
      'BAN_JOIN',
      'BAN_PUBLISH',
      'SUSPEND_TAKE_3D',
      'SUSPEND_TAKE_7D',
    ]);
  });
});
