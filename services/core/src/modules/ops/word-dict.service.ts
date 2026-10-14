/**
 * H5 风控与敏感词管理服务——W1 词库切片（机制核心）：
 *   - 双词库管理（§2 illegal_content/legal_industry，§5 GET/PUT /admin/risk/dictionaries，
 *     幂等键=dict+base_version，400 E_DUP_WORD）；
 *   - 词库热更新走 H7 版本化（R-03 免公示通道 createLexiconVersion，正文=rule_definitions
 *     wordlist.* 的 content jsonb——R14 裁决的版本化唯一事实源）+ DictionaryUpdated 同事务出箱（§6）；
 *   - 同步判定 CHECK_RISK（§5 内部 API 无 HTTP，D5 发送路径消费，P95 ≤50ms=热路径进程内零 DB）：
 *     词级三级 action（BLOCK→拦截；REVIEW→放行+risk_records 记录；MARK→放行+标记），聚合取最高
 *     severity，判定引擎=进程内 AC 自动机（word-dict.automaton，版本号比对驱动重建）。
 *
 * 施工规格：docs/modules/H-运营后台/H5-风控与敏感词管理.md；只写 ops.* 表（边界纪律）；词表
 * 经 H7 机制 API（currentVersion/createLexiconVersion）取，不直查 rule_definitions。
 *
 * ⚠M2 后置位（H5 §1/§2/§4 与计划序列明文）：人审工单闭环（queue/review REST）、MQ 二次模型
 * 复核（消费 MessageSent→补拦截，RiskBlocked 生产）、定期巡查抽样——本批不建机制，事件注释位
 * 见 word-dict.events.ts。语音/视频事后审核=V2 边界（R-04 标注）。
 */
import { Injectable } from '@nestjs/common';
import { AppError, ErrorCode } from '@ljr/shared';
import { OutboxService } from '../../infrastructure/outbox/outbox.service';
import { PgPoolService } from '../../infrastructure/sql';
import { RuleCenterService } from './rule-center.service';
import { AcMatcher, type AutomatonEntry } from './word-dict.automaton';
import { WordDictAutomatonCache, type LoadedDictionary } from './word-dict.cache';
import { DICTIONARY_UPDATED_TOPIC, type DictionaryUpdatedPayload } from './word-dict.events';
import type {
  CheckRiskInput,
  CheckRiskResult,
  DictionaryView,
  DictType,
  PutDictionaryInput,
  PutDictionaryResult,
  RiskHit,
} from './word-dict.types';
import { DICT_TYPES, WORD_ACTION_SEVERITY, wordlistRuleKey } from './word-dict.types';
import {
  assertBaseVersion,
  assertDictType,
  canonicalJson,
  normalizeWordEntries,
  parseLexiconContent,
  toLexiconContent,
} from './word-dict.validate';

@Injectable()
export class WordDictService {
  constructor(
    private readonly pool: PgPoolService,
    private readonly outbox: OutboxService,
    // 词库版本化唯一事实源（H7 机制 API——免公示通道写入 + 现行版查询；不直查 rule_definitions）
    private readonly rules: RuleCenterService,
    private readonly cache: WordDictAutomatonCache,
  ) {}

  // ---------- 管理面（§5 GET/PUT /admin/risk/dictionaries，幂等键=dict+base_version） ----------

  /**
   * 词库提交（PUT 机制面）：base_version=调用方所见当前版本（0=尚无版本），写入版本恒=
   * base_version+1（乐观并发）。语义：
   *   - 重放（写入目标版本=在册版本且内容 canonical 全等——词集规范化后与顺序/大小写无关）
   *     ⇒ 幂等回读 created:false（§5 幂等键=dict+base_version，createDraft 先例）；
   *   - base_version 落后/超前在册版本 ⇒ 409 E_CONFLICT（过期基数，客户端重取后重试；
   *     并发窗口的残余竞态由 H7 UNIQUE(rule_key,version) 兜底冒泡 E_RULE_PUBLISHING）；
   *   - 词库内重复词（大小写不敏感）⇒ 400 E_DUP_WORD（校验在 word-dict.validate）。
   * 写入=createLexiconVersion（创建即 EFFECTIVE+STL lexicon_publish_freeze 审计）与
   * DictionaryUpdated（§6）同事务；提交后进程内自动机即时重建（版本号比对驱动失效）。
   */
  async putDictionary(input: PutDictionaryInput): Promise<PutDictionaryResult> {
    assertDictType(input.dictType);
    assertBaseVersion(input.baseVersion);
    const entries = normalizeWordEntries(input.words);
    const content = toLexiconContent(entries);
    const ruleKey = wordlistRuleKey(input.dictType);
    const canonical = canonicalJson(content);
    const current = await this.rules.currentVersion(ruleKey);
    const currentVersion = current?.version ?? 0;
    const targetVersion = input.baseVersion + 1;
    if (current !== null && currentVersion === targetVersion) {
      // 重放路径：目标版本已在册且内容全等 ⇒ 幂等回读（不发事件、不重建版本）
      if (canonicalJson(current.content) === canonical) {
        return {
          dictType: input.dictType,
          ruleKey,
          version: currentVersion,
          effectiveAt: this.assertEffectiveAt(current),
          wordCount: entries.length,
          created: false,
        };
      }
      throw new AppError(
        ErrorCode.Conflict,
        `base_version 过期：${ruleKey} 当前 v${currentVersion}（内容与提交不等），调用方基于 v${input.baseVersion}`,
      );
    }
    if (currentVersion !== input.baseVersion) {
      throw new AppError(
        ErrorCode.Conflict,
        `base_version 过期：${ruleKey} 当前 v${currentVersion}，调用方基于 v${input.baseVersion}（重取后重试）`,
      );
    }
    const view = await this.pool.withTransaction(async (uow) => {
      // 免公示通道：创建即 EFFECTIVE（STL lexicon_publish_freeze 审计）；ON CONFLICT DO
      // NOTHING 保证冲突不毒化本事务（409 干净交还）
      const created = await this.rules.createLexiconVersion(uow, {
        ruleKey,
        version: targetVersion,
        content,
      });
      // §6：DictionaryUpdated 与词库版本写入同事务（业务回滚则事件不出）
      await this.outbox.recordOutbox(uow, {
        type: DICTIONARY_UPDATED_TOPIC,
        payload: {
          rule_key: ruleKey,
          rule_version: targetVersion,
          dict_type: input.dictType,
          effective_at: this.assertEffectiveAt(created).toISOString(),
        } satisfies DictionaryUpdatedPayload,
      });
      return created;
    });
    // 进程内自动机即时重建（H7 写路径已失效现行版缓存，此处预编译=更新即生效，勿等首次判定）
    await this.ensureLoaded(input.dictType);
    return {
      dictType: input.dictType,
      ruleKey,
      version: targetVersion,
      effectiveAt: this.assertEffectiveAt(view),
      wordCount: entries.length,
      created: true,
    };
  }

  /** 管理面视图（GET 机制面）：当前生效版本；尚无版本 ⇒ version=0、words=[]（确定性契约） */
  async getDictionaries(dictType?: DictType): Promise<DictionaryView[]> {
    const dicts = this.resolveDicts(dictType);
    const views: DictionaryView[] = [];
    for (const d of dicts) {
      const ruleKey = wordlistRuleKey(d);
      const current = await this.rules.currentVersion(ruleKey);
      views.push(
        current === null
          ? { dictType: d, ruleKey, version: 0, effectiveAt: null, words: [] }
          : {
              dictType: d,
              ruleKey,
              version: current.version,
              effectiveAt: current.effectiveAt,
              words: parseLexiconContent(current.content).words,
            },
      );
    }
    return views;
  }

  // ---------- 同步判定（§5 CHECK_RISK 内部 API，无 HTTP；D5 发送路径消费，P95 ≤50ms） ----------

  /**
   * 统一链路判定入口（R-02：房间/私聊/1对1 所有文本会话共用此单入口，判定与会话形态无关）。
   * 聚合处置=命中里最高 severity（BLOCK>REVIEW>MARK）；无命中=PASS。副作用唯一=REVIEW 命中
   * 落 ops.risk_records（每库一行，word_hits 带命中时词库版本审计位；自持短事务——W1 判定
   * 先于消息落库，message_id 由 M2 D5 接入时补关联 ⚠；D5 M2 若需与发送同事务可改 uow 形态）。
   * 热路径（无 REVIEW 命中）零 DB：词库自动机经版本号比对保持进程内热（ensureLoaded 仅在
   * 版本变化时回源+重建）。
   */
  async checkRisk(input: CheckRiskInput): Promise<CheckRiskResult> {
    if (typeof input.content !== 'string') {
      throw new AppError(ErrorCode.InvalidArgument, `content 须为字符串：${typeof input.content}`);
    }
    if (
      input.conversationId !== undefined &&
      (!Number.isSafeInteger(input.conversationId) || input.conversationId <= 0)
    ) {
      throw new AppError(
        ErrorCode.InvalidArgument,
        `conversationId 须为正整数：${String(input.conversationId)}`,
      );
    }
    if (input.content.length === 0) return { action: 'PASS', hits: [] };
    const loaded = new Map<DictType, LoadedDictionary>();
    const rawHits: AutomatonEntry[] = [];
    for (const dictType of DICT_TYPES) {
      const snapshot = await this.ensureLoaded(dictType);
      loaded.set(dictType, snapshot);
      rawHits.push(...snapshot.matcher.scan(input.content));
    }
    if (rawHits.length === 0) return { action: 'PASS', hits: [] };
    // 聚合取最高 severity；同 severity 按词序（确定性出参）
    const hits: RiskHit[] = rawHits
      .sort(
        (a, b) =>
          WORD_ACTION_SEVERITY[b.action] - WORD_ACTION_SEVERITY[a.action] ||
          (a.word < b.word ? -1 : a.word > b.word ? 1 : 0),
      )
      .map((h) => ({ word: h.word, action: h.action, dictType: h.dictType }));
    const action = hits[0]!.action;
    // REVIEW 命中落记录（每库一行；word_hits 只记该库 REVIEW 集 + 命中时词库版本）
    const reviewByDict = new Map<DictType, RiskHit[]>();
    for (const hit of hits) {
      if (hit.action !== 'REVIEW') continue;
      const list = reviewByDict.get(hit.dictType) ?? [];
      list.push(hit);
      reviewByDict.set(hit.dictType, list);
    }
    if (reviewByDict.size > 0) {
      await this.pool.withTransaction(async (uow) => {
        for (const [dictType, reviewHits] of reviewByDict) {
          await uow.query(
            `INSERT INTO ops.risk_records (conversation_id, dict_type, word_hits, action)
             VALUES ($1, $2, $3::jsonb, 'REVIEW')`,
            [
              input.conversationId ?? null,
              dictType,
              JSON.stringify(
                reviewHits.map((h) => ({
                  word: h.word,
                  action: h.action,
                  rule_version: loaded.get(dictType)?.version ?? null,
                })),
              ),
            ],
          );
        }
      });
    }
    return { action, hits };
  }

  // ---------- E1 硬拦词集消费接口（Task 7 敏感话术硬拦；签名明示于任务报告） ----------

  /**
   * 当前生效词库中 action=BLOCK 的词集（小写规范形，升序；缺省两库合并，可按库过滤——E1 的
   * 「承诺结果/包赢类」词集=legal_industry 库 BLOCK 集，R-05 专项词表所在库）。词库更新即
   * 反映（同一版本号缓存）；无生效版本 ⇒ 空集（E1 侧自行决定兜底语义）。
   */
  async currentBlockWords(dictType?: DictType): Promise<readonly string[]> {
    const out: string[] = [];
    for (const d of this.resolveDicts(dictType)) {
      out.push(...(await this.ensureLoaded(d)).blockWords);
    }
    return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  }

  // ---------- 内部件 ----------

  private resolveDicts(dictType: string | undefined): readonly DictType[] {
    if (dictType === undefined) return DICT_TYPES;
    assertDictType(dictType);
    return [dictType];
  }

  /**
   * wordlist.* 行的生效时刻不变量（V7：免公示通道创建即落 effective_at）——违例=InternalError
   * 显性化（同 parseNoticeContent 口径），不静默以 null 参与出参/事件。
   */
  private assertEffectiveAt(view: { readonly effectiveAt: Date | null }): Date {
    if (view.effectiveAt === null) {
      throw new AppError(ErrorCode.InternalError, '词库版本缺生效时刻（不变量破坏）');
    }
    return view.effectiveAt;
  }

  /**
   * 加载/校对单词库自动机快照：以 H7 currentVersion（进程内缓存，写路径即时失效）的版本号
   * 比对驱动重建——版本一致直接用缓存（热路径零 DB），不一致才回源+重编译。
   */
  private async ensureLoaded(dictType: DictType): Promise<LoadedDictionary> {
    const ruleKey = wordlistRuleKey(dictType);
    const current = await this.rules.currentVersion(ruleKey);
    const version = current?.version ?? 0;
    const cached = this.cache.get(dictType);
    if (cached !== undefined && cached.version === version) return cached;
    const entries = current === null ? [] : parseLexiconContent(current.content).words;
    const automatonEntries: AutomatonEntry[] = entries.map((e) => ({
      word: e.word,
      action: e.action,
      dictType,
    }));
    const loaded: LoadedDictionary = {
      version,
      matcher: AcMatcher.build(automatonEntries),
      blockWords: entries.filter((e) => e.action === 'BLOCK').map((e) => e.word),
    };
    this.cache.set(dictType, loaded);
    return loaded;
  }
}
