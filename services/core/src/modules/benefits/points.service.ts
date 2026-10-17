/**
 * F4 ①切片积分服务（§4/§5/§7/§8 + Task 2 简报裁决）——C3 报名支付编排（T7）与 F2 退款（T6）
 * 消费的应用服务导出面（BenefitsModule exports 唯一入口，形态沿 F1 可剥离纪律）。
 *
 * 状态纪律（简报明示，报告口径）：points_txns.kind 是词汇表非状态机；账户无独立状态列 →
 * 不涉状态机守卫/STL——**账户余额变更走「流水不可变 + 余额行锁」纪律**（G1 流水先例）：
 * 每次账户列移动同事务留痕一行不可变流水（含 FREEZE/UNFREEZE 留痕行），行锁 SELECT…FOR UPDATE
 * 串行化同账户全部变更（§8 并发超用防线；uq(user_id,kind,source_ref) 为幂等 DB 真兜底）。
 *
 * FREEZE/UNFREEZE 留痕行（①切片口径归一，V21 头注/shared POINTS_TXN_KINDS 注同口径）：
 * §5「幂等键=order」在两表模型下若无冻结留痕则重放不可判定——冻结/解冻各留一行 delta=∓冻结额
 * 的流水行（幂等锚点+逐单审计）；余额不变量求和只计五种记账 kind（见 expiryAgg SQL），两个
 * 留痕 kind 不重复计入任一列。
 *
 * 余额不变量（应用侧维持，DB ck_balance>=0 兜底）：
 *   balance = Σdelta(COMPENSATION,ABSENCE_SHARE,REFUND_RESTORE,REDEEM,EXPIRE)
 *           = Σ授予 − Σ核销 − Σ过期；frozen 为账户列状态（ΣFREEZE 行 = ΣUNFREEZE+ΣREDEEM 行）。
 *
 * 过期语义（R-02/R-06 + 简报最小裁决，V21 头注同口径）：
 *   - 惰性路径：读/冻结时把「已过期未扣减」从可用余额剔除（纯计算，不落行）；
 *   - job 路径（POINTS_EXPIRE 执行器→expireAll/expireUser）：按用户聚合
 *     未处理过期额 = max(0, 已过期授予额 − 已消耗额)，扣 min(未处理, balance)——
 *     frozen 冻结中不过期：不足以扣的部分留在「未处理」，解冻/核销失败回 balance 后由下一轮
 *     惰性/job 路径按原 expires_at 扫走（已过期即扫，无宽限）；
 *   - FIFO 口径推导：TTL 恒定时 expires_at 随流水创建序单调（授予=时刻+TTL、还原=restore+TTL），
 *     「已过期授予额」与「已消耗额」同为 grants 序列前缀度量，聚合公式精确；
 *   - R-06 退款还原写新鲜时钟（新行 expires_at=DB now()+TTL）——原授予行已过期但已被核销时，
 *     consumed 抵消 expired_total，还原余额不被原时钟连坐（spec 用例钉死）。
 *
 * 全部过期比对走 DB 时钟（now()，credit 窗口判定同款先例）；测试以 SQL interval 夹具时间旅行。
 */
import { Inject, Injectable } from '@nestjs/common';
import {
  AppError,
  ErrorCode,
  POINTS_EXPIRED_TOPIC,
  POINTS_GRANTED_TOPIC,
  POINTS_REDEEMED_TOPIC,
  type PointsExpiredPayload,
  type PointsGrantedPayload,
  type PointsRedeemedPayload,
} from '@ljr/shared';
import type { SqlExecutor } from '../../infrastructure/sql';
import { PgPoolService } from '../../infrastructure/sql';
import { OutboxService } from '../../infrastructure/outbox/outbox.service';
import { BENEFITS_CONFIG, type BenefitsConfig } from './benefits.config';
import {
  EXPIRING_SOON_LIMIT,
  EXPIRING_SOON_WINDOW_DAYS,
  GRANT_KINDS,
  assertNonNegativeInt,
  assertPoints,
  assertPositiveInt,
  assertSourceRef,
  orderSourceRef,
  type ExpiringSoonItem,
  type FreezeInput,
  type GrantInput,
  type GrantKind,
  type OrderOpInput,
  type PointsMineView,
  type PointsMutationResult,
  type RestoreInput,
} from './points.types';

interface AccountRow {
  readonly balance: number;
  readonly frozen: number;
}

/** 每账户过期聚合（未处理过期额公式的两个输入） */
interface ExpiryAgg {
  readonly expired_total: number;
  readonly consumed_total: number;
}

interface TxnRow {
  readonly id: string;
  readonly delta: number;
}

/** 记账 kind（余额不变量求和口径；FREEZE/UNFREEZE 留痕行不参与） */
const LEDGER_GRANT_KINDS_SQL = `('COMPENSATION','ABSENCE_SHARE','REFUND_RESTORE')`;
const LEDGER_CONSUME_KINDS_SQL = `('REDEEM','EXPIRE')`;

@Injectable()
export class PointsService {
  constructor(
    private readonly pool: PgPoolService,
    private readonly outbox: OutboxService,
    // Symbol token（纯 interface 无运行时类型）：module useFactory 装配，测试构造直传
    @Inject(BENEFITS_CONFIG) private readonly config: BenefitsConfig,
  ) {}

  // ===========================================================================
  // 授予原语（正向入账；PointsGranted 生产路径；幂等键=(user_id, kind, ref)）
  // ===========================================================================

  async grant(input: GrantInput): Promise<PointsMutationResult> {
    assertPositiveInt(input.user_id, 'user_id');
    const points = assertPoints(input.points, 'points');
    if (!GRANT_KINDS.includes(input.kind as GrantKind)) {
      throw new AppError(
        ErrorCode.InvalidArgument,
        `kind 越授予值域（${GRANT_KINDS.join('|')}；REDEEM/EXPIRE/FREEZE/UNFREEZE 非授予词汇）：${String(input.kind)}`,
      );
    }
    const ref = assertSourceRef(input.ref, 'ref');
    return this.insertPositive(input.user_id, points, input.kind as GrantKind, ref);
  }

  // ===========================================================================
  // R-06 退款还原（正向入账 + 过期时钟重置；幂等键=(user_id, ref)；T6 F2 消费）
  // ===========================================================================

  async refundRestore(input: RestoreInput): Promise<PointsMutationResult> {
    assertPositiveInt(input.user_id, 'user_id');
    const points = assertPoints(input.points, 'points');
    const ref = assertSourceRef(input.ref, 'ref');
    return this.insertPositive(input.user_id, points, 'REFUND_RESTORE', ref);
  }

  /** 正向入账共用体：流水 INSERT ON CONFLICT 幂等 → 余额行锁 UPDATE → PointsGranted 同事务出箱 */
  private async insertPositive(
    userId: number,
    points: number,
    kind: GrantKind | 'REFUND_RESTORE',
    ref: string,
  ): Promise<PointsMutationResult> {
    return this.pool.withTransaction(async (uow) => {
      const account = await this.lockAccount(uow, userId);
      if (!account) {
        // lockAccount 已 upsert，此处缺失即基座异常，显性化（TS 收窄用显式守卫）
        throw new AppError(ErrorCode.InternalError, `账户 ${userId} upsert 后不可读（不应触达）`);
      }
      const inserted = await uow.query<TxnRow>(
        `INSERT INTO benefits.points_txns (user_id, delta, kind, source_ref, expires_at)
         VALUES ($1, $2, $3, $4, now() + make_interval(days => $5))
         ON CONFLICT (user_id, kind, source_ref) DO NOTHING
         RETURNING id, delta`,
        [userId, points, kind, ref, this.config.pointsTtlDays],
      );
      if (inserted.rows.length === 0) {
        // at-least-once 重放：读回比对载荷——同键同载荷短路（余额/事件不动），异载荷显性冲突
        const existing = await uow.query<TxnRow>(
          `SELECT id, delta FROM benefits.points_txns WHERE user_id = $1 AND kind = $2 AND source_ref = $3`,
          [userId, kind, ref],
        );
        const row = existing.rows[0];
        if (!row) throw new AppError(ErrorCode.InternalError, '幂等流水不可读（不应触达）');
        if (row.delta !== points) {
          throw new AppError(
            ErrorCode.Conflict,
            `幂等键 (${userId},${kind},${ref}) 已绑定 delta=${row.delta}（同键须同载荷重放）`,
          );
        }
        return { deduplicated: true, balance: account.balance, frozen: account.frozen };
      }

      const updated = await uow.query<AccountRow>(
        `UPDATE benefits.points_accounts SET balance = balance + $2, updated_at = now()
          WHERE user_id = $1 RETURNING balance, frozen`,
        [userId, points],
      );
      const after = updated.rows[0]!;
      await this.outbox.recordOutbox(uow, {
        type: POINTS_GRANTED_TOPIC,
        payload: {
          user_id: userId,
          delta: points,
          kind,
          ref,
          balance_after: after.balance,
        } satisfies PointsGrantedPayload,
      });
      return { deduplicated: false, balance: after.balance, frozen: after.frozen };
    });
  }

  // ===========================================================================
  // FREEZE（§5；幂等键=order；R-01 50% 上限在入参校验；可用余额=惰性过期口径）
  // ===========================================================================

  async freeze(input: FreezeInput): Promise<PointsMutationResult> {
    return this.freezeRun(input, (fn) => this.pool.withTransaction(fn));
  }

  /**
   * freeze 的同事务变体（M1-W3 T7 C3 消费位）：调用方在自己的业务事务内以 uow 调用——
   * C3 报名下单「enrollment+冻结+F1 下单同事务，任一失败全回滚（含冻结）」（T5
   * createOrderInTx 先例同形：校验/幂等/余额预检与 self-tx freeze 全同口径）。
   */
  async freezeInTx(uow: SqlExecutor, input: FreezeInput): Promise<PointsMutationResult> {
    return this.freezeRun(input, (fn) => fn(uow));
  }

  /** freeze 共用体（校验+冻结逻辑单点；事务边界由 run 承载——self-tx=池事务，InTx=调用方事务） */
  private freezeRun(
    input: FreezeInput,
    run: (fn: (uow: SqlExecutor) => Promise<PointsMutationResult>) => Promise<PointsMutationResult>,
  ): Promise<PointsMutationResult> {
    assertPositiveInt(input.user_id, 'user_id');
    assertPositiveInt(input.payment_order_id, 'payment_order_id');
    const points = assertPoints(input.points_to_use, 'points_to_use');
    const payable = assertNonNegativeInt(input.order_payable_cents, 'order_payable_cents');
    // R-01 单次抵扣 ≤ 订单应付 50%（int 分域：2×points ≤ payable ⇔ points ≤ floor(payable/2)；
    // 零头边界：应付 1 分 → 上限 0 → 任何抵扣拒绝）
    if (points * 2 > payable) {
      throw new AppError(
        ErrorCode.InvalidArgument,
        `R-01 单次抵扣超订单应付 50%：points_to_use=${points}（=${points * 2} 分）> floor(${payable}/2)`,
      );
    }
    const ref = orderSourceRef(input.payment_order_id);

    return run(async (uow) => {
      const account = await this.lockAccount(uow, input.user_id);
      if (!account) {
        // lockAccount 已 upsert，此处缺失即基座异常，显性化（TS 收窄用显式守卫）
        throw new AppError(
          ErrorCode.InternalError,
          `账户 ${input.user_id} upsert 后不可读（不应触达）`,
        );
      }

      // 幂等重放：同 order 留痕行在册 → 同额短路 / 异额冲突（T1 DUP 语义同源，错误码取通用冲突）
      const freezeRow = await this.findOrderTxn(uow, input.user_id, 'FREEZE', ref);
      if (freezeRow) {
        if (freezeRow.delta !== -points) {
          throw new AppError(
            ErrorCode.Conflict,
            `幂等键 order=${input.payment_order_id} 已冻结 ${-freezeRow.delta} 分（同键须同载荷重放）`,
          );
        }
        return { deduplicated: true, balance: account.balance, frozen: account.frozen };
      }

      // 可用余额预检（惰性过期口径：已过期未扣减部分不可用——§8 并发超用第一层，行锁串行化兜底）
      const agg = await this.expiryAgg(uow, input.user_id);
      const unprocessed = Math.max(0, agg.expired_total - agg.consumed_total);
      const available = account.balance - Math.min(unprocessed, account.balance);
      if (points > available) {
        throw new AppError(
          ErrorCode.InsufficientFunds,
          `积分可用余额不足：可用=${available}（物理 ${account.balance}，过期未扣 ${Math.min(unprocessed, account.balance)}）< 冻结 ${points}`,
          409,
        );
      }

      await uow.query(
        `INSERT INTO benefits.points_txns (user_id, delta, kind, source_ref)
         VALUES ($1, $2, 'FREEZE', $3)`,
        [input.user_id, -points, ref],
      );
      const updated = await uow.query<AccountRow>(
        `UPDATE benefits.points_accounts SET balance = balance - $2, frozen = frozen + $2, updated_at = now()
          WHERE user_id = $1 RETURNING balance, frozen`,
        [input.user_id, points],
      );
      const after = updated.rows[0]!;
      return { deduplicated: false, balance: after.balance, frozen: after.frozen };
    });
  }

  // ===========================================================================
  // SETTLE（§5 核销：支付成功 frozen 扣减 + REDEEM 行 + PointsRedeemed；幂等键=order）
  // ===========================================================================

  async settle(input: OrderOpInput): Promise<PointsMutationResult> {
    return this.settleRun(input, (fn) => this.pool.withTransaction(fn));
  }

  /** settle 的同事务变体（M1-W3 T7 C3 消费位）：成团守卫事务内核销（报名 PAID 与积分核销原子） */
  async settleInTx(uow: SqlExecutor, input: OrderOpInput): Promise<PointsMutationResult> {
    return this.settleRun(input, (fn) => fn(uow));
  }

  /** settle 共用体（事务边界由 run 承载，freezeRun 同形） */
  private settleRun(
    input: OrderOpInput,
    run: (fn: (uow: SqlExecutor) => Promise<PointsMutationResult>) => Promise<PointsMutationResult>,
  ): Promise<PointsMutationResult> {
    assertPositiveInt(input.user_id, 'user_id');
    assertPositiveInt(input.payment_order_id, 'payment_order_id');
    const ref = orderSourceRef(input.payment_order_id);

    return run(async (uow) => {
      const account = await this.lockAccount(uow, input.user_id);
      const freezeRow = await this.requireOrderTxn(
        uow,
        input.user_id,
        'FREEZE',
        ref,
        input.payment_order_id,
      );
      if (!account) {
        // FREEZE 留痕在册而账户行缺失：不变量失守，显性化（TS 收窄用显式守卫）
        throw new AppError(
          ErrorCode.InternalError,
          `order=${input.payment_order_id} 有 FREEZE 留痕但账户行缺失（不应触达）`,
        );
      }

      // 结局互斥（先到先定）：已解冻（支付失败已定）→ 核销冲突
      await this.rejectIfOrderTxn(uow, input.user_id, 'UNFREEZE', ref, input.payment_order_id);
      // 幂等重放
      const redeemRow = await this.findOrderTxn(uow, input.user_id, 'REDEEM', ref);
      if (redeemRow) {
        return { deduplicated: true, balance: account.balance, frozen: account.frozen };
      }

      const points = -freezeRow.delta; // 冻结额从留痕行取，调用方不重传
      if (account.frozen < points) {
        // frozen 列状态与流水序不变量失守（正常路径不可达：同账户全部变更被行锁串行化）
        throw new AppError(
          ErrorCode.InternalError,
          `frozen 列与 FREEZE 留痕不变量失守：frozen=${account.frozen} < 核销 ${points}（order=${input.payment_order_id}）`,
        );
      }

      const inserted = await uow.query<TxnRow>(
        `INSERT INTO benefits.points_txns (user_id, delta, kind, source_ref)
         VALUES ($1, $2, 'REDEEM', $3)
         ON CONFLICT (user_id, kind, source_ref) DO NOTHING
         RETURNING id, delta`,
        [input.user_id, -points, ref],
      );
      if (inserted.rows.length === 0) {
        return { deduplicated: true, balance: account.balance, frozen: account.frozen };
      }

      const updated = await uow.query<AccountRow>(
        `UPDATE benefits.points_accounts SET frozen = frozen - $2, updated_at = now()
          WHERE user_id = $1 RETURNING balance, frozen`,
        [input.user_id, points],
      );
      const after = updated.rows[0]!;
      await this.outbox.recordOutbox(uow, {
        type: POINTS_REDEEMED_TOPIC,
        payload: {
          user_id: input.user_id,
          delta: -points,
          kind: 'REDEEM',
          order_id: input.payment_order_id,
          ref,
          balance_after: after.balance,
        } satisfies PointsRedeemedPayload,
      });
      return { deduplicated: false, balance: after.balance, frozen: after.frozen };
    });
  }

  // ===========================================================================
  // UNFREEZE_POINTS（§5 解冻：支付失败 frozen→balance 原额回摆；幂等键=order；无事件）
  // ===========================================================================

  async unfreeze(input: OrderOpInput): Promise<PointsMutationResult> {
    return this.unfreezeRun(input, (fn) => this.pool.withTransaction(fn));
  }

  /**
   * unfreeze 的同事务变体（M1-W3 T7 C3 消费位）：自动退款分支/流标清场事务内解冻——幂等
   * （同 order 已解冻即 deduplicated 短路）正是「流标已解冻 + 晚到回调再解冻不双计」的守恒锚。
   */
  async unfreezeInTx(uow: SqlExecutor, input: OrderOpInput): Promise<PointsMutationResult> {
    return this.unfreezeRun(input, (fn) => fn(uow));
  }

  /** unfreeze 共用体（事务边界由 run 承载，freezeRun 同形） */
  private unfreezeRun(
    input: OrderOpInput,
    run: (fn: (uow: SqlExecutor) => Promise<PointsMutationResult>) => Promise<PointsMutationResult>,
  ): Promise<PointsMutationResult> {
    assertPositiveInt(input.user_id, 'user_id');
    assertPositiveInt(input.payment_order_id, 'payment_order_id');
    const ref = orderSourceRef(input.payment_order_id);

    return run(async (uow) => {
      const account = await this.lockAccount(uow, input.user_id);
      const freezeRow = await this.requireOrderTxn(
        uow,
        input.user_id,
        'FREEZE',
        ref,
        input.payment_order_id,
      );
      if (!account) {
        // FREEZE 留痕在册而账户行缺失：不变量失守，显性化（TS 收窄用显式守卫）
        throw new AppError(
          ErrorCode.InternalError,
          `order=${input.payment_order_id} 有 FREEZE 留痕但账户行缺失（不应触达）`,
        );
      }

      // 结局互斥：已核销（支付成功已定）→ 解冻冲突
      await this.rejectIfOrderTxn(uow, input.user_id, 'REDEEM', ref, input.payment_order_id);
      // 幂等重放
      const unfreezeRow = await this.findOrderTxn(uow, input.user_id, 'UNFREEZE', ref);
      if (unfreezeRow) {
        return { deduplicated: true, balance: account.balance, frozen: account.frozen };
      }

      const points = -freezeRow.delta;
      if (account.frozen < points) {
        throw new AppError(
          ErrorCode.InternalError,
          `frozen 列与 FREEZE 留痕不变量失守：frozen=${account.frozen} < 解冻 ${points}（order=${input.payment_order_id}）`,
        );
      }

      const inserted = await uow.query<TxnRow>(
        `INSERT INTO benefits.points_txns (user_id, delta, kind, source_ref)
         VALUES ($1, $2, 'UNFREEZE', $3)
         ON CONFLICT (user_id, kind, source_ref) DO NOTHING
         RETURNING id, delta`,
        [input.user_id, points, ref],
      );
      if (inserted.rows.length === 0) {
        return { deduplicated: true, balance: account.balance, frozen: account.frozen };
      }

      const updated = await uow.query<AccountRow>(
        `UPDATE benefits.points_accounts SET frozen = frozen - $2, balance = balance + $2, updated_at = now()
          WHERE user_id = $1 RETURNING balance, frozen`,
        [input.user_id, points],
      );
      const after = updated.rows[0]!;
      return { deduplicated: false, balance: after.balance, frozen: after.frozen };
    });
  }

  // ===========================================================================
  // GET /points/mine 数据面（§5：{balance, frozen, expiring_soon[]}；balance=惰性过期口径）
  // ===========================================================================

  async getMine(userId: number): Promise<PointsMineView> {
    assertPositiveInt(userId, 'user_id');
    const [accountRes, agg, expiring] = await Promise.all([
      this.pool.query<AccountRow>(
        'SELECT balance, frozen FROM benefits.points_accounts WHERE user_id = $1',
        [userId],
      ),
      this.pool.query<ExpiryAgg>(this.expiryAggSql(), [userId]),
      this.pool.query<{ delta: number; expires_at: Date }>(
        `SELECT delta, expires_at FROM benefits.points_txns
          WHERE user_id = $1 AND kind IN ${LEDGER_GRANT_KINDS_SQL}
            AND expires_at > now() AND expires_at <= now() + make_interval(days => $2)
          ORDER BY expires_at, id LIMIT $3`,
        [userId, EXPIRING_SOON_WINDOW_DAYS, EXPIRING_SOON_LIMIT],
      ),
    ]);
    const account = accountRes.rows[0];
    const balance = account?.balance ?? 0;
    const aggRow = agg.rows[0] ?? { expired_total: 0, consumed_total: 0 };
    const unprocessed = Math.max(0, aggRow.expired_total - aggRow.consumed_total);
    const items: ExpiringSoonItem[] = expiring.rows.map((r) => ({
      points: r.delta,
      expires_at: new Date(r.expires_at).toISOString(),
    }));
    return {
      balance: balance - Math.min(unprocessed, balance),
      frozen: account?.frozen ?? 0,
      expiring_soon: items,
    };
  }

  /**
   * 按 kind+source_ref 的流水存在性只读面（M1-W4 T1 导出加法扩展，findOrderById 同形先例）：
   * H4 资损巡检第⑤类消费——C6「EFFECTED DOWN 历史行对照积分流水对账」的 benefits 侧核对锚
   * （如 COMPENSATION × price_change:{id}）。存在性语义，不扫金额（巡检只读面，金额核对=M2 对账）。
   */
  async hasTxnOfKindRef(kind: string, ref: string): Promise<boolean> {
    if (typeof kind !== 'string' || kind.length === 0 || kind.length > 20) {
      throw new AppError(ErrorCode.InvalidArgument, `kind 越域：${JSON.stringify(kind)}`);
    }
    if (typeof ref !== 'string' || ref.length === 0 || ref.length > 64) {
      throw new AppError(ErrorCode.InvalidArgument, `ref 越域：${JSON.stringify(ref)}`);
    }
    const res = await this.pool.query<{ ok: number }>(
      `SELECT 1 AS ok FROM benefits.points_txns WHERE kind = $1 AND source_ref = $2 LIMIT 1`,
      [kind, ref],
    );
    return res.rows.length > 0;
  }

  // ===========================================================================
  // 过期 job 路径（POINTS_EXPIRE 执行器内核；惰性路径为纯计算不落行，物化扣减唯一在此）
  // ===========================================================================

  /**
   * 单用户过期扣减：行锁下扣 min(未处理过期, balance)——EXPIRE 聚合行（delta<0，expires_at/
   * source_ref 双 NULL）+ 余额扣减 + PointsExpired 同事务；无账户行/无未处理额 → {swept:0}
   * （无账户行返回 null）。执行器经 ctx.uow 与 job DONE 同事务调用；测试经池直驱。
   */
  async expireUser(uow: SqlExecutor, userId: number): Promise<{ swept: number } | null> {
    assertPositiveInt(userId, 'user_id');
    const account = await this.lockAccount(uow, userId);
    if (!account) return null;
    const agg = await this.expiryAgg(uow, userId);
    const unprocessed = Math.max(0, agg.expired_total - agg.consumed_total);
    const deduct = Math.min(unprocessed, account.balance);
    if (deduct <= 0) return { swept: 0 };

    await uow.query(
      `INSERT INTO benefits.points_txns (user_id, delta, kind, source_ref)
       VALUES ($1, $2, 'EXPIRE', NULL)`,
      [userId, -deduct],
    );
    const updated = await uow.query<AccountRow>(
      `UPDATE benefits.points_accounts SET balance = balance - $2, updated_at = now()
        WHERE user_id = $1 RETURNING balance, frozen`,
      [userId, deduct],
    );
    const after = updated.rows[0]!;
    await this.outbox.recordOutbox(uow, {
      type: POINTS_EXPIRED_TOPIC,
      payload: {
        user_id: userId,
        delta: -deduct,
        kind: 'EXPIRE',
        ref: null,
        balance_after: after.balance,
      } satisfies PointsExpiredPayload,
    });
    return { swept: deduct };
  }

  /** 批量扫（job 执行器入口）：候选=有已过期授予行的用户全集，逐用户行锁扣减 */
  async expireAll(uow: SqlExecutor): Promise<{ users_swept: number; points_expired: number }> {
    const candidates = await uow.query<{ user_id: string }>(
      `SELECT DISTINCT user_id FROM benefits.points_txns
        WHERE kind IN ${LEDGER_GRANT_KINDS_SQL} AND expires_at <= now()`,
    );
    let usersSwept = 0;
    let pointsExpired = 0;
    for (const row of candidates.rows) {
      const r = await this.expireUser(uow, Number(row.user_id));
      if (r && r.swept > 0) {
        usersSwept += 1;
        pointsExpired += r.swept;
      }
    }
    return { users_swept: usersSwept, points_expired: pointsExpired };
  }

  // ===========================================================================
  // 内部件
  // ===========================================================================

  /** 账户行锁（§8 并发超用唯一串行化点）；无行则建 0/0 行再锁（upsert） */
  private async lockAccount(uow: SqlExecutor, userId: number): Promise<AccountRow | null> {
    await uow.query(
      'INSERT INTO benefits.points_accounts (user_id) VALUES ($1) ON CONFLICT DO NOTHING',
      [userId],
    );
    const res = await uow.query<AccountRow>(
      'SELECT balance, frozen FROM benefits.points_accounts WHERE user_id = $1 FOR UPDATE',
      [userId],
    );
    return res.rows[0] ?? null;
  }

  /** 未处理过期额聚合（两输入；SQL 常量拼接口径见 LEDGER_*_KINDS_SQL 注释） */
  private expiryAggSql(): string {
    return `SELECT
        COALESCE(sum(delta) FILTER (
          WHERE kind IN ${LEDGER_GRANT_KINDS_SQL} AND expires_at <= now()), 0)::int AS expired_total,
        -COALESCE(sum(delta) FILTER (WHERE kind IN ${LEDGER_CONSUME_KINDS_SQL}), 0)::int AS consumed_total
      FROM benefits.points_txns WHERE user_id = $1`;
  }

  /** 未处理过期额聚合（两输入；SQL 常量拼接口径见 LEDGER_*_KINDS_SQL 注释）；无流水行回零值 */
  private async expiryAgg(uow: SqlExecutor, userId: number): Promise<ExpiryAgg> {
    const res = await uow.query<ExpiryAgg>(this.expiryAggSql(), [userId]);
    return res.rows[0] ?? { expired_total: 0, consumed_total: 0 };
  }

  private findOrderTxn(
    uow: SqlExecutor,
    userId: number,
    kind: 'FREEZE' | 'REDEEM' | 'UNFREEZE',
    ref: string,
  ): Promise<TxnRow | null> {
    return uow
      .query<TxnRow>(
        `SELECT id, delta FROM benefits.points_txns WHERE user_id = $1 AND kind = $2 AND source_ref = $3`,
        [userId, kind, ref],
      )
      .then((r) => r.rows[0] ?? null);
  }

  private async requireOrderTxn(
    uow: SqlExecutor,
    userId: number,
    kind: 'FREEZE' | 'REDEEM' | 'UNFREEZE',
    ref: string,
    orderId: number,
  ): Promise<TxnRow> {
    const row = await this.findOrderTxn(uow, userId, kind, ref);
    if (!row) {
      throw new AppError(ErrorCode.NotFound, `order=${orderId} 无 ${kind} 留痕（冻结在前契约）`);
    }
    return row;
  }

  private async rejectIfOrderTxn(
    uow: SqlExecutor,
    userId: number,
    kind: 'FREEZE' | 'REDEEM' | 'UNFREEZE',
    ref: string,
    orderId: number,
  ): Promise<void> {
    const row = await this.findOrderTxn(uow, userId, kind, ref);
    if (row) {
      throw new AppError(
        ErrorCode.Conflict,
        `order=${orderId} 结局互斥冲突：已存在 ${kind} 留痕（§5 幂等键=order，先到先定）`,
      );
    }
  }
}
