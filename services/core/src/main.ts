import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { CONFIG_PROVIDER, type ConfigProvider } from './config/config-provider.interface';
import { OutboxRelayService } from './infrastructure/outbox/outbox-relay.service';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks(); // SIGTERM/SIGINT → relay.stop + 连接池回收

  // Outbox relay 后台轮询（M0-4）：interval 经 LJR_OUTBOX_RELAY_INTERVAL_MS 配置；
  // 仅进程入口启动——测试/嵌入场景直接调 tick()，不经此路径。
  app.get(OutboxRelayService).start();

  // 监听端口经配置装载（M0-8：env PORT > config/<env>/app.env > 默认 3000）
  const config = app.get<ConfigProvider>(CONFIG_PROVIDER);
  const port = config.require<number>('port');
  await app.listen(port);
}

void bootstrap();
