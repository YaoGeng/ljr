/**
 * C6 改价与补偿服务（施工规格 docs/modules/C-交易/C6-改价与补偿.md §4/§5/§7 + Task 9 简报）。
 *
 * 版本单写者（R-W3-P）：C6 不直写 price_versions——生效（createVersionFromDraftInTx）/撤销恢复
 * （restoreVersionInTx）均经 B3 版本服务导出方法（消费方接线性质）；pricing_histories 归 C6 写。
 * 在团判定（跨模块接口）：经 C1/C2 导出 hasActiveSessions/hasActiveGroupBuys；补偿对象经 C3
 * 导出 listActivePaidForLawyer——禁跨 schema join（架构 §3.2）。
 *
 * 引擎判定（§4 逐条，纯函数在 price-change.engine）：
 *   不在团 → 直效（自由改价，无惩罚无信用事件无通知）；在团 UP → 直效 + 信用事件（G1 消费 -5）
 *   + 已锁定用户锁价话术；在团 DOWN≤10% / >10% → 审批档（PENDING_APPROVAL）。
 * 频率（R-03，⚠W3-7 裁决）：DB 滑窗——pricing_histories 按 lawyer+created_at 30 天窗口计数
 * （含涨降、含被否决/待审请求=保守风控口径，报告注明）；超限 → 审批兜底档（无论方向/在团）。
 * Redis 滑窗为换装适配位（本头注即锚，开发期无 Redis 基建 Ruling-6；换装时仅替换
 * countRecentChanges 实现，窗口事实源仍为 DB now() 口径复核）。窗口/撤销判定全走 DB 时钟。
 * 429 FREQ_EXCEEDED 契约位保留不用：PRD §8.2 无滥用 429 明确定义，超限语义=审批兜底档。
 *
 * 审批（①期人工兜底）：approval_source='MANUAL'（H3=M2 接 TicketResolved 重驱动）；幂等键=
 * history（终态不翻案）；approve 时点版本链复核（new_version 号被 B3 直改抢占 → 409 审批作废）。
 *
 * 信用/补偿分工：C6 只出箱 PriceChangeApproved（kind 三档，G1 消费扣分/停接）——恶意频繁
 * 改价 -20/严重停接亦 G1 侧规则（credit.rules），本模块不实现扣分。补偿（R-05/D17：分母=
 * paid_amount 全额 cash+points/100）：积分经 F4 grant（COMPENSATION 真链，幂等 ref=
 * price_change:{id}，仅 has_active_group 且 DOWN 生效路径）；券经指令事件出箱（F4 ②全量=
 * M2 消费）。补偿发放 24h SLA=approve 同步直发 + 巡检位 M2（EFFECTED DOWN 历史行对照
 * points_txns 对账，简报 T9「②补验」标注）。
 */
import { Injectable, Logger } from '@nestjs/common';
import {
  AppError,
  ErrorCode,
  PRICE_CHANGE_APPROVED_TOPIC,
  PRICE_CHANGE_REJECTED_TOPIC,
  PRICE_COUPON_INSTRUCTED_TOPIC,
  PRICE_REVOKED_TOPIC,
  type PriceChangeApprovedPayload,
  type PriceChangeKind,
  type PriceChangeRejectedPayload,
  type PriceCouponInstructedPayload,
  type PriceRevokedPayload,
} from '@ljr/shared';
import type { SqlExecutor } from '../../infrastructure/sql';
import { PgPoolService } from '../../infrastructure/sql';
import { OutboxService } from '../../infrastructure/outbox/outbox.service';
import { NotifyDispatcherService } from '../notify/notify-dispatcher.service';
import { NotifyTemplateService } from '../notify/notify-template.service';
import { PointsService } from '../benefits/points.service';
import { EnrollmentService } from '../trade/enrollment.service';
import { GroupBuyService } from '../trade/group-buy.service';
import { SessionService } from '../trade/session.service';
import { PricingConfigService } from './pricing.service';
import { moneyToCents, normalizePricingWrite } from './pricing.validate';
import { classifyChange, computeCompensations } from './price-change.engine';
import type {
  ApproveInput,
  ApproveResult,
  ChangeRequestResult,
  PaidActiveEnrollment,
  PriceHistoryRow,
  PriceHistoryView,
  RevokeResult,
} from './price-change.types';
import type { PutPricingInput } from './pricing.types';

/** R-03 频率窗口（30 天 3 次，含涨降） */
const FREQ_WINDOW_DAYS = 30;
const FREQ_LIMIT = 3;
/** R-04 撤销窗（24h；谓词 created_at >= now()-24h 含端点） */
const REVOKE_WINDOW_HOURS = 24;

/** 撤销通知模板（PRD §8.2 未定义撤销话术——⚠决策位：模板 seed 归 I1 域新迁移；缺失时跳过扇出+告警日志，不阻断 R-04 主流程） */
const REVOKE_TEMPLATE = 'PRICE_REVOKED';

/** 三档 → I1 话术模板（V4 seed 逐字；R-06） */
const KIND_TEMPLATE: Record<PriceChangeKind, string> = {
  PRICE_UP: 'PRICE_UP_LOCKED',
  PRICE_DOWN_LE10: 'PRICE_DOWN_COMP',
  PRICE_DOWN_GT10: 'PRICE_DOWN_BIG',
};

interface PriceVersionBasisRow {
  readonly version: number;
  readonly per_head: string | null;
  readonly session_total: string | null;
}

interface HistoryInsertOut {
  readonly id: string;
}

/** approve 事务出参（提交后补偿直发/缓存失效的续燃上下文） */
interface ApproveEffectContext {
  readonly historyId: number;
  readonly lawyerId: number;
  readonly kind: PriceChangeKind;
  readonly hasActiveGroup: boolean;
  readonly oldCents: number;
  readonly newCents: number;
  readonly recipients: readonly PaidActiveEnrollment[];
}

@Injectable()
export class PriceChangeService {
  private readonly logger = new Logger(PriceChangeService.name);

  constructor(
    private readonly pool: PgPoolService,
    private readonly outbox: OutboxService,
    // R-W3-P 单写者：版本落版/恢复唯一经 B3 导出服务
    private readonly b3: PricingConfigService,
    // 跨模块消费全部走导出服务（C1/C2/C3/F4/I1）——禁跨 schema join（架构 §3.2 红线）
    private readonly sessions: SessionService,
    private readonly groupBuys: GroupBuyService,
    private readonly enrollments: EnrollmentService,
    private readonly points: PointsService,
    private readonly dispatcher: NotifyDispatcherService,
    private readonly templates: NotifyTemplateService,
  ) {}

  // ===========================================================================
  // §4 引擎判定主入口（§5 POST /lawyer/pricing/change；幂等键=lawyer+new_version 以 EFFECTED
  // 行为幂等面——ux_pricing_histories_lawyer_newver_effected 部分唯一索引物理兜底：一个版本号
  // 在该律师名下至多生效一次。new_version=请求时点 head+1 快照；PENDING/REJECTED 行为意图
  // 快照不阻塞后续分配，approve 时点版本链复核兜漂移）
  // ===========================================================================

  async requestChange(lawyerId: number, draft: PutPricingInput): Promise<ChangeRequestResult> {
    // 内容校验（R-01/R-02 应用双层；base_version=客户端乐观锁令牌，语义在步骤②复核）
    const normalized = normalizePricingWrite(draft);

    return this.pool.withTransaction(async (uow): Promise<ChangeRequestResult> => {
      // ① 版本分配串行化（B3 putPricing 同款 advisory lock；C6 生效路径经 B3 重入同锁无害）
      await uow.query(
        `SELECT pg_advisory_xact_lock(hashtext('pricing.price_versions:' || $1::text))`,
        [lawyerId],
      );
      // ② 基线版本（无版本可改=409；乐观锁令牌不符=409，H5/B3 先例口径）
      const cur = await uow.query<PriceVersionBasisRow>(
        `SELECT version, per_head::text AS per_head, session_total::text AS session_total
           FROM pricing.price_versions WHERE lawyer_id = $1 ORDER BY version DESC LIMIT 1`,
        [lawyerId],
      );
      const base = cur.rows[0];
      if (!base) {
        throw new AppError(
          ErrorCode.Conflict,
          `律师 ${lawyerId} 无价格版本（首配置走 B3 PUT，不在团前提），无可改基线`,
        );
      }
      if (base.version !== normalized.base_version) {
        throw new AppError(
          ErrorCode.Conflict,
          `draft.base_version 过期：当前 v${base.version}，调用方基于 v${normalized.base_version}（重取后重试）`,
        );
      }
      // ③ 计价基（per_head|session_total 二选一；模式变更非「改价」，显性拒绝）
      const oldPrice = base.per_head ?? base.session_total;
      const newPrice = normalized.per_head ?? normalized.session_total;
      if (oldPrice === null || newPrice === null || (base.per_head === null) !== (normalized.per_head === null)) {
        throw new AppError(
          ErrorCode.Conflict,
          '改价基线与新草案计价模式不一致（per_head/session_total 二选一须同侧）；模式变更不在 C6 三档矩阵语义内',
        );
      }
      const oldCents = moneyToCents(oldPrice);
      const newCents = moneyToCents(newPrice);

      // ④ 在团判定（C1/C2 导出，跨模块接口；快照进历史行=判定时点口径）
      const hasActiveGroup =
        (await this.sessions.hasActiveSessions(lawyerId)) ||
        (await this.groupBuys.hasActiveGroupBuys(lawyerId));

      // ⑤ R-01 三档判定（纯函数；同价/非正价显性 400）+ ⑥ R-03 频率 DB 滑窗（⚠W3-7）
      const classification = classifyChange(oldCents, newCents, hasActiveGroup);
      const freqExceeded = await this.countRecentChanges(uow, lawyerId) >= FREQ_LIMIT;
      const requiresApproval = freqExceeded || classification.tierRequiresApproval;
      const newVersion = base.version + 1;

      if (requiresApproval) {
        // 审批档：草案随历史行持久化（§5 approve 入参无草案；R-03 版本不可变下生效只有一次机会）
        const inserted = await uow.query<HistoryInsertOut>(
          `INSERT INTO pricing.pricing_histories
             (lawyer_id, old_version, new_version, direction, change_pct, has_active_group,
              result, credit_penalty, new_version_draft)
           VALUES ($1, $2, $3, $4, $5, $6, 'PENDING_APPROVAL', $7, $8::jsonb)
           RETURNING id`,
          [
            lawyerId,
            base.version,
            newVersion,
            classification.direction,
            classification.changePct,
            hasActiveGroup,
            classification.creditPenalty,
            JSON.stringify(normalized),
          ],
        );
        const historyId = Number(inserted.rows[0]!.id);
        return { result: 'PENDING_APPROVAL', history_id: historyId, new_version: newVersion };
      }

      // ⑦ 直效档（不在团任意方向 / 在团 UP）：版本经 B3 落版（R-W3-P）+ 历史行同事务
      const effectuated = await this.b3.createVersionFromDraftInTx(uow, lawyerId, draft);
      const inserted = await uow.query<HistoryInsertOut>(
        `INSERT INTO pricing.pricing_histories
           (lawyer_id, old_version, new_version, direction, change_pct, has_active_group,
            result, credit_penalty, new_version_draft)
         VALUES ($1, $2, $3, $4, $5, $6, 'EFFECTED', $7, $8::jsonb)
         RETURNING id`,
        [
          lawyerId,
          base.version,
          effectuated.version,
          classification.direction,
          classification.changePct,
          hasActiveGroup,
          classification.creditPenalty,
          JSON.stringify(normalized),
        ],
      );
      const historyId = Number(inserted.rows[0]!.id);

      // ⑧ 在团直效：信用事件（G1 消费 -5 档）+ 已锁定用户锁价话术（I1 真消费）。
      //    不在团自由改价不 emit（PRD §8.2 惩罚/通知两表均为在团场景——emit 将致 G1 误扣）。
      if (hasActiveGroup) {
        await this.outbox.recordOutbox(uow, {
          type: PRICE_CHANGE_APPROVED_TOPIC,
          payload: {
            price_change_id: historyId,
            lawyer_id: lawyerId,
            kind: classification.kind,
          } satisfies PriceChangeApprovedPayload,
        });
        const recipients = await this.enrollments.listActivePaidForLawyer(lawyerId);
        await this.registerTierNotifications(uow, historyId, classification.kind, recipients);
      }

      return { result: 'EFFECTED', history_id: historyId, new_version: effectuated.version };
    }).then((result) => {
      // 写后失效（提交成功后；R-W2-8——C6 落版与 B3 PUT 同纪律）
      this.b3.invalidateCurrentCache(lawyerId);
      return result;
    });
  }

  // ===========================================================================
  // §5 POST /pricing/change/{id}/approve：①期人工兜底（幂等键=history；终态不翻案）
  // ===========================================================================

  async approve(historyId: number, input: ApproveInput): Promise<ApproveResult> {
    const ctx = await this.pool.withTransaction(async (uow): Promise<ApproveEffectContext | null> => {
      const row = await this.lockHistory(uow, historyId);
      if (!row) throw new AppError(ErrorCode.NotFound, `改价历史不存在：${historyId}`);
      const lawyerId = Number(row.lawyer_id);
      // 幂等键=history：非 PENDING=已决终态，重放返回既有结果（零副作用，不翻案）
      if (row.result !== 'PENDING_APPROVAL') {
        return null;
      }

      // kind/金额精判：old 版本内容（不可变行）× 持久化草案 → 整数精确重算（存储 change_pct
      // 为三位小数审计展示位，不得用于档位判定——边界防漂移）
      const oldBasis = await this.readVersionBasis(uow, lawyerId, row.old_version);
      const draft = normalizePricingWrite(row.new_version_draft);
      const oldCents = moneyToCents(oldBasis.per_head ?? oldBasis.session_total!);
      const newCents = moneyToCents(draft.per_head ?? draft.session_total!);
      const kind = classifyChange(oldCents, newCents, true).kind;

      if (!input.approved) {
        // 否决：版本不生效；PriceChangeRejected 出箱（审计/通知扇出位）；无信用事件无补偿
        await this.outbox.recordOutbox(uow, {
          type: PRICE_CHANGE_REJECTED_TOPIC,
          payload: {
            price_change_id: historyId,
            lawyer_id: lawyerId,
            kind,
          } satisfies PriceChangeRejectedPayload,
        });
        await this.decideHistory(uow, historyId, 'REJECTED', input.approval_id);
        return null;
      }

      // 通过：版本链复核（PENDING 期间 B3 直改占号 → 409 审批作废重发起，不静默覆盖）
      const head = await this.readHeadVersion(uow, lawyerId);
      if (head !== row.new_version - 1) {
        throw new AppError(
          ErrorCode.Conflict,
          `审批作废：目标版本 v${row.new_version} 的前置链已漂移（当前 v${head}），须重新发起改价`,
        );
      }
      // R-W3-P：生效经 B3 版本服务（分配号=锁内 max+1，与 new_version 一致由复核保证）
      await this.b3.createVersionFromDraftInTx(uow, lawyerId, row.new_version_draft);
      await this.decideHistory(uow, historyId, 'EFFECTED', input.approval_id);

      // 在团才.emit 信用事件/扇出话术/补偿指令（口径同 requestChange ⑧；不在团=无受影响用户）
      if (!row.has_active_group) return null;
      await this.outbox.recordOutbox(uow, {
        type: PRICE_CHANGE_APPROVED_TOPIC,
        payload: { price_change_id: historyId, lawyer_id: lawyerId, kind },
      });
      const recipients = await this.enrollments.listActivePaidForLawyer(lawyerId);
      await this.registerTierNotifications(uow, historyId, kind, recipients);
      if (kind === 'PRICE_DOWN_GT10') {
        // 券发放指令（F4 ②全量=M2 消费；券面额/有效期 PRD 未定义，F4 ②按 H7 配置落值）
        for (const r of recipients) {
          await this.outbox.recordOutbox(uow, {
            type: PRICE_COUPON_INSTRUCTED_TOPIC,
            payload: {
              price_change_id: historyId,
              lawyer_id: lawyerId,
              user_id: r.user_id,
              coupon_kind: 'PRICE_COMP',
            } satisfies PriceCouponInstructedPayload,
          });
        }
      }
      return {
        historyId,
        lawyerId,
        kind,
        hasActiveGroup: true,
        oldCents,
        newCents,
        recipients,
      };
    });

    if (ctx && (ctx.kind === 'PRICE_DOWN_LE10' || ctx.kind === 'PRICE_DOWN_GT10')) {
      // 提交后补偿直发（F4 真链 grant COMPENSATION；幂等 ref=price_change:{id}，崩溃重放靠
      // approve 幂等短路不会重发——grant 自身幂等兜底 at-least-once 重放）。24h SLA=同步直发
      // +巡检位 M2（EFFECTED DOWN 历史行对照 points_txns 对账，简报 T9 ②补验标注）。
      const comps = computeCompensations(
        ctx.recipients.map((r) => ({ user_id: r.user_id, paidCents: r.paid_full_cents })),
        ctx.oldCents,
        ctx.newCents,
      );
      for (const c of comps) {
        await this.points.grant({
          user_id: c.user_id,
          points: c.points,
          kind: 'COMPENSATION',
          ref: `price_change:${ctx.historyId}`,
        });
      }
    }
    if (ctx) this.b3.invalidateCurrentCache(ctx.lawyerId);

    // 幂等重放/否决路径读回终态出参
    if (!ctx) {
      const row = await this.readHistory(historyId);
      if (!row) throw new AppError(ErrorCode.NotFound, `改价历史不存在：${historyId}`);
      return { history_id: historyId, result: row.result, approval_source: row.approval_source };
    }
    return { history_id: historyId, result: 'EFFECTED', approval_source: 'MANUAL' };
  }

  // ===========================================================================
  // §5 POST /pricing/change/{id}/revoke：R-04（24h 内恢复上一版本；幂等键=history；不扣信用）
  // ===========================================================================

  async revoke(historyId: number, operatorLawyerId: number): Promise<RevokeResult> {
    const restored = await this.pool.withTransaction(async (uow): Promise<number | null> => {
      const row = await this.lockHistory(uow, historyId);
      if (!row || Number(row.lawyer_id) !== operatorLawyerId) {
        // 他人行/不存在行同形 404：不暴露存在性（claims 语义面惯例）
        throw new AppError(ErrorCode.NotFound, `改价历史不存在：${historyId}`);
      }
      const lawyerId = Number(row.lawyer_id);
      // 幂等键=history：已撤销 → 短路重放（零新版本/事件）
      if (row.revoked_at !== null) return null;
      if (row.result !== 'EFFECTED') {
        throw new AppError(
          ErrorCode.Conflict,
          `改价历史 ${historyId} 非生效态（${row.result}），无可撤销对象`,
        );
      }
      // R-04 超窗（DB 时钟；谓词含端点=恰 24h 仍可撤销）
      const past = await uow.query<{ past: boolean }>(
        `SELECT (created_at < now() - make_interval(hours => $2)) AS past
           FROM pricing.pricing_histories WHERE id = $1`,
        [historyId, REVOKE_WINDOW_HOURS],
      );
      if (past.rows[0]!.past) {
        throw new AppError(
          ErrorCode.Past24h,
          `改价 ${historyId} 已超 ${REVOKE_WINDOW_HOURS}h 撤销窗口（R-04）`,
        );
      }
      // 恢复上一版本（R-W3-P：经 B3；版本不可变 → 恢复=新版本承载 old_version 内容快照）
      const r = await this.b3.restoreVersionInTx(uow, lawyerId, row.old_version);
      await uow.query(
        `UPDATE pricing.pricing_histories SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`,
        [historyId],
      );
      await this.outbox.recordOutbox(uow, {
        type: PRICE_REVOKED_TOPIC,
        payload: { price_change_id: historyId, lawyer_id: lawyerId } satisfies PriceRevokedPayload,
      });
      // 通知受影响用户（R-04）：模板在册才扇出（⚠决策位——PRD §8.2 无撤销话术，PRICE_REVOKED
      // seed 归 I1 域新迁移；缺失时跳过+告警日志，不阻断撤销主流程，台账缺位即显性）
      const recipients = await this.enrollments.listActivePaidForLawyer(lawyerId);
      if (recipients.length > 0 && (await this.templateExists(uow, REVOKE_TEMPLATE))) {
        for (const r2 of recipients) {
          await this.dispatcher.registerForEvent(uow, {
            userId: r2.user_id,
            templateCode: REVOKE_TEMPLATE,
            params: {},
            idempotencyKey: `pricing/ph-${historyId}/rev-u${r2.user_id}`,
          });
        }
      } else if (recipients.length > 0) {
        this.logger.warn(
          `改价 ${historyId} 撤销：受影响用户 ${recipients.length} 人，但模板 ${REVOKE_TEMPLATE} 未 seed（I1 域待落）——本次跳过通知扇出（⚠决策位，报告注明）`,
        );
      }
      return r.version;
    });
    if (restored !== null) {
      const row = await this.readHistory(historyId);
      if (row) this.b3.invalidateCurrentCache(Number(row.lawyer_id));
      return { history_id: historyId, status: 'REVOKED', restored_version: restored };
    }
    // 幂等重放：读回既有 revoked 事实（restored_version 取当时落版号=new_version+1 槽位不可考——
    // 返回当前 head 即恢复后版本，幂等语义=零新副作用）
    const row = await this.readHistory(historyId);
    if (!row) throw new AppError(ErrorCode.NotFound, `改价历史不存在：${historyId}`);
    const head = await this.pool
      .query<{ version: number }>(
        `SELECT version FROM pricing.price_versions WHERE lawyer_id = $1 ORDER BY version DESC LIMIT 1`,
        [row.lawyer_id],
      )
      .then((r) => r.rows[0]!.version);
    return { history_id: historyId, status: 'REVOKED', restored_version: head };
  }

  // ===========================================================================
  // §5 GET /pricing/histories?lawyer_id=：改价记录列表（新在前）
  // ===========================================================================

  async listHistories(lawyerId: number): Promise<PriceHistoryView[]> {
    if (!Number.isInteger(lawyerId) || lawyerId <= 0) {
      throw new AppError(ErrorCode.InvalidArgument, `lawyer_id 须为正整数：${String(lawyerId)}`);
    }
    const res = await this.pool.query<PriceHistoryRow>(
      `SELECT id, lawyer_id::text AS lawyer_id, old_version, new_version, direction,
              change_pct::text AS change_pct, has_active_group, result,
              approval_id::text AS approval_id, approval_source, credit_penalty,
              new_version_draft, created_at, revoked_at
         FROM pricing.pricing_histories WHERE lawyer_id = $1 ORDER BY id DESC`,
      [lawyerId],
    );
    return res.rows.map((row) => ({
      history_id: Number(row.id),
      lawyer_id: Number(row.lawyer_id),
      old_version: row.old_version,
      new_version: row.new_version,
      direction: row.direction,
      change_pct: row.change_pct,
      has_active_group: row.has_active_group,
      result: row.result,
      approval_id: row.approval_id === null ? null : Number(row.approval_id),
      approval_source: row.approval_source,
      credit_penalty: row.credit_penalty,
      created_at: new Date(row.created_at).toISOString(),
      revoked_at: row.revoked_at === null ? null : new Date(row.revoked_at).toISOString(),
    }));
  }

  // ===========================================================================
  // 内部件
  // ===========================================================================

  /** R-03 频率 DB 滑窗计数（⚠W3-7：pricing_histories lawyer+created_at 窗口；DB now() 口径） */
  private async countRecentChanges(uow: SqlExecutor, lawyerId: number): Promise<number> {
    const res = await uow.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pricing.pricing_histories
        WHERE lawyer_id = $1 AND created_at > now() - make_interval(days => $2)`,
      [lawyerId, FREQ_WINDOW_DAYS],
    );
    return res.rows[0]!.n;
  }

  /** 三档话术登记（I1 真消费：事务内幂等登记 QUEUED，下发由 dispatcher worker 承接） */
  private async registerTierNotifications(
    uow: SqlExecutor,
    historyId: number,
    kind: PriceChangeKind,
    recipients: readonly PaidActiveEnrollment[],
  ): Promise<void> {
    const templateCode = KIND_TEMPLATE[kind];
    const short = kind === 'PRICE_UP' ? 'up' : kind === 'PRICE_DOWN_LE10' ? 'down' : 'downbig';
    for (const r of recipients) {
      await this.dispatcher.registerForEvent(uow, {
        userId: r.user_id,
        templateCode,
        params: {},
        idempotencyKey: `pricing/ph-${historyId}/${short}-u${r.user_id}`,
      });
    }
  }

  private async templateExists(uow: SqlExecutor, code: string): Promise<boolean> {
    try {
      await this.templates.findByCode(uow, code);
      return true;
    } catch (e) {
      if (e instanceof AppError && e.code === ErrorCode.NotFound) return false;
      throw e;
    }
  }

  /** 历史行行锁（approve/revoke 串行化锚：幂等键=history 的并发双请求恰一生效） */
  private async lockHistory(uow: SqlExecutor, id: number): Promise<PriceHistoryRow | null> {
    const res = await uow.query<PriceHistoryRow>(
      `SELECT id, lawyer_id::text AS lawyer_id, old_version, new_version, direction,
              change_pct::text AS change_pct, has_active_group, result,
              approval_id::text AS approval_id, approval_source, credit_penalty,
              new_version_draft, created_at, revoked_at
         FROM pricing.pricing_histories WHERE id = $1 FOR UPDATE`,
      [id],
    );
    return res.rows[0] ?? null;
  }

  private async readHistory(id: number): Promise<PriceHistoryRow | null> {
    const res = await this.pool.query<PriceHistoryRow>(
      `SELECT id, lawyer_id::text AS lawyer_id, old_version, new_version, direction,
              change_pct::text AS change_pct, has_active_group, result,
              approval_id::text AS approval_id, approval_source, credit_penalty,
              new_version_draft, created_at, revoked_at
         FROM pricing.pricing_histories WHERE id = $1`,
      [id],
    );
    return res.rows[0] ?? null;
  }

  /** 终态裁决落列（result+审批归源；行锁内条件更新防并发翻案） */
  private async decideHistory(
    uow: SqlExecutor,
    id: number,
    result: 'EFFECTED' | 'REJECTED',
    approvalId: number,
  ): Promise<void> {
    const updated = await uow.query<{ id: number }>(
      `UPDATE pricing.pricing_histories
          SET result = $2, approval_id = $3, approval_source = 'MANUAL'
        WHERE id = $1 AND result = 'PENDING_APPROVAL' RETURNING id`,
      [id, result, approvalId],
    );
    if (updated.rows.length === 0) {
      throw new AppError(ErrorCode.StateStaleEntity, `改价历史 ${id} 已被并发裁决`);
    }
  }

  private async readVersionBasis(
    uow: SqlExecutor,
    lawyerId: number,
    version: number,
  ): Promise<PriceVersionBasisRow> {
    const res = await uow.query<PriceVersionBasisRow>(
      `SELECT version, per_head::text AS per_head, session_total::text AS session_total
         FROM pricing.price_versions WHERE lawyer_id = $1 AND version = $2`,
      [lawyerId, version],
    );
    const row = res.rows[0];
    if (!row) {
      throw new AppError(
        ErrorCode.InternalError,
        `基线版本不可读（不应触达）：lawyer=${lawyerId} v${version}`,
      );
    }
    return row;
  }

  private async readHeadVersion(uow: SqlExecutor, lawyerId: number): Promise<number> {
    const res = await uow.query<{ version: number }>(
      `SELECT version FROM pricing.price_versions WHERE lawyer_id = $1 ORDER BY version DESC LIMIT 1`,
      [lawyerId],
    );
    return res.rows[0]?.version ?? 0;
  }
}
