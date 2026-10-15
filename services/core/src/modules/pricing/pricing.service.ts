/**
 * B3 默认价格与1对1价格配置服务（§2/§4/§5/§8 + Task 5 简报裁决）：
 *   - 版本化配置（R-03）：修改 = INSERT version+1（version=当前最大+1），禁 UPDATE 既有版本行
 *     ——应用侧只 INSERT（迁移层另有 tg_price_versions_immutable 触发器硬禁 UPDATE/DELETE）；
 *   - 写并发：PUT 幂等键=lawyer+base_version 乐观锁（base_version ≠ 当前最大 version → 409
 *     E_CONFLICT，H5 base_version 过期先例口径）；版本分配经事务内 advisory lock 按律师串行化
 *     （并发 PUT 各算 max+1 会撞 UNIQUE(lawyer_id, version)——锁内分配，409 语义先行）；
 *   - R-04 在团修改转 C6：isInGroup 适配位（R-W2-9 本批恒 false）为 true → 409 E_IN_GROUP_CHANGE；
 *   - 事件：PriceVersionCreated{lawyer_id, version} 经 recordOutbox 与版本插入同事务
 *     （I1 参与者通知 / C6 基线 W3 消费）；C6 回流消费本批不做；
 *   - 读：当前版本 60s 进程内缓存适配位（R-W2-8，写后失效；history 不缓存）。
 *
 * 只写本 schema 的 pricing.price_versions 一表；金额一律 Money 字符串进出（NUMERIC(10,2)，
 * 禁 float——R-02 区间比较经 moneyToCents 整数换算）。
 */
import { Inject, Injectable } from '@nestjs/common';
import { AppError, ErrorCode, PRICE_VERSION_CREATED_TOPIC, isValidMoney } from '@ljr/shared';
import type { SqlExecutor } from '../../infrastructure/sql';
import { PgPoolService } from '../../infrastructure/sql';
import { OutboxService } from '../../infrastructure/outbox/outbox.service';
import { CurrentPricingCache } from './pricing.cache';
import { IN_GROUP_PROBE, type InGroupProbe } from './pricing.adapters';
import {
  ROOM_MODES,
  type CurrentPricingView,
  type OneOnOnePrices,
  type PricingConfigView,
  type PricingVersionHistoryItem,
  type PutPricingInput,
  type RoomMode,
} from './pricing.types';
import { normalizePricingWrite } from './pricing.validate';

interface PriceVersionRow {
  readonly version: number;
  readonly created_at: Date;
  readonly per_head: string | null;
  readonly session_total: string | null;
  readonly group_size: number | null;
  readonly accept_min: number | null;
  readonly accept_max: number | null;
  readonly room_modes: string[] | null;
  readonly one_on_one_prices: unknown;
}

const SELECT_COLUMNS = `version, created_at, per_head::text AS per_head, session_total::text AS session_total,
        group_size, accept_min, accept_max, room_modes, one_on_one_prices`;

@Injectable()
export class PricingConfigService {
  constructor(
    private readonly pool: PgPoolService,
    private readonly cache: CurrentPricingCache,
    private readonly outbox: OutboxService,
    // 纯 interface 无运行时类型 token，须经 Symbol 注入（module useFactory 装配；R-W2-9 适配位）
    @Inject(IN_GROUP_PROBE) private readonly inGroup: InGroupProbe,
  ) {}

  // ---------- §5 GET /lawyer/{id}/pricing：当前版本全量（60s 缓存适配位，R-W2-8） ----------

  async getCurrentPricing(lawyerId: number): Promise<CurrentPricingView> {
    this.assertLawyerId(lawyerId);
    const cached = this.cache.get<CurrentPricingView>(lawyerId);
    if (cached) return cached;
    const view = await this.readCurrent(this.pool, lawyerId);
    this.cache.set(lawyerId, view);
    return view;
  }

  // ---------- §5 GET /lawyer/{id}/pricing/history：版本列表（新在前，不缓存） ----------

  async getHistory(lawyerId: number): Promise<PricingVersionHistoryItem[]> {
    this.assertLawyerId(lawyerId);
    const res = await this.pool.query<PriceVersionRow>(
      `SELECT ${SELECT_COLUMNS} FROM pricing.price_versions
        WHERE lawyer_id = $1 ORDER BY version DESC`,
      [lawyerId],
    );
    return res.rows.map((row) => ({
      version: row.version,
      created_at: this.toIso(row.created_at),
      pricing: this.toConfigView(row),
    }));
  }

  // ---------- §5 PUT /lawyer/pricing：全量新配置（幂等键=lawyer+base_version） ----------

  async putPricing(lawyerId: number, input: PutPricingInput): Promise<CurrentPricingView> {
    this.assertLawyerId(lawyerId);
    const normalized = normalizePricingWrite(input); // R-01/R-02 应用校验层（400/422）
    // R-04/R-W2-9：在团判定适配位（本批恒 false）——true → 409 转 C6 流程（W3 接线转真）；
    // 判定置于写事务外（适配器查询不占锁；TOCTOU 收口随 W3 C6 真实现，报告注明）
    if (await this.inGroup.isInGroup(lawyerId)) {
      throw new AppError(
        ErrorCode.InGroupChange,
        `律师 ${lawyerId} 存在进行中拼团，默认价格修改须走改价引擎（C6，R-04）`,
      );
    }
    const { version, createdAt } = await this.pool.withTransaction(async (uow) => {
      // 版本分配串行化：并发 PUT 各算 max+1 会撞 UNIQUE(lawyer_id, version)——advisory
      // 事务锁按律师排队（hashtext 冲突仅造成额外串行化，无害）；锁内比对 base_version（409）
      await uow.query(
        `SELECT pg_advisory_xact_lock(hashtext('pricing.price_versions:' || $1::text))`,
        [lawyerId],
      );
      const cur = await uow.query<{ version: number }>(
        `SELECT version FROM pricing.price_versions
          WHERE lawyer_id = $1 ORDER BY version DESC LIMIT 1`,
        [lawyerId],
      );
      const currentVersion = cur.rows[0]?.version ?? 0; // 无任何版本=0（GET 读侧同口径）
      if (currentVersion !== normalized.base_version) {
        throw new AppError(
          ErrorCode.Conflict,
          `base_version 过期：当前 v${currentVersion}，调用方基于 v${normalized.base_version}（重取后重试）`,
        );
      }
      const nextVersion = currentVersion + 1;
      const inserted = await uow.query<{ created_at: Date }>(
        `INSERT INTO pricing.price_versions
           (lawyer_id, version, per_head, session_total, group_size, accept_min, accept_max,
            room_modes, one_on_one_prices)
         VALUES ($1, $2, $3::numeric, $4::numeric, $5, $6, $7, $8::varchar[], $9::jsonb)
         RETURNING created_at`,
        [
          lawyerId,
          nextVersion,
          normalized.per_head,
          normalized.session_total,
          normalized.group_size,
          normalized.accept_min,
          normalized.accept_max,
          normalized.room_modes,
          JSON.stringify(normalized.one_on_one_prices),
        ],
      );
      // §6：PriceVersionCreated 与版本插入同事务出箱（I1 参与者通知 W3 消费位）
      await this.outbox.recordOutbox(uow, {
        type: PRICE_VERSION_CREATED_TOPIC,
        payload: { lawyer_id: lawyerId, version: nextVersion },
      });
      return { version: nextVersion, createdAt: inserted.rows[0]!.created_at };
    });
    this.cache.invalidateLawyer(lawyerId); // 写后失效（提交成功后；R-W2-8）
    return {
      version,
      created_at: this.toIso(createdAt),
      pricing: {
        per_head: normalized.per_head,
        session_total: normalized.session_total,
        group_size: normalized.group_size,
        accept_min: normalized.accept_min,
        accept_max: normalized.accept_max,
        room_modes: normalized.room_modes,
        one_on_one_prices: normalized.one_on_one_prices,
      },
    };
  }

  // ---------- 内部件 ----------

  private async readCurrent(exec: SqlExecutor, lawyerId: number): Promise<CurrentPricingView> {
    const res = await exec.query<PriceVersionRow>(
      `SELECT ${SELECT_COLUMNS} FROM pricing.price_versions
        WHERE lawyer_id = $1 ORDER BY version DESC LIMIT 1`,
      [lawyerId],
    );
    const row = res.rows[0];
    if (!row) return { version: 0, created_at: null, pricing: null }; // 无任何版本=0（PUT 读侧同口径）
    return {
      version: row.version,
      created_at: this.toIso(row.created_at),
      pricing: this.toConfigView(row),
    };
  }

  /** 行 → 全量配置视图（Money/枚举防御性校验：库内值漂移显性化为 InternalError，不静默透传） */
  private toConfigView(row: PriceVersionRow): PricingConfigView {
    const oneOnOne = row.one_on_one_prices as OneOnOnePrices | null;
    if (
      !oneOnOne ||
      typeof oneOnOne !== 'object' ||
      !isValidMoney(oneOnOne.text?.per_round) ||
      !isValidMoney(oneOnOne.voice?.per_15min) ||
      !isValidMoney(oneOnOne.video?.per_15min)
    ) {
      throw new AppError(
        ErrorCode.InternalError,
        'price_versions.one_on_one_prices 形态漂移（不应触达）',
      );
    }
    if (row.per_head !== null && !isValidMoney(row.per_head)) {
      throw new AppError(ErrorCode.InternalError, `per_head 出库形态漂移：${row.per_head}`);
    }
    if (row.session_total !== null && !isValidMoney(row.session_total)) {
      throw new AppError(
        ErrorCode.InternalError,
        `session_total 出库形态漂移：${row.session_total}`,
      );
    }
    return {
      per_head: row.per_head,
      session_total: row.session_total,
      group_size: row.group_size,
      accept_min: row.accept_min,
      accept_max: row.accept_max,
      room_modes: row.room_modes === null ? null : row.room_modes.map(this.assertRoomMode),
      one_on_one_prices: oneOnOne,
    };
  }

  private assertRoomMode(value: string): RoomMode {
    if ((ROOM_MODES as readonly string[]).includes(value)) return value as RoomMode;
    throw new AppError(ErrorCode.InternalError, `room_modes 出库值越域（不应触达）：${value}`);
  }

  private toIso(value: Date): string {
    return new Date(value).toISOString();
  }

  private assertLawyerId(lawyerId: number): void {
    if (!Number.isInteger(lawyerId) || lawyerId <= 0) {
      throw new AppError(ErrorCode.InvalidArgument, `lawyerId 须为正整数：${String(lawyerId)}`);
    }
  }
}
