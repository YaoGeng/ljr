/**
 * E3 知识库分块器（§4：512 token 重叠 64——确定性纯函数，同文件同分块）。
 *
 * token 口径（控制者裁决授权自定义，报告明示）：**1 token = 1 个 Unicode 码点（按字切）**。
 * 理由：①确定性优先——无模型分词器依赖，同输入恒同输出（§9 TDD 要求）；②中文法律语料为主
 * （CJK 占比高），码点≈token 是业界常用近似；③ES/PG 侧长度语义统一按码点，避免 UTF-16 代理
 * 对切半。512 码点窗口对中文约 250~500 字，语义完整性由 M2 语义分块升级位承接（⚠结构留位）。
 *
 * 窗口算法：stride = chunkTokens - overlapTokens；窗口 [start, start+chunkTokens) 逐块推进，
 * 末块不足窗口原样收尾（不丢弃、不补白）。charStart/charEnd 均为码点偏移（非 UTF-16 下标），
 * 与 metadata.char_start/char_end 同口径。
 */
import { AppError, ErrorCode } from '@ljr/shared';

export interface TextChunk {
  /** 块序号（0 起，文档内连续） */
  readonly index: number;
  /** 块正文（原文切片，不做任何改写——检索命中后由消费方回溯原文） */
  readonly text: string;
  /** 起始码点偏移（含） */
  readonly charStart: number;
  /** 结束码点偏移（不含） */
  readonly charEnd: number;
}

export interface ChunkOptions {
  readonly chunkTokens: number;
  readonly overlapTokens: number;
}

/** 码点视图（[...str] 迭代 Unicode 码点；代理对不切半） */
function codepoints(text: string): string[] {
  return [...text];
}

export function chunkText(text: string, options: ChunkOptions): TextChunk[] {
  const { chunkTokens, overlapTokens } = options;
  if (!Number.isSafeInteger(chunkTokens) || chunkTokens < 1) {
    throw new AppError(ErrorCode.InvalidArgument, `chunkTokens 须为正整数：${String(chunkTokens)}`);
  }
  if (!Number.isSafeInteger(overlapTokens) || overlapTokens < 0 || overlapTokens >= chunkTokens) {
    throw new AppError(
      ErrorCode.InvalidArgument,
      `overlapTokens 须为 0..<chunkTokens（${chunkTokens}）的整数：${String(overlapTokens)}`,
    );
  }
  const chars = codepoints(text);
  const total = chars.length;
  if (total === 0) return [];
  const stride = chunkTokens - overlapTokens;
  const chunks: TextChunk[] = [];
  let start = 0;
  let index = 0;
  while (start < total) {
    const end = Math.min(start + chunkTokens, total);
    chunks.push({
      index,
      text: chars.slice(start, end).join(''),
      charStart: start,
      charEnd: end,
    });
    index += 1;
    if (end >= total) break;
    start += stride;
  }
  return chunks;
}
