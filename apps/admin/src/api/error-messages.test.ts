import { describe, expect, it } from 'bun:test';
import { KNOWN_SERVER_CODES, resolveApiErrorCopy } from './error-messages';

describe('admin 错误码→文案单源映射（M3-W3 T1 起册；T2 扩 409 状态冲突面、T4 扩风控域 E_DUP_WORD/E_RULE_PUBLISHING）', () => {
  it('登录面与鉴权门高频码走映射表', () => {
    expect(resolveApiErrorCopy('E_CODE_INVALID')).toBe('验证码无效或已过期，请重新输入');
    expect(resolveApiErrorCopy('E_UNAUTHORIZED')).toBe('登录已失效，请重新登录');
    expect(resolveApiErrorCopy('E_ROLE_FORBIDDEN')).toBe('该操作要求运营（admin）权限');
    expect(resolveApiErrorCopy('CLIENT_NETWORK')).toBe('网络连接失败，请检查网络后重试');
  });

  it('H1 审核状态冲突码（409 STATE）入册且文案指向刷新动作', () => {
    // @ljr/shared error-codes.ts：两码 httpStatus=409（守卫拒绝/并发迁移）——工作台冲突横幅载体
    expect(KNOWN_SERVER_CODES.has('E_STATE_ILLEGAL_TRANSITION')).toBe(true);
    expect(KNOWN_SERVER_CODES.has('E_STATE_STALE_ENTITY')).toBe(true);
    expect(resolveApiErrorCopy('E_STATE_ILLEGAL_TRANSITION')).toContain('请刷新列表后重试');
    expect(resolveApiErrorCopy('E_STATE_STALE_ENTITY')).toContain('请刷新列表后重试');
    // 404 未审/未知（档案抽屉错误态承载）
    expect(resolveApiErrorCopy('E_NOT_FOUND')).toBe('请求的内容不存在');
  });

  it('表外码回退服务端 message → 通用兜底（不吞错不撒谎）', () => {
    expect(resolveApiErrorCopy('E_NEW_CODE', '服务端原文')).toBe('服务端原文');
    expect(resolveApiErrorCopy('E_NEW_CODE')).toBe('操作失败，请稍后重试');
    // 表内码不回退服务端 message（映射优先——文案口径单源）
    expect(resolveApiErrorCopy('E_CODE_INVALID', '服务端原文')).toBe(
      '验证码无效或已过期，请重新输入',
    );
  });
});
