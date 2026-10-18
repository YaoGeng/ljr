/**
 * I3 文件与存证模块（M2-W1 T2，⚠W1-4 归属裁定）：横切基座——代码落 src/infrastructure/artifacts/
 * （outbox/state-machine 先例），表落 platform schema（V36），不注册 src/modules。
 *
 * 模块独立装配（而非并入 InfrastructureModule）的原因：RETENTION_PURGE 自投须消费 I2
 * SchedulerModule（registerJob/findPendingJobId 导出面）、调取面守卫须消费 A1 IdentityAuthModule
 * （叶子模块）——两者均依赖 InfrastructureModule，基座模块反向 import 即成环；故本模块平级挂
 * AppModule（物理归属仍是 infrastructure 目录，依赖方向保持单向：
 * ArtifactsModule → {Infrastructure, Scheduler, IdentityAuth}）。
 *
 * 供应商位（外部对接后置约定 2026-10-14）：ARTIFACT_STORE=W1 本地 FS（S3 兼容 OSS 换装只改
 * 工厂，根目录经 config artifacts.dir）；EVIDENCE_CHAIN=W1 mock（D-P9 至信链真对接后换装）。
 */
import { Module } from '@nestjs/common';
import { CONFIG_PROVIDER, type ConfigProvider } from '../../config/config-provider.interface';
import { InfrastructureModule } from '../infrastructure.module';
import { SchedulerModule } from '../../modules/schedule/scheduler.module';
import { IdentityAuthModule } from '../../modules/identity/identity-auth.module';
import { ARTIFACT_STORE, LocalFsArtifactStore } from './artifact-store';
import { ArtifactsService } from './artifacts.service';
import { ArtifactsJobExecutors } from './artifacts.executors';
import { ArtifactAdminController } from './artifacts.controller';
import { EVIDENCE_CHAIN, MockEvidenceChain } from './evidence-chain';

@Module({
  imports: [
    InfrastructureModule, // 基座：连接池 + Outbox 写入端
    SchedulerModule, // I2：RETENTION_PURGE 自投（registerJob/findPendingJobId）+ 执行器注册表
    IdentityAuthModule, // A1：/admin/artifacts 调取面 JWT/角色守卫件（叶子模块）
  ],
  controllers: [ArtifactAdminController],
  providers: [
    // 存储适配器（供应商位：本地 FS=W1；OSS 换装只改本工厂；根目录=config artifacts.dir 单一装载）
    {
      provide: ARTIFACT_STORE,
      useFactory: (config: ConfigProvider) =>
        new LocalFsArtifactStore(config.require<string>('artifacts.dir')),
      inject: [CONFIG_PROVIDER],
    },
    // 上链适配器（供应商位：mock=W1；至信链 D-P9 后换装只改本绑定）
    MockEvidenceChain,
    { provide: EVIDENCE_CHAIN, useExisting: MockEvidenceChain },
    ArtifactsService,
    // RETENTION_PURGE 执行器经 onModuleInit 注册到 I2 执行器注册表（真注册，非 NO_EXECUTOR 形态）
    ArtifactsJobExecutors,
  ],
  exports: [ArtifactsService],
})
export class ArtifactsModule {}
