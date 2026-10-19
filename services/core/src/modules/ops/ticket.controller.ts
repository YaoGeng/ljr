/**
 * H3 纠纷工单 REST 面（§5 契约表 + 任务简报扩展位）：
 *   GET  /admin/tickets?category=&status=&limit=  工单列表（行内 sla_overdue 布尔数据位）
 *   GET  /admin/tickets/sla-stats                 SLA 统计面（超时率口径留 H4，本批计数）
 *   POST /admin/tickets                           人工建单（幂等键=category+ref ⚠W2-9）
 *   GET  /admin/tickets/{id}                      详情（含 ticket_actions 审计行）
 *   POST /admin/tickets/{id}/resolve              处置 {action_payload?, approved}
 *                                                （终态 409 CLOSED；幂等键=ticket）
 *
 * 鉴权：lawyer-admin.controller 既有 guard 形态（A.4 逐字）——类级 IdentityAuthGuard+
 * IdentityRoleGuard + 每端点 @RequireRole('admin')：未认证 401 / 未持 admin 旗标 403。
 *
 * 路由声明序注意：sla-stats 先于 :id（避免动态段吞并具名路径）。
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
import { AppHttpExceptionFilter } from '../../infrastructure/app-error.filter';
import { parsePositiveInt } from '../../infrastructure/parse-positive-int';
import {
  CurrentIdentity,
  IdentityAuthGuard,
  IdentityRoleGuard,
  RequireRole,
  type IdentityClaims,
} from '../identity/identity.guards';
import { parseCreateTicketBody, parseResolveTicketBody, parseTicketListQuery } from './ticket.http';
import { TicketService } from './ticket.service';

@Controller('admin/tickets')
@UseFilters(AppHttpExceptionFilter)
@UseGuards(IdentityAuthGuard, IdentityRoleGuard)
export class TicketController {
  constructor(private readonly tickets: TicketService) {}

  /** GET /admin/tickets：列表（category/status 筛选；新单在前；sla_overdue 数据位） */
  @Get()
  @RequireRole('admin')
  async list(
    @Query('category') category?: string,
    @Query('status') status?: string,
    @Query('limit') limit?: string,
  ): Promise<{ items: Awaited<ReturnType<TicketService['listTickets']>> }> {
    const items = await this.tickets.listTickets(parseTicketListQuery({ category, status, limit }));
    return { items };
  }

  /** GET /admin/tickets/sla-stats：SLA 统计面（open/overdue 计数 + 分类计数；H4 超时率留位） */
  @Get('sla-stats')
  @RequireRole('admin')
  slaStats(): Promise<Awaited<ReturnType<TicketService['slaStats']>>> {
    return this.tickets.slaStats();
  }

  /** POST /admin/tickets：人工建单（事件建单走 relay 消费面不经此端点） */
  @Post()
  @RequireRole('admin')
  async create(
    @CurrentIdentity() identity: IdentityClaims,
    @Body() body: unknown,
  ): Promise<{ created: boolean; ticket_id: number; status: string }> {
    const res = await this.tickets.createTicket(parseCreateTicketBody(body));
    return { created: res.created, ticket_id: res.ticket.id, status: res.ticket.status };
  }

  /** GET /admin/tickets/{id}：详情（含 ticket_actions 审计行） */
  @Get(':id')
  @RequireRole('admin')
  detail(@Param('id') id: string): Promise<Awaited<ReturnType<TicketService['getTicketDetail']>>> {
    return this.tickets.getTicketDetail(parsePositiveInt(id, 'ticket_id'));
  }

  /** POST /admin/tickets/{id}/resolve：处置（approved=true→RESOLVED / false→REJECTED；
   *  action_payload.target 触发回调发起方——pricing 真链 / d4=W2 T3 接线位；终态 409 CLOSED） */
  @Post(':id/resolve')
  @HttpCode(200) // 动作端点非资源创建（rule-admin/payment @HttpCode(200) 先例）
  @RequireRole('admin')
  async resolve(
    @Param('id') id: string,
    @CurrentIdentity() identity: IdentityClaims,
    @Body() body: unknown,
  ): Promise<{ status: string }> {
    const { approved, actionPayload } = parseResolveTicketBody(body);
    return this.tickets.resolveTicket({
      ticketId: parsePositiveInt(id, 'ticket_id'),
      operatorId: identity.userId,
      approved,
      actionPayload,
    });
  }
}
