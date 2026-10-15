/**
 * A3a REST 面（§5）：律师提交面 POST /lawyer/qualification、GET /lawyer/audit-status（本人，
 * user_id 取 JWT claims——提交者尚未持有 lawyer 角色，角色守卫不适用，A2 同口径）与
 * H1 审核操作面 POST /admin/lawyers/{id}/audit（契约归 A3a，简报本批交付；{id}=
 * lawyer_profiles.id；admin 鉴权占位=R-W2-F park 先例，H1 接线前置门清单项）。
 * 响应字段用 §5 契约词汇（snake_case）；一切出参不含 license_no 明文（PII 红线 §9）。
 */
import { Body, Controller, Get, Param, Post, UseFilters, UseGuards } from '@nestjs/common';
import { CurrentIdentity, IdentityAuthGuard, type IdentityClaims } from './identity.guards';
import { IdentityHttpExceptionFilter } from './identity.http';
import { parseAuditActionBody, parseProfileId, parseQualificationBody } from './lawyer.http';
import { LawyerQualificationService } from './lawyer.service';

@Controller('lawyer')
@UseFilters(IdentityHttpExceptionFilter)
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

/**
 * H1 审核操作面（简报：action=claim|approve|reject|suspend|resume，reject_reason 必填于拒绝）。
 * admin 鉴权占位（W1 共性裁决 R-W2-F）：接入 H1/H2 后统一接线，接线前禁上 staging 共网。
 */
@Controller('admin/lawyers')
@UseFilters(IdentityHttpExceptionFilter)
export class LawyerAuditAdminController {
  constructor(private readonly qualification: LawyerQualificationService) {}

  @Post(':id/audit')
  async audit(@Param('id') id: string, @Body() body: unknown): Promise<{ status: string }> {
    const done = await this.qualification.audit(parseProfileId(id), parseAuditActionBody(body));
    return { status: done.status };
  }
}
