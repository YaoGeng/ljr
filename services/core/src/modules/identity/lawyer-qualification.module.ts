/**
 * A3a 律师资质审核（M1-W2 序 3）：identity schema 第三个业务模块，与 A1/A2 同目录分文件。
 *
 * 边界：只写 identity.* 表（lawyer_profiles/qualification_files），横切经基座
 * （OutboxService/StateTransitionGuardService），认证件复用 IdentityAuthModule（JWT 守卫/
 * 列加密/盲索引 pepper），错误映射经 infrastructure 的 AppHttpExceptionFilter——不新增过滤器副本。
 *
 * 生产事件（§6）：LawyerAuditPassed（approve 同事务）→ A1 消费授 lawyer role；
 * LawyerSuspended（suspend 同事务）→ 预留 C3/H1 订阅位。消费：无。
 * 下游：isAuditPassed（R-01）由 W3 C3/接单大厅反向 import 本模块消费（A2 闸口同形态）。
 */
import { Module } from '@nestjs/common';
import { InfrastructureModule } from '../../infrastructure/infrastructure.module';
import { IdentityAuthModule } from './identity-auth.module';
import { LawyerAuditAdminController, LawyerQualificationController } from './lawyer.controller';
import { LawyerQualificationService } from './lawyer.service';

@Module({
  imports: [InfrastructureModule, IdentityAuthModule],
  controllers: [LawyerQualificationController, LawyerAuditAdminController],
  providers: [LawyerQualificationService],
  exports: [LawyerQualificationService],
})
export class LawyerQualificationModule {}
