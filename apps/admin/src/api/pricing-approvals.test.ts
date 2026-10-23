import { beforeEach, describe, expect, it } from 'bun:test';
import { setApiBaseUrl } from './config';
import { AdminApiError, getAccessToken, setAccessToken, __resetClientForTest } from './client';
import { KNOWN_SERVER_CODES, resolveApiErrorCopy } from './error-messages';
import {
  PRICE_KIND_LABELS,
  PRICE_RESULT_LABELS,
  approvePriceChange,
  buildApproveBody,
  derivePriceChangeKind,
  listPricingHistories,
  sortHistoriesPendingFirst,
  validateLawyerIdInput,
  type PriceHistoryView,
} from './pricing-approvals';

// bun test 同进程串文件：隔离他文件残留的 env 基址与 token（rules.test.ts 同款形态）
beforeEach(() => {
  __resetClientForTest();
  setApiBaseUrl();
  delete process.env.VITE_API_BASE;
});

/** fetch 桩：捕获请求并回放固定响应（rules.test.ts 同款形态） */
function stubFetch(payload: unknown, status = 200): Array<{ url: string; init: RequestInit }> {
  const seen: Array<{ url: string; init: RequestInit }> = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), init: init ?? ({} as RequestInit) });
    return new Response(JSON.stringify(payload), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  return seen;
}

/** 历史行样本（core pricing/price-change.types.ts PriceHistoryView 形状逐字段——在团
 *  DOWN>10% 待审批行：credit_penalty=-30；approval_id/approval_source 待审恒 null） */
const PENDING_GT10: PriceHistoryView = {
  history_id: 12,
  lawyer_id: 42,
  old_version: 3,
  new_version: 4,
  direction: 'DOWN',
  change_pct: '13.333',
  has_active_group: true,
  result: 'PENDING_APPROVAL',
  approval_id: null,
  approval_source: null,
  credit_penalty: -30,
  created_at: '2026-10-23T06:00:00.000Z',
  revoked_at: null,
};

/** 直效行（在团涨价不经审批即 EFFECTED；approval_source=null） */
const EFFECTED_UP: PriceHistoryView = {
  ...PENDING_GT10,
  history_id: 11,
  old_version: 2,
  new_version: 3,
  direction: 'UP',
  change_pct: '5.000',
  credit_penalty: -5,
  result: 'EFFECTED',
};

/** 人工兜底否决行（approval_source=MANUAL 归源留痕） */
const REJECTED_MANUAL: PriceHistoryView = {
  ...PENDING_GT10,
  history_id: 10,
  change_pct: '8.000',
  credit_penalty: -15,
  result: 'REJECTED',
  approval_id: 205,
  approval_source: 'MANUAL',
};

describe('C6 改价审批台 API 层（M3-W3 T6：histories 直达 + approve 兜底）', () => {
  it('listPricingHistories：GET /pricing/histories?lawyer_id= 必填参数透传 + Bearer 注入 + 数组出参直通（null 审批位如实承载）', async () => {
    setAccessToken('jwt-admin');
    const seen = stubFetch([PENDING_GT10, EFFECTED_UP]);
    const rows = await listPricingHistories(42);
    expect(seen[0]?.url).toBe('/pricing/histories?lawyer_id=42');
    expect(seen[0]?.init.method).toBe('GET'); // client 缺省显式 GET
    const headers = seen[0]?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer jwt-admin'); // 公开面统一走 admin 会话头（T6 口径）
    expect(rows).toHaveLength(2);
    expect(rows[0]?.approval_id).toBeNull();
    expect(rows[0]?.approval_source).toBeNull(); // 待审行无归源
    expect(rows[1]?.approval_source).toBeNull(); // 直效行归源恒 null
    expect(rows[1]?.credit_penalty).toBe(-5);
  });

  it('listPricingHistories 必填防呆：0/负数/小数/NaN 非正整数本地拒（CLIENT_BAD_REQUEST，不发请求）', async () => {
    const seen = stubFetch([]);
    for (const bad of [0, -1, 2.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      let caught: unknown;
      try {
        await listPricingHistories(bad);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(AdminApiError);
      expect((caught as AdminApiError).code).toBe('CLIENT_BAD_REQUEST');
    }
    expect(seen).toHaveLength(0); // 防呆先行：零出站请求
  });

  it('approvePriceChange：POST /pricing/change/:id/approve + {approved, approval_id} 体；出参 {history_id, result, approval_source} 直通', async () => {
    setAccessToken('jwt-admin');
    const seen = stubFetch({ history_id: 12, result: 'EFFECTED', approval_source: 'MANUAL' });
    const res = await approvePriceChange(12, { approved: true, approval_id: 205 });
    expect(seen[0]?.url).toBe('/pricing/change/12/approve');
    expect(seen[0]?.init.method).toBe('POST');
    expect(JSON.parse(String(seen[0]?.init.body))).toEqual({ approved: true, approval_id: 205 });
    const headers = seen[0]?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer jwt-admin'); // approve=admin 角色门
    expect(res.result).toBe('EFFECTED');
    expect(res.approval_source).toBe('MANUAL');
  });

  it('approvePriceChange 幂等重放形态：非 PENDING 重放返回既有终态（REJECTED 不翻案）出参直通', async () => {
    setAccessToken('jwt-admin');
    stubFetch({ history_id: 12, result: 'REJECTED', approval_source: 'MANUAL' });
    const replay = await approvePriceChange(12, { approved: true, approval_id: 999 });
    expect(replay.result).toBe('REJECTED'); // 终态不翻案——调用方按实际回包文案承载
    expect(replay.approval_source).toBe('MANUAL');
  });

  it('approvePriceChange 路径参数防呆：非正整数 historyId 本地拒（不发请求）', async () => {
    const seen = stubFetch({});
    let caught: unknown;
    try {
      await approvePriceChange(0, { approved: true, approval_id: 1 });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AdminApiError);
    expect((caught as AdminApiError).code).toBe('CLIENT_BAD_REQUEST');
    expect(seen).toHaveLength(0);
  });

  it('错误归一：409 E_CONFLICT（版本链漂移审批作废）→ AdminApiError 透传；非 401 不触发登出', async () => {
    setAccessToken('jwt-admin');
    stubFetch(
      { code: 'E_CONFLICT', message: '审批作废：目标版本 v4 的前置链已漂移（当前 v3）' },
      409,
    );
    let caught: unknown;
    try {
      await approvePriceChange(12, { approved: true, approval_id: 205 });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AdminApiError);
    const apiErr = caught as AdminApiError;
    expect(apiErr.code).toBe('E_CONFLICT');
    expect(apiErr.httpStatus).toBe(409);
    expect(apiErr.serverMessage).toContain('审批作废');
    expect(getAccessToken()).toBe('jwt-admin'); // 409 非 401：不触发登出拦截
  });

  it('错误归一：404 E_NOT_FOUND（改价历史不存在）与 409 E_STATE_STALE_ENTITY（并发裁决）透传', async () => {
    setAccessToken('jwt-admin');
    stubFetch({ code: 'E_NOT_FOUND', message: '改价历史不存在：12' }, 404);
    let notFound: unknown;
    try {
      await approvePriceChange(12, { approved: false, approval_id: 1 });
    } catch (err) {
      notFound = err;
    }
    expect((notFound as AdminApiError).code).toBe('E_NOT_FOUND');

    stubFetch({ code: 'E_STATE_STALE_ENTITY', message: '改价历史 12 已被并发裁决' }, 409);
    let stale: unknown;
    try {
      await approvePriceChange(12, { approved: false, approval_id: 1 });
    } catch (err) {
      stale = err;
    }
    expect((stale as AdminApiError).code).toBe('E_STATE_STALE_ENTITY');
    expect((stale as AdminApiError).httpStatus).toBe(409);
  });

  it('改价域在册错误码全覆盖（controller/service/http 实码抛码 ⊆ KNOWN_SERVER_CODES 且映射表有文案）', () => {
    // lawyer_id 缺/空/非法 + approve 体缺字段 → 400 E_INVALID_ARGUMENT；history 不存在 → 404；
    // 版本链漂移 → 409 E_CONFLICT；并发裁决残余 → 409 E_STATE_STALE_ENTITY；守卫非法迁移 →
    // 409 E_STATE_ILLEGAL_TRANSITION；无 admin 旗标 → 403 E_ROLE_FORBIDDEN；兜底 → 500
    const pricingDomainCodes = [
      'E_INVALID_ARGUMENT',
      'E_NOT_FOUND',
      'E_CONFLICT',
      'E_STATE_STALE_ENTITY',
      'E_STATE_ILLEGAL_TRANSITION',
      'E_ROLE_FORBIDDEN',
      'E_INTERNAL',
    ] as const;
    for (const code of pricingDomainCodes) {
      expect(KNOWN_SERVER_CODES.has(code)).toBe(true);
      expect(resolveApiErrorCopy(code)).not.toBe('操作失败，请稍后重试'); // 表内映射命中非兜底
    }
  });
});

describe('result 状态与 kind 三档映射（单源纪律：对照 core 实码 + C6 R-01）', () => {
  it('PRICE_RESULT_LABELS 三态全覆盖（label+note 非空——REJECTED=终态不翻案、撤销以 revoked_at 承载）', () => {
    const states = ['EFFECTED', 'PENDING_APPROVAL', 'REJECTED'] as const;
    for (const s of states) {
      expect(PRICE_RESULT_LABELS[s].label.length).toBeGreaterThan(0);
      expect(PRICE_RESULT_LABELS[s].note.length).toBeGreaterThan(0);
    }
    expect(PRICE_RESULT_LABELS.REJECTED.note).toContain('不生效');
    expect(PRICE_RESULT_LABELS.EFFECTED.note).toContain('revoked_at');
  });

  it('PRICE_KIND_LABELS 三档文案对照 R-01 矩阵（UP -5 / LE10 快照+积分 -15 / GT10 券+-30+停接 3 天）', () => {
    expect(PRICE_KIND_LABELS.PRICE_UP.note).toContain('-5');
    expect(PRICE_KIND_LABELS.PRICE_UP.note).toContain('快照');
    expect(PRICE_KIND_LABELS.PRICE_DOWN_LE10.note).toContain('积分补偿');
    expect(PRICE_KIND_LABELS.PRICE_DOWN_LE10.note).toContain('-15');
    expect(PRICE_KIND_LABELS.PRICE_DOWN_GT10.note).toContain('优惠券');
    expect(PRICE_KIND_LABELS.PRICE_DOWN_GT10.note).toContain('-30');
    expect(PRICE_KIND_LABELS.PRICE_DOWN_GT10.note).toContain('停接 3 天');
  });

  it('derivePriceChangeKind 在团行：按 credit_penalty 权威快照一一映射（-5→UP / -15→LE10 / -30→GT10，与引擎判定同源零漂移）', () => {
    expect(
      derivePriceChangeKind({
        direction: 'UP',
        change_pct: '5.000',
        has_active_group: true,
        credit_penalty: -5,
      }),
    ).toBe('PRICE_UP');
    expect(
      derivePriceChangeKind({
        direction: 'DOWN',
        change_pct: '8.000',
        has_active_group: true,
        credit_penalty: -15,
      }),
    ).toBe('PRICE_DOWN_LE10');
    expect(
      derivePriceChangeKind({
        direction: 'DOWN',
        change_pct: '13.333',
        has_active_group: true,
        credit_penalty: -30,
      }),
    ).toBe('PRICE_DOWN_GT10');
  });

  it('derivePriceChangeKind 评审反例：在团 ¥1999.99→¥1799.99 引擎判 GT10（delta×10=200000>199999）但 change_pct 向下取整 "10.000"——在团走 credit_penalty 不被文本带偏', () => {
    // 引擎：delta=20000 分，delta×10=200000 > old=199999 → GT10（-30+券+停接）；审计文本
    // floor(20000/199999×100000)=10000 → "10.000"（文本回退路径会误推 LE10）
    expect(
      derivePriceChangeKind({
        direction: 'DOWN',
        change_pct: '10.000',
        has_active_group: true,
        credit_penalty: -30,
      }),
    ).toBe('PRICE_DOWN_GT10'); // 权威列 credit_penalty 与档位一致，展示不落漂移
  });

  it('derivePriceChangeKind 不在团回退：credit_penalty 恒 0 无区分度——UP 恒 PRICE_UP；DOWN 文本 ≤10→LE10、>10→GT10（开窗内可漂一档，不落决策文案）', () => {
    expect(
      derivePriceChangeKind({
        direction: 'UP',
        change_pct: '5.000',
        has_active_group: false,
        credit_penalty: 0,
      }),
    ).toBe('PRICE_UP');
    expect(
      derivePriceChangeKind({
        direction: 'UP',
        change_pct: '200.000',
        has_active_group: false,
        credit_penalty: 0,
      }),
    ).toBe('PRICE_UP'); // 超大幅涨幅仍 UP 档
    expect(
      derivePriceChangeKind({
        direction: 'DOWN',
        change_pct: '0.500',
        has_active_group: false,
        credit_penalty: 0,
      }),
    ).toBe('PRICE_DOWN_LE10');
    expect(
      derivePriceChangeKind({
        direction: 'DOWN',
        change_pct: '10.001',
        has_active_group: false,
        credit_penalty: 0,
      }),
    ).toBe('PRICE_DOWN_GT10');
    expect(
      derivePriceChangeKind({
        direction: 'DOWN',
        change_pct: '13.333',
        has_active_group: false,
        credit_penalty: 0,
      }),
    ).toBe('PRICE_DOWN_GT10');
  });

  it('derivePriceChangeKind 防御位：在团 credit_penalty 越值域 / 不在团文本非十进制、负值 → null 不猜档', () => {
    // 在团 0/未知值=表外（engine 在团恒非 0 三值——不应触达）
    expect(
      derivePriceChangeKind({
        direction: 'DOWN',
        change_pct: '8.000',
        has_active_group: true,
        credit_penalty: 0,
      }),
    ).toBeNull();
    expect(
      derivePriceChangeKind({
        direction: 'DOWN',
        change_pct: '8.000',
        has_active_group: true,
        credit_penalty: -20,
      }),
    ).toBeNull();
    // 不在团文本防御（Number('')=0 陷阱已堵词法；DB CHECK 保证非负）
    expect(
      derivePriceChangeKind({
        direction: 'DOWN',
        change_pct: 'abc',
        has_active_group: false,
        credit_penalty: 0,
      }),
    ).toBeNull();
    expect(
      derivePriceChangeKind({
        direction: 'DOWN',
        change_pct: '',
        has_active_group: false,
        credit_penalty: 0,
      }),
    ).toBeNull();
    expect(
      derivePriceChangeKind({
        direction: 'DOWN',
        change_pct: '-1.000',
        has_active_group: false,
        credit_penalty: 0,
      }),
    ).toBeNull();
  });

  it('sortHistoriesPendingFirst：PENDING 置顶且组内保序，其余保持服务端序（id DESC）；全已决原样返回', () => {
    const rows = [EFFECTED_UP, PENDING_GT10, REJECTED_MANUAL] as const;
    const sorted = sortHistoriesPendingFirst(rows);
    expect(sorted.map((r) => r.history_id)).toEqual([12, 11, 10]); // PENDING 12 置顶，余保持 id DESC
    const allDecided = sortHistoriesPendingFirst([EFFECTED_UP, REJECTED_MANUAL]);
    expect(allDecided.map((r) => r.history_id)).toEqual([11, 10]);
    expect(sortHistoriesPendingFirst([])).toEqual([]);
  });
});

describe('lawyer_id 校验与审批载荷构造（parsePositiveInt / parseApproveBody 实码镜像）', () => {
  it('validateLawyerIdInput：纯十进制正整数通过；0/负/小数/科学计数/0x/空格/空串拒', () => {
    const ok = validateLawyerIdInput('42');
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.value).toBe(42);
    expect(validateLawyerIdInput('042').ok).toBe(true); // 前导零仍十进制合法（Number 收口 42）
    expect(validateLawyerIdInput('9007199254740991').ok).toBe(true); // MAX_SAFE_INTEGER 恰上限
    for (const bad of [
      '0',
      '-1',
      '1.5',
      '1e2',
      '0x10',
      ' 42',
      '42 ',
      '',
      'abc',
      '9007199254740993',
    ]) {
      const res = validateLawyerIdInput(bad);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.length).toBeGreaterThan(0);
    }
  });

  it('buildApproveBody：{approved, approval_id} 两键体；数字串收口为正整数（parseApproveBody 同规则）', () => {
    const ok = buildApproveBody({ approved: false, approvalId: '205' });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.value).toEqual({ approved: false, approval_id: 205 });
    const num = buildApproveBody({ approved: true, approvalId: 205 });
    expect(num.ok).toBe(true);
    if (num.ok) expect(num.value).toEqual({ approved: true, approval_id: 205 });
    const padded = buildApproveBody({ approved: true, approvalId: ' 12 ' });
    expect(padded.ok).toBe(true); // trim 后收口
  });

  it('buildApproveBody 防呆：approval_id 空串/0/负/小数/非十进制形态拒（①期=处置凭据 id 必填）', () => {
    for (const bad of ['', '0', '-3', '2.5', '1e2', '0x10', 'abc', '12a']) {
      const res = buildApproveBody({ approved: true, approvalId: bad });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toContain('approval_id');
    }
  });
});
