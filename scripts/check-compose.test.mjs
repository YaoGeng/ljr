// scripts/check-compose.test.mjs —— docker/dev compose 结构断言（M0-8 本机验证口径的固化）
//
// 本机无容器运行时（Ruling-6）：「一键 up 全栈绿」降级为结构断言（控制者裁定）——
// compose 文件的任何改动若丢了服务/丢了 tag 锁定/丢了 healthcheck/把端口暴露到非回环/塞进密钥字面量，
// `bun test scripts/` 即刻红。真实全栈健康演练标注【待 docker 环境补全栈演练】
//（compose 文件头同款标注；GitHub Actions 容器环境或后续本机 docker 补跑）。
// 手法对齐 check-ci-workflow.test.mjs：js-yaml 解析 + 语义断言，不依赖 docker 二进制。
import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as yamlLoad } from 'js-yaml';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const COMPOSE_PATH = path.resolve(HERE, '..', 'docker', 'dev', 'docker-compose.yml');
const raw = fs.readFileSync(COMPOSE_PATH, 'utf8');
const compose = yamlLoad(raw);
const services = compose.services;

const service = (id) => services[id];
const image = (id) => service(id)?.image ?? '';

/** 常驻服务清单（flyway 是 run-once 迁移 job，无 healthcheck 属正确形态） */
const LONG_RUNNING = ['postgres', 'redis', 'rocketmq-namesrv', 'rocketmq-broker', 'nacos'];

describe('compose：M0-8 全栈服务齐备（服务语义映射）', () => {
  test('六服务齐全：pg/flyway（M0-3 既有）+ redis/rocketmq 双容器/nacos（M0-8 扩展）', () => {
    expect(Object.keys(services).sort()).toEqual(
      ['flyway', 'nacos', 'postgres', 'redis', 'rocketmq-broker', 'rocketmq-namesrv'].sort(),
    );
  });

  test('rocketmq 双容器方案：broker 依赖 nameserver healthy（注册序）', () => {
    expect(service('rocketmq-broker').depends_on).toEqual({
      'rocketmq-namesrv': { condition: 'service_healthy' },
    });
  });

  test('nacos standalone（embedded derby）+ dev 关鉴权', () => {
    const env = service('nacos').environment;
    expect(env.MODE).toBe('standalone');
    expect(String(env.NACOS_AUTH_ENABLE)).toBe('false');
  });
});

describe('compose：镜像锁 tag（ADR-0002：禁 latest/裸镜像）', () => {
  test('全部镜像带具体 tag 且无 latest', () => {
    for (const id of Object.keys(services)) {
      expect(image(id), `${id} 镜像须为 repo:tag`).toMatch(/^[\w./-]+:[\w.-]+$/);
      expect(image(id), `${id} 禁 latest`).not.toContain('latest');
    }
  });

  test('三件选型：redis 7.x 官方库镜像 / apache 官方 rocketmq / 官方 nacos-server', () => {
    expect(image('redis')).toMatch(/^redis:7\./);
    expect(image('rocketmq-namesrv')).toMatch(/^apache\/rocketmq:/);
    expect(image('rocketmq-broker')).toBe(image('rocketmq-namesrv')); // 同版本，防漂移
    expect(image('nacos')).toMatch(/^nacos\/nacos-server:/);
  });
});

describe('compose：健康检查与端口绑定', () => {
  test('常驻服务均带 healthcheck（flyway 为 run-once job，豁免）', () => {
    for (const id of LONG_RUNNING) {
      expect(service(id).healthcheck, `${id} 须有 healthcheck`).toBeDefined();
      expect(service(id).healthcheck.test.length).toBeGreaterThan(0);
    }
    expect(service('flyway').healthcheck).toBeUndefined();
  });

  test('所有端口映射仅绑 127.0.0.1（dev 单机口径）', () => {
    for (const id of Object.keys(services)) {
      for (const mapping of service(id).ports ?? []) {
        expect(mapping, `${id} 端口 ${mapping} 须绑回环`).toMatch(/^127\.0\.0\.1:\d+:\d+$/);
      }
    }
  });

  test('redis healthcheck 校验输出 PONG（未认证 ping 退出码恒 0，须 grep 兜底）', () => {
    const test = service('redis').healthcheck.test.join(' ');
    expect(test).toContain('grep -q PONG');
  });
});

describe('compose：密钥红线（架构 §1.3）', () => {
  test('口令/令牌类 env 一律 ${VAR} 插值注入，无字面量真值', () => {
    for (const id of Object.keys(services)) {
      const entries = service(id).environment ?? {};
      for (const [key, value] of Object.entries(entries)) {
        // 只盯真密钥键（PASSWORD/TOKEN/SECRET）；NACOS_AUTH_ENABLE 是开关非凭据
        if (/PASSWORD|TOKEN|SECRET/i.test(key)) {
          expect(String(value), `${id}.${key} 须为 \${VAR} 注入`).toMatch(/^\$\{[^}]+\}$/);
        }
      }
    }
  });

  test('redis requirepass 口令同为 ${VAR} 注入（command 内）', () => {
    const cmd = service('redis').command;
    const i = cmd.indexOf('--requirepass');
    expect(cmd[i + 1]).toMatch(/^\$\{LJR_REDIS_PASSWORD/);
  });

  test('头注标注【待 docker 环境补全栈演练】（降级口径留痕）', () => {
    expect(raw).toContain('待 docker 环境补全栈演练');
  });
});
