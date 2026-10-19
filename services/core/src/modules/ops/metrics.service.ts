/**
 * H4 指标管道服务（M2-W2 T8）：消费面（R-03 去重+同事务聚合）+ 查询面（分组/窗口）。
 *
 * 消费面（H4 §4「Outbox 事件消费（幂等）→ 聚合 → 落日表」的形态裁定——控制者最小面）：
 *   - 消费即聚合：handler 在 relay 认领事务（uow）内先 INSERT events_consumed
 *     （ON CONFLICT event_id 短路=R-03 重放不双计唯一承载），再逐条 upsert metrics_daily
 *     增量——去重与聚合同事务，失败整体回滚不半计；**不建独立 T+1 job**（语义等同，
 *     少一个调度面；day=消费时刻上海日，重放已被去重短路无跨日漂移面）；
 *   - metrics_realtime 不建表（⚠W2-6 dev 口径）：实时面=查询时 SQL 聚合直查 metrics_daily。
 *
 * 查询面（§5 GET /admin/dashboard/metrics?group=core|health&from=&to=）：
 *   - 只读 ops.metrics_daily（owner 表）——02 §7.2「来源」列的表语义由事件承载，
 *     不跨 schema 读源表（schema-refs 0 为门；跨域真源仅补偿分母一处=pricing 导出面，
 *     patrol 检测件各域自持先例同款）；
 *   - 比率在应用层由计数器对计算（分母 0 → null 不除零；计数 0 → 0）。
 */
import { Injectable } from '@nestjs/common';
import { AppError, ErrorCode } from '@ljr/shared';
import type { SqlExecutor } from '../../infrastructure/sql';
import { PgPoolService } from '../../infrastructure/sql';
import { PriceChangeService } from '../pricing/price-change.service';
import {
  MC,
  METRIC_CATALOG,
  METRIC_STUBS,
  REVIEW_DIMS,
  type MetricGroup,
  type MetricIncrement,
  type MetricView,
  type MetricsResponse,
} from './metrics.types';

/**
 * 改价后投诉率：改价关联日窗参数——映射表未定窗长（待澄清，注记出参）。窗口=**8 自然日**
 * （工单日 D 与前 7 个自然日，即 d=0..WINDOW 天偏移全含）；代码行为已由口径用例锁定。
 */
const PRICE_CHANGE_COMPLAINT_WINDOW_DAYS = 7;

/** YYYY-MM-DD 形态（上海日界口径，lawyer-admin.http 同源校验形态） */
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** 补偿分母窗口缺省（全量）：[epoch, 9999-12-31) ——from/to 缺省时与分子口径一致 */
const UNBOUNDED_FROM = new Date(0);
const UNBOUNDED_TO = new Date('9999-12-31T00:00:00Z');

/** 4 位小数四舍五入（比率展示口径；比率非金额，不受 Money 禁 float 约束——session.stats 同款） */
function rate4(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return Math.round((numerator / denominator) * 10_000) / 10_000;
}

/** 'YYYY-MM-DD' → 上海日界 0 点时刻（窗口锚；口径=各域 stats 面同款） */
function shanghaiDayStart(date: string): Date {
  return new Date(`${date}T00:00:00+08:00`);
}

/** 日表聚合行（按 key+dim+day 聚合——投诉率日窗关联需要 day 粒度） */
interface DailyRow {
  readonly metric_key: string;
  readonly dim: string;
  readonly day: string;
  readonly total: string;
}

@Injectable()
export class MetricsService {
  constructor(
    private readonly pool: PgPoolService,
    // 补偿发放率分母真源（#39 收口后=comp_snapshots 计数）——pricing 域导出面（owner=pricing，
    // ops 侧禁跨 schema join；patrol 检测件各域自持先例同款）
    private readonly priceChange: PriceChangeService,
  ) {}

  // ===========================================================================
  // 消费面：R-03 去重 + 同事务聚合（metrics.consumer 的 handler 经 uow 调用）
  // ===========================================================================

  /**
   * 消费单事件：先插 events_consumed（冲突=event 已消费，短路返回 deduped=true——
   * R-03 重放不双计），否则逐条累加 increments 进 metrics_daily（同事务）。
   * increments 由 metrics.consumer.counterIncrementsFor 按事件载荷求值（含载荷校验）。
   */
  async applyEvent(
    exec: SqlExecutor,
    event: { readonly eventId: string; readonly topic: string },
    increments: readonly MetricIncrement[],
  ): Promise<{ deduped: boolean }> {
    const inserted = await exec.query(
      `INSERT INTO ops.events_consumed (event_id, topic) VALUES ($1, $2)
       ON CONFLICT (event_id) DO NOTHING`,
      [event.eventId, event.topic],
    );
    if ((inserted.rowCount ?? 0) === 0) {
      return { deduped: true }; // at-least-once 重投：零副作用（R-03）
    }
    for (const inc of increments) {
      await exec.query(
        `INSERT INTO ops.metrics_daily (metric_key, dim, day, value)
         VALUES ($1, $2, (now() AT TIME ZONE 'Asia/Shanghai')::date, $3::numeric)
         ON CONFLICT (metric_key, dim, day) DO UPDATE
           SET value = ops.metrics_daily.value + EXCLUDED.value, computed_at = now()`,
        [inc.key, inc.dim, inc.inc],
      );
    }
    return { deduped: false };
  }

  // ===========================================================================
  // 查询面：分组 + 窗口（§5 契约）
  // ===========================================================================

  /** 指标集查询（from/to 缺省=全量；分母 0 比率=null 不除零；日表右闭含 to） */
  async getMetrics(query: {
    readonly group: MetricGroup;
    readonly from?: string;
    readonly to?: string;
  }): Promise<MetricsResponse> {
    const from = query.from;
    const to = query.to;
    // M-2：服务层与 HTTP 层同拒（regex+Date.parse NaN 双闸同源——直达调用方与服务面口径一致）
    for (const [key, raw] of [
      ['from', from],
      ['to', to],
    ] as const) {
      if (raw === undefined) continue;
      if (!ISO_DATE_PATTERN.test(raw) || Number.isNaN(Date.parse(`${raw}T00:00:00Z`))) {
        throw new AppError(ErrorCode.InvalidArgument, `${key} 必须为 YYYY-MM-DD 形态：${raw}`);
      }
    }
    if ((from === undefined) !== (to === undefined)) {
      throw new AppError(ErrorCode.InvalidArgument, 'from/to 须成对给出（或都缺省=全量）');
    }
    if (
      from !== undefined &&
      to !== undefined &&
      Date.parse(`${to}T00:00:00Z`) < Date.parse(`${from}T00:00:00Z`)
    ) {
      throw new AppError(ErrorCode.InvalidArgument, `区间倒置（from 须 ≤ to）：${from}..${to}`);
    }

    const params: unknown[] = [];
    const where =
      from !== undefined && to !== undefined
        ? (() => {
            params.push(from, to);
            return `WHERE day >= $1::date AND day <= $2::date`; // 日表右闭含 to
          })()
        : '';
    const rows = await this.pool.query<DailyRow>(
      `SELECT metric_key, dim, to_char(day, 'YYYY-MM-DD') AS day, sum(value)::text AS total
         FROM ops.metrics_daily ${where}
        GROUP BY metric_key, dim, day`,
      params,
    );

    // 计数器速查：key+dim → 窗口内和；byKey=全域 dim('') 和（**不计切片 dim**——enrollment_paid
    // 的 user:* 切片是复购去重维度，混入即双计）；byKeyAllDims=全 dim 和（room_closed 按
    // lawyer:* 切片求和=房间总数）
    const byKeyDim = new Map<string, number>();
    const byKey = new Map<string, number>();
    const byKeyAllDims = new Map<string, number>();
    for (const r of rows.rows) {
      const v = Number(r.total);
      byKeyDim.set(
        `${r.metric_key}\u0000${r.dim}`,
        (byKeyDim.get(`${r.metric_key}\u0000${r.dim}`) ?? 0) + v,
      );
      byKeyAllDims.set(r.metric_key, (byKeyAllDims.get(r.metric_key) ?? 0) + v);
      if (r.dim === '') {
        byKey.set(r.metric_key, (byKey.get(r.metric_key) ?? 0) + v);
      }
    }
    const of = (key: string, dim = ''): number => byKeyDim.get(`${key}\u0000${dim}`) ?? 0;
    const sumOf = (key: string): number => byKey.get(key) ?? 0;
    const sumAllDims = (key: string): number => byKeyAllDims.get(key) ?? 0;

    const c = {
      gbPublished: sumOf(MC.GROUP_BUY_PUBLISHED),
      gbReached: sumOf(MC.GROUP_BUY_REACHED),
      judged: of(MC.ATTENDANCE_JUDGED, 'role:user'),
      normal: of(MC.ATTENDANCE_NORMAL, 'role:user'),
      late: of(MC.ATTENDANCE_LATE, 'role:user'),
      absent: of(MC.ATTENDANCE_ABSENT, 'role:user'),
      oooPaid: sumOf(MC.ONE_ON_ONE_PAID),
      rooms: sumAllDims(MC.ROOM_CLOSED), // room_closed 只按 lawyer:* 切片落行——全 dim 求和
      reviewCountUser: of(MC.REVIEW_SUBMITTED, 'direction:user_to_lawyer'),
      enrollmentPaid: sumOf(MC.ENROLLMENT_PAID),
      refundCompleted: sumOf(MC.REFUND_COMPLETED),
      disputeTickets: of(MC.TICKET_CREATED, 'category:dispute'),
      cancelled: sumOf(MC.SESSION_CANCELLED),
      c2bCreated: sumOf(MC.C2B_SESSION_CREATED),
      convertedCreated: sumOf(MC.CONVERTED_SESSION_CREATED),
      priceChanges: sumOf(MC.PRICE_CHANGE_APPROVED),
      compGrants: sumOf(MC.COMP_POINTS_GRANTED),
    };
    // 修复环 C-1：B2C 分列经算术推导（SessionCreated/SessionFull 载荷无 mode，C4 confirm/
    // convert 生成场次同发 SessionCreated；confirm「满员即成团」同事务再发 SessionFull）：
    //   b2cCreated = Σ(session_created) − c2b_session_created − converted_session_created
    //   b2cFull    = Σ(session_full) − c2b_session_created（每次 confirm 恰一次 SessionFull；
    //                convert 无 markFull 不发）
    // cancel_rate 分母 = Σ(session_created)（每次场次创建恰发一次本事件，天然无双计——
    // 禁再叠加 confirm/converted 计数，否则 confirm 场次双计）
    const sessionCreatedAll = sumOf(MC.SESSION_CREATED);
    const b2cCreated = sessionCreatedAll - c.c2bCreated - c.convertedCreated;
    const b2cFull = sumOf(MC.SESSION_FULL) - c.c2bCreated;

    // 复购：enrollments 按 user 去重（02 §7.2「按 user 去重时间窗」——窗口内 per-user 总和≥2）
    let paidUsers = 0;
    let repeatUsers = 0;
    for (const [k, v] of byKeyDim) {
      const sep = k.indexOf('\u0000');
      const key = k.slice(0, sep);
      const dim = k.slice(sep + 1);
      if (key === MC.ENROLLMENT_PAID && dim.startsWith('user:')) {
        paidUsers += 1;
        if (v >= 2) repeatUsers += 1;
      }
    }

    const views = new Map<string, MetricView>();
    const put = (key: string, value: number | null, stub: string | null = null): void => {
      views.set(key, { key, value, stub });
    };

    // —— 核心 7（§2/§7.2 映射表口径） ——
    put('group_buy_rate_b2c', rate4(b2cFull, b2cCreated));
    put('group_buy_rate_c2b', rate4(c.gbReached, c.gbPublished));
    // 用户发起拼团成团率：02 §7.2 与 C2B 分列同源（group_buys 状态分布=reached÷published）
    put('user_group_buy_rate', rate4(c.gbReached, c.gbPublished));
    put('attendance_rate', rate4(c.normal + c.late, c.judged));
    put('punctual_attendance_rate', rate4(c.normal, c.judged));
    put('absence_rate', rate4(c.absent, c.judged));
    put('one_on_one_conversion_rate', rate4(c.oooPaid, c.judged), METRIC_STUBS.oneOnOneConversion);
    put('lawyer_room_count', c.rooms);
    put('lawyer_room_avg_duration_min', null, METRIC_STUBS.lawyerRoomDuration);
    put('draft_adoption_rate', null, METRIC_STUBS.draftAdoption);
    // 修复环 I-1：§7.2「用户满意度」=user_to_lawyer 方向（lawyer_to_user 计数留 dim 不入均值）
    for (const dim of REVIEW_DIMS) {
      put(
        `satisfaction_avg_${dim}`,
        c.reviewCountUser === 0
          ? null
          : Math.round(
              (of(`${MC.REVIEW_DIM_SUM}${dim}`, 'direction:user_to_lawyer') / c.reviewCountUser) *
                10_000,
            ) / 10_000,
      );
    }
    put('repurchase_rate', rate4(repeatUsers, paidUsers));

    // —— 健康 11 ——
    put('dispute_rate', rate4(c.disputeTickets, c.enrollmentPaid));
    put('refund_rate', rate4(c.refundCompleted, c.enrollmentPaid));
    put('lawyer_retention_rate', null, METRIC_STUBS.lawyerRetention);
    put('room_avg_duration_min', null, METRIC_STUBS.lawyerRoomDuration);
    // 修复环 C-1：分母=Σ(session_created)（每次场次创建恰发一次——含 confirm/convert 生成场次，
    // 去双计：禁再叠加 c2b/converted 计数）
    put('cancel_rate', rate4(c.cancelled, sessionCreatedAll));
    // M-4：缺席半边与 core 条目双列必须同值（同一计数器对 absent÷judged，目录双条目注记钉住）
    put('absence_rate', rate4(c.absent, c.judged));
    put('one_on_one_satisfaction_rate', null, METRIC_STUBS.oneOnOneSatisfaction);
    put('one_on_one_dispute_rate', null, METRIC_STUBS.oneOnOneDispute);
    put('price_change_frequency', c.priceChanges);
    const compDenominator = await this.compSnapshotDenominator(from, to);
    put(
      'compensation_grant_rate',
      compDenominator === 0 ? null : rate4(c.compGrants, compDenominator),
    );
    put(
      'post_price_change_complaint_rate',
      this.postPriceChangeComplaintRate(rows.rows),
      METRIC_STUBS.postPriceChangeComplaint,
    );
    // price_stability_index：METRIC_CATALOG 注册（hidden）但不入出参——占位显式排除（04 §8 #8）

    const metrics = METRIC_CATALOG.filter((entry) => entry.group === query.group && !entry.hidden)
      .map((entry) => views.get(entry.key))
      .filter((v): v is MetricView => v !== undefined);
    return { group: query.group, from: from ?? null, to: to ?? null, metrics };
  }

  // ===========================================================================
  // 内部件
  // ===========================================================================

  /** 补偿发放率分母（comp_snapshots 计数=应补偿真源，pricing 导出面；缺省=全量窗口） */
  private async compSnapshotDenominator(from?: string, to?: string): Promise<number> {
    const start = from !== undefined ? shanghaiDayStart(from) : UNBOUNDED_FROM;
    const endExclusive =
      to !== undefined ? new Date(shanghaiDayStart(to).getTime() + 86_400_000) : UNBOUNDED_TO;
    return this.priceChange.countCompSnapshotsBetween(start, endExclusive);
  }

  /**
   * 改价后投诉率（近似口径，注记出参）：price_change 类工单按「工单日 D 与前 7 个自然日
   * 合计 8 自然日窗（d=0..WINDOW）内存在改价审批日计数」判关联；率=关联工单数÷窗口内改价
   * 审批数。日粒度关联=metrics_daily day 列可承载的最近似（映射表「改价时间窗」未定窗长
   * ——待澄清）。
   */
  private postPriceChangeComplaintRate(rows: readonly DailyRow[]): number | null {
    const approvalsByDay = new Map<string, number>();
    let approvals = 0;
    const ticketsByDay = new Map<string, number>();
    for (const r of rows) {
      const v = Number(r.total);
      if (r.metric_key === MC.PRICE_CHANGE_APPROVED && r.dim === '') {
        approvalsByDay.set(r.day, (approvalsByDay.get(r.day) ?? 0) + v);
        approvals += v;
      }
      if (r.metric_key === MC.TICKET_CREATED && r.dim === 'category:price_change') {
        ticketsByDay.set(r.day, (ticketsByDay.get(r.day) ?? 0) + v);
      }
    }
    if (approvals === 0) return null;
    let related = 0;
    for (const [day, tickets] of ticketsByDay) {
      const t = Date.parse(`${day}T00:00:00Z`);
      let inWindow = false;
      for (let d = 0; d <= PRICE_CHANGE_COMPLAINT_WINDOW_DAYS && !inWindow; d += 1) {
        const key = new Date(t - d * 86_400_000).toISOString().slice(0, 10);
        if ((approvalsByDay.get(key) ?? 0) > 0) inWindow = true;
      }
      if (inWindow) related += tickets;
    }
    return rate4(related, approvals);
  }
}
