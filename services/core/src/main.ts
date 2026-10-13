import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { CONFIG_PROVIDER, type ConfigProvider } from './config/config-provider.interface';
import { TRACE_LOGGER } from './observability/observability.module';
import { OutboxRelayService } from './infrastructure/outbox/outbox-relay.service';

async function bootstrap(): Promise<void> {
  // bufferLogs：create 期间的启动日志先进缓冲，挂上 TraceLogger（含 trace_id 注入）后统一回放
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(TRACE_LOGGER));
  app.enableShutdownHooks(); // SIGTERM/SIGINT → relay.stop + 观测 shutdown(flush) + 连接池回收

  // Outbox relay 后台轮询（M0-4）：interval 经 LJR_OUTBOX_RELAY_INTERVAL_MS 配置；
  // 仅进程入口启动——测试/嵌入场景直接调 tick()，不经此路径。
  app.get(OutboxRelayService).start();

  // 监听端口经配置装载（M0-8：env PORT > config/<env>/app.env > 默认 3000）
  const config = app.get<ConfigProvider>(CONFIG_PROVIDER);
  const port = config.require<number>('port');
  await app.listen(port);
}

void bootstrap();
