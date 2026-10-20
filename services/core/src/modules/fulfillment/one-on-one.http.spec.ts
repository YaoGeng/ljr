import { describe, expect, it } from 'vitest';
import { oneOnOneConfigFromEnv } from './one-on-one.config';
import { AppError, ErrorCode } from '@ljr/shared';
import {
  parseConsumedUnitsField,
  parseDurationSecondsField,
  parseModeField,
  parseOrderIdParam,
  parseOooRole,
  parseRoomIdField,
  parseServiceTypeField,
  parseSettleAmountField,
} from './one-on-one.http';

/**
 * D6 HTTP 面请求形状解析（§5 契约词汇 snake_case 逐字；cancellation.http.spec 同形纯函数件）。
 */
describe('D6 HTTP 解析件（one-on-one.http，纯函数）', () => {
  it('parseOrderIdParam/parseRoomIdField：十进制正整数收口（0/负/浮点/科学计数/字符串形态 400）', () => {
    expect(parseOrderIdParam('42')).toBe(42);
    expect(parseRoomIdField(7)).toBe(7);
    for (const bad of [0, -1, 1.5, '0x10', '1e2', '', null, undefined]) {
      expect(() => parseRoomIdField(bad)).toThrow(AppError);
    }
    expect(() => parseOrderIdParam('abc')).toThrow(
      expect.objectContaining({ code: ErrorCode.InvalidArgument }) as never,
    );
  });

  it('parseServiceTypeField/parseModeField：三值越域 400', () => {
    expect(parseServiceTypeField('deep_answer')).toBe('deep_answer');
    expect(parseServiceTypeField('doc_revision')).toBe('doc_revision');
    expect(parseServiceTypeField('strategy')).toBe('strategy');
    expect(parseModeField('text')).toBe('text');
    expect(parseModeField('voice')).toBe('voice');
    expect(parseModeField('video')).toBe('video');
    for (const bad of ['deep', 'TEXT', 1, null, undefined]) {
      expect(() => parseServiceTypeField(bad)).toThrow(AppError);
      expect(() => parseModeField(bad)).toThrow(AppError);
    }
  });

  it('parseConsumedUnitsField：可选非负整数声明（缺省 undefined——无声明；负/浮点 400）', () => {
    expect(parseConsumedUnitsField(undefined)).toBeUndefined();
    expect(parseConsumedUnitsField(null)).toBeUndefined();
    expect(parseConsumedUnitsField(0)).toBe(0);
    expect(parseConsumedUnitsField(3)).toBe(3);
    for (const bad of [-1, 1.5, '2', NaN]) {
      expect(() => parseConsumedUnitsField(bad)).toThrow(AppError);
    }
  });

  it('parseSettleAmountField：Money 两位小数字符串（整数位/一位小数/number 400）', () => {
    expect(parseSettleAmountField('100.00')).toBe('100.00');
    expect(parseSettleAmountField('0.00')).toBe('0.00');
    for (const bad of ['100', '100.0', 100, '-1.00', '', null]) {
      expect(() => parseSettleAmountField(bad)).toThrow(AppError);
    }
  });

  it('parseOooRole：user|lawyer 双值（cancel 缺省 user；越域 400）', () => {
    expect(parseOooRole('user')).toBe('user');
    expect(parseOooRole('lawyer')).toBe('lawyer');
    expect(parseOooRole(undefined, 'user')).toBe('user');
    expect(parseOooRole(null, 'user')).toBe('user');
    for (const bad of ['platform', 'admin', 1, '']) {
      expect(() => parseOooRole(bad)).toThrow(AppError);
    }
  });

  it('parseDurationSecondsField：非负整数秒（0=开启信标合法；负/浮点 400）', () => {
    expect(parseDurationSecondsField(0)).toBe(0);
    expect(parseDurationSecondsField(1)).toBe(1);
    expect(parseDurationSecondsField(901)).toBe(901);
    for (const bad of [-5, 12.5, '60', null, undefined]) {
      expect(() => parseDurationSecondsField(bad)).toThrow(AppError);
    }
  });
});

describe('D6 配置件（one-on-one.config，纯函数）：I-5b duration 端点环境闸', () => {
  it('durationGate：缺省/dev 开放；staging/prod 关闭；显式 env 键覆盖', () => {
    expect(oneOnOneConfigFromEnv({}).durationCallbackEnabled).toBe(true); // 缺省=dev
    expect(oneOnOneConfigFromEnv({ LJR_ENV: 'dev' }).durationCallbackEnabled).toBe(true);
    expect(oneOnOneConfigFromEnv({ LJR_ENV: 'staging' }).durationCallbackEnabled).toBe(false);
    expect(oneOnOneConfigFromEnv({ LJR_ENV: 'prod' }).durationCallbackEnabled).toBe(false);
    expect(
      oneOnOneConfigFromEnv({ LJR_ENV: 'prod', LJR_FULFILLMENT_OOO_DURATION_CALLBACK: 'true' })
        .durationCallbackEnabled,
    ).toBe(true); // 显式开启（联调位）
    expect(
      oneOnOneConfigFromEnv({ LJR_ENV: 'dev', LJR_FULFILLMENT_OOO_DURATION_CALLBACK: 'false' })
        .durationCallbackEnabled,
    ).toBe(false); // 显式关闭
  });

  it('三时窗缺省=W3-2 口径（30/30/15）；非法值回落默认', () => {
    const c = oneOnOneConfigFromEnv({});
    expect(c.acceptTimeoutMinutes).toBe(30);
    expect(c.settleDefaultMinutes).toBe(30);
    expect(c.diffPayMinutes).toBe(15);
    const bad = oneOnOneConfigFromEnv({ LJR_FULFILLMENT_OOO_ACCEPT_TIMEOUT_MIN: '-3' });
    expect(bad.acceptTimeoutMinutes).toBe(30);
  });
});
