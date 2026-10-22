/**
 * D1/D3/D4/D5 场次看板 API（M3-W2 T5）：律师视角只读聚合 + 关房/取消两动作
 * （契约消费——core 实文出参逐字段，§5 逐字键名）：
 *   GET  /rooms/{room_id}/attendance           → AttendanceView[]（§5 逐字
 *                                                {user_id, role, status, join_at}；Bearer，
 *                                                403 NOT_PARTY 复用 E_ROLE_FORBIDDEN、404=房间
 *                                                不存在/未开房——attendance.controller 实文）
 *   GET  /rooms/{id}/notice                    → RoomNoticeView（D5 薄代理 H7 须知；
 *                                                **无鉴权公开只读面**——core 实文「无鉴权沿
 *                                                ops 面先例」，本层不带 Bearer）
 *   GET  /conversations/{id}/messages?after_seq=&limit= → MessageView[]（只读增量；
 *                                                after_seq 独占下界缺省 0、limit 缺省 50 上限
 *                                                200 静默收窄——conversation.http 实文镜像；
 *                                                成员门=asUserId（JWT）room 型非参与方 403）
 *   POST /rooms/{session_id}/close             → {closed_at}（D1 §5「job/律师端」律师端半边；
 *                                                **无请求体**（幂等键=路径参 session）；
 *                                                409 NOT_OPEN=已终态、404=未开房、403=非本场
 *                                                律师——room.controller/service 实文）
 *   POST /sessions/{session_id}/cancel         → {result, approval?}（D4 §5 role=user|lawyer
 *                                                双角色面；律师可取消=模块文档+core 实文
 *                                                （矩阵 LAWYER_NOTICE≥24h/LAWYER_LT24H 审批支）
 *                                                ——body.role 与 JWT 激活角色必须一致）
 *
 * ⚠契约缺口（如实承载，禁发明——任务简报核对结论）：GET /sessions/{id} 出参无 room_id，
 * 全 HTTP 面亦无「按场次查房间」或「按房间查会话」端点——看板的出席/公告（room_id）与
 * 消息（conversation_id）以「按 ID 直达输入」承载，缺口列任务报告 triage（04 §8 候选）。
 *
 * fail-visible：出参形状（数组/行字段/枚举判别值）本层校验，非法即 CLIENT_BAD_RESPONSE；
 * 入参本地前置校验镜像 core 值域（parse-positive-int/parseCancelReason ≤200/MAX_PULL_LIMIT）。
 * 本模块保持平台无关（无 react-native import），bun test 直接可测。
 */
import { AppClientErrorCode, apiFetch, AppApiError } from './client';

// ---------------------------------------------------------------------------
// §5 契约类型（core 实文逐字段；snake_case 逐字）
// ---------------------------------------------------------------------------

/** D3 §3 attendances.status 值域（V39 ck 同字面） */
export type AttendanceStatus = 'NORMAL' | 'LATE' | 'ABSENT';

/** D3 §3 role 值域（user|lawyer） */
export type AttendanceRole = 'user' | 'lawyer';

/** GET /rooms/{room_id}/attendance 条目（§5 逐字四键） */
export interface AttendanceView {
  readonly user_id: number;
  readonly role: AttendanceRole;
  readonly status: AttendanceStatus;
  /** 首次进入时刻（ISO 8601；从未进入=null） */
  readonly join_at: string | null;
}

/** H7 须知内容块（ops rule-center.types RoomNoticeContent 逐字段） */
export interface RoomNoticeContent {
  readonly title: string;
  readonly paragraphs: readonly string[];
  readonly disclosures: readonly string[];
}

/** GET /rooms/{id}/notice 出参（薄代理形态：ruleKey/version/effectiveAt/content） */
export interface RoomNoticeView {
  readonly ruleKey: string;
  readonly version: number;
  readonly effectiveAt: string;
  readonly content: RoomNoticeContent;
}

/** D5 sender_role 全集（V37 ck 四值；agent=律师审查后进房、system=须知/提醒） */
export type SenderRole = 'user' | 'lawyer' | 'agent' | 'system';

/** D5 消息类型（V37 ck 二值：text 用户文本 / system 须知·提醒） */
export type MessageType = 'text' | 'system';

/** GET /conversations/{id}/messages 条目（conversation.types MessageView 十一键逐字段） */
export interface MessageView {
  readonly message_id: number;
  readonly conversation_id: number;
  readonly seq: number;
  readonly sender_id: number;
  readonly sender_role: SenderRole;
  readonly type: MessageType;
  readonly content: string;
  readonly mention: 'agent' | 'lawyer' | null;
  /** PASS|BLOCKED|REVIEW（BLOCKED 在册不可达——拦截即拒无行） */
  readonly risk_flag: string;
  readonly source_msg_id: string | null;
  readonly created_at: string;
}

/** POST /rooms/{session_id}/close 出参（§5 逐字 {closed_at}） */
export interface RoomClosedResult {
  readonly closed_at: string;
}

/** D4 §5 响应 {result, approval?}（SessionCancelResult 实文；reschedule_available=user 支不入本面） */
export interface SessionCancelResult {
  readonly result: 'CANCELLED' | 'PENDING_APPROVAL' | 'APPROVAL_REJECTED';
  /** 幂等键=session+role 命中既有取消（重放幂等位） */
  readonly deduplicated?: boolean;
  readonly refund?: 'FULL';
  /** PENDING_APPROVAL/APPROVAL_REJECTED：H3 工单锚（§5 approval 半边） */
  readonly approval?: { readonly ticket_id: number; readonly sla_due: string };
}

// ---------------------------------------------------------------------------
// 值域常量（core 实文镜像）
// ---------------------------------------------------------------------------

/** core parseCancelReason 理由域（自由文本 ≤200，缺省空串） */
export const CANCEL_REASON_MAX_LEN = 200;
/** core D5 读路径缺省条数（conversation.types DEFAULT_PULL_LIMIT） */
export const MESSAGES_LIMIT_DEFAULT = 50;
/** core D5 读路径上限（MAX_PULL_LIMIT；超出静默收窄不报错——本层同款镜像） */
export const MESSAGES_LIMIT_MAX = 200;

// ---------------------------------------------------------------------------
// 文案映射表（单源；未知值回退原码——fail-visible 不吞不编）
// ---------------------------------------------------------------------------

/** D3 出席三态文案（R-01：宽限内=正常；超宽限 ≤15min=迟到旁听；>15min=缺席费用不退） */
export const ATTENDANCE_STATUS_COPY: Readonly<Record<AttendanceStatus, string>> = {
  NORMAL: '正常到场',
  LATE: '迟到（旁听）',
  ABSENT: '缺席',
};

export function attendanceStatusCopy(status: string): string {
  return ATTENDANCE_STATUS_COPY[status as AttendanceStatus] ?? status;
}

const SENDER_ROLE_COPY: Readonly<Record<SenderRole, string>> = {
  user: '用户',
  lawyer: '律师',
  agent: 'AI 辅助',
  system: '系统',
};

export function senderRoleCopy(role: string): string {
  return SENDER_ROLE_COPY[role as SenderRole] ?? role;
}

/**
 * 律师取消结果回执文案（D4 §4 矩阵单源出；视图禁散写三元）。
 * ⚠矩阵参数（24h/-10/-30/20%/30 天窗/停接 7 天）=rule_definitions cancel.matrix **版本化参数**
 * （cancellation.engine 快照读）——本文案为 D4 模块文档口径快照，参数漂移时以规则中心现行版为准。
 */
export function lawyerCancelResultNote(r: SessionCancelResult): string {
  if (r.result === 'CANCELLED') {
    const base =
      '已取消 · 全额退款已发起，信用 -10 已记录（30 天内连续 2 次取消/缺席将暂停接单 7 天）';
    return r.deduplicated === true ? `${base}（重复提交：本次为幂等重放，未产生新副作用）` : base;
  }
  if (r.result === 'PENDING_APPROVAL') {
    const sla =
      r.approval !== undefined
        ? `（工单 #${r.approval.ticket_id}，处理时限 ${r.approval.sla_due}）`
        : '';
    return `已提交平台审批${sla}——距开始 <24h 取消须平台审批：通过后全额退款、信用 -30，并以场次总价 20% 违约金按支付占比补偿用户`;
  }
  return '审批已被驳回——本场次维持原状态，如仍需取消请提交新工单或联系平台';
}

// ---------------------------------------------------------------------------
// 形状校验（fail-visible）
// ---------------------------------------------------------------------------

function badShape(detail: string): AppApiError {
  return new AppApiError({
    code: AppClientErrorCode.BadResponseBody,
    copy: '服务响应异常，请稍后重试',
    serverMessage: `场次看板响应形状非法：${detail}`,
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

function isIsoString(v: unknown): v is string {
  return typeof v === 'string' && v['length'] > 0 && !Number.isNaN(Date.parse(v));
}

function isStringArray(v: unknown): v is readonly string[] {
  return Array.isArray(v) && v.every((s) => typeof s === 'string');
}

/** 路径参正整数本地校验（core parse-positive-int 镜像——不发坏请求） */
function assertPathId(id: number, field: string, copy: string): number {
  if (!isPosInt(id) || !Number.isSafeInteger(id))
    throw localReject(`${field} 非正整数：${String(id)}`, copy);
  return id;
}

function parseAttendanceView(raw: unknown): AttendanceView {
  if (typeof raw !== 'object' || raw === null) throw badShape('出席行非对象');
  const r = raw as Record<string, unknown>;
  if (!isPosInt(r['user_id'])) throw badShape('user_id 非正整数');
  if (r['role'] !== 'user' && r['role'] !== 'lawyer') throw badShape('role 越值域');
  if (r['status'] !== 'NORMAL' && r['status'] !== 'LATE' && r['status'] !== 'ABSENT') {
    throw badShape('status 越值域');
  }
  const joinAt = r['join_at'];
  if (joinAt !== null && !isIsoString(joinAt)) throw badShape('join_at 非 ISO 时刻或 null');
  const joinAtTyped: string | null = joinAt === null ? null : (joinAt as string);
  return {
    user_id: r['user_id'],
    role: r['role'],
    status: r['status'],
    join_at: joinAtTyped,
  };
}

function parseRoomNotice(raw: unknown): RoomNoticeView {
  if (typeof raw !== 'object' || raw === null) throw badShape('须知响应非对象');
  const r = raw as Record<string, unknown>;
  if (typeof r['ruleKey'] !== 'string' || r['ruleKey'].length === 0) {
    throw badShape('ruleKey 非非空字符串');
  }
  if (!isPosInt(r['version'])) throw badShape('version 非正整数');
  if (!isIsoString(r['effectiveAt'])) throw badShape('effectiveAt 非时刻');
  const c = r['content'];
  if (typeof c !== 'object' || c === null) throw badShape('content 非对象');
  const content = c as Record<string, unknown>;
  if (typeof content['title'] !== 'string' || content['title'].length === 0) {
    throw badShape('content.title 非非空字符串');
  }
  if (!isStringArray(content['paragraphs'])) throw badShape('content.paragraphs 非字符串数组');
  if (!isStringArray(content['disclosures'])) throw badShape('content.disclosures 非字符串数组');
  return {
    ruleKey: r['ruleKey'],
    version: r['version'],
    effectiveAt: r['effectiveAt'],
    content: {
      title: content['title'],
      paragraphs: content['paragraphs'],
      disclosures: content['disclosures'],
    },
  };
}

function parseMessageView(raw: unknown): MessageView {
  if (typeof raw !== 'object' || raw === null) throw badShape('消息行非对象');
  const r = raw as Record<string, unknown>;
  if (!isPosInt(r['message_id'])) throw badShape('message_id 非正整数');
  if (!isPosInt(r['conversation_id'])) throw badShape('conversation_id 非正整数');
  if (!isPosInt(r['seq'])) throw badShape('seq 非正整数');
  if (!isPosInt(r['sender_id'])) throw badShape('sender_id 非正整数');
  // 展示枚举（sender_role/type/risk_flag/mention）：非空字符串放行原样——文案层回退原码
  // （parseSessionView 同款宽进严出口径：core 新增枚举先行时前端不吞错不撒谎）
  for (const key of ['sender_role', 'type', 'risk_flag']) {
    if (typeof r[key] !== 'string' || (r[key] as string).length === 0) {
      throw badShape(`${key} 非非空字符串`);
    }
  }
  if (r['mention'] !== null && typeof r['mention'] !== 'string')
    throw badShape('mention 非字符串或 null');
  if (r['source_msg_id'] !== null && typeof r['source_msg_id'] !== 'string') {
    throw badShape('source_msg_id 非字符串或 null');
  }
  if (typeof r['content'] !== 'string') throw badShape('content 非字符串');
  if (!isIsoString(r['created_at'])) throw badShape('created_at 非时刻');
  return {
    message_id: r['message_id'],
    conversation_id: r['conversation_id'],
    seq: r['seq'],
    sender_id: r['sender_id'],
    sender_role: r['sender_role'] as SenderRole,
    type: r['type'] as MessageType,
    content: r['content'],
    mention: (r['mention'] as 'agent' | 'lawyer' | null) ?? null,
    risk_flag: r['risk_flag'] as string,
    source_msg_id: (r['source_msg_id'] as string | null) ?? null,
    created_at: r['created_at'],
  };
}

function parseSessionCancelResult(raw: unknown): SessionCancelResult {
  if (typeof raw !== 'object' || raw === null) throw badShape('取消响应非对象');
  const r = raw as Record<string, unknown>;
  // 判别值从严（动作出参：未知 result 不放行——分支语义靠它裁决，fail-visible）
  if (
    r['result'] !== 'CANCELLED' &&
    r['result'] !== 'PENDING_APPROVAL' &&
    r['result'] !== 'APPROVAL_REJECTED'
  ) {
    throw badShape(`result 越值域：${JSON.stringify(r['result'])}`);
  }
  if (r['deduplicated'] !== undefined && typeof r['deduplicated'] !== 'boolean') {
    throw badShape('deduplicated 非布尔');
  }
  if (r['refund'] !== undefined && r['refund'] !== 'FULL') throw badShape('refund 越值域');
  let approval: SessionCancelResult['approval'];
  if (r['approval'] !== undefined) {
    const a = r['approval'];
    if (typeof a !== 'object' || a === null) throw badShape('approval 非对象');
    const approvalRow = a as Record<string, unknown>;
    if (!isPosInt(approvalRow['ticket_id'])) throw badShape('approval.ticket_id 非正整数');
    if (!isIsoString(approvalRow['sla_due'])) throw badShape('approval.sla_due 非时刻');
    approval = { ticket_id: approvalRow['ticket_id'], sla_due: approvalRow['sla_due'] };
  }
  return {
    result: r['result'],
    deduplicated: r['deduplicated'],
    refund: r['refund'],
    approval,
  };
}

// ---------------------------------------------------------------------------
// API 封装（snake_case 逐字；错误经 error-messages 单源映射）
// ---------------------------------------------------------------------------

/** GET /rooms/{room_id}/attendance：出席名单（Bearer；403=非参与方/404=房间不存在） */
export async function fetchRoomAttendance(roomId: number): Promise<AttendanceView[]> {
  const id = assertPathId(roomId, 'room_id', '房间号参数有误，请检查后重试');
  const raw = await apiFetch<unknown>(`/rooms/${id}/attendance`, { auth: true });
  if (!Array.isArray(raw)) throw badShape('出席响应非数组');
  return raw.map(parseAttendanceView);
}

/** GET /rooms/{id}/notice：房间须知（无鉴权公开只读面——本层不带 Bearer，core 实文口径） */
export async function fetchRoomNotice(roomId: number): Promise<RoomNoticeView> {
  const id = assertPathId(roomId, 'room_id', '房间号参数有误，请检查后重试');
  const raw = await apiFetch<unknown>(`/rooms/${id}/notice`);
  return parseRoomNotice(raw);
}

/** GET /conversations/{id}/messages 入参（after_seq 独占下界缺省 0；limit 缺省 50 上限 200） */
export interface FetchMessagesInput {
  readonly after_seq?: number;
  readonly limit?: number;
}

/** GET /conversations/{id}/messages：会话消息只读（Bearer；成员门=JWT 本人=场次律师/PAID 报名） */
export async function fetchConversationMessages(
  conversationId: number,
  input: FetchMessagesInput = {},
): Promise<MessageView[]> {
  const id = assertPathId(conversationId, 'conversation_id', '会话号参数有误，请检查后重试');
  const params = new URLSearchParams();
  if (input.after_seq !== undefined) {
    if (!Number.isInteger(input.after_seq) || input.after_seq < 0) {
      throw localReject(`after_seq 须为非负整数：${String(input.after_seq)}`);
    }
    if (input.after_seq > 0) params.set('after_seq', String(input.after_seq)); // 0=缺省语义不显式携带
  }
  if (input.limit !== undefined) {
    if (!Number.isInteger(input.limit) || input.limit <= 0) {
      throw localReject(`limit 须为正整数：${String(input.limit)}`);
    }
    params.set('limit', String(Math.min(input.limit, MESSAGES_LIMIT_MAX))); // core 静默收窄镜像
  }
  const qs = params.toString();
  const raw = await apiFetch<unknown>(
    `/conversations/${id}/messages${qs.length > 0 ? `?${qs}` : ''}`,
    {
      auth: true,
    },
  );
  if (!Array.isArray(raw)) throw badShape('消息响应非数组');
  return raw.map(parseMessageView);
}

/**
 * 向新翻页锚（修复环 I-1 语义钉）：core listMessages=after_seq 独占下界+seq 升序=**向新翻页**
 * （无向旧面）——首页（缺省 after_seq）=会话**最早**一页（缺省 50 条），追加页锚=已载末条 seq
 * （拉到的是**更新**的消息）。空页无锚不可翻（null——首拉前/空会话）。
 */
export function nextPageAfterSeq(messages: readonly MessageView[]): number | null {
  if (messages.length === 0) return null;
  return messages[messages.length - 1]!.seq;
}

/** POST /rooms/{session_id}/close：律师端关房（无请求体——幂等键=路径参；
 *  409 NOT_OPEN=房间已终态、404=未开房、403=非本场律师） */
export async function closeRoom(sessionId: number): Promise<RoomClosedResult> {
  const id = assertPathId(sessionId, 'session_id', '场次号参数有误，请检查后重试');
  const raw = await apiFetch<unknown>(`/rooms/${id}/close`, { method: 'POST', auth: true });
  if (typeof raw !== 'object' || raw === null) throw badShape('关房响应非对象');
  const closedAt = (raw as Record<string, unknown>)['closed_at'];
  if (!isIsoString(closedAt)) throw badShape('closed_at 非时刻');
  return { closed_at: closedAt };
}

/** POST /sessions/{session_id}/cancel {role:"lawyer"}：律师取消（D4 §5 双角色面律师支；
 *  role 恒字面 'lawyer'（JWT 激活角色须一致——user token 打本面 403 E_ROLE_FORBIDDEN）；
 *  ≥24h=直接全退+信用-10 / <24h=H3 审批工单（result=PENDING_APPROVAL）） */
export async function cancelSessionAsLawyer(
  sessionId: number,
  reason?: string,
): Promise<SessionCancelResult> {
  const id = assertPathId(sessionId, 'session_id', '场次号参数有误，请检查后重试');
  if (reason !== undefined) {
    if (
      typeof reason !== 'string' ||
      reason.length === 0 ||
      reason.length > CANCEL_REASON_MAX_LEN
    ) {
      throw localReject(
        `reason 须为 1-${CANCEL_REASON_MAX_LEN} 字符字符串`,
        `取消理由须 1-${CANCEL_REASON_MAX_LEN} 字`,
      );
    }
  }
  const body: Record<string, unknown> = { role: 'lawyer' };
  if (reason !== undefined) body['reason'] = reason;
  const raw = await apiFetch<unknown>(`/sessions/${id}/cancel`, {
    method: 'POST',
    body,
    auth: true,
  });
  return parseSessionCancelResult(raw);
}
