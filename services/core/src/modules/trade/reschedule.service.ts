/**
 * C5 改期服务（M2-W2 T5；§1/§2/§4/§5/§7/§8/§9）——交易域应用服务导出面（可剥离纪律同形：
 * 只暴露应用服务+事件契约+HTTP 契约；机器件/配置为模块内部件复用）。
 *
 * 三面一执行器：
 *   - 申请（POST /enrollments/{id}/reschedule {target_session_id}，§5；幂等键=enrollment）：
 *     守卫链=属主（403 RESTRICTED）→ session 型 PAID 报名 → R-02 reschedule_used 一次（409
 *     USED）→ 已有 PENDING 请求（同目标幂等返回/异目标 409）→ R-01 原场次开始前 ≥2h（400
 *     <2H；**裁定锚=原场次 scheduled_start**，DB 钟窗判定）→ 目标场次软守卫（同律师+CREATED
 *     +joined<capacity，409 NO_SEAT——确认时权威守卫兜底）+用户在目标场次无活跃报名
 *     （**I-1** 软检查 400——确认事务 NOT EXISTS 权威守卫同语义）→ 同事务：PENDING 行落库
 *     （expires_at=now()+confirmTimeoutHours，DB 钟生成）+RESCHEDULE_CONFIRM_TIMEOUT job 预写
 *     （ref=reschedule/request_id，due=expires_at）+RescheduleRequested 出箱（I1 通知律师位）；
 *   - 撤回（POST /reschedule/{id}/cancel，§2 确认前；409 CONFIRMED=已确认不可撤）：PENDING→
 *     CANCELLED+超时 job 同事务作废（幽灵执行禁令）；
 *   - 律师确认（POST /reschedule/{id}/confirm，§4 逐字；幂等键=request；**M-2：律师属主校验
 *     前移至一切状态分支（含 CONFIRMED 幂等短路）之前**——防任意律师 JWT 探测）：目标场次
 *     空位守卫（FOR UPDATE 并发安全，C3 模式——失败→请求置 FAILED+409 NO_SEAT，**FAILED 置位
 *     随事务提交**）+「用户在目标场次无活跃报名」NOT EXISTS 守卫（**I-1**：PENDING|PAID 撞
 *     ux_enroll_active 唯一索引——无此前置则迁移 INSERT 直接 23505 冒 500；失败→FAILED+
 *     409 E_CONFLICT）→ 旧 enrollment PAID→RESCHEDULED_OUT（守卫+STL；**§9 新建行铁律：旧行
 *     仅 pay_status 位翻转，业务列禁 UPDATE**）→ 新建 enrollment（快照列逐字复制=R-03 不重算+
 *     reschedule_used=true+prev_enrollment_id 回链）→ 目标 joined+1（满员即 markFull，R-02
 *     满员即成团——C4 confirm 先例）→ 旧场次 joined-1（**席位回吐裁定**：验收项「旧段释放」
 *     的计数半边；FULL 不回退状态，空位重开由 status 守卫承载）→ 超时 job 作废 → 请求置
 *     CONFIRMED（confirmed_at 落值）→ RescheduleConfirmed 出箱；
 *   - 超时执行器（RESCHEDULE_CONFIRM_TIMEOUT，§6 消费=ScheduleJobFired 语义——I2 拾取
 *     驱动）：recheck=请求仍 PENDING；执行=PENDING→EXPIRED（**R-04 原报名完全不动——幂等
 *     回退**）+I1 直发通知用户（模板在册才发——C6 撤销话术同款决策位：RESCHEDULE_EXPIRED
 *     seed 归 I1 域，缺失跳过+告警日志不阻断回退）。
 *
 * D2 提醒重投（§10④ I2 联调，**裁定**——REMIND×4 job 是场次锚（refType='session'）且分发
 * 对象=执行时点该场次 PAID 清单动态取数（reminder.service listPaidEnrollmentUsers）：
 * 确认事务零 REMIND job 操作——改期者置 RESCHEDULED_OUT 天然跌出旧场次 PAID 清单（零幽灵
 * 提醒），迁移新行天然进入目标场次 PAID 清单（届时提醒自动重投）；目标场次 REMIND×4 在其
 * 创建事务已锚自身 slot_start 预写（session.service REMIND_OFFSETS_MS），重复预写=幽灵重复
 * job；旧场次 REMIND 作废反会丢失同场次其他报名者的提醒（场次级 job 服务全场次）——故
 * 确认事务不作废不预写，消费面职责=防御复核（reminder.consumer，迁移链漂移显性化）。
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  AppError,
  ErrorCode,
  RESCHEDULE_CONFIRMED_TOPIC,
  RESCHEDULE_REQUESTED_TOPIC,
  type RescheduleConfirmedPayload,
  type RescheduleRequestedPayload,
} from '@ljr/shared';
import type { SqlExecutor } from '../../infrastructure/sql';
import { PgPoolService } from '../../infrastructure/sql';
import { OutboxService } from '../../infrastructure/outbox/outbox.service';
import { StateTransitionGuardService } from '../../infrastructure/state-machine/state-transition-guard.service';
import { NotifyDispatcherService } from '../notify/notify-dispatcher.service';
import { NotifyTemplateService } from '../notify/notify-template.service';
import { SchedulerService } from '../schedule/scheduler.service';
import { EnrollmentService } from './enrollment.service';
import { ENROLLMENT_MACHINE } from './enrollment.machine';
import { SessionService } from './session.service';
import { TRADE_RESCHEDULE_CONFIG, type TradeRescheduleConfig } from './reschedule.config';
import { RESCHEDULE_MACHINE, type RescheduleStatus } from './reschedule.machine';
import {
  RESCHEDULE_JOB_REF_TYPE,
  RESCHEDULE_MIGRATE_COLS,
  type RescheduleMigrateRow,
  type RescheduleRequestView,
} from './reschedule.types';

/** I1 模板中心 code（EXPIRED 直发；在册才发——seed 归 I1 域，类注「C6 同款决策位」） */
export const RESCHEDULE_EXPIRED_TEMPLATE_CODE = 'RESCHEDULE_EXPIRED';

/** reschedule_requests 行（DB 形态；enrollment 归属半边经域内 JOIN 带出——锁序恒先 enrollment） */
interface RequestRow {
  readonly id: string;
  readonly enrollment_id: string;
  readonly target_session_id: string;
  readonly status: string;
  readonly requested_at: Date;
  readonly confirmed_at: Date | null;
  readonly expires_at: Date;
}

interface RequestWithUserRow extends RequestRow {
  readonly user_id: string;
}

const REQUEST_COLS = `id, enrollment_id::text AS enrollment_id, target_session_id::text AS target_session_id,
  status, requested_at, confirmed_at, expires_at`;

function toView(row: RequestRow): RescheduleRequestView {
  return {
    id: Number(row.id),
    enrollment_id: Number(row.enrollment_id),
    target_session_id: Number(row.target_session_id),
    status: row.status as RescheduleStatus,
    requested_at: new Date(row.requested_at).toISOString(),
    confirmed_at: row.confirmed_at === null ? null : new Date(row.confirmed_at).toISOString(),
    expires_at: new Date(row.expires_at).toISOString(),
  };
}

function assertPositiveInt(v: unknown, field: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0 || !Number.isSafeInteger(v)) {
    throw new AppError(ErrorCode.InvalidArgument, `${field} 须为正整数：${JSON.stringify(v)}`);
  }
  return v;
}

@Injectable()
export class RescheduleService {
  private readonly logger = new Logger(RescheduleService.name);

  constructor(
    private readonly pool: PgPoolService,
    private readonly outbox: OutboxService,
    private readonly guard: StateTransitionGuardService,
    private readonly scheduler: SchedulerService,
    // 同域建面/满员推进（R-W3-K 单点纪律；禁跨 schema join——架构 §3.2 红线）
    private readonly sessions: SessionService,
    private readonly enrollments: EnrollmentService,
    // I1 通知（EXPIRED 直发）+模板在册判定（price-change C6 同款跨域导出服务消费形态）
    private readonly dispatcher: NotifyDispatcherService,
    private readonly templates: NotifyTemplateService,
    @Inject(TRADE_RESCHEDULE_CONFIG) private readonly config: TradeRescheduleConfig,
  ) {}

  // ===========================================================================
  // 申请（§5 POST /enrollments/{id}/reschedule：幂等键=enrollment；400 <2H / 409 NO_SEAT|USED
  // / 403 RESTRICTED）
  // ===========================================================================

  async apply(
    enrollmentId: number,
    userId: number,
    targetSessionId: number,
  ): Promise<RescheduleRequestView> {
    const eid = assertPositiveInt(enrollmentId, 'enrollment_id');
    const uid = assertPositiveInt(userId, 'user_id');
    const target = assertPositiveInt(targetSessionId, 'target_session_id');

    return this.pool.withTransaction(async (uow) => {
      // 单锁事务（仅锁 enrollment；PENDING 请求查询无锁）——confirm 是唯一双锁事务（r→e 序），
      // 本面不反向持锁等待，无环无死锁
      const enrollment = await this.lockEnrollment(uow, eid);
      if (!enrollment) {
        throw new AppError(ErrorCode.NotFound, `报名不存在：${eid}`);
      }
      if (Number(enrollment.user_id) !== uid) {
        // §5 403 RESTRICTED（非属主；Restricted 码复用——403 状态字面对齐，message 区分语义）
        throw new AppError(
          ErrorCode.Restricted,
          `用户 ${uid} 非报名 ${eid} 属主（user=${enrollment.user_id}），不可代申请改期`,
        );
      }
      if (enrollment.ref_type !== 'session') {
        throw new AppError(
          ErrorCode.Conflict,
          `报名 ${eid} 非场次报名（ref_type=${enrollment.ref_type}），无改期语义（拼团行经 C4 转化后再改期）`,
        );
      }
      if (enrollment.pay_status !== 'PAID') {
        throw new AppError(
          ErrorCode.Conflict,
          `报名 ${eid} 状态 ${enrollment.pay_status} 不可改期（仅 PAID 已支付报名，R-01）`,
        );
      }
      if (enrollment.reschedule_used) {
        throw new AppError(
          ErrorCode.RescheduleUsed,
          `报名 ${eid} 免费改期一次已使用（R-02），不可再次改期`,
        );
      }
      const sourceSessionId = Number(enrollment.ref_id);

      // 幂等键=enrollment：已有 PENDING 请求——同目标幂等返回原请求，异目标 409（先撤回再申请）
      const pending = await uow.query<RequestRow>(
        `SELECT ${REQUEST_COLS} FROM trade.reschedule_requests
          WHERE enrollment_id = $1 AND status = 'PENDING' ORDER BY id DESC LIMIT 1`,
        [eid],
      );
      const prev = pending.rows[0];
      if (prev) {
        if (Number(prev.target_session_id) === target) return toView(prev);
        throw new AppError(
          ErrorCode.Conflict,
          `报名 ${eid} 已有进行中改期请求（${prev.id}，目标场次 ${prev.target_session_id}），先撤回再申请`,
        );
      }

      // R-01 <2h：锚=原场次 scheduled_start（裁定，类注）；窗判定走 DB 钟（C4 修复环 M-1 口径）
      const source = await uow.query<{
        lawyer_id: string;
        status: string;
        slot_start: Date;
        lead_ok: boolean;
      }>(
        `SELECT lawyer_id::text AS lawyer_id, status, slot_start,
                slot_start - now() >= make_interval(hours => $2::int) AS lead_ok
           FROM trade.sessions WHERE id = $1`,
        [sourceSessionId, this.config.requestLeadHours],
      );
      const src = source.rows[0];
      if (!src) {
        throw new AppError(
          ErrorCode.InternalError,
          `报名 ${eid} 指向的场次 ${sourceSessionId} 不可读（不应触达）`,
        );
      }
      if (this.sessions.isTerminalStatus(src.status)) {
        throw new AppError(
          ErrorCode.Conflict,
          `原场次 ${sourceSessionId} 已终态（${src.status}），改期不适用（走 D4 取消链）`,
        );
      }
      if (!src.lead_ok) {
        throw new AppError(
          ErrorCode.InvalidArgument,
          `原场次开始前不足 ${this.config.requestLeadHours}h（slot_start=${new Date(src.slot_start).toISOString()}），R-01 不可申请改期`,
        );
      }
      if (target === sourceSessionId) {
        throw new AppError(
          ErrorCode.InvalidArgument,
          `目标场次与原场次相同（${target}），改期无意义`,
        );
      }

      // 目标场次软守卫（§1 边界：同律师既有报名中场次空位——⚠04§8-5 本设计默认）；
      // 权威守卫在确认事务（FOR UPDATE，§8 并发安全）
      const seat = await uow.query<{
        seat_ok: boolean;
        status: string;
        joined: number;
        capacity: number;
      }>(
        `SELECT (lawyer_id = $2 AND status = 'CREATED' AND joined < capacity) AS seat_ok,
                status, joined, capacity
           FROM trade.sessions WHERE id = $1`,
        [target, src.lawyer_id],
      );
      const seatRow = seat.rows[0];
      if (!seatRow) {
        throw new AppError(ErrorCode.NotFound, `目标场次不存在：${target}`);
      }
      if (!seatRow.seat_ok) {
        throw new AppError(
          ErrorCode.NoSeat,
          `目标场次 ${target} 无可改期空位（须同律师+报名中+有空位：status=${seatRow.status}，${seatRow.joined}/${seatRow.capacity}）`,
        );
      }
      // I-1（评审）：目标场次该用户活跃报名软检查（确认事务权威守卫同语义——此处 400 前置，
      // 防注定失败的申请入列占用 12h 窗与律师确认面）
      const active = await uow.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM trade.enrollments
          WHERE ref_type = 'session' AND ref_id = $1 AND user_id = $2
            AND pay_status IN ('PENDING', 'PAID')`,
        [target, uid],
      );
      if ((active.rows[0]?.n ?? 0) > 0) {
        throw new AppError(
          ErrorCode.InvalidArgument,
          `用户 ${uid} 在目标场次 ${target} 已有进行中报名（PENDING|PAID），不可改期进入（先撤单或完成支付收敛）`,
        );
      }

      // 同事务：PENDING 行（expires_at=DB 钟生成——requested_at 与窗判定同钟）+超时 job 预写+出箱
      const inserted = await uow.query<RequestRow>(
        `INSERT INTO trade.reschedule_requests
           (enrollment_id, target_session_id, status, expires_at)
         VALUES ($1, $2, 'PENDING', now() + make_interval(hours => $3::int))
         RETURNING ${REQUEST_COLS}`,
        [eid, target, this.config.confirmTimeoutHours],
      );
      const row = inserted.rows[0]!;
      const requestId = Number(row.id);
      await this.scheduler.registerJob(uow, {
        jobType: 'RESCHEDULE_CONFIRM_TIMEOUT',
        refType: RESCHEDULE_JOB_REF_TYPE,
        refId: requestId,
        dueAt: new Date(row.expires_at), // DB 生成值回传——due 与 expires_at 同源同钟
      });
      await this.outbox.recordOutbox(uow, {
        type: RESCHEDULE_REQUESTED_TOPIC,
        payload: {
          request_id: requestId,
          enrollment_id: eid,
          user_id: uid,
          target_session_id: target,
        } satisfies RescheduleRequestedPayload,
      });
      return toView(row);
    });
  }

  // ===========================================================================
  // 撤回（§2/§5 POST /reschedule/{id}/cancel：409 CONFIRMED=已确认不可撤；幂等=CANCELLED 短路）
  // ===========================================================================

  async cancel(requestId: number, userId: number): Promise<{ status: 'CANCELLED' }> {
    const rid = assertPositiveInt(requestId, 'request_id');
    const uid = assertPositiveInt(userId, 'user_id');

    return this.pool.withTransaction(async (uow) => {
      const row = await this.lockRequestWithUser(uow, rid);
      if (!row) {
        throw new AppError(ErrorCode.NotFound, `改期请求不存在：${rid}`);
      }
      if (Number(row.user_id) !== uid) {
        throw new AppError(
          ErrorCode.Restricted,
          `用户 ${uid} 非改期请求 ${rid} 属主（user=${row.user_id}），不可代撤回`,
        );
      }
      if (row.status === 'CANCELLED') return { status: 'CANCELLED' as const }; // 幂等重放
      if (row.status === 'CONFIRMED') {
        throw new AppError(
          ErrorCode.Conflict,
          `改期请求 ${rid} 已确认（CONFIRMED），不可撤回（§5 409 CONFIRMED）`,
        );
      }
      if (row.status !== 'PENDING') {
        throw new AppError(
          ErrorCode.Conflict,
          `改期请求 ${rid} 状态 ${row.status} 不可撤回（仅 PENDING 确认前可撤，§2）`,
        );
      }
      await this.transitionRequest(uow, rid, 'PENDING', 'CANCELLED', 'user_cancelled');
      // 超时 job 同事务作废（幽灵执行禁令；迟到 job 的 recheck 亦兜底双保险）
      await this.scheduler.cancelJob(uow, {
        jobType: 'RESCHEDULE_CONFIRM_TIMEOUT',
        refType: RESCHEDULE_JOB_REF_TYPE,
        refId: rid,
      });
      return { status: 'CANCELLED' as const };
    });
  }

  // ===========================================================================
  // 律师确认（§4 逐字 / §5 POST /reschedule/{id}/confirm：幂等键=request；409 EXPIRED|NO_SEAT）
  // ===========================================================================

  async confirm(requestId: number, lawyerId: number): Promise<{ new_enrollment_id: number }> {
    const rid = assertPositiveInt(requestId, 'request_id');
    const lid = assertPositiveInt(lawyerId, 'lawyer_id');

    // NO_SEAT 路径的请求置 FAILED 是要提交的业务效果——经 deferred 事务外抛（事务不回滚）
    let deferred: AppError | null = null;
    const out = await this.pool.withTransaction(async (uow) => {
      const request = await this.lockRequestWithUser(uow, rid);
      if (!request) {
        throw new AppError(ErrorCode.NotFound, `改期请求不存在：${rid}`);
      }
      // M-2（评审）：律师属主校验前移至一切状态分支（含 CONFIRMED 幂等短路）之前——
      // 防任意律师 JWT 经幂等重放面探测 new_enrollment_id（非本人场次不暴露，C4 同口径）
      await this.assertTargetLawyer(uow, Number(request.target_session_id), lid);
      if (request.status === 'CONFIRMED') {
        // 幂等重放（幂等键=request）：迁移新行直读（prev 回链+目标场次双锚精确解析）
        const successor = await uow.query<{ id: string }>(
          `SELECT id FROM trade.enrollments
            WHERE prev_enrollment_id = $1 AND ref_type = 'session' AND ref_id = $2
            ORDER BY id DESC LIMIT 1`,
          [Number(request.enrollment_id), Number(request.target_session_id)],
        );
        const row = successor.rows[0];
        if (!row) {
          throw new AppError(
            ErrorCode.InternalError,
            `改期请求 ${rid} 已 CONFIRMED 但迁移新行不可读（不应触达）`,
          );
        }
        return { new_enrollment_id: Number(row.id) };
      }
      if (request.status === 'EXPIRED') {
        throw new AppError(
          ErrorCode.RescheduleExpired,
          `改期请求 ${rid} 已过 12h 确认窗（EXPIRED），原报名不受影响（R-04）`,
        );
      }
      if (request.status !== 'PENDING') {
        throw new AppError(
          ErrorCode.Conflict,
          `改期请求 ${rid} 状态 ${request.status} 不可确认（仅 PENDING 可确认）`,
        );
      }
      const eid = Number(request.enrollment_id);
      const target = Number(request.target_session_id);

      // 锁序第二步=重锁 enrollment（confirm 为唯一双锁事务 r→e；apply/cancel/expire 均单锁——无环）
      const enrollment = await this.lockEnrollment(uow, eid);
      if (!enrollment || enrollment.pay_status !== 'PAID') {
        throw new AppError(
          ErrorCode.InternalError,
          `改期请求 ${rid} 的源报名 ${eid} 不可读或非 PAID（不应触达）`,
        );
      }
      const sourceSessionId = Number(enrollment.ref_id);

      // 目标场次空位守卫（§8：FOR UPDATE 并发安全，C3 同款模式——两请求同 confirm 抢 1 空位恰一成功）；
      // I-1（评审）：追加「用户在目标场次无活跃报名」NOT EXISTS（PENDING|PAID 撞 ux_enroll_active
      // 唯一索引——无此前置则迁移 INSERT 直接 23505 冒 500）——权威守卫，apply 侧同语义软检查
      const seat = await uow.query<{
        lawyer_id: string;
        status: string;
        joined: number;
        capacity: number;
        seat_ok: boolean;
        active_ok: boolean;
      }>(
        `SELECT lawyer_id::text AS lawyer_id, status, joined, capacity,
                (status = 'CREATED' AND joined < capacity) AS seat_ok,
                NOT EXISTS(
                  SELECT 1 FROM trade.enrollments e
                   WHERE e.ref_type = 'session' AND e.ref_id = sessions.id
                     AND e.user_id = $2 AND e.pay_status IN ('PENDING', 'PAID')
                ) AS active_ok
           FROM trade.sessions WHERE id = $1 FOR UPDATE`,
        [target, enrollment.user_id],
      );
      const seatRow = seat.rows[0];
      if (!seatRow) {
        throw new AppError(ErrorCode.NotFound, `目标场次不存在：${target}`);
      }
      if (Number(seatRow.lawyer_id) !== lid) {
        // 防御位（M-2 属主校验已前置；同值恒过，不暴露他人物口径保留）
        throw new AppError(ErrorCode.NotFound, `目标场次不存在：${target}`);
      }
      if (!seatRow.seat_ok) {
        // 守卫失败 → 请求置 FAILED（随本事务提交）+409 NO_SEAT（deferred 事务外抛）
        await this.transitionRequest(uow, rid, 'PENDING', 'FAILED', 'no_seat_on_confirm');
        deferred = new AppError(
          ErrorCode.NoSeat,
          `目标场次 ${target} 已无空位（status=${seatRow.status}，${seatRow.joined}/${seatRow.capacity}），改期请求 ${rid} 置 FAILED`,
        );
        return { new_enrollment_id: 0 };
      }
      if (!seatRow.active_ok) {
        // I-1：目标场次已有该用户进行中报名（申请后新下的 PENDING/PAID 单）→ 请求置 FAILED
        // +409 E_CONFLICT（随事务提交，同 NO_SEAT 路径形态）
        await this.transitionRequest(uow, rid, 'PENDING', 'FAILED', 'active_enrollment_on_confirm');
        deferred = new AppError(
          ErrorCode.Conflict,
          `目标场次 ${target} 已有用户 ${enrollment.user_id} 的进行中报名（PENDING|PAID），改期请求 ${rid} 置 FAILED`,
        );
        return { new_enrollment_id: 0 };
      }

      // 旧 enrollment：PAID→RESCHEDULED_OUT（守卫+STL；§9 新建行铁律——旧行仅状态位翻转）
      await this.guard.assertTransition(ENROLLMENT_MACHINE, {
        entityId: eid,
        from: 'PAID',
        to: 'RESCHEDULED_OUT',
        reason: 'reschedule_confirmed',
        uow,
      });
      const updated = await uow.query<{ id: string }>(
        `UPDATE trade.enrollments SET pay_status = 'RESCHEDULED_OUT'
          WHERE id = $1 AND pay_status = 'PAID' RETURNING id`,
        [eid],
      );
      if (updated.rows.length === 0) {
        throw new AppError(ErrorCode.StateStaleEntity, `报名 ${eid} 已被并发迁移`);
      }

      // 新建 enrollment（R-03 快照列逐字复制不重算；reschedule_used=true+prev 回链）
      const insertedNew = await uow.query<{ id: string }>(
        `INSERT INTO trade.enrollments
           (ref_type, ref_id, user_id, price_snapshot, unit_price, paid_amount, cash_amount,
            points_amount, price_version_id, pay_status, credit_used, reschedule_used,
            prev_enrollment_id)
         VALUES ('session', $1, $2, $3::jsonb, $4, $5, $6, $7, $8, 'PAID', $9, true, $10)
         RETURNING id`,
        [
          target,
          enrollment.user_id,
          JSON.stringify(enrollment.price_snapshot),
          enrollment.unit_price,
          enrollment.paid_amount,
          enrollment.cash_amount,
          enrollment.points_amount,
          enrollment.price_version_id,
          enrollment.credit_used,
          eid,
        ],
      );
      const newEnrollmentId = Number(insertedNew.rows[0]!.id);

      // 目标 joined+1（C3 守卫同款乐观谓词——行锁下必成，防御位）；满员即成团（markFull，
      // C4 confirm 先例）；旧场次 joined-1（席位回吐裁定：joined>0 谓词防负计数）
      const bumped = await uow.query<{ joined: number }>(
        `UPDATE trade.sessions SET joined = joined + 1
          WHERE id = $1 AND status = 'CREATED' AND joined < capacity
          RETURNING joined`,
        [target],
      );
      if (bumped.rows.length === 0) {
        throw new AppError(ErrorCode.StateStaleEntity, `目标场次 ${target} 已被并发迁移`);
      }
      if ((bumped.rows[0]!.joined ?? 0) >= seatRow.capacity) {
        await this.sessions.markFull(target, uow);
      }
      await uow.query(
        `UPDATE trade.sessions SET joined = joined - 1 WHERE id = $1 AND joined > 0`,
        [sourceSessionId],
      );

      // 超时 job 作废（已确认窗收敛；迟到 job 的 recheck 亦兜底）
      await this.scheduler.cancelJob(uow, {
        jobType: 'RESCHEDULE_CONFIRM_TIMEOUT',
        refType: RESCHEDULE_JOB_REF_TYPE,
        refId: rid,
      });

      // 请求置 CONFIRMED（confirmed_at 落值）+出箱
      await this.transitionRequest(uow, rid, 'PENDING', 'CONFIRMED', 'lawyer_confirmed');
      await uow.query(`UPDATE trade.reschedule_requests SET confirmed_at = now() WHERE id = $1`, [
        rid,
      ]);
      await this.outbox.recordOutbox(uow, {
        type: RESCHEDULE_CONFIRMED_TOPIC,
        payload: {
          old_enrollment_id: eid,
          new_enrollment_id: newEnrollmentId,
          session_id: target,
          user_id: Number(enrollment.user_id),
        } satisfies RescheduleConfirmedPayload,
      });
      return { new_enrollment_id: newEnrollmentId };
    });
    if (deferred !== null) throw deferred;
    return out;
  }

  // ===========================================================================
  // 超时回退（RESCHEDULE_CONFIRM_TIMEOUT 执行器体；§6 消费=ScheduleJobFired 语义）
  // ===========================================================================

  /**
   * PENDING→EXPIRED（R-04：**原报名完全不动**——幂等回退；enrollment/场次/job 零操作）+
   * I1 直发通知用户（模板在册才发——C6 撤销话术同款决策位：RESCHEDULE_EXPIRED seed 归 I1
   * 域新迁移，缺失跳过+告警日志不阻断回退主流程）。非 PENDING（业务先到：确认/撤回/并发
   * 执行）→ {expired:false} 幂等无操作。EXPIRED 不出领域事件（§6 消费仅 ScheduleJobFired
   * ——回退是终态收敛非业务事实广播，任务报告裁定注记）。
   */
  async expireRequest(
    uow: SqlExecutor,
    requestId: number,
  ): Promise<{ expired: boolean; request_id: number }> {
    const rid = assertPositiveInt(requestId, 'request_id');
    const row = await this.lockRequestWithUser(uow, rid);
    if (!row || row.status !== 'PENDING') {
      return { expired: false, request_id: rid }; // 幂等回退：原报名不动（R-04）
    }
    await this.transitionRequest(uow, rid, 'PENDING', 'EXPIRED', 'confirm_timeout');
    if (await this.templateExists(uow, RESCHEDULE_EXPIRED_TEMPLATE_CODE)) {
      await this.dispatcher.registerForEvent(uow, {
        userId: Number(row.user_id),
        templateCode: RESCHEDULE_EXPIRED_TEMPLATE_CODE,
        params: { request_id: rid, enrollment_id: Number(row.enrollment_id) },
        idempotencyKey: `reschedule/r${rid}/expired`,
      });
    } else {
      this.logger.warn(
        `改期请求 ${rid} 超时回退：模板 ${RESCHEDULE_EXPIRED_TEMPLATE_CODE} 未 seed（I1 域待落）——本次跳过通知（⚠决策位，报告注明）`,
      );
    }
    return { expired: true, request_id: rid };
  }

  /** 执行器 recheck 锚（I2 catalog recheckAnchor「reschedule_requests 状态」的字面承载） */
  async statusOf(exec: SqlExecutor, requestId: number): Promise<RescheduleStatus | null> {
    const res = await exec.query<{ status: string }>(
      `SELECT status FROM trade.reschedule_requests WHERE id = $1`,
      [assertPositiveInt(requestId, 'request_id')],
    );
    const status = res.rows[0]?.status;
    return status === undefined ? null : (status as RescheduleStatus);
  }

  // ===========================================================================
  // 内部件
  // ===========================================================================

  /** 迁移源行（FOR UPDATE 行锁；快照列原样带走——R-03 逐字复制，与 C4 ParticipantRow 同构） */
  private async lockEnrollment(
    uow: SqlExecutor,
    enrollmentId: number,
  ): Promise<RescheduleMigrateRow | null> {
    const res = await uow.query<RescheduleMigrateRow>(
      `SELECT ${RESCHEDULE_MIGRATE_COLS} FROM trade.enrollments WHERE id = $1 FOR UPDATE`,
      [enrollmentId],
    );
    return res.rows[0] ?? null;
  }

  /** 请求行+报名属主（域内 JOIN 带出 user_id；锁 r 行——锁序恒后于 enrollment） */
  private async lockRequestWithUser(
    uow: SqlExecutor,
    requestId: number,
  ): Promise<RequestWithUserRow | null> {
    const res = await uow.query<RequestWithUserRow>(
      `SELECT r.id, r.enrollment_id::text AS enrollment_id,
              r.target_session_id::text AS target_session_id, r.status,
              r.requested_at, r.confirmed_at, r.expires_at, e.user_id::text AS user_id
         FROM trade.reschedule_requests r
         JOIN trade.enrollments e ON e.id = r.enrollment_id
        WHERE r.id = $1 FOR UPDATE OF r`,
      [requestId],
    );
    return res.rows[0] ?? null;
  }

  /**
   * 目标场次属主校验（M-2 评审前移位）：confirm 一切状态分支（含 CONFIRMED 幂等短路）之前
   * 调用——非属主律师不暴露他人物（不泄露请求状态与 new_enrollment_id，C4 confirm 同口径）。
   */
  private async assertTargetLawyer(
    uow: SqlExecutor,
    sessionId: number,
    lawyerId: number,
  ): Promise<void> {
    const res = await uow.query<{ lawyer_id: string }>(
      `SELECT lawyer_id::text AS lawyer_id FROM trade.sessions WHERE id = $1`,
      [sessionId],
    );
    const row = res.rows[0];
    if (!row || Number(row.lawyer_id) !== lawyerId) {
      throw new AppError(ErrorCode.NotFound, `目标场次不存在：${sessionId}`);
    }
  }

  /** 请求状态推进（守卫+STL+乐观谓词 UPDATE——状态禁裸写） */
  private async transitionRequest(
    uow: SqlExecutor,
    requestId: number,
    from: RescheduleStatus,
    to: RescheduleStatus,
    reason: string,
  ): Promise<void> {
    await this.guard.assertTransition(RESCHEDULE_MACHINE, {
      entityId: requestId,
      from,
      to,
      reason,
      uow,
    });
    const updated = await uow.query<{ id: string }>(
      `UPDATE trade.reschedule_requests SET status = $2
        WHERE id = $1 AND status = $3 RETURNING id`,
      [requestId, to, from],
    );
    if (updated.rows.length === 0) {
      throw new AppError(ErrorCode.StateStaleEntity, `改期请求 ${requestId} 已被并发迁移`);
    }
  }

  /** 模板在册判定（price-change.service templateExists 同款——在册才扇出） */
  private async templateExists(uow: SqlExecutor, code: string): Promise<boolean> {
    try {
      await this.templates.findByCode(uow, code);
      return true;
    } catch (e) {
      if (e instanceof AppError && e.code === ErrorCode.NotFound) return false;
      throw e;
    }
  }
}
