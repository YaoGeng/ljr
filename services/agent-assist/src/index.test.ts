import { describe, expect, it } from 'bun:test';
import { SERVICE_NAME, createServiceSkeleton } from './index';

describe('@ljr/agent-assist 骨架冒烟', () => {
  it('暴露服务名，启动/停止占位可调用', async () => {
    expect(SERVICE_NAME).toBe('agent-assist');
    const svc = createServiceSkeleton();
    await svc.start();
    await svc.stop();
  });
});
