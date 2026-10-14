/**
 * H7 规则中心类型契约（施工规格 docs/modules/H-运营后台/H7-规则中心.md §2/§3/§5/§6）。
 *
 * 定位（§1）：rule_definitions 通用规则版本化唯一事实源——变更状态机（草案→公示≥7日→生效）、
 * 行为时快照查询、房间须知内容块、App 规则页。不做规则执行（各消费方按快照执行）。
 * 消费方：C6/G1/D4（快照）、H5 词库（R-03 免公示通道，M1-W1 Task 5）、D5（须知内容）、I1（RulePublished）。
 */

/** 规则发布状态（§2/§3；迁移经 rule-center.machine 守卫；§9 禁止未公示直接 EFFECTIVE） */
export type RulePublishStatus = 'DRAFT' | 'PUBLISHED' | 'EFFECTIVE' | 'ABANDONED';

/** 全量状态集（管理面 status 筛选用）；ABANDONED=控制者裁决的草案废弃终态（报告论证：留痕优于删行） */
export const RULE_PUBLISH_STATUSES = ['DRAFT', 'PUBLISHED', 'EFFECTIVE', 'ABANDONED'] as const;

/** 类型收窄守卫（REST status 筛选入参校验用） */
export function isRulePublishStatus(value: string): value is RulePublishStatus {
  return (RULE_PUBLISH_STATUSES as readonly string[]).includes(value);
}

/** 规则行视图（§3 ops.rule_definitions；REST 出参用 camelCase，Date 由 Nest 序列化为 ISO） */
export interface RuleDefinitionView {
  readonly id: number;
  readonly ruleKey: string;
  readonly version: number;
  readonly content: Record<string, unknown>;
  /** 生效时刻：PUBLISHED 时=published_at+7 日承诺时刻；R-03 免公示通道创建即落；DRAFT/ABANDONED 为 null */
  readonly effectiveAt: Date | null;
  readonly publishStatus: RulePublishStatus;
  /** 提交公示时刻；R-03 免公示通道恒 null（未走公示流） */
  readonly publishedAt: Date | null;
  readonly createdAt: Date;
}

/** POST /admin/rules 体（§5 幂等键=key+version） */
export interface CreateDraftInput {
  readonly ruleKey: string;
  readonly version: number;
  readonly content: Record<string, unknown>;
}

export interface CreateDraftResult extends RuleDefinitionView {
  /** true=新建；false=同 key+version 重放（内容全等）幂等回读既有行（§5 幂等键语义，REST 裁量见报告） */
  readonly created: boolean;
}

export interface SubmitPublicationResult {
  readonly ruleKey: string;
  readonly version: number;
  /** 公示期满承诺时刻（=published_at+publicationMs；App「即将生效」展示与快照锚点） */
  readonly effectiveAt: Date;
  readonly publishedAt: Date;
  /** true=重复提交幂等短路（已 PUBLISHED：不重发事件、不重注册 job，回读首次公示时刻） */
  readonly deduplicated: boolean;
}

/**
 * R-03 词库免公示通道入参（Task 5 H5 消费，最终签名见报告）：版本化但不走公示流——
 * 创建即 EFFECTIVE（effective_at 缺省 now），不 RulePublished、不注册 RULE_EFFECTIVE job；
 * 留痕=state_transition_log 显式审计行（reason='lexicon_publish_freeze'）；仅限内部机制调用。
 */
export interface LexiconVersionInput {
  readonly ruleKey: string;
  readonly version: number;
  readonly content: Record<string, unknown>;
  /** 缺省 now()；传未来时刻=预约生效（快照按行为时刻命中，热更新灰度位） */
  readonly effectiveAt?: Date;
}

// ---------- 房间须知内容块（R-02；content jsonb 结构由本模块定义，D5 经 GET /rooms/notice-content 消费） ----------

/**
 * rule_key=<noticeRuleKey>（缺省 room_notice）的 content jsonb 结构（H7 定义，D5 按此消费）：
 *   { "title": string(1..64),
 *     "paragraphs": string[](每条 1..500，可为空数组),
 *     "disclosures": string[](非空数组，必须含用户侧披露——PRD §7.1.5
 *       「法律意见由执业律师作出，平台提供信息技术撮合」由配置内容承载，机制层只校验非空) }
 * 结构在创建草案时校验（早反馈）；读取时再校验一次（防御历史脏数据，违例=InternalError 显性化）。
 */
export interface RoomNoticeContent {
  readonly title: string;
  readonly paragraphs: readonly string[];
  readonly disclosures: readonly string[];
}

/** GET /rooms/notice-content 出参（D5 进房拉取；404=尚无生效版本） */
export interface RoomNoticeView {
  readonly ruleKey: string;
  readonly version: number;
  readonly effectiveAt: Date;
  readonly content: RoomNoticeContent;
}
