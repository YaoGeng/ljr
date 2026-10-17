/**
 * GET /admin/scheduler/jobs?status=&type=&limit= （I2 §5 运维视图：job 清单与状态筛选）。
 * W3 T10 G-A 同批接线：⚠决策位占位兑现——运维视图属 admin 面，挂 IdentityAuthGuard+
 * IdentityRoleGuard + @RequireRole('admin')（未认证 401 / 未持 admin 旗标 403）。
 */
import { Controller, Get, Query, UseFilters, UseGuards } from '@nestjs/common';
import { AppHttpExceptionFilter } from '../../infrastructure/app-error.filter';
import { IdentityAuthGuard, IdentityRoleGuard, RequireRole } from '../identity/identity.guards';
import { SchedulerService } from './scheduler.service';
import { parseJobLimit, parseJobStatus, parseJobType } from './scheduler.http';

@Controller('admin/scheduler')
@UseFilters(AppHttpExceptionFilter)
@UseGuards(IdentityAuthGuard, IdentityRoleGuard)
export class SchedulerAdminController {
  constructor(private readonly scheduler: SchedulerService) {}

  @Get('jobs')
  @RequireRole('admin')
  jobs(
    @Query('status') status?: string,
    @Query('type') type?: string,
    @Query('limit') limit?: string,
  ): ReturnType<SchedulerService['listJobs']> {
    return this.scheduler.listJobs({
      status: parseJobStatus(status),
      jobType: parseJobType(type),
      limit: parseJobLimit(limit),
    });
  }
}
