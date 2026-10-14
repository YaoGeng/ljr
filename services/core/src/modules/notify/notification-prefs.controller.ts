/**
 * GET/PUT /notification-prefs（I1 §5）：用户通知偏好查询与设置。
 * 身份接线 ⚠决策位：user_id 暂经 query 注入，claims/token 校验随 A1（W2）接入后替换。
 */
import { Body, Controller, Get, Put, Query, UseFilters } from '@nestjs/common';
import { NotifyHttpExceptionFilter, parsePrefsBody, parseUserId } from './notify.http';
import { NotifyPrefsService } from './notify-prefs.service';

@Controller('notification-prefs')
@UseFilters(NotifyHttpExceptionFilter)
export class NotificationPrefsController {
  constructor(private readonly prefs: NotifyPrefsService) {}

  @Get()
  get(@Query('user_id') userId: string): ReturnType<NotifyPrefsService['getPrefs']> {
    return this.prefs.getPrefs(parseUserId(userId));
  }

  @Put()
  put(
    @Query('user_id') userId: string,
    @Body() body: unknown,
  ): ReturnType<NotifyPrefsService['putPrefs']> {
    return this.prefs.putPrefs(parseUserId(userId), parsePrefsBody(body));
  }
}
