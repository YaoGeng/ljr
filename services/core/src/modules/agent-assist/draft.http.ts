/**
 * E1 HTTP 面共用件（§5 契约词汇 snake_case）：只做「形状→领域入参」搬运，错误映射经
 * AppHttpExceptionFilter（全仓唯一过滤器纪律）。cancellation.http/one-on-one.http 同形纯函数件。
 */
import { AppError, ErrorCode } from '@ljr/shared';
import {
  isDraftAction,
  isDraftStatus,
  type DraftActionInput,
  type DraftStatus,
} from './draft.types';

function parsePositiveIntParam(raw: string, field: string): number {
  if (!/^\d+$/.test(raw)) {
    throw new AppError(ErrorCode.InvalidArgument, `${field} 须为十进制正整数：${raw}`);
  }
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new AppError(ErrorCode.InvalidArgument, `${field} 须为正整数：${raw}`);
  }
  return n;
}

/** POST /drafts/{id}/action 路径参数（draft_id） */
export function parseDraftIdParam(raw: string): number {
  return parsePositiveIntParam(raw, 'draft_id');
}

/**
 * POST /drafts/{id}/action 请求体：{action: send|edit_send|discard, edited_content?}
 * （§5 逐字）。edited_content 仅 edit_send 可携带且须非空字符串（send/discard 携带=400）；
 * 长度护栏=sendMessage 链路单点（D5 I-1 同一 400 出口，不重复设阈）。
 */
export function parseDraftActionBody(body: Record<string, unknown>): DraftActionInput {
  const action = body['action'];
  if (typeof action !== 'string' || !isDraftAction(action)) {
    throw new AppError(
      ErrorCode.InvalidArgument,
      `action 须为 send|edit_send|discard，收到：${JSON.stringify(action)}`,
    );
  }
  const hasEdited = Object.prototype.hasOwnProperty.call(body, 'edited_content');
  if (action === 'edit_send') {
    const edited = body['edited_content'];
    if (!hasEdited || typeof edited !== 'string' || edited.length === 0) {
      throw new AppError(ErrorCode.InvalidArgument, 'edit_send 须携带非空字符串 edited_content');
    }
    return { action, editedContent: edited };
  }
  if (hasEdited) {
    throw new AppError(
      ErrorCode.InvalidArgument,
      `edited_content 仅 edit_send 可携带（action=${action}）`,
    );
  }
  return { action };
}

/** GET /agent/drafts?room_id=&status= 查询解析（断线补拉面——口径见 draft.service.listDrafts） */
export function parseDraftListQuery(query: { room_id?: string; status?: string }): {
  roomId?: number;
  status?: DraftStatus;
} {
  let roomId: number | undefined;
  if (query.room_id !== undefined && query.room_id !== '') {
    roomId = parsePositiveIntParam(query.room_id, 'room_id');
  }
  let status: DraftStatus | undefined;
  if (query.status !== undefined && query.status !== '') {
    if (!isDraftStatus(query.status)) {
      throw new AppError(
        ErrorCode.InvalidArgument,
        `status 须为 PENDING|SENT|EDITED_SENT|DISCARDED|EXPIRED，收到：${query.status}`,
      );
    }
    status = query.status;
  }
  return { roomId, status };
}
