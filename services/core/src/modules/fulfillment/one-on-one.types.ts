/**
 * D6 1对1 服务闭环类型件（§3 领域模型 + §5 接口契约词汇；room.types/cancellation.types 同形）。
 *
 * 词汇锚：service_type 三值（deep_answer|doc_revision|strategy）与 mode 三值（text|voice|video）
 * =V47 ck 同源；status 十三值=§4 状态机全集（机器件 one-on-one.machine 钉边表）。
 *
 * 幂等键全表（F1/F2 资金面稳定可重放；本文件单点收口禁散写）：
 *   F1 预付单：ooo/o{id}/pay（createOrderInTx，biz_type='ooo'）
 *   F1 补差单：ooo/o{id}/diff（biz_type='ooo_diff'——BIZ_TYPES 既有值零扩）
 *   F2 接单超时全退：refund/po-{po}/ooo-timeout（reason OOO_TIMEOUT）
 *   F2 取消①全退：refund/po-{po}/ooo-cancel（reason OOO_CANCEL）
 *   F2 取消②③部分退：refund/po-{po}/ooo-cancel-partial（reason OOO_CANCEL——同单不可两键全退，
 *     accept 守恒入口约束：全退与部分退的键互斥，复合路径由受理面累计边界兜住）
 *   F2 实结多退：refund/po-{po}/ooo-settle（reason SETTLE_REFUND）
 */
import { AppError, ErrorCode } from '@ljr/shared';

/** §2 服务类型三值（V47 ck_ooo_service_type 同源词汇） */
export const ONE_ON_ONE_SERVICE_TYPES = ['deep_answer', 'doc_revision', 'strategy'] as const;
export type OneOnOneServiceType = (typeof ONE_ON_ONE_SERVICE_TYPES)[number];

/** §2 方式三值（V47 ck_ooo_mode 同源词汇） */
export const ONE_ON_ONE_MODES = ['text', 'voice', 'video'] as const;
export type OneOnOneMode = (typeof ONE_ON_ONE_MODES)[number];

/** §4 状态机十三值（V47 ck_ooo_status 同源词汇；边表=one-on-one.machine） */
export type OneOnOneStatus =
  | 'CREATED'
  | 'PAID'
  | 'ACCEPTED'
  | 'IN_SERVICE'
  | 'FINISHED'
  | 'SETTLING'
  | 'SETTLED'
  | 'LAWYER_TIMEOUT'
  | 'REFUNDED'
  | 'CANCELLED'
  | 'PARTIAL_REFUNDED'
  | 'REFUND_PARTIAL'
  | 'DIFF_PENDING';

/** 活跃态集（ux_ooo_active 谓词同源：服务级幂等重放锚=同房间同用户同类型活跃单唯一） */
export const ONE_ON_ONE_ACTIVE_STATUSES: readonly OneOnOneStatus[] = [
  'CREATED',
  'PAID',
  'ACCEPTED',
  'IN_SERVICE',
  'FINISHED',
  'SETTLING',
  'REFUND_PARTIAL',
  'DIFF_PENDING',
];

/** 终态集（无出边——重复操作 409 的机器面依据） */
export const ONE_ON_ONE_TERMINAL_STATUSES: readonly OneOnOneStatus[] = [
  'SETTLED',
  'LAWYER_TIMEOUT',
  'REFUNDED',
  'CANCELLED',
  'PARTIAL_REFUNDED',
];

/** voice/video 计量段长（R-01/R-04：每 15min 一段，向上取整） */
export const ONE_ON_ONE_SEGMENT_SECONDS = 900;

/** I2 job ref（OOO_* 三 job 的 refType——refId=订单 id） */
export const ONE_ON_ONE_JOB_REF_TYPE = 'one_on_one';

function assertPositiveIntNum(v: unknown, field: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0 || !Number.isSafeInteger(v)) {
    throw new AppError(ErrorCode.InvalidArgument, `${field} 须为正整数：${JSON.stringify(v)}`);
  }
  return v;
}

export function assertServiceType(v: unknown): OneOnOneServiceType {
  if (typeof v !== 'string' || !(ONE_ON_ONE_SERVICE_TYPES as readonly string[]).includes(v)) {
    throw new AppError(
      ErrorCode.InvalidArgument,
      `service_type 越域（${ONE_ON_ONE_SERVICE_TYPES.join('|')}）：${JSON.stringify(v)}`,
    );
  }
  return v as OneOnOneServiceType;
}

export function assertOneOnOneMode(v: unknown): OneOnOneMode {
  if (typeof v !== 'string' || !(ONE_ON_ONE_MODES as readonly string[]).includes(v)) {
    throw new AppError(
      ErrorCode.InvalidArgument,
      `mode 越域（${ONE_ON_ONE_MODES.join('|')}）：${JSON.stringify(v)}`,
    );
  }
  return v as OneOnOneMode;
}

export function assertPositiveIntField(v: unknown, field: string): number {
  return assertPositiveIntNum(v, field);
}

/** 非负整数（duration_seconds 计量面：0=会话开启信标——触发 IN_SERVICE 不计段） */
export function assertNonNegativeIntField(v: unknown, field: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || !Number.isSafeInteger(v)) {
    throw new AppError(ErrorCode.InvalidArgument, `${field} 须为非负整数：${JSON.stringify(v)}`);
  }
  return v;
}

/** 时长秒 → 15min 段数（向上取整；1s→1、15m→1、15m01s→2——R-04/TDD 边界口径） */
export function segmentsOfDuration(durationSeconds: number): number {
  return Math.ceil(durationSeconds / ONE_ON_ONE_SEGMENT_SECONDS);
}

// ---------------------------------------------------------------------------
// 幂等键构造/解析（头注全表单点收口）
// ---------------------------------------------------------------------------

/** F1 预付单幂等键（domain/entity/event：entity=o{orderId}） */
export function oooPayKey(orderId: number): string {
  return `ooo/o${orderId}/pay`;
}

/** F1 补差单幂等键 */
export function oooDiffKey(orderId: number): string {
  return `ooo/o${orderId}/diff`;
}

/** 从 F1 幂等键解析 D6 订单引用（非 ooo 形态键=null——消费器各归其位） */
export function parseOooOrderKey(key: string): { orderId: number; kind: 'pay' | 'diff' } | null {
  const m = /^ooo\/o(\d+)\/(pay|diff)$/.exec(key);
  return m ? { orderId: Number(m[1]), kind: m[2] as 'pay' | 'diff' } : null;
}

/** F2 接单超时全退幂等键 */
export function oooTimeoutRefundKey(paymentOrderId: number): string {
  return `refund/po-${paymentOrderId}/ooo-timeout`;
}

/** F2 取消①全退幂等键 */
export function oooCancelRefundKey(paymentOrderId: number): string {
  return `refund/po-${paymentOrderId}/ooo-cancel`;
}

/** F2 取消②③部分退幂等键（与全退键互斥——accept 守恒入口约束） */
export function oooCancelPartialRefundKey(paymentOrderId: number): string {
  return `refund/po-${paymentOrderId}/ooo-cancel-partial`;
}

/** F2 实结多退幂等键 */
export function oooSettleRefundKey(paymentOrderId: number): string {
  return `refund/po-${paymentOrderId}/ooo-settle`;
}

// ---------------------------------------------------------------------------
// 行视图与端点出入参（§5 契约词汇 snake_case）
// ---------------------------------------------------------------------------

/** one_on_one_orders 行视图（DB 读出形态：numeric::text、timestamptz→ISO） */
export interface OneOnOneOrderView {
  readonly id: number;
  readonly room_id: number;
  readonly conversation_id: number | null;
  readonly user_id: number;
  readonly lawyer_id: number;
  readonly service_type: OneOnOneServiceType;
  readonly mode: OneOnOneMode;
  readonly unit_price: string;
  readonly prepaid: string;
  readonly consumed_units: number;
  readonly settle_amount: string | null;
  readonly refund_amount: string | null;
  readonly diff_order_id: number | null;
  readonly payment_order_id: number;
  readonly status: OneOnOneStatus;
  readonly accept_deadline: string | null;
  readonly started_at: string | null;
  readonly finished_at: string | null;
  readonly settle_deadline: string | null;
  readonly created_at: string;
}

/** POST /one-on-one 入参（§5：{room_id, service_type, mode}；user_id=JWT actor） */
export interface CreateOneOnOneInput {
  readonly room_id: number;
  readonly service_type: OneOnOneServiceType;
  readonly mode: OneOnOneMode;
  readonly user_id: number;
}

/** POST /one-on-one 出参（§5：{order, payment_order}+pay_params——C3 replayResult 同形） */
export interface CreateOneOnOneResult {
  readonly order: OneOnOneOrderView;
  readonly payment_order: {
    readonly id: number;
    readonly biz_type: string;
    readonly biz_id: number;
    readonly cash_amount: string;
    readonly points_amount: number;
    readonly total: string;
    readonly status: string;
  };
  readonly pay_params: Record<string, unknown>;
  readonly deduplicated: boolean;
}

/** POST /one-on-one/{id}/finish 出参（W3-15：consumed_units 声明仅校验回执——advisory 不阻塞） */
export interface FinishOneOnOneResult {
  readonly order: OneOnOneOrderView;
  /** 声明回执比对（declared=用户声明；system=系统计量事实源；matches=是否一致） */
  readonly advisory: {
    readonly declared: number | null;
    readonly system: number;
    readonly matches: boolean;
  } | null;
}

/** POST /one-on-one/{id}/settle-confirm 出参（order=落定后回读；SETTLING 中间态可缺省） */
export interface SettleConfirmResult {
  readonly order?: OneOnOneOrderView;
  /** SETTLING=首方已录待另一方；SETTLED=双方一致已落定；DIFF_PENDING=少补挂起（补差支付后 SETTLED） */
  readonly status: 'SETTLING' | 'SETTLED' | 'DIFF_PENDING';
  readonly settled_by_default?: boolean;
  readonly deduplicated?: boolean;
}

/** POST /one-on-one/{id}/cancel 出参（§5 {refund}——refund=受理回执摘要） */
export interface CancelOneOnOneResult {
  readonly order: OneOnOneOrderView;
  readonly refund: {
    readonly kind: 'FULL' | 'PARTIAL' | 'NONE';
    readonly amount: string;
    readonly refund_id: number | null;
  };
  readonly deduplicated?: boolean;
}

/** POST /one-on-one/{id}/duration 出参（RTC 时长回调 dev 面） */
export interface RecordDurationResult {
  readonly order: OneOnOneOrderView;
  readonly segments: number;
  readonly in_service_triggered: boolean;
}
