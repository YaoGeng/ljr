import { describe, expect, it } from 'bun:test';
import { APP_NAME } from './app-info';

describe('@ljr/app 骨架冒烟', () => {
  it('暴露 App 名称占位', () => {
    expect(APP_NAME).toBe('律聚人');
    expect(APP_NAME.length).toBeGreaterThan(0);
  });
});
