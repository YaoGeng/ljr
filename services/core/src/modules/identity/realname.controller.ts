/**
 * A2 实名 REST 面（§5）：POST /realname、GET /realname/status（本人，user_id 取 JWT claims）
 * 与 GET /admin/realname/decrypt（受控解密）。响应字段用 §5 契约词汇（snake_case）；
 * R-05：一切对外出参不含实名信息本体（仅 status/verified_at；解密面除外=合规双人复核出口）。
 */
import { Body, Controller, Get, Post, Query, UseFilters, UseGuards } from '@nestjs/common';
import { AppHttpExceptionFilter } from '../../infrastructure/app-error.filter';
import {
  CurrentIdentity,
  IdentityAuthGuard,
  IdentityRoleGuard,
  RequireRole,
  type IdentityClaims,
} from './identity.guards';
import { parseDecryptQuery, parseRealnameBody } from './realname.http';
import { RealnameService } from './realname.service';

@Controller('realname')
@UseFilters(AppHttpExceptionFilter)
export class RealnameController {
  constructor(private readonly realname: RealnameService) {}

  /** POST /realname：{name, id_no} → {status}（幂等键=user，§5） */
  @Post()
  @UseGuards(IdentityAuthGuard)
  async submit(
    @CurrentIdentity() identity: IdentityClaims,
    @Body() body: unknown,
  ): Promise<{ status: string }> {
    const input = parseRealnameBody(body);
    const done = await this.realname.submitRealname(identity.userId, input);
    return { status: done.status };
  }

  /** GET /realname/status：→ {status, verified_at?}（R-01 查询面本人侧） */
  @Get('status')
  @UseGuards(IdentityAuthGuard)
  async status(@CurrentIdentity() identity: IdentityClaims): Promise<{
    status: string;
    verified_at?: string;
  }> {
    const view = await this.realname.realnameStatus(identity.userId);
    return {
      status: view.status,
      ...(view.verifiedAt ? { verified_at: view.verifiedAt.toISOString() } : {}),
    };
  }
}

/**
 * 受控解密管理面（R-04，§5 GET /admin/realname/decrypt）。授权两层：
 *   ① admin 角色守卫（⚠W3-8 @RequireRole('admin')，W3 T10 G-A 前置门接线——R-W2-F park 关闭，
 *      接线前禁上 staging 共网的定性项就此关闭）；
 *   ② 审批行双签完整性（approved_by≠reviewed_by），无/不完整 → 403 NOT_APPROVED（第二道门）。
 */
@Controller('admin/realname')
@UseFilters(AppHttpExceptionFilter)
@UseGuards(IdentityAuthGuard, IdentityRoleGuard)
export class RealnameAdminController {
  constructor(private readonly realname: RealnameService) {}

  @Get('decrypt')
  @RequireRole('admin')
  async decrypt(
    @Query('user_id') userId?: string,
    @Query('reason') reason?: string,
    @Query('approval_id') approvalId?: string,
  ): Promise<{ name: string; id_no: string }> {
    const input = parseDecryptQuery({ user_id: userId, reason, approval_id: approvalId });
    const done = await this.realname.decryptForCompliance(input);
    return { name: done.name, id_no: done.idNo };
  }
}
