/**
 * H1 律师与资质审核数据面（M3-W3 T2）：/admin/lawyers 五端点。
 *
 * 出入参类型为 services/core 实码契约副本（admin 不依赖 core/shared 包——T1 口径，
 * 消费侧出参类型上移 @ljr/shared=独立卡）：每类型头注标注来源文件，core 改口径时本文件
 * 随之同步。词汇纪律：status/action 合法值与请求体键名逐字对照 core 实码，禁发明字段
 * （列表出参无姓名/手机号——如实展示，不虚构脱敏形态）。
 */
import { apiFetch } from './client';

// ---------------------------------------------------------------------------
// 契约类型副本（对照来源逐字段抄，禁发明）
// ---------------------------------------------------------------------------

/** 律师资质审核状态（core identity/lawyer.machine.ts LawyerAuditStatus；
 *  DRAFT=无行态不出现在列表/档案出参，保留全值域防御位） */
export type LawyerAuditStatus =
  'DRAFT' | 'SUBMITTED' | 'IN_REVIEW' | 'PASSED' | 'REJECTED' | 'SUSPENDED';

/** 工作台 status 过滤值域（core ops/lawyer-admin.http.ts WORKBENCH_STATUSES 实码序；
 *  absent=审核队列 SUBMITTED|IN_REVIEW，无「全部」选项——服务端无该语义不发明） */
export const WORKBENCH_STATUS_VALUES: readonly [
  'SUBMITTED',
  'IN_REVIEW',
  'PASSED',
  'REJECTED',
  'SUSPENDED',
] = ['SUBMITTED', 'IN_REVIEW', 'PASSED', 'REJECTED', 'SUSPENDED'];

export type WorkbenchStatus = (typeof WORKBENCH_STATUS_VALUES)[number];

/** 审核动作词汇（core identity/lawyer.http.ts AUDIT_ACTIONS 实码序；R-W3-B=A3a 实现词汇，
 *  H1 §5 文档 pass/reject 旧词不采用——裁决已定） */
export const LAWYER_AUDIT_ACTIONS: readonly ['claim', 'approve', 'reject', 'suspend', 'resume'] = [
  'claim',
  'approve',
  'reject',
  'suspend',
  'resume',
];

export type LawyerAuditAction = (typeof LAWYER_AUDIT_ACTIONS)[number];

/**
 * audit 弹层按当前状态可达的动作集（M3-W3 T8 死动作裁剪；来源=core 实码核实）：
 *   - SUBMITTED=[claim]：唯一出边 SUBMITTED→IN_REVIEW（identity/lawyer.machine.ts L30，
 *     machine 头注 L13「SUBMITTED→IN_REVIEW：H1 领取」=claim 专属）；
 *   - IN_REVIEW=[approve,reject]：出边 IN_REVIEW→PASSED｜REJECTED（machine L31-32，头注
 *     L14「审核结论」——approve 专属，同事务发 LawyerAuditPassed）。
 * ⚠ 核差注记（以 machine 实码为准逐边核实所得）：lawyer.service.ts L139 ACTION_TO_STATUS
 *   将 resume 映射到 'PASSED'，与 approve 同目标态；守卫为纯边校验（state-machine.ts L52
 *   allowed.has(from→to)），故 resume 从 IN_REVIEW 可搭 L31 边机械走通——但该路径不落
 *   audited_at、不发 LawyerAuditPassed，与 machine 文档语义（该边=审核结论 approve 专用）
 *   相悖，属 core 侧待收紧的宽松位（T8 报告注记），本表不向 UI 暴露；误触非法/病态组合
 *   仍有 409 横幅 + 强制刷新兜底（LawyersPage runAction 保留）。
 */
export const LAWYER_AUDIT_ACTIONS_BY_STATUS: Readonly<
  Record<'SUBMITTED' | 'IN_REVIEW', readonly LawyerAuditAction[]>
> = {
  SUBMITTED: ['claim'],
  IN_REVIEW: ['approve', 'reject'],
};

/** A3a 提交队列条目（core identity/lawyer.service.ts SubmissionQueueItem；无 license 字段
 *  =PII 红线，亦无姓名/手机号——列表行如实展示本表字段） */
export interface SubmissionQueueItem {
  /** lawyer_profiles.id（H1 审核/档案路由对象 {id}） */
  readonly id: number;
  readonly lawyer_user_id: number;
  readonly audit_status: LawyerAuditStatus;
  readonly firm_name: string | null;
  readonly material_version: number;
  /** 最近一次提交时刻 ISO（SLA 起算事实源；防御位可 null） */
  readonly submitted_at: string | null;
}

/** 工作台条目（core ops/lawyer-admin.service.ts WorkbenchItem：队列条目 + R-01 SLA 数据位） */
export interface WorkbenchItem extends SubmissionQueueItem {
  /** SLA 截止（submitted_at+3 工作日 ISO；submitted_at 缺失=null 防御位） */
  readonly sla_due_at: string | null;
  /** 剩余毫秒（负数=超时） */
  readonly sla_remaining_ms: number | null;
  /** 超时告警数据位（H4 看板同源） */
  readonly sla_overdue: boolean;
}

/** GET /admin/lawyers 出参（core ops/lawyer-admin.service.ts WorkbenchListResult） */
export interface WorkbenchListResult {
  readonly items: readonly WorkbenchItem[];
  readonly total: number;
  readonly page: number;
  readonly page_size: number;
}

/** 资质档案视图（core identity/lawyer.service.ts QualificationProfileView；无 license 字段） */
export interface QualificationProfileView {
  readonly id: number;
  readonly lawyer_user_id: number;
  readonly audit_status: LawyerAuditStatus;
  readonly firm_name: string | null;
  /** A3b 进件回填的律所 id（进件前 null） */
  readonly firm_id: number | null;
  readonly city: string;
  readonly material_version: number;
  readonly submitted_at: string | null;
  readonly audited_at: string | null;
  readonly auditor_id: number | null;
  readonly reject_reason?: string | null;
}

/** A3b 商户进件视图（core payment/firm-merchant.types.ts FirmMerchantView） */
export type FirmMerchantStatus =
  'SUBMITTING' | 'IN_REVIEW' | 'ACTIVE' | 'CHANGING' | 'SUSPENDED' | 'STOPPED';

export interface FirmMerchantView {
  readonly id: number;
  readonly firm_id: number;
  readonly channel: string;
  readonly sub_mchid: string | null;
  readonly status: FirmMerchantStatus;
  readonly verified_at: string | null;
  readonly reverify_due: string | null;
  readonly created_at: string;
}

/** G1 信用流水/限制令视图（core credit/credit.types.ts CreditEventView/RestrictionView） */
export interface CreditEventView {
  readonly id: number;
  readonly action: string;
  readonly delta: number;
  readonly rule_version: number;
  readonly ref_type: string;
  readonly ref_id: number;
  readonly created_at: string;
}

export interface RestrictionView {
  readonly id: number;
  readonly kind: string;
  readonly until: string;
  readonly reason: string;
  readonly created_at: string;
}

/** G1 信用快照（core credit/credit.types.ts CreditMineView） */
export interface CreditMineView {
  readonly score: number;
  readonly recent_events: readonly CreditEventView[];
  readonly restrictions: readonly RestrictionView[];
}

/** C1 场次统计四率（core trade/session.types.ts SessionStatsView；null=缺数据语义非 0） */
export interface SessionStatsView {
  readonly enroll_rate: number | null;
  readonly group_rate: number | null;
  readonly attendance_rate: number | null;
  readonly ooo_rate: number | null;
}

/** GET /admin/lawyers/:id/profile 出参（core ops/lawyer-admin.service.ts
 *  LawyerProfileAdminView：资质 A3a + 进件 A3b + 信用 G1 + 服务面 C1 四节） */
export interface LawyerProfileAdminView {
  readonly qualification: QualificationProfileView;
  /** A3b 进件行（按 firm 聚合；未进件=空数组不抛） */
  readonly merchants: readonly FirmMerchantView[];
  /** G1 信用快照（无账户行=初始 100 口径） */
  readonly credit: CreditMineView;
  /** C1 场次统计四率（缺省窗口=近 30 天上海日界） */
  readonly session_stats: SessionStatsView;
  readonly session_stats_window: { readonly from: string; readonly to: string };
}

// ---------------------------------------------------------------------------
// 展示映射表（文案单源，禁组件散写三元）
// ---------------------------------------------------------------------------

/** 状态 → 中文（覆盖全值域含 DRAFT 防御位；DRAFT=无档案行不出现在工作台） */
export const LAWYER_STATUS_LABELS: Readonly<Record<LawyerAuditStatus, string>> = {
  DRAFT: '未提交',
  SUBMITTED: '待审核',
  IN_REVIEW: '审核中',
  PASSED: '已通过',
  REJECTED: '已驳回',
  SUSPENDED: '已停用',
};

/** 工作台筛选文案（「审核队列」=缺省态 SUBMITTED|IN_REVIEW，对照实码缺省语义） */
export const WORKBENCH_FILTERS: readonly {
  readonly label: string;
  readonly status?: WorkbenchStatus;
}[] = [
  { label: '审核队列' },
  { label: '待审核', status: 'SUBMITTED' },
  { label: '审核中', status: 'IN_REVIEW' },
  { label: '已通过', status: 'PASSED' },
  { label: '已驳回', status: 'REJECTED' },
  { label: '已停用', status: 'SUSPENDED' },
];

/** 审核动作 → 中文（词汇=A3a 实现五枚；reject/suspend 附必填事由——服务端同规则） */
export const LAWYER_AUDIT_ACTION_LABELS: Readonly<
  Record<LawyerAuditAction, { label: string; note: string; danger: boolean }>
> = {
  claim: {
    label: '领取审核',
    note: '转入审核中（SUBMITTED → IN_REVIEW），锁定本人跟进',
    danger: false,
  },
  approve: {
    label: '审核通过',
    note: 'IN_REVIEW → PASSED，发 LawyerAuditPassed（列表可见/角色授予联动）',
    danger: false,
  },
  reject: {
    label: '驳回',
    note: 'IN_REVIEW → REJECTED，需填拒绝事由（本人可见，可补充材料重提）',
    danger: true,
  },
  suspend: {
    label: '停用',
    note: 'PASSED → SUSPENDED，需填停用事由（发 LawyerSuspended，在途场次受影响）',
    danger: true,
  },
  resume: { label: '恢复', note: 'SUSPENDED → PASSED（不发事件）', danger: false },
};

/** A3b 进件状态文案（firm-merchant.machine 值域） */
export const MERCHANT_STATUS_LABELS: Readonly<Record<FirmMerchantStatus, string>> = {
  SUBMITTING: '提交中',
  IN_REVIEW: '通道审核中',
  ACTIVE: '生效（可分账）',
  CHANGING: '变更期（暂停分账）',
  SUSPENDED: '已暂停',
  STOPPED: '已终止',
};

// ---------------------------------------------------------------------------
// 纯函数（防呆校验 + 格式化，bun test 直测）
// ---------------------------------------------------------------------------

export interface ReasonValidation {
  readonly ok: boolean;
  /** ok=false 时的防呆提示（与服务端 parseAuditActionBody 同规则：前端防呆+服务端校验双层） */
  readonly error?: string;
}

/**
 * audit 动作事由防呆（对照 core identity/lawyer.http.ts parseAuditActionBody 实码规则）：
 * reject → reject_reason 必填 1-1000 位；suspend → reason 必填 1-256 位；其余动作无事由。
 */
export function validateAuditReason(action: LawyerAuditAction, reason: string): ReasonValidation {
  const trimmed = reason.trim();
  if (action === 'reject') {
    if (trimmed === '') return { ok: false, error: '驳回必须填写拒绝事由（本人可见）' };
    if (reason.length > 1000) return { ok: false, error: '拒绝事由不得超过 1000 字' };
    return { ok: true };
  }
  if (action === 'suspend') {
    if (trimmed === '') return { ok: false, error: '停用必须填写停用事由' };
    if (reason.length > 256) return { ok: false, error: '停用事由不得超过 256 字' };
    return { ok: true };
  }
  return { ok: true };
}

/** suspend 专端点事由防呆（对照 core ops/lawyer-admin.http.ts parseSuspendBody：1-256 位非空） */
export function validateSuspendReason(reason: string): ReasonValidation {
  const trimmed = reason.trim();
  if (trimmed === '') return { ok: false, error: '停用必须填写停用事由' };
  if (reason.length > 256) return { ok: false, error: '停用事由不得超过 256 字' };
  return { ok: true };
}

/** SLA 剩余展示（R-01 3 工作日；负数=超期——超期由调用方按 sla_overdue 染危险色） */
export function formatSlaRemaining(remainingMs: number | null): string {
  if (remainingMs === null) return '—';
  const overdue = remainingMs < 0;
  const abs = Math.abs(remainingMs);
  const days = Math.floor(abs / 86_400_000);
  const hours = Math.floor((abs % 86_400_000) / 3_600_000);
  const minutes = Math.floor((abs % 3_600_000) / 60_000);
  const body =
    days > 0 ? `${days} 天 ${hours} 时` : hours > 0 ? `${hours} 时 ${minutes} 分` : `${minutes} 分`;
  return overdue ? `超期 ${body}` : `剩 ${body}`;
}

/** ISO 时刻 → 本地展示 'YYYY-MM-DD HH:mm'（timestamptz 出站 ISO 串统一出口） */
export function formatDateTime(iso: string | null): string {
  if (iso === null) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 比率展示（SessionStatsView null=缺数据语义非 0 → '—'，不假装数据） */
export function formatRate(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—';
  return `${(value * 100).toFixed(2)}%`;
}

// ---------------------------------------------------------------------------
// API 函数（全部受保护面：auth + 401 统一拦截）
// ---------------------------------------------------------------------------

/** GET /admin/lawyers?status=&page=：工作台列表（提交时间 ASC 服务端定；缺省=审核队列） */
export async function listLawyers(
  status?: WorkbenchStatus,
  page?: number,
): Promise<WorkbenchListResult> {
  const params = new URLSearchParams();
  if (status !== undefined) params.set('status', status);
  if (page !== undefined) params.set('page', String(page));
  const qs = params.toString();
  return apiFetch<WorkbenchListResult>(`/admin/lawyers${qs === '' ? '' : `?${qs}`}`, {
    auth: true,
  });
}

/**
 * POST /admin/lawyers/:id/audit：审核动作（词汇五枚实码；reject → reject_reason 键、
 * suspend → reason 键——载荷映射单源收口在此，调用方只传语义化参数）。
 * 409 E_STATE_ILLEGAL_TRANSITION/E_STATE_STALE_ENTITY = 状态冲突（屏顶横幅+刷新承载）。
 */
export async function auditLawyer(
  id: number,
  action: LawyerAuditAction,
  reason?: string,
): Promise<{ status: string }> {
  const body: Record<string, string> = { action };
  if (action === 'reject' && reason !== undefined) body.reject_reason = reason;
  if (action === 'suspend' && reason !== undefined) body.reason = reason;
  return apiFetch<{ status: string }>(`/admin/lawyers/${id}/audit`, {
    method: 'POST',
    auth: true,
    body,
  });
}

/** POST /admin/lawyers/:id/suspend {reason}：停用（专端点，reason 必填 1-256） */
export async function suspendLawyer(id: number, reason: string): Promise<{ status: string }> {
  return apiFetch<{ status: string }>(`/admin/lawyers/${id}/suspend`, {
    method: 'POST',
    auth: true,
    body: { reason },
  });
}

/** POST /admin/lawyers/:id/resume：恢复（SUSPENDED → PASSED） */
export async function resumeLawyer(id: number): Promise<{ status: string }> {
  return apiFetch<{ status: string }>(`/admin/lawyers/${id}/resume`, {
    method: 'POST',
    auth: true,
  });
}

/**
 * GET /admin/lawyers/:id/profile?from=&to=：档案聚合（404 未审/未知=如实承载错误态）。
 * from/to 窗口参数本卡缺省（服务端缺省=近 30 天上海日界），面板开面=后续卡。
 */
export async function fetchLawyerProfile(
  id: number,
  from?: string,
  to?: string,
): Promise<LawyerProfileAdminView> {
  const params = new URLSearchParams();
  if (from !== undefined) params.set('from', from);
  if (to !== undefined) params.set('to', to);
  const qs = params.toString();
  return apiFetch<LawyerProfileAdminView>(
    `/admin/lawyers/${id}/profile${qs === '' ? '' : `?${qs}`}`,
    { auth: true },
  );
}
