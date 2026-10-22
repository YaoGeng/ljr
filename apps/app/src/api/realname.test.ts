import { beforeEach, describe, expect, it } from 'bun:test';
import { ErrorCode } from '@ljr/shared';
import { isAppApiError, setAccessToken, __resetClientForTest } from './client';
import { setApiBaseUrl } from './config';
import {
  fetchRealnameStatus,
  isValidIdNo,
  isValidRealnameName,
  normalizeIdNo,
  submitRealname,
} from './realname';
import { jsonResponse, stubFetch } from './test-helpers';

beforeEach(() => {
  __resetClientForTest();
  setApiBaseUrl('http://core.test');
  setAccessToken('jwt-u');
});

describe('A2 实名 API（POST /realname + GET /realname/status）', () => {
  it('提交：id_no x 归一大写 + auth 注入；出参 {status}', async () => {
    const seen = stubFetch([jsonResponse(201, { status: 'VERIFIED' })]);
    const r = await submitRealname({ name: '周链一', id_no: '11010119900101011x' });
    expect(r.status).toBe('VERIFIED');
    const init = seen[0]?.init as RequestInit & { headers: Record<string, string>; body?: string };
    expect(init.headers.Authorization).toBe('Bearer jwt-u');
    const body = JSON.parse(String(init.body)) as Record<string, string>;
    expect(body['id_no']).toBe('11010119900101011X'); // 末位 x → X（core 归一同口径）
  });

  it('状态查询：VERIFIED 附 verified_at；NONE 无附加键', async () => {
    stubFetch([jsonResponse(200, { status: 'VERIFIED', verified_at: '2026-10-21T09:00:00.000Z' })]);
    const verified = await fetchRealnameStatus();
    expect(verified.status).toBe('VERIFIED');
    expect(verified.verified_at).toBe('2026-10-21T09:00:00.000Z');
    stubFetch([jsonResponse(200, { status: 'NONE' })]);
    const none = await fetchRealnameStatus();
    expect(none.status).toBe('NONE');
    expect('verified_at' in none).toBe(false);
  });

  it('400 E_INVALID_ID → 映射文案（服务端形态层拒绝）', async () => {
    stubFetch([jsonResponse(400, { code: ErrorCode.InvalidId, message: '身份证号须为 18 位' })]);
    const err = (await submitRealname({ name: '周链一', id_no: '110101199001010119' }).then(
      () => null,
      (e: unknown) => e,
    )) as { code: string; message: string };
    expect(isAppApiError(err)).toBe(true);
    expect(err.message).toBe('身份证号或姓名格式有误，请检查后重试');
  });

  it('状态越值域 → CLIENT_BAD_RESPONSE（fail-visible 不吞新枚举）', async () => {
    stubFetch([jsonResponse(200, { status: 'SOMETHING' })]);
    const err = (await fetchRealnameStatus().then(
      () => null,
      (e: unknown) => e,
    )) as { code: string };
    expect(err.code).toBe('CLIENT_BAD_RESPONSE');
  });

  it('客户端镜像校验：18 位形态（末位 X/x）合法、17 位拒绝；姓名 trim 后 1..64', () => {
    expect(isValidIdNo('11010119900101011X')).toBe(true);
    expect(isValidIdNo('11010119900101011x')).toBe(true); // 小写 x 归一后合法
    expect(isValidIdNo('1101011990010101X')).toBe(false);
    expect(normalizeIdNo(' 11010119900101011x ')).toBe('11010119900101011X');
    expect(isValidRealnameName('  周链一  ')).toBe(true);
    expect(isValidRealnameName('   ')).toBe(false);
  });
});
