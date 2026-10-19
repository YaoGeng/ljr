/**
 * F4 ②全量事件消费端（M2-W2 T6）：
 *   ① AttendanceAdjudicated（D3 生产 → G1/F3/D4 扇出既有）→ ABSENCE_SHARE 缺席 30% 分成
 *     （本文件）；② PRICE_COUPON_INSTRUCTED（C6 W3 已出箱）→ coupon_grants ACTIVE +
 *     CouponGranted（coupon.consumer.ts——独立文件防 points.module ↔ 本文件环）。
 *
 * ①分成口径（F4 §4/§7 R-04 + PRD §8.5 逐字对齐，任务简报裁定）：
 *   - 30% 基数=该缺席用户的支付额（R-07 全额口径 paid=cash+points/100，经 payment 导出面
 *     RefundSourceRegistry 'session' 真源=trade PAID 报名+F1 支付单聚合），池=Σ所有缺席
 *     用户 30%——**单次 splitAbsenceShare 驱动**（池一次取整+占比 floor+余数归 user_id 升序
 *     首名，R-04「30% 总额」口径；逐缺席用户分步分配会造成多次 floor 偏差，禁用）；
 *   - 触发时点=「该场次判定完成」：经基座只读面 OutboxService.listEventsByPayload 重放该场次
 *     全部 AttendanceAdjudicated 留痕（D3 presence 序列重放同款形态——域模块不持 outbox 表
 *     知识），名册=缺席判定事实源（PAID 用户清单）+律师判定行；未完成（有名册成员未判定）
 *     → 无操作等后续事件补齐再触发（最后一个判定事件承载完整快照）；
 *   - 前置门：律师缺席 → 整场跳过（PRD §8.6 律师缺席=全额退款+赔付路径，无 30% 池）；
 *     无缺席用户 → 跳过；无到场用户 → 跳过+warn（30% 无受领人，PRD 未定义→待澄清，
 *     报告登记不自行发明）；
 *   - 授予：PointsService.grant ABSENCE_SHARE（幂等键=(user_id, ABSENCE_SHARE,
 *     absence:{session_id})——absenceSourceRef）+备付 ACCRUE 同事务逐笔记账+POINTS_GRANTED
 *     出箱（kind=ABSENCE_SHARE 既有面）。**事件重放不双计**：grant 幂等键 + relay
 *     at-least-once 重投均经该键短路（ticket.consumer 先例：handler 自持事务，效果幂等
 *     由 DB 唯一约束兜底，不依赖认领事务）。
 *
 * 装配边界（任务裁定，报告注明）：①的 paid 聚合经 payment 导出面 RefundSourceRegistry，
 * 但 PaymentModule imports BenefitsModule（F2 退款还原链）——BenefitsModule 反向 import
 * 即环。故消费端装配在 **BenefitsConsumersModule**（本文件，AppModule 平级注册：imports=
 * Infrastructure+Benefits+Payment；payment.module 不回导本文件，文件级无环）。
 */
import {
  AppError,
  ErrorCode,
  ATTENDANCE_ADJUDICATED_TOPIC,
  REFUND_SOURCE_REF_TYPE_SESSION,
  type AttendanceResult,
} from '@ljr/shared';
import { Injectable, Logger, Module, type OnModuleInit } from '@nestjs/common';
import type { OutboxHandler, RelayEvent } from '../../infrastructure/outbox/outbox-relay.service';
import { OutboxRelayService } from '../../infrastructure/outbox/outbox-relay.service';
import { InfrastructureModule } from '../../infrastructure/infrastructure.module';
import { OutboxService } from '../../infrastructure/outbox/outbox.service';
import { RefundSourceRegistry } from '../payment/refund.source';
import { PaymentModule } from '../payment/payment.module';
import { moneyToCents } from '../pricing/pricing.validate';
import { PointsService } from './points.service';
import { absenceSourceRef } from './points.types';
import { splitAbsenceShare } from './points.share-split';
import { BenefitsModule } from './points.module';

function isPositiveInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0;
}

function parseResult(v: unknown): AttendanceResult {
  if (v !== 'normal' && v !== 'late' && v !== 'absent') {
    throw new AppError(
      ErrorCode.InvalidArgument,
      `AttendanceAdjudicated 载荷 result 越域（normal|late|absent）：${String(v)}`,
    );
  }
  return v;
}

/** 分成处理结果（日志/测试观测面） */
export interface AbsenceShareOutcome {
  readonly session_id: number;
  readonly acted: boolean;
  readonly reason:
    | 'incomplete_adjudication'
    | 'lawyer_absent'
    | 'no_absent_users'
    | 'no_attending_users'
    | 'zero_pool'
    | 'granted';
  readonly pool_cents: number;
  readonly granted_users: number;
}

/**
 * AttendanceAdjudicated → ABSENCE_SHARE handler（①分成；独立可测工厂，attendance.consumer
 * 同形态）。paid 聚合与事件重放均走 relay 认领事务的 uow（只读），授予走 PointsService
 * 自持事务（幂等键兜底 at-least-once）。
 */
export function createAttendanceAdjudicatedHandler(
  points: PointsService,
  sources: RefundSourceRegistry,
  outbox: OutboxService,
): OutboxHandler {
  const logger = new Logger('F4AbsenceShare');
  return async (event: RelayEvent, uow) => {
    if (event.topic !== ATTENDANCE_ADJUDICATED_TOPIC) {
      throw new AppError(ErrorCode.InvalidArgument, `分成消费器收到未注册 topic：${event.topic}`);
    }
    const payload = (event.payload ?? {}) as Partial<{
      adjudication_id: unknown;
      session_id: unknown;
      owner_type: unknown;
      owner_id: unknown;
      result: unknown;
    }>;
    if (
      !isPositiveInt(payload.adjudication_id) ||
      !isPositiveInt(payload.session_id) ||
      !isPositiveInt(payload.owner_id)
    ) {
      throw new AppError(
        ErrorCode.InvalidArgument,
        `AttendanceAdjudicated 载荷缺 adjudication_id/session_id/owner_id 最小集（进重试轨道，不静默丢弃）`,
      );
    }
    if (payload.owner_type !== 'user' && payload.owner_type !== 'lawyer') {
      throw new AppError(
        ErrorCode.InvalidArgument,
        `AttendanceAdjudicated 载荷 owner_type 越域（user|lawyer）：${String(payload.owner_type)}`,
      );
    }
    parseResult(payload.result);
    const sessionId = payload.session_id;

    // 该场次判定留痕重放（基座只读面；当前事件行已在 outbox——生产先于消费提交）
    const events = await outbox.listEventsByPayload(
      uow,
      [ATTENDANCE_ADJUDICATED_TOPIC],
      'session_id',
      String(sessionId),
    );
    let lawyerResult: AttendanceResult | undefined;
    const userResults = new Map<number, AttendanceResult>();
    for (const e of events) {
      const p = (e.payload ?? {}) as Partial<{
        owner_type: unknown;
        owner_id: unknown;
        result: unknown;
      }>;
      if (p.owner_type !== 'user' && p.owner_type !== 'lawyer') continue; // 坏载荷防御（D3 生产侧已校验）
      if (!isPositiveInt(p.owner_id)) continue;
      const result = parseResult(p.result);
      if (p.owner_type === 'lawyer') {
        lawyerResult = result;
      } else {
        userResults.set(p.owner_id, result);
      }
    }

    // paid 名册（payment 导出面真源；同用户多 PAID 报名聚合——R-07 全额口径）
    const source = sources.resolve(REFUND_SOURCE_REF_TYPE_SESSION);
    if (!source) {
      throw new AppError(
        ErrorCode.ConfigInvalid,
        `退款源 'session' 未注册（F2 RefundSourceRegistry）——缺席分成 paid 聚合链路未装配`,
      );
    }
    const orders = await source.listPaidPaymentOrders(sessionId, uow);
    const paidCentsByUser = new Map<number, number>();
    for (const o of orders) {
      const cents = moneyToCents(o.cash_amount) + o.points_amount; // R-07：cash 分+积分（1 积分=1 分）
      paidCentsByUser.set(o.user_id, (paidCentsByUser.get(o.user_id) ?? 0) + cents);
    }

    // 完成门：律师已判 + 名册全员已判（未齐=等最后一个判定事件再触发）
    const roster = [...paidCentsByUser.keys()];
    if (lawyerResult === undefined || roster.some((uid) => !userResults.has(uid))) {
      logger.log(
        `场次 ${sessionId} 判定未齐（lawyer=${lawyerResult ?? '未判'}，已判用户 ${userResults.size}/${roster.length}）——分成等待后续判定事件`,
      );
      return;
    }
    if (lawyerResult === 'absent') {
      logger.log(`场次 ${sessionId} 律师缺席——整场走 §8.6 全额退款+赔付路径，无 30% 分成池`);
      return;
    }
    const absentUsers = roster.filter((uid) => userResults.get(uid) === 'absent');
    const attendingUsers = roster.filter((uid) => userResults.get(uid) !== 'absent');
    if (absentUsers.length === 0) {
      logger.log(`场次 ${sessionId} 全员到场/旁听——无 30% 分成池`);
      return;
    }
    if (attendingUsers.length === 0) {
      logger.warn(
        `场次 ${sessionId} 缺席 ${absentUsers.length} 人但零到场用户——30% 池无受领人（PRD §8.5 未定义该形态资金去向，跳过发放，04 §8 待澄清登记）`,
      );
      return;
    }
    const poolCents = absentUsers.reduce((s, uid) => s + (paidCentsByUser.get(uid) ?? 0), 0);
    if (poolCents <= 0) {
      logger.warn(`场次 ${sessionId} 缺席者合计 paid=0——无分成池（防御位）`);
      return;
    }
    const attendingPaid = attendingUsers.reduce((s, uid) => s + (paidCentsByUser.get(uid) ?? 0), 0);
    if (attendingPaid <= 0) {
      logger.warn(
        `场次 ${sessionId} 到场用户合计 paid=0——占比分母无定义（splitAbsenceShare 契约拒绝），跳过发放，04 §8 待澄清登记`,
      );
      return;
    }

    // R-04 唯一定义：池一次取整（函数内 30%）+占比 floor+余数归 user_id 升序首名
    const allocations = splitAbsenceShare(
      poolCents,
      attendingUsers.map((uid) => ({ user_id: uid, paid_cents: paidCentsByUser.get(uid) ?? 0 })),
    );
    const ref = absenceSourceRef(sessionId);
    let grantedUsers = 0;
    for (const a of allocations) {
      if (a.points <= 0) continue; // floor 为 0 的受领人无授予（grant 域为正整数）
      await points.grant({
        user_id: a.user_id,
        points: a.points,
        kind: 'ABSENCE_SHARE',
        ref,
      });
      grantedUsers += 1;
    }
    logger.log(
      `场次 ${sessionId} 缺席分成完成：缺席 ${absentUsers.length} 人池=${poolCents} 分（30%=${Math.floor((poolCents * 3) / 10)} 分）→ 到场 ${grantedUsers} 人入账（ref=${ref}）`,
    );
  };
}

/** ①消费端装配（BenefitsConsumersModule——见文件头装配边界注记） */
@Injectable()
export class AbsenceShareConsumer implements OnModuleInit {
  constructor(
    private readonly relay: OutboxRelayService,
    private readonly points: PointsService,
    private readonly sources: RefundSourceRegistry,
    private readonly outbox: OutboxService,
  ) {}

  onModuleInit(): void {
    this.relay.registerHandler(
      ATTENDANCE_ADJUDICATED_TOPIC,
      createAttendanceAdjudicatedHandler(this.points, this.sources, this.outbox),
    );
  }
}

/**
 * ①的消费装配模块（AppModule 平级注册；见文件头「装配边界」注记——BenefitsModule 与
 * PaymentModule 的依赖方向为 payment→benefits，本模块只被 AppModule 引用，文件级无环）。
 */
@Module({
  imports: [InfrastructureModule, BenefitsModule, PaymentModule],
  providers: [AbsenceShareConsumer],
})
export class BenefitsConsumersModule {}
