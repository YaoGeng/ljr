/**
 * 角色文案映射表（M3-W2 T1）：role/activeRole → 用户可读文案，单一事实源
 * （纪律：角色显示经映射表禁散写三元；session-copy.ts 同形）。
 *
 * - 账号角色（/me roles 数组词汇）：user|lawyer|admin（admin=运营后台权限旗标，
 *   App 端仅徽标兜底显示——V31 预置账号口径）；
 * - 激活角色（switch-role 重签的 claims.role）：user|lawyer 双角色同 App（A1 R-02）；
 * - 未知值回退原码（fail-visible：core 新增枚举先行时前端不吞错不撒谎）。
 */
const ROLE_COPY: Readonly<Record<string, string>> = {
  user: '用户',
  lawyer: '律师',
  admin: '管理员',
};

/** 账号角色徽标文案（/me roles 数组成员） */
export function roleCopy(role: string): string {
  return ROLE_COPY[role] ?? role;
}

const ACTIVE_ROLE_COPY: Readonly<Record<string, string>> = {
  user: '用户端',
  lawyer: '律师端',
};

/** 激活角色（当前端别）文案 */
export function activeRoleCopy(role: string): string {
  return ACTIVE_ROLE_COPY[role] ?? role;
}
