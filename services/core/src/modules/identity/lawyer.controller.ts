/**
 * A3a REST 面（§5 律师侧）：提交面 POST /lawyer/qualification、GET /lawyer/audit-status（本人，
 * user_id 取 JWT claims——提交者尚未持有 lawyer 角色，角色守卫不适用，A2 同口径）。
 * 响应字段用 §5 契约词汇（snake_case）；一切出参不含 license_no 明文（PII 红线 §9）。
 *
 * W3 T10：admin 审核操作面 POST /admin/lawyers/{id}/audit 的 HTTP 面随 H1 落位迁至 ops
 * （ops/lawyer-admin.controller，G-A 前置门接线 @RequireRole('admin') + auditor_id 回填 +
 * ops 域审计表同事务审计——编排方须持 ops schema 写权，schema 纪律决定路由归位）；
 * 契约仍归 A3a §5（action 词汇=A3a 实现词汇，审核逻辑=auditWithExecutor 服务面不变）。
 */
import { Body, Controller, Get, Post, UseFilters, UseGuards } from '@nestjs/common';
import { AppHttpExceptionFilter } from '../../infrastructure/app-error.filter';
import { CurrentIdentity, IdentityAuthGuard, type IdentityClaims } from './identity.guards';
import { parseQualificationBody } from './lawyer.http';
import { LawyerQualificationService } from './lawyer.service';

@Controller('lawyer')
@UseFilters(AppHttpExceptionFilter)
export class LawyerQualificationController {
  constructor(private readonly qualification: LawyerQualificationService) {}

  /** POST /lawyer/qualification：{license_no, firm_name?, files[]} → {status}（幂等键=user，§5） */
  @Post('qualification')
  @UseGuards(IdentityAuthGuard)
  async submit(
    @CurrentIdentity() identity: IdentityClaims,
    @Body() body: unknown,
  ): Promise<{ status: string }> {
    const done = await this.qualification.submitQualification(
      identity.userId,
      parseQualificationBody(body),
    );
    return { status: done.status };
  }

  /** GET /lawyer/audit-status：→ {status, reason?}（本人视角，R-01 查询面本人侧） */
  @Get('audit-status')
  @UseGuards(IdentityAuthGuard)
  async status(@CurrentIdentity() identity: IdentityClaims): Promise<{
    status: string;
    reason?: string;
  }> {
    const view = await this.qualification.auditStatus(identity.userId);
    return { status: view.status, ...(view.reason ? { reason: view.reason } : {}) };
  }
}
