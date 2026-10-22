import { beforeEach, describe, expect, it } from 'bun:test';
import { ErrorCode } from '@ljr/shared';
import { setApiBaseUrl } from './config';
import { AppClientErrorCode, __resetClientForTest, setAccessToken } from './client';
import {
  fetchPriceHistories,
  fetchPricing,
  fetchPricingHistory,
  ONE_ON_ONE_RANGES,
  putPricing,
  requestPriceChange,
  revokePriceChange,
  validatePricingDraft,
  type PutPricingInput,
} from './pricing';
import { jsonResponse, stubFetch } from './test-helpers';

const CURRENT_VIEW = {
  version: 2,
  created_at: '2026-10-01T02:00:00.000Z',
  pricing: {
    per_head: '99.00',
    session_total: null,
    group_size: 5,
    accept_min: 2,
    accept_max: 6,
    room_modes: ['text', 'voice'],
    one_on_one_prices: {
      text: { per_round: '150.00' },
      voice: { per_15min: '200.00' },
      video: { per_15min: '300.00' },
    },
  },
};

const DRAFT: PutPricingInput = {
  base_version: 2,
  per_head: '109.00',
  session_total: null,
  group_size: 5,
  accept_min: 2,
  accept_max: 6,
  room_modes: ['text', 'voice'],
  one_on_one_prices: {
    text: { per_round: '150.00' },
    voice: { per_15min: '200.00' },
    video: { per_15min: '300.00' },
  },
};

beforeEach(() => {
  __resetClientForTest();
  setApiBaseUrl('http://core.test');
});

describe('GET /lawyer/:id/pricing（B3 当前版本读）', () => {
  it('路径拼 id、公开读无 Bearer；version/pricing 全字段解析', async () => {
    const seen = stubFetch([jsonResponse(200, CURRENT_VIEW)]);
    const view = await fetchPricing(4);
    expect(seen[0]?.url).toBe('http://core.test/lawyer/4/pricing');
    expect(seen[0]?.init.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(view.version).toBe(2);
    expect(view.pricing?.per_head).toBe('99.00');
    expect(view.pricing?.session_total).toBeNull();
    expect(view.pricing?.room_modes).toEqual(['text', 'voice']);
    expect(view.pricing?.one_on_one_prices.text.per_round).toBe('150.00');
  });

  it('无任何版本：{version:0, created_at:null, pricing:null} 合法解析', async () => {
    stubFetch([jsonResponse(200, { version: 0, created_at: null, pricing: null })]);
    const view = await fetchPricing(4);
    expect(view).toEqual({ version: 0, created_at: null, pricing: null });
  });

  it('响应形状非法（缺 one_on_one.voice/room_modes 越域/金额非两位小数）→ CLIENT_BAD_RESPONSE', async () => {
    const bad = (pricing: unknown): void => {
      stubFetch([
        jsonResponse(200, { version: 1, created_at: '2026-10-01T02:00:00.000Z', pricing }),
      ]);
    };
    let err: unknown = null;
    const expectBad = async (): Promise<void> => {
      err = null;
      await fetchPricing(4).catch((e) => {
        err = e;
      });
      expect((err as { code?: string }).code).toBe(AppClientErrorCode.BadResponseBody);
    };

    bad({
      ...CURRENT_VIEW.pricing!,
      one_on_one_prices: { text: { per_round: '150.00' }, video: { per_15min: '300.00' } },
    });
    await expectBad();
    bad({ ...CURRENT_VIEW.pricing!, room_modes: ['chat'] });
    await expectBad();
    bad({ ...CURRENT_VIEW.pricing!, per_head: '99.0' });
    await expectBad();
    bad({ ...CURRENT_VIEW.pricing!, group_size: -1 });
    await expectBad();
  });

  it('非正整数 id → 本地拒绝 CLIENT_BAD_REQUEST（请求未发出）', async () => {
    const seen = stubFetch([jsonResponse(200, CURRENT_VIEW)]);
    let err: unknown = null;
    await fetchPricing(0).catch((e) => {
      err = e;
    });
    expect((err as { code?: string }).code).toBe(AppClientErrorCode.BadRequest);
    expect(seen).toHaveLength(0);
  });
});

describe('PUT /lawyer/pricing（B3 全量新配置）', () => {
  it('Bearer 注入 + 体形状逐键（base_version/二选一/one_on_one_prices 三通道）；出参为新视图', async () => {
    setAccessToken('lawyer-token');
    const seen = stubFetch([jsonResponse(200, { ...CURRENT_VIEW, version: 3 })]);
    const view = await putPricing(DRAFT);
    const headers = seen[0]?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer lawyer-token');
    expect(seen[0]?.url).toBe('http://core.test/lawyer/pricing');
    expect(JSON.parse(String(seen[0]?.init.body))).toEqual(DRAFT);
    expect(view.version).toBe(3);
  });

  it('409 E_IN_GROUP_CHANGE（R-04 在团转 C6）→ shared 码透传 + 映射文案', async () => {
    setAccessToken('lawyer-token');
    stubFetch([
      jsonResponse(409, {
        code: ErrorCode.InGroupChange,
        message: '律师 4 存在进行中拼团，默认价格修改须走改价引擎（C6，R-04）',
      }),
    ]);
    let err: unknown = null;
    await putPricing(DRAFT).catch((e) => {
      err = e;
    });
    expect((err as { code?: string }).code).toBe(ErrorCode.InGroupChange);
    expect((err as { httpStatus?: number }).httpStatus).toBe(409);
    expect((err as Error).message).toBe('有进行中的拼团或场次，默认价格修改须提交改价申请');
  });

  it('409 E_CONFLICT（base_version 过期乐观锁）→ 码透传（时间表同款语义）', async () => {
    setAccessToken('lawyer-token');
    stubFetch([
      jsonResponse(409, { code: ErrorCode.Conflict, message: 'base_version 过期：当前 v3' }),
    ]);
    let err: unknown = null;
    await putPricing(DRAFT).catch((e) => {
      err = e;
    });
    expect((err as { code?: string }).code).toBe(ErrorCode.Conflict);
  });
});

describe('validatePricingDraft（本地前置——core normalizePricingWrite 镜像，不发坏请求）', () => {
  const expectReject = (draft: PutPricingInput): string => {
    try {
      validatePricingDraft(draft);
    } catch (e) {
      return (e as { code: string }).code;
    }
    throw new Error('应当拒绝的草案被放行');
  };

  it('R-01 二选一：双侧空/双侧填均拒；单侧收', () => {
    expect(expectReject({ ...DRAFT, per_head: null, session_total: null })).toBe(
      AppClientErrorCode.BadRequest,
    );
    expect(expectReject({ ...DRAFT, per_head: '99.00', session_total: '650.00' })).toBe(
      AppClientErrorCode.BadRequest,
    );
    validatePricingDraft(DRAFT); // per_head 单侧：不抛
    validatePricingDraft({ ...DRAFT, per_head: null, session_total: '650.00' });
  });

  it('金额形态：一位小数/三位小数/number 形态均拒（Money 禁 float 线格式）', () => {
    expect(expectReject({ ...DRAFT, per_head: '99.0' })).toBe(AppClientErrorCode.BadRequest);
    expect(expectReject({ ...DRAFT, per_head: '99.000' })).toBe(AppClientErrorCode.BadRequest);
    expect(expectReject({ ...DRAFT, per_head: 99 as never })).toBe(AppClientErrorCode.BadRequest);
  });

  it('NUMERIC(10,2) 列宽护栏：整数 9 位拒、8 位收', () => {
    expect(expectReject({ ...DRAFT, per_head: '123456789.00' })).toBe(
      AppClientErrorCode.BadRequest,
    );
    validatePricingDraft({ ...DRAFT, per_head: '12345678.00' });
  });

  it('R-02 区间：text 49.99/300.01 拒、50.00/300.00 收；voice/video 99.99/500.01 拒', () => {
    const ooo = (text: string, voice: string, video: string): PutPricingInput => ({
      ...DRAFT,
      one_on_one_prices: {
        text: { per_round: text },
        voice: { per_15min: voice },
        video: { per_15min: video },
      },
    });
    expect(expectReject(ooo('49.99', '200.00', '300.00'))).toBe(AppClientErrorCode.BadRequest);
    expect(expectReject(ooo('300.01', '200.00', '300.00'))).toBe(AppClientErrorCode.BadRequest);
    expect(expectReject(ooo('150.00', '99.99', '300.00'))).toBe(AppClientErrorCode.BadRequest);
    expect(expectReject(ooo('150.00', '200.00', '500.01'))).toBe(AppClientErrorCode.BadRequest);
    validatePricingDraft(ooo('50.00', '100.00', '500.00'));
  });

  it('可空列护栏：group_size 0 拒；accept 只填一半拒、min>max 拒；room_modes 重复/越域拒', () => {
    expect(expectReject({ ...DRAFT, group_size: 0 })).toBe(AppClientErrorCode.BadRequest);
    expect(expectReject({ ...DRAFT, accept_min: null })).toBe(AppClientErrorCode.BadRequest);
    expect(expectReject({ ...DRAFT, accept_min: 7 })).toBe(AppClientErrorCode.BadRequest);
    expect(expectReject({ ...DRAFT, room_modes: ['text', 'text'] })).toBe(
      AppClientErrorCode.BadRequest,
    );
    expect(expectReject({ ...DRAFT, room_modes: ['chat'] as never })).toBe(
      AppClientErrorCode.BadRequest,
    );
    validatePricingDraft({
      ...DRAFT,
      group_size: null,
      accept_min: null,
      accept_max: null,
      room_modes: null,
    });
  });

  it('ONE_ON_ONE_RANGES 常量与 B3 §2/§3 逐字（文字 50-300 元/次；语音视频 100-500 元/15min）', () => {
    expect(ONE_ON_ONE_RANGES.text.minCents).toBe(5_000);
    expect(ONE_ON_ONE_RANGES.text.maxCents).toBe(30_000);
    expect(ONE_ON_ONE_RANGES.voice.minCents).toBe(10_000);
    expect(ONE_ON_ONE_RANGES.video.maxCents).toBe(50_000);
  });
});

describe('GET /lawyer/:id/pricing/history（B3 版本列表）', () => {
  it('路径拼 id；条目 {version, created_at, pricing}（新在前原样承载）', async () => {
    const seen = stubFetch([
      jsonResponse(200, [
        CURRENT_VIEW,
        { version: 1, created_at: '2026-09-02T02:00:00.000Z', pricing: CURRENT_VIEW.pricing },
      ]),
    ]);
    const rows = await fetchPricingHistory(4);
    expect(seen[0]?.url).toBe('http://core.test/lawyer/4/pricing/history');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.version).toBe(2);
    expect(rows[1]?.version).toBe(1);
  });

  it('响应非数组 → CLIENT_BAD_RESPONSE', async () => {
    stubFetch([jsonResponse(200, { versions: [] })]);
    let err: unknown = null;
    await fetchPricingHistory(4).catch((e) => {
      err = e;
    });
    expect((err as { code?: string }).code).toBe(AppClientErrorCode.BadResponseBody);
  });
});

describe('POST /lawyer/pricing/change（C6 改价申请）', () => {
  it('Bearer + 体 {new_version_draft} 包键；出参 {result, history_id, new_version}', async () => {
    setAccessToken('lawyer-token');
    const seen = stubFetch([
      jsonResponse(200, { result: 'EFFECTED', history_id: 9, new_version: 3 }),
    ]);
    const r = await requestPriceChange(DRAFT);
    const headers = seen[0]?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer lawyer-token');
    expect(seen[0]?.url).toBe('http://core.test/lawyer/pricing/change');
    expect(JSON.parse(String(seen[0]?.init.body))).toEqual({ new_version_draft: DRAFT });
    expect(r).toEqual({ result: 'EFFECTED', history_id: 9, new_version: 3 });
  });

  it('PENDING_APPROVAL 档出参同样解析；本地草案校验先于请求（坏草案不发）', async () => {
    setAccessToken('lawyer-token');
    const seen = stubFetch([
      jsonResponse(200, { result: 'PENDING_APPROVAL', history_id: 10, new_version: 3 }),
    ]);
    const r = await requestPriceChange({ ...DRAFT, per_head: null, session_total: '650.00' });
    expect(r.result).toBe('PENDING_APPROVAL');
    expect(seen).toHaveLength(1);

    let err: unknown = null;
    await requestPriceChange({ ...DRAFT, per_head: null, session_total: null }).catch((e) => {
      err = e;
    });
    expect((err as { code?: string }).code).toBe(AppClientErrorCode.BadRequest);
    expect(seen).toHaveLength(1); // 坏草案未发第二请求
  });

  it('409 E_CONFLICT（无版本基线/草案过期）→ 码透传 + 映射文案', async () => {
    setAccessToken('lawyer-token');
    stubFetch([jsonResponse(409, { code: ErrorCode.Conflict, message: '律师 4 无价格版本' })]);
    let err: unknown = null;
    await requestPriceChange(DRAFT).catch((e) => {
      err = e;
    });
    expect((err as { code?: string }).code).toBe(ErrorCode.Conflict);
    expect((err as Error).message).toBe('操作冲突，请刷新后重试');
  });
});

describe('GET /pricing/histories?lawyer_id=（C6 我的改价记录）', () => {
  const HISTORY_ROW = {
    history_id: 9,
    lawyer_id: 4,
    old_version: 2,
    new_version: 3,
    direction: 'UP',
    change_pct: '10.101',
    has_active_group: true,
    result: 'EFFECTED',
    approval_id: null,
    approval_source: null,
    credit_penalty: -5,
    created_at: '2026-10-01T02:00:00.000Z',
    revoked_at: null,
  };

  it('查询串 lawyer_id=；行全字段解析（含 PENDING/MANUAL 档；credit_penalty 有符号=真库实证 -5 档）', async () => {
    const seen = stubFetch([
      jsonResponse(200, [
        HISTORY_ROW,
        {
          ...HISTORY_ROW,
          history_id: 10,
          direction: 'DOWN',
          change_pct: '12.500',
          result: 'PENDING_APPROVAL',
          credit_penalty: -30,
          revoked_at: '2026-10-02T01:00:00.000Z',
        },
      ]),
    ]);
    const rows = await fetchPriceHistories(4);
    expect(seen[0]?.url).toBe('http://core.test/pricing/histories?lawyer_id=4');
    expect(rows[0]?.direction).toBe('UP');
    expect(rows[0]?.change_pct).toBe('10.101');
    expect(rows[0]?.credit_penalty).toBe(-5);
    expect(rows[1]?.result).toBe('PENDING_APPROVAL');
    expect(rows[1]?.revoked_at).toBe('2026-10-02T01:00:00.000Z');
  });

  it('响应形状非法（result 越三值域/direction 越二值域/change_pct 非十进制文本）→ CLIENT_BAD_RESPONSE', async () => {
    const bad = (row: unknown): void => {
      stubFetch([jsonResponse(200, [row])]);
    };
    const expectBad = async (): Promise<void> => {
      let err: unknown = null;
      await fetchPriceHistories(4).catch((e) => {
        err = e;
      });
      expect((err as { code?: string }).code).toBe(AppClientErrorCode.BadResponseBody);
    };
    bad({ ...HISTORY_ROW, result: 'MAYBE' });
    await expectBad();
    bad({ ...HISTORY_ROW, direction: 'FLAT' });
    await expectBad();
    bad({ ...HISTORY_ROW, change_pct: '10%' });
    await expectBad();
  });
});

describe('POST /pricing/change/:id/revoke（C6 24h 撤销）', () => {
  it('Bearer + 路径拼 id；出参 {history_id, status, restored_version}', async () => {
    setAccessToken('lawyer-token');
    const seen = stubFetch([
      jsonResponse(200, { history_id: 9, status: 'REVOKED', restored_version: 4 }),
    ]);
    const r = await revokePriceChange(9);
    const headers = seen[0]?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer lawyer-token');
    expect(seen[0]?.url).toBe('http://core.test/pricing/change/9/revoke');
    expect(r).toEqual({ history_id: 9, status: 'REVOKED', restored_version: 4 });
  });

  it('409 E_PAST_24H（超 24h 撤销窗）→ 码透传 + 映射文案', async () => {
    setAccessToken('lawyer-token');
    stubFetch([jsonResponse(409, { code: ErrorCode.Past24h, message: '改价已超过 24h 撤销窗口' })]);
    let err: unknown = null;
    await revokePriceChange(9).catch((e) => {
      err = e;
    });
    expect((err as { code?: string }).code).toBe(ErrorCode.Past24h);
    expect((err as Error).message).toBe('改价已超过 24 小时撤销窗口，不可撤销');
  });

  it('非正整数 id → 本地拒绝不发请求', async () => {
    setAccessToken('lawyer-token');
    const seen = stubFetch([jsonResponse(200, {})]);
    let err: unknown = null;
    await revokePriceChange(0).catch((e) => {
      err = e;
    });
    expect((err as { code?: string }).code).toBe(AppClientErrorCode.BadRequest);
    expect(seen).toHaveLength(0);
  });
});
