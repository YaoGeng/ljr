/**
 * admin 登录页（M3-W3 T1，W3-2，视觉对照 prototype a-login）：手机号（大陆 11 位）+
 * 6 位验证码 → POST /auth/verify 真链；roles 含 admin → 进壳（session 层收口），
 * 不含 → 显式「无后台权限」态（不进壳，可重输——保留已输手机号）。
 *
 * 后台无 SMS 面：不内置任何取码逻辑；dev 提示文案指向 mint-login 夹具（VITE dev 模式
 * 才显示，生产构建不渲染）。表单校验错误内联提示（字段下方），服务端错误走
 * error-messages 单源文案。主按钮=豆沙红（极小面积铁律）。
 */
import { useMemo, useState } from 'react';
import { isAdminApiError } from '../api/client';
import { signIn } from '../api/session';
import { ADMIN_APP_NAME } from '../health';

/** A1 R-W2-12 大陆手机号（core identity.crypto 同口径的客户端镜像） */
const MAINLAND_PHONE = /^1[3-9]\d{9}$/;
const CODE_6 = /^\d{6}$/;

/**
 * dev 取码提示（评审 NIT-2）：提示文案**在分支内**构造——import.meta.env.DEV 构建期被
 * 替换为 false 后整个分支连同夹具路径字串被 DCE 剔除，生产 bundle 不含 dev 词汇
 * （字串留在模块顶层会原样进产物）。
 */
function devHintNode(): React.ReactNode {
  if (import.meta.env.DEV !== true) return null;
  return (
    <div className="tiny muted" style={{ marginTop: 8 }}>
      dev 联调取码：node apps/app/e2e/fixtures/mint-login.mjs &lt;手机号&gt; [6位码]
      --admin（种入验证码 +admin 旗标）；后台无 SMS 下发面。
    </div>
  );
}

type SubmitState =
  | { phase: 'idle' }
  | { phase: 'submitting' }
  | { phase: 'forbidden' }
  | { phase: 'error'; message: string };

export function LoginPage() {
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [submit, setSubmit] = useState<SubmitState>({ phase: 'idle' });
  const [showFieldErrors, setShowFieldErrors] = useState(false);

  const phoneValid = useMemo(() => MAINLAND_PHONE.test(phone), [phone]);
  const codeValid = useMemo(() => CODE_6.test(code), [code]);
  const submitting = submit.phase === 'submitting';

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setShowFieldErrors(true);
    if (!phoneValid || !codeValid) return; // 内联校验先行，不发请求
    setSubmit({ phase: 'submitting' });
    try {
      const result = await signIn(phone, code);
      // ok → session 翻转 authenticated，App 根据此卸载登录页（无本地跳转）
      setSubmit(result.status === 'ok' ? { phase: 'idle' } : { phase: 'forbidden' });
    } catch (err) {
      setSubmit({
        phase: 'error',
        message: isAdminApiError(err) ? err.message : '操作失败，请稍后重试',
      });
    }
  }

  return (
    <div className="login-wrap">
      <div className="login-brand">
        <span className="login-seal">律</span>
        <h1 style={{ fontSize: 22, fontWeight: 700, marginTop: 12 }}>{ADMIN_APP_NAME}</h1>
        <div className="small muted" style={{ marginTop: 4 }}>
          Web Console · 仅限平台运营角色（admin 权限旗标）
        </div>
      </div>

      <form className="glass-card login-card" onSubmit={handleSubmit} noValidate>
        <div className="field">
          <label className="label" htmlFor="admin-phone">
            手机号
          </label>
          <input
            id="admin-phone"
            className={`input${showFieldErrors && !phoneValid ? ' invalid' : ''}`}
            inputMode="numeric"
            autoComplete="username"
            placeholder="大陆 11 位手机号"
            value={phone}
            disabled={submitting}
            onChange={(e) => setPhone(e.target.value.replace(/[^\d]/g, '').slice(0, 11))}
          />
          {showFieldErrors && !phoneValid ? (
            <div className="field-error">请输入大陆 11 位手机号（1[3-9] 开头）</div>
          ) : null}
        </div>

        <div className="field">
          <label className="label" htmlFor="admin-code">
            验证码
          </label>
          <input
            id="admin-code"
            className={`input${showFieldErrors && !codeValid ? ' invalid' : ''}`}
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="6 位验证码"
            value={code}
            disabled={submitting}
            onChange={(e) => setCode(e.target.value.replace(/[^\d]/g, '').slice(0, 6))}
          />
          {showFieldErrors && !codeValid ? (
            <div className="field-error">请输入 6 位数字验证码</div>
          ) : null}
        </div>

        {submit.phase === 'forbidden' ? (
          <div className="error-banner" style={{ marginBottom: 14 }} role="alert">
            <span>
              该账号无后台（admin）权限——已验证手机号但未持有运营权限旗标，可更换账号重试。
            </span>
          </div>
        ) : null}
        {submit.phase === 'error' ? (
          <div className="error-banner" style={{ marginBottom: 14 }} role="alert">
            <span>{submit.message}</span>
          </div>
        ) : null}

        <button
          type="submit"
          className="btn btn-p btn-lg"
          disabled={submitting || !phoneValid || !codeValid}
        >
          {submitting ? '登录中…' : '登录'}
        </button>

        <div className="notice" style={{ marginTop: 12 }}>
          <span>全部后台操作留痕（审计）；登录会话驻留本浏览器，退出即清。</span>
        </div>
        {devHintNode()}
      </form>
    </div>
  );
}
