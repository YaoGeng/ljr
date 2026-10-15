/**
 * A2 同意 REST 面（§5 + §2 做项）：POST /consents/training、POST /consents/training/revoke
 * 与 GET /consents/training（授权状态查询=§2「设置中心授权状态查询」最小满足，§5 契约表
 * 未列——文档缺口回写项）。user_id 一律取 JWT claims；R-02：拒绝路径不降级其余功能。
 */
import { Body, Controller, Get, Post, UseFilters, UseGuards } from '@nestjs/common';
import { CurrentIdentity, IdentityAuthGuard, type IdentityClaims } from './identity.guards';
import { IdentityHttpExceptionFilter } from './identity.http';
import { parseTrainingConsentBody } from './realname.http';
import { ConsentService } from './consent.service';

@Controller('consents/training')
@UseFilters(IdentityHttpExceptionFilter)
export class ConsentController {
  constructor(private readonly consent: ConsentService) {}

  /** POST /consents/training：{policy_version, accept} → {status}（§5；409 VERSION_MISMATCH） */
  @Post()
  @UseGuards(IdentityAuthGuard)
  async grant(
    @CurrentIdentity() identity: IdentityClaims,
    @Body() body: unknown,
  ): Promise<{ status: string }> {
    const input = parseTrainingConsentBody(body);
    const done = await this.consent.grantTraining(identity.userId, input);
    return { status: done.status };
  }

  /** POST /consents/training/revoke：→ {status, revoked_at}（R-03 撤回链路起点） */
  @Post('revoke')
  @UseGuards(IdentityAuthGuard)
  async revoke(@CurrentIdentity() identity: IdentityClaims): Promise<{
    status: string;
    revoked_at?: string;
  }> {
    const done = await this.consent.revokeTraining(identity.userId);
    return {
      status: done.status,
      ...(done.revokedAt ? { revoked_at: done.revokedAt.toISOString() } : {}),
    };
  }

  /** GET /consents/training：现行授权状态（设置中心「可记忆/不重复弹」§8 的事实源） */
  @Get()
  @UseGuards(IdentityAuthGuard)
  async status(@CurrentIdentity() identity: IdentityClaims): Promise<{
    status: string;
    policy_version?: string;
    granted_at?: string;
    revoked_at?: string;
  }> {
    const view = await this.consent.trainingConsentStatus(identity.userId);
    return {
      status: view.status,
      ...(view.policyVersion ? { policy_version: view.policyVersion } : {}),
      ...(view.grantedAt ? { granted_at: view.grantedAt.toISOString() } : {}),
      ...(view.revokedAt ? { revoked_at: view.revokedAt.toISOString() } : {}),
    };
  }
}
