/**
 * GET /rooms/notice-content?key=（H7 §5，D5 进房拉取消费；缺省键=room_notice）。
 * R-02 房间须知可配置内容块（含用户侧披露）；无鉴权（App 面只读，控制者裁决）。
 * 内容 jsonb 结构=H7 定义（rule-center.types.ts RoomNoticeContent 注释），D5 按该结构渲染。
 */
import { Controller, Get, Query, UseFilters } from '@nestjs/common';
import type { RoomNoticeView } from './rule-center.types';
import { RuleCenterService } from './rule-center.service';
import { parseRuleKey } from './rule.http';
import { AppHttpExceptionFilter } from '../../infrastructure/app-error.filter';

@Controller('rooms')
@UseFilters(AppHttpExceptionFilter)
export class RoomNoticeController {
  constructor(private readonly rules: RuleCenterService) {}

  @Get('notice-content')
  notice(@Query('key') key?: string): Promise<RoomNoticeView> {
    return this.rules.noticeContent(
      key === undefined || key === '' ? undefined : parseRuleKey(key),
    );
  }
}
