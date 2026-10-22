/**
 * 通知文案映射表（M3-W1 T4）：templateCode → 类型徽标文案 + 站内信正文渲染，单一事实源
 * （纪律：状态/类型文案映射表禁散写三元；视图层一律经本件取文案）。
 *
 * ⚠契约现状（任务报告 triage）：GET /notifications/mine 行无渲染文案字段（仅 templateCode+params）
 * ——正文在 App 侧按模板目录渲染。目录=core 模板事实源的「消费侧文案副本」（先例=error-messages/
 * session-copy 的消费侧映射表）：话术实文抄自 core 种子（V4 迁移三档改价 PRD §8.2 逐字 +
 * reminder.service SESSION_REMIND 缺省话术）；core 模板修订走新迁移，届时须同步本目录。
 * 未知 code 回退：label=原码、正文=通用文案（fail-visible，不吞不编）。
 *
 * 占位符渲染算法与 core renderTemplate 同形：{key} → String(params[key])；值缺失/空保留原占位符。
 * 展示增强（仅值形态层）：值为 ISO 时刻字符串时经 date.ts 人话化（上海时区）——不改变模板结构。
 */
import { formatDateTimeFull } from '../utils/date';

export type NotifyTone = 'open' | 'grouped' | 'finished' | 'failed';

export interface NotifyTemplateCopy {
  readonly label: string;
  readonly tone: NotifyTone;
  /** 站内信正文模板（含 {key} 占位符）；null=core 未 seed 固定话术（如 RESCHEDULE_EXPIRED）→ 通用正文 */
  readonly content: string | null;
}

// ---------------------------------------------------------------------------
// 模板目录（I1 模板中心在册 code；话术=core 种子实文逐字）
// ---------------------------------------------------------------------------

const TEMPLATE_COPY: Readonly<Record<string, NotifyTemplateCopy>> = {
  // V4 迁移种子：PRD §8.2 三档改价话术（R-01 逐字一致）
  PRICE_UP_LOCKED: {
    label: '价格上调 · 原价已锁',
    tone: 'grouped',
    content: '您已锁定原价，当前律师已调价，您享受的是涨价前的价格，不受影响。',
  },
  PRICE_DOWN_COMP: {
    label: '价格下调 · 积分补偿',
    tone: 'open',
    content:
      '您参与的服务价格有所调整，您已锁定的原价不受影响。为感谢您的信任，我们已为您申请平台积分补偿，将在 24 小时内到账。',
  },
  PRICE_DOWN_BIG: {
    label: '价格大幅下调 · 补偿',
    tone: 'open',
    content:
      '您参与的服务价格大幅调整。您已锁定的原价不受影响，我们已为您申请积分补偿 + 额外平台优惠券，将在 24 小时内到账。感谢您的信任与支持。',
  },
  // reminder.service 缺省话术（模板自愈 seed；{slot_start}/{kind_label} 占位）
  SESSION_REMIND: {
    label: '场次提醒',
    tone: 'open',
    content:
      '场次提醒：您报名的场次将于 {slot_start} 开始（{kind_label}）。请提前进入房间；确认到场与申请改期请前往「我的报名」操作。',
  },
  // reschedule.service 消费位（模板未 seed 时 core 跳过通知——正文书面上不可达，目录仅备类型徽标）
  RESCHEDULE_EXPIRED: { label: '改期请求超时', tone: 'failed', content: null },
};

export function notifyTemplateCopy(templateCode: string): NotifyTemplateCopy {
  return TEMPLATE_COPY[templateCode] ?? { label: templateCode, tone: 'finished', content: null };
}

// ---------------------------------------------------------------------------
// 正文渲染（core renderTemplate 同形 + ISO 值人话化）
// ---------------------------------------------------------------------------

const ISO_LIKE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

/** 参数值 → 展示串（ISO 时刻字符串经 date.ts；其余 String(value) 与 core 同形） */
function paramValueToString(value: unknown): string {
  if (typeof value === 'string' && ISO_LIKE.test(value) && !Number.isNaN(Date.parse(value))) {
    return formatDateTimeFull(value);
  }
  return String(value);
}

/** 站内信正文渲染：目录话术 {key} 替换（缺值保留原占位符）；无话术/未知 code → 通用正文 */
export function renderNotifyContent(
  templateCode: string,
  params: Readonly<Record<string, unknown>>,
): string {
  const copy = notifyTemplateCopy(templateCode);
  if (copy.content === null) {
    const extras = Object.entries(params)
      .map(([k, v]) => `${k}：${paramValueToString(v)}`)
      .join('；');
    return extras.length > 0 ? `收到一条平台通知（${extras}）` : '收到一条平台通知';
  }
  return copy.content.replace(/\{([A-Za-z0-9_]+)\}/g, (raw, key: string) => {
    const value = params[key];
    return value === undefined || value === null ? raw : paramValueToString(value);
  });
}
