/**
 * I3 审批调取面（§5 GET /admin/artifacts/{id}/evidence；R-02 仅合规审批调取）——REST 承载。
 * 双签完整（approved_by+reviewed_by 非空且 V36 CHECK 禁同人=物理兜底）才返回凭证三元组
 * {evidence_id, hash_sha256, object_key}；未审批/单签→403 E_NOT_APPROVED（同码拒绝不泄露
 * 审批存在性，A2 受控解密先例）；无 evidence_id（非录音归档链产物）/未知 id→404。
 *
 * 鉴权（G-A 前置门，不可降级）：类级 IdentityAuthGuard+IdentityRoleGuard+端点
 * @RequireRole('admin')——admin=DB 预置权限旗标（claims.roles 成员判定），运营台=H9/W2+。
 * 审批行创建面（渐进签发工作流）=H9（W2+），本批审批行以测试直插只做消费。
 * 形态抄 ops 域 lawyer-admin 控制器（admin 路由+AppHttpExceptionFilter {code,message}）。
 */
import { Controller, Get, Param, UseFilters, UseGuards } from '@nestjs/common';
import { AppError, ErrorCode } from '@ljr/shared';
import { AppHttpExceptionFilter } from '../app-error.filter';
import {
  IdentityAuthGuard,
  IdentityRoleGuard,
  RequireRole,
} from '../../modules/identity/identity.guards';
import type { ArtifactEvidenceView } from './artifacts.service';
import { ArtifactsService } from './artifacts.service';

function parseArtifactId(raw: string): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    throw new AppError(ErrorCode.InvalidArgument, `artifact_id 须为正整数，收到：${raw}`);
  }
  return id;
}

@Controller('admin/artifacts')
@UseFilters(AppHttpExceptionFilter)
@UseGuards(IdentityAuthGuard, IdentityRoleGuard)
export class ArtifactAdminController {
  constructor(private readonly artifacts: ArtifactsService) {}

  /** GET /admin/artifacts/{id}/evidence：存证凭证调取（双签审批门，§5 契约） */
  @Get(':id/evidence')
  @RequireRole('admin')
  evidence(@Param('id') id: string): Promise<ArtifactEvidenceView> {
    return this.artifacts.evidenceFor(parseArtifactId(id));
  }
}
