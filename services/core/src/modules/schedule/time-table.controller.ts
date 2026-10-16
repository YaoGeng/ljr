/**
 * B1 REST 面（§5 + Task 4 简报裁决）：
 *   - GET  /lawyer/{id}/schedule      → {version, templates[]}（version=PUT 乐观并发读侧，自定口径报告注明）
 *   - PUT  /lawyer/schedule           → 全量替换；律师本人（claims 身份，@RequireRole('lawyer')）
 *   - GET  /lawyer/{id}/slots?from=&to= → 状态视图 [{slot_start, status, ref}]
 * 鉴权口径（简报）：PUT=律师本人；GET 面公开/用户态均可（用户端选段要读）——最小实现 GET 不设
 * 角色限制（报告标注；接线 H1 后如需收紧为可选鉴权再统一处理）。
 * 响应字段用 §5 契约词汇（snake_case）；slot_start 为 ISO 8601（B2 事件出站同口径）。
 */
import { Body, Controller, Get, Param, Put, Query, UseFilters, UseGuards } from '@nestjs/common';
import { AppHttpExceptionFilter } from '../../infrastructure/app-error.filter';
import {
  CurrentIdentity,
  IdentityAuthGuard,
  IdentityRoleGuard,
  RequireRole,
  type IdentityClaims,
} from '../identity/identity.guards';
import { parseLawyerId, parseReplaceScheduleBody, parseSlotRangeQuery } from './time-table.http';
import { TimeTableService } from './time-table.service';
import type { ScheduleView, SlotViewRow } from './time-table.types';

interface TemplatePayload {
  readonly id: number;
  readonly weekday: number;
  readonly start_time: string;
  readonly duration_small: number;
  readonly enabled: boolean;
}

function toTemplatePayload(view: ScheduleView): { version: number; templates: TemplatePayload[] } {
  return {
    version: view.version,
    templates: view.templates.map((t) => ({
      id: t.id,
      weekday: t.weekday,
      start_time: t.startTime,
      duration_small: t.durationSmall,
      enabled: t.enabled,
    })),
  };
}

interface SlotViewPayload {
  readonly slot_start: string;
  readonly status: string;
  readonly ref: { readonly ref_type: string; readonly ref_id: number } | null;
}

function toSlotViewPayload(rows: SlotViewRow[]): SlotViewPayload[] {
  return rows.map((r) => ({
    slot_start: r.slotStart.toISOString(),
    status: r.status,
    ref: r.ref ? { ref_type: r.ref.refType, ref_id: r.ref.refId } : null,
  }));
}

@Controller('lawyer')
@UseFilters(AppHttpExceptionFilter)
export class TimeTableController {
  constructor(private readonly timeTable: TimeTableService) {}

  /** GET /lawyer/{id}/schedule：{version, templates[]}（公开读，见头注鉴权口径） */
  @Get(':id/schedule')
  async schedule(
    @Param('id') id: string,
  ): Promise<{ version: number; templates: TemplatePayload[] }> {
    return toTemplatePayload(await this.timeTable.getSchedule(parseLawyerId(id)));
  }

  /** PUT /lawyer/schedule：全量替换（幂等键=lawyer+version；lawyerId 取 JWT claims，不收 body 注入） */
  @Put('schedule')
  @UseGuards(IdentityAuthGuard, IdentityRoleGuard)
  @RequireRole('lawyer')
  async replaceSchedule(
    @CurrentIdentity() identity: IdentityClaims,
    @Body() body: unknown,
  ): Promise<{ version: number; templates: TemplatePayload[] }> {
    const input = parseReplaceScheduleBody(body);
    return toTemplatePayload(await this.timeTable.replaceSchedule(identity.userId, input));
  }

  /** GET /lawyer/{id}/slots?from=&to=：状态视图（公开/用户态均可，见头注鉴权口径） */
  @Get(':id/slots')
  async slots(@Param('id') id: string, @Query() query: unknown): Promise<SlotViewPayload[]> {
    const { from, to } = parseSlotRangeQuery(query);
    return toSlotViewPayload(await this.timeTable.slotViews(parseLawyerId(id), from, to));
  }
}
