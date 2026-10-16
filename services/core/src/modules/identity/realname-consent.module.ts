/**
 * A2 实名认证与同意管理（M1-W2 序 2）：identity schema 第二个业务模块，与 A1 同目录分文件。
 *
 * 边界：只写 identity.* 表（real_name_infos/consents/decrypt_approvals），横切经基座
 * （OutboxService/StateTransitionGuardService），认证件复用 IdentityAuthModule（JWT 守卫/
 * 列加密），错误映射经 infrastructure 的 AppHttpExceptionFilter——不新增过滤器副本（T1 评审 minor-5）。
 *
 * 消费依赖（单向）：IdentityModule 不依赖本模块；W3 C3/F1 实名闸口（R-01）反向 import
 * 本模块取 isRealnameVerified（同 schema 内服务导出，非跨 schema 取数）。
 * 核验通道=端口适配（裁决 D12）：REALNAME_PROVIDER 缺省绑 MockRealnameProvider（沙箱），
 * prod 前替换为 CTID/三要素真通道，verify_provider 落通道 kind。
 */
import { Module } from '@nestjs/common';
import { InfrastructureModule } from '../../infrastructure/infrastructure.module';
import { IdentityAuthModule } from './identity-auth.module';
import { ConsentController } from './consent.controller';
import { CONSENT_CONFIG, consentConfigFromEnv } from './consent.config';
import { ConsentService } from './consent.service';
import { RealnameAdminController, RealnameController } from './realname.controller';
import { REALNAME_CONFIG, realnameConfigFromEnv } from './realname.config';
import { MockRealnameProvider, REALNAME_PROVIDER } from './realname.provider';
import { RealnameService } from './realname.service';

@Module({
  imports: [InfrastructureModule, IdentityAuthModule],
  controllers: [RealnameController, RealnameAdminController, ConsentController],
  providers: [
    { provide: REALNAME_CONFIG, useFactory: () => realnameConfigFromEnv() },
    { provide: CONSENT_CONFIG, useFactory: () => consentConfigFromEnv() },
    { provide: REALNAME_PROVIDER, useClass: MockRealnameProvider },
    RealnameService,
    ConsentService,
  ],
  exports: [RealnameService, ConsentService],
})
export class RealnameConsentModule {}
