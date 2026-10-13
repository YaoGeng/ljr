import { Controller, Get } from '@nestjs/common';

export interface HealthResponse {
  status: 'ok';
  service: '@ljr/core';
  timestamp: string;
}

@Controller()
export class HealthController {
  @Get('healthz')
  getHealth(): HealthResponse {
    return { status: 'ok', service: '@ljr/core', timestamp: new Date().toISOString() };
  }
}
