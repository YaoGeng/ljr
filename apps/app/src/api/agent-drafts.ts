/**
 * E1 Agent 草稿气泡审查 API（M3-W2 T6）：律师端草稿列表 + 三动作（契约消费——core
 * draft.controller/draft.types 实文逐字段，§5 逐字键名；W2-2 决策：气泡数据面=HTTP，
 * WSS lawyer/drafts 推送帧不依赖）：
 *   GET  /agent/drafts?room_id=&status=   → AgentDraftView[]（Bearer+lawyer；listDrafts
 *                                         per-room 归属门 fail-closed——非该房参与方 403
 *                                         E_ROLE_FORBIDDEN；id 倒序上限 200；status 缺省=
 *                                         不过滤全态，PENDING 置顶由前端 sortAgentDrafts
 *                                         承载）
 *   POST /drafts/:id/action               → {draft_id, status, deduplicated}（§5 逐字
 *                                         {action: send|edit_send|discard, edited_content?}；
 *                                         409 EXPIRED=非 PENDING 且无同动作留痕；幂等键=
 *                                         draft+action——同动作重放 deduplicated=true 零副作用）
 *   GET  /agent/health                    → 复用 lawyer-stats.ts fetchAgentHealth（T2 先例，
 *                                         不重复封装）
 *
 * edited_content 前置校验镜像 core parseDraftActionBody（draft.http 实文）：仅 edit_send
 * 可携带且须非空字符串（send/discard 携带=core 400——前端同口径 CLIENT_BAD_REQUEST）。
 *
 * 合规面（E1 §3/§7，UI 消费纪律）：
 *   - placeholders（占位符→原文映射）仅律师端还原显示（restorePlaceholders）——禁入任何
 *     上行载荷；本模块上行面只有 action 体（无草稿原文/占位符映射字段）；
 *   - content 含「【AI 辅助，仅供参考】」标记（R-04）——展示层原样渲染禁剥离（不设清洗）。
 *
 * fail-visible：出参形状（行字段/五态枚举/segment_ms 四键）本层校验，非法即
 * CLIENT_BAD_RESPONSE；入参本地前置校验镜像 core 值域（parse-positive-int/五态白名单）。
 * 本模块保持平台无关（无 react-native import），bun test 直接可测。
 */
import { AppClientErrorCode, apiFetch, AppApiError } from './client';

// ---------------------------------------------------------------------------
// §3/§5 契约类型（core draft.types.ts 逐字段；snake_case 逐字）
// ---------------------------------------------------------------------------

/** 草稿状态词汇（V48 ck 五值；E1 §3——PENDING 待审 / 三动作终态 / EXPIRED 去重置换终态） */
export type AgentDraftStatus = 'PENDING' | 'SENT' | 'EDITED_SENT' | 'DISCARDED' | 'EXPIRED';

/** 五态白名单（运行时校验用——本地前置校验镜像 core isDraftStatus） */
export const AGENT_DRAFT_STATUSES: readonly AgentDraftStatus[] = [
  'PENDING',
  'SENT',
  'EDITED_SENT',
  'DISCARDED',
  'EXPIRED',
];

function isAgentDraftStatus(v: string): v is AgentDraftStatus {
  return (AGENT_DRAFT_STATUSES as readonly string[]).includes(v);
}

/** 律师三动作（§5 POST /drafts/{id}/action） */
export type AgentDraftAction = 'send' | 'edit_send' | 'discard';

/** 各段打点（§8 预算口径四键；毫秒整数 ≥0） */
export interface AgentDraftSegmentMs {
  readonly sanitize: number;
  readonly intent: number;
  readonly rag: number;
  readonly llm: number;
}

/**
 * 占位符→原文映射（仅律师端还原显示专用——R-02）。**映射对象本身禁入上行载荷**（本模块
 * 上行面只有 action 体，无 placeholders 字段）；还原后的文本仅在律师显式选择 edit_send 时
 * 作为 edited_content 上行（评审修复环 I-1 口径：数据最小化由编辑器注记承载，非类型面禁绝）。
 */
export type AgentDraftPlaceholders = Readonly<Record<string, string>>;

/** GET /agent/drafts 行（DraftView 实文十三键逐字段——评审修复环 I-4 校正） */
export interface AgentDraftView {
  readonly draft_id: number;
  readonly room_id: number;
  readonly conversation_id: number;
  readonly target_user_id: number;
  /** 脱敏后问题摘要（占位符形态——原文禁入，R-02） */
  readonly question_digest: string;
  /** 草稿正文（含「【AI 辅助，仅供参考】」标记——R-04，展示原样禁剥离） */
  readonly content: string;
  readonly placeholders: AgentDraftPlaceholders;
  readonly status: AgentDraftStatus;
  /** 待办标记（E2；M2 后置位写面——读面如实承载） */
  readonly answered: boolean;
  readonly latency_ms: number | null;
  readonly segment_ms: AgentDraftSegmentMs | null;
  readonly created_at: string;
  readonly replied_at: string | null;
}

/** POST /drafts/:id/action 出参（幂等回执面三键：终态回显 + deduplicated 重放标识） */
export interface AgentDraftActionResult {
  readonly draft_id: number;
  readonly status: AgentDraftStatus;
  /** true=UNIQUE(draft_id,action) 幂等命中（同动作重放零副作用零新事件） */
  readonly deduplicated: boolean;
}

/** GET /agent/drafts 入参（两键均可选——缺省=全态全房间，core parseDraftListQuery 口径） */
export interface FetchAgentDraftsInput {
  readonly room_id?: number;
  readonly status?: AgentDraftStatus;
}

// ---------------------------------------------------------------------------
// 文案映射表（单源；未知值回退原码——fail-visible 不吞不编）
// ---------------------------------------------------------------------------

/** 草稿五态文案（E1 §2 三动作态 + EXPIRED 语义=R-06 同用户新问题置换） */
export const AGENT_DRAFT_STATUS_COPY: Readonly<Record<AgentDraftStatus, string>> = {
  PENDING: '待审查',
  SENT: '已发送',
  EDITED_SENT: '修改后发送',
  DISCARDED: '已丢弃',
  EXPIRED: '已失效',
};

export function agentDraftStatusCopy(status: string): string {
  return AGENT_DRAFT_STATUS_COPY[status as AgentDraftStatus] ?? status;
}

// ---------------------------------------------------------------------------
// 形状校验（fail-visible）
// ---------------------------------------------------------------------------

function badShape(detail: string): AppApiError {
  return new AppApiError({
    code: AppClientErrorCode.BadResponseBody,
    copy: '服务响应异常，请稍后重试',
    serverMessage: `草稿响应形状非法：${detail}`,
  });
}

function localReject(detail: string, copy = '请求参数有误，请返回重试'): AppApiError {
  return new AppApiError({
    code: AppClientErrorCode.BadRequest,
    copy,
    serverMessage: detail,
  });
}

function isPosInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0;
}

function isNonNegInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

function isIsoString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && !Number.isNaN(Date.parse(v));
}

/** 正整数字段读取（索引访问收窄不生效——显式读取收型，lawyer-stats readInt 同形） */
function readPosInt(r: Record<string, unknown>, key: string): number {
  const v = r[key];
  if (!isPosInt(v) || !Number.isSafeInteger(v)) throw badShape(`${key} 非正整数`);
  return v;
}

function parseAgentDraftView(raw: unknown): AgentDraftView {
  if (typeof raw !== 'object' || raw === null) throw badShape('草稿行非对象');
  const r = raw as Record<string, unknown>;
  const ids = {
    draft_id: readPosInt(r, 'draft_id'),
    room_id: readPosInt(r, 'room_id'),
    conversation_id: readPosInt(r, 'conversation_id'),
    target_user_id: readPosInt(r, 'target_user_id'),
  };
  if (typeof r['question_digest'] !== 'string') throw badShape('question_digest 非字符串');
  if (typeof r['content'] !== 'string') throw badShape('content 非字符串');
  // placeholders：占位符→原文映射（core toPlaceholders 恒出对象；值域=string→string）
  const rawPlaceholders = r['placeholders'];
  if (
    typeof rawPlaceholders !== 'object' ||
    rawPlaceholders === null ||
    Array.isArray(rawPlaceholders)
  ) {
    throw badShape('placeholders 非对象');
  }
  const placeholders: Record<string, string> = {};
  for (const [token, value] of Object.entries(rawPlaceholders)) {
    if (typeof value !== 'string') throw badShape(`placeholders['${token}'] 值非字符串`);
    placeholders[token] = value;
  }
  // status：五值域从严（V48 ck 闭集；筛选 chip/动作门控/徽标三分支判别值——fail-visible）
  if (typeof r['status'] !== 'string' || !isAgentDraftStatus(r['status'])) {
    throw badShape(`status 越五值域：${JSON.stringify(r['status'])}`);
  }
  if (typeof r['answered'] !== 'boolean') throw badShape('answered 非布尔');
  const latency = r['latency_ms'];
  if (latency !== null && !isNonNegInt(latency)) throw badShape('latency_ms 非非负整数或 null');
  // segment_ms：null 或四键齐（§8 分段打点闭集——core toSegmentMs 恒出四键）
  let segmentMs: AgentDraftSegmentMs | null = null;
  if (r['segment_ms'] !== null) {
    const seg = r['segment_ms'];
    if (typeof seg !== 'object' || seg === null) throw badShape('segment_ms 非对象或 null');
    const s = seg as Record<string, unknown>;
    const readSeg = (key: string): number => {
      const v = s[key];
      if (!isNonNegInt(v)) throw badShape(`segment_ms.${key} 非非负整数`);
      return v;
    };
    segmentMs = {
      sanitize: readSeg('sanitize'),
      intent: readSeg('intent'),
      rag: readSeg('rag'),
      llm: readSeg('llm'),
    };
  }
  if (!isIsoString(r['created_at'])) throw badShape('created_at 非时刻');
  const repliedAt = r['replied_at'];
  if (repliedAt !== null && !isIsoString(repliedAt)) throw badShape('replied_at 非时刻或 null');
  return {
    ...ids,
    question_digest: r['question_digest'],
    content: r['content'],
    placeholders,
    status: r['status'],
    answered: r['answered'],
    latency_ms: latency,
    segment_ms: segmentMs,
    created_at: r['created_at'],
    replied_at: repliedAt === null ? null : (repliedAt as string),
  };
}

function parseActionResult(raw: unknown): AgentDraftActionResult {
  if (typeof raw !== 'object' || raw === null) throw badShape('动作响应非对象');
  const r = raw as Record<string, unknown>;
  const draftId = readPosInt(r, 'draft_id');
  // 判别值从严（动作出参分支语义靠 status 裁决——parseSessionCancelResult 同款口径）
  if (typeof r['status'] !== 'string' || !isAgentDraftStatus(r['status'])) {
    throw badShape(`status 越五值域：${JSON.stringify(r['status'])}`);
  }
  if (typeof r['deduplicated'] !== 'boolean') throw badShape('deduplicated 非布尔');
  return { draft_id: draftId, status: r['status'], deduplicated: r['deduplicated'] };
}

// ---------------------------------------------------------------------------
// API 封装（snake_case 逐字；错误经 error-messages 单源映射）
// ---------------------------------------------------------------------------

/** GET /agent/drafts?room_id=&status=：律师端草稿列表（Bearer；403=非房间参与方） */
export async function fetchAgentDrafts(
  input: FetchAgentDraftsInput = {},
): Promise<AgentDraftView[]> {
  const params = new URLSearchParams();
  if (input.room_id !== undefined) {
    if (!isPosInt(input.room_id) || !Number.isSafeInteger(input.room_id)) {
      throw localReject(`room_id 须为正整数：${String(input.room_id)}`);
    }
    params.set('room_id', String(input.room_id));
  }
  if (input.status !== undefined) {
    if (!isAgentDraftStatus(input.status)) {
      throw localReject(`status 须为五值域之一，收到：${String(input.status)}`);
    }
    params.set('status', input.status);
  }
  const qs = params.toString();
  const raw = await apiFetch<unknown>(`/agent/drafts${qs.length > 0 ? `?${qs}` : ''}`, {
    auth: true,
  });
  if (!Array.isArray(raw)) throw badShape('草稿响应非数组');
  return raw.map(parseAgentDraftView);
}

/**
 * POST /drafts/:id/action：律师三动作（send=直接发送 / edit_send=修改后发送 / discard=丢弃）。
 * editedContent 仅 edit_send 可携带且须非空（core parseDraftActionBody 400 前置同口径——
 * send/discard 携带即本地拒发）；409 EXPIRED/403 成员门经 AppApiError 透传（视图层承载）。
 */
export async function sendDraftAction(
  draftId: number,
  action: AgentDraftAction,
  editedContent?: string,
): Promise<AgentDraftActionResult> {
  if (!isPosInt(draftId) || !Number.isSafeInteger(draftId)) {
    throw localReject(`draft_id 须为正整数：${String(draftId)}`);
  }
  if (action !== 'send' && action !== 'edit_send' && action !== 'discard') {
    throw localReject(`action 须为 send|edit_send|discard，收到：${String(action)}`);
  }
  let body: Record<string, unknown>;
  if (action === 'edit_send') {
    if (typeof editedContent !== 'string' || editedContent.length === 0) {
      throw localReject('edit_send 须携带非空字符串 edited_content', '请输入修改后的回复内容');
    }
    body = { action, edited_content: editedContent };
  } else {
    if (editedContent !== undefined) {
      throw localReject(`edited_content 仅 edit_send 可携带（action=${action}）`);
    }
    body = { action };
  }
  const raw = await apiFetch<unknown>(`/drafts/${draftId}/action`, {
    method: 'POST',
    body,
    auth: true,
  });
  return parseActionResult(raw);
}

// ---------------------------------------------------------------------------
// 纯函数（视图层共用；列表排序/还原显示/路由参数/回执文案单源）
// ---------------------------------------------------------------------------

/**
 * 路由参数 room_id 解析（评审修复环 I-5）：number 正整数或十进制数字串（trim 后）双收，
 * 其余一律 null（null=无过滤态由屏内注记明示——避免 string 参数静默降全域的误解）。
 * 自定口径（导航 params 值域=路由参数原始值，非 core 契约面）。
 */
export function parseAgentDraftsRoomParam(raw: unknown): number | null {
  if (typeof raw === 'number') {
    return Number.isSafeInteger(raw) && raw > 0 ? raw : null;
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!/^\d+$/.test(trimmed)) return null;
    const value = Number(trimmed);
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }
  return null;
}

/**
 * PENDING 优先置顶（T6 验收：待审面优先）：稳定分区——PENDING 段在前、其余段在后，
 * 两段内保持入参相对序（core 返回 id 倒序=组内新草稿在前，不重排）。
 */
export function sortAgentDraftsPendingFirst(rows: readonly AgentDraftView[]): AgentDraftView[] {
  const pending = rows.filter((d) => d.status === 'PENDING');
  if (pending.length === 0) return [...rows];
  return [...pending, ...rows.filter((d) => d.status !== 'PENDING')];
}

/**
 * 占位符→原文还原（仅律师端草稿卡显示专用——E1 §3 注记；token=[姓名]/[电话2] 形态，
 * 与 PLACEHOLDER_LABELS 同源）。全部出现处替换；映射空=原样返回。
 */
export function restorePlaceholders(text: string, placeholders: AgentDraftPlaceholders): string {
  let out = text;
  for (const [token, original] of Object.entries(placeholders)) {
    if (token.length === 0) continue;
    out = out.split(token).join(original);
  }
  return out;
}

/**
 * 动作结果回执文案（单源出；视图禁散写三元）：
 *   send/edit_send=「已作为律师消息发送」+ 会话消息查看入口注记（消息可见性由场次看板
 *   消息段承载——本页不渲染公屏）；discard=审查留痕；deduplicated=幂等重放注记。
 */
export function agentDraftActionNote(r: AgentDraftActionResult): string {
  let base: string;
  if (r.status === 'SENT') {
    base =
      '草稿已发送（SENT）——内容已作为您的律师消息进入会话；消息可在「场次看板 → 会话消息」查看';
  } else if (r.status === 'EDITED_SENT') {
    base =
      '修改后发送（EDITED_SENT）——修改稿已作为您的律师消息进入会话；消息可在「场次看板 → 会话消息」查看';
  } else if (r.status === 'DISCARDED') {
    base = '草稿已丢弃（DISCARDED）——审查留痕已记录（AgentReviewLog）';
  } else {
    base = `草稿状态：${agentDraftStatusCopy(r.status)}`;
  }
  return r.deduplicated
    ? `${base}（幂等重放：同动作重复提交，服务端返回同态，未产生新副作用）`
    : base;
}
