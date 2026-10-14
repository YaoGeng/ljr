import { describe, expect, it } from 'vitest';
import { AcMatcher } from './word-dict.automaton';
import type { DictType, WordAction } from './word-dict.types';

/**
 * H5 判定引擎内核（AC 自动机）纯单元测试（无 PG）：
 * 词命中/未命中、大小写规范、ASCII 词边界、去重、跨库同词、fail 链正确性（随机对拍朴素扫描）。
 * 三动作聚合/severity 语义在 word-dict.spec.ts（服务层）覆盖。
 */

interface EntrySpec {
  word: string;
  action: WordAction;
  dictType: DictType;
}

function build(entries: EntrySpec[]): AcMatcher {
  return AcMatcher.build(entries);
}

const words = (matcher: AcMatcher, text: string): string[] =>
  matcher
    .scan(text)
    .map((h) => h.word)
    .sort();

describe('H5 AC 自动机（判定引擎内核，纯单元）', () => {
  it('单词命中/未命中：命中返回 {word, action, dictType}；未命中返回空集', () => {
    const m = build([
      { word: '包赢', action: 'BLOCK', dictType: 'legal_industry' },
      { word: '内部渠道', action: 'MARK', dictType: 'legal_industry' },
    ]);
    expect(m.scan('这个方案包赢')).toEqual([
      { word: '包赢', action: 'BLOCK', dictType: 'legal_industry' },
    ]);
    expect(m.scan('这个方案很稳妥')).toEqual([]);
    expect(m.scan('')).toEqual([]);
  });

  it('大小写不敏感：词库小写规范形命中任意大小写文本；命中词以规范形回报', () => {
    const m = build([{ word: 'guaranteed', action: 'REVIEW', dictType: 'legal_industry' }]);
    expect(m.scan('100% GUARANTEED win')).toEqual([
      { word: 'guaranteed', action: 'REVIEW', dictType: 'legal_industry' },
    ]);
    expect(m.scan('GuArAnTeEd!')).toHaveLength(1);
    expect(m.scan('guarantee')).toEqual([]);
  });

  it('ASCII 词边界：子串不误伤（win 不命中 window）；独立出现命中；CJK 无边界要求', () => {
    const m = build([
      { word: 'win', action: 'REVIEW', dictType: 'legal_industry' },
      { word: '赢', action: 'BLOCK', dictType: 'legal_industry' },
    ]);
    expect(m.scan('window shopping')).toEqual([]);
    expect(m.scan('a win b')).toEqual([
      { word: 'win', action: 'REVIEW', dictType: 'legal_industry' },
    ]);
    expect(m.scan('win-win')).toHaveLength(1);
    // CJK 词无词界概念：嵌入长串即命中（稳赢 含 赢）
    expect(m.scan('稳赢方案')).toEqual([
      { word: '赢', action: 'BLOCK', dictType: 'legal_industry' },
    ]);
  });

  it('多次出现/重叠命中去重：同词只报一次；多词各自成条', () => {
    const m = build([
      { word: 'ab', action: 'MARK', dictType: 'illegal_content' },
      { word: 'abc', action: 'BLOCK', dictType: 'illegal_content' },
    ]);
    // ababab/abc 内的 ab 均处词内（ASCII 边界不命中）——独立出现各去重报一次
    expect(words(m, 'ab ab abc abc')).toEqual(['ab', 'abc']);
    expect(words(m, 'ababab abc')).toEqual(['abc']);
  });

  it('跨库同词：同词在两库不同 action 各自成条（聚合取最高由服务层负责）', () => {
    const m = build([
      { word: '代充', action: 'REVIEW', dictType: 'illegal_content' },
      { word: '代充', action: 'BLOCK', dictType: 'legal_industry' },
    ]);
    const hits = m.scan('需要代充吗');
    expect(hits).toHaveLength(2);
    expect(hits).toContainEqual({ word: '代充', action: 'REVIEW', dictType: 'illegal_content' });
    expect(hits).toContainEqual({ word: '代充', action: 'BLOCK', dictType: 'legal_industry' });
  });

  it('空词表匹配任何文本均为空集（清空词库版本的合法形态）', () => {
    expect(build([]).scan('任意文本包赢')).toEqual([]);
  });

  it('fail 链正确性：随机词表×随机文本与朴素扫描对拍（含 ASCII 边界语义，200 轮）', () => {
    // 确定伪随机（种子固定，可复现）
    let seed = 20261015;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const alphabet = ['a', 'b', '包', '赢'];
    const asciiAlnum = (w: string) => /^[a-z0-9]+$/.test(w);
    const naiveScan = (es: EntrySpec[], text: string): string[] => {
      const norm = text.toLowerCase();
      const out = new Set<string>();
      for (const e of es) {
        if (asciiAlnum(e.word)) {
          const re = new RegExp(`(?<![a-z0-9])${e.word}(?![a-z0-9])`);
          if (re.test(norm)) out.add(e.word);
        } else if (norm.includes(e.word)) {
          out.add(e.word);
        }
      }
      return [...out].sort();
    };
    for (let round = 0; round < 200; round++) {
      const es: EntrySpec[] = Array.from({ length: 1 + rand(12) }, () => {
        const len = 1 + rand(4);
        const w = Array.from({ length: len }, () => alphabet[rand(alphabet.length)]).join('');
        const action = (['BLOCK', 'REVIEW', 'MARK'] as const)[rand(3)] as WordAction;
        const dictType = (['illegal_content', 'legal_industry'] as const)[rand(2)] as DictType;
        return { word: w.toLowerCase(), action, dictType };
      });
      // 词表内去重（同词去重保一条）
      const unique = [...new Map(es.map((e) => [e.word, e])).values()];
      const text = Array.from(
        { length: 40 },
        () => alphabet.concat([' '])[rand(alphabet.length + 1)] as string,
      ).join('');
      const m = build(unique);
      expect(words(m, text)).toEqual(naiveScan(unique, text));
    }
  });
});
