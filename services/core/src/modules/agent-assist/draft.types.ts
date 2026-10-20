/**
 * E1 Agent 草稿气泡管线——类型契约（M2-W3 T4；施工规格 docs/modules/E-AI辅助/E1-Agent草稿
 * 气泡管线.md §3/§5/§6/§8 + 执行计划附录 A.3 V48 蓝图）。类型即契约——先于实现落位
 * （契约类型先行纪律）。词汇与 V48 CHECK 值域逐字对齐。
 *
 * R-02 铁律的类型表达：DraftView.question_digest（脱敏后摘要，占位符形态）与
 * DraftView.placeholders（占位符→原文映射）是两个互斥用途结构——后者仅律师端气泡还原显示，
 * 禁入 RAG/LLM 载荷（LlmAdapter 入参无 placeholders 字段，类型面钉死）。
 */

/** 草稿状态词汇（V48 ck 五值；E1 §3——PENDING 待审 / 三动作终态 / EXPIRED 去重终态） */
export const DRAFT_STATUSES = ['PENDING', 'SENT', 'EDITED_SENT', 'DISCARDED', 'EXPIRED'] as const;
export type DraftStatus = (typeof DRAFT_STATUSES)[number];

export function isDraftStatus(value: string): value is DraftStatus {
  return (DRAFT_STATUSES as readonly string[]).includes(value);
}

/** 律师三动作（V48 agent_review_logs ck 三值；§5 POST /drafts/{id}/action） */
export const DRAFT_ACTIONS = ['send', 'edit_send', 'discard'] as const;
export type DraftAction = (typeof DRAFT_ACTIONS)[number];

export function isDraftAction(value: string): value is DraftAction {
  return (DRAFT_ACTIONS as readonly string[]).includes(value);
}

/** 各段打点（毫秒整数 ≥0；§8 预算：sanitize≤1s / intent≤1s / rag≤2s / llm≤4s，总 P95≤8s） */
export interface DraftSegmentMs {
  readonly sanitize: number;
  readonly intent: number;
  readonly rag: number;
  readonly llm: number;
}

/** 占位符→原文映射（律师端气泡还原显示专用；R-02：禁入 RAG/LLM 载荷） */
export type DraftPlaceholders = Readonly<Record<string, string>>;

/** drafts 行视图（气泡推送/断线补拉/测试断言锚） */
export interface DraftView {
  readonly draft_id: number;
  readonly room_id: number;
  readonly conversation_id: number;
  readonly target_user_id: number;
  /** 脱敏后问题摘要（占位符形态——原文禁入，R-02） */
  readonly question_digest: string;
  /** 草稿正文（含「AI 辅助，仅供参考」标记——R-04） */
  readonly content: string;
  readonly placeholders: DraftPlaceholders;
  readonly status: DraftStatus;
  readonly answered: boolean;
  readonly latency_ms: number | null;
  readonly segment_ms: DraftSegmentMs | null;
  readonly created_at: string;
  readonly replied_at: string | null;
}

/** agent_review_logs 行视图（审查留痕断言锚） */
export interface ReviewLogView {
  readonly id: number;
  readonly draft_id: number;
  readonly lawyer_id: number;
  readonly action: DraftAction;
  readonly edited_content: string | null;
  readonly review_ms: number;
  readonly sent_at: string | null;
  readonly created_at: string;
}

/** 管线入参（消费端组装：MessageSent 载荷回查后的进程内形态——content=原文只在进程内） */
export interface DraftPipelineInput {
  readonly conversationId: number;
  readonly roomId: number;
  readonly seq: number;
  readonly targetUserId: number;
  /** 用户消息原文（含 PII）——先过 SanitizeService 再进 RAG/LLM（R-02） */
  readonly content: string;
}

/** 管线结局（draft.service 出参；blocked=硬拦命中，degraded=管线段失败降级） */
export type DraftPipelineOutcome = 'drafted' | 'blocked' | 'degraded';

/** 律师动作入参（§5 POST /drafts/{id}/action） */
export interface DraftActionInput {
  readonly action: DraftAction;
  /** edit_send 必填；send/discard 禁带（服务面校验） */
  readonly editedContent?: string;
}

/** 动作出参（幂等重放标识 + 终态回显） */
export interface DraftActionResult {
  readonly draft_id: number;
  readonly status: DraftStatus;
  /** true=UNIQUE(draft_id,action) 幂等命中（重复同动作零副作用零新事件） */
  readonly deduplicated: boolean;
}

/** 健康面出参（§5 GET /agent/health：降级态透出——W3-7 降级纪律的可观测口） */
export interface AgentHealth {
  readonly status: 'ok' | 'degraded';
  /** 最近一次管线段失败的错误摘要（不含原文——R-02；null=无降级在册） */
  readonly last_error: string | null;
  /** 累计降级次数（进程内单调计数，重启归零——dev 单进程口径） */
  readonly degraded_count: number;
}
