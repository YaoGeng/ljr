import { beforeEach, describe, expect, it } from 'bun:test';
import { ErrorCode } from '@ljr/shared';
import { isAppApiError, setAccessToken, __resetClientForTest } from './client';
import { setApiBaseUrl } from './config';
import {
  attendanceStatusCopy,
  cancelSessionAsLawyer,
  closeRoom,
  fetchConversationMessages,
  fetchRoomAttendance,
  fetchRoomNotice,
  lawyerCancelResultNote,
  nextPageAfterSeq,
  senderRoleCopy,
  type MessageView,
} from './lawyer-board';
import { jsonResponse, stubFetch } from './test-helpers';

/** D3 出席行实文样例（AttendanceView：§5 逐字 {user_id, role, status, join_at}） */
const ATTENDANCE_ROW = {
  user_id: 75,
  role: 'user',
  status: 'NORMAL',
  join_at: '2026-10-16T12:31:04.000Z',
};

/** D5 房间须知实文样例（RoomNoticeView：ruleKey/version/effectiveAt/content 三段） */
const NOTICE = {
  ruleKey: 'room_notice',
  version: 3,
  effectiveAt: '2026-10-01T00:00:00.000Z',
  content: {
    title: '房间须知',
    paragraphs: [
      '本房间咨询仅供法律信息参考，不构成正式法律意见。',
      '请勿在房间内发送身份证件照片。',
    ],
    disclosures: ['平台不对律师发言内容承担担保责任'],
  },
};

/** D5 消息行实文样例（MessageView：十一键；mention/source_msg_id 可 null） */
const MESSAGE = {
  message_id: 12,
  conversation_id: 5,
  seq: 120,
  sender_id: 75,
  sender_role: 'user',
  type: 'text',
  content: '劳动合同被单方变更，可以主张什么？',
  mention: null,
  risk_flag: 'PASS',
  source_msg_id: null,
  created_at: '2026-10-16T12:32:10.000Z',
};

beforeEach(() => {
  __resetClientForTest();
  setApiBaseUrl('http://core.test');
});

describe('D3 出席名单（GET /rooms/:room_id/attendance）', () => {
  it('数组解析通过（join_at=null 行含）+ Bearer 注入 + URL', async () => {
    setAccessToken('jwt-lawyer');
    const seen = stubFetch([
      jsonResponse(200, [
        ATTENDANCE_ROW,
        { ...ATTENDANCE_ROW, user_id: 1, role: 'lawyer', join_at: null },
      ]),
    ]);
    const rows = await fetchRoomAttendance(9);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.status).toBe('NORMAL');
    expect(rows[0]?.join_at).toBe('2026-10-16T12:31:04.000Z');
    expect(rows[1]?.join_at).toBeNull();
    expect(seen[0]?.url).toBe('http://core.test/rooms/9/attendance');
    const init = seen[0]?.init as RequestInit & { headers: Record<string, string> };
    expect(init.headers.Authorization).toBe('Bearer jwt-lawyer');
  });

  it('404 E_NOT_FOUND（房间不存在/未开房）→ 映射文案', async () => {
    setAccessToken('jwt-lawyer');
    stubFetch([jsonResponse(404, { code: ErrorCode.NotFound, message: '房间不存在：9' })]);
    const err = (await fetchRoomAttendance(9).then(
      () => null,
      (e: unknown) => e,
    )) as { code: string; message: string };
    expect(isAppApiError(err)).toBe(true);
    expect(err.message).toBe('请求的内容不存在');
  });

  it('形状非法（status 缺键）→ CLIENT_BAD_RESPONSE', async () => {
    setAccessToken('jwt-lawyer');
    const noStatus = JSON.parse(
      JSON.stringify(ATTENDANCE_ROW, (k, v) => (k === 'status' ? undefined : v)),
    );
    stubFetch([jsonResponse(200, [noStatus])]);
    const err = (await fetchRoomAttendance(9).then(
      () => null,
      (e: unknown) => e,
    )) as { code: string };
    expect(err.code).toBe('CLIENT_BAD_RESPONSE');
  });

  it('本地前置校验：非正整数 room_id → CLIENT_BAD_REQUEST 不发请求', async () => {
    const seen = stubFetch([]);
    for (const bad of [0, -1, 2.5, Number.NaN]) {
      const err = (await fetchRoomAttendance(bad).then(
        () => null,
        (e: unknown) => e,
      )) as { code: string };
      expect(err.code).toBe('CLIENT_BAD_REQUEST');
    }
    expect(seen).toHaveLength(0);
  });
});

describe('D5 房间须知（GET /rooms/:id/notice）', () => {
  it('解析通过（content 三段）+ 无 Bearer（无鉴权公开只读面——core 实文沿 ops 面先例）', async () => {
    setAccessToken('jwt-lawyer');
    const seen = stubFetch([jsonResponse(200, NOTICE)]);
    const view = await fetchRoomNotice(9);
    expect(view.ruleKey).toBe('room_notice');
    expect(view.version).toBe(3);
    expect(view.content.paragraphs).toHaveLength(2);
    expect(seen[0]?.url).toBe('http://core.test/rooms/9/notice');
    const init = seen[0]?.init as RequestInit & { headers: Record<string, string> };
    expect(init.headers.Authorization).toBeUndefined();
  });

  it('形状非法（paragraphs 非字符串数组）→ CLIENT_BAD_RESPONSE', async () => {
    stubFetch([
      jsonResponse(200, { ...NOTICE, content: { ...NOTICE.content, paragraphs: '段落' } }),
    ]);
    const err = (await fetchRoomNotice(9).then(
      () => null,
      (e: unknown) => e,
    )) as { code: string };
    expect(err.code).toBe('CLIENT_BAD_RESPONSE');
  });

  it('本地前置校验：room_id 非正整数 → CLIENT_BAD_REQUEST', async () => {
    const seen = stubFetch([]);
    const err = (await fetchRoomNotice(0).then(
      () => null,
      (e: unknown) => e,
    )) as { code: string };
    expect(err.code).toBe('CLIENT_BAD_REQUEST');
    expect(seen).toHaveLength(0);
  });
});

describe('D5 会话消息只读（GET /conversations/:id/messages）', () => {
  it('after_seq/limit 查询串逐字 + Bearer 注入 + 行解析（mention=null）', async () => {
    setAccessToken('jwt-lawyer');
    const seen = stubFetch([jsonResponse(200, [MESSAGE])]);
    const rows = await fetchConversationMessages(5, { after_seq: 119, limit: 50 });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.seq).toBe(120);
    expect(rows[0]?.mention).toBeNull();
    expect(seen[0]?.url).toBe('http://core.test/conversations/5/messages?after_seq=119&limit=50');
    const init = seen[0]?.init as RequestInit & { headers: Record<string, string> };
    expect(init.headers.Authorization).toBe('Bearer jwt-lawyer');
  });

  it('缺省入参=无查询串（after_seq=0 语义等价缺省不显式携带）', async () => {
    setAccessToken('jwt-lawyer');
    const seen = stubFetch([jsonResponse(200, [])]);
    await fetchConversationMessages(5);
    expect(seen[0]?.url).toBe('http://core.test/conversations/5/messages');
  });

  it('limit>200 本地静默收窄为 200（core MAX_PULL_LIMIT 镜像——core 侧同款静默收窄不报错）', async () => {
    setAccessToken('jwt-lawyer');
    const seen = stubFetch([jsonResponse(200, [])]);
    await fetchConversationMessages(5, { limit: 500 });
    expect(seen[0]?.url).toBe('http://core.test/conversations/5/messages?limit=200');
  });

  it('向新翻页语义（修复环 I-1）：首次=会话最早一页（无查询串），追加=已载末条 seq 为 after_seq 的更新页', async () => {
    setAccessToken('jwt-lawyer');
    const firstPage = Array.from({ length: 50 }, (_, i) => ({
      ...MESSAGE,
      message_id: i + 1,
      seq: i + 1,
    }));
    const secondPage = [{ ...MESSAGE, message_id: 51, seq: 51 }];
    const seen = stubFetch([jsonResponse(200, firstPage), jsonResponse(200, secondPage)]);
    // 首页：缺省入参=从头（最早）拉取，seq 升序
    const page1 = await fetchConversationMessages(5);
    expect(page1).toHaveLength(50);
    expect(page1[0]?.seq).toBe(1);
    expect(page1[49]?.seq).toBe(50);
    expect(seen[0]?.url).toBe('http://core.test/conversations/5/messages');
    // 追加页：after_seq=已载末条 seq（独占下界）→ 拉到的是更新的消息（seq 51）
    const anchor = nextPageAfterSeq(page1);
    expect(anchor).toBe(50);
    const page2 = await fetchConversationMessages(5, { after_seq: anchor ?? 0 });
    expect(page2[0]?.seq).toBe(51);
    expect(seen[1]?.url).toBe('http://core.test/conversations/5/messages?after_seq=50');
  });

  it('形状非法（seq 非正整数）→ CLIENT_BAD_RESPONSE', async () => {
    setAccessToken('jwt-lawyer');
    stubFetch([jsonResponse(200, [{ ...MESSAGE, seq: 0 }])]);
    const err = (await fetchConversationMessages(5).then(
      () => null,
      (e: unknown) => e,
    )) as { code: string };
    expect(err.code).toBe('CLIENT_BAD_RESPONSE');
  });

  it('本地前置校验：after_seq 负数 / limit 非正整数 / 非正整数会话 id → CLIENT_BAD_REQUEST', async () => {
    const seen = stubFetch([]);
    const bads: Array<Parameters<typeof fetchConversationMessages>> = [
      [0, { after_seq: -1 }],
      [0, { limit: 0 }],
      [-3],
    ];
    for (const bad of bads) {
      const err = (await fetchConversationMessages(bad[0], bad[1] ?? {}).then(
        () => null,
        (e: unknown) => e,
      )) as { code: string };
      expect(err.code).toBe('CLIENT_BAD_REQUEST');
    }
    expect(seen).toHaveLength(0);
  });

  it('消息行类型面：MessageView 十一键齐全（type/mention/risk_flag 值域透传展示层回退）', async () => {
    setAccessToken('jwt-lawyer');
    stubFetch([
      jsonResponse(200, [
        {
          ...MESSAGE,
          message_id: 13,
          seq: 121,
          sender_role: 'lawyer',
          type: 'system',
          mention: 'lawyer',
          risk_flag: 'REVIEW',
          source_msg_id: 'draft-42',
        },
      ]),
    ]);
    const rows = (await fetchConversationMessages(5)) as MessageView[];
    expect(rows[0]?.sender_role).toBe('lawyer');
    expect(rows[0]?.mention).toBe('lawyer');
    expect(rows[0]?.risk_flag).toBe('REVIEW');
    expect(rows[0]?.source_msg_id).toBe('draft-42');
  });
});

describe('D1 关房（POST /rooms/:session_id/close）', () => {
  it('无请求体 POST（幂等键=路径参 session——core 实文 close 无请求体）→ {closed_at} 解析 + Bearer', async () => {
    setAccessToken('jwt-lawyer');
    const seen = stubFetch([jsonResponse(201, { closed_at: '2026-10-16T13:05:00.000Z' })]);
    const r = await closeRoom(43);
    expect(r.closed_at).toBe('2026-10-16T13:05:00.000Z');
    expect(seen[0]?.url).toBe('http://core.test/rooms/43/close');
    expect(seen[0]?.init.method).toBe('POST');
    expect((seen[0]?.init as RequestInit & { body?: string }).body).toBeUndefined();
    const init = seen[0]?.init as RequestInit & { headers: Record<string, string> };
    expect(init.headers.Authorization).toBe('Bearer jwt-lawyer');
  });

  it('409 E_CONFLICT（已终态 NOT_OPEN）→ 映射文案', async () => {
    setAccessToken('jwt-lawyer');
    stubFetch([
      jsonResponse(409, { code: ErrorCode.Conflict, message: '房间 1 已终态（CLOSED）' }),
    ]);
    const err = (await closeRoom(43).then(
      () => null,
      (e: unknown) => e,
    )) as { code: string; message: string };
    expect(isAppApiError(err)).toBe(true);
    expect(err.code).toBe(ErrorCode.Conflict);
    expect(err.message).toBe('操作冲突，请刷新后重试');
  });

  it('形状非法（closed_at 非字符串）→ CLIENT_BAD_RESPONSE', async () => {
    setAccessToken('jwt-lawyer');
    stubFetch([jsonResponse(201, { closed_at: 123 })]);
    const err = (await closeRoom(43).then(
      () => null,
      (e: unknown) => e,
    )) as { code: string };
    expect(err.code).toBe('CLIENT_BAD_RESPONSE');
  });

  it('本地前置校验：session_id 非正整数 → CLIENT_BAD_REQUEST 不发请求', async () => {
    const seen = stubFetch([]);
    const err = (await closeRoom(0).then(
      () => null,
      (e: unknown) => e,
    )) as { code: string };
    expect(err.code).toBe('CLIENT_BAD_REQUEST');
    expect(seen).toHaveLength(0);
  });
});

describe('D4 律师取消（POST /sessions/:session_id/cancel {role:"lawyer"}）', () => {
  it('无理由时体={role:"lawyer"} 逐字（reason 缺省空串在 core 解析）+ Bearer', async () => {
    setAccessToken('jwt-lawyer');
    const seen = stubFetch([jsonResponse(201, { result: 'CANCELLED', refund: 'FULL' })]);
    const r = await cancelSessionAsLawyer(43);
    expect(r.result).toBe('CANCELLED');
    expect(r.refund).toBe('FULL');
    expect(seen[0]?.url).toBe('http://core.test/sessions/43/cancel');
    const body = JSON.parse(
      String((seen[0]?.init as RequestInit & { body?: string }).body),
    ) as Record<string, unknown>;
    expect(body).toEqual({ role: 'lawyer' });
  });

  it('带理由时体={role,reason} 逐字', async () => {
    setAccessToken('jwt-lawyer');
    const seen = stubFetch([jsonResponse(201, { result: 'CANCELLED' })]);
    await cancelSessionAsLawyer(43, '突发健康原因');
    const body = JSON.parse(
      String((seen[0]?.init as RequestInit & { body?: string }).body),
    ) as Record<string, unknown>;
    expect(body).toEqual({ role: 'lawyer', reason: '突发健康原因' });
  });

  it('result=PENDING_APPROVAL（<24h 审批支）+ approval 工单锚解析', async () => {
    setAccessToken('jwt-lawyer');
    stubFetch([
      jsonResponse(201, {
        result: 'PENDING_APPROVAL',
        approval: { ticket_id: 88, sla_due: '2026-10-24T10:00:00.000Z' },
      }),
    ]);
    const r = await cancelSessionAsLawyer(43);
    expect(r.result).toBe('PENDING_APPROVAL');
    expect(r.approval?.ticket_id).toBe(88);
  });

  it('幂等重放位（deduplicated）解析', async () => {
    setAccessToken('jwt-lawyer');
    stubFetch([jsonResponse(201, { result: 'CANCELLED', refund: 'FULL', deduplicated: true })]);
    const r = await cancelSessionAsLawyer(43);
    expect(r.deduplicated).toBe(true);
  });

  it('result 越值域（未知 result）→ CLIENT_BAD_RESPONSE（动作出参判别值不放行）', async () => {
    setAccessToken('jwt-lawyer');
    stubFetch([jsonResponse(201, { result: 'WHATEVER' })]);
    const err = (await cancelSessionAsLawyer(43).then(
      () => null,
      (e: unknown) => e,
    )) as { code: string };
    expect(err.code).toBe('CLIENT_BAD_RESPONSE');
  });

  it('409 E_CONFLICT（NOT_CANCELLABLE 终态）→ 映射文案', async () => {
    setAccessToken('jwt-lawyer');
    stubFetch([
      jsonResponse(409, { code: ErrorCode.Conflict, message: '场次不可取消（NOT_CANCELLABLE）' }),
    ]);
    const err = (await cancelSessionAsLawyer(43).then(
      () => null,
      (e: unknown) => e,
    )) as { code: string; message: string };
    expect(err.code).toBe(ErrorCode.Conflict);
    expect(err.message).toBe('操作冲突，请刷新后重试');
  });

  it('本地前置校验：reason >200 字符 → CLIENT_BAD_REQUEST（core parseCancelReason 镜像）', async () => {
    const seen = stubFetch([]);
    const err = (await cancelSessionAsLawyer(43, '长'.repeat(201)).then(
      () => null,
      (e: unknown) => e,
    )) as { code: string };
    expect(err.code).toBe('CLIENT_BAD_REQUEST');
    expect(seen).toHaveLength(0);
  });
});

describe('文案映射（出席状态 / 发送者角色 / 取消结果——单源表，未知回退原码）', () => {
  it('attendanceStatusCopy：NORMAL/LATE/ABSENT 三态 + 未知回退原码', () => {
    expect(attendanceStatusCopy('NORMAL')).toBe('正常到场');
    expect(attendanceStatusCopy('LATE')).toBe('迟到（旁听）');
    expect(attendanceStatusCopy('ABSENT')).toBe('缺席');
    expect(attendanceStatusCopy('WEIRD')).toBe('WEIRD');
  });

  it('senderRoleCopy：user/lawyer/agent/system 四值 + 未知回退原码', () => {
    expect(senderRoleCopy('user')).toBe('用户');
    expect(senderRoleCopy('lawyer')).toBe('律师');
    expect(senderRoleCopy('agent')).toBe('AI 辅助');
    expect(senderRoleCopy('system')).toBe('系统');
    expect(senderRoleCopy('robot')).toBe('robot');
  });

  it('lawyerCancelResultNote：CANCELLED（含幂等位+30 天窗口句）/PENDING_APPROVAL/APPROVAL_REJECTED 三支', () => {
    expect(lawyerCancelResultNote({ result: 'CANCELLED', refund: 'FULL' })).toContain('信用 -10');
    expect(lawyerCancelResultNote({ result: 'CANCELLED', refund: 'FULL' })).toContain('30 天内');
    expect(
      lawyerCancelResultNote({ result: 'CANCELLED', refund: 'FULL', deduplicated: true }),
    ).toContain('重复提交');
    expect(lawyerCancelResultNote({ result: 'PENDING_APPROVAL' })).toContain('平台审批');
    expect(lawyerCancelResultNote({ result: 'APPROVAL_REJECTED' })).toContain('驳回');
  });

  it('nextPageAfterSeq：已载末条 seq 为向新翻页锚；空页无锚=null（修复环 I-1）', () => {
    const page = [
      { ...MESSAGE, seq: 10 },
      { ...MESSAGE, seq: 12 },
    ] as MessageView[];
    expect(nextPageAfterSeq(page)).toBe(12);
    expect(nextPageAfterSeq([])).toBeNull();
  });
});
