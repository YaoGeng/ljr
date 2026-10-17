/**
 * C2 C2B 拼团类型契约与分摊/值域工具（§3/§5 契约词汇 snake_case；Money=string 禁 float，架构 §1.3）。
 *
 * 金额工具复用本模块 C1 件（session.types 同域内部共享，不跨模块外泄——可剥离纪律只约束模块
 * 边界）：moneyToCents/centsToMoney/dbNumericToCents 严格两位小数字符串 ↔ 整数分，全程无浮点。
 *
 * R-02 分摊口径（⚠W3-6 裁决）：share_price = B3 默认场次总价 ÷ sub_min，NUMERIC 除法保留 2 位
 * **HALF_UP（四舍五入）**——PRD §6.3/§9.2 只定义「总价÷最低人数」无舍入规则，实现前查证无果，
 * 按简报裁决 HALF_UP 收口；模块文档 §9「银行家舍入 ⚠舍入规则实现前确认」的存疑标记由本裁决
 * 解除（任务报告偏差节注明）。非负整数分域下 HALF_UP ≡ C1「半分向上」公式：
 * floor((2×total + sub_min) / (2×sub_min))——纯整数运算无浮点，恰半向上、亚半向下。
 *
 * 列宽约束（V24）：share_price numeric(10,2)（整数位 8 位，上限=UNIT_PRICE_MAX_CENTS 复用 C1）——
 * 应用层先行 400，不让 DB 22003 漏成 500。
 */
import { AppError, ErrorCode } from '@ljr/shared';
import type { GroupBuyStatus } from './group-buy.machine';

// ---------------------------------------------------------------------------
// 金额工具（本模块 C1 件同域复用）
// ---------------------------------------------------------------------------

export {
  assertIsoDatetime,
  assertPositiveInt,
  centsToMoney,
  dbNumericToCents,
  moneyToCents,
} from './session.types';
export { UNIT_PRICE_MAX_CENTS as SHARE_PRICE_MAX_CENTS } from './session.types';
export { assertCity, DEFAULT_CITY } from './session.types';
export type { Money } from './session.types';

// ---------------------------------------------------------------------------
// R-02 分摊额：总价÷sub_min HALF_UP 到分（⚠W3-6，见头注）
// ---------------------------------------------------------------------------

/**
 * share_price 整数分解算：HALF_UP(totalCents / subMin) 到分。
 * 非负安全整数域：floor((2×total + sub_min) / (2×sub_min))——恰半（x.5 分）向上、亚半向下，
 * 与 C1 splitTotalIntoUnit 同式（C1 口径名「半分向上」=非负域 HALF_UP，任务报告注明）。
 */
export function splitShareCents(totalCents: number, subMin: number): number {
  if (
    !Number.isSafeInteger(totalCents) ||
    totalCents < 0 ||
    !Number.isSafeInteger(subMin) ||
    subMin <= 0
  ) {
    throw new AppError(ErrorCode.InternalError, '分摊入参非法（不应触达）');
  }
  return Math.floor((2 * totalCents + subMin) / (2 * subMin));
}

// ---------------------------------------------------------------------------
// 值域常量与校验（错误一律 InvalidArgument=400；值域防御在应用层，V24 头注口径）
// ---------------------------------------------------------------------------

/** 子范围人数域（对齐 C1 sessions capacity 2..50：C2B CONFIRMED 生成履约 Session 复用本表，容量须可落） */
export const GROUP_BUY_SUB_MIN = 2;
export const GROUP_BUY_SUB_MAX = 50;

/** specialty 列宽（varchar(32)；V1 仅 labor_arbitration 单专项，E3 R-04） */
export const SPECIALTY_MAX_LEN = 32;

/** 问题标签形态（E3 问题树引导多选+补充；V24 头注⑤：不设 DB 值域 CHECK 留 M2 演进位） */
export const QUESTION_TAGS_MAX_ITEMS = 20;
export const QUESTION_TAG_MAX_LEN = 64;

/** R-01 子范围值域（2..50 且 min≤max；⊆ B3 accept 范围的语义校验在服务层——需读 B3） */
export function assertSubRange(
  subMin: unknown,
  subMax: unknown,
): {
  sub_min: number;
  sub_max: number;
} {
  const min = assertSubBound(subMin, 'sub_min');
  const max = assertSubBound(subMax, 'sub_max');
  if (min > max) {
    throw new AppError(
      ErrorCode.InvalidArgument,
      `sub_min 须 ≤ sub_max（子范围）：${min} > ${max}`,
    );
  }
  return { sub_min: min, sub_max: max };
}

function assertSubBound(v: unknown, field: string): number {
  if (
    typeof v !== 'number' ||
    !Number.isInteger(v) ||
    v < GROUP_BUY_SUB_MIN ||
    v > GROUP_BUY_SUB_MAX
  ) {
    throw new AppError(
      ErrorCode.InvalidArgument,
      `${field} 须为 ${GROUP_BUY_SUB_MIN}-${GROUP_BUY_SUB_MAX} 整数（子范围人数域）：${JSON.stringify(v)}`,
    );
  }
  return v;
}

/** 问题标签形态：字符串数组（1..64 字符/项，≤20 项）；空数组放行（⚠口径：PRD 未定最少条数，报告注明） */
export function assertQuestionTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) {
    throw new AppError(
      ErrorCode.InvalidArgument,
      `question_tags 须为字符串数组：${JSON.stringify(tags)}`,
    );
  }
  if (tags.length > QUESTION_TAGS_MAX_ITEMS) {
    throw new AppError(
      ErrorCode.InvalidArgument,
      `question_tags 至多 ${QUESTION_TAGS_MAX_ITEMS} 项：${tags.length}`,
    );
  }
  return tags.map((t) => {
    if (typeof t !== 'string' || t.length === 0 || t.length > QUESTION_TAG_MAX_LEN) {
      throw new AppError(
        ErrorCode.InvalidArgument,
        `question_tags 项须为 1-${QUESTION_TAG_MAX_LEN} 字符字符串：${JSON.stringify(t)}`,
      );
    }
    return t;
  });
}

/** 专项形态：1..32 字符（值域防御在应用层；跨专项校验=M2 专项扩展随 E3 接线） */
export function assertSpecialty(v: unknown): string {
  if (typeof v !== 'string' || v.length === 0 || v.length > SPECIALTY_MAX_LEN) {
    throw new AppError(
      ErrorCode.InvalidArgument,
      `specialty 须为 1-${SPECIALTY_MAX_LEN} 字符：${JSON.stringify(v)}`,
    );
  }
  return v;
}

// ---------------------------------------------------------------------------
// §5 契约入参/出参（snake_case 逐字）
// ---------------------------------------------------------------------------

/** POST /group-buys 服务入参（initiator_id 取 JWT claims，非 body；slot_start/deadline 为 Date） */
export interface CreateGroupBuyInput {
  readonly initiator_id: number;
  readonly lawyer_id: number;
  readonly specialty: string;
  readonly slot_start: Date;
  readonly sub_min: number;
  readonly sub_max: number;
  readonly question_tags: string[];
  /** 缺省=slot_start 前 N 小时（⚠04§8-3，config.enrollDeadlineHours 默认 24） */
  readonly deadline?: Date;
}

/** 拼团行视图（DB 行读出口径：金额 Money 字符串/时间 ISO 字符串）。
 *  joined 桩=null：已加入数事实源=C3 enrollments（T7 落位经服务面取数，禁跨 schema join）——
 *  V24 头注⑥，SessionStatsView attendance_rate 同款先例，T7 接线转真。
 *  双维度列（序 11.5 V33）：specialty=发布入参；city=发布物化目标律师执业城市（缺省北京）。 */
export interface GroupBuyView {
  readonly id: number;
  readonly initiator_id: number;
  readonly lawyer_id: number;
  readonly specialty: string;
  readonly city: string;
  readonly slot_start: string;
  readonly sub_min: number;
  readonly sub_max: number;
  readonly share_price: string;
  readonly question_tags: string[];
  readonly deadline: string;
  readonly status: GroupBuyStatus;
  readonly lawyer_confirm_by: string | null;
  readonly created_at: string;
  /** 桩标注：C3 报名计数（T7 落位），本批恒 null */
  readonly joined: null;
}

/** POST /group-buys 出参（§5 逐字：{group_buy, share_price, payment_order}；share_price 顶层重述） */
export interface PublishGroupBuyResult {
  readonly group_buy: GroupBuyView;
  readonly share_price: string;
  readonly payment_order: PaymentOrderRefView;
}

/** 发起人支付单引用（F1 PaymentOrderView 发布面消费的最小集；完整单据以 F1 导出面为准） */
export interface PaymentOrderRefView {
  readonly id: number;
  readonly biz_type: string;
  readonly biz_id: number;
  readonly cash_amount: string;
  readonly total: string;
  readonly status: string;
}

/** GET /group-buys 筛选（§5 ?specialty=；公开列表仅 PUBLISHED，沿 C1 ⚠W3-12 公开面口径）。
 *  城市维（序 11.5 V33）：?city= 参与真过滤（specialty 本表列先例——与 C1 同为双维 WHERE）。 */
export interface ListGroupBuysFilter {
  readonly specialty?: string;
  readonly city?: string;
}
