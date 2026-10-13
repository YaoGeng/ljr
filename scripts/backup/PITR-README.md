# PITR 备份与恢复（staging 起用；dev 只交付不运行）

> M0-3 交付。架构口径：**PITR 备份，日全量 + WAL**（docs/02-架构设计.md §5.2「迁移/备份」）。
> 生产回退依赖前向修复（新增补偿迁移）+ PITR（ADR-0002），与「down=drop schema 整库重放」的 dev 演练口径是两件事。
> 当前状态：**模板已交付、未在任何环境运行**；staging 建库时按本文件启用并做一次恢复演练。

## 1. 组成

| 文件              | 角色                                                                    |
| ----------------- | ----------------------------------------------------------------------- |
| `basebackup.mjs`  | 日全量基线：`pg_basebackup -Fp -Xs --checkpoint=fast`，输出目录形态基线 |
| `wal-archive.mjs` | WAL 归档：`archive_command` 调用，落归档目录，失败退出码 1 交 PG 重试   |
| 本 README         | 配置、保留策略、恢复步骤                                                |

## 2. staging 启用清单

1. **备份账号**：`CREATE ROLE backup WITH LOGIN REPLICATION;`（口令经环境变量 `PITR_PG_PASSWORD` 注入，禁入文件）。
2. **pg_hba.conf** 放行本机 replication 连接（`host replication backup 127.0.0.1/32 scram-sha-256`）。
3. **postgresql.conf**：

   ```conf
   wal_level = replica
   archive_mode = on
   archive_command = 'node /opt/ljr/scripts/backup/wal-archive.mjs "%p" "%f"'
   ```

   （`PITR_WAL_ARCHIVE_DIR` 指向独立磁盘/挂载点；节点进程环境注入。）

4. **cron（每日 02:30 Asia/Shanghai）**：

   ```cron
   30 2 * * * cd /opt/ljr && PITR_BACKUP_DIR=/backups PITR_PG_BIN=/usr/lib/postgresql/15/bin PITR_PG_USER=backup PITR_PG_PASSWORD=*** node scripts/backup/basebackup.mjs >> /var/log/ljr-basebackup.log 2>&1
   ```

5. **保留策略（起步值，staging 观察后调）**：基线保留 **14 份**（≈14 天）+ WAL 归档保留 **30 天**；
   清理脚本随首次真实备份补（先恢复演练、再清理，避免误删唯一可用链）。
6. **验证节奏**：启用后立即做一次完整恢复演练（§3）；此后每月一次 + 每次大版本升级前一次。

## 3. 恢复步骤（PITR 到任意时刻）

前提：拿到一份基线目录（`/backups/base/<stamp>`，`-Xs` 保证基线自洽）+ 其后连续的 WAL 归档。

1. 新建空数据目录，把基线目录内容完整拷入（权限属主改为 postgres 用户）。
2. 在数据目录建 `recovery.signal`（空文件）。
3. `postgresql.conf` 追加：

   ```conf
   restore_command = 'cp /backups/wal_archive/%f %p'
   recovery_target_time = '2026-10-13 12:34:56+08'   # 目标时刻（Asia/Shanghai 口径，架构 §1.3）
   recovery_target_action = 'promote'
   ```

4. 启动实例：自动重放 WAL 至目标时刻并 promote。
5. 校验：业务 schema 完整性（`\dn` 13 个业务 schema）、关键表行数/最近写入时间与预期核对。
6. 恢复出的实例只做核查用，确认数据后按需切换流量（V1 单库形态：停写→恢复→切换）。

## 4. 指标与边界

- **RPO** ≈ 归档延迟（正常 ≤ 1 个 WAL 段，16MB）；
- **RTO** 取决于基线大小与 WAL 重放量，staging 首次演练后记录实测值；
- 归档目录写满或 `archive_command` 持续失败会使 WAL 堆积（`pg_stat_archiver` 监控 failed_count）；
- 备份不含 OSS 对象（录音/文件走对象存储版本化，另行备份，见架构 §5.2 留存合规要求）。
