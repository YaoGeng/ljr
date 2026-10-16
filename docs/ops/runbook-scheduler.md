# Runbook — I2 调度 job FAILED 重放（W1 前置件④）

适用：`schedule.schedule_jobs` 行经退避重试 3 次仍失败转 `FAILED` 后的运维重放（FAILED 不自动重试）。

## 1. 现象识别

- 接口：`GET /admin/scheduler/jobs?status=FAILED`（返回 id/job_type/ref/last_error/retry_count）。
- 告警：`JOB_FAILED`（SchedulerAlertSink，mock 适配期记录于进程内存；真实通道 M2+ 接入，工单位=H3）。
- 归因：看该行 `last_error`（执行器异常摘要 `name: message`）与 `job_type` 对应执行器日志。

## 2. 前置检查

- PG 存活：本地栈 `node scripts/db/start.mjs`（端口 5435）；生产按环境等价探测。
- 读 `last_error` 判因：偶发（连接抖动/死锁/下游暂不可用）→ 可重放；确定性缺陷（契约/数据非法）→ 不重放，转 §5。
- 幂等回查锚点：执行器在抢占事务内自校（如 ref 实体已终态即幂等短路），重放不产生重复副作用；确认失败根因已消除再重放。

## 3. 重放操作

- I2 既有重放入口：`SchedulerService.replayJob(jobId)`（服务面）。语义：`FAILED→PENDING`、
  `retry_count=0`、`next_retry_at=now()`、`last_error=NULL`；返回 `{replayed:false}` = job 不存在或已非 FAILED（无需处理）。
- 等价路径：运维经服务直调（临时 bootstrap 脚本取 `SchedulerService` 后调 `replayJob`）；
  admin HTTP 管理面随 H 系接线补位，接线前不以裸 UPDATE 改状态（状态禁裸写：重放须经状态机留痕）。

## 4. 验证

- 重放后 `GET /admin/scheduler/jobs?status=PENDING` 见该 job 且 `retry_count=0`。
- Worker 下一 tick 拾取推进至 `DONE`；再次查 `status=FAILED` 应无该行。
- 若重放后仍 FAILED：**停止继续重放**（避免烧退避与告警噪音），转 §5。

## 5. 升级路径

- 二次 FAILED 即升级：附 job_id / last_error / 对应执行器日志开缺陷单，人工修复数据或代码后再走 §3。
- 涉及房间开台（ROOM_OPEN）超时未推进：同步评估 D5 履约缺席口径（锚定约定开始时刻），必要时人工干预履约侧。

## 多实例幂等性说明

`replayJob` 以 `SELECT ... WHERE id=$1 AND status='FAILED' FOR UPDATE` 行锁+状态条件收口：
并发重放/多实例同 job 恰一生效，其余方拿到 `{replayed:false}`，天然幂等零副作用。
执行侧由 SKIP LOCKED 保证多节点恰一抢占；执行器自身幂等（回查锚点见 §2），重放即安全。
