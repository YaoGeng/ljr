/**
 * 身份认证基座模块（A1，叶子模块）：JWT 双 token 服务 + 认证/角色守卫 + 列加密。
 *
 * 独立成模块的原因（防循环依赖）：NotifyModule（I1 用户面）接 JWT 守卫须 import 本模块，
 * 而 IdentityModule 又消费 NotifyModule 的限频器/SMS 通道——把「无 notify 依赖的认证件」
 * 收进叶子模块（只依赖 InfrastructureModule），依赖链保持单向：
 *   NotifyModule → IdentityAuthModule ← IdentityModule。
 * IDENTITY_CONFIG 工厂仅在显式构建 AppModule（进程启动）时走 env 装载；测试 override 注入。
 */
import { Module } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InfrastructureModule } from '../../infrastructure/infrastructure.module';
import { IDENTITY_CONFIG, identityConfigFromEnv, type IdentityConfig } from './identity.config';
import { IdentityCryptoService } from './identity.crypto';
import { IdentityAuthGuard, IdentityRoleGuard } from './identity.guards';
import { IdentityTokenService } from './identity.token.service';

@Module({
  imports: [InfrastructureModule],
  providers: [
    { provide: IDENTITY_CONFIG, useFactory: () => identityConfigFromEnv() },
    // JwtService 显式工厂（JwtModule.registerAsync 的 inject 不可达本模块 provider——动态模块
    // 上下文限制；直造 JwtService 与 JwtModule.register() 等价，且随 IDENTITY_CONFIG override 生效）
    {
      provide: JwtService,
      useFactory: (config: IdentityConfig) => new JwtService({ secret: config.jwtSecret }),
      inject: [IDENTITY_CONFIG],
    },
    IdentityCryptoService,
    IdentityTokenService,
    IdentityAuthGuard,
    IdentityRoleGuard,
  ],
  exports: [
    IDENTITY_CONFIG,
    JwtService,
    IdentityCryptoService,
    IdentityTokenService,
    IdentityAuthGuard,
    IdentityRoleGuard,
  ],
})
export class IdentityAuthModule {}
