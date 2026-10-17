/**
 * E3 管理面 REST（§5 三接口）：知识库上传（幂等键=file_hash）/ 问题树编辑（幂等键=
 * key+base_version，400 INVALID_TREE）/ 提示词模板（R-03 版本化）。
 * 鉴权（W3 T10 修复轮，评审 Important-1）：⚠决策位占位兑现——管理面驱动 agent 检索语料与
 * 提示词，属 admin 面，挂 IdentityAuthGuard+IdentityRoleGuard + @RequireRole('admin')
 * （rule-admin/word-admin 同批同款）；公开只读面=SpecialtyPublicController（不受影响）。
 */
import { Body, Controller, Param, Post, Put, UseFilters, UseGuards } from '@nestjs/common';
import type { PutSpecialtyConfigResult } from './specialty.types';
import { SpecialtyConfigService } from './specialty.service';
import { KnowledgeService } from './knowledge.service';
import type { UploadKnowledgeDocResult } from './knowledge.types';
import {
  parsePutPromptsBody,
  parsePutQuestionTreeBody,
  parseSpecialtyKey,
  parseUploadKnowledgeBody,
} from './specialty.http';
import { AppHttpExceptionFilter } from '../../infrastructure/app-error.filter';
import { IdentityAuthGuard, IdentityRoleGuard, RequireRole } from '../identity/identity.guards';

@Controller('admin/specialty')
@UseFilters(AppHttpExceptionFilter)
@UseGuards(IdentityAuthGuard, IdentityRoleGuard)
export class SpecialtyAdminController {
  constructor(
    private readonly configs: SpecialtyConfigService,
    private readonly knowledge: KnowledgeService,
  ) {}

  /** POST /admin/specialty/{key}/knowledge：上传登记（§5 {doc_id}；幂等键=file_hash） */
  @Post(':key/knowledge')
  @RequireRole('admin')
  upload(@Param('key') key: string, @Body() body: unknown): Promise<UploadKnowledgeDocResult> {
    const specialty = parseSpecialtyKey(key);
    const input = parseUploadKnowledgeBody(body);
    return this.knowledge.uploadDocument({ specialty, ...input });
  }

  /** PUT /admin/specialty/{key}/question-tree：问题树提交（§5 {version}；400 INVALID_TREE） */
  @Put(':key/question-tree')
  @RequireRole('admin')
  putQuestionTree(
    @Param('key') key: string,
    @Body() body: unknown,
  ): Promise<PutSpecialtyConfigResult> {
    const specialty = parseSpecialtyKey(key);
    const input = parsePutQuestionTreeBody(body);
    return this.configs.putQuestionTree({ specialty, ...input });
  }

  /** PUT /admin/specialty/{key}/prompts：提示词提交（§5 {version}；R-03 版本化） */
  @Put(':key/prompts')
  @RequireRole('admin')
  putPrompts(@Param('key') key: string, @Body() body: unknown): Promise<PutSpecialtyConfigResult> {
    const specialty = parseSpecialtyKey(key);
    const input = parsePutPromptsBody(body);
    return this.configs.putPrompts({ specialty, ...input });
  }
}
