/**
 * 认证面（M3-W3 T1，W3-2）：admin 登录走与 App 端同链的 POST /auth/verify（手机+验证码）。
 *
 * core 契约（identity.controller.ts 实码）：
 *   POST /auth/verify {phone, code, age_declared?} → {access_token, refresh_token, roles}
 *
 * 两个不发送/不存储的口径：
 *   - age_declared 不发送——后台账号=DB 预置号（V31：admin=权限旗标，mint-login --admin
 *     夹具先建用户行），非「新手机号首次登录即注册」链路；
 *   - refresh_token 不存储——后台会话=access token + roles 驻留 localStorage（运营后台
 *     刷新常驻形态），过期即 401 回登录重登（refresh 自愈链路无后台消费面，不发明）。
 */
import { apiFetch } from './client';

/** POST /auth/verify 响应（core AuthController 实码形状） */
interface VerifyResponse {
  readonly access_token: string;
  readonly refresh_token: string;
  readonly roles: readonly string[];
}

export interface AdminLoginResult {
  readonly accessToken: string;
  readonly roles: readonly string[];
}

/** 验证码登录换 token（角色判定在 session 层收口，本函数只搬运契约） */
export async function verifyLogin(phone: string, code: string): Promise<AdminLoginResult> {
  const res = await apiFetch<VerifyResponse>('/auth/verify', {
    method: 'POST',
    body: { phone, code },
  });
  return { accessToken: res.access_token, roles: res.roles };
}
