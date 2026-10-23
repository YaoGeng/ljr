/**
 * C6 改价审批台数据面（M3-W3 T6）：/pricing/histories（记录列表）+ /pricing/change/:id/approve
 * （①期人工兜底审批）两端点。
 *
 * 出入参类型为 services/core 实码契约副本（admin 不依赖 core/shared 包——T1 口径，消费侧
 * 出参类型上移 @ljr/shared=独立卡）：每类型头注标注来源文件，core 改口径时本文件随之同步。
 *
 * 契约对齐（core price-change.controller/service/http 实码）：
 *   - GET /pricing/histories?lawyer_id=：lawyer_id **必填**（缺/空 → 400；parsePositiveInt
 *     十进制正整数口径）。跨律师「待审批」列表面无契约端点——W3-4 拍板按「直达输入」承载
 *     （#49-① 先例），非缺口不 triage；
 *   - 出参条目=PriceHistoryView 13 字段：SQL SELECT 含 new_version_draft 但 view 映射剥离
 *     ——出参**无新旧价格金额、无草案明细**（审批台金额对照缺口列任务报告 triage，不扩面）；
 *   - POST /pricing/change/:id/approve：@RequireRole('admin')；体={approved, approval_id}
 *     两者均必填（parseApproveBody：approved 布尔 + approval_id 正整数——①期人工兜底=处置
 *     凭据 id，H3 工单 id ②期接入）。非 PENDING 重放返回既有终态不翻案；版本链漂移 →
 *     409 E_CONFLICT；并发裁决 → 409 E_STATE_STALE_ENTITY；
 *   - histories=公开 GET 面（无角色门），approve=admin 角色——本台统一 auth:true 走 admin
 *     会话头（读公开面+动作面混合口径，T6 任务约定）。
 * 错误码：本域抛码（E_INVALID_ARGUMENT/E_NOT_FOUND/E_CONFLICT/E_STATE_STALE_ENTITY/
 * E_STATE_ILLEGAL_TRANSITION/E_ROLE_FORBIDDEN）均已在 error-messages.ts 册内——零新码。
 */
import { AdminApiError, AdminClientErrorCode, apiFetch } from './client';
import { resolveApiErrorCopy } from './error-messages';

// ---------------------------------------------------------------------------
// 契约类型副本（对照来源逐字段抄，禁发明）
// ---------------------------------------------------------------------------

/** 改价结果三态（core pricing/price-change.types.ts ChangeRequestResultState；
 *  REVOKED 以 revoked_at 承载不出现在 result 列——V29 CHECK 值域） */
export type PriceHistoryResultState = 'EFFECTED' | 'PENDING_APPROVAL' | 'REJECTED';

/** 改价方向（core pricing/price-change.types.ts；§3 direction 值域 UP|DOWN） */
export type PriceChangeDirection = 'UP' | 'DOWN';

/**
 * GET /pricing/histories?lawyer_id= 条目（core pricing/price-change.types.ts
 * PriceHistoryView——listHistories 映射后出站形态）。注意：无新旧价格金额、无 new_version_draft
 * （view 剥离）；approval_source=MANUAL=人工兜底审批归源，null=直效行（不经审批）。
 */
export interface PriceHistoryView {
  readonly history_id: number;
  readonly lawyer_id: number;
  readonly old_version: number;
  readonly new_version: number;
  readonly direction: PriceChangeDirection;
  /** numeric(6,3) 审计文本（如 "10.000"；档位判定服务端走引擎整数精确比较） */
  readonly change_pct: string;
  readonly has_active_group: boolean;
  readonly result: PriceHistoryResultState;
  readonly approval_id: number | null;
  readonly approval_source: 'MANUAL' | null;
  /** 档位信用惩罚快照（在团 UP -5 / DOWN≤10% -15 / >10% -30；不在团恒 0） */
  readonly credit_penalty: number;
  readonly created_at: string;
  readonly revoked_at: string | null;
}

/** POST /pricing/change/:id/approve 请求体（core pricing/price-change.http.ts
 *  parseApproveBody：approved 布尔必填 + approval_id 正整数必填——两者缺一 400） */
export interface ApprovePriceChangeBody {
  readonly approved: boolean;
  readonly approval_id: number;
}

/** POST /pricing/change/:id/approve 出参（core pricing/price-change.types.ts ApproveResult；
 *  幂等重放返回既有终态不翻案；直效行 approval_source=null） */
export interface ApprovePriceChangeResult {
  readonly history_id: number;
  readonly result: PriceHistoryResultState;
  readonly approval_source: 'MANUAL' | null;
}

/** 三档词汇（@ljr/shared events.ts PriceChangeKind 值域副本——admin 不依赖 shared 包）；
 *  出箱 PriceChangeApproved.kind 同值（G1 扣分/停接、F4 补偿、I1 话术按此联动） */
export type PriceChangeKindTier = 'PRICE_UP' | 'PRICE_DOWN_LE10' | 'PRICE_DOWN_GT10';

// ---------------------------------------------------------------------------
// 展示映射表（文案单源，禁组件散写三元）
// ---------------------------------------------------------------------------

/** 结果三态 → 中文（note=列表/焦点卡共用的流转标注文案源；已撤销以 revoked_at 承载非独立态） */
export const PRICE_RESULT_LABELS: Readonly<
  Record<PriceHistoryResultState, { label: string; note: string }>
> = {
  PENDING_APPROVAL: {
    label: '待审批',
    note: '审批档（R-01 在团降价 / R-03 频率超限兜底）——等待运营处置',
  },
  EFFECTED: {
    label: '已生效',
    note: '版本已落版（直效档或审批通过；result 列不变，撤销以 revoked_at 承载）',
  },
  REJECTED: {
    label: '已否决',
    note: '审批否决终态：版本不生效，无信用事件无补偿（不翻案）',
  },
};

/** R-01 三档 → 徽标与后果注记（C6 §4/§7 逐字口径——审批员处置前可见联动后果） */
export const PRICE_KIND_LABELS: Readonly<
  Record<PriceChangeKindTier, { label: string; note: string }>
> = {
  PRICE_UP: {
    label: '涨价',
    note: '在团涨价：已锁定用户按支付时快照价，新发起按新价；信用 -5',
  },
  PRICE_DOWN_LE10: {
    label: '降价 ≤10%',
    note: '审批通过后生效：已锁定用户价格快照保护；积分补偿=（原-新）×支付占比，24h 内发放；信用 -15',
  },
  PRICE_DOWN_GT10: {
    label: '降价 >10%',
    note: '审批通过后生效：快照保护+积分补偿+优惠券补偿；信用 -30 且停接 3 天（R-01 逐字）',
  },
};

// ---------------------------------------------------------------------------
// 纯函数（防呆校验 + 载荷构造 + 档位推导，bun test 直测）
// ---------------------------------------------------------------------------

/** 构造结果：ok=false 附防呆提示（rules.ts BuildResult 同形态，本模块自持不跨引） */
export type ParseResult<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

/** 十进制正整数字符串词法（core infrastructure/parse-positive-int.ts 同式） */
const DECIMAL_POSITIVE_INT = /^\d+$/;

/**
 * 十进制正整数解析镜像（core parse-positive-int.ts 同口径：^\d+$ 收纯十进制（拒 0x/1e2/
 * 科学计数/负号/空格）、≠0、≤MAX_SAFE_INTEGER——非法入参不出 500 的前端同层防呆）。
 */
export function parsePositiveIntInput(raw: string, field: string): ParseResult<number> {
  if (!DECIMAL_POSITIVE_INT.test(raw)) {
    return { ok: false, error: `${field} 须为十进制正整数（不含空格/小数/负号）` };
  }
  const value = Number(raw);
  if (value === 0) {
    return { ok: false, error: `${field} 须为正整数（0 非法）` };
  }
  if (!Number.isSafeInteger(value)) {
    return { ok: false, error: `${field} 超出安全整数上限（≤ ${Number.MAX_SAFE_INTEGER}）` };
  }
  return { ok: true, value };
}

/** lawyer_id 直达输入防呆（服务端 parsePositiveInt('lawyer_id') 镜像；trim 由调用方收口） */
export function validateLawyerIdInput(raw: string): ParseResult<number> {
  return parsePositiveIntInput(raw, '律师 id');
}

/**
 * 审批载荷构造（对照 core price-change.http.ts parseApproveBody 实码规则）：approved 来自
 * 按钮二选恒为布尔；approval_id 必填正整数（①期人工兜底=处置凭据 id，H3 工单 id ②期接入）
 * ——字符串输入走十进制词法镜像（拒 '1e2'/'0x10' 形态，与 parsePositiveInt 同口径）。
 */
export function buildApproveBody(input: {
  readonly approved: boolean;
  readonly approvalId: string | number;
}): ParseResult<ApprovePriceChangeBody> {
  const raw =
    typeof input.approvalId === 'number' ? String(input.approvalId) : input.approvalId.trim();
  const parsed = parsePositiveIntInput(raw, 'approval_id');
  if (!parsed.ok) return parsed;
  return { ok: true, value: { approved: input.approved, approval_id: parsed.value } };
}

/** numeric(6,3) 非负十进制文本词法（DB 出站形态：如 "10.000"——拒空串/负号/科学计数） */
const NON_NEGATIVE_DECIMAL = /^\d+(\.\d+)?$/;

/**
 * 展示档位推导（评审 IMPORTANT-1 修正版）：
 *   - **在团行（has_active_group=true）按 credit_penalty 权威快照映射**（-5→UP / -15→LE10 /
 *     -30→GT10）——engine 实码在团恒 creditPenalty=TIER_PENALTY[kind] 且三值互异一一对应，
 *     与引擎档位判定同源零漂移；
 *   - **change_pct 审计文本路径仅作不在团行回退**：其 BigInt 向下取整与引擎整数判定**不同界**
 *     ——真实幅度落在 (10.000%, 10.001%) 开窗内文本为 "10.000" 而引擎判 GT10（评审反例：
 *     ¥1999.99→¥1799.99，delta×10=200000>199999=GT10/-30，change_pct 却向下取整 "10.000"）。
 *     不在团行 credit_penalty 恒 0 无区分度只能回退，且其无信用/补偿联动——展示漂移不落
 *     决策文案；
 *   - 表外形态（在团 credit_penalty 越值域 / 不在团 change_pct 非十进制/负——Number('')=0
 *     陷阱已堵词法）→ null 防御位不猜档。
 */
export function derivePriceChangeKind(row: {
  readonly direction: PriceChangeDirection;
  readonly change_pct: string;
  readonly has_active_group: boolean;
  readonly credit_penalty: number;
}): PriceChangeKindTier | null {
  if (row.has_active_group) {
    switch (row.credit_penalty) {
      case -5:
        return 'PRICE_UP';
      case -15:
        return 'PRICE_DOWN_LE10';
      case -30:
        return 'PRICE_DOWN_GT10';
      default:
        return null; // 表外值防御位（engine 在团恒非 0 三值——不应触达）
    }
  }
  // 不在团回退：direction + change_pct 文本推导（边界开窗内可漂一档——见头注）
  if (row.direction === 'UP') return 'PRICE_UP';
  if (!NON_NEGATIVE_DECIMAL.test(row.change_pct)) return null;
  const pct = Number(row.change_pct);
  if (!Number.isFinite(pct)) return null;
  return pct <= 10 ? 'PRICE_DOWN_LE10' : 'PRICE_DOWN_GT10';
}

/** 待审批置顶：PENDING_APPROVAL 行分区置前（焦点卡承载），其余保持服务端序（id DESC 新在前） */
export function sortHistoriesPendingFirst(
  rows: readonly PriceHistoryView[],
): readonly PriceHistoryView[] {
  const pending = rows.filter((r) => r.result === 'PENDING_APPROVAL');
  if (pending.length === 0) return rows;
  return [...pending, ...rows.filter((r) => r.result !== 'PENDING_APPROVAL')];
}

// ---------------------------------------------------------------------------
// API 函数（统一 auth:true 走 admin 会话头：approve=admin 角色门；histories 公开面同头无碍）
// ---------------------------------------------------------------------------

/** GET /pricing/histories?lawyer_id=：按律师直达的改价记录列表（服务端排序 id DESC 新在前）。
 *  lawyerId 必填正整数——非法即本地拒（CLIENT_BAD_REQUEST，不发请求），服务端同规则 400 兜底 */
export async function listPricingHistories(lawyerId: number): Promise<readonly PriceHistoryView[]> {
  if (!Number.isInteger(lawyerId) || lawyerId <= 0) {
    throw new AdminApiError({
      code: AdminClientErrorCode.BadRequest,
      copy: resolveApiErrorCopy(AdminClientErrorCode.BadRequest),
    });
  }
  return apiFetch<readonly PriceHistoryView[]>(`/pricing/histories?lawyer_id=${lawyerId}`, {
    auth: true,
  });
}

/** POST /pricing/change/:id/approve：①期人工兜底审批（true→EFFECTED / false→REJECTED；
 *  归源 approval_source=MANUAL）。非 PENDING 重放返回既有终态（不翻案零副作用）；409
 *  E_CONFLICT=版本链漂移审批作废 / E_STATE_STALE_ENTITY=并发裁决 → 调用方横幅+刷新承载 */
export async function approvePriceChange(
  historyId: number,
  body: ApprovePriceChangeBody,
): Promise<ApprovePriceChangeResult> {
  if (!Number.isInteger(historyId) || historyId <= 0) {
    throw new AdminApiError({
      code: AdminClientErrorCode.BadRequest,
      copy: resolveApiErrorCopy(AdminClientErrorCode.BadRequest),
    });
  }
  return apiFetch<ApprovePriceChangeResult>(`/pricing/change/${historyId}/approve`, {
    method: 'POST',
    auth: true,
    body,
  });
}
