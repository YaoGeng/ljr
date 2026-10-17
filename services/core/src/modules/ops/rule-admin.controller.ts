/**
 * H7 管理面 REST（§5 GET/POST /admin/rules[/{key}]）：创建草案 / 提交公示 / 废弃草案 / 列表与版本视图。
 * 鉴权（W3 T10 修复轮，评审 Important-1）：⚠决策位占位兑现——规则发布影响全平台信用规则，
 * 属 admin 面，挂 IdentityAuthGuard+IdentityRoleGuard + @RequireRole('admin')
 * （未认证 401 / 未持 admin 旗标 403；与 I2 /admin/scheduler/jobs 同批同款）；幂等键=key+version
 * （§5，服务层落地见 rule-center.service）。
 */
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import type {
  CreateDraftResult,
  RuleDefinitionView,
  SubmitPublicationResult,
} from './rule-center.types';
import { RuleCenterService } from './rule-center.service';
import {
  parseCreateRuleBody,
  parseRuleKey,
  parseRuleLimit,
  parseRuleStatus,
  parseRuleVersionBody,
} from './rule.http';
import { AppHttpExceptionFilter } from '../../infrastructure/app-error.filter';
import { IdentityAuthGuard, IdentityRoleGuard, RequireRole } from '../identity/identity.guards';

@Controller('admin/rules')
@UseFilters(AppHttpExceptionFilter)
@UseGuards(IdentityAuthGuard, IdentityRoleGuard)
export class RuleAdminController {
  constructor(private readonly rules: RuleCenterService) {}

  /** POST /admin/rules：创建草案（幂等键=key+version；重放内容全等 ⇒ created:false） */
  @Post()
  @RequireRole('admin')
  @HttpCode(200)
  create(@Body() body: unknown): Promise<CreateDraftResult> {
    return this.rules.createDraft(parseCreateRuleBody(body));
  }

  /** GET /admin/rules?rule_key=&status=&limit=：管理列表 */
  @Get()
  @RequireRole('admin')
  list(
    @Query('rule_key') ruleKey?: string,
    @Query('status') status?: string,
    @Query('limit') limit?: string,
  ): Promise<RuleDefinitionView[]> {
    return this.rules.listRules({
      ruleKey: ruleKey === undefined || ruleKey === '' ? undefined : parseRuleKey(ruleKey),
      status: parseRuleStatus(status),
      limit: parseRuleLimit(limit),
    });
  }

  /** GET /admin/rules/:key：单键版本列表（version DESC） */
  @Get(':key')
  @RequireRole('admin')
  versions(@Param('key') key: string): Promise<RuleDefinitionView[]> {
    return this.rules.listRules({ ruleKey: parseRuleKey(key) });
  }

  /** POST /admin/rules/:key/publish：提交公示（DRAFT→PUBLISHED；重放幂等 deduplicated:true） */
  @Post(':key/publish')
  @RequireRole('admin')
  @HttpCode(200)
  publish(@Param('key') key: string, @Body() body: unknown): Promise<SubmitPublicationResult> {
    return this.rules.submitForPublication(parseRuleKey(key), parseRuleVersionBody(body));
  }

  /** POST /admin/rules/:key/abandon：废弃草案（DRAFT→ABANDONED；非 DRAFT 守卫拒绝 409） */
  @Post(':key/abandon')
  @RequireRole('admin')
  @HttpCode(200)
  abandon(@Param('key') key: string, @Body() body: unknown): Promise<RuleDefinitionView> {
    return this.rules.abandonDraft(parseRuleKey(key), parseRuleVersionBody(body));
  }
}
