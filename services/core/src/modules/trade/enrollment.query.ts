/**
 * C3 报名只读查询件（同 schema 内服务，模块内部件不外泄给其他域——trade 域内 C2 cancel
 * 扩展的唯一取数缝）。独立于 EnrollmentService 存在的原因：EnrollmentService 依赖
 * SessionService/GroupBuyService（成团守卫推进位），而 GroupBuyService.cancel 依赖本查询面
 * （T5 评审 F1 交接：取消判定扩展「该 group_buy 活跃 PAID enrollment 计数=0」）——查询面
 * 只依赖连接池，斩断 service ↔ service 循环依赖（架构 §3.2 同域内服务单向依赖）。
 */
import { Injectable } from '@nestjs/common';
import type { EnrollmentRefType } from '@ljr/shared';
import type { SqlExecutor } from '../../infrastructure/sql';
import { PgPoolService } from '../../infrastructure/sql';

@Injectable()
export class EnrollmentQueryService {
  constructor(private readonly pool: PgPoolService) {}

  /**
   * 已支付（PAID）报名计数——C2 cancel「无任何已支付加入者」判定的事实源（R-W3-L 扩展，T7 接线）。
   * exec 形态（statusOf 同形先例）：成团守卫事务内计数必须传 uow——独立连接读不到本事务未提交的
   * PENDING→PAID 行（计数差一的静默正确性事故，故无缺省池形态）。
   */
  async countPaid(exec: SqlExecutor, refType: EnrollmentRefType, refId: number): Promise<number> {
    const res = await exec.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM trade.enrollments
        WHERE ref_type = $1 AND ref_id = $2 AND pay_status = 'PAID'`,
      [refType, refId],
    );
    return res.rows[0]!.n;
  }

  /** 活跃（PENDING+PAID）报名计数——join 上限（sub_max）判定口径：支付意向行同占名额（只读预检用池连接） */
  async countActive(refType: EnrollmentRefType, refId: number): Promise<number> {
    const res = await this.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM trade.enrollments
        WHERE ref_type = $1 AND ref_id = $2 AND pay_status IN ('PENDING', 'PAID')`,
      [refType, refId],
    );
    return res.rows[0]!.n;
  }
}
