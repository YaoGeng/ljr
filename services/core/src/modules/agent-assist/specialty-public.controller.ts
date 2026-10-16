/**
 * E3 公开只读 REST（§5 GET /specialty/question-tree?key=）：C2 引导页消费的树结构。
 * 无鉴权（§5「公开只读」）；未知/未配置专项=404（资源语义，不向公网暴露在册专项清单口径）。
 */
import { Controller, Get, Query, UseFilters } from '@nestjs/common';
import { SpecialtyConfigService } from './specialty.service';
import type { SpecialtyQuestionTreeView } from './specialty.types';
import { parsePublicSpecialtyKey } from './specialty.http';
import { AppHttpExceptionFilter } from '../../infrastructure/app-error.filter';

@Controller('specialty')
@UseFilters(AppHttpExceptionFilter)
export class SpecialtyPublicController {
  constructor(private readonly configs: SpecialtyConfigService) {}

  /** GET /specialty/question-tree?key=：当前问题树 + version（C2 引导页拉新版，§10 验收②承载） */
  @Get('question-tree')
  getQuestionTree(@Query('key') key?: string): Promise<SpecialtyQuestionTreeView> {
    return this.configs.getQuestionTree(parsePublicSpecialtyKey(key));
  }
}
