/**
 * C4 C2B 律师响应与双向转化服务（§2/§3/§4/§5/§7 + M2-W2 T4 简报）——交易域应用服务导出面
 * （可剥离纪律同形：只暴露应用服务+事件契约+HTTP 契约；机器件/建面件为模块内部件复用）。
 *
 * 四面一窗：
 *   - 接单大厅（GET /lawyer/group-buys?status=PENDING_LAWYER）：已选定自己（group_buys.lawyer_id
 *     =本律师，C2 发布即定）+PENDING_LAWYER 的任务清单（子范围/标签/lawyer_confirm_by 截止）；
 *   - confirm（POST /group-buys/{id}/confirm，幂等键=gb）：#36 停接拦截（SUSPEND_TAKE_* → 403，
 *     ⚠W2-5=拦 confirm 时点不拦新开团/新发起——convert/reject 不拦）→ 单事务：PENDING_LAWYER→
 *     CONFIRMED（守卫+STL）+ mode='C2B' 履约 Session（经 SessionService.createC2BFulfillment，
 *     R-W3-K 建面单点；capacity=joined=参与者数=满员闭环）+ 参与者报名行迁移（新建 session 型行
 *     +prev 回链+旧行 CONVERTED_OUT，§9 禁 UPDATE 迁移）+ LawyerConfirmed 出箱；
 *   - reject（POST /group-buys/{id}/reject，幂等键=gb）：PENDING_LAWYER→REJECTED + 既有
 *     LAWYER_REJECTED(via_timeout=false) 出箱（G1 -5 消费在位；F2 全额退款=M2 桩，C4 §10①
 *     「F2 桩」口径）+占用锁同事务释放——与超时路径（confirmTimeout）同构；
 *   - convert（POST /group-buys/{id}/convert，幂等键=gb）：守卫源态=PUBLISHED/REACHED/
 *     PENDING_LAWYER（⚠守卫口径=执行计划 T4 行裁定「PENDING_LAWYER 可直接转化=认领」+ C2 §4
 *     原文两边；CONFIRMED 后转化未定义=不收，任务报告注明）→ 单事务：GroupBuy→CONVERTED +
 *     新 B2C Session（SessionService.createConvertedB2C，锁承接=groupbuy 锁释放+session 锁重占）+
 *     参与者迁移（快照价维持，R-02）+ GroupBuyConverted 出箱；
 *   - 24h 转化退款窗（R-03，服务面——§5 未定义用户 HTTP 入口，不发明端点）：被迁移用户在
 *     转化后 24h 内经 requestConvertRefund 申请原单全额退款（F2 reason=CONVERT_WINDOW——§2
 *     九值实词；退款完成收敛走 advanceToRefunded 迁移链重定向）。
 *
 * 迁移事务原子（§8）：GroupBuy 推进 + Session 创建 + enrollment 批量新建（+旧行标记）+ 出箱
 * 全在单一 uow——中段失败全回滚（用例注入钉住）。幂等：目标态短路重放（confirm/convert 经
 * 迁移链解析原 session_id；reject 回 {status}），非源态 409（NOT_REACHED/NOT_PENDING/
 * NOT_CONVERTIBLE——§5 契约码）。
 */
import { Injectable } from '@nestjs/common';
import {
  AppError,
  ErrorCode,
  GROUP_BUY_CONVERTED_TOPIC,
  GROUP_BUY_LAWYER_CONFIRMED_TOPIC,
  LAWYER_REJECTED_TOPIC,
  assertMoney,
  type GroupBuyConvertedPayload,
  type GroupBuyLawyerConfirmedPayload,
  type LawyerRejectedPayload,
  type Money,
} from '@ljr/shared';
import type { SqlExecutor } from '../../infrastructure/sql';
import { PgPoolService } from '../../infrastructure/sql';
import { OutboxService } from '../../infrastructure/outbox/outbox.service';
import {
  StateTransitionLogService,
  type TransitionLogReadRow,
} from '../../infrastructure/state-machine/state-transition-log.service';
import { StateTransitionGuardService } from '../../infrastructure/state-machine/state-transition-guard.service';
import { CreditService } from '../credit/credit.service';
import { PaymentGatewayService } from '../payment/payment.gateway.service';
import { RefundService } from '../payment/refund.service';
import { PricingConfigService } from '../pricing/pricing.service';
import { SchedulerService } from '../schedule/scheduler.service';
import { SlotLockService } from '../schedule/slot-lock.service';
import { ENROLLMENT_MACHINE } from './enrollment.machine';
import { EnrollmentQueryService } from './enrollment.query';
import { enrollmentOrderKey } from './enrollment.types';
import { GROUP_BUY_MACHINE, type GroupBuyStatus } from './group-buy.machine';
import type { GroupBuyView } from './group-buy.types';
import { SessionService } from './session.service';
import {
  assertCapacity,
  assertIsoDate,
  assertPositiveInt,
  centsToMoney,
  moneyToCents,
  shanghaiDayAfter,
  shanghaiDayStart,
  splitTotalIntoUnit,
  type PriceMode,
  type SessionRoomMode,
} from './session.types';

/** group_buys 行（本模块所需切面；列集=group-buy.service GB_COLS 同源子集 + session_id 回链列） */
interface GroupBuyRow {
  readonly id: string;
  readonly initiator_id: string;
  readonly lawyer_id: string;
  readonly specialty: string;
  readonly city: string;
  readonly slot_start: Date;
  readonly sub_min: number;
  readonly sub_max: number;
  readonly share_price: string;
  readonly question_tags: unknown;
  readonly deadline: Date;
  readonly status: string;
  readonly lawyer_confirm_by: Date | null;
  /** C4 履约 Session 回链（V41；confirm/convert 建面同事务落值，NULL=未生成） */
  readonly session_id: string | null;
  readonly created_at: Date;
}

const GB_COLS = `id, initiator_id, lawyer_id, specialty, city, slot_start, sub_min, sub_max,
  share_price::text AS share_price, question_tags, deadline, status, lawyer_confirm_by,
  session_id::text AS session_id, created_at`;

/** 迁移源参与者行（PAID + 行锁；快照列原样带走） */
interface ParticipantRow {
  readonly id: string;
  readonly user_id: string;
  readonly price_snapshot: unknown;
  readonly unit_price: string;
  readonly paid_amount: string;
  readonly cash_amount: string;
  readonly points_amount: number;
  readonly price_version_id: string;
  readonly credit_used: number;
}

const PARTICIPANT_COLS = `id, user_id::text AS user_id, price_snapshot, unit_price::text AS unit_price,
  paid_amount::text AS paid_amount, cash_amount::text AS cash_amount, points_amount,
  price_version_id::text AS price_version_id, credit_used`;

/** 可转化源态（⚠守卫口径，类注）：C2 §4 原文 PUBLISHED/REACHED + T4 裁定增 PENDING_LAWYER */
const CONVERTIBLE_STATUSES: readonly GroupBuyStatus[] = ['PUBLISHED', 'REACHED', 'PENDING_LAWYER'];

/** R-03 转化退款窗：24h（迁移行 created_at 锚=转化事务时刻；**DB 钟窗判定**——修复环 M-1：
 *  SQL 侧 now() - created_at <= interval 计算，应用钟只消费 DB 回传的展示值；25h=拒——验收③） */
export const CONVERT_REFUND_WINDOW_HOURS = 24;

/** 接单大厅单页护栏（§5 未定分页；C1/C2 list LIMIT 500 同形） */
const HALL_LIMIT = 500;

/** responseStats 的 STL 窗读护栏（修复环 I-2：H4 管道接管前的使用边界） */
const STATS_STL_READ_LIMIT = 200;

function toView(row: GroupBuyRow, joined: number | null): GroupBuyView {
  return {
    id: Number(row.id),
    initiator_id: Number(row.initiator_id),
    lawyer_id: Number(row.lawyer_id),
    specialty: row.specialty,
    city: row.city,
    slot_start: new Date(row.slot_start).toISOString(),
    sub_min: row.sub_min,
    sub_max: row.sub_max,
    share_price: row.share_price,
    question_tags: Array.isArray(row.question_tags) ? (row.question_tags as string[]) : [],
    deadline: new Date(row.deadline).toISOString(),
    status: row.status as GroupBuyStatus,
    lawyer_confirm_by:
      row.lawyer_confirm_by === null ? null : new Date(row.lawyer_confirm_by).toISOString(),
    created_at: new Date(row.created_at).toISOString(),
    joined,
  };
}

@Injectable()
export class GroupBuyResponseService {
  constructor(
    private readonly pool: PgPoolService,
    private readonly outbox: OutboxService,
    private readonly guard: StateTransitionGuardService,
    private readonly stateLog: StateTransitionLogService,
    private readonly scheduler: SchedulerService,
    private readonly locks: SlotLockService,
    // 同域建面/查询件（R-W3-K 单点纪律；禁跨 schema join——架构 §3.2 红线）
    private readonly sessions: SessionService,
    private readonly queries: EnrollmentQueryService,
    // 跨模块消费全部走导出服务（G1/B3/F1/F2）
    private readonly credit: CreditService,
    private readonly pricing: PricingConfigService,
    private readonly payment: PaymentGatewayService,
    private readonly refunds: RefundService,
  ) {}

  // ===========================================================================
  // 接单大厅（§5 GET /lawyer/group-buys?status=PENDING_LAWYER：已选定自己+待确认清单）
  // ===========================================================================

  async listPendingForLawyer(lawyerId: number): Promise<GroupBuyView[]> {
    const lid = assertPositiveInt(lawyerId, 'lawyer_id');
    const res = await this.pool.query<GroupBuyRow>(
      `SELECT ${GB_COLS} FROM trade.group_buys
        WHERE lawyer_id = $1 AND status = 'PENDING_LAWYER'
        ORDER BY lawyer_confirm_by, id LIMIT ${HALL_LIMIT}`,
      [lid],
    );
    // 已支付参与者计数（C3 落位后的 joined 接线：大厅的「已加入数」事实源=enrollments PAID 计数）
    return Promise.all(
      res.rows.map(async (row) =>
        toView(row, await this.queries.countPaid(this.pool, 'groupbuy', Number(row.id))),
      ),
    );
  }

  // ===========================================================================
  // 确认（§5 POST /group-buys/{id}/confirm：幂等键=gb；409 NOT_REACHED；#36 停接拦截 403）
  // ===========================================================================

  async confirm(groupBuyId: number, lawyerId: number): Promise<{ session_id: number }> {
    const id = assertPositiveInt(groupBuyId, 'group_buy_id');
    const lid = assertPositiveInt(lawyerId, 'lawyer_id');

    // #36 停接拦截（⚠W2-5 维持现状：拦 confirm 时点；SUSPEND_TAKE_*=接单侧限制令四值其二）
    const restrictions = await this.credit.listActiveRestrictions('lawyer', lid);
    if (restrictions.some((r) => r.kind.startsWith('SUSPEND_TAKE'))) {
      throw new AppError(
        ErrorCode.Restricted,
        `律师 ${lid} 停接限制令生效中（G1 ${restrictions[0]!.kind}），不可确认接单（#36 拦 confirm 时点）`,
      );
    }
    const roomMode = await this.resolveRoomMode(lid);

    return this.pool.withTransaction(async (uow) => {
      const row = await this.lockRowForUpdate(uow, id);
      if (!row || Number(row.lawyer_id) !== lid) {
        throw new AppError(ErrorCode.NotFound, `拼团任务不存在：${id}`); // 非本人不暴露他人物（cancel 同口径）
      }
      if (row.status === 'CONFIRMED') {
        return { session_id: this.storedSessionId(row, id) }; // 幂等重放（session_id 列直读，V41）
      }
      if (row.status !== 'PENDING_LAWYER') {
        throw new AppError(
          ErrorCode.NotReached,
          `拼团 ${id} 状态 ${row.status} 未达律师待确认态（PENDING_LAWYER），不可确认`,
        );
      }
      const participants = await this.lockPaidParticipants(uow, id);
      // 参与者契约下界 2 人；达线后退款缩员至 [2,sub_min) 属合法形态（达线事实已发生）——
      // 口径留档待澄清（任务报告 §待澄清）
      if (participants.length < 2) {
        throw new AppError(
          ErrorCode.InternalError,
          `拼团 ${id} 待确认态参与者 ${participants.length} < 参与者契约下界 2（不应触达）`,
        );
      }

      await this.guard.assertTransition(GROUP_BUY_MACHINE, {
        entityId: id,
        from: 'PENDING_LAWYER',
        to: 'CONFIRMED',
        reason: 'lawyer_confirmed',
        uow,
      });

      // 履约 Session（C1 建面单点）：capacity=joined=参与者数（满员闭环——报名面不开放且
      // ENROLL_DEADLINE 流标 job 对满员场次天然 no-op）；B2 不加锁（groupbuy 锁持续占用同段）
      const session = await this.sessions.createC2BFulfillment(
        {
          group_buy_id: id,
          lawyer_id: lid,
          slot_start: new Date(row.slot_start),
          share_price: row.share_price,
          capacity: participants.length,
          room_mode: roomMode,
          initial_joined: participants.length,
        },
        uow,
      );

      // 状态推进+回链落值同事务（session_id=V41 修复环 C-2：幂等重放直查列，迁移链反查已移除）
      const updated = await uow.query<GroupBuyRow>(
        `UPDATE trade.group_buys SET status = 'CONFIRMED', status_since = now(), session_id = $2
          WHERE id = $1 AND status = 'PENDING_LAWYER' RETURNING ${GB_COLS}`,
        [id, session.id],
      );
      if (updated.rows.length === 0) {
        throw new AppError(ErrorCode.StateStaleEntity, `拼团 ${id} 已被并发迁移`);
      }

      // 参与者报名行迁移（§9 禁 UPDATE 迁移：新建行承载，旧行仅状态位翻转）
      await this.migrateEnrollments(uow, participants, session.id, 'confirm_migrated');

      // 满员即成团（joined==capacity → FULL；进入成团链：sessionRemindable 不受截止窗防御半边
      // 误拦、成团率统计可算）——SessionFull 同事务出箱
      await this.sessions.markFull(session.id, uow);

      await this.outbox.recordOutbox(uow, {
        type: GROUP_BUY_LAWYER_CONFIRMED_TOPIC,
        payload: {
          gb_id: id,
          session_id: session.id,
          lawyer_id: lid,
        } satisfies GroupBuyLawyerConfirmedPayload,
      });
      return { session_id: session.id };
    });
  }

  // ===========================================================================
  // 拒绝（§5 POST /group-buys/{id}/reject：幂等键=gb；409 NOT_PENDING；G1 -5/F2 桩消费既有）
  // ===========================================================================

  async reject(
    groupBuyId: number,
    lawyerId: number,
    reasonText?: string,
  ): Promise<{ status: 'REJECTED' }> {
    const id = assertPositiveInt(groupBuyId, 'group_buy_id');
    const lid = assertPositiveInt(lawyerId, 'lawyer_id');
    // 拒绝理由唯一落点=STL reason（group_buys 无理由列、PRD 未定义存储——截断承载，报告注记）
    const stlReason =
      reasonText === undefined || reasonText.length === 0
        ? 'lawyer_rejected'
        : `lawyer_rejected:${reasonText}`.slice(0, 128);

    return this.pool.withTransaction(async (uow) => {
      const row = await this.lockRowForUpdate(uow, id);
      if (!row || Number(row.lawyer_id) !== lid) {
        throw new AppError(ErrorCode.NotFound, `拼团任务不存在：${id}`);
      }
      if (row.status === 'REJECTED') return { status: 'REJECTED' as const }; // 幂等重放
      if (row.status !== 'PENDING_LAWYER') {
        throw new AppError(
          ErrorCode.NotPending,
          `拼团 ${id} 状态 ${row.status} 未达律师待确认态（PENDING_LAWYER），不可拒绝`,
        );
      }
      await this.guard.assertTransition(GROUP_BUY_MACHINE, {
        entityId: id,
        from: 'PENDING_LAWYER',
        to: 'REJECTED',
        reason: stlReason,
        uow,
      });
      const updated = await uow.query<GroupBuyRow>(
        `UPDATE trade.group_buys SET status = 'REJECTED', status_since = now()
          WHERE id = $1 AND status = 'PENDING_LAWYER' RETURNING ${GB_COLS}`,
        [id],
      );
      if (updated.rows.length === 0) {
        throw new AppError(ErrorCode.StateStaleEntity, `拼团 ${id} 已被并发迁移`);
      }
      // 占用锁同事务释放（confirmTimeout 同构；REJECTED=锁终态，架构 §4.2）
      await this.locks.releaseSlot(uow, {
        refType: 'groupbuy',
        refId: id,
        reason: 'group_buy_rejected',
      });
      // 既有 topic 复用（A.1：C4 显式拒=同载荷 via_timeout:false；G1 按 topic 消费 -5 档，
      // F2 全额退款=M2 桩——本批只断言出箱契约）
      await this.outbox.recordOutbox(uow, {
        type: LAWYER_REJECTED_TOPIC,
        payload: {
          group_id: id,
          lawyer_id: lid,
          via_timeout: false,
        } satisfies LawyerRejectedPayload,
      });
      return { status: 'REJECTED' as const };
    });
  }

  // ===========================================================================
  // 认领转化（§5 POST /group-buys/{id}/convert：幂等键=gb；409 NOT_CONVERTIBLE）
  // ===========================================================================

  async convert(
    groupBuyId: number,
    lawyerId: number,
    input: { readonly capacity?: number; readonly price?: Money } = {},
  ): Promise<{ session_id: number }> {
    const id = assertPositiveInt(groupBuyId, 'group_buy_id');
    const lid = assertPositiveInt(lawyerId, 'lawyer_id');
    const capacityOverride =
      input.capacity === undefined ? undefined : assertCapacity(input.capacity);
    const priceOverride = input.price === undefined ? undefined : assertMoney(input.price);

    // 价格解算（事务外，B3 读走导出服务 30s 适配位）：显式覆盖=per_head 单价；缺省=B3 现值
    // （per_head 优先，次选 session_total 分摊——「新加入按 B2C 定价」R-02；B3 全空 → 400）
    const pricePlan = await this.resolveConvertPrice(lid, priceOverride);
    const roomMode = await this.resolveRoomMode(lid);

    return this.pool.withTransaction(async (uow) => {
      const row = await this.lockRowForUpdate(uow, id);
      if (!row || Number(row.lawyer_id) !== lid) {
        throw new AppError(ErrorCode.NotFound, `拼团任务不存在：${id}`);
      }
      if (row.status === 'CONVERTED') {
        return { session_id: this.storedSessionId(row, id) }; // 幂等重放（session_id 列直读，V41——零参与转化重放不再依赖迁移链）
      }
      if (!(CONVERTIBLE_STATUSES as readonly string[]).includes(row.status)) {
        throw new AppError(
          ErrorCode.NotConvertible,
          `拼团 ${id} 状态 ${row.status} 不可认领转化（源态限 PUBLISHED/REACHED/PENDING_LAWYER；CONFIRMED 后转化语义未定义=不收）`,
        );
      }
      const from = row.status as GroupBuyStatus;
      const participants = await this.lockPaidParticipants(uow, id);
      const capacity = capacityOverride ?? row.sub_max; // §11：capacity 由律师定，默认=sub_max
      if (capacity < participants.length) {
        throw new AppError(
          ErrorCode.InvalidArgument,
          `转化容量 ${capacity} 低于已支付参与者 ${participants.length}（被迁移者不可丢弃）`,
        );
      }
      const price = computeConvertPrices(pricePlan, capacity);

      await this.guard.assertTransition(GROUP_BUY_MACHINE, {
        entityId: id,
        from,
        to: 'CONVERTED',
        reason: 'lawyer_claim_convert',
        uow,
      });

      // 锁承接第一步：groupbuy 锁释放（CONVERTED=锁终态；TTL 已释放=ALREADY_RELEASED 良性）
      await this.locks.releaseSlot(uow, {
        refType: 'groupbuy',
        refId: id,
        reason: 'group_buy_converted',
      });

      // 新 B2C 场次（建面单点；锁承接第二步=lockSlot(session) 在创建事务内）——specialty/city
      // 从拼团任务物化带出；enroll_deadline 缺省同 C1（createConvertedB2C 内解算）
      const session = await this.sessions.createConvertedB2C(
        {
          group_buy_id: id,
          lawyer_id: lid,
          slot_start: new Date(row.slot_start),
          specialty: row.specialty,
          city: row.city,
          price_mode: price.price_mode,
          unit_price: price.unit_price,
          session_total: price.session_total,
          capacity,
          initial_joined: participants.length,
          room_mode: roomMode,
        },
        uow,
      );

      // 状态推进+回链落值同事务（session_id=V41 修复环 C-2）
      const updated = await uow.query<GroupBuyRow>(
        `UPDATE trade.group_buys SET status = 'CONVERTED', status_since = now(), session_id = $3
          WHERE id = $1 AND status = $2 RETURNING ${GB_COLS}`,
        [id, from, session.id],
      );
      if (updated.rows.length === 0) {
        throw new AppError(ErrorCode.StateStaleEntity, `拼团 ${id} 已被并发迁移`);
      }

      // 参与者迁移（R-02：快照价维持——新行复制原快照；新加入者按 B2C 价经 C3 报名链）
      await this.migrateEnrollments(uow, participants, session.id, 'convert_migrated');

      // groupbuy 锚未发 job 作废（幽灵执行禁令；迟到 job 的 recheck（statusOf）亦兜底双保险）
      await this.scheduler.cancelJob(uow, {
        jobType: 'C2B_CONFIRM_TIMEOUT',
        refType: 'groupbuy',
        refId: id,
      });
      await this.scheduler.cancelJob(uow, {
        jobType: 'ENROLL_DEADLINE',
        refType: 'groupbuy',
        refId: id,
      });

      await this.outbox.recordOutbox(uow, {
        type: GROUP_BUY_CONVERTED_TOPIC,
        payload: {
          gb_id: id,
          session_id: session.id,
          capacity,
          migrated_users: participants.map((p) => Number(p.user_id)),
        } satisfies GroupBuyConvertedPayload,
      });
      return { session_id: session.id };
    });
  }

  // ===========================================================================
  // 24h 转化退款窗（R-03；服务面——§5 未定义用户 HTTP 入口，不发明端点，报告注记）
  // ===========================================================================

  /**
   * 被迁移用户申请转化退款：守卫=迁移行（prev_enrollment_id 非空的 session 型 PAID 行）+
   * 24h 窗内（迁移行 created_at 锚=转化事务时刻；**窗判定走 DB 钟**——`now() - created_at
   * <= interval '24 hours'` 在 SQL 侧计算，应用钟与 DB 钟混用是修复环 M-1 移除项）；超窗 409。
   * 受理=F2 accept（reason=CONVERT_WINDOW=§2 九值实词；幂等键 refund/po-{原单}/convert-window
   * ——重放短路）；退款完成收敛（RefundCompleted→advanceToRefunded）经迁移链重定向落到本
   * 迁移行 PAID→REFUNDED。
   */
  async requestConvertRefund(
    enrollmentId: number,
    userId: number,
  ): Promise<{ refund_id: number; status: string }> {
    const id = assertPositiveInt(enrollmentId, 'enrollment_id');
    const uid = assertPositiveInt(userId, 'user_id');
    const res = await this.pool.query<{
      ref_type: string;
      user_id: string;
      pay_status: string;
      prev_enrollment_id: string | null;
      cash_amount: string;
      points_amount: number;
      hours_since_migration: string;
      in_window: boolean;
    }>(
      `SELECT ref_type, user_id::text AS user_id, pay_status, prev_enrollment_id::text AS prev_enrollment_id,
              cash_amount::text AS cash_amount, points_amount,
              EXTRACT(EPOCH FROM (now() - created_at)) / 3600.0 AS hours_since_migration,
              now() - created_at <= make_interval(hours => $2::int) AS in_window
         FROM trade.enrollments WHERE id = $1`,
      [id, CONVERT_REFUND_WINDOW_HOURS],
    );
    const row = res.rows[0];
    if (!row || Number(row.user_id) !== uid) {
      throw new AppError(ErrorCode.NotFound, `报名不存在：${id}`); // 非本人不暴露他人物
    }
    if (row.ref_type !== 'session' || row.prev_enrollment_id === null) {
      throw new AppError(
        ErrorCode.Conflict,
        `报名 ${id} 非转化迁移行（无 prev 回链），不适用 24h 转化退款窗`,
      );
    }
    if (row.pay_status !== 'PAID') {
      throw new AppError(
        ErrorCode.Conflict,
        `报名 ${id} 状态 ${row.pay_status} 不可申请（仅 PAID 迁移行）`,
      );
    }
    if (!row.in_window) {
      throw new AppError(
        ErrorCode.Conflict,
        `已过 24h 转化退款窗（迁移已 ${Number(row.hours_since_migration).toFixed(1)}h，R-03 仅窗内可申请）`,
      );
    }
    // 原单定位：迁移行不自持支付单（enrollment.refund-source 同一回链口径）
    const order = await this.payment.findOrderByIdempotencyKey(
      enrollmentOrderKey(Number(row.prev_enrollment_id)),
    );
    if (!order) {
      throw new AppError(
        ErrorCode.InternalError,
        `迁移报名 ${id} 的原支付单不可读（prev=${row.prev_enrollment_id}，不应触达）`,
      );
    }
    const { refund } = await this.refunds.accept({
      order_id: order.id,
      user_id: uid,
      cash: row.cash_amount,
      points: row.points_amount,
      reason: 'CONVERT_WINDOW',
      idempotency_key: `refund/po-${order.id}/convert-window`,
    });
    return { refund_id: refund.refund_id, status: refund.status };
  }

  // ===========================================================================
  // 接单响应统计（§5 GET /lawyer/response-stats?from=&to=：12h 确认时长，口径=H4；STL 聚合）
  // ===========================================================================

  /**
   * 律师本人 [from,to)（上海日界，左闭右开——session.stats 同口径）窗内的确认时长：
   * CONFIRMED 迁移的 STL 留痕（allowed=true，entity_type='group_buy'）为锚，时长=CONFIRMED
   * 时刻 − 同实体 PENDING_LAWYER 时刻（12h 确认窗的实耗）。samples=逐拼团样本；avg=
   * 算术平均分钟（无样本=null）。STL 读经基座服务 StateTransitionLogService（platform 表
   * 经基座访问属设计内合法跨域；lawyer 归属过滤在 trade 侧）。
   */
  async responseStats(
    lawyerId: number,
    from: string,
    to: string,
  ): Promise<{
    samples: ReadonlyArray<{ gb_id: number; confirmed_at: string; confirm_minutes: number }>;
    avg_confirm_minutes: number | null;
  }> {
    const lid = assertPositiveInt(lawyerId, 'lawyer_id');
    const fromDate = assertIsoDate(from, 'from');
    const toDate = assertIsoDate(to, 'to');
    if (Date.parse(`${toDate}T00:00:00Z`) < Date.parse(`${fromDate}T00:00:00Z`)) {
      throw new AppError(
        ErrorCode.InvalidArgument,
        `区间倒置（from 须 ≤ to）：${fromDate}..${toDate}`,
      );
    }
    const windowStart = shanghaiDayStart(fromDate);
    const windowEnd = shanghaiDayStart(shanghaiDayAfter(toDate));

    // 窗读护栏 LIMIT 200（修复环 I-2：H4 管道接管前的使用边界——宽窗/全量 STL 扫不进本查询面；
    // 超限窗的确认时长聚合=H4 指标管道（M2-W2 T8）职责，本面只承载律师近端窗口）
    const confirmed = await this.stateLog.listAllowedTransitions({
      entityType: 'group_buy',
      toStatus: 'CONFIRMED',
      from: windowStart,
      to: windowEnd,
      limit: STATS_STL_READ_LIMIT,
    });
    if (confirmed.length === 0) return { samples: [], avg_confirm_minutes: null };

    // 本人归属过滤（STL 无 lawyer 列——trade 侧反查 group_buys）
    const ids = [...new Set(confirmed.map((t) => t.entityId))];
    const mine = await this.pool.query<{ id: string }>(
      `SELECT id FROM trade.group_buys WHERE lawyer_id = $1 AND id = ANY($2::bigint[])`,
      [lid, ids],
    );
    const mineSet = new Set(mine.rows.map((r) => Number(r.id)));
    const mineConfirmed = confirmed.filter((t) => mineSet.has(t.entityId));
    if (mineConfirmed.length === 0) return { samples: [], avg_confirm_minutes: null };

    // 各实体 PENDING_LAWYER 起点（最早一次——groupBuyReachedGuard 单事务双边，恒一行）
    const pending = await this.stateLog.listAllowedTransitions({
      entityType: 'group_buy',
      toStatus: 'PENDING_LAWYER',
      entityIds: [...mineSet],
    });
    const pendingAt = new Map<number, number>();
    for (const t of pending) {
      const ms = Date.parse(t.createdAt);
      const prev = pendingAt.get(t.entityId);
      if (prev === undefined || ms < prev) pendingAt.set(t.entityId, ms);
    }

    const samples: Array<{ gb_id: number; confirmed_at: string; confirm_minutes: number }> = [];
    for (const t of mineConfirmed as TransitionLogReadRow[]) {
      const startMs = pendingAt.get(t.entityId);
      if (startMs === undefined) continue; // 无 PENDING_LAWYER 留痕=数据漂移，跳过不计（防御）
      const endMs = Date.parse(t.createdAt);
      samples.push({
        gb_id: t.entityId,
        confirmed_at: t.createdAt,
        confirm_minutes: Math.round(((endMs - startMs) / 60_000) * 100) / 100,
      });
    }
    samples.sort((a, b) => a.gb_id - b.gb_id);
    const avg =
      samples.length === 0
        ? null
        : Math.round((samples.reduce((s, x) => s + x.confirm_minutes, 0) / samples.length) * 100) /
          100;
    return { samples, avg_confirm_minutes: avg };
  }

  // ===========================================================================
  // 内部件
  // ===========================================================================

  /**
   * 参与者迁移（§3/§9）：每 PAID 行——守卫 PAID→CONVERTED_OUT（STL 留痕 reason=迁移分支）→
   * 旧行仅 pay_status 位翻转（乐观谓词锚源态 PAID）→ 新建 session 型行（快照/金额/版本列
   * 原样复制 + prev_enrollment_id 回链 + pay_status='PAID' 出生态：款已付讫于原单，迁移
   * 不搬家款）。PENDING 行不迁移（晚到回调走既有自动退款分支，R-W3-O 延续）。
   */
  private async migrateEnrollments(
    uow: SqlExecutor,
    participants: readonly ParticipantRow[],
    sessionId: number,
    reason: string,
  ): Promise<void> {
    for (const p of participants) {
      const oldId = Number(p.id);
      await this.guard.assertTransition(ENROLLMENT_MACHINE, {
        entityId: oldId,
        from: 'PAID',
        to: 'CONVERTED_OUT',
        reason,
        uow,
      });
      const upd = await uow.query<{ id: string }>(
        `UPDATE trade.enrollments SET pay_status = 'CONVERTED_OUT'
          WHERE id = $1 AND pay_status = 'PAID' RETURNING id`,
        [oldId],
      );
      if (upd.rows.length === 0) {
        throw new AppError(ErrorCode.StateStaleEntity, `报名 ${oldId} 已被并发迁移`);
      }
      await uow.query<{ id: string }>(
        `INSERT INTO trade.enrollments
           (ref_type, ref_id, user_id, price_snapshot, unit_price, paid_amount, cash_amount,
            points_amount, price_version_id, pay_status, credit_used, prev_enrollment_id)
         VALUES ('session', $1, $2, $3::jsonb, $4, $5, $6, $7, $8, 'PAID', $9, $10)
         RETURNING id`,
        [
          sessionId,
          p.user_id,
          JSON.stringify(p.price_snapshot),
          p.unit_price,
          p.paid_amount,
          p.cash_amount,
          p.points_amount,
          p.price_version_id,
          p.credit_used,
          oldId,
        ],
      );
    }
  }

  /** 已支付参与者（FOR UPDATE 行锁：与并发支付回调/取消/退款收敛串行化） */
  private async lockPaidParticipants(
    uow: SqlExecutor,
    groupBuyId: number,
  ): Promise<readonly ParticipantRow[]> {
    const res = await uow.query<ParticipantRow>(
      `SELECT ${PARTICIPANT_COLS} FROM trade.enrollments
        WHERE ref_type = 'groupbuy' AND ref_id = $1 AND pay_status = 'PAID'
        ORDER BY id FOR UPDATE`,
      [groupBuyId],
    );
    return res.rows;
  }

  /**
   * 履约 Session 回链直读（幂等重放锚；V41 修复环 C-2）：CONFIRMED/CONVERTED 行的
   * group_buys.session_id 列（confirm/convert 建面同事务落值）。迁移链反查路径已删除——
   * 唯一路径=本列；C4 前无 CONFIRMED/CONVERTED 生产者，历史行不存在缺值形态（缺值=漂移
   * 显性化 InternalError，不静默）。
   */
  private storedSessionId(row: GroupBuyRow, groupBuyId: number): number {
    if (row.session_id === null) {
      throw new AppError(
        ErrorCode.InternalError,
        `拼团 ${groupBuyId} 已确认/已转化但 session_id 回链缺值（不应触达）`,
      );
    }
    return Number(row.session_id);
  }

  /** 沟通形式缺省：B3 room_modes 首值（配置存在时），否则 'text'（V1 C2B 文字咨询默认，⚠报告注记） */
  private async resolveRoomMode(lawyerId: number): Promise<SessionRoomMode> {
    const current = await this.pricing.getCurrentPricing(lawyerId);
    const mode = current.pricing?.room_modes?.[0];
    return mode === undefined || mode === null ? 'text' : mode;
  }

  /**
   * 转化价解算计划（事务外）：显式覆盖=per_head 单价；缺省=B3 现值（per_head 优先、
   * session_total 次选——「新加入按 B2C 定价」R-02；B3 全空 → 400）。最终 unit/total 按
   * capacity 整化（computeConvertPrices，事务内 capacity 定形后）——全程整数分无浮点。
   */
  private async resolveConvertPrice(
    lawyerId: number,
    priceOverride: Money | undefined,
  ): Promise<
    | { readonly mode: 'per_head'; readonly unitCents: number }
    | { readonly mode: 'session_total'; readonly totalCents: number }
  > {
    if (priceOverride !== undefined) {
      return { mode: 'per_head', unitCents: moneyToCents(priceOverride) };
    }
    const current = await this.pricing.getCurrentPricing(lawyerId);
    const cfg = current.pricing;
    if (cfg !== null && cfg !== undefined && cfg.per_head !== null && cfg.per_head !== undefined) {
      return { mode: 'per_head', unitCents: moneyToCents(cfg.per_head) };
    }
    if (
      cfg !== null &&
      cfg !== undefined &&
      cfg.session_total !== null &&
      cfg.session_total !== undefined
    ) {
      return { mode: 'session_total', totalCents: moneyToCents(cfg.session_total) };
    }
    throw new AppError(
      ErrorCode.InvalidArgument,
      `律师 ${lawyerId} 未配置 B3 per_head/session_total 现值（转化缺省价源缺失），须显式传 price 或先配置 B3`,
    );
  }

  private async lockRowForUpdate(exec: SqlExecutor, id: number): Promise<GroupBuyRow | null> {
    const res = await exec.query<GroupBuyRow>(
      `SELECT ${GB_COLS} FROM trade.group_buys WHERE id = $1 FOR UPDATE`,
      [id],
    );
    return res.rows[0] ?? null;
  }
}

/** 转化价计划 → 行价格（capacity 定形后）：per_head=total=unit×capacity；session_total=
 *  unit=splitTotalIntoUnit 半分向上（C1 resolvePrices 同口径；整数分全程无浮点） */
function computeConvertPrices(
  plan:
    | { readonly mode: 'per_head'; readonly unitCents: number }
    | {
        readonly mode: 'session_total';
        readonly totalCents: number;
      },
  capacity: number,
): { price_mode: PriceMode; unit_price: Money; session_total: Money } {
  if (plan.mode === 'per_head') {
    return {
      price_mode: 'per_head',
      unit_price: centsToMoney(plan.unitCents),
      session_total: centsToMoney(plan.unitCents * capacity),
    };
  }
  return {
    price_mode: 'session_total',
    unit_price: centsToMoney(splitTotalIntoUnit(plan.totalCents, capacity)),
    session_total: centsToMoney(plan.totalCents),
  };
}
