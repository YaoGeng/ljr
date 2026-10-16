import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { CONFIG_PROVIDER, type ConfigProvider } from './config/config-provider.interface';
import { TRACE_LOGGER } from './observability/observability.module';
import { TraceLogger } from './observability/trace-logger';
import { OutboxRelayService } from './infrastructure/outbox/outbox-relay.service';
import { NotifyDispatchWorker } from './modules/notify/notify-dispatch.worker';
import { SchedulerWorker } from './modules/schedule/scheduler.worker';
import { SlotLockService } from './modules/schedule/slot-lock.service';

async function bootstrap(): Promise<void> {
  // bufferLogs：create 期间的启动日志先进缓冲，挂上 TraceLogger（含 trace_id 注入）后统一回放；
  // rawBody：F1 回调验签须对原始报文字节做 HMAC-SHA256（payment.controller /callbacks/{channel}）
  const app = await NestFactory.create(AppModule, { bufferLogs: true, rawBody: true });
  app.useLogger(app.get(TRACE_LOGGER));
  app.enableShutdownHooks(); // SIGTERM/SIGINT → relay/notify worker stop + 观测 shutdown(flush) + 连接池回收

  // Outbox relay 后台轮询（M0-4）：interval 经 LJR_OUTBOX_RELAY_INTERVAL_MS 配置；
  // 仅进程入口启动——测试/嵌入场景直接调 tick()，不经此路径。
  app.get(OutboxRelayService).start();

  // 通知下发 worker（M1-W1 I1）：interval 经 LJR_NOTIFY_DISPATCH_INTERVAL_MS 配置，同上仅入口启动
  app.get(NotifyDispatchWorker).start();

  // 调度节拍器（M1-W1 I2，ADR-0003）：双通道 interval 经 LJR_SCHEDULER_*_INTERVAL_MS 配置，
  // 仅入口启动（调度器不自启动）；节拍为内存态非事实源，正确性不依赖它
  app.get(SchedulerWorker).start();

  // B2 reaper 周期 job 引导（M1-W1 Task 3）：幂等注册首个 SLOT_REAPER（在册 PENDING 已存在则跳过），
  // 后续周期由执行器 DONE 前自投（ADR-0003 周期 job 自续口径）。引导失败必须留痕（一次性动作
  // 无 interval 自愈窗口，兜底线失效只能等进程重启再引导——区别于节拍器单轮吞错）。
  app
    .get(SlotLockService)
    .ensureReaperScheduled()
    .catch((e: unknown) => {
      app
        .get<TraceLogger>(TRACE_LOGGER)
        .error(`SLOT_REAPER 引导注册失败（reaper 兜底不可用，待进程重启再引导）：${String(e)}`);
    });

  // 监听端口经配置装载（M0-8：env PORT > config/<env>/app.env > 默认 3000）
  const config = app.get<ConfigProvider>(CONFIG_PROVIDER);
  const port = config.require<number>('port');
  await app.listen(port);
}

void bootstrap();
