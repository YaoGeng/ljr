/**
 * E1 草稿管线测试夹具（M2-W3 T4；fulfillment-fixture/job-fixture 同款纪律）：agent_assist 域
 * 两表直读（owner=agent_assist 合法）；fulfillment 域跨读一律经 fulfillment-fixture（spec 不
 * 内联他域表名——check-schema-refs 纪律）。仅供 *.spec.ts 使用，生产代码禁 import。
 * 评审修复环注记：CapturingLlmAdapter.noMarker=「R-04 标记缺失」违约注入位（I-1 用例锚）。
 */
import type { Pool } from 'pg';

/** drafts 全行直读（status/打点/去重断言锚；可按 room 过滤，id 升序） */
export async function draftRowsRaw(
  pool: Pool,
  opts?: { readonly roomId?: number },
): Promise<Record<string, unknown>[]> {
  const res =
    opts?.roomId === undefined
      ? await pool.query<Record<string, unknown>>(`SELECT * FROM agent_assist.drafts ORDER BY id`)
      : await pool.query<Record<string, unknown>>(
          `SELECT * FROM agent_assist.drafts WHERE room_id = $1 ORDER BY id`,
          [opts.roomId],
        );
  return res.rows;
}

/** agent_review_logs 全行直读（三动作/幂等/审查留痕断言锚；可按 draft 过滤，id 升序） */
export async function reviewLogRowsRaw(
  pool: Pool,
  opts?: { readonly draftId?: number },
): Promise<Record<string, unknown>[]> {
  const res =
    opts?.draftId === undefined
      ? await pool.query<Record<string, unknown>>(
          `SELECT * FROM agent_assist.agent_review_logs ORDER BY id`,
        )
      : await pool.query<Record<string, unknown>>(
          `SELECT * FROM agent_assist.agent_review_logs WHERE draft_id = $1 ORDER BY id`,
          [opts.draftId],
        );
  return res.rows;
}

/** 捕获型 LLM 适配器（R-02 断言锚：记录 generate 入参——进入 LLM 载荷的抽检断言事实源；
 *  fail=故障注入开关（W3-7 降级/恢复用例运行中翻转）；noMarker=输出缺 R-04 标记的违约注入
 *  （评审修复环 I-1 用例锚——管线级强制断言的驱动面），固定出稿缺省含 R-04 标记） */
export class CapturingLlmAdapter {
  public fail = false;
  public noMarker = false;
  public readonly calls: Array<{
    readonly questionDigest: string;
    readonly intent: string;
    readonly hitCount: number;
    readonly raw: unknown;
  }> = [];

  async generate(input: {
    readonly questionDigest: string;
    readonly intent: string;
    readonly hits: readonly unknown[];
  }): Promise<{ readonly content: string }> {
    if (this.fail) throw new Error('CapturingLlmAdapter 故障注入（测试）');
    this.calls.push({
      questionDigest: input.questionDigest,
      intent: input.intent,
      hitCount: input.hits.length,
      raw: input,
    });
    if (this.noMarker) {
      return { content: '适配器违约输出：无标记草稿正文（I-1 注入）' };
    }
    return { content: '【AI 辅助，仅供参考】捕获适配器固定草稿（测试锚）' };
  }
}
