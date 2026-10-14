/**
 * E3 管理面 REST（§5 三接口）：知识库上传（幂等键=file_hash）/ 问题树编辑（幂等键=
 * key+base_version，400 INVALID_TREE）/ 提示词模板（R-03 版本化）。
 * 后台鉴权 ⚠决策位：admin 鉴权随 H1/H2（W2+）接入后替换（rule-admin/word-admin 同口径）。
 */
import { Body, Controller, Param, Post, Put, UseFilters } from '@nestjs/common';
import type { PutSpecialtyConfigResult } from './specialty.types';
import { SpecialtyConfigService } from './specialty.service';
import { KnowledgeService } from './knowledge.service';
import type { UploadKnowledgeDocResult } from './knowledge.types';
import {
  SpecialtyHttpExceptionFilter,
  parsePutPromptsBody,
  parsePutQuestionTreeBody,
  parseSpecialtyKey,
  parseUploadKnowledgeBody,
} from './specialty.http';

@Controller('admin/specialty')
@UseFilters(SpecialtyHttpExceptionFilter)
export class SpecialtyAdminController {
  constructor(
    private readonly configs: SpecialtyConfigService,
    private readonly knowledge: KnowledgeService,
  ) {}

  /** POST /admin/specialty/{key}/knowledge：上传登记（§5 {doc_id}；幂等键=file_hash） */
  @Post(':key/knowledge')
  upload(@Param('key') key: string, @Body() body: unknown): Promise<UploadKnowledgeDocResult> {
    const specialty = parseSpecialtyKey(key);
    const input = parseUploadKnowledgeBody(body);
    return this.knowledge.uploadDocument({ specialty, ...input });
  }

  /** PUT /admin/specialty/{key}/question-tree：问题树提交（§5 {version}；400 INVALID_TREE） */
  @Put(':key/question-tree')
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
  putPrompts(@Param('key') key: string, @Body() body: unknown): Promise<PutSpecialtyConfigResult> {
    const specialty = parseSpecialtyKey(key);
    const input = parsePutPromptsBody(body);
    return this.configs.putPrompts({ specialty, ...input });
  }
}
