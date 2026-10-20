/**
 * E1 LLM 供应商适配器（M2-W3 T4；⚠W3-3/D11）：接口隔离位——草稿生成段（§4 管线末段）
 * 只依赖本抽象，真供应商换装不改主流程。
 *
 * R-07 硬约束（架构 §1.3-5）：LLM 供应商=境内/不出境/输入不留存不训练/DPA 签署——本批
 * **禁引入任何真供应商 SDK（含境外）**，缺省装配=MockLlmAdapter（零网络确定性模板拼装，
 * 与 knowledge.embedding 的 mock 供应商位同款纪律）；境内真供应商 DPA 签署后换装=新适配器
 * 文件 + 模块工厂单点替换。
 *
 * R-02 类型面钉死：入参只有脱敏后载荷（questionDigest/intent/hits）——placeholders（占位符
 * →原文映射）与原文永不进入本接口（类型无该字段，编译期拦截）。
 */
import { Injectable } from '@nestjs/common';
import type { KnowledgeHit } from './knowledge.types';

/** LLM 生成入参（全部为脱敏后载荷——R-02；构造即契约，禁扩原文/占位符字段） */
export interface LlmGenerateInput {
  /** 脱敏后问题摘要（占位符形态）——RAG/LLM 唯一合法的问题载荷 */
  readonly questionDigest: string;
  /** 意图聚类结果（E1 轻量意图段产出；当前词汇='general'） */
  readonly intent: string;
  /** RAG 命中（chunk=知识库语料，无用户 PII；空数组=无命中容忍） */
  readonly hits: readonly KnowledgeHit[];
}

export interface LlmGenerateOutput {
  /** 草稿正文（须含「AI 辅助，仅供参考」标记——R-04；mock=模板拼装） */
  readonly content: string;
}

/**
 * R-04 标记（管线级强制锚——T4 评审 I-1）：草稿正文缺本标记=适配器违约，管线降级不出稿
 * （真供应商换装时输出形态不受平台控制，红线不悬于适配器自觉）。mock 模板同款字面量。
 */
export const AI_ASSIST_MARKER = '【AI 辅助，仅供参考】';

/** LLM 适配器接口（供应商隔离位：mock ↔ 境内真供应商换装缝） */
export interface LlmAdapter {
  generate(input: LlmGenerateInput): Promise<LlmGenerateOutput>;
}

export const LLM_ADAPTER = Symbol('E1_LLM_ADAPTER');

/** 故障注入开关的环境键（mock 期降级路径联调：true=每次 generate 抛错——W3-7 降级纪律测试） */
export const LLM_MOCK_FAIL_ENV = 'LJR_AGENT_ASSIST_LLM_MOCK_FAIL';

/** 问题摘要嵌入模板的截断长度（字符——mock 模板防滥用护栏，非产品契约） */
const DIGEST_MAX_CHARS = 120;
/** 知识命中引用条数与单条摘要长度（「命中知识 chunk 摘要引用」的 mock 形态） */
const HIT_LIMIT = 3;
const HIT_EXCERPT_CHARS = 80;

/**
 * Mock LLM 适配器（D11/W3-3 缺省装配）：确定性模板拼装（同输入同输出、零网络零时钟）——
 *   - 草稿正文含「AI 辅助，仅供参考」标记（R-04——仅律师端可见的标注起点）与审查提示尾；
 *   - 命中知识 chunk 摘要引用（top 命中 ≤3 条：文档标题+chunk 前 80 字）；
 *   - 故障注入：构造参 fail 或 env LJR_AGENT_ASSIST_LLM_MOCK_FAIL（测试/联调降级路径；
 *     fail 字段公开可变——运行中翻转覆盖恢复路径用例）。抛错形态=Error（消费端按管线段
 *     失败降级处理，W3-7）。
 */
@Injectable()
export class MockLlmAdapter implements LlmAdapter {
  /** 故障注入开关（公开可变：降级→恢复两态用例运行中翻转） */
  public fail: boolean;

  constructor(options?: { readonly fail?: boolean }) {
    this.fail = options?.fail ?? false;
  }

  async generate(input: LlmGenerateInput): Promise<LlmGenerateOutput> {
    if (this.fail) {
      throw new Error('MockLlmAdapter 故障注入（LLM 段降级路径）');
    }
    const digest = [...input.questionDigest.trim()].slice(0, DIGEST_MAX_CHARS).join('');
    const lines: string[] = [
      AI_ASSIST_MARKER,
      `关于用户问题「${digest}」（意图：${input.intent}），建议回复要点：`,
    ];
    if (input.hits.length === 0) {
      lines.push('· 本问题暂无知识库命中，请律师按专项经验作答。');
    } else {
      for (const hit of input.hits.slice(0, HIT_LIMIT)) {
        const excerpt = [...hit.chunk].slice(0, HIT_EXCERPT_CHARS).join('');
        lines.push(`· 知识参考《${hit.docTitle}》（第 ${hit.chunkIndex + 1} 块）：${excerpt}`);
      }
    }
    lines.push('以上由 AI 生成，请律师审查修改后使用。');
    return { content: lines.join('\n') };
  }
}

/** 模块工厂（draft.module 装配）：缺省 mock；env 故障注入键透传（联调降级演练） */
export const llmAdapterFactory = (): LlmAdapter => {
  const fail = process.env[LLM_MOCK_FAIL_ENV] === 'true';
  return new MockLlmAdapter({ fail });
};
