/**
 * 交易/身份状态文案映射表（M3-W1 T3 建/T4 扩展）：报名支付单、拼团、报名支付状态、退款态、
 * 实名、训练授权的枚举 → 用户可读文案，单一事实源（纪律：状态文案映射表禁散写三元；
 * 视图层一律经本件取文案）。
 *
 * - 状态集=各 core 状态机实文（payment.machine / group-buy.machine / enrollment.machine /
 *   EnrollmentRefundStatus / A2 §4 / consent §4）；
 * - 未知值回退显示原码（fail-visible，不吞不编）；
 * - tone=徽标色调档（复用 session-card TONE 映射口径）：open 进行前/grouped 成团链/
 *   live 进行链/finished 终态/failed 失败链。
 */
import type { GroupBuyStatus } from './group-buys';
import type { RealnameStatus } from './realname';
import type { TrainingConsentStatus } from './consents';

export type TradeStatusTone = 'open' | 'grouped' | 'live' | 'finished' | 'failed';

export interface TradeStatusCopy {
  readonly label: string;
  readonly tone: TradeStatusTone;
}

// ---------------------------------------------------------------------------
// F1 支付单状态（payment.machine 七态）
// ---------------------------------------------------------------------------

const PAY_ORDER_STATUS_COPY: Readonly<Record<string, TradeStatusCopy>> = {
  CREATED: { label: '待支付', tone: 'open' },
  FROZEN: { label: '支付成功 · 冻结中', tone: 'grouped' },
  PAID: { label: '已支付', tone: 'grouped' },
  REFUNDING: { label: '退款中', tone: 'failed' },
  REFUNDED: { label: '已退款', tone: 'finished' },
  SPLIT: { label: '已分账', tone: 'finished' },
  CLOSED: { label: '已关单', tone: 'finished' },
};

export function payOrderStatusCopy(status: string): TradeStatusCopy {
  return PAY_ORDER_STATUS_COPY[status] ?? { label: status, tone: 'finished' };
}

// ---------------------------------------------------------------------------
// C2 拼团状态（group-buy.machine 八态，C2 §4）
// ---------------------------------------------------------------------------

const GROUP_BUY_STATUS_COPY: Readonly<Record<GroupBuyStatus, TradeStatusCopy>> = {
  PUBLISHED: { label: '拼团中', tone: 'open' },
  REACHED: { label: '已成团 · 待律师确认', tone: 'grouped' },
  PENDING_LAWYER: { label: '待律师确认（12h）', tone: 'grouped' },
  CONFIRMED: { label: '已确认 · 生成履约场次', tone: 'grouped' },
  CONVERTED: { label: '律师已认领转化', tone: 'grouped' },
  EXPIRED: { label: '已流标 · 退款', tone: 'failed' },
  REFUNDED: { label: '已退款', tone: 'finished' },
  REJECTED: { label: '律师未接 · 退款', tone: 'failed' },
};

export function groupBuyStatusCopy(status: string): TradeStatusCopy {
  return GROUP_BUY_STATUS_COPY[status as GroupBuyStatus] ?? { label: status, tone: 'finished' };
}

// ---------------------------------------------------------------------------
// C2 拼团状态 · 律师视角（M3-W2 T4：接单大厅/认领转化语境——与上方用户视角表并列；
// PENDING_LAWYER=live 焦点档=大厅主操作位，REJECTED=failed 危险档（信用 -5 链））
// ---------------------------------------------------------------------------

const LAWYER_GROUP_BUY_STATUS_COPY: Readonly<Record<GroupBuyStatus, TradeStatusCopy>> = {
  PUBLISHED: { label: '拼团中 · 可认领转化', tone: 'open' },
  REACHED: { label: '已成团 · 待确认', tone: 'grouped' },
  PENDING_LAWYER: { label: '待你确认（12h 窗）', tone: 'live' },
  CONFIRMED: { label: '已接单 · 履约场次已生成', tone: 'grouped' },
  CONVERTED: { label: '已认领 · 转为 B2C 场次', tone: 'grouped' },
  EXPIRED: { label: '已流标 · 用户退款', tone: 'failed' },
  REFUNDED: { label: '已退款', tone: 'finished' },
  REJECTED: { label: '已婉拒 · 用户退款', tone: 'failed' },
};

/** 律师视角拼团状态徽标（接单大厅卡/认领转化语境；未知值回退原码——fail-visible） */
export function lawyerGroupBuyStatusCopy(status: string): TradeStatusCopy {
  return (
    LAWYER_GROUP_BUY_STATUS_COPY[status as GroupBuyStatus] ?? {
      label: status,
      tone: 'finished',
    }
  );
}

// ---------------------------------------------------------------------------
// A2 实名状态（§4：NONE→PENDING→VERIFIED/FAILED 可重提）
// ---------------------------------------------------------------------------

const REALNAME_STATUS_COPY: Readonly<Record<RealnameStatus, string>> = {
  NONE: '未实名',
  PENDING: '核验中',
  VERIFIED: '已实名',
  FAILED: '核验未通过（可重新提交）',
};

export function realnameStatusCopy(status: string): string {
  return REALNAME_STATUS_COPY[status as RealnameStatus] ?? status;
}

// ---------------------------------------------------------------------------
// A2 训练授权状态（§4：ABSENT→GRANTED→REVOKED）
// ---------------------------------------------------------------------------

const CONSENT_STATUS_COPY: Readonly<Record<TrainingConsentStatus, string>> = {
  ABSENT: '未授权',
  GRANTED: '已授权',
  REVOKED: '已撤回',
};

export function trainingConsentStatusCopy(status: string): string {
  return CONSENT_STATUS_COPY[status as TrainingConsentStatus] ?? status;
}

// ---------------------------------------------------------------------------
// C3 报名支付状态（enrollment.machine 五态，「我的报名」行状态徽标）
// ---------------------------------------------------------------------------

const ENROLL_PAY_STATUS_COPY: Readonly<Record<string, TradeStatusCopy>> = {
  PENDING: { label: '待支付', tone: 'open' },
  PAID: { label: '已支付', tone: 'grouped' },
  REFUNDED: { label: '已退款', tone: 'finished' },
  CONVERTED_OUT: { label: '已转入拼团场次', tone: 'finished' },
  RESCHEDULED_OUT: { label: '已改期迁移', tone: 'finished' },
};

export function enrollPayStatusCopy(status: string): TradeStatusCopy {
  return ENROLL_PAY_STATUS_COPY[status] ?? { label: status, tone: 'finished' };
}

// ---------------------------------------------------------------------------
// C3 退款态（EnrollmentRefundStatus 四态；NONE=无退款流程，视图层不渲徽标）
// ---------------------------------------------------------------------------

const REFUND_STATUS_COPY: Readonly<Record<string, TradeStatusCopy>> = {
  NONE: { label: '无退款', tone: 'finished' },
  PROCESSING: { label: '退款处理中', tone: 'failed' },
  REFUNDED: { label: '已退款', tone: 'finished' },
  FAILED: { label: '退款失败', tone: 'failed' },
};

export function refundStatusCopy(status: string): TradeStatusCopy {
  return REFUND_STATUS_COPY[status] ?? { label: status, tone: 'finished' };
}

// ---------------------------------------------------------------------------
// C3 报名对象类型（ref_type 二值：场次/拼团——「我的报名/我的拼团」行上下文前缀）
// ---------------------------------------------------------------------------

const ENROLL_REF_TYPE_COPY: Readonly<Record<string, string>> = {
  session: '场次报名',
  groupbuy: '拼团报名',
};

export function enrollRefTypeCopy(refType: string): string {
  return ENROLL_REF_TYPE_COPY[refType] ?? refType;
}

// ---------------------------------------------------------------------------
// 报名支付结果态（#40 直接成功口径的成团反馈文案）
// ---------------------------------------------------------------------------

/**
 * 支付后场次状态 → 报名结果反馈（详情刷新后取 session.status 判定）：
 * FULL=满员成团；CREATED=已支付待成团；其余（极端竞态如流标）按退款语义收口。
 */
export function enrollOutcomeCopy(sessionStatus: string): {
  readonly title: string;
  readonly note: string;
} {
  if (sessionStatus === 'FULL') {
    return {
      title: '报名成功 · 已成团',
      note: '本场已满员成团，费用已锁定，后续按成团履约；成团后不退不改期（详见订单规则）。',
    };
  }
  if (sessionStatus === 'CREATED') {
    return {
      title: '报名成功 · 待成团',
      note: '支付已成功，等待更多成员加入；达到人数即成团，到报名截止仍未成团将全额自动退款。',
    };
  }
  if (sessionStatus === 'FAILED' || sessionStatus === 'CANCELLED') {
    return {
      title: '支付已受理 · 场次未成团',
      note: '该场次已流标或取消，报名费用将原路全额自动退款，请留意到账。',
    };
  }
  return {
    title: '报名成功',
    note: `当前场次状态：${sessionStatus}`,
  };
}

/**
 * 支付回调已受理但成团确认刷新失败时的降级收口（评审 I4）：
 * 轮询网络抖动不得把已支付流程翻成失败态——钱已扣只报「确认中」。
 */
export const ENROLL_ACCEPTED_PENDING: { readonly title: string; readonly note: string } = {
  title: '支付已受理 · 成团确认中',
  note: '支付回调已受理，成团状态确认中；稍后可在场次详情或「我的报名」查看最新状态。',
};
