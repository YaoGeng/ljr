import { describe, expect, it } from 'vitest';
import { AppError } from '@ljr/shared';
import { parseDraftActionBody, parseDraftIdParam, parseDraftListQuery } from './draft.http';

/**
 * E1 HTTP 面请求形状解析（draft.http，纯函数件；one-on-one.http.spec 同形）。
 */
describe('E1 HTTP 解析件（draft.http，纯函数）', () => {
  it('parseDraftIdParam：十进制正整数收口（0/负/浮点/非数字 400）', () => {
    expect(parseDraftIdParam('42')).toBe(42);
    for (const bad of ['0', '-1', '1.5', '0x10', '1e2', 'abc', '']) {
      expect(() => parseDraftIdParam(bad)).toThrow(AppError);
    }
  });

  it('parseDraftActionBody：action 三值收口（§5 逐字）；edited_content 仅 edit_send 可携带且须非空', () => {
    expect(parseDraftActionBody({ action: 'send' })).toEqual({ action: 'send' });
    expect(parseDraftActionBody({ action: 'discard' })).toEqual({ action: 'discard' });
    expect(parseDraftActionBody({ action: 'edit_send', edited_content: '改后稿' })).toEqual({
      action: 'edit_send',
      editedContent: '改后稿',
    });
    for (const bad of [undefined, null, 1, '', 'SEND', 'edit']) {
      expect(() => parseDraftActionBody({ action: bad })).toThrow(AppError);
    }
    // edit_send 缺/空 edited_content=400；send/discard 携带=400（契约窄面）
    expect(() => parseDraftActionBody({ action: 'edit_send' })).toThrow(AppError);
    expect(() => parseDraftActionBody({ action: 'edit_send', edited_content: '' })).toThrow(
      AppError,
    );
    expect(() => parseDraftActionBody({ action: 'send', edited_content: 'x' })).toThrow(AppError);
    expect(() => parseDraftActionBody({ action: 'discard', edited_content: null })).toThrow(
      AppError,
    );
  });

  it('parseDraftListQuery：room_id 正整数/status 五值收口（空串=缺省不过滤）', () => {
    expect(parseDraftListQuery({})).toEqual({});
    expect(parseDraftListQuery({ room_id: '', status: '' })).toEqual({});
    expect(parseDraftListQuery({ room_id: '7', status: 'PENDING' })).toEqual({
      roomId: 7,
      status: 'PENDING',
    });
    for (const bad of ['0', '-2', 'x', '1.5']) {
      expect(() => parseDraftListQuery({ room_id: bad })).toThrow(AppError);
    }
    for (const bad of ['pending', 'BLOCKED', 'OPEN']) {
      expect(() => parseDraftListQuery({ status: bad })).toThrow(AppError);
    }
  });
});
