import { beforeEach, describe, expect, it } from 'bun:test';
import { ErrorCode } from '@ljr/shared';
import { isAppApiError, setAccessToken, __resetClientForTest } from './client';
import { setApiBaseUrl } from './config';
import { fetchTrainingConsent, grantTrainingConsent, revokeTrainingConsent } from './consents';
import { jsonResponse, stubFetch } from './test-helpers';

beforeEach(() => {
  __resetClientForTest();
  setApiBaseUrl('http://core.test');
  setAccessToken('jwt-u');
});

describe('A2 训练授权 API（GET/POST/revoke）', () => {
  it('状态查询：GRANTED 附 policy_version/granted_at；ABSENT 仅 status（可选键不落）', async () => {
    stubFetch([
      jsonResponse(200, {
        status: 'GRANTED',
        policy_version: 'v1.0.0',
        granted_at: '2026-10-21T09:00:00.000Z',
      }),
    ]);
    const granted = await fetchTrainingConsent();
    expect(granted.status).toBe('GRANTED');
    expect(granted.policy_version).toBe('v1.0.0');
    stubFetch([jsonResponse(200, { status: 'ABSENT' })]);
    const absent = await fetchTrainingConsent();
    expect(absent.status).toBe('ABSENT');
    expect('policy_version' in absent).toBe(false);
  });

  it('授权：POST {policy_version, accept:true} 逐字（R-02 独立同意语义）', async () => {
    const seen = stubFetch([jsonResponse(201, { status: 'GRANTED' })]);
    const r = await grantTrainingConsent('v1.0.0');
    expect(r.status).toBe('GRANTED');
    const init = seen[0]?.init as RequestInit & { body?: string };
    expect(JSON.parse(String(init.body))).toEqual({ policy_version: 'v1.0.0', accept: true });
  });

  it('撤回：POST revoke（无请求体）→ {status, revoked_at}', async () => {
    const seen = stubFetch([
      jsonResponse(201, { status: 'REVOKED', revoked_at: '2026-10-21T10:00:00.000Z' }),
    ]);
    const r = await revokeTrainingConsent();
    expect(r.status).toBe('REVOKED');
    expect(r.revoked_at).toBe('2026-10-21T10:00:00.000Z');
    const init = seen[0]?.init as RequestInit & { body?: string };
    expect(init.body).toBeUndefined();
  });

  it('409 E_VERSION_MISMATCH → 映射文案（policy_version 版本闸）', async () => {
    stubFetch([jsonResponse(409, { code: ErrorCode.VersionMismatch, message: '版本不一致' })]);
    const err = (await grantTrainingConsent('v0.9.0').then(
      () => null,
      (e: unknown) => e,
    )) as { code: string; message: string };
    expect(isAppApiError(err)).toBe(true);
    expect(err.message).toBe('授权协议版本已更新，请刷新后重试');
  });

  it('本地入参拒绝（空 policy_version）→ CLIENT_BAD_REQUEST 不发请求', async () => {
    const seen = stubFetch([]);
    const err = (await grantTrainingConsent('').then(
      () => null,
      (e: unknown) => e,
    )) as { code: string };
    expect(err.code).toBe('CLIENT_BAD_REQUEST');
    expect(seen).toHaveLength(0);
  });
});
