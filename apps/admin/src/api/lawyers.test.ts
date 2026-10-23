import { beforeEach, describe, expect, it } from 'bun:test';
import { setApiBaseUrl } from './config';
import { AdminApiError, getAccessToken, setAccessToken, __resetClientForTest } from './client';
import {
  LAWYER_AUDIT_ACTIONS,
  LAWYER_AUDIT_ACTIONS_BY_STATUS,
  LAWYER_STATUS_LABELS,
  WORKBENCH_STATUS_VALUES,
  auditLawyer,
  fetchLawyerProfile,
  formatDateTime,
  formatRate,
  formatSlaRemaining,
  listLawyers,
  resumeLawyer,
  suspendLawyer,
  validateAuditReason,
  validateSuspendReason,
  type WorkbenchListResult,
} from './lawyers';

// bun test 同进程串文件：隔离他文件残留的 env 基址与 token（dashboard.test.ts 同款形态）
beforeEach(() => {
  __resetClientForTest();
  setApiBaseUrl();
  delete process.env.VITE_API_BASE;
});

/** fetch 桩：捕获请求并回放固定响应（dashboard.test.ts 同款形态） */
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

/** 工作台出参样本（core ops/lawyer-admin.service.ts WorkbenchListResult 形状） */
const LIST_FIXTURE: WorkbenchListResult = {
  items: [
    {
      id: 7,
      lawyer_user_id: 42,
      audit_status: 'SUBMITTED',
      firm_name: '律聚人联营律师事务所（夹具）',
      material_version: 1,
      submitted_at: '2026-10-23T02:00:00.000Z',
      sla_due_at: '2026-10-28T02:00:00.000Z',
      sla_remaining_ms: -3600_000,
      sla_overdue: true,
    },
    {
      id: 8,
      lawyer_user_id: 43,
      audit_status: 'IN_REVIEW',
      firm_name: null,
      material_version: 2,
      submitted_at: null,
      sla_due_at: null,
      sla_remaining_ms: null,
      sla_overdue: false,
    },
  ],
  total: 2,
  page: 1,
  page_size: 20,
};

describe('H1 律师与资质审核 API 层（M3-W3 T2：/admin/lawyers 五端点）', () => {
  it('listLawyers：缺省=无查询串（服务端审核队列语义）；status/page 逐字透传 + Bearer 注入 + 出参形状直通', async () => {
    setAccessToken('jwt-admin');
    let seen = stubFetch(LIST_FIXTURE);
    const plain = await listLawyers();
    expect(seen[0]?.url).toBe('/admin/lawyers');
    expect(plain.items[0]?.sla_overdue).toBe(true);
    expect(plain.items[1]?.sla_remaining_ms).toBeNull();
    expect(plain.page_size).toBe(20);

    seen = stubFetch(LIST_FIXTURE);
    await listLawyers('SUBMITTED', 3);
    expect(seen[0]?.url).toBe('/admin/lawyers?status=SUBMITTED&page=3');
    const headers = seen[0]?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer jwt-admin');
  });

  it('auditLawyer：action 词汇逐字透传；reject→reject_reason 键、suspend→reason 键（载荷映射单源）', async () => {
    setAccessToken('jwt-admin');
    let seen = stubFetch({ status: 'IN_REVIEW' });
    await auditLawyer(7, 'claim');
    expect(seen[0]?.url).toBe('/admin/lawyers/7/audit');
    expect(seen[0]?.init.method).toBe('POST');
    expect(JSON.parse(String(seen[0]?.init.body))).toEqual({ action: 'claim' });

    seen = stubFetch({ status: 'REJECTED' });
    await auditLawyer(7, 'reject', '材料不清晰');
    expect(JSON.parse(String(seen[0]?.init.body))).toEqual({
      action: 'reject',
      reject_reason: '材料不清晰',
    });

    seen = stubFetch({ status: 'SUSPENDED' });
    await auditLawyer(7, 'suspend', '资质存疑待复核');
    expect(JSON.parse(String(seen[0]?.init.body))).toEqual({
      action: 'suspend',
      reason: '资质存疑待复核',
    });
  });

  it('suspendLawyer/resumeLawyer：专端点形态（{reason} 体 / 无体）', async () => {
    setAccessToken('jwt-admin');
    let seen = stubFetch({ status: 'SUSPENDED' });
    await suspendLawyer(9, '违规执业');
    expect(seen[0]?.url).toBe('/admin/lawyers/9/suspend');
    expect(JSON.parse(String(seen[0]?.init.body))).toEqual({ reason: '违规执业' });

    seen = stubFetch({ status: 'PASSED' });
    await resumeLawyer(9);
    expect(seen[0]?.url).toBe('/admin/lawyers/9/resume');
    expect(seen[0]?.init.body).toBeUndefined();
  });

  it('fetchLawyerProfile：缺省无窗口参数（服务端缺省近 30 天）；from/to 成对透传', async () => {
    setAccessToken('jwt-admin');
    let seen = stubFetch({
      qualification: {
        id: 7,
        lawyer_user_id: 42,
        audit_status: 'SUBMITTED',
        firm_name: null,
        firm_id: null,
        city: '北京',
        material_version: 1,
        submitted_at: '2026-10-23T02:00:00.000Z',
        audited_at: null,
        auditor_id: null,
      },
      merchants: [],
      credit: { score: 100, recent_events: [], restrictions: [] },
      session_stats: { enroll_rate: null, group_rate: null, attendance_rate: null, ooo_rate: null },
      session_stats_window: { from: '2026-09-23', to: '2026-10-23' },
    });
    const profile = await fetchLawyerProfile(7);
    expect(seen[0]?.url).toBe('/admin/lawyers/7/profile');
    expect(profile.credit.score).toBe(100);
    expect(profile.session_stats.group_rate).toBeNull();

    seen = stubFetch(profile);
    await fetchLawyerProfile(7, '2026-09-01', '2026-09-30');
    expect(seen[0]?.url).toBe('/admin/lawyers/7/profile?from=2026-09-01&to=2026-09-30');
  });

  it('错误归一：409 状态冲突 → AdminApiError（code 透传 + 映射文案）', async () => {
    setAccessToken('jwt-admin');
    stubFetch({ code: 'E_STATE_ILLEGAL_TRANSITION', message: 'SUBMITTED → PASSED 未定义' }, 409);
    let caught: unknown;
    try {
      await auditLawyer(7, 'approve');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AdminApiError);
    const apiErr = caught as AdminApiError;
    expect(apiErr.code).toBe('E_STATE_ILLEGAL_TRANSITION');
    expect(apiErr.httpStatus).toBe(409);
    expect(apiErr.message).toContain('请刷新列表后重试');
    expect(getAccessToken()).toBe('jwt-admin'); // 409 非 401：不触发登出拦截
  });
});

describe('审核动作事由防呆（对照 parseAuditActionBody/parseSuspendBody 实码规则）', () => {
  it('reject：reject_reason 必填 1-1000 字；空/空白/超长拒绝', () => {
    expect(validateAuditReason('reject', '').ok).toBe(false);
    expect(validateAuditReason('reject', '   ').ok).toBe(false);
    expect(validateAuditReason('reject', 'a'.repeat(1001)).ok).toBe(false);
    expect(validateAuditReason('reject', '材料不清晰，请补充执业证照片').ok).toBe(true);
    expect(validateAuditReason('reject', 'a'.repeat(1000)).ok).toBe(true);
  });

  it('suspend：reason 必填 1-256 字；其余动作无事由恒 ok', () => {
    expect(validateAuditReason('suspend', '').ok).toBe(false);
    expect(validateAuditReason('suspend', '   ').ok).toBe(false);
    expect(validateAuditReason('suspend', 'a'.repeat(257)).ok).toBe(false);
    expect(validateAuditReason('suspend', '资质存疑').ok).toBe(true);
    for (const a of ['claim', 'approve', 'resume'] as const) {
      expect(validateAuditReason(a, '').ok).toBe(true);
    }
    // suspend 专端点（parseSuspendBody 同规则 1-256）
    expect(validateSuspendReason('')).toEqual({
      ok: false,
      error: expect.stringContaining('停用'),
    });
    expect(validateSuspendReason('a'.repeat(257)).ok).toBe(false);
    expect(validateSuspendReason('违规执业，暂停接单').ok).toBe(true);
  });

  it('防呆错误附用户可读文案（reject/suspend 分开提示）', () => {
    const r = validateAuditReason('reject', '');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('驳回');
    const s = validateAuditReason('suspend', '');
    expect(s.ok).toBe(false);
    expect(s.error).toContain('停用');
  });
});

describe('状态映射表与词汇（单源纪律）', () => {
  it('status→中文覆盖工作台五值 + DRAFT 防御位（core lawyer.machine 值域）', () => {
    expect(LAWYER_STATUS_LABELS.SUBMITTED).toBe('待审核');
    expect(LAWYER_STATUS_LABELS.IN_REVIEW).toBe('审核中');
    expect(LAWYER_STATUS_LABELS.PASSED).toBe('已通过');
    expect(LAWYER_STATUS_LABELS.REJECTED).toBe('已驳回');
    expect(LAWYER_STATUS_LABELS.SUSPENDED).toBe('已停用');
    expect(LAWYER_STATUS_LABELS.DRAFT).toBeDefined();
  });

  it('工作台筛选值域/审核动作词汇与 core 实码序逐字一致（lawyer-admin.http/ lawyer.http）', () => {
    expect([...WORKBENCH_STATUS_VALUES]).toEqual([
      'SUBMITTED',
      'IN_REVIEW',
      'PASSED',
      'REJECTED',
      'SUSPENDED',
    ]);
    expect([...LAWYER_AUDIT_ACTIONS]).toEqual(['claim', 'approve', 'reject', 'suspend', 'resume']);
  });

  it('audit 弹层按状态可达动作集（T8 死动作裁剪）：SUBMITTED=[claim]、IN_REVIEW=[approve,reject]', () => {
    // 表值锁定（lawyer.machine 八边：SUBMITTED→IN_REVIEW=claim；IN_REVIEW→PASSED|REJECTED=
    // approve|reject——核差注记见 lawyers.ts 头注：resume 经 ACTION_TO_STATUS 目标态碰撞
    // 在 guard 层可走通但属 core 侧病态宽松位，UI 不暴露）
    expect(LAWYER_AUDIT_ACTIONS_BY_STATUS.SUBMITTED).toEqual(['claim']);
    expect(LAWYER_AUDIT_ACTIONS_BY_STATUS.IN_REVIEW).toEqual(['approve', 'reject']);
    // 表内动作不得越出 A3a 五枚词汇（越界=发明字段，词汇纪律）
    for (const actions of Object.values(LAWYER_AUDIT_ACTIONS_BY_STATUS)) {
      for (const a of actions) {
        expect(LAWYER_AUDIT_ACTIONS).toContain(a);
      }
    }
  });
});

describe('SLA / 时间 / 比率格式化（R-01 展示口径）', () => {
  it('formatSlaRemaining：正=剩、负=超期、null=防御位破折号', () => {
    expect(formatSlaRemaining(null)).toBe('—');
    expect(formatSlaRemaining(2 * 86_400_000 + 5 * 3_600_000)).toBe('剩 2 天 5 时');
    expect(formatSlaRemaining(-(86_400_000 + 2 * 3_600_000))).toBe('超期 1 天 2 时');
    expect(formatSlaRemaining(30 * 60_000)).toBe('剩 30 分');
  });

  it('formatDateTime：ISO→本地形态、null/非法=破折号', () => {
    expect(formatDateTime(null)).toBe('—');
    const iso = new Date(2026, 9, 23, 14, 5).toISOString(); // 本地时区构造→回显同刻
    expect(formatDateTime(iso)).toBe('2026-10-23 14:05');
    expect(formatDateTime('not-a-date')).toBe('—');
  });

  it('formatRate：null=缺数据破折号（非 0，不假装数据）；数值=百分比', () => {
    expect(formatRate(null)).toBe('—');
    expect(formatRate(0.3533)).toBe('35.33%');
    expect(formatRate(1)).toBe('100.00%');
  });
});
