/**
 * 现行版缓存（H7 §8「快照查询 P95 ≤30ms（缓存现行版+版本号失效）」）。
 *
 * Ruling-3 同款：dev 无 Redis——默认实现=进程内 Map（现行版 + 负缓存）+ 写路径逐 key 失效
 * （版本号失效口径：任何使某 key 现行版解析结果改变的写路径——创建/提交公示/废弃/生效迁移/
 * 免公示通道——都 invalidate 该 key）；TTL 仅作跨进程/跨节点盲区的安全网（配置可关）。
 * Redis/多节点一致实现位=M2+：经 RULE_CURRENT_CACHE port 换装，服务层只依赖 port。
 *
 * 行为时快照（snapshotAt）不走缓存——历史时刻查询无现行版语义，索引点查本身满足 P95 预算。
 */
import { InjectionToken } from '@nestjs/common';
import type { RuleDefinitionView } from './rule-center.types';

/** 现行版缓存 port：get 返回 undefined=未命中；null=已缓存的「无生效版本」负缓存 */
export interface RuleCurrentCachePort {
  get(ruleKey: string): RuleDefinitionView | null | undefined;
  set(ruleKey: string, view: RuleDefinitionView | null): void;
  invalidate(ruleKey: string): void;
  clear(): void;
  /** 观测位（H4 看板/测试断言用）：命中/未命中/失效计数 */
  readonly stats: Readonly<{ hits: number; misses: number; invalidations: number }>;
}

/** 缓存 DI 令牌（测试可 override 注桩；module 缺省装 InProcessRuleCurrentCache） */
export const RULE_CURRENT_CACHE: InjectionToken<RuleCurrentCachePort> =
  Symbol('RULE_CURRENT_CACHE');

export class InProcessRuleCurrentCache implements RuleCurrentCachePort {
  private readonly entries = new Map<
    string,
    { view: RuleDefinitionView | null; storedAt: number }
  >();
  readonly stats = { hits: 0, misses: 0, invalidations: 0 };

  constructor(private readonly ttlMs: number) {}

  get(ruleKey: string): RuleDefinitionView | null | undefined {
    const entry = this.entries.get(ruleKey);
    if (entry === undefined) {
      this.stats.misses += 1;
      return undefined;
    }
    if (this.ttlMs > 0 && Date.now() - entry.storedAt > this.ttlMs) {
      this.entries.delete(ruleKey);
      this.stats.misses += 1;
      return undefined;
    }
    this.stats.hits += 1;
    return entry.view;
  }

  set(ruleKey: string, view: RuleDefinitionView | null): void {
    this.entries.set(ruleKey, { view, storedAt: Date.now() });
  }

  /** 逐 key 失效（计数按调用次数——失效请求量观测位，无论命中与否） */
  invalidate(ruleKey: string): void {
    this.entries.delete(ruleKey);
    this.stats.invalidations += 1;
  }

  /** 清空条目并归零计数（用例隔离/换装复位用；生产运行期不调用） */
  clear(): void {
    this.entries.clear();
    this.stats.hits = 0;
    this.stats.misses = 0;
    this.stats.invalidations = 0;
  }
}
