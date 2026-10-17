/**
 * H1 律师与资质管理（M1-W3 T10 压轴）：ops schema 域第三个业务模块（与 H7/H5 同目录平级文件）。
 *
 * 边界：只写 ops.audit_logs（AuditLogService，本 schema owner）；状态本体经 A3a
 * LawyerQualificationService 导出面（identity 域）、进件经 A3b FirmMerchantService（payment 域）、
 * 信用经 G1 CreditService（credit 域）、场次统计经 C1 SessionService（trade 域）——
 * 跨模块取数全走服务接口，禁跨 schema join（架构 §2.1/§3.2，H1 §9）。
 * 依赖（单向，无环）：InfrastructureModule（pool/AuditLog 底座）、IdentityAuthModule（JWT 守卫件
 * 叶子）、LawyerQualificationModule、CreditModule、PaymentModule、TradeModule（均为叶子方向，
 * 无反向依赖本模块）。
 *
 * G-A 前置门（W2 终审不可降级）本模块关闭第 2 项：POST /admin/lawyers/{id}/audit
 * @RequireRole('admin') + auditor_id 回填绑定（R-W2-G）；第 1/3 项（A2 decrypt/G1 restrictions）
 * 由本批各自模块接线关闭；第 4 项（B1/B3 GET 面）经 R-W3-R 裁决保留公开读（决策记录=报告）。
 */
import { Module } from '@nestjs/common';
import { InfrastructureModule } from '../../infrastructure/infrastructure.module';
import { IdentityAuthModule } from '../identity/identity-auth.module';
import { LawyerQualificationModule } from '../identity/lawyer-qualification.module';
import { CreditModule } from '../credit/credit.module';
import { PaymentModule } from '../payment/payment.module';
import { TradeModule } from '../trade/trade.module';
import { AuditLogService } from './audit-log.service';
import { LawyerAdminController } from './lawyer-admin.controller';
import { LawyerAdminService } from './lawyer-admin.service';

@Module({
  imports: [
    InfrastructureModule,
    IdentityAuthModule,
    LawyerQualificationModule, // A3a：资质状态本体 + 审核面（auditor_id 透传缝合点）
    CreditModule, // G1：信用快照（档案聚合源）
    PaymentModule, // A3b：进件状态（档案聚合源，listByFirm 导出面）
    TradeModule, // C1：场次统计（档案聚合源，SessionService.stats）
  ],
  controllers: [LawyerAdminController],
  providers: [AuditLogService, LawyerAdminService],
  exports: [LawyerAdminService], // H9(M4) 审计面扩装时的复用入口（本批无外部消费方）
})
export class LawyerAdminModule {}
