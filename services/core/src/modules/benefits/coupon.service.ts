/**
 * F4 券服务（②全量，M2-W2 T6）：消费 PRICE_COUPON_INSTRUCTED（C6 W3 已出箱）落
 * coupon_grants ACTIVE + CouponGranted 出箱；到期 EXPIRED 双路径（惰性读时翻转+日扫周期槽）；
 * 核销最小面（C3 联动预留接口：USED 翻转幂等，不做完整下单编排——dev 期支付直接成功口径）。
 *
 * 券定义解析（计划 T6 行口径，任务裁定——报告注明）：H7 规则中心 rule_key=
 * 'coupon.price_comp' 现行版（content={face_value, validity_days}）优先；无现行版回退
 * V43 seed 行（PRICE_COMP 券 id=1，面额 50.00/有效期 90 天 ⚠PRD 未定义待产品拍板）。
 * face_value 为发放时点快照（CouponGranted 载荷携带；表无面额列——A.3 蓝图逐列），
 * /coupons/mine 展示值=定义行当前值（定义后续变更不回溯已发券的到期时刻）。
 *
 * 幂等：UNIQUE(source, source_ref) DB 兜底（source_ref=price_change:{id}:u{user}——
 * shared PriceCouponInstructedPayload 幂等锚=(price_change_id, user_id)）；冲突路径
 * 读回同键行短路（无新行无新事件）。
 *
 * 状态纪律：ACTIVE→USED/EXPIRED 全经 COUPON_MACHINE 守卫+STL（entity_type='coupon_grant'，
 * M2-W2 计划全局约束明列）；INSERT status='ACTIVE' 非迁移无需守卫（demo/ticket 同口径）。
 * 周期到期扫描共用 POINTS_EXPIRE 日扫槽（F4 日维护同槽，I2 目录零增量裁定沿附录 A.2
 * 精神——报告注明）。
 */
import { Injectable } from '@nestjs/common';
import {
  AppError,
  COUPON_GRANTED_TOPIC,
  ErrorCode,
  assertMoney,
  type CouponGrantedPayload,
} from '@ljr/shared';
import type { SqlExecutor } from '../../infrastructure/sql';
import { PgPoolService } from '../../infrastructure/sql';
import { OutboxService } from '../../infrastructure/outbox/outbox.service';
import { StateTransitionGuardService } from '../../infrastructure/state-machine/state-transition-guard.service';
import { RuleCenterService } from '../ops/rule-center.service';
import { COUPON_MACHINE, type CouponStatus } from './coupon.machine';
import {
  COUPON_PRICE_COMP_RULE_KEY,
  PRICE_COMP_COUPON_ID,
  type CouponDefinition,
  type CouponGrantView,
  type GrantCouponResult,
  type GrantPriceCompInput,
  type RedeemCouponInput,
  type RedeemCouponResult,
} from './coupon.types';

interface CouponGrantRow {
  readonly id: string;
  readonly user_id: string;
  readonly coupon_id: string;
  readonly status: string;
  readonly granted_at: Date;
  readonly used_at: Date | null;
  readonly expires_at: Date;
  readonly face_value: string;
}

/** 行读取基（同 schema join 定义行取面额；命名列避免歧义） */
const GRANT_SELECT = `SELECT g.id, g.user_id, g.coupon_id, g.status, g.granted_at, g.used_at,
       g.expires_at, c.face_value::text AS face_value
  FROM benefits.coupon_grants g JOIN benefits.coupons c ON c.id = g.coupon_id`;

function toView(row: CouponGrantRow): CouponGrantView {
  return {
    id: Number(row.id),
    coupon_id: Number(row.coupon_id),
    face_value: row.face_value,
    status: row.status as CouponStatus,
    granted_at: new Date(row.granted_at).toISOString(),
    used_at: row.used_at === null ? null : new Date(row.used_at).toISOString(),
    expires_at: new Date(row.expires_at).toISOString(),
  };
}

@Injectable()
export class CouponService {
  constructor(
    private readonly pool: PgPoolService,
    private readonly outbox: OutboxService,
    private readonly guard: StateTransitionGuardService,
    private readonly rules: RuleCenterService,
  ) {}

  // ===========================================================================
  // 券定义解析（H7 现行版优先 → V43 seed 行回退）
  // ===========================================================================

  /** H7 content 面额/有效期解析（结构违例=规则侧脏数据显性化，不静默回退 seed） */
  private parseRuleContent(content: Record<string, unknown>): {
    faceValue: string;
    validityDays: number;
  } | null {
    if (!('face_value' in content) || !('validity_days' in content)) return null;
    const face = content['face_value'];
    const days = content['validity_days'];
    if (typeof face !== 'string' || typeof days !== 'number') return null;
    const faceValue = assertMoney(face); // 越式抛 400（规则侧发布口径违例显性化）
    if (!Number.isInteger(days) || days <= 0 || days > 36_500) {
      throw new AppError(
        ErrorCode.ConfigInvalid,
        `规则 ${COUPON_PRICE_COMP_RULE_KEY} validity_days 越域（1-36500 整数）：${String(days)}`,
      );
    }
    return { faceValue, validityDays: days };
  }

  /**
   * PRICE_COMP 券定义（H7 coupon.price_comp 现行版优先；缺省回退 seed 行——缺失显性化）。
   * 取数=snapshotAt(行为时快照，D4 cancel.matrix 同款先例——不走 currentVersion 进程缓存：
   * 发放是行为时点口径且测试需即时可见）。
   */
  async resolvePriceCompDefinition(): Promise<CouponDefinition> {
    const rule = await this.rules.snapshotAt(COUPON_PRICE_COMP_RULE_KEY, new Date());
    if (rule) {
      const parsed = this.parseRuleContent(rule.content);
      if (parsed) {
        return {
          couponId: PRICE_COMP_COUPON_ID,
          faceValue: parsed.faceValue,
          validityDays: parsed.validityDays,
        };
      }
    }
    const res = await this.pool.query<{ face_value: string; validity_days: number }>(
      `SELECT face_value::text AS face_value, validity_days FROM benefits.coupons WHERE id = $1`,
      [PRICE_COMP_COUPON_ID],
    );
    const row = res.rows[0];
    if (!row) {
      throw new AppError(
        ErrorCode.ConfigInvalid,
        `PRICE_COMP 券定义不可读（V43 seed 行 id=${PRICE_COMP_COUPON_ID} 缺失）——先跑迁移`,
      );
    }
    return {
      couponId: PRICE_COMP_COUPON_ID,
      faceValue: row.face_value,
      validityDays: row.validity_days,
    };
  }

  // ===========================================================================
  // 发放（PRICE_COUPON_INSTRUCTED 消费核心；幂等=UNIQUE(source, source_ref)）
  // ===========================================================================

  /**
   * 券指令落账（自持事务——ticket.consumer 先例：效果幂等由 DB 部分唯一约束兜底，不依赖
   * relay 认领事务）：ACTIVE 行 + CouponGranted 同事务出箱；同键重放读回短路零副作用。
   */
  async grantPriceComp(input: GrantPriceCompInput): Promise<GrantCouponResult> {
    if (!Number.isInteger(input.price_change_id) || input.price_change_id <= 0) {
      throw new AppError(
        ErrorCode.InvalidArgument,
        `price_change_id 须为正整数：${String(input.price_change_id)}`,
      );
    }
    if (!Number.isInteger(input.user_id) || input.user_id <= 0) {
      throw new AppError(ErrorCode.InvalidArgument, `user_id 须为正整数：${String(input.user_id)}`);
    }
    const def = await this.resolvePriceCompDefinition();
    const sourceRef = `price_change:${input.price_change_id}:u${input.user_id}`;
    return this.pool.withTransaction(async (uow) => {
      const inserted = await uow.query<CouponGrantRow>(
        `INSERT INTO benefits.coupon_grants (coupon_id, user_id, source, source_ref, status, expires_at)
         VALUES ($1, $2, 'price_compensation', $3, 'ACTIVE',
                 now() + make_interval(days => $4))
         ON CONFLICT (source, source_ref) DO NOTHING
         RETURNING id, user_id, coupon_id, status, granted_at, used_at, expires_at,
                   $5::text AS face_value`,
        [def.couponId, input.user_id, sourceRef, def.validityDays, def.faceValue],
      );
      if (inserted.rows.length === 0) {
        // at-least-once 重放：同键读回（source_ref 内含 user——同键即同人同指令，无载荷歧义）
        const existing = await uow.query<CouponGrantRow>(
          `${GRANT_SELECT} WHERE g.source = 'price_compensation' AND g.source_ref = $1`,
          [sourceRef],
        );
        const row = existing.rows[0];
        if (!row) throw new AppError(ErrorCode.InternalError, '券幂等行不可读（不应触达）');
        return { deduplicated: true, grant: toView(row) };
      }
      const row = inserted.rows[0]!;
      await this.outbox.recordOutbox(uow, {
        type: COUPON_GRANTED_TOPIC,
        payload: {
          grant_id: Number(row.id),
          user_id: input.user_id,
          coupon_id: def.couponId,
          face_value: def.faceValue,
          expires_at: new Date(row.expires_at).toISOString(),
        } satisfies CouponGrantedPayload,
      });
      return { deduplicated: false, grant: toView(row) };
    });
  }

  // ===========================================================================
  // GET /coupons/mine（§5 券列表；惰性到期=读时翻转 ACTIVE→EXPIRED）
  // ===========================================================================

  async listMine(userId: number): Promise<readonly CouponGrantView[]> {
    if (!Number.isInteger(userId) || userId <= 0) {
      throw new AppError(ErrorCode.InvalidArgument, `user_id 须为正整数：${String(userId)}`);
    }
    await this.expireDueOfUser(userId);
    const res = await this.pool.query<CouponGrantRow>(
      `${GRANT_SELECT} WHERE g.user_id = $1 ORDER BY g.id DESC`,
      [userId],
    );
    return res.rows.map(toView);
  }

  /** 用户维度惰性到期（守卫+STL 逐行；事务内条件更新兜底并发） */
  private async expireDueOfUser(userId: number): Promise<void> {
    await this.pool.withTransaction(async (uow) => {
      const due = await uow.query<{ id: string }>(
        `SELECT id FROM benefits.coupon_grants
          WHERE user_id = $1 AND status = 'ACTIVE' AND expires_at <= now() ORDER BY id`,
        [userId],
      );
      for (const row of due.rows) {
        await this.expireGrantRow(uow, Number(row.id));
      }
    });
  }

  /** 周期到期扫描（POINTS_EXPIRE 日扫槽位调用；返回翻转行数） */
  async sweepExpired(uow: SqlExecutor): Promise<{ coupons_expired: number }> {
    const due = await uow.query<{ id: string }>(
      `SELECT id FROM benefits.coupon_grants WHERE status = 'ACTIVE' AND expires_at <= now() ORDER BY id`,
    );
    let expired = 0;
    for (const row of due.rows) {
      if (await this.expireGrantRow(uow, Number(row.id))) expired += 1;
    }
    return { coupons_expired: expired };
  }

  /** ACTIVE→EXPIRED 唯一写点（守卫+STL+条件更新；false=已并发翻转/终态） */
  private async expireGrantRow(uow: SqlExecutor, grantId: number): Promise<boolean> {
    await this.guard.assertTransition(COUPON_MACHINE, {
      entityId: grantId,
      from: 'ACTIVE',
      to: 'EXPIRED',
      reason: 'coupon_expired',
      uow,
    });
    const updated = await uow.query<{ id: string }>(
      `UPDATE benefits.coupon_grants SET status = 'EXPIRED'
        WHERE id = $1 AND status = 'ACTIVE' RETURNING id`,
      [grantId],
    );
    return (updated.rowCount ?? 0) > 0;
  }

  // ===========================================================================
  // 核销最小面（C3 联动预留接口位：USED 翻转幂等；不做完整下单编排）
  // ===========================================================================

  /**
   * 券核销（调用方业务事务内）：ACTIVE→USED（守卫+STL，reason 承载 order_ref 审计）；
   * 已 USED=幂等重放短路（deduplicated）；EXPIRED=409；**过期未扫的 ACTIVE 行（惰性/周期
   * 翻转尚未触达）同样 409 拒核销**（修复环 I-1：expires_at<=now() 显式守卫——与 EXPIRED
   * 分支同语义，过期券不得经核销路径复活）；非属主=403；无行=404。
   */
  async redeemInTx(uow: SqlExecutor, input: RedeemCouponInput): Promise<RedeemCouponResult> {
    if (!Number.isInteger(input.grant_id) || input.grant_id <= 0) {
      throw new AppError(
        ErrorCode.InvalidArgument,
        `grant_id 须为正整数：${String(input.grant_id)}`,
      );
    }
    if (!Number.isInteger(input.user_id) || input.user_id <= 0) {
      throw new AppError(ErrorCode.InvalidArgument, `user_id 须为正整数：${String(input.user_id)}`);
    }
    if (typeof input.order_ref !== 'string' || input.order_ref.length === 0) {
      throw new AppError(ErrorCode.InvalidArgument, 'order_ref 须为非空字符串');
    }
    const found = await uow.query<CouponGrantRow>(
      `${GRANT_SELECT} WHERE g.id = $1 FOR UPDATE OF g`,
      [input.grant_id],
    );
    const row = found.rows[0];
    if (!row) {
      throw new AppError(ErrorCode.NotFound, `券发放不存在：${input.grant_id}`);
    }
    if (Number(row.user_id) !== input.user_id) {
      throw new AppError(
        ErrorCode.RoleForbidden,
        `用户 ${input.user_id} 非券 ${input.grant_id} 属主，不可核销`,
      );
    }
    const status = row.status as CouponStatus;
    if (status === 'USED') {
      return { deduplicated: true, grant: toView(row) };
    }
    if (status === 'EXPIRED' || (status === 'ACTIVE' && row.expires_at.getTime() <= Date.now())) {
      // I-1：过期判定双半边——已扫 EXPIRED 行 + 过期未扫 ACTIVE 行（惰性/日扫翻转未触达，
      // 核销时点显式守卫拒绝；不在此翻状态——抛错回滚，翻转归读路径/日扫）
      throw new AppError(ErrorCode.Conflict, `券 ${input.grant_id} 已过期，不可核销`);
    }
    await this.guard.assertTransition(COUPON_MACHINE, {
      entityId: input.grant_id,
      from: 'ACTIVE',
      to: 'USED',
      reason: `redeem:${input.order_ref}`,
      uow,
    });
    const updated = await uow.query<CouponGrantRow>(
      `UPDATE benefits.coupon_grants SET status = 'USED', used_at = now()
        WHERE id = $1 AND status = 'ACTIVE'
        RETURNING id, user_id, coupon_id, status, granted_at, used_at, expires_at,
                  (SELECT face_value::text FROM benefits.coupons WHERE id = benefits.coupon_grants.coupon_id) AS face_value`,
      [input.grant_id],
    );
    const after = updated.rows[0];
    if (!after) {
      throw new AppError(ErrorCode.StateStaleEntity, `券 ${input.grant_id} 已被并发核销/翻转`);
    }
    return { deduplicated: false, grant: toView(after) };
  }
}
