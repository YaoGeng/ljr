/**
 * GET /notifications/mine（I1 §5）：站内信列表（本用户 INBOX+SENT）。
 * 身份接线 ⚠决策位：user_id 暂经 query 注入，claims/token 校验随 A1（W2）接入后替换。
 */
import { Controller, Get, Query, UseFilters } from '@nestjs/common';
import { NotifyHttpExceptionFilter, parseUserId } from './notify.http';
import { NotifyDispatcherService } from './notify-dispatcher.service';

@Controller('notifications')
@UseFilters(NotifyHttpExceptionFilter)
export class NotificationsController {
  constructor(private readonly dispatcher: NotifyDispatcherService) {}

  @Get('mine')
  mine(@Query('user_id') userId: string): ReturnType<NotifyDispatcherService['listInbox']> {
    return this.dispatcher.listInbox(parseUserId(userId));
  }
}
