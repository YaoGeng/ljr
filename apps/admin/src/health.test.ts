import { describe, expect, it } from 'bun:test';
import { ADMIN_APP_NAME, healthStatus } from './health';

describe('@ljr/admin 骨架冒烟', () => {
  it('/health 数据源返回 ok', () => {
    expect(healthStatus()).toBe('ok');
    expect(ADMIN_APP_NAME).toContain('律聚人');
  });
});
