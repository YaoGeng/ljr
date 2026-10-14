/**
 * E3 embedding 供应商 port + 确定性 mock（⚠决策位：真实境内供应商 D11/M2-W3 接入——
 * 境外 API 禁令，§9/E3 §11；出站请求约束见根 AGENTS.md）。
 *
 * mock 口径（控制者裁决）：确定性——同文本恒同向量（跨进程/跨运行）、维度可注入、
 * 零网络请求（sha256 派生，非随机）。实现：分量 i = sha256(`<i>|<text>`) 首 4 字节映射到
 * [-1,1]，再 L2 归一（cosine = 点积；同文 score=1）。语义上不同文本近似正交（相似度≈0）——
 * dev/测试只依赖「同文可复现、异文可区分」的检索机制性质，真实语义排序随真供应商到位后
 * 由 E2E 语义用例补强（M2-W3）。
 *
 * port（EmbeddingProvider）即供应商位：真实适配器实现 embed() 批量接口接入（批量向量化、
 * 重试/限流策略属供应商适配器内部）；服务层唯一额外约束=输出维度须等于 KNOWLEDGE_CONFIG.
 * embeddingDim（写入守卫，违例 InternalError 显性化——维度漂移静默入库会让检索全部失配）。
 */
import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { InjectionToken } from '@nestjs/common';
import { AppError, ErrorCode } from '@ljr/shared';
import type { KnowledgeConfig } from './knowledge.config';

export interface EmbeddingProvider {
  /** 向量维度（服务层写入/查询守卫用；须与 KNOWLEDGE_CONFIG.embeddingDim 一致） */
  readonly dim: number;
  /** 批量向量化（顺序与入参一一对应；实现方自行决定批量策略） */
  embed(texts: readonly string[]): Promise<number[][]>;
}

/** DI 令牌：缺省装 MockEmbeddingProvider（module useFactory）；测试可 override 故障桩 */
export const EMBEDDING_PROVIDER: InjectionToken<EmbeddingProvider> = Symbol('EMBEDDING_PROVIDER');

function deterministicVector(text: string, dim: number): number[] {
  const v = new Array<number>(dim);
  for (let i = 0; i < dim; i++) {
    const digest = createHash('sha256').update(`${i}|${text}`, 'utf8').digest();
    const u = digest.readUInt32BE(0);
    v[i] = (u / 0xffffffff) * 2 - 1;
  }
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return norm === 0 ? v : v.map((x) => x / norm);
}

@Injectable()
export class MockEmbeddingProvider implements EmbeddingProvider {
  readonly dim: number;

  constructor(dim = 1024) {
    if (!Number.isSafeInteger(dim) || dim < 1) {
      throw new AppError(ErrorCode.ConfigInvalid, `embedding 维度须为正整数：${String(dim)}`);
    }
    this.dim = dim;
  }

  async embed(texts: readonly string[]): Promise<number[][]> {
    return texts.map((t) => deterministicVector(t, this.dim));
  }
}

/** module 装配工厂：按 KNOWLEDGE_CONFIG.embeddingDim 构造缺省 mock 供应商 */
export function mockEmbeddingProviderFactory(config: KnowledgeConfig): EmbeddingProvider {
  return new MockEmbeddingProvider(config.embeddingDim);
}
