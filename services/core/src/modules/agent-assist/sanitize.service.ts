/**
 * E1 实时脱敏层——服务面（机制 API，无 HTTP；M2 草稿管线消费）：
 *   sanitize({ text, persistAudit? }) → { sanitized, placeholders, hits, ruleVersion, durationMs, auditId }
 *
 * 职责=纯引擎（sanitize.rules，零 IO）+ 命中审计（agent_assist.sanitize_audit，V10）：
 *   - 审计只存 sha256 摘要/命中类型计数/耗时/规则集版本——原文明文零出现（本模块存在意义，
 *     spec 断言行级内容），支撑 E1 §10「进入 LLM 的载荷抽检断言」与 §8 各段耗时打点；
 *   - durationMs 只计脱敏本体（引擎+构造），不含审计写——§8「脱敏 ≤1s」预算口径；
 *   - 审计写入失败走旁路（warn 不含原文，脱敏结果照常返回）：审计是抽检增益，丢失不构成
 *     R-02 违规；脱敏失败才是管线级故障（引擎不变量由回归集把门）。
 *
 * ⚠M2 后置位：MQ 消费/意图/RAG/LLM/气泡推送/drafts 表/审查日志/敏感话术硬拦（H5 词集
 * currentBlockWords 消费位已留）/NER 模型追加——本批均不建（计划明文裁切）。
 */
import { Inject, Injectable } from '@nestjs/common';
import { AppError, ErrorCode } from '@ljr/shared';
import { PgPoolService } from '../../infrastructure/sql';
import { TRACE_LOGGER } from '../../observability/observability.module';
import type { TraceLogger } from '../../observability/trace-logger';
import { sanitizeText, sha256Hex } from './sanitize.rules';
import type { SanitizeInput, SanitizeResult } from './sanitize.types';

@Injectable()
export class SanitizeService {
  constructor(
    private readonly pool: PgPoolService,
    // 审计旁路的运维侧 warn（审计行是事实源；logger 为增益，测试注桩/可缺省）
    @Inject(TRACE_LOGGER) private readonly logger: TraceLogger,
  ) {}

  /**
   * 实时脱敏（E1 §4 管线第一段，§8 预算 ≤1s）：确定性替换 + 命中审计（缺省落库）。
   * 同输入同输出（引擎零随机/零时钟）；审计行仅在 hits>0 且 persistAudit!==false 时写入，
   * 返回 auditId 供 M2 管线与 drafts/审查日志关联（本批无消费方，结构留位）。
   */
  async sanitize(input: SanitizeInput): Promise<SanitizeResult> {
    if (typeof input.text !== 'string') {
      throw new AppError(ErrorCode.InvalidArgument, `text 须为字符串：${typeof input.text}`);
    }
    const startedAt = Date.now();
    const pure = sanitizeText(input.text);
    const durationMs = Date.now() - startedAt;
    let auditId: number | null = null;
    if ((input.persistAudit ?? true) && pure.hits.length > 0) {
      auditId = await this.writeAudit(pure.sanitized, input.text, pure, durationMs);
    }
    return { ...pure, durationMs, auditId };
  }

  /**
   * 命中审计落 sanitize_audit（抽检事实源）：入参=脱敏前摘要（sha256，原文不落库）与脱敏后
   * 摘要。写入失败旁路（warn 不含原文，只含摘要/版本/计数）——审计丢失可由抽检告警发现，
   * 不得反噬脱敏主路径（R-02 的优先级是「原文不进 LLM」，审计是观测面）。
   */
  private async writeAudit(
    sanitized: string,
    originalText: string,
    pure: { readonly hits: readonly { readonly type: string }[]; readonly ruleVersion: string },
    durationMs: number,
  ): Promise<number | null> {
    const hitTypes = Object.entries(
      pure.hits.reduce<Record<string, number>>((acc, h) => {
        acc[h.type] = (acc[h.type] ?? 0) + 1;
        return acc;
      }, {}),
    ).map(([type, count]) => ({ type, count }));
    try {
      const res = await this.pool.query<{ id: string }>(
        `INSERT INTO agent_assist.sanitize_audit
           (rule_version, input_digest, output_digest, hit_types, duration_ms)
         VALUES ($1, $2, $3, $4::jsonb, $5) RETURNING id`,
        [
          pure.ruleVersion,
          sha256Hex(originalText),
          sha256Hex(sanitized),
          JSON.stringify(hitTypes),
          durationMs,
        ],
      );
      const id = res.rows[0]?.id;
      return id === undefined ? null : Number(id);
    } catch (e) {
      this.logger.warn('sanitize_audit 写入失败（脱敏结果不受影响）', {
        rule_version: pure.ruleVersion,
        hit_count: pure.hits.length,
        error: String(e),
      });
      return null;
    }
  }
}
