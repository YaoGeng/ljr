/**
 * SQL 执行器契约与 PG 连接基座（M0-4）。
 *
 * - SqlExecutor：最小结构类型（pg Pool/PoolClient 均满足），守卫/outbox 的 uow 参数口径
 *   —— 业务事务里的 client 就是 uow，横切写入与业务写同事务。
 * - PgPoolService：NestJS 可注入连接池；连接参数与 scripts/db/lib.mjs 同口径（env 注入，密钥禁硬编码）：
 *   LJR_PG_HOST(127.0.0.1) / LJR_PG_PORT(5435) / LJR_PG_USER(postgres) / LJR_PG_PASSWORD / LJR_PG_DB(ljr_dev)。
 */
import { Injectable, Optional, type OnApplicationShutdown } from '@nestjs/common';
import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg';

/** 最小 SQL 执行器（pg Pool / PoolClient 结构兼容；测试可替换为假实现） */
export interface SqlExecutor {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<R>>;
}

export interface PgConfig {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  readonly database: string;
}

/** 与 scripts/db/lib.mjs 同口径的 env 解析（默认值=dev portable 轨） */
export function pgConfigFromEnv(env: NodeJS.ProcessEnv = process.env): PgConfig {
  return {
    host: env.LJR_PG_HOST ?? '127.0.0.1',
    port: Number(env.LJR_PG_PORT ?? 5435),
    user: env.LJR_PG_USER ?? 'postgres',
    password: env.LJR_PG_PASSWORD ?? 'ljr-dev-only',
    database: env.LJR_PG_DB ?? 'ljr_dev',
  };
}

@Injectable()
export class PgPoolService implements SqlExecutor, OnApplicationShutdown {
  readonly pool: Pool;
  /** 是否本服务自建（测试注入共享池时=false，shutdown 不越权关闭） */
  private readonly ownsPool: boolean;

  constructor(@Optional() poolOrConfig?: Pool | PgConfig) {
    // 测试可注入既有 Pool（复用连接，避免每 spec 起独立池）；缺省按 env 自建。
    this.ownsPool = !(poolOrConfig instanceof Pool);
    this.pool =
      poolOrConfig instanceof Pool ? poolOrConfig : new Pool(poolOrConfig ?? pgConfigFromEnv());
  }

  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<R>> {
    return this.pool.query<R>(text, values);
  }

  /** 事务模板：BEGIN → fn(uow) → COMMIT；异常 ROLLBACK 后原样抛出 */
  async withTransaction<T>(fn: (uow: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (e) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // 回滚失败（连接已断等）：保留原始异常
      }
      throw e;
    } finally {
      client.release();
    }
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.ownsPool) {
      await this.pool.end().catch(() => undefined);
    }
  }
}

export type { PoolClient, QueryResult, QueryResultRow };
