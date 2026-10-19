/**
 * F4 权益模块（M1-W3 T2 ①切片 → M2-W2 T6 ②全量扩展）：benefits schema owner（V1 建
 * schema/role；V21 积分两表；V43 券两表+备付台账）。施工规格：
 * docs/modules/F-资金/F4-权益积分优惠券备付台账.md。
 *
 * ②全量增量（M2-W2 T6）：券（CouponService+CouponController+coupon.machine——发券/查询/
 * 核销最小面/到期双路径）；备付台账（ReserveService——ACCRUE/REDEEM_NET/EXPIRE_NET 写入面
 * +日终对平核心）；RESERVE_RECONCILE 执行器（ReserveJobExecutors）；PRICE_COUPON_INSTRUCTED
 * 消费（CouponInstructionConsumer）。AttendanceAdjudicated 分成消费=BenefitsConsumersModule
 * （absence.consumer.ts——paid 聚合需 payment 导出面，PaymentModule imports 本模块，反向
 * import 即环；装配模块由 AppModule 平级注册，文件级无环，任务裁定见该文件头注）。
 *
 * 依赖（单向）：InfrastructureModule（pool/outbox/守卫）+ IdentityAuthModule（JWT 守卫件，
 * 叶子）+ SchedulerModule（I2 执行器注册表——POINTS_EXPIRE/RESERVE_RECONCILE 注册）
 * + RuleCenterModule（H7 券配置 coupon.price_comp 现行版读——fulfillment/credit 同款
 * 跨域规则快照消费先例；rule-center 依赖树不含 benefits，无环）。
 *
 * 可消费纪律（形态沿 F1 导出面纪律）：导出 PointsService（积分原语+grantInTx）、
 * CouponService（券面+核销 InTx——C3 联动位）、PointsJobExecutors/ReserveJobExecutors
 * （main.ts 引导/测试驱动）；控制器、消费器内部件不外泄。
 */
import { Module } from '@nestjs/common';
import { InfrastructureModule } from '../../infrastructure/infrastructure.module';
import { IdentityAuthModule } from '../identity/identity-auth.module';
import { SchedulerModule } from '../schedule/scheduler.module';
import { RuleCenterModule } from '../ops/rule-center.module';
import { BENEFITS_CONFIG, benefitsConfigFromEnv } from './benefits.config';
import { CouponController } from './coupon.controller';
import { CouponInstructionConsumer } from './coupon.consumer';
import { CouponService } from './coupon.service';
import { PointsController } from './points.controller';
import { PointsJobExecutors } from './points.executors';
import { PointsService } from './points.service';
import { ReserveJobExecutors } from './reserve.executors';
import { ReserveService } from './reserve.service';

@Module({
  imports: [InfrastructureModule, IdentityAuthModule, SchedulerModule, RuleCenterModule],
  controllers: [PointsController, CouponController],
  providers: [
    // 配置装配（LJR_BENEFITS_POINTS_TTL_DAYS env > 代码默认 180；Symbol token，测试 override 注入）
    { provide: BENEFITS_CONFIG, useFactory: () => benefitsConfigFromEnv(process.env) },
    PointsService,
    // ②全量：备付台账写入面+对平核心 / 券面（H7 配置读+发券+查询+核销）
    ReserveService,
    CouponService,
    // POINTS_EXPIRE 执行器经 onModuleInit 注册到 I2 执行器注册表（首个 job 由 main.ts 引导）
    PointsJobExecutors,
    // RESERVE_RECONCILE 执行器（目录第 26 项；首个 job 由 main.ts 引导）
    ReserveJobExecutors,
    // PRICE_COUPON_INSTRUCTED 消费器经 onModuleInit 注册到 outbox relay（C6 券指令→发券）
    CouponInstructionConsumer,
  ],
  exports: [PointsService, PointsJobExecutors, ReserveService, CouponService, ReserveJobExecutors],
})
export class BenefitsModule {}
