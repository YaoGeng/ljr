/**
 * F4 备付金台账服务（②全量，M2-W2 T6）：reserve_ledgers 唯一写入面 + R-05 日终对平核心。
 *
 * 定性依据（05 §11 D1 行 ⚠W2-3）：缺席费 30% 积分资金定性=备付台账实现——全部正向积分
 * 入账（COMPENSATION/ABSENCE_SHARE/REFUND_RESTORE）逐笔 ACCRUE，核销 REDEEM_NET 减记，
 * 过期 EXPIRE_NET 净减记（04 §8 #1「到期资金归属待决策」→ 台账先按「净额记账待决策」
 * 口径实现，EXPIRE_NET 即该口径承载）。
 *
 * 记账口径（V43 头注同源，任务裁定——报告注明）：
 *   - 有符号：ACCRUE=+points/100、REDEEM_NET/EXPIRE_NET=−points/100——Σamount×100 恒等
 *     未兑付积分余额（Σaccounts.balance+frozen），R-05 1:1 对平的直接可比形态；
 *   - 单位：台账 amount=元 NUMERIC(12,2)，积分 int；换算 100:1 全程显式（SQL numeric 域
 *     精确除，禁 float）；
 *   - period=上海日（DB 钟 (now() AT TIME ZONE 'Asia/Shanghai')::date——与 03:00
 *     POINTS_EXPIRE/04:00 RESERVE_RECONCILE 的上海日切口径一致）；
 *   - ref_id（人工下钻锚，无唯一约束）：ACCRUE={points source_ref}:u{user}、REDEEM_NET=
 *     order:{支付单id}、EXPIRE_NET=expire:{yyyymmdd}:u{user}。
 *
 * 台账行不可变（只 INSERT；V43 只授 INSERT）——写入与业务流水同事务（points.service
 * insertPositive/settleRun/expireUser 各记账位），幂等由上游流水插入的 ON CONFLICT 短路
 * 承载（deduplicated 路径不落台账行）。
 *
 * 对平（§8 日终台账对平 job）：未兑付积分余额=Σ(balance+frozen)（frozen=在途核销同属
 * 未兑付——任务口径裁定）vs 台账净额 Σ(amount)×100（int 分域比较，numeric→bigint 精确）。
 * **两侧聚合+period 单条 SQL（修复环 I-2）**：两个标量子查询同语句同快照——READ COMMITTED
 * 下两条独立语句可各见不同已提交版本（台账行在两读间落库）造成假差异，合并消除该竞态。
 * 不平→告警（Logger.error 资损面显性化）+ReserveDiffFound 出箱→H3 reconciliation 工单
 * （控制者裁定：复用 reconciliation 类目=24h 硬 SLA，title 区分「备付对平差异」；经事件面
 * 建单=规避模块环 Benefits→Ticket→PricingChange→Benefits，ReconciliationDiffFound 先例
 * 同为事件面）。对平结果行=job DONE detail 承载（不建新 run 表——任务裁定，
 * RESERVE_RECONCILE recheckAnchor=reserve_ledgers 最近对平轮次即本对平的 period）。
 *
 * 悬空分成附带核对（修复环 I-3，控制者裁定——最小面挂本 executor，不动 RISK_PATROL
 * 五类）：判定流静默超 48h 的场次（AttendanceAdjudicated 留痕经基座只读面分组枚举+重放
 * ——不跨域读 fulfillment attendances）×存在到场用户×存在缺席用户×points_txns 无
 * absence:{session_id} 授予 → AbsenceShareDangling 出箱→H3 reconciliation 工单（title
 * 区分「分成悬空」，一场一工单幂等）。已知边界（报告注记）：零池（缺席者 paid 合计极小
 * 致 30% 取整为 0）/到场者零支付占比分母形态在消费器侧合法跳过发放，会被本核对检出为
 * 噪音工单（发生率极低，人工 dismissal——与 #39 收口前⑤类假阳同处置口径）。
 */
import { Injectable, Logger } from '@nestjs/common';
import {
  ABSENCE_SHARE_DANGLING_TOPIC,
  ATTENDANCE_ADJUDICATED_TOPIC,
  RESERVE_DIFF_FOUND_TOPIC,
  type AbsenceShareDanglingPayload,
  type ReserveDiffFoundPayload,
} from '@ljr/shared';
import type { SqlExecutor } from '../../infrastructure/sql';
import { OutboxService } from '../../infrastructure/outbox/outbox.service';
import { absenceSourceRef } from './points.types';

/** 台账 entry 三值（V43 ck 值域逐字） */
export type ReserveEntry = 'ACCRUE' | 'REDEEM_NET' | 'EXPIRE_NET';

/** 悬空分成检出窗口（48h：判定流（15min 窗+重试）远完成后的应发未发兜底检出锚） */
export const DANGLING_SHARE_QUIET_MS = 48 * 3_600_000;

/** 对平结果（executor 出参→job DONE detail；balanced=true 零外部动作） */
export interface ReserveReconcileResult {
  readonly period: string;
  readonly balanced: boolean;
  /** 未兑付积分余额（分；Σpoints_accounts.balance+frozen） */
  readonly points_outstanding_cents: number;
  /** 台账净额（分；Σreserve_ledgers.amount×100） */
  readonly reserve_net_cents: number;
  /** 差额（分）=outstanding−net；balanced ⇔ 0 */
  readonly diff_cents: number;
}

/** 悬空分成核对结果（executor 出参→job DONE detail） */
export interface DanglingShareResult {
  /** 本轮枚举的静默场次候选数 */
  readonly checked_sessions: number;
  /** 检出悬空（已出箱 AbsenceShareDangling）的场次数 */
  readonly dangling_sessions: number;
}

@Injectable()
export class ReserveService {
  private readonly logger = new Logger(ReserveService.name);

  constructor(private readonly outbox: OutboxService) {}

  /**
   * 台账写入（业务流水同事务位调用；幂等由上游流水 ON CONFLICT 短路承载——deduplicated
   * 路径不达此处）。points=正整数分域积分额（1 积分=1 分）；符号由 entry 决定（ACCRUE 正/
   * 两净额负）。amount 换算在 SQL numeric 域精确进行（$1::numeric/100，禁 float）。
   */
  async recordInTx(
    uow: SqlExecutor,
    entry: ReserveEntry,
    points: number,
    ref: string,
  ): Promise<void> {
    if (!Number.isInteger(points) || points <= 0) {
      // 调用位语义保证（记账额恒正分域）；违例=不变量失守显性化
      throw new Error(`备付台账记账额须为正整数（分）：entry=${entry} points=${String(points)}`);
    }
    if (typeof ref !== 'string' || ref.length === 0 || ref.length > 64) {
      throw new Error(`备付台账 ref 越域（1-64 字符）：${JSON.stringify(ref)}`);
    }
    const signed = entry === 'ACCRUE' ? points : -points;
    await uow.query(
      `INSERT INTO benefits.reserve_ledgers (period, entry, amount, ref_id)
       VALUES ((now() AT TIME ZONE 'Asia/Shanghai')::date, $1, $2::bigint::numeric / 100, $3)`,
      [entry, signed, ref],
    );
  }

  /**
   * 日终对平（RESERVE_RECONCILE 执行器核心；ctx.uow 与 job DONE 同事务）：**单条 SQL 两个
   * 标量子查询**（修复环 I-2：同语句同快照，消除 READ COMMITTED 两读竞态假差异）+period
   * 同语句推导；不平衡时告警+ReserveDiffFound 同事务出箱（事件与 DONE 标记原子——重试轮次
   * 事件至多一次可见）。空库两侧均 0=平。
   */
  async reconcile(uow: SqlExecutor): Promise<ReserveReconcileResult> {
    const res = await uow.query<{ outstanding: string; net: string; period: string }>(
      `SELECT (SELECT COALESCE(sum(balance) + sum(frozen), 0) FROM benefits.points_accounts)::bigint::text AS outstanding,
              (SELECT COALESCE(sum(amount * 100), 0) FROM benefits.reserve_ledgers)::bigint::text AS net,
              to_char((now() AT TIME ZONE 'Asia/Shanghai')::date, 'YYYY-MM-DD') AS period`,
    );
    const row = res.rows[0]!;
    const outstanding = Number(row.outstanding);
    const net = Number(row.net);
    const period = row.period;
    const diff = outstanding - net;
    if (diff === 0) {
      return {
        period,
        balanced: true,
        points_outstanding_cents: outstanding,
        reserve_net_cents: net,
        diff_cents: 0,
      };
    }
    const payload: ReserveDiffFoundPayload = {
      period,
      points_outstanding_cents: outstanding,
      reserve_net_cents: net,
      diff_cents: diff,
    };
    this.logger.error(
      `备付台账对平差异（R-05 资损面）：period=${period} 未兑付积分余额=${outstanding} 分 vs 台账净额=${net} 分（diff=${diff} 分）——已出箱 ReserveDiffFound（H3 reconciliation 工单 24h 硬 SLA）`,
    );
    await this.outbox.recordOutbox(uow, { type: RESERVE_DIFF_FOUND_TOPIC, payload });
    return {
      period,
      balanced: false,
      points_outstanding_cents: outstanding,
      reserve_net_cents: net,
      diff_cents: diff,
    };
  }

  /**
   * 悬空分成附带核对（修复环 I-3；RESERVE_RECONCILE 执行器随对平同轮）：候选=判定流静默
   * 超 48h 的场次（基座只读面分组枚举——不跨域读 fulfillment attendances）；完成门与缺席/
   * 到场判读=该场次 AttendanceAdjudicated 留痕重放（律师已判非缺席+缺席用户≥1+到场用户≥1）；
   * 悬空判据=points_txns 无 kind=ABSENCE_SHARE AND source_ref=absence:{sid} 行（本域直查）。
   * 检出→AbsenceShareDangling 出箱（与 DONE 同事务；一场一工单幂等在 H3 消费侧）。
   */
  async detectDanglingAbsenceShares(uow: SqlExecutor): Promise<DanglingShareResult> {
    const groups = await this.outbox.listEventGroupsBefore(
      uow,
      [ATTENDANCE_ADJUDICATED_TOPIC],
      'session_id',
      DANGLING_SHARE_QUIET_MS,
    );
    let dangling = 0;
    for (const g of groups) {
      const sessionId = Number(g.value);
      if (!Number.isInteger(sessionId) || sessionId <= 0) continue; // 坏载荷防御
      const events = await this.outbox.listEventsByPayload(
        uow,
        [ATTENDANCE_ADJUDICATED_TOPIC],
        'session_id',
        g.value,
      );
      let lawyerJudged = false;
      let lawyerAbsent = false;
      const absentUsers = new Set<number>();
      const attendingUsers = new Set<number>();
      for (const e of events) {
        const p = (e.payload ?? {}) as Partial<{
          owner_type: unknown;
          owner_id: unknown;
          result: unknown;
        }>;
        if (p.owner_type !== 'user' && p.owner_type !== 'lawyer') continue;
        if (typeof p.owner_id !== 'number' || !Number.isInteger(p.owner_id) || p.owner_id <= 0) {
          continue;
        }
        if (p.result !== 'normal' && p.result !== 'late' && p.result !== 'absent') continue;
        if (p.owner_type === 'lawyer') {
          lawyerJudged = true;
          lawyerAbsent = p.result === 'absent';
        } else if (p.result === 'absent') {
          absentUsers.add(p.owner_id);
        } else {
          attendingUsers.add(p.owner_id);
        }
      }
      // 律师缺席=整场全额退款路径（无 30% 池）；无缺席或无到场=无应发面——均非悬空
      if (!lawyerJudged || lawyerAbsent || absentUsers.size === 0 || attendingUsers.size === 0) {
        continue;
      }
      const granted = await uow.query<{ ok: number }>(
        `SELECT 1 AS ok FROM benefits.points_txns
          WHERE kind = 'ABSENCE_SHARE' AND source_ref = $1 LIMIT 1`,
        [absenceSourceRef(sessionId)],
      );
      if (granted.rows.length > 0) continue;
      dangling += 1;
      const payload: AbsenceShareDanglingPayload = {
        session_id: sessionId,
        absent_users: absentUsers.size,
        attending_users: attendingUsers.size,
      };
      this.logger.error(
        `缺席分成悬空（应发未发兜底检出）：session=${sessionId} 缺席 ${absentUsers.size} 人/到场 ${attendingUsers.size} 人，判定流静默超 48h 而无 ABSENCE_SHARE 授予——已出箱 AbsenceShareDangling（H3 reconciliation 工单）`,
      );
      await this.outbox.recordOutbox(uow, { type: ABSENCE_SHARE_DANGLING_TOPIC, payload });
    }
    return { checked_sessions: groups.length, dangling_sessions: dangling };
  }
}
