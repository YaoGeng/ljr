/**
 * H5 词库管理 REST（§5 GET/PUT /admin/risk/dictionaries）：词库当前生效版本视图 / 词库提交
 * （幂等键=dict+base_version，400 E_DUP_WORD）。人审队列与处置（§5 GET /admin/risk/queue、
 * POST /admin/risk/records/{id}/review）后置 M2-W2（本批不建路由）。
 * 鉴权（W3 T10 修复轮，评审 Important-1）：⚠决策位占位兑现——词库提交驱动全站风控，属 admin
 * 面，挂 IdentityAuthGuard+IdentityRoleGuard + @RequireRole('admin')（rule-admin 同批同款）。
 */
import { Body, Controller, Get, Put, Query, UseFilters, UseGuards } from '@nestjs/common';
import type { DictionaryView, PutDictionaryResult } from './word-dict.types';
import { AppHttpExceptionFilter } from '../../infrastructure/app-error.filter';
import { IdentityAuthGuard, IdentityRoleGuard, RequireRole } from '../identity/identity.guards';
import { WordDictService } from './word-dict.service';
import { parseDictTypeFilter, parsePutDictionaryBody } from './word-dict.http';

@Controller('admin/risk/dictionaries')
@UseFilters(AppHttpExceptionFilter)
@UseGuards(IdentityAuthGuard, IdentityRoleGuard)
export class WordAdminController {
  constructor(private readonly dicts: WordDictService) {}

  /** GET /admin/risk/dictionaries?dict_type=：当前生效版本视图（缺省双库；无版本库 version=0） */
  @Get()
  @RequireRole('admin')
  list(@Query('dict_type') dictType?: string): Promise<DictionaryView[]> {
    return this.dicts.getDictionaries(parseDictTypeFilter(dictType));
  }

  /** PUT /admin/risk/dictionaries：词库提交（幂等键=dict+base_version；重放 created:false） */
  @Put()
  @RequireRole('admin')
  put(@Body() body: unknown): Promise<PutDictionaryResult> {
    return this.dicts.putDictionary(parsePutDictionaryBody(body));
  }
}
