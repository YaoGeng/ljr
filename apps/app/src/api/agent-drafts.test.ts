import { beforeEach, describe, expect, it } from 'bun:test';
import { ErrorCode } from '@ljr/shared';
import { isAppApiError, setAccessToken, __resetClientForTest } from './client';
import { setApiBaseUrl } from './config';
import {
  agentDraftActionNote,
  agentDraftStatusCopy,
  fetchAgentDrafts,
  parseAgentDraftsRoomParam,
  restorePlaceholders,
  sendDraftAction,
  sortAgentDraftsPendingFirst,
  type AgentDraftView,
} from './agent-drafts';
import { jsonResponse, stubFetch } from './test-helpers';

/**
 * E1 Agent 草稿面（M3-W2 T6）：GET /agent/drafts + POST /drafts/:id/action 契约消费用例。
 * 样例=core DraftView/toDraftView 实文形态（draft.types.ts 逐字段）。
 */

/** DraftView 实文样例（PENDING 行：question_digest 占位符形态 + content 含 R-04 标记） */
const DRAFT = {
  draft_id: 7,
  room_id: 1,
  conversation_id: 1,
  target_user_id: 75,
  question_digest: '[姓名]被公司拖欠工资三个月怎么办？',
  content:
    '【AI 辅助，仅供参考】\n关于用户问题「[姓名]被拖欠工资」…以上由 AI 生成，请律师审查修改后使用。',
  placeholders: { '[姓名]': '周女士', '[地址]': '北京市朝阳区' },
  status: 'PENDING',
  answered: false,
  latency_ms: 42,
  segment_ms: { sanitize: 3, intent: 1, rag: 8, llm: 30 },
  created_at: '2026-10-16T12:32:20.000Z',
  replied_at: null,
};

/** 已处理行样例（latency/segment 可 null + replied_at 非空——core 列可空形态） */
const DRAFT_SENT = {
  ...DRAFT,
  draft_id: 6,
  status: 'SENT',
  answered: true,
  latency_ms: null,
  segment_ms: null,
  replied_at: '2026-10-16T12:33:02.000Z',
};

beforeEach(() => {
  __resetClientForTest();
  setApiBaseUrl('http://core.test');
});

describe('E1 草稿列表（GET /agent/drafts）', () => {
  it('room_id+status 查询串逐字 + Bearer 注入 + 行全键解析（placeholders/segment_ms/answered/replied_at=null）', async () => {
    setAccessToken('jwt-lawyer');
    const seen = stubFetch([jsonResponse(200, [DRAFT])]);
    const rows = await fetchAgentDrafts({ room_id: 1, status: 'PENDING' });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.draft_id).toBe(7);
    expect(rows[0]?.question_digest).toBe('[姓名]被公司拖欠工资三个月怎么办？');
    expect(rows[0]?.content).toContain('【AI 辅助，仅供参考】');
    expect(rows[0]?.placeholders).toEqual({ '[姓名]': '周女士', '[地址]': '北京市朝阳区' });
    expect(rows[0]?.segment_ms).toEqual({ sanitize: 3, intent: 1, rag: 8, llm: 30 });
    expect(rows[0]?.latency_ms).toBe(42);
    expect(rows[0]?.replied_at).toBeNull();
    expect(seen[0]?.url).toBe('http://core.test/agent/drafts?room_id=1&status=PENDING');
    const init = seen[0]?.init as RequestInit & { headers: Record<string, string> };
    expect(init.headers.Authorization).toBe('Bearer jwt-lawyer');
  });

  it('缺省入参=无查询串（全态拉取——PENDING 置顶由前端排序承载）', async () => {
    setAccessToken('jwt-lawyer');
    const seen = stubFetch([jsonResponse(200, [])]);
    await fetchAgentDrafts();
    expect(seen[0]?.url).toBe('http://core.test/agent/drafts');
  });

  it('终态行解析（latency_ms/segment_ms=null + replied_at 非空）', async () => {
    setAccessToken('jwt-lawyer');
    stubFetch([jsonResponse(200, [DRAFT_SENT])]);
    const rows = await fetchAgentDrafts({ room_id: 1 });
    expect(rows[0]?.status).toBe('SENT');
    expect(rows[0]?.latency_ms).toBeNull();
    expect(rows[0]?.segment_ms).toBeNull();
    expect(rows[0]?.replied_at).toBe('2026-10-16T12:33:02.000Z');
  });

  it('403 E_ROLE_FORBIDDEN（非房间成员——listDrafts fail-closed 成员门）→ 码透传', async () => {
    setAccessToken('jwt-lawyer');
    stubFetch([jsonResponse(403, { code: ErrorCode.RoleForbidden, message: '非会话成员' })]);
    const err = (await fetchAgentDrafts({ room_id: 1 }).then(
      () => null,
      (e: unknown) => e,
    )) as { code: string };
    expect(isAppApiError(err)).toBe(true);
    expect(err.code).toBe(ErrorCode.RoleForbidden);
  });

  it('形状非法（status 越五值域）→ CLIENT_BAD_RESPONSE', async () => {
    setAccessToken('jwt-lawyer');
    stubFetch([jsonResponse(200, [{ ...DRAFT, status: 'WEIRD' }])]);
    const err = (await fetchAgentDrafts({ room_id: 1 }).then(
      () => null,
      (e: unknown) => e,
    )) as { code: string };
    expect(err.code).toBe('CLIENT_BAD_RESPONSE');
  });

  it('形状非法（placeholders 值非字符串 / segment_ms 缺键）→ CLIENT_BAD_RESPONSE', async () => {
    setAccessToken('jwt-lawyer');
    stubFetch([jsonResponse(200, [{ ...DRAFT, placeholders: { '[姓名]': 12 } }])]);
    const err1 = (await fetchAgentDrafts({ room_id: 1 }).then(
      () => null,
      (e: unknown) => e,
    )) as { code: string };
    expect(err1.code).toBe('CLIENT_BAD_RESPONSE');
    stubFetch([jsonResponse(200, [{ ...DRAFT, segment_ms: { sanitize: 3, intent: 1, rag: 8 } }])]);
    const err2 = (await fetchAgentDrafts({ room_id: 1 }).then(
      () => null,
      (e: unknown) => e,
    )) as { code: string };
    expect(err2.code).toBe('CLIENT_BAD_RESPONSE');
  });

  it('本地前置校验：room_id 非正整数 / status 越值域 → CLIENT_BAD_REQUEST 不发请求', async () => {
    const seen = stubFetch([]);
    for (const bad of [0, -1, 2.5]) {
      const err = (await fetchAgentDrafts({ room_id: bad }).then(
        () => null,
        (e: unknown) => e,
      )) as { code: string };
      expect(err.code).toBe('CLIENT_BAD_REQUEST');
    }
    const errStatus = (await fetchAgentDrafts({ status: 'WEIRD' as never }).then(
      () => null,
      (e: unknown) => e,
    )) as { code: string };
    expect(errStatus.code).toBe('CLIENT_BAD_REQUEST');
    expect(seen).toHaveLength(0);
  });
});

describe('E1 律师三动作（POST /drafts/:id/action）', () => {
  it('send：请求体逐字 {action:"send"}（无 edited_content 键）+ Bearer + 出参解析', async () => {
    setAccessToken('jwt-lawyer');
    const seen = stubFetch([
      jsonResponse(201, { draft_id: 7, status: 'SENT', deduplicated: false }),
    ]);
    const r = await sendDraftAction(7, 'send');
    expect(r).toEqual({ draft_id: 7, status: 'SENT', deduplicated: false });
    expect(seen[0]?.url).toBe('http://core.test/drafts/7/action');
    expect(seen[0]?.init.method).toBe('POST');
    const body = JSON.parse(
      String((seen[0]?.init as RequestInit & { body?: string }).body),
    ) as Record<string, unknown>;
    expect(body).toEqual({ action: 'send' });
    const init = seen[0]?.init as RequestInit & { headers: Record<string, string> };
    expect(init.headers.Authorization).toBe('Bearer jwt-lawyer');
  });

  it('edit_send：请求体逐字 {action:"edit_send", edited_content}', async () => {
    setAccessToken('jwt-lawyer');
    const seen = stubFetch([
      jsonResponse(201, { draft_id: 7, status: 'EDITED_SENT', deduplicated: false }),
    ]);
    const r = await sendDraftAction(7, 'edit_send', '修改后的回复正文');
    expect(r.status).toBe('EDITED_SENT');
    const body = JSON.parse(
      String((seen[0]?.init as RequestInit & { body?: string }).body),
    ) as Record<string, unknown>;
    expect(body).toEqual({ action: 'edit_send', edited_content: '修改后的回复正文' });
  });

  it('discard：请求体逐字 {action:"discard"}', async () => {
    setAccessToken('jwt-lawyer');
    const seen = stubFetch([
      jsonResponse(201, { draft_id: 7, status: 'DISCARDED', deduplicated: false }),
    ]);
    await sendDraftAction(7, 'discard');
    const body = JSON.parse(
      String((seen[0]?.init as RequestInit & { body?: string }).body),
    ) as Record<string, unknown>;
    expect(body).toEqual({ action: 'discard' });
  });

  it('幂等重放（同动作重复提交）→ deduplicated=true 解析（core 幂等返回同态）', async () => {
    setAccessToken('jwt-lawyer');
    stubFetch([jsonResponse(201, { draft_id: 7, status: 'SENT', deduplicated: true })]);
    const r = await sendDraftAction(7, 'send');
    expect(r.deduplicated).toBe(true);
  });

  it('409 EXPIRED（非 PENDING 且无同动作留痕）→ E_CONFLICT 码透传 + 映射文案', async () => {
    setAccessToken('jwt-lawyer');
    stubFetch([
      jsonResponse(409, {
        code: ErrorCode.Conflict,
        message: '草稿 7 已终态（SENT），不可 discard（409 EXPIRED）',
      }),
    ]);
    const err = (await sendDraftAction(7, 'discard').then(
      () => null,
      (e: unknown) => e,
    )) as { code: string; message: string };
    expect(isAppApiError(err)).toBe(true);
    expect(err.code).toBe(ErrorCode.Conflict);
    expect(err.message).toBe('操作冲突，请刷新后重试');
  });

  it('出参形状非法（status 越值域 / deduplicated 非布尔）→ CLIENT_BAD_RESPONSE', async () => {
    setAccessToken('jwt-lawyer');
    stubFetch([jsonResponse(201, { draft_id: 7, status: 'WEIRD', deduplicated: false })]);
    const err1 = (await sendDraftAction(7, 'send').then(
      () => null,
      (e: unknown) => e,
    )) as { code: string };
    expect(err1.code).toBe('CLIENT_BAD_RESPONSE');
    stubFetch([jsonResponse(201, { draft_id: 7, status: 'SENT', deduplicated: 'yes' })]);
    const err2 = (await sendDraftAction(7, 'send').then(
      () => null,
      (e: unknown) => e,
    )) as { code: string };
    expect(err2.code).toBe('CLIENT_BAD_RESPONSE');
  });

  it('edited_content 前置校验（core 400 同口径）：edit_send 缺 edited_content / 空串 → CLIENT_BAD_REQUEST 不发请求', async () => {
    const seen = stubFetch([]);
    const missing = (await sendDraftAction(7, 'edit_send').then(
      () => null,
      (e: unknown) => e,
    )) as { code: string };
    expect(missing.code).toBe('CLIENT_BAD_REQUEST');
    const empty = (await sendDraftAction(7, 'edit_send', '').then(
      () => null,
      (e: unknown) => e,
    )) as { code: string };
    expect(empty.code).toBe('CLIENT_BAD_REQUEST');
    expect(seen).toHaveLength(0);
  });

  it('edited_content 前置校验：send/discard 携带 edited_content → CLIENT_BAD_REQUEST（core 400 镜像）', async () => {
    const seen = stubFetch([]);
    const asSend = (await sendDraftAction(7, 'send', '多余内容').then(
      () => null,
      (e: unknown) => e,
    )) as { code: string };
    expect(asSend.code).toBe('CLIENT_BAD_REQUEST');
    const asDiscard = (await sendDraftAction(7, 'discard', '多余内容').then(
      () => null,
      (e: unknown) => e,
    )) as { code: string };
    expect(asDiscard.code).toBe('CLIENT_BAD_REQUEST');
    expect(seen).toHaveLength(0);
  });

  it('本地前置校验：draft_id 非正整数 → CLIENT_BAD_REQUEST 不发请求', async () => {
    const seen = stubFetch([]);
    for (const bad of [0, -3, 1.5]) {
      const err = (await sendDraftAction(bad, 'send').then(
        () => null,
        (e: unknown) => e,
      )) as { code: string };
      expect(err.code).toBe('CLIENT_BAD_REQUEST');
    }
    expect(seen).toHaveLength(0);
  });
});

describe('E1 文案与纯函数（五态映射 / PENDING 置顶 / 占位符还原 / 动作回执）', () => {
  it('agentDraftStatusCopy：五态逐值 + 未知回退原码', () => {
    expect(agentDraftStatusCopy('PENDING')).toBe('待审查');
    expect(agentDraftStatusCopy('SENT')).toBe('已发送');
    expect(agentDraftStatusCopy('EDITED_SENT')).toBe('修改后发送');
    expect(agentDraftStatusCopy('DISCARDED')).toBe('已丢弃');
    expect(agentDraftStatusCopy('EXPIRED')).toBe('已失效');
    expect(agentDraftStatusCopy('WEIRD')).toBe('WEIRD');
  });

  it('sortAgentDraftsPendingFirst：PENDING 置顶 + 组内保持原相对序（core id 倒序不重排）', () => {
    const rows = [
      { ...DRAFT_SENT, draft_id: 9, status: 'DISCARDED' },
      { ...DRAFT, draft_id: 8, status: 'PENDING' },
      { ...DRAFT_SENT, draft_id: 7, status: 'SENT' },
      { ...DRAFT, draft_id: 6, status: 'PENDING' },
      { ...DRAFT_SENT, draft_id: 5, status: 'EXPIRED' },
    ] as AgentDraftView[];
    const sorted = sortAgentDraftsPendingFirst(rows);
    expect(sorted.map((d) => d.status)).toEqual([
      'PENDING',
      'PENDING',
      'DISCARDED',
      'SENT',
      'EXPIRED',
    ]);
    expect(sorted[0]?.draft_id).toBe(8);
    expect(sorted[1]?.draft_id).toBe(6);
  });

  it('restorePlaceholders：全部占位符替换为原文（含重复出现记号）+ 空映射原样返回', () => {
    const map = { '[姓名]': '周女士', '[地址]': '北京市朝阳区' };
    expect(restorePlaceholders('[姓名]在[地址]上班，[姓名]被拖欠工资', map)).toBe(
      '周女士在北京市朝阳区上班，周女士被拖欠工资',
    );
    expect(restorePlaceholders('无占位符文本', map)).toBe('无占位符文本');
    expect(restorePlaceholders('[姓名]', {})).toBe('[姓名]');
  });

  it('agentDraftActionNote：SENT/EDITED_SENT 附会话消息查看注记 + DISCARDED 支 + 幂等重放注记', () => {
    expect(agentDraftActionNote({ draft_id: 7, status: 'SENT', deduplicated: false })).toContain(
      '已发送',
    );
    expect(agentDraftActionNote({ draft_id: 7, status: 'SENT', deduplicated: false })).toContain(
      '场次看板',
    );
    expect(
      agentDraftActionNote({ draft_id: 7, status: 'EDITED_SENT', deduplicated: false }),
    ).toContain('修改后发送');
    expect(
      agentDraftActionNote({ draft_id: 7, status: 'DISCARDED', deduplicated: false }),
    ).toContain('已丢弃');
    expect(agentDraftActionNote({ draft_id: 7, status: 'SENT', deduplicated: true })).toContain(
      '幂等重放',
    );
  });
});

describe('路由参数 room_id 解析（parseAgentDraftsRoomParam——number/数字串双收，垃圾值 null）', () => {
  it('number 正整数与数字串均收（评审 I-5：string 参数不再静默降全域）', () => {
    expect(parseAgentDraftsRoomParam(7)).toBe(7);
    expect(parseAgentDraftsRoomParam('7')).toBe(7);
    expect(parseAgentDraftsRoomParam(' 12 ')).toBe(12);
  });

  it('非正整数/非数字串/其他类型 → null（忽略过滤态——屏内注记明示当前态）', () => {
    for (const bad of [0, -3, 2.5, '0', '-3', '7.5', 'abc', '', null, undefined, {}, true]) {
      expect(parseAgentDraftsRoomParam(bad)).toBeNull();
    }
  });
});
