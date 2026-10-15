/**
 * B3 默认价格与1对1价格配置类型契约（施工规格 docs/modules/B-律师配置/B3-默认价格与1对1价格配置.md
 * §3/§5 + M1-W2 Task 5 简报裁决）。
 *
 * 边界（§1）：B3 只做版本化价格配置（INSERT-only，R-03）+ 区间校验（R-02 双层）；
 * 不做改价规则判定（C6）、价格快照（C3 支付时固化）。在团判定 isInGroup=内部适配接口
 * （R-W2-9：本批恒 false，C1/C2 W3 接线转真）；I1 参与者通知经 PriceVersionCreated 事件消费（W3）。
 */
import type { Money } from '@ljr/shared';

/** 房间沟通形式（§3 room_modes 值域：text|voice|video 多选；DB CHECK 值域 + 应用层去重/形态） */
export const ROOM_MODES = ['text', 'voice', 'video'] as const;
export type RoomMode = (typeof ROOM_MODES)[number];

/** R-02 区间（元，Money 字符串）：文字 50-300/次；语音/视频 100-500/15min（DB CHECK 同字面兜底） */
export const ONE_ON_ONE_RANGES = {
  text: { field: 'per_round', minCents: 5_000, maxCents: 30_000, label: '50-300 元/次' },
  voice: { field: 'per_15min', minCents: 10_000, maxCents: 50_000, label: '100-500 元/15min' },
  video: { field: 'per_15min', minCents: 10_000, maxCents: 50_000, label: '100-500 元/15min' },
} as const satisfies Record<
  RoomMode,
  { field: string; minCents: number; maxCents: number; label: string }
>;

/** 1对1 价格矩阵（§3 jsonb 结构；三通道全量必填——简报最小口径，报告注明） */
export interface OneOnOnePrices {
  readonly text: { readonly per_round: Money };
  readonly voice: { readonly per_15min: Money };
  readonly video: { readonly per_15min: Money };
}

/** 单个版本的全量配置（§3 契约词汇 snake_case；Money 一律字符串，禁 number/float） */
export interface PricingConfigView {
  readonly per_head: Money | null;
  readonly session_total: Money | null;
  readonly group_size: number | null;
  readonly accept_min: number | null;
  readonly accept_max: number | null;
  /** null=未配置；[]=未选择（DB 值域 CHECK 通行，应用层禁重复/越域值） */
  readonly room_modes: readonly RoomMode[] | null;
  readonly one_on_one_prices: OneOnOnePrices;
}

/** GET /lawyer/{id}/pricing 出参：{version, pricing}；无任何版本=version 0 + pricing null（自定口径，报告注明） */
export interface CurrentPricingView {
  readonly version: number;
  readonly created_at: string | null;
  readonly pricing: PricingConfigView | null;
}

/** GET /lawyer/{id}/pricing/history 条目（新版本在前，自定口径；联调 C3 快照比对的取数面） */
export interface PricingVersionHistoryItem {
  readonly version: number;
  readonly created_at: string;
  readonly pricing: PricingConfigView;
}

/** PUT /lawyer/pricing 入参（§5「全量新配置」+ base_version 乐观锁令牌；wire=snake_case） */
export interface PutPricingInput {
  /** 乐观并发令牌：与服务端当前最大 version 一致才接受（否则 409）；无任何版本=0 */
  readonly base_version: number;
  readonly per_head?: Money | null;
  readonly session_total?: Money | null;
  readonly group_size?: number | null;
  readonly accept_min?: number | null;
  readonly accept_max?: number | null;
  readonly room_modes?: readonly RoomMode[] | null;
  readonly one_on_one_prices: OneOnOnePrices;
}
