/**
 * H4 数据看板查询面 REST（§5：GET /admin/dashboard/metrics?group=core|health&from=&to=）。
 *
 * 鉴权（G-A 前置门，lawyer-admin 先例）：类级 IdentityAuthGuard+IdentityRoleGuard +
 * @RequireRole('admin')——未认证 401 / 未持 admin 旗标 403 E_ROLE_FORBIDDEN。
 * 巡检内部 job 与告警不在本面（RISK_PATROL 既有，M1-W4 T1——本批零改动）。
 */
import { Controller, Get, Query, UseFilters, UseGuards } from '@nestjs/common';
import { AppHttpExceptionFilter } from '../../infrastructure/app-error.filter';
import { IdentityAuthGuard, IdentityRoleGuard, RequireRole } from '../identity/identity.guards';
import { parseMetricsQuery } from './metrics.http';
import { MetricsService } from './metrics.service';

@Controller('admin/dashboard')
@UseFilters(AppHttpExceptionFilter)
@UseGuards(IdentityAuthGuard, IdentityRoleGuard)
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  /** GET /admin/dashboard/metrics：指标集（group 过滤；from/to 窗口缺省=全量） */
  @Get('metrics')
  @RequireRole('admin')
  dashboard(
    @Query('group') group?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): ReturnType<MetricsService['getMetrics']> {
    return this.metrics.getMetrics(parseMetricsQuery({ group, from, to }));
  }
}
