/**
 * GET /admin/scheduler/jobs?status=&type=&limit= （I2 §5 运维视图：job 清单与状态筛选）。
 * 后台鉴权 ⚠决策位：admin 角色鉴权随 H1/H2（W2+）接入后替换，本批次只交付接口形态。
 */
import { Controller, Get, Query, UseFilters } from '@nestjs/common';
import { AppHttpExceptionFilter } from '../../infrastructure/app-error.filter';
import { SchedulerService } from './scheduler.service';
import { parseJobLimit, parseJobStatus, parseJobType } from './scheduler.http';

@Controller('admin/scheduler')
@UseFilters(AppHttpExceptionFilter)
export class SchedulerAdminController {
  constructor(private readonly scheduler: SchedulerService) {}

  @Get('jobs')
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
