/**
 * H5 判定引擎内核：Aho-Corasick 自动机（零外部依赖自实现，§4「词库 AC 自动机/DFA」、§8
 * 内存 ≤50MB——词表量级下节点数组远小于该预算）。
 *
 * 匹配语义（与词库正文/入参共用 normalizeWord 规范形）：
 *   - 大小写不敏感：词库词与扫描文本统一 toLowerCase 后匹配（命中以规范形小写回报）；
 *   - ASCII 词边界：纯 [a-z0-9] 词要求两端不邻接 [a-z0-9]（win 不误伤 window）；含 CJK 等非
 *     ASCII 词无词界概念，子串即命中；
 *   - 去重：同词多次出现只报一次；跨库同词各自成条（聚合取最高 severity 由服务层负责）。
 * 扫描复杂度 O(文本长 + 命中数)——输出经 fail 链合并到节点（构建期一次），热路径无回溯链行走。
 */
import type { DictType, WordAction } from './word-dict.types';

/** 自动机词条（词=小写规范形；构建方保证去重） */
export interface AutomatonEntry {
  readonly word: string;
  readonly action: WordAction;
  readonly dictType: DictType;
}

interface AcNode {
  readonly next: Map<string, number>;
  fail: number;
  /** 合并输出（本节点词 + fail 链后缀词）；构建期一次合并，扫描期 O(1) 取用 */
  output: AutomatonEntry[];
}

const ASCII_ALNUM = /^[a-z0-9]$/;
const ASCII_WORD = /^[a-z0-9]+$/;

export class AcMatcher {
  private constructor(private readonly nodes: readonly AcNode[]) {}

  /** 构建：词条须为小写规范形（服务层 normalizeWord 保证）；同词重复词条以先入者为准 */
  static build(entries: readonly AutomatonEntry[]): AcMatcher {
    const nodes: AcNode[] = [{ next: new Map(), fail: 0, output: [] }];
    for (const entry of entries) {
      let cur = 0;
      // 按UTF-16 码元迭代（与 scan 的 norm[i] 同口径， astral 字符也保持一致）
      for (let k = 0; k < entry.word.length; k++) {
        const ch = entry.word[k] as string;
        let nxt = nodes[cur]?.next.get(ch);
        if (nxt === undefined) {
          nxt = nodes.length;
          nodes.push({ next: new Map(), fail: 0, output: [] });
          nodes[cur]?.next.set(ch, nxt);
        }
        cur = nxt;
      }
      const node = nodes[cur];
      if (
        node &&
        !node.output.some((e) => e.word === entry.word && e.dictType === entry.dictType)
      ) {
        node.output.push(entry);
      }
    }
    // BFS 建 fail 链并合并后缀输出
    const queue: number[] = [];
    for (const child of nodes[0]?.next.values() ?? []) {
      nodes[child]!.fail = 0;
      queue.push(child);
    }
    for (let qi = 0; qi < queue.length; qi++) {
      const u = queue[qi] as number;
      for (const [ch, v] of nodes[u]?.next ?? []) {
        let f = nodes[u]!.fail;
        while (f !== 0 && !nodes[f]!.next.has(ch)) f = nodes[f]!.fail;
        nodes[v]!.fail = nodes[f]!.next.get(ch) ?? 0;
        nodes[v]!.output = [...nodes[v]!.output, ...nodes[nodes[v]!.fail]!.output];
        queue.push(v);
      }
    }
    return new AcMatcher(nodes);
  }

  /** 扫描文本（任意大小写，内部统一规范形）；命中去重（同词同库只报一次） */
  scan(text: string): AutomatonEntry[] {
    if (this.nodes.length === 1) return []; // 空词表（清空词库版本的合法形态）
    const norm = text.toLowerCase();
    const out = new Map<string, AutomatonEntry>();
    let state = 0;
    for (let i = 0; i < norm.length; i++) {
      const ch = norm[i] as string;
      // goto 沿 fail 链回退（失配无转移时停在根）
      for (;;) {
        const nxt = this.nodes[state]?.next.get(ch);
        if (nxt !== undefined) {
          state = nxt;
          break;
        }
        if (state === 0) break;
        state = this.nodes[state]!.fail;
      }
      const outputs = this.nodes[state]?.output;
      if (outputs !== undefined && outputs.length > 0) {
        for (const hit of outputs) {
          const key = `${hit.dictType}\u0000${hit.word}`;
          if (!out.has(key) && this.boundaryOk(norm, i, hit.word)) out.set(key, hit);
        }
      }
    }
    return [...out.values()];
  }

  /** ASCII 词边界：纯 [a-z0-9] 词两端不得邻接 [a-z0-9]；其余词无边界要求 */
  private boundaryOk(norm: string, end: number, word: string): boolean {
    if (!ASCII_WORD.test(word)) return true;
    const start = end - word.length + 1;
    if (start > 0 && ASCII_ALNUM.test(norm[start - 1] as string)) return false;
    if (end < norm.length - 1 && ASCII_ALNUM.test(norm[end + 1] as string)) return false;
    return true;
  }
}
