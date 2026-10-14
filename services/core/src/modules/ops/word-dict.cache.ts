/**
 * 词库自动机进程内缓存（Ruling-3 同款：dev 无 Redis——进程内缓存 + 版本号驱动失效）。
 *
 * 与 H7 现行版缓存的分工：本缓存持有「已编译的自动机 + BLOCK 词集」，**不自带 TTL**——每次
 * 判定前以 H7 currentVersion（进程内缓存，写路径即时失效）的版本号比对驱动重建：
 *   - 本进程词库更新（putDictionary→createLexiconVersion）：H7 写路径逐 key 失效 → 版本号变化
 *     → 下一次判定即时重建（验收口径「更新 1min 内生效」以**即时**满足，报告注明）；
 *   - 跨进程盲区（多实例部署下他实例更新）：由 H7 现行版缓存的 currentCacheTtlMs（缺省 60s）
 *     安全网兜底——⚠与 §3「Redis 全量缓存」的差异=R3 裁决的外部对接后置口径，Redis/多节点
 *     一致实现位 M2+（经 DictionaryUpdated 事件消费换装）。
 */
import { Injectable } from '@nestjs/common';
import type { AcMatcher } from './word-dict.automaton';
import type { DictType } from './word-dict.types';

/** 单词库已加载快照（version=0=尚无生效版本，空自动机合法形态） */
export interface LoadedDictionary {
  readonly version: number;
  readonly matcher: AcMatcher;
  /** 该版本 action=BLOCK 的词集（小写规范形，升序；E1 硬拦词集消费的事实源） */
  readonly blockWords: readonly string[];
}

@Injectable()
export class WordDictAutomatonCache {
  private readonly entries = new Map<DictType, LoadedDictionary>();

  get(dictType: DictType): LoadedDictionary | undefined {
    return this.entries.get(dictType);
  }

  set(dictType: DictType, loaded: LoadedDictionary): void {
    this.entries.set(dictType, loaded);
  }

  /** 清空（用例隔离/换装复位用；生产运行期靠版本号比对，不主动清） */
  clear(): void {
    this.entries.clear();
  }
}
