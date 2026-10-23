import { beforeEach, describe, expect, it } from 'bun:test';
import { apiBaseUrl, setApiBaseUrl } from './config';

const ENV_KEY = 'VITE_API_BASE';

beforeEach(() => {
  setApiBaseUrl(); // 清 override
  delete process.env[ENV_KEY];
});

describe('admin API 基址解析（M3-W3 T1：VITE_API_BASE，缺省空串=同源）', () => {
  it('缺省=空串（同源相对路径——dev 走 vite proxy / 部署走反代）', () => {
    expect(apiBaseUrl()).toBe('');
  });

  it('process.env 注入生效（bun test 运行态面）+ 尾斜杠剥除', () => {
    process.env[ENV_KEY] = 'http://127.0.0.1:3000/';
    expect(apiBaseUrl()).toBe('http://127.0.0.1:3000');
    process.env[ENV_KEY] = 'http://core.test//';
    expect(apiBaseUrl()).toBe('http://core.test');
  });

  it('setApiBaseUrl override 优先于 env；无参调用清除回 env 缺省', () => {
    process.env[ENV_KEY] = 'http://env-value';
    setApiBaseUrl('http://override-value/');
    expect(apiBaseUrl()).toBe('http://override-value');
    setApiBaseUrl();
    expect(apiBaseUrl()).toBe('http://env-value');
  });
});
