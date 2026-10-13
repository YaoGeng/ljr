// scripts/check-observability.test.mjs —— M0-9 观测栈结构断言（Ruling-6 降级口径的固化）
//
// 本机无容器运行时：「观测四件+alertmanager 占位 up 起来、jaeger 可查、grafana 面板可见」降级为：
//   ① compose 观测段结构断言（服务齐/tag 锁/healthcheck/回环绑定/口令插值/挂载就位）
//   ② prometheus / otel-collector / alertmanager / grafana provisioning 配置文件可解析且语义就位
//   ③ core 侧 span/trace 真实产生 + trace_id 入日志行为另有 vitest 断言（services/core/src/observability/）
// 端到端演练标注【待 docker 环境补端到端演练】（compose 文件头与 docs/plans/M0-9-观测基座说明.md 同款）。
// 手法对齐 check-compose.test.mjs：js-yaml 解析 + 语义断言，不依赖 docker 二进制。
import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as yamlLoad } from 'js-yaml';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEV = path.resolve(HERE, '..', 'docker', 'dev');

const read = (...parts) => fs.readFileSync(path.join(DEV, ...parts), 'utf8');
const readYaml = (...parts) => yamlLoad(read(...parts));

const composeRaw = read('docker-compose.yml');
const compose = yamlLoad(composeRaw);
const services = compose.services;
const service = (id) => services[id];

const OBS_SERVICES = ['otel-collector', 'jaeger', 'prometheus', 'grafana', 'alertmanager'];

describe('compose 观测段：四件 + alertmanager 占位齐备', () => {
  test('五服务均在且镜像锁定家族 tag（禁 latest/裸镜像）', () => {
    const expected = {
      'otel-collector': /^otel\/opentelemetry-collector-contrib:0\./,
      jaeger: /^jaegertracing\/all-in-one:2\./,
      prometheus: /^prom\/prometheus:v3\./,
      grafana: /^grafana\/grafana:12\./,
      alertmanager: /^prom\/alertmanager:v0\./,
    };
    for (const [id, pattern] of Object.entries(expected)) {
      expect(service(id), `${id} 服务缺失`).toBeDefined();
      expect(service(id).image, `${id} 镜像须匹配 ${pattern}`).toMatch(pattern);
      expect(service(id).image, `${id} 禁 latest`).not.toContain('latest');
    }
  });

  test('全部带 healthcheck（常驻口径同 check-compose 的 LONG_RUNNING 覆盖）', () => {
    for (const id of OBS_SERVICES) {
      expect(service(id).healthcheck, `${id} 须有 healthcheck`).toBeDefined();
      expect(service(id).healthcheck.test.length).toBeGreaterThan(0);
    }
  });

  test('端口映射仅绑 127.0.0.1（dev 单机口径）；grafana 让位 3000 映射 3300', () => {
    for (const id of OBS_SERVICES) {
      for (const mapping of service(id).ports ?? []) {
        expect(mapping, `${id} 端口 ${mapping} 须绑回环`).toMatch(/^127\.0\.0\.1:\d+:\d+$/);
      }
    }
    expect(service('grafana').ports).toContain('127.0.0.1:3300:3000');
    // collector 对宿主只开 OTLP 收口（4317/4318）；8889 抓取口不暴露宿主机
    expect(service('otel-collector').ports).toEqual(['127.0.0.1:4317:4317', '127.0.0.1:4318:4318']);
  });

  test('配置文件均以只读卷挂载（compose 引用与仓库文件一一对应）', () => {
    const mounts = (id) => (service(id).volumes ?? []).map((v) => v.split(':')[0]);
    expect(mounts('otel-collector')).toContain('./otel-collector/config.yaml');
    expect(mounts('prometheus')).toContain('./prometheus/prometheus.yml');
    expect(mounts('prometheus')).toContain('./prometheus/rules/ljr-alerts.yml');
    expect(mounts('alertmanager')).toContain('./alertmanager/alertmanager.yml');
    expect(mounts('grafana')).toContain('./grafana/provisioning');
    expect(mounts('grafana')).toContain('./grafana/dashboards');
    for (const f of [
      ['otel-collector', 'config.yaml'],
      ['prometheus', 'prometheus.yml'],
      ['prometheus', 'rules', 'ljr-alerts.yml'],
      ['alertmanager', 'alertmanager.yml'],
    ]) {
      expect(fs.existsSync(path.join(DEV, ...f)), `${f.join('/')} 须入库`).toBe(true);
    }
  });

  test('grafana 管理口令 ${VAR} 注入（密钥红线，架构 §1.3）', () => {
    const env = service('grafana').environment;
    expect(String(env.GF_SECURITY_ADMIN_PASSWORD)).toMatch(/^\$\{LJR_GRAFANA_PASSWORD/);
    expect(read('.env.example')).toContain('LJR_GRAFANA_PASSWORD=ljr-dev-only');
  });

  test('头注标注【待 docker 环境补端到端演练】（降级口径留痕）', () => {
    expect(composeRaw).toContain('待 docker 环境补端到端演练');
  });
});

describe('otel-collector 配置（config.yaml）', () => {
  const cfg = readYaml('otel-collector', 'config.yaml');

  test('otlp 接收器开 grpc(4317)+http(4318)，与 compose 端口口径一致', () => {
    expect(cfg.receivers.otlp.protocols.grpc.endpoint).toBe('0.0.0.0:4317');
    expect(cfg.receivers.otlp.protocols.http.endpoint).toBe('0.0.0.0:4318');
  });

  test('traces → otlp/jaeger（容器网内 grpc，dev 无 TLS）；metrics → prometheus(8889)', () => {
    expect(cfg.exporters['otlp/jaeger'].endpoint).toBe('jaeger:4317');
    expect(cfg.exporters['otlp/jaeger'].tls.insecure).toBe(true);
    expect(cfg.exporters.prometheus.endpoint).toBe('0.0.0.0:8889');
    expect(cfg.service.pipelines.traces).toEqual({
      receivers: ['otlp'],
      processors: ['batch'],
      exporters: ['otlp/jaeger'],
    });
    expect(cfg.service.pipelines.metrics.exporters).toContain('prometheus');
    // 资源属性转 label：service.name 可入面板/告警聚合维度
    expect(cfg.exporters.prometheus.resource_to_telemetry_conversion.enabled).toBe(true);
  });

  test('health_check 扩展就位（对应 compose healthcheck 的 13133 口径）', () => {
    expect(cfg.extensions.health_check.endpoint).toBe('127.0.0.1:13133');
    expect(cfg.service.extensions).toContain('health_check');
  });
});

describe('prometheus 配置（prometheus.yml + rules）', () => {
  const cfg = readYaml('prometheus', 'prometheus.yml');

  test('抓取面恰两 job：自监控 + otel-collector:8889（core 无 /metrics，指标走 OTLP→collector）', () => {
    const jobs = cfg.scrape_configs.map((s) => s.job_name).sort();
    expect(jobs).toEqual(['otel-collector', 'prometheus']);
    const collector = cfg.scrape_configs.find((s) => s.job_name === 'otel-collector');
    expect(collector.static_configs[0].targets).toContain('otel-collector:8889');
  });

  test('告警联动：rule_files 挂载占位规则，alertmanager 指向同 compose 段服务', () => {
    expect(cfg.rule_files).toContain('/etc/prometheus/rules/ljr-alerts.yml');
    expect(cfg.alerting.alertmanagers[0].static_configs[0].targets).toContain('alertmanager:9093');
  });

  test('规则文件可解析且为占位口径（alert+expr 就位，不发明真实告警面）', () => {
    const rules = readYaml('prometheus', 'rules', 'ljr-alerts.yml');
    const first = rules.groups[0].rules[0];
    expect(first.alert).toBe('LjrScrapeTargetDown');
    expect(first.expr).toBe('up == 0');
  });
});

describe('alertmanager 占位配置', () => {
  const cfg = readYaml('alertmanager', 'alertmanager.yml');
  const raw = read('alertmanager', 'alertmanager.yml');

  test('webhook 接收器预留（占位端点，非真实凭据/通道）', () => {
    expect(cfg.route.receiver).toBe('ljr-webhook');
    const receiver = cfg.receivers.find((r) => r.name === 'ljr-webhook');
    expect(receiver.webhook_configs[0].url).toMatch(/^http:\/\//);
  });

  test('电话级通道仅注释占位（PRD 未定义，docs/04 §8 待澄清——不擅自发明）', () => {
    expect(raw).toContain('电话级通道仅注释占位');
  });
});

describe('grafana provisioning', () => {
  test('数据源预配 prometheus（默认）+ jaeger', () => {
    const cfg = readYaml('grafana', 'provisioning', 'datasources', 'datasources.yml');
    const byType = Object.fromEntries(cfg.datasources.map((d) => [d.type, d]));
    expect(byType.prometheus.url).toBe('http://prometheus:9090');
    expect(byType.prometheus.isDefault).toBe(true);
    expect(byType.jaeger.url).toBe('http://jaeger:16686');
  });

  test('dashboard provider 从挂载目录装载', () => {
    const cfg = readYaml('grafana', 'provisioning', 'dashboards', 'dashboards.yml');
    expect(cfg.providers[0].options.path).toBe('/var/lib/grafana/dashboards');
  });

  test('占位面板 JSON 可解析：uid 唯一、≥3 面板、每面板 type/targets 就位', () => {
    const dash = JSON.parse(read('grafana', 'dashboards', 'ljr-m0-overview.json'));
    expect(dash.uid).toBe('ljr-m0-overview');
    expect(dash.title).toContain('LJR');
    expect(dash.panels.length).toBeGreaterThanOrEqual(3);
    for (const panel of dash.panels) {
      expect(panel.type, `面板 ${panel.id} 缺 type`).toBeTruthy();
      expect(panel.targets[0].expr, `面板 ${panel.id} 缺查询`).toBeTruthy();
    }
    // 占位查询的「待首跑校准」口径留痕（与 docs/plans/M0-9 §6 演练清单呼应）
    expect(dash.description).toContain('待 docker 首跑');
  });
});
