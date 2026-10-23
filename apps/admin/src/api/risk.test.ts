import { beforeEach, describe, expect, it } from 'bun:test';
import { setApiBaseUrl } from './config';
import { AdminApiError, getAccessToken, setAccessToken, __resetClientForTest } from './client';
import { KNOWN_SERVER_CODES, resolveApiErrorCopy } from './error-messages';
import {
  DICT_TYPE_LABELS,
  DICT_TYPE_VALUES,
  REVIEW_VERDICT_LABELS,
  REVIEW_VERDICT_VALUES,
  WORD_ACTION_LABELS,
  WORD_ACTION_VALUES,
  buildPutDictionaryBody,
  buildReviewBody,
  diffWordEntries,
  listDictionaries,
  listRiskQueue,
  normalizeWord,
  parseWordHits,
  putDictionary,
  reviewRiskRecord,
  type DictionaryView,
  type LexiconWordEntry as LexiconWordEntryLike,
  type RiskQueueItem,
} from './risk';

// bun test 同进程串文件：隔离他文件残留的 env 基址与 token（tickets.test.ts 同款形态）
beforeEach(() => {
  __resetClientForTest();
  setApiBaseUrl();
  delete process.env.VITE_API_BASE;
});

/** fetch 桩：捕获请求并回放固定响应（tickets.test.ts 同款形态） */
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

/** 队列行样本（core ops/risk-review.types.ts RiskQueueItem 形状；word_hits=V8 三键形态） */
const QUEUE_FIXTURE: RiskQueueItem = {
  id: 31,
  message_id: null,
  conversation_id: 990041,
  dict_type: 'legal_industry',
  word_hits: [{ word: '加微信返全款', action: 'REVIEW', rule_version: 2 }],
  action: 'REVIEW',
  created_at: '2026-10-23T02:00:00.000Z',
};

const DICT_FIXTURE: readonly DictionaryView[] = [
  {
    dictType: 'legal_industry',
    ruleKey: 'wordlist.legal_industry',
    version: 2,
    effectiveAt: '2026-10-20T08:00:00.000Z',
    words: [
      { word: '包赢', action: 'BLOCK' },
      { word: '加微信返全款', action: 'REVIEW' },
    ],
  },
  {
    dictType: 'illegal_content',
    ruleKey: 'wordlist.illegal_content',
    version: 0,
    effectiveAt: null,
    words: [],
  },
];

describe('H5 风控 API 层（M3-W3 T4：queue/review + dictionaries GET/PUT 四端点）', () => {
  it('listRiskQueue：缺省=无查询串；dict_type/action/limit/offset 逐字透传 + Bearer 注入 + items 出参直通', async () => {
    setAccessToken('jwt-admin');
    let seen = stubFetch({ items: [QUEUE_FIXTURE] });
    const plain = await listRiskQueue();
    expect(seen[0]?.url).toBe('/admin/risk/queue');
    expect(plain.items[0]?.word_hits[0]?.['rule_version']).toBe(2); // jsonb 直通
    expect(plain.items[0]?.message_id).toBeNull(); // null 如实承载（V1 无消息锚点）

    seen = stubFetch({ items: [] });
    await listRiskQueue('legal_industry', 'REVIEW', 50, 100);
    expect(seen[0]?.url).toBe(
      '/admin/risk/queue?dict_type=legal_industry&action=REVIEW&limit=50&offset=100',
    );
    const headers = seen[0]?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer jwt-admin');
  });

  it('reviewRiskRecord：POST /admin/risk/records/:id/review；{verdict} 最小体 + note 合法才发键', async () => {
    setAccessToken('jwt-admin');
    let seen = stubFetch({
      record_id: 31,
      verdict: 'CONFIRM_BLOCK',
      reviewed_by: 137,
      reviewed_at: '2026-10-23T08:00:00.000Z',
    });
    const res = await reviewRiskRecord(31, { verdict: 'CONFIRM_BLOCK' });
    expect(seen[0]?.url).toBe('/admin/risk/records/31/review');
    expect(seen[0]?.init.method).toBe('POST');
    expect(JSON.parse(String(seen[0]?.init.body))).toEqual({ verdict: 'CONFIRM_BLOCK' });
    expect(res.record_id).toBe(31);
    expect(res.reviewed_by).toBe(137);

    seen = stubFetch({
      record_id: 31,
      verdict: 'FALSE_POSITIVE',
      reviewed_by: 137,
      reviewed_at: '2026-10-23T08:00:00.000Z',
    });
    await reviewRiskRecord(31, { verdict: 'FALSE_POSITIVE', note: '命中词误拦' });
    expect(JSON.parse(String(seen[0]?.init.body))).toEqual({
      verdict: 'FALSE_POSITIVE',
      note: '命中词误拦',
    });
  });

  it('listDictionaries：缺省=无查询串（双库视图）；dict_type 过滤透传；无版本库 version=0/effectiveAt=null 直通', async () => {
    setAccessToken('jwt-admin');
    let seen = stubFetch(DICT_FIXTURE);
    const res = await listDictionaries();
    expect(seen[0]?.url).toBe('/admin/risk/dictionaries');
    expect(res).toHaveLength(2);
    expect(res[1]?.version).toBe(0);
    expect(res[1]?.effectiveAt).toBeNull();
    expect(res[0]?.words[0]?.word).toBe('包赢');

    seen = stubFetch([DICT_FIXTURE[0]!]);
    await listDictionaries('legal_industry');
    expect(seen[0]?.url).toBe('/admin/risk/dictionaries?dict_type=legal_industry');
  });

  it('putDictionary：PUT 端点 + snake_case 三键体；created:false 幂等重放回包直通', async () => {
    setAccessToken('jwt-admin');
    let seen = stubFetch({
      dictType: 'legal_industry',
      ruleKey: 'wordlist.legal_industry',
      version: 3,
      effectiveAt: '2026-10-23T08:00:00.000Z',
      wordCount: 3,
      created: true,
    });
    const created = await putDictionary({
      dict_type: 'legal_industry',
      base_version: 2,
      words: [{ word: '包赢', action: 'BLOCK' }],
    });
    expect(seen[0]?.url).toBe('/admin/risk/dictionaries');
    expect(seen[0]?.init.method).toBe('PUT');
    expect(JSON.parse(String(seen[0]?.init.body))).toEqual({
      dict_type: 'legal_industry',
      base_version: 2,
      words: [{ word: '包赢', action: 'BLOCK' }],
    });
    expect(created.created).toBe(true);
    expect(created.version).toBe(3);

    seen = stubFetch({
      dictType: 'legal_industry',
      ruleKey: 'wordlist.legal_industry',
      version: 3,
      effectiveAt: '2026-10-23T08:00:00.000Z',
      wordCount: 3,
      created: false,
    });
    const replay = await putDictionary({
      dict_type: 'legal_industry',
      base_version: 2,
      words: [{ word: '包赢', action: 'BLOCK' }],
    });
    expect(replay.created).toBe(false); // 同 dict+base_version 内容全等幂等回读
    expect(replay.version).toBe(3);
  });

  it('错误归一：409 E_CONFLICT（DONE 已处置）→ AdminApiError 透传；非 401 不触发登出', async () => {
    setAccessToken('jwt-admin');
    stubFetch(
      {
        code: 'E_CONFLICT',
        message: '风险记录已处置（DONE）：31 于 2026-10-23T08:00:00Z 处置完毕，不可再处置',
      },
      409,
    );
    let caught: unknown;
    try {
      await reviewRiskRecord(31, { verdict: 'CONFIRM_BLOCK' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AdminApiError);
    const apiErr = caught as AdminApiError;
    expect(apiErr.code).toBe('E_CONFLICT');
    expect(apiErr.httpStatus).toBe(409);
    expect(apiErr.serverMessage).toContain('DONE');
    expect(getAccessToken()).toBe('jwt-admin'); // 409 非 401：不触发登出拦截
  });

  it('风控域在册错误码全覆盖（risk-review/word-dict 实码抛码 ⊆ KNOWN_SERVER_CODES 且映射表有文案）', () => {
    // parseQueueQuery/parseReviewBody/parsePutDictionaryBody/normalizeWordEntries → 400；
    // E_DUP_WORD=词库重复词；review 已处置 → 409 E_CONFLICT；记录缺失 → 404；
    // base_version 过期 → 409 E_CONFLICT；并发残余竞态 → 409 E_RULE_PUBLISHING；兜底 → 500
    const riskDomainCodes = [
      'E_INVALID_ARGUMENT',
      'E_NOT_FOUND',
      'E_CONFLICT',
      'E_DUP_WORD',
      'E_RULE_PUBLISHING',
      'E_INTERNAL',
    ] as const;
    for (const code of riskDomainCodes) {
      expect(KNOWN_SERVER_CODES.has(code)).toBe(true);
      expect(resolveApiErrorCopy(code)).not.toBe('操作失败，请稍后重试'); // 表内映射命中非兜底
    }
    expect(resolveApiErrorCopy('E_DUP_WORD')).toContain('重复词');
  });
});

describe('词汇与映射表（单源纪律：对照 core 实码序）', () => {
  it('dict_type 两值/action 三值/verdict 三值词汇与 core 实码序逐字一致；标签覆盖全集', () => {
    expect([...DICT_TYPE_VALUES]).toEqual(['illegal_content', 'legal_industry']);
    expect([...WORD_ACTION_VALUES]).toEqual(['BLOCK', 'REVIEW', 'MARK']);
    expect([...REVIEW_VERDICT_VALUES]).toEqual(['CONFIRM_BLOCK', 'FALSE_POSITIVE', 'MARK_ONLY']);
    expect(DICT_TYPE_LABELS.illegal_content).toBe('违法信息类型');
    expect(DICT_TYPE_LABELS.legal_industry).toBe('行业违规话术');
    for (const a of WORD_ACTION_VALUES) {
      expect(WORD_ACTION_LABELS[a].length).toBeGreaterThan(0);
    }
    for (const v of REVIEW_VERDICT_VALUES) {
      expect(REVIEW_VERDICT_LABELS[v]!.label.length).toBeGreaterThan(0);
      expect(REVIEW_VERDICT_LABELS[v]!.note.length).toBeGreaterThan(0);
    }
  });

  it('verdict 危险位：仅 CONFIRM_BLOCK（对照原型「拦截」红位——二段确认门载体）', () => {
    expect(REVIEW_VERDICT_LABELS.CONFIRM_BLOCK!.danger).toBe(true);
    expect(REVIEW_VERDICT_LABELS.FALSE_POSITIVE!.danger).toBe(false);
    expect(REVIEW_VERDICT_LABELS.MARK_ONLY!.danger).toBe(false);
  });

  it('word_hits 防御性解析：三键直通；rule_version 非数值置 null；word 非字符串 JSON 化', () => {
    const hits = parseWordHits([
      { word: '加微信返全款', action: 'REVIEW', rule_version: 2 },
      { word: '脏行', rule_version: 'x' },
      { word: 42, action: 'REVIEW' },
    ]);
    expect(hits[0]).toEqual({ word: '加微信返全款', action: 'REVIEW', rule_version: 2 });
    expect(hits[1]?.rule_version).toBeNull();
    expect(hits[2]?.word).toBe('42');
  });

  it('normalizeWord：trim+小写规范形（core word-dict.validate.ts 同式——本地查重同口径）', () => {
    expect(normalizeWord('  包赢  ')).toBe('包赢');
    expect(normalizeWord('WeChat')).toBe('wechat');
  });
});

describe('词库提交体构造（对照 parsePutDictionaryBody + normalizeWordEntries 实码规则）', () => {
  const BASE = {
    dictType: 'legal_industry',
    baseVersion: 2,
    words: [
      { word: '包赢', action: 'BLOCK' },
      { word: '加微信返全款', action: 'REVIEW' },
    ],
  };

  it('合法体：三键 snake_case；词统一规范形并按 word 升序（集合语义——core 存储形态）', () => {
    const built = buildPutDictionaryBody({
      ...BASE,
      words: [
        { word: ' 加微信返全款 ', action: 'REVIEW' }, // 规范形前后空白剥除
        { word: '包赢', action: 'BLOCK' },
      ],
    });
    expect(built.ok).toBe(true);
    if (built.ok) {
      expect(built.value).toEqual({
        dict_type: 'legal_industry',
        base_version: 2,
        words: [
          { word: '加微信返全款', action: 'REVIEW' },
          { word: '包赢', action: 'BLOCK' },
        ],
      });
    }
  });

  it('空词集合法（=清空词库的版本）；首版 base_version=0 合法', () => {
    const empty = buildPutDictionaryBody({
      dictType: 'illegal_content',
      baseVersion: 0,
      words: [],
    });
    expect(empty.ok).toBe(true);
    if (empty.ok) {
      expect(empty.value.base_version).toBe(0);
      expect(empty.value.words).toEqual([]);
    }
  });

  it('E_DUP_WORD 本地防呆：规范形重复拒（大小写不敏感，与服务端 400 同规则）', () => {
    const dup = buildPutDictionaryBody({
      ...BASE,
      words: [
        { word: '包赢', action: 'BLOCK' },
        { word: '包赢', action: 'REVIEW' },
      ],
    });
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.error).toContain('E_DUP_WORD');

    const caseDup = buildPutDictionaryBody({
      ...BASE,
      words: [
        { word: 'Win', action: 'BLOCK' },
        { word: 'win ', action: 'MARK' },
      ],
    });
    expect(caseDup.ok).toBe(false); // trim+小写后同词
  });

  it('词条边界：空/超 64 拒、action 表外拒、dict_type 表外拒、base_version 负/非整数拒', () => {
    expect(buildPutDictionaryBody({ ...BASE, words: [{ word: '  ', action: 'BLOCK' }] }).ok).toBe(
      false,
    );
    expect(
      buildPutDictionaryBody({ ...BASE, words: [{ word: 'a'.repeat(65), action: 'BLOCK' }] }).ok,
    ).toBe(false);
    expect(
      buildPutDictionaryBody({ ...BASE, words: [{ word: 'a'.repeat(64), action: 'BLOCK' }] }).ok,
    ).toBe(true);
    expect(buildPutDictionaryBody({ ...BASE, words: [{ word: '词', action: 'HOLD' }] }).ok).toBe(
      false,
    );
    expect(buildPutDictionaryBody({ ...BASE, dictType: 'unknown' }).ok).toBe(false);
    expect(buildPutDictionaryBody({ ...BASE, baseVersion: -1 }).ok).toBe(false);
    expect(buildPutDictionaryBody({ ...BASE, baseVersion: 1.5 }).ok).toBe(false);
  });
});

describe('处置体构造与词集 diff（对照 parseReviewBody 实码 / 词库集合语义）', () => {
  it('buildReviewBody：verdict 三值；note 空白=不发键；超 500 拒不静默截断', () => {
    const min = buildReviewBody('MARK_ONLY', '');
    expect(min.ok).toBe(true);
    if (min.ok) expect(min.value).toEqual({ verdict: 'MARK_ONLY' });

    const withNote = buildReviewBody('FALSE_POSITIVE', ' 命中词误拦 ');
    expect(withNote.ok).toBe(true);
    if (withNote.ok) expect(withNote.value.note).toBe('命中词误拦');

    expect(buildReviewBody('APPROVE', '').ok).toBe(false); // 表外 verdict 拒
    expect(buildReviewBody('MARK_ONLY', 'x'.repeat(501)).ok).toBe(false);
    expect(buildReviewBody('MARK_ONLY', 'x'.repeat(500)).ok).toBe(true);
  });

  it('diffWordEntries：按 {word,action} 全等对比——新增/移除各自成列，无变化双空', () => {
    const oldWords: readonly LexiconWordEntryLike[] = [
      { word: '包赢', action: 'BLOCK' },
      { word: '加微信', action: 'REVIEW' },
    ];
    const newWords: readonly LexiconWordEntryLike[] = [
      { word: '加微信', action: 'REVIEW' },
      { word: '私下收款', action: 'MARK' },
    ];
    const diff = diffWordEntries(oldWords, newWords);
    expect(diff.added).toEqual([{ word: '私下收款', action: 'MARK' }]);
    expect(diff.removed).toEqual([{ word: '包赢', action: 'BLOCK' }]);

    const same = diffWordEntries(oldWords, oldWords);
    expect(same.added).toEqual([]);
    expect(same.removed).toEqual([]);
  });

  it('diffWordEntries：action 变更词条计入新增+移除两列（词条替换——PUT canonical 不等=新建版本非重放；评审 IMPORTANT-1 防回归）', () => {
    const oldWords: readonly LexiconWordEntryLike[] = [
      { word: '包赢', action: 'BLOCK' },
      { word: '加微信', action: 'REVIEW' },
    ];
    // UI 可达路径：移除词条 → 换处置级重新添加（同词 action 变更）
    const newWords: readonly LexiconWordEntryLike[] = [
      { word: '包赢', action: 'MARK' }, // action 变更（BLOCK→MARK）
      { word: '加微信', action: 'REVIEW' }, // 不变
    ];
    const diff = diffWordEntries(oldWords, newWords);
    expect(diff.added).toEqual([{ word: '包赢', action: 'MARK' }]);
    expect(diff.removed).toEqual([{ word: '包赢', action: 'BLOCK' }]);
    // 双空=真无变化（含 action 全等）——面板「无词集变化（重放）」文案仅在此时出现
    const untouched = diffWordEntries(oldWords, [
      { word: '加微信', action: 'REVIEW' },
      { word: '包赢', action: 'BLOCK' },
    ]);
    expect(untouched.added).toEqual([]);
    expect(untouched.removed).toEqual([]);
  });
});
