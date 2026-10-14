/**
 * E3 专项配置包类型契约（施工规格 docs/modules/E-AI辅助/E3-专项配置与知识库.md §2/§3/§5/§6）。
 *
 * 领域模型（§3）：specialty_configs(specialty UNIQUE, question_tree jsonb, prompts jsonb,
 * active)——专项=key 的配置包（R-01：知识库+问题树+提示词+词表引用按专项收敛；词表引用不落
 * 本表——H5 词库机制 API 是词库版本化唯一事实源，架构 §4.4/模块边界，E3 不冗余存储）。
 *
 * jsonb 结构（写入端 normalize 保证、读取端 parse 防御，报告明示）：
 *   question_tree = { root, nodes: [{id, label, children: [id...]}] }（空树 {root:'',nodes:[]}）
 *   prompts       = { templates: { <key>: <content> } }
 * 版本（§5 幂等键=key+base_version；R-03 变更记 version）：承载于
 * specialty_configs.question_tree_version / prompts_version（V9 追加列，迁移头注②）。
 */

/** V1 在册专项（R-04：V2 才新增专项；新专项=追加本表 + 配置包录入，零代码是 V2 目标） */
export const SUPPORTED_SPECIALTIES = ['labor_arbitration'] as const;
export type SpecialtyKey = (typeof SUPPORTED_SPECIALTIES)[number];

/** 问题树节点：children 顺序即展示顺序（语义化，规范化不排序 children） */
export interface QuestionTreeNode {
  readonly id: string;
  readonly label: string;
  readonly children: readonly string[];
}

export interface QuestionTree {
  readonly root: string;
  readonly nodes: readonly QuestionTreeNode[];
}

/** 提示词模板集：key → 模板正文（R-03 版本化整体变更；消费方=生成时读当前版本，M2-W3 接线） */
export type PromptTemplates = {
  readonly templates: Readonly<Record<string, string>>;
};

/** GET /specialty/question-tree 出参（公开只读，C2 消费） */
export interface SpecialtyQuestionTreeView {
  readonly specialty: string;
  readonly version: number;
  readonly questionTree: QuestionTree;
}

/** PUT question-tree/prompts 出参（§5 {version}；created=additive 幂等重放标识，rule-center 先例） */
export interface PutSpecialtyConfigResult {
  readonly specialty: string;
  readonly version: number;
  /** true=新建版本；false=同 key+base_version 重放（内容 canonical 全等）幂等回读 */
  readonly created: boolean;
}

/** specialty_configs 行视图（模块内/机制消费用；REST 面不暴露整行） */
export interface SpecialtyConfigView {
  readonly id: number;
  readonly specialty: string;
  readonly active: boolean;
  readonly questionTree: QuestionTree;
  readonly prompts: PromptTemplates;
  readonly questionTreeVersion: number;
  readonly promptsVersion: number;
  readonly updatedAt: Date;
}
