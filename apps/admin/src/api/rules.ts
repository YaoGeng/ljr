/**
 * H7 规则中心数据面（M3-W3 T5）：/admin/rules 五端点（创建草案 / 管理列表 / 单键版本视图 /
 * 提交公示 / 废弃草案）。
 *
 * 出入参类型为 services/core 实码契约副本（admin 不依赖 core/shared 包——T1 口径，消费侧
 * 出参类型上移 @ljr/shared=独立卡）：每类型头注标注来源文件，core 改口径时本文件随之同步。
 * 词汇纪律：status 四值 / rule_key 词法 / 请求体键名逐字对照 core 实码，禁发明字段
 * （RuleDefinitionView.content 为不透明 jsonb 对象——如实 JSON 展示，不猜结构）。
 *
 * 幂等与 409 口径（H7 §5 + core 实码）：
 *   - 创建草案幂等键=key+version：同键内容全等重放 → created:false 幂等回读既有行；内容不等 →
 *     409 E_RULE_PUBLISHING（横幅+刷新承载）；
 *   - 提交公示幂等=PUBLISHED 行重放 → deduplicated:true（不重发事件/不重注册 job，回读首次
 *     公示时刻）；非 DRAFT 非 PUBLISHED → 409 E_RULE_PUBLISHING；
 *   - 废弃草案非 DRAFT → 409 E_STATE_ILLEGAL_TRANSITION（守卫拒绝）；并发迁移残余 →
 *     409 E_STATE_STALE_ENTITY；
 *   - wordlist.* 保留前缀（H5 词库专用通道）→ 400 E_RULE_KEY_RESERVED（本卡扩入映射表，
 *     前端防呆+服务端兜底双层）。
 */
import { apiFetch } from './client';

// ---------------------------------------------------------------------------
// 契约类型副本（对照来源逐字段抄，禁发明）
// ---------------------------------------------------------------------------

/** 规则发布状态（core ops/rule-center.types.ts RulePublishStatus 实码；§9 未公示直接
 *  EFFECTIVE 无状态机边——守卫必然拒绝；ABANDONED=草案废弃终态（留痕优于删行） */
export type RulePublishStatus = 'DRAFT' | 'PUBLISHED' | 'EFFECTIVE' | 'ABANDONED';

/** 全量状态集（core rule-center.types.ts RULE_PUBLISH_STATUSES 实码序；status 筛选合法值） */
export const RULE_PUBLISH_STATUS_VALUES: readonly RulePublishStatus[] = [
  'DRAFT',
  'PUBLISHED',
  'EFFECTIVE',
  'ABANDONED',
];

/** 规则行视图（core rule-center.types.ts RuleDefinitionView；core=Date，HTTP JSON 序列化后
 *  =ISO 串——本副本按线上形态收窄 string；content=不透明 jsonb 对象） */
export interface RuleDefinitionView {
  readonly id: number;
  readonly ruleKey: string;
  readonly version: number;
  readonly content: Record<string, unknown>;
  /** 生效时刻：PUBLISHED=published_at+公示期承诺时刻；DRAFT/ABANDONED=null */
  readonly effectiveAt: string | null;
  readonly publishStatus: RulePublishStatus;
  /** 提交公示时刻；DRAFT/ABANDONED=null */
  readonly publishedAt: string | null;
  readonly createdAt: string;
}

/** POST /admin/rules 出参（core rule-center.types.ts CreateDraftResult；created=false=同
 *  key+version 内容全等重放幂等回读既有行——§5 幂等键语义） */
export interface CreateDraftResult extends RuleDefinitionView {
  readonly created: boolean;
}

/** 提交公示出参（core rule-center.types.ts SubmitPublicationResult；时刻同上 JSON 形态；
 *  deduplicated=true=已 PUBLISHED 重放幂等短路：不重发事件/不重注册 job，回读首次公示时刻） */
export interface SubmitPublicationResult {
  readonly ruleKey: string;
  readonly version: number;
  /** 公示期满承诺时刻（=published_at+公示期，缺省 7 日；App「即将生效」展示与快照锚点） */
  readonly effectiveAt: string;
  readonly publishedAt: string;
  readonly deduplicated: boolean;
}

/** POST /admin/rules 请求体（core rule.http.ts parseCreateRuleBody 形状；键 snake_case） */
export interface CreateRuleBody {
  readonly rule_key: string;
  readonly version: number;
  readonly content: Record<string, unknown>;
}

/** POST /admin/rules/:key/publish|abandon 请求体（core rule.http.ts parseRuleVersionBody 形状） */
export interface RuleVersionBody {
  readonly version: number;
}

// ---------------------------------------------------------------------------
// 词法常量（core rule-center.validate.ts 同源：rule_key 词法与保留前缀——前端防呆层）
// ---------------------------------------------------------------------------

/** rule_key 词法（core RULE_KEY_PATTERN 同式：1-32 位字母/数字/下划线/点；DB varchar(32)） */
export const RULE_KEY_PATTERN = /^[A-Za-z0-9_.]{1,32}$/;

/** 保留前缀（core RESERVED_RULE_KEY_PREFIXES 同源：wordlist.*=H5 词库专用通道，通用管理面
 *  拒绝——E_RULE_KEY_RESERVED 前端防呆；前缀集随新专用通道扩充时本表随之同步） */
export const RESERVED_RULE_KEY_PREFIXES: readonly string[] = ['wordlist.'];

// ---------------------------------------------------------------------------
// 展示映射表（文案单源，禁组件散写三元）
// ---------------------------------------------------------------------------

/** 状态 → 中文（core 值域语义：DRAFT 草案 / PUBLISHED 公示中（§2 变更流，公示期满自动
 *  EFFECTIVE）/ EFFECTIVE 已生效（行为时快照命中态）/ ABANDONED 草案废弃终态（留痕）；
 *  note=时间线/列表共用的流转标注文案源） */
export const RULE_STATUS_LABELS: Readonly<
  Record<RulePublishStatus, { label: string; note: string }>
> = {
  DRAFT: {
    label: '草案',
    note: '草案（编辑中）——可提交公示或废弃',
  },
  PUBLISHED: {
    label: '公示中',
    note: '公示中——公示期满（缺省 7 日）自动生效为行为时快照版本',
  },
  EFFECTIVE: {
    label: '已生效',
    note: '已生效——行为时快照按 effective_at 命中本版本（现行版）',
  },
  ABANDONED: {
    label: '已废弃',
    note: '已废弃（终态留痕不删行——变更历史可查，电商法 §34）',
  },
};

// ---------------------------------------------------------------------------
// 纯函数（表单防呆 + 请求体构造，bun test 直测；规则逐字对照 core 校验实码双层）
// ---------------------------------------------------------------------------

/** 构造结果：ok=false 附防呆提示（与服务端校验同规则——前端防呆+服务端兜底双层） */
export type BuildResult<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

/**
 * 创建草案请求体构造（对照 core rule.http.ts parseCreateRuleBody + rule-center.validate.ts
 * assertRuleKey/assertNotReservedRuleKey/assertVersion/assertContent 规则）：rule_key 1-32 位
 * 字母/数字/下划线/点且非 wordlist.* 保留前缀；version 正整数；content 须为 JSON 对象
 * （非数组/null——表单以 JSON 文本录入，解析失败即拒）。room_notice 键的须知结构
 * （{title, paragraphs, disclosures}，R-02）由服务端按配置键校验权威——本层不做硬拦
 * （noticeRuleKey 为 env 可配，前端硬拦会与服务端配置漂移），以提示文案引导。
 */
export function buildCreateDraftBody(input: {
  readonly ruleKey: string;
  readonly version: string | number;
  readonly contentText: string;
}): BuildResult<CreateRuleBody> {
  if (!RULE_KEY_PATTERN.test(input.ruleKey)) {
    return {
      ok: false,
      error: 'rule_key 须为 1-32 位字母/数字/下划线/点',
    };
  }
  if (RESERVED_RULE_KEY_PREFIXES.some((p) => input.ruleKey.startsWith(p))) {
    return {
      ok: false,
      error: 'rule_key 前缀 wordlist. 保留（词库须经 H5 词库管理面写入）——E_RULE_KEY_RESERVED',
    };
  }
  const version = typeof input.version === 'number' ? input.version : Number(input.version.trim());
  if (!Number.isInteger(version) || version <= 0) {
    return { ok: false, error: 'version 必须为正整数' };
  }
  let content: unknown;
  try {
    content = JSON.parse(input.contentText);
  } catch {
    return { ok: false, error: 'content 须为合法 JSON（且为对象，非数组/null）' };
  }
  if (typeof content !== 'object' || content === null || Array.isArray(content)) {
    return { ok: false, error: 'content 须为 JSON 对象（非数组/null）' };
  }
  // JSON.parse 出参 object 已排除 null/数组——收窄即 Record<string, unknown>（core assertContent 同语义）
  return {
    ok: true,
    value: { rule_key: input.ruleKey, version, content: content as Record<string, unknown> },
  };
}

/**
 * publish/abandon 请求体构造（对照 core rule.http.ts parseRuleVersionBody：version 正整数；
 * 行内版本号本已是 number——本函数承载「字符串输入→正整数」的表单防呆与出参形状收口）。
 */
export function buildRuleVersionBody(version: string | number): BuildResult<RuleVersionBody> {
  const n = typeof version === 'number' ? version : Number(version.trim());
  if (!Number.isInteger(n) || n <= 0) {
    return { ok: false, error: 'version 必须为正整数' };
  }
  return { ok: true, value: { version: n } };
}

/** 当前数据内该 key 的最高版本号（无行=0）——创建草案表单的「建议下一版 vN+1」提示源
 *  （纯展示建议，非契约：version 由运营显式填写，幂等键=key+version） */
export function latestVersionOf(rows: readonly RuleDefinitionView[], ruleKey: string): number {
  let max = 0;
  for (const r of rows) {
    if (r.ruleKey === ruleKey && r.version > max) max = r.version;
  }
  return max;
}

// ---------------------------------------------------------------------------
// API 函数（全部受保护面：auth + 401 统一拦截）
// ---------------------------------------------------------------------------

/**
 * GET /admin/rules?rule_key=&status=&limit=：管理列表（服务端 ORDER BY rule_key, version
 * DESC——同一 key 多版本行并列）。status 合法值=DRAFT|PUBLISHED|EFFECTIVE|ABANDONED（表外值
 * 400）；limit 缺省 100 封顶 500。
 */
export async function listRules(
  ruleKey?: string,
  status?: RulePublishStatus,
  limit?: number,
): Promise<readonly RuleDefinitionView[]> {
  const params = new URLSearchParams();
  if (ruleKey !== undefined && ruleKey !== '') params.set('rule_key', ruleKey);
  if (status !== undefined) params.set('status', status);
  if (limit !== undefined) params.set('limit', String(limit));
  const qs = params.toString();
  return apiFetch<readonly RuleDefinitionView[]>(`/admin/rules${qs === '' ? '' : `?${qs}`}`, {
    auth: true,
  });
}

/** GET /admin/rules/:key：单键版本列表（version DESC 时间线；key 词法非法 400；无行=空数组） */
export async function listRuleVersions(key: string): Promise<readonly RuleDefinitionView[]> {
  return apiFetch<readonly RuleDefinitionView[]>(`/admin/rules/${encodeURIComponent(key)}`, {
    auth: true,
  });
}

/**
 * POST /admin/rules：创建草案（幂等键=key+version）。重放（同键内容全等）→ created:false
 * 幂等回读既有行；内容不等 → 409 E_RULE_PUBLISHING；wordlist.* → 400 E_RULE_KEY_RESERVED。
 */
export async function createRuleDraft(body: CreateRuleBody): Promise<CreateDraftResult> {
  return apiFetch<CreateDraftResult>('/admin/rules', { method: 'POST', auth: true, body });
}

/**
 * POST /admin/rules/:key/publish：提交公示（DRAFT→PUBLISHED，published_at/effective_at 落值
 * +RULE_EFFECTIVE job+RulePublished 出箱同事务）。重放（已 PUBLISHED）→ deduplicated:true；
 * 非 DRAFT/PUBLISHED → 409 E_RULE_PUBLISHING。
 */
export async function publishRule(
  key: string,
  body: RuleVersionBody,
): Promise<SubmitPublicationResult> {
  return apiFetch<SubmitPublicationResult>(`/admin/rules/${encodeURIComponent(key)}/publish`, {
    method: 'POST',
    auth: true,
    body,
  });
}

/**
 * POST /admin/rules/:key/abandon：废弃草案（DRAFT→ABANDONED 终态留痕）。非 DRAFT →
 * 409 E_STATE_ILLEGAL_TRANSITION（PUBLISHED 不可废弃只能被新版本取代；EFFECTIVE/ABANDONED
 * 为终态）；行缺失 → 404。
 */
export async function abandonRule(key: string, body: RuleVersionBody): Promise<RuleDefinitionView> {
  return apiFetch<RuleDefinitionView>(`/admin/rules/${encodeURIComponent(key)}/abandon`, {
    method: 'POST',
    auth: true,
    body,
  });
}
