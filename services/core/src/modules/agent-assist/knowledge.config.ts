/**
 * E3 知识库处理配置（§4 分块参数 / §5 检索 top_k / §8 向量化维度）。
 *
 * 取值口径：文档固定值（512/64/8）为模块规格逐字；embeddingDim=1024 与 V9 embedding 列型
 * vector(1024) 对齐（路径①强约束，路径②由写入守卫保证维度一致性）。⚠决策位：maxInlineChars/
 * maxChunksPerDoc/maxQueryCodepoints 为实现约定上限（防误用巨包；真实语料分批由 M2 管理面承载）。
 * W1 不开 env 覆盖（文档未定义运维调参面；测试经 DI override 注入）。
 */
import type { InjectionToken } from '@nestjs/common';

export interface KnowledgeConfig {
  /** 向量维度（§3 vector(1024)；mock 供应商按此出向量，真实供应商接入时必须一致） */
  readonly embeddingDim: number;
  /** 分块窗口 token 数（§4 逐字；token 口径=Unicode 码点，报告明示） */
  readonly chunkTokenSize: number;
  /** 分块重叠 token 数（§4 逐字） */
  readonly chunkOverlapTokens: number;
  /** 检索 top_k 缺省（§5 逐字 =8） */
  readonly retrievalTopK: number;
  /** inline 正文最大码点数（⚠实现约定；超限 400 E_BAD_FORMAT） */
  readonly maxInlineChars: number;
  /** 单文档分块数上限（⚠防御上限；超限 ingest 落 FAILED） */
  readonly maxChunksPerDoc: number;
  /** 检索 query 最大码点数（超出截断；⚠实现约定） */
  readonly maxQueryCodepoints: number;
}

/** DI 令牌（RULE_CENTER_CONFIG 同款 Symbol 口径；缺装配即启动期 fail-fast） */
export const KNOWLEDGE_CONFIG: InjectionToken<KnowledgeConfig> = Symbol('KNOWLEDGE_CONFIG');

/** 默认值=文档/迁移口径（512/64/8/1024）+ ⚠实现约定上限 */
export const KNOWLEDGE_DEFAULT_CONFIG: KnowledgeConfig = {
  embeddingDim: 1024,
  chunkTokenSize: 512,
  chunkOverlapTokens: 64,
  retrievalTopK: 8,
  maxInlineChars: 200_000,
  maxChunksPerDoc: 2048,
  maxQueryCodepoints: 4096,
};

/** 装配工厂（测试可传 overrides；运行时用默认） */
export function knowledgeConfig(overrides: Partial<KnowledgeConfig> = {}): KnowledgeConfig {
  return { ...KNOWLEDGE_DEFAULT_CONFIG, ...overrides };
}
