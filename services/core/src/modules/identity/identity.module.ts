/**
 * A1 注册登录与双角色（M1-W2）：identity schema 首个业务模块。
 * 施工规格：docs/modules/A-身份与账号/A1-注册登录与双角色.md；只写 identity.* 表（边界纪律）。
 *
 * 依赖（单向）：消费 NotifyModule 的 VerifyCodeRateLimiter（R-01，裁决 W2-2 不自建）与
 * SMS 通道注册表；认证件（token/守卫/加密）在叶子模块 IdentityAuthModule（NotifyModule 反向
 * import 它接 JWT 守卫，见 identity-auth.module 头注——避免 notify↔identity 循环）。
 */
import { Module } from '@nestjs/common';
import { InfrastructureModule } from '../../infrastructure/infrastructure.module';
import { NotifyModule } from '../notify/notify.module';
import { IdentityAuthModule } from './identity-auth.module';
import { IdentityUserConsumer } from './identity.consumer';
import { AuthController, MeController } from './identity.controller';
import { IdentityService } from './identity.service';

@Module({
  imports: [InfrastructureModule, NotifyModule, IdentityAuthModule],
  controllers: [AuthController, MeController],
  providers: [IdentityService, IdentityUserConsumer],
  // IdentityAuthModule 再导出：其认证件（token/守卫/加密）对 import IdentityModule 的模块同可见
  exports: [IdentityService, IdentityAuthModule],
})
export class IdentityModule {}
