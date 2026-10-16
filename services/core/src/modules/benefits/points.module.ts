/**
 * F4 权益模块（M1-W3 T2）：benefits schema owner（V1 已建 schema/role，本模块首个落位），
 * 代码放 modules/benefits/（benefits.* 前缀，check-schema-refs 目录→schema 约定）。
 * 施工规格：docs/modules/F-资金/F4-权益积分优惠券备付台账.md；V21__benefits.sql 两表（①切片）。
 *
 * 边界（Task 2 简报硬边界）：只做积分账户/流水 + 冻结核销解冻 + 退款还原 + 过期双路径 +
 * GET /points/mine + POINTS_EXPIRE 执行器 + R-04 纯函数；coupons/coupon_grants/reserve_ledgers
 * 三表与券/备付全部逻辑、GRANT_COMPENSATION/GRANT_ABSENCE_SHARE 内部接口、
 * CompensationGranted/CouponGranted 事件=②全量（M2-W2），坚决不建。
 * 依赖（单向）：InfrastructureModule（pool/outbox）+ IdentityAuthModule（JWT 守卫件，叶子）
 * + SchedulerModule（I2 执行器注册表——POINTS_EXPIRE 注册）。
 *
 * 可消费纪律（形态沿 F1 导出面纪律）：只导出应用服务 PointsService（C3 报名支付编排=T7 消费、
 * F2 退款=T6 消费、②全量编排复用）+ PointsJobExecutors（main.ts 引导/测试驱动）；控制器、
 * 执行器内部件不外泄。
 */
import { Module } from '@nestjs/common';
import { InfrastructureModule } from '../../infrastructure/infrastructure.module';
import { IdentityAuthModule } from '../identity/identity-auth.module';
import { SchedulerModule } from '../schedule/scheduler.module';
import { BENEFITS_CONFIG, benefitsConfigFromEnv } from './benefits.config';
import { PointsController } from './points.controller';
import { PointsJobExecutors } from './points.executors';
import { PointsService } from './points.service';

@Module({
  imports: [InfrastructureModule, IdentityAuthModule, SchedulerModule],
  controllers: [PointsController],
  providers: [
    // 配置装配（LJR_BENEFITS_POINTS_TTL_DAYS env > 代码默认 180；Symbol token，测试 override 注入）
    { provide: BENEFITS_CONFIG, useFactory: () => benefitsConfigFromEnv(process.env) },
    PointsService,
    // POINTS_EXPIRE 执行器经 onModuleInit 注册到 I2 执行器注册表（首个 job 由 main.ts 引导）
    PointsJobExecutors,
  ],
  exports: [PointsService, PointsJobExecutors],
})
export class BenefitsModule {}
