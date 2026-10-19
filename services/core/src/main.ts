import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { WsAdapter } from '@nestjs/platform-ws';
import { AppModule } from './app.module';
import { CONFIG_PROVIDER, type ConfigProvider } from './config/config-provider.interface';
import { TRACE_LOGGER } from './observability/observability.module';
import { TraceLogger } from './observability/trace-logger';
import { OutboxRelayService } from './infrastructure/outbox/outbox-relay.service';
import { NotifyDispatchWorker } from './modules/notify/notify-dispatch.worker';
import { SchedulerWorker } from './modules/schedule/scheduler.worker';
import { SlotLockService } from './modules/schedule/slot-lock.service';
import { PointsJobExecutors } from './modules/benefits/points.executors';
import { ReserveJobExecutors } from './modules/benefits/reserve.executors';
import { PatrolService } from './modules/ops/patrol.service';
import { ArtifactsJobExecutors } from './infrastructure/artifacts/artifacts.executors';
import { ConversationJobExecutors } from './modules/fulfillment/conversation.executors';

async function bootstrap(): Promise<void> {
  // bufferLogs：create 期间的启动日志先进缓冲，挂上 TraceLogger（含 trace_id 注入）后统一回放；
  // rawBody：F1 回调验签须对原始报文字节做 HMAC-SHA256（payment.controller /callbacks/{channel}）
  const app = await NestFactory.create(AppModule, { bufferLogs: true, rawBody: true });
  // D5 WSS 网关适配器（M2-W1 T3，⚠W1-2：WSS 进 core 单进程；路径 /ws 经 ConversationGateway
  // 装饰器声明）——**必须在 init/listen 前装**（网关初始化时读取；迟挂对既有网关不生效）
  app.useWebSocketAdapter(new WsAdapter(app));
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

  // F4 POINTS_EXPIRE 每日 job 引导（M1-W3 Task 2）：幂等注册首个次日扫期（上海 03:00，在册
  // PENDING 已存在则跳过），后续由执行器 DONE 前自投（ADR-0003 周期 job 自续口径）。引导失败
  // 必须留痕（同 SLOT_REAPER：一次性动作无 interval 自愈窗口，兜底线失效只能等进程重启再引导
  // ——过期还有惰性读路径兜可用性，物理扣减收敛延后不丢账）。
  app
    .get(PointsJobExecutors)
    .ensureDailyJobScheduled()
    .catch((e: unknown) => {
      app
        .get<TraceLogger>(TRACE_LOGGER)
        .error(`POINTS_EXPIRE 引导注册失败（每日过期扫不可用，待进程重启再引导）：${String(e)}`);
    });

  // F4 RESERVE_RECONCILE 日终备付对平 job 引导（M2-W2 T6；目录第 26 项）：幂等注册首个次日
  // 扫期（上海 04:00——03:00 过期扫之后，在册 PENDING 已存在则跳过），后续由执行器 DONE 前
  // 自投（ADR-0003 周期 job 自续口径，POINTS_EXPIRE/RISK_PATROL 同款）。引导失败必须留痕
  // （一次性动作无 interval 自愈窗口——对平停摆只能等进程重启再引导，R-05 资损面检出随之
  // 延后不丢账：差异对平为幂等只读比较，恢复后首轮即补检）。
  app
    .get(ReserveJobExecutors)
    .ensureDailyJobScheduled()
    .catch((e: unknown) => {
      app
        .get<TraceLogger>(TRACE_LOGGER)
        .error(
          `RESERVE_RECONCILE 引导注册失败（日终备付对平不可用，待进程重启再引导）：${String(e)}`,
        );
    });

  // H4 资损巡检周期 job 引导（M1-W4 Task 1）：幂等注册首个 RISK_PATROL（分钟级，在册 PENDING
  // 已存在则跳过），后续周期由执行器 DONE 前自投（ADR-0003 周期 job 自续口径，SLOT_REAPER/
  // POINTS_EXPIRE 同款）。引导失败必须留痕（一次性动作无 interval 自愈窗口——巡检停摆只能
  // 等进程重启再引导，资损违例检出随之延后不丢账：dedup 锚保证恢复后不重复入账）。
  app
    .get(PatrolService)
    .ensureScheduled()
    .catch((e: unknown) => {
      app
        .get<TraceLogger>(TRACE_LOGGER)
        .error(`RISK_PATROL 引导注册失败（资损巡检不可用，待进程重启再引导）：${String(e)}`);
    });

  // I3 RETENTION_PURGE 每日到期处置 job 引导（M2-W1 T2）：幂等注册首个（24h 后，在册 PENDING
  // 已存在则跳过），后续周期由执行器 DONE 前自投（ADR-0003 周期 job 自续口径，RISK_PATROL/
  // SLOT_REAPER/POINTS_EXPIRE 同款）。引导失败必须留痕（一次性动作无 interval 自愈窗口——
  // 处置停摆只能等进程重启再引导，恢复后 purged_at 判重保证不重复处置不重复出箱）。
  app
    .get(ArtifactsJobExecutors)
    .ensurePurgeScheduled()
    .catch((e: unknown) => {
      app
        .get<TraceLogger>(TRACE_LOGGER)
        .error(
          `RETENTION_PURGE 引导注册失败（存档到期处置不可用，待进程重启再引导）：${String(e)}`,
        );
    });

  // D5 COLD_ARCHIVE 每日消息冷存 job 引导（M2-W1 T3）：幂等注册首个（24h 后，在册 PENDING
  // 已存在则跳过），后续周期由执行器 DONE 前自投（RETENTION_PURGE/RISK_PATROL 同款）。引导
  // 失败必须留痕（一次性动作无 interval 自愈窗口——冷存停摆只能等进程重启再引导，恢复后
  // 「created_at<水位」扫描面+putArtifact hash 幂等保证不重复归档不丢消息）。
  app
    .get(ConversationJobExecutors)
    .ensureColdArchiveScheduled()
    .catch((e: unknown) => {
      app
        .get<TraceLogger>(TRACE_LOGGER)
        .error(`COLD_ARCHIVE 引导注册失败（消息冷存不可用，待进程重启再引导）：${String(e)}`);
    });

  // 监听端口经配置装载（M0-8：env PORT > config/<env>/app.env > 默认 3000）
  const config = app.get<ConfigProvider>(CONFIG_PROVIDER);
  const port = config.require<number>('port');
  await app.listen(port);
}

void bootstrap();
