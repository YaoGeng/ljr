/**
 * H1 律师与资质管理 REST 面（§5 契约表 + W2 终审 G-A 前置门承载，M1-W3 T10）：
 *   GET  /admin/lawyers?status=&page=        工作台列表（SLA 3 工作日剩余=R-01）
 *   POST /admin/lawyers/{id}/audit           审核操作（R-W3-B：action=A3a 实现词汇五枚；
 *                                            幂等键=id+action → 409 STATE 透传；同事务
 *                                            ops.audit_logs=§8 全审计）
 *   POST /admin/lawyers/{id}/suspend         停用 {reason}（幂等键=id；LawyerSuspended 出箱=A3a）
 *   POST /admin/lawyers/{id}/resume          恢复（A3a SUSPENDED→PASSED，无事件=§6）
 *   GET  /admin/lawyers/{id}/profile         档案聚合（A3a+A3b+G1+C1 服务面；404 未审/未知）
 *
 * 鉴权（G-A 前置门，终审不可降级）：类级 IdentityAuthGuard+IdentityRoleGuard + 每端点
 * @RequireRole('admin')——未认证 401 / 未持 admin 旗标 403 E_ROLE_FORBIDDEN。admin 账号=
 * DB 级预置（identity 域 user_roles 直插 role='admin'，无自助 API；运营台=M3/M4）。
 * 本控制器是 /admin/lawyers 路由唯一主人（A3a 的 admin 占位控制器随本批退役——契约归 A3a、
 * HTTP 面归 ops：同事务审计要求编排方持有 ops 域审计表写权，schema 纪律决定归属）。
 */
import { Body, Controller, Get, Param, Post, Query, UseFilters, UseGuards } from '@nestjs/common';
import { AppHttpExceptionFilter } from '../../infrastructure/app-error.filter';
import {
  CurrentIdentity,
  IdentityAuthGuard,
  IdentityRoleGuard,
  RequireRole,
  type IdentityClaims,
} from '../identity/identity.guards';
import { parseAuditActionBody, parseProfileId } from '../identity/lawyer.http';
import {
  parseProfileWindowQuery,
  parseSuspendBody,
  parseWorkbenchQuery,
} from './lawyer-admin.http';
import type { LawyerProfileAdminView, WorkbenchListResult } from './lawyer-admin.service';
import { LawyerAdminService } from './lawyer-admin.service';

@Controller('admin/lawyers')
@UseFilters(AppHttpExceptionFilter)
@UseGuards(IdentityAuthGuard, IdentityRoleGuard)
export class LawyerAdminController {
  constructor(private readonly lawyerAdmin: LawyerAdminService) {}

  /** GET /admin/lawyers?status=&page=：入驻审核工作台（提交时间 ASC + SLA 数据位 R-01） */
  @Get()
  @RequireRole('admin')
  list(
    @Query('status') status?: string,
    @Query('page') page?: string,
  ): Promise<WorkbenchListResult> {
    return this.lawyerAdmin.listWorkbench(parseWorkbenchQuery({ status, page }));
  }

  /** POST /admin/lawyers/{id}/audit：审核操作（R-W3-B 词汇=A3a 五枚；同事务审计） */
  @Post(':id/audit')
  @RequireRole('admin')
  async audit(
    @Param('id') id: string,
    @CurrentIdentity() identity: IdentityClaims,
    @Body() body: unknown,
  ): Promise<{ status: string }> {
    return this.lawyerAdmin.audit(parseProfileId(id), parseAuditActionBody(body), identity.userId);
  }

  /** POST /admin/lawyers/{id}/suspend {reason}：停用（转调 A3a suspend；事件出箱=A3a） */
  @Post(':id/suspend')
  @RequireRole('admin')
  async suspend(
    @Param('id') id: string,
    @CurrentIdentity() identity: IdentityClaims,
    @Body() body: unknown,
  ): Promise<{ status: string }> {
    const { reason } = parseSuspendBody(body);
    return this.lawyerAdmin.suspend(parseProfileId(id), reason, identity.userId);
  }

  /** POST /admin/lawyers/{id}/resume：恢复（A3a SUSPENDED→PASSED） */
  @Post(':id/resume')
  @RequireRole('admin')
  async resume(
    @Param('id') id: string,
    @CurrentIdentity() identity: IdentityClaims,
  ): Promise<{ status: string }> {
    return this.lawyerAdmin.resume(parseProfileId(id), identity.userId);
  }

  /** GET /admin/lawyers/{id}/profile?from=&to=：档案聚合视图（404 未知/未建档案） */
  @Get(':id/profile')
  @RequireRole('admin')
  profile(
    @Param('id') id: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): Promise<LawyerProfileAdminView> {
    return this.lawyerAdmin.profile(parseProfileId(id), parseProfileWindowQuery({ from, to }));
  }
}
