/**
 * H1 律师与资质管理领域服务（docs/modules/H-运营后台/H1-律师与资质管理.md §2/§4/§5/§7/§8；
 * M1-W3 T10 压轴 + W2 终审 G-A 前置门关闭承载面）。
 *
 * 边界（§1/架构 §2.1）：ops 域编排面——只写 ops.audit_logs（本 schema）；状态本体在 A3a
 * （identity.lawyer_profiles 经 LawyerQualificationService 导出面，禁 join identity 表），
 * 进件状态在 A3b（FirmMerchantService 导出面）、信用快照在 G1（CreditService 导出面）、
 * 场次统计在 C1（SessionService 导出面）——跨模块取数全走服务接口，禁跨 schema join
 * （H1 §9 明文禁止 + check-schema-refs 红线）。
 *
 * 关键流程（§4）：审核操作 →（同事务）A3a 审核面 + ops.audit_logs 落行 → A3a 事件出箱
 * （LawyerAuditPassed/Suspended，生产方=A3a）→ C3 可见性/角色授予联动（R-02，W2 已闭环，
 * 本批以 isAuditPassed 翻转断言钉住本侧）。SLA（R-01）=3 工作日（lawyer-admin.sla 纯函数），
 * 超时负数展示+告警数据位（sla_overdue，H4 看板同源）。
 *
 * G-A 承载（W2 终审不可降级项）：本服务是 POST /admin/lawyers/{id}/audit 的唯一 HTTP 面
 * （A3a 的 admin 占位控制器随本批退役，路由归位 ops）——@RequireRole('admin') 守卫 +
 * @CurrentIdentity 注入 admin userId → auditWithExecutor 透传 auditor_id（R-W2-G 绑定项，
 * 终结恒 NULL）+ 同事务 ops.audit_logs（§8 全审计，actor=claims userId）。
 */
import { Injectable } from '@nestjs/common';
import { AppError, ErrorCode } from '@ljr/shared';
import type { SqlExecutor } from '../../infrastructure/sql';
import { PgPoolService } from '../../infrastructure/sql';
import { CreditService } from '../credit/credit.service';
import type { CreditMineView } from '../credit/credit.types';
import type { FirmMerchantView } from '../payment/firm-merchant.types';
import { FirmMerchantService } from '../payment/firm-merchant.service';
import {
  LawyerQualificationService,
  type AuditActionInput,
  type QualificationProfileView,
  type SubmissionQueueItem,
} from '../identity/lawyer.service';
import { SessionService } from '../trade/session.service';
import { AuditLogService } from './audit-log.service';
import type { WorkbenchStatus } from './lawyer-admin.http';
import { slaRemainingMs } from './lawyer-admin.sla';

/** 审核对象类型（ops.audit_logs.target_type；H1 唯一值，H9 扩展时增词汇） */
const TARGET_TYPE_LAWYER_PROFILE = 'lawyer_profile';

/** 场次统计缺省窗口天数（⚠H1 §11 展示口径待产品定义——先按近 30 天，报告注记决策位） */
const STATS_WINDOW_DAYS = 30;

/** 工作台条目（A3a 队列条目 + R-01 SLA 数据位） */
export interface WorkbenchItem extends SubmissionQueueItem {
  /** SLA 截止（submitted_at+3 工作日，ISO；submitted_at 缺失=null 防御位） */
  readonly sla_due_at: string | null;
  /** 剩余毫秒（负数=超时） */
  readonly sla_remaining_ms: number | null;
  /** 超时告警数据位（H4 看板同源消费） */
  readonly sla_overdue: boolean;
}

export interface WorkbenchListResult {
  readonly items: readonly WorkbenchItem[];
  readonly total: number;
  readonly page: number;
  readonly page_size: number;
}

/** 律师档案聚合视图（§2 档案视图：资质+进件+信用+场次统计；全经各源模块导出面） */
export interface LawyerProfileAdminView {
  readonly qualification: QualificationProfileView;
  /** A3b 进件行（按 firm 聚合全通道；未进件=空数组不抛） */
  readonly merchants: readonly FirmMerchantView[];
  /** G1 信用快照（lawyer 侧账户；score/recent_events/活跃限制令） */
  readonly credit: CreditMineView;
  /** C1 场次统计四率（窗口=from/to；attendance/ooo 桩=null 口径同 C1） */
  readonly session_stats: {
    readonly enroll_rate: number | null;
    readonly group_rate: number | null;
    readonly attendance_rate: null;
    readonly ooo_rate: null;
  };
  /** 统计窗口（⚠§11 口径待产品定义：缺省=近 30 天上海日界，报告注记） */
  readonly session_stats_window: { readonly from: string; readonly to: string };
}

/** 上海日界日期串（YYYY-MM-DD）：+8h 平移取墙钟日 */
function shanghaiDateOf(instant: Date): string {
  return new Date(instant.getTime() + 8 * 3_600_000).toISOString().slice(0, 10);
}

@Injectable()
export class LawyerAdminService {
  constructor(
    private readonly pool: PgPoolService,
    private readonly qualification: LawyerQualificationService,
    private readonly merchants: FirmMerchantService,
    private readonly credit: CreditService,
    private readonly sessions: SessionService,
    private readonly auditLog: AuditLogService,
  ) {}

  /**
   * GET /admin/lawyers?status=&page=（§5 工作台列表）：来源=A3a 提交队列（statuses 缺省=
   * SUBMITTED|IN_REVIEW；提交时间 ASC 排序由 A3a listSubmissions 承载）+ R-01 SLA 数据位。
   */
  async listWorkbench(query: {
    status?: WorkbenchStatus;
    page: number;
  }): Promise<WorkbenchListResult> {
    const statuses =
      query.status === undefined ? undefined : ([query.status] as const);
    const queue = await this.qualification.listSubmissions({ statuses, page: query.page });
    const now = new Date();
    const items: WorkbenchItem[] = queue.items.map((item) => {
      if (item.submitted_at === null) {
        // 防御位：提交必落 submitted_at；异常行不给 SLA 数据位也不崩看板
        return { ...item, sla_due_at: null, sla_remaining_ms: null, sla_overdue: false };
      }
      const remaining = slaRemainingMs(new Date(item.submitted_at), now);
      const due = new Date(now.getTime() + remaining); // now+remaining ≡ deadline（避免重复推日历）
      return {
        ...item,
        sla_due_at: due.toISOString(),
        sla_remaining_ms: remaining,
        sla_overdue: remaining < 0,
      };
    });
    return { items, total: queue.total, page: query.page, page_size: 20 };
  }

  /**
   * POST /admin/lawyers/{id}/audit（§5；幂等键=id+action 的冲突面=A3a 状态守卫 409 透传）：
   * 同事务串 A3a 审核迁移（auditor_id 回填）+ ops.audit_logs（§8 全审计）。
   */
  async audit(
    profileId: number,
    input: AuditActionInput,
    adminUserId: number,
  ): Promise<{ status: string }> {
    const done = await this.pool.withTransaction(async (uow) => {
      const result = await this.qualification.auditWithExecutor(uow, profileId, input, adminUserId);
      await this.recordAudit(uow, adminUserId, input.action, profileId, result.status, input);
      return result;
    });
    return { status: done.status };
  }

  /** POST /admin/lawyers/{id}/suspend {reason}（§5；幂等键=id；转调 A3a suspend，事件出箱=A3a） */
  async suspend(profileId: number, reason: string, adminUserId: number): Promise<{ status: string }> {
    return this.audit(profileId, { action: 'suspend', reason }, adminUserId);
  }

  /** POST /admin/lawyers/{id}/resume（§5；恢复不发事件=§6 词汇，A3a 既有） */
  async resume(profileId: number, adminUserId: number): Promise<{ status: string }> {
    return this.audit(profileId, { action: 'resume' }, adminUserId);
  }

  /**
   * GET /admin/lawyers/{id}/profile（§2 档案视图）：A3a 资质（404 未知档案）→ A3b 进件
   * （firm_id 非空时按律所聚合，未进件=空数组）→ G1 信用快照 → C1 场次统计（缺省窗口=
   * 近 30 天上海日界，⚠§11）。
   */
  async profile(
    profileId: number,
    window?: { from?: string; to?: string },
  ): Promise<LawyerProfileAdminView> {
    const qualification = await this.qualification.profileViewById(profileId);
    if (qualification === undefined) {
      throw new AppError(ErrorCode.NotFound, `律师资质档案 ${profileId} 不存在`);
    }
    const lawyerUserId = qualification.lawyer_user_id;

    // A3b 进件状态（经 payment 域导出面；firm_id=null=未绑定律所，进件位空）
    const merchants =
      qualification.firm_id === null
        ? []
        : await this.merchants.listByFirm(qualification.firm_id);

    // G1 信用快照（lawyer 侧账户；无账户行时 getMine 回显初始 100 口径）
    const credit = await this.credit.getMine('lawyer', lawyerUserId);

    // C1 场次统计（经 trade 导出面；缺省窗口=近 30 天上海日界，⚠§11 口径待产品定义）
    const now = new Date();
    const to = window?.to ?? shanghaiDateOf(now);
    const from =
      window?.from ??
      shanghaiDateOf(new Date(now.getTime() - STATS_WINDOW_DAYS * 86_400_000));
    const sessionStats = await this.sessions.stats(lawyerUserId, from, to);

    return {
      qualification,
      merchants,
      credit,
      session_stats: sessionStats,
      session_stats_window: { from, to },
    };
  }

  /** ops.audit_logs 同事务落行（§8 审核操作全审计；actor=claims userId） */
  private async recordAudit(
    uow: SqlExecutor,
    adminUserId: number,
    action: string,
    profileId: number,
    resultStatus: string,
    input: AuditActionInput,
  ): Promise<void> {
    await this.auditLog.record(uow, {
      actorUserId: adminUserId,
      action: `lawyer_audit.${action}`,
      targetType: TARGET_TYPE_LAWYER_PROFILE,
      targetId: profileId,
      detail: {
        action,
        result_status: resultStatus,
        ...(input.rejectReason !== undefined ? { reject_reason: input.rejectReason } : {}),
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
      },
    });
  }
}
