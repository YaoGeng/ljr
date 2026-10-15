/**
 * G1 规则内容解析（credit.rules content jsonb → CreditRulesContent）：结构契约守门纯函数。
 *
 * 定位（R-W2-10）：分值/限制映射的唯一事实源在 H7 规则中心（运营配置），本模块只承载机制——
 * 解析层只做「结构是否可执行」判定，不做任何业务默认值回填：形态漂移=InternalError 显性化
 * （脏配置静默透传会让限制令/分值静默失准，宁炸读端不降级，parseNoticeContent 同口径）。
 * 约束语义：delta 整数（可正可负可 0）；kind ∈ RESTRICTION_KINDS（§3 四值，DB CHECK 同字面）；
 * days/window_days/threshold 正整数；violation 布尔可选。
 */
import { AppError, ErrorCode } from '@ljr/shared';
import {
  RESTRICTION_KINDS,
  type ActionRule,
  type CreditRulesContent,
  type OwnerType,
  type RestrictionKind,
  type RestrictionSpec,
} from './credit.types';

function drift(message: string): never {
  throw new AppError(
    ErrorCode.InternalError,
    `credit.rules 内容结构漂移（H7 配置须符合 G1 契约，不应触达）：${message}`,
  );
}

function assertRestrictionSpec(raw: unknown, where: string): RestrictionSpec {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    drift(`${where} 须为对象 {kind, days}`);
  }
  const obj = raw as Record<string, unknown>;
  const kind = obj['kind'];
  if (typeof kind !== 'string' || !(RESTRICTION_KINDS as readonly string[]).includes(kind)) {
    drift(`${where}.kind 越域（${RESTRICTION_KINDS.join('/')}）：${JSON.stringify(kind)}`);
  }
  const days = obj['days'];
  if (typeof days !== 'number' || !Number.isInteger(days) || days <= 0) {
    drift(`${where}.days 须为正整数：${JSON.stringify(days)}`);
  }
  return { kind: kind as RestrictionKind, days };
}

function assertActionRule(action: string, raw: unknown): ActionRule {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    drift(`actions.${action} 须为对象 {delta, restriction?, violation?}`);
  }
  const obj = raw as Record<string, unknown>;
  const delta = obj['delta'];
  if (typeof delta !== 'number' || !Number.isInteger(delta)) {
    drift(`actions.${action}.delta 须为整数：${JSON.stringify(delta)}`);
  }
  const rule: { delta: number; restriction?: RestrictionSpec; violation?: boolean } = { delta };
  if (obj['restriction'] !== undefined && obj['restriction'] !== null) {
    rule.restriction = assertRestrictionSpec(obj['restriction'], `actions.${action}.restriction`);
  }
  if (obj['violation'] !== undefined) {
    if (typeof obj['violation'] !== 'boolean') {
      drift(`actions.${action}.violation 须为布尔：${JSON.stringify(obj['violation'])}`);
    }
    rule.violation = obj['violation'];
  }
  return rule;
}

function assertRestrictionByOwner(
  raw: unknown,
): CreditRulesContent['violation']['restriction_by_owner'] {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    drift('violation.restriction_by_owner 须为对象 {user, lawyer}');
  }
  const obj = raw as Record<string, unknown>;
  const user = obj['user'];
  const lawyer = obj['lawyer'];
  if (user === undefined || user === null || lawyer === undefined || lawyer === null) {
    drift('violation.restriction_by_owner 须同时含 user 与 lawyer（窗口触发按 owner 分流）');
  }
  return {
    user: assertRestrictionSpec(user, 'violation.restriction_by_owner.user'),
    lawyer: assertRestrictionSpec(lawyer, 'violation.restriction_by_owner.lawyer'),
  };
}

/**
 * 解析并收窄 credit.rules content（ruleVersion 仅用于错误定位信息——快照版本随流水落审计位）。
 * 抛 InternalError=配置脏数据（消费路径进 relay 重试/死信轨道，显性化不静默）。
 */
export function parseCreditRules(
  content: Record<string, unknown>,
  ruleVersion: number,
): CreditRulesContent {
  if (typeof content !== 'object' || content === null || Array.isArray(content)) {
    drift(`content 须为 JSON 对象（v${ruleVersion}）`);
  }
  const raw = content as Record<string, unknown>;
  const violationRaw = raw['violation'];
  if (typeof violationRaw !== 'object' || violationRaw === null || Array.isArray(violationRaw)) {
    drift(`violation 须为对象 {window_days, threshold, restriction_by_owner}（v${ruleVersion}）`);
  }
  const violation = violationRaw as Record<string, unknown>;
  const windowDays = violation['window_days'];
  const threshold = violation['threshold'];
  if (typeof windowDays !== 'number' || !Number.isInteger(windowDays) || windowDays <= 0) {
    drift(`violation.window_days 须为正整数：${JSON.stringify(windowDays)}`);
  }
  if (typeof threshold !== 'number' || !Number.isInteger(threshold) || threshold <= 0) {
    drift(`violation.threshold 须为正整数：${JSON.stringify(threshold)}`);
  }
  const actionsRaw = raw['actions'];
  if (typeof actionsRaw !== 'object' || actionsRaw === null || Array.isArray(actionsRaw)) {
    drift(`actions 须为对象（action→规则映射，v${ruleVersion}）`);
  }
  const actions: Record<string, ActionRule> = {};
  for (const [action, rule] of Object.entries(actionsRaw as Record<string, unknown>)) {
    actions[action] = assertActionRule(action, rule);
  }
  return {
    violation: {
      window_days: windowDays,
      threshold,
      restriction_by_owner: assertRestrictionByOwner(violation['restriction_by_owner']),
    },
    actions,
  };
}

/** 查某行为的规则项（缺失=null；调用方决定显性化语义——emit 侧 config gap 进重试轨道） */
export function actionRuleOf(rules: CreditRulesContent, action: string): ActionRule | null {
  return rules.actions[action] ?? null;
}

/** 窗口触发限制令按 owner 分流（owner_type 已在入口收窄，防御性兜底 InternalError） */
export function violationRestrictionFor(
  rules: CreditRulesContent,
  ownerType: OwnerType,
): RestrictionSpec {
  const spec = rules.violation.restriction_by_owner[ownerType];
  if (!spec) drift(`violation.restriction_by_owner 缺 ${ownerType} 项`);
  return spec;
}
