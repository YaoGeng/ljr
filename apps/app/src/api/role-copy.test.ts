import { describe, expect, it } from 'bun:test';
import { activeRoleCopy, roleCopy } from './role-copy';

describe('角色文案映射表（M3-W2 T1：role 显示经映射表禁散写三元）', () => {
  it('账号角色徽标：user=用户 / lawyer=律师 / admin=管理员', () => {
    expect(roleCopy('user')).toBe('用户');
    expect(roleCopy('lawyer')).toBe('律师');
    expect(roleCopy('admin')).toBe('管理员');
  });

  it('激活角色（当前端别）：user=用户端 / lawyer=律师端', () => {
    expect(activeRoleCopy('user')).toBe('用户端');
    expect(activeRoleCopy('lawyer')).toBe('律师端');
  });

  it('未知角色回退原码（fail-visible：core 新增枚举先行时前端不吞错不撒谎）', () => {
    expect(roleCopy('auditor')).toBe('auditor');
    expect(activeRoleCopy('auditor' as 'user' | 'lawyer')).toBe('auditor');
  });
});
