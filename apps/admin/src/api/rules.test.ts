import { beforeEach, describe, expect, it } from 'bun:test';
import { setApiBaseUrl } from './config';
import { AdminApiError, getAccessToken, setAccessToken, __resetClientForTest } from './client';
import { KNOWN_SERVER_CODES, resolveApiErrorCopy } from './error-messages';
import {
  RESERVED_RULE_KEY_PREFIXES,
  RULE_KEY_PATTERN,
  RULE_PUBLISH_STATUS_VALUES,
  RULE_STATUS_LABELS,
  buildCreateDraftBody,
  buildRuleVersionBody,
  createRuleDraft,
  abandonRule,
  latestVersionOf,
  listRules,
  listRuleVersions,
  publishRule,
  type RuleDefinitionView,
} from './rules';

// bun test 同进程串文件：隔离他文件残留的 env 基址与 token（risk.test.ts 同款形态）
beforeEach(() => {
  __resetClientForTest();
  setApiBaseUrl();
  delete process.env.VITE_API_BASE;
});

/** fetch 桩：捕获请求并回放固定响应（risk.test.ts 同款形态） */
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

/** 规则行样本（core rule-center.types.ts RuleDefinitionView 形状；content=不透明 jsonb） */
const RULE_FIXTURE: RuleDefinitionView = {
  id: 12,
  ruleKey: 'price_change',
  version: 3,
  content: { tier_deltas: [-5, -15, -30] },
  effectiveAt: '2026-10-30T08:00:00.000Z',
  publishStatus: 'PUBLISHED',
  publishedAt: '2026-10-23T08:00:00.000Z',
  createdAt: '2026-10-22T06:00:00.000Z',
};

const DRAFT_FIXTURE: RuleDefinitionView = {
  ...RULE_FIXTURE,
  id: 15,
  version: 4,
  effectiveAt: null,
  publishStatus: 'DRAFT',
  publishedAt: null,
};

describe('H7 规则中心 API 层（M3-W3 T5：五端点）', () => {
  it('listRules：缺省=无查询串；rule_key/status/limit 逐字透传 + Bearer 注入 + 数组出参直通（null 时刻如实承载）', async () => {
    setAccessToken('jwt-admin');
    let seen = stubFetch([RULE_FIXTURE, DRAFT_FIXTURE]);
    const plain = await listRules();
    expect(seen[0]?.url).toBe('/admin/rules');
    expect(plain).toHaveLength(2);
    expect(plain[0]?.effectiveAt).not.toBeNull();
    expect(plain[1]?.effectiveAt).toBeNull(); // DRAFT 无公示/生效时刻
    expect(plain[1]?.content.tier_deltas).toEqual([-5, -15, -30]); // jsonb 直通

    seen = stubFetch([]);
    await listRules('price_change', 'DRAFT', 50);
    expect(seen[0]?.url).toBe('/admin/rules?rule_key=price_change&status=DRAFT&limit=50');
    const headers = seen[0]?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer jwt-admin');
  });

  it('listRuleVersions：GET /admin/rules/:key 单键版本视图（key 编码进路径段）', async () => {
    setAccessToken('jwt-admin');
    const seen = stubFetch([RULE_FIXTURE]);
    const res = await listRuleVersions('room_notice');
    expect(seen[0]?.url).toBe('/admin/rules/room_notice');
    expect(res[0]?.ruleKey).toBe('price_change'); // 服务端回包直通不猜
  });

  it('createRuleDraft：POST /admin/rules + snake_case 三键体；created:true/created:false（同键内容全等重放）回包直通', async () => {
    setAccessToken('jwt-admin');
    let seen = stubFetch({ ...DRAFT_FIXTURE, created: true });
    const created = await createRuleDraft({
      rule_key: 'price_change',
      version: 4,
      content: { tier_deltas: [-5, -15, -30] },
    });
    expect(seen[0]?.url).toBe('/admin/rules');
    expect(seen[0]?.init.method).toBe('POST');
    expect(JSON.parse(String(seen[0]?.init.body))).toEqual({
      rule_key: 'price_change',
      version: 4,
      content: { tier_deltas: [-5, -15, -30] },
    });
    expect(created.created).toBe(true);
    expect(created.publishStatus).toBe('DRAFT');

    seen = stubFetch({ ...DRAFT_FIXTURE, created: false });
    const replay = await createRuleDraft({
      rule_key: 'price_change',
      version: 4,
      content: { tier_deltas: [-5, -15, -30] },
    });
    expect(replay.created).toBe(false); // 幂等键=key+version 重放幂等回读
    expect(replay.id).toBe(15);
  });

  it('publishRule：POST :key/publish + {version} 体；deduplicated:false/true 回包直通', async () => {
    setAccessToken('jwt-admin');
    let seen = stubFetch({
      ruleKey: 'price_change',
      version: 4,
      effectiveAt: '2026-10-30T08:00:00.000Z',
      publishedAt: '2026-10-23T08:00:00.000Z',
      deduplicated: false,
    });
    const first = await publishRule('price_change', { version: 4 });
    expect(seen[0]?.url).toBe('/admin/rules/price_change/publish');
    expect(seen[0]?.init.method).toBe('POST');
    expect(JSON.parse(String(seen[0]?.init.body))).toEqual({ version: 4 });
    expect(first.deduplicated).toBe(false);

    seen = stubFetch({
      ruleKey: 'price_change',
      version: 4,
      effectiveAt: '2026-10-30T08:00:00.000Z',
      publishedAt: '2026-10-23T08:00:00.000Z',
      deduplicated: true,
    });
    const replay = await publishRule('price_change', { version: 4 });
    expect(replay.deduplicated).toBe(true); // 已 PUBLISHED 重放幂等短路（回读首次公示时刻）
  });

  it('abandonRule：POST :key/abandon + {version} 体；出参=废弃后 RuleDefinitionView', async () => {
    setAccessToken('jwt-admin');
    const seen = stubFetch({ ...DRAFT_FIXTURE, publishStatus: 'ABANDONED' });
    const res = await abandonRule('price_change', { version: 4 });
    expect(seen[0]?.url).toBe('/admin/rules/price_change/abandon');
    expect(seen[0]?.init.method).toBe('POST');
    expect(JSON.parse(String(seen[0]?.init.body))).toEqual({ version: 4 });
    expect(res.publishStatus).toBe('ABANDONED');
  });

  it('错误归一：409 E_RULE_PUBLISHING（同键内容不等）→ AdminApiError 透传；非 401 不触发登出', async () => {
    setAccessToken('jwt-admin');
    stubFetch({ code: 'E_RULE_PUBLISHING', message: '规则版本已存在：price_change v4' }, 409);
    let caught: unknown;
    try {
      await createRuleDraft({ rule_key: 'price_change', version: 4, content: { other: 1 } });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AdminApiError);
    const apiErr = caught as AdminApiError;
    expect(apiErr.code).toBe('E_RULE_PUBLISHING');
    expect(apiErr.httpStatus).toBe(409);
    expect(apiErr.serverMessage).toContain('price_change');
    expect(getAccessToken()).toBe('jwt-admin'); // 409 非 401：不触发登出拦截
  });

  it('规则域在册错误码全覆盖（rule.http/rule-center 实码抛码 ⊆ KNOWN_SERVER_CODES 且映射表有文案）', () => {
    // parseCreateRuleBody/parseRuleStatus/parseRuleVersionBody/parseRuleKey → 400；
    // wordlist.* 保留前缀 → 400 E_RULE_KEY_RESERVED；同键内容不等 → 409 E_RULE_PUBLISHING；
    // 非 DRAFT 提交公示 → 409 E_RULE_PUBLISHING；非 DRAFT 废弃 → 409 E_STATE_ILLEGAL_TRANSITION；
    // 并发迁移残余 → 409 E_STATE_STALE_ENTITY；草案缺失 → 404；兜底 → 500
    const ruleDomainCodes = [
      'E_INVALID_ARGUMENT',
      'E_RULE_KEY_RESERVED',
      'E_NOT_FOUND',
      'E_RULE_PUBLISHING',
      'E_STATE_ILLEGAL_TRANSITION',
      'E_STATE_STALE_ENTITY',
      'E_INTERNAL',
    ] as const;
    for (const code of ruleDomainCodes) {
      expect(KNOWN_SERVER_CODES.has(code)).toBe(true);
      expect(resolveApiErrorCopy(code)).not.toBe('操作失败，请稍后重试'); // 表内映射命中非兜底
    }
    expect(resolveApiErrorCopy('E_RULE_KEY_RESERVED')).toContain('wordlist');
  });
});

describe('词汇与映射表（单源纪律：对照 core 实码序）', () => {
  it('状态四值与 core RULE_PUBLISH_STATUSES 实码序逐字一致；标签覆盖全集（label+note）', () => {
    expect([...RULE_PUBLISH_STATUS_VALUES]).toEqual([
      'DRAFT',
      'PUBLISHED',
      'EFFECTIVE',
      'ABANDONED',
    ]);
    for (const s of RULE_PUBLISH_STATUS_VALUES) {
      expect(RULE_STATUS_LABELS[s]!.label.length).toBeGreaterThan(0);
      expect(RULE_STATUS_LABELS[s]!.note.length).toBeGreaterThan(0);
    }
  });

  it('rule_key 词法与保留前缀常量对照 core validate.ts 同源（防漂移锚）', () => {
    expect(RULE_KEY_PATTERN.source).toBe('^[A-Za-z0-9_.]{1,32}$');
    expect(RESERVED_RULE_KEY_PREFIXES).toEqual(['wordlist.']);
  });
});

describe('创建草案体构造（对照 parseCreateRuleBody + assertNotReservedRuleKey 实码规则）', () => {
  it('合法体：三键 snake_case；version 数字串收口为正整数；content JSON 文本解析为对象', () => {
    const built = buildCreateDraftBody({
      ruleKey: 'price_change',
      version: '4',
      contentText: '{"tier_deltas":[-5,-15,-30]}',
    });
    expect(built.ok).toBe(true);
    if (built.ok) {
      expect(built.value).toEqual({
        rule_key: 'price_change',
        version: 4,
        content: { tier_deltas: [-5, -15, -30] },
      });
    }
  });

  it('rule_key 词法防呆：空/超 32 位/非法字符拒（core RULE_KEY_PATTERN 同规则）', () => {
    expect(buildCreateDraftBody({ ruleKey: '', version: 1, contentText: '{}' }).ok).toBe(false);
    expect(
      buildCreateDraftBody({ ruleKey: 'a'.repeat(33), version: 1, contentText: '{}' }).ok,
    ).toBe(false);
    expect(buildCreateDraftBody({ ruleKey: '非法 键', version: 1, contentText: '{}' }).ok).toBe(
      false,
    );
    expect(
      buildCreateDraftBody({ ruleKey: 'a'.repeat(32), version: 1, contentText: '{}' }).ok,
    ).toBe(true); // 32 位=上限合法
  });

  it('wordlist.* 保留前缀拒（E_RULE_KEY_RESERVED 前端防呆——服务端同规则 400 兜底）', () => {
    const reserved = buildCreateDraftBody({
      ruleKey: 'wordlist.legal_industry',
      version: 3,
      contentText: '{"words":[]}',
    });
    expect(reserved.ok).toBe(false);
    if (!reserved.ok) expect(reserved.error).toContain('E_RULE_KEY_RESERVED');
  });

  it('version 防呆：0/负数/小数/非数字串拒（core parseCreateRuleBody 同规则）', () => {
    expect(buildCreateDraftBody({ ruleKey: 'credit', version: 0, contentText: '{}' }).ok).toBe(
      false,
    );
    expect(buildCreateDraftBody({ ruleKey: 'credit', version: -1, contentText: '{}' }).ok).toBe(
      false,
    );
    expect(buildCreateDraftBody({ ruleKey: 'credit', version: 1.5, contentText: '{}' }).ok).toBe(
      false,
    );
    expect(buildCreateDraftBody({ ruleKey: 'credit', version: 'x', contentText: '{}' }).ok).toBe(
      false,
    );
    expect(buildCreateDraftBody({ ruleKey: 'credit', version: ' 2 ', contentText: '{}' }).ok).toBe(
      true,
    ); // 数字串 trim 后收口
  });

  it('content 防呆：非 JSON / 数组 / null 拒（core assertContent 同规则——恒为 JSON 对象）', () => {
    expect(buildCreateDraftBody({ ruleKey: 'credit', version: 1, contentText: '{bad' }).ok).toBe(
      false,
    );
    expect(buildCreateDraftBody({ ruleKey: 'credit', version: 1, contentText: '[1,2]' }).ok).toBe(
      false,
    );
    expect(buildCreateDraftBody({ ruleKey: 'credit', version: 1, contentText: 'null' }).ok).toBe(
      false,
    );
    // room_notice 非须知结构不硬拦（noticeRuleKey 为 env 可配——服务端按配置键权威校验）
    const notice = buildCreateDraftBody({
      ruleKey: 'room_notice',
      version: 1,
      contentText: '{"foo":1}',
    });
    expect(notice.ok).toBe(true);
  });
});

describe('发布/废弃体构造与版本建议（parseRuleVersionBody 形状 / 展示建议源）', () => {
  it('buildRuleVersionBody：正整数收口 {version}；0/负/小数/空串拒', () => {
    const ok = buildRuleVersionBody('4');
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.value).toEqual({ version: 4 });
    expect(buildRuleVersionBody(0).ok).toBe(false);
    expect(buildRuleVersionBody(-2).ok).toBe(false);
    expect(buildRuleVersionBody(2.5).ok).toBe(false);
    expect(buildRuleVersionBody('').ok).toBe(false);
  });

  it('latestVersionOf：无行=0；同 key 取最高版本；他 key 不干扰（建议下一版提示源）', () => {
    const rows: readonly RuleDefinitionView[] = [
      RULE_FIXTURE, // price_change v3
      DRAFT_FIXTURE, // price_change v4
      { ...RULE_FIXTURE, id: 20, ruleKey: 'credit', version: 2 },
    ];
    expect(latestVersionOf(rows, 'price_change')).toBe(4);
    expect(latestVersionOf(rows, 'credit')).toBe(2);
    expect(latestVersionOf(rows, 'cancellation')).toBe(0);
    expect(latestVersionOf([], 'price_change')).toBe(0);
  });
});
