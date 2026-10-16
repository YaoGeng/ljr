/**
 * H7 App 面只读 REST（§5）：GET /rules/current（现行版+公示中「即将生效」）、GET /rules/snapshot
 * （行为时快照，内部）。无鉴权（控制者裁决：App 面只读接口无鉴权；快照标注「内部」供服务间取数）。
 */
import { Controller, Get, Query, UseFilters } from '@nestjs/common';
import type { RuleDefinitionView } from './rule-center.types';
import { RuleCenterService } from './rule-center.service';
import { parseRuleKey, parseSnapshotAt } from './rule.http';
import { AppHttpExceptionFilter } from '../../infrastructure/app-error.filter';

@Controller('rules')
@UseFilters(AppHttpExceptionFilter)
export class RuleAppController {
  constructor(private readonly rules: RuleCenterService) {}

  /** GET /rules/current?key=：现行版（current）+ 公示中最新版（pending，「即将生效」§4） */
  @Get('current')
  current(@Query('key') key?: string): ReturnType<RuleCenterService['currentWithPending']> {
    return this.rules.currentWithPending(parseRuleKey(key));
  }

  /** GET /rules/snapshot?key=&at=：行为时快照（§3 语句；无生效版本返回 null） */
  @Get('snapshot')
  snapshot(
    @Query('key') key?: string,
    @Query('at') at?: string,
  ): Promise<RuleDefinitionView | null> {
    return this.rules.snapshotAt(parseRuleKey(key), parseSnapshotAt(at));
  }
}
