import { describe, expect, it } from 'vitest';
import { AppError, ErrorCode } from '@ljr/shared';
import { DRAFT_MACHINE } from './draft.machine';
import { MockLlmAdapter } from './llm.adapter';

/**
 * E1 草稿状态机（draft.machine）五态边表 + MockLlmAdapter（llm.adapter）确定性模板与故障
 * 注入——纯函数件（knowledge.machine.spec 同形，无 DB）。
 */
describe('E1 草稿状态机（draft.machine：PENDING 四出边、后四态终态）', () => {
  it('PENDING→SENT/EDITED_SENT/DISCARDED/EXPIRED 四边放行（守卫+STL 词汇=V48 ck 逐字）', () => {
    for (const to of ['SENT', 'EDITED_SENT', 'DISCARDED', 'EXPIRED'] as const) {
      expect(DRAFT_MACHINE.canTransition('PENDING', to)).toBe(true);
      expect(() => DRAFT_MACHINE.assertTransition('PENDING', to)).not.toThrow();
    }
  });

  it('后四态终态无出边：任何再迁移 409 StateIllegalTransition（含终态间横跳与回环）', () => {
    const terminals = ['SENT', 'EDITED_SENT', 'DISCARDED', 'EXPIRED'] as const;
    for (const from of terminals) {
      for (const to of ['PENDING', ...terminals] as const) {
        expect(() => DRAFT_MACHINE.assertTransition(from, to)).toThrow(
          expect.objectContaining({ code: ErrorCode.StateIllegalTransition }) as never,
        );
      }
      expect(() => DRAFT_MACHINE.assertTransition(from, from)).toThrow(AppError);
    }
  });
});

describe('E1 MockLlmAdapter（llm.adapter：R-04 标记+知识引用+故障注入）', () => {
  it('生成含「AI 辅助，仅供参考」标记与审查提示尾；命中知识 chunk 摘要引用（标题+前 80 字）', async () => {
    const adapter = new MockLlmAdapter();
    const out = await adapter.generate({
      questionDigest: '公司拖欠工资三个月怎么办',
      intent: 'general',
      hits: [
        {
          chunk:
            '劳动仲裁申请书应当载明劳动者姓名、性别、年龄、工作单位等信息，并向劳动合同履行地或用人单位所在地的仲裁委员会提交。',
          score: 0.9,
          docId: 3,
          docTitle: '劳动仲裁申请指引',
          sourceType: 'official',
          chunkIndex: 2,
          metadata: {},
        },
      ],
    });
    expect(out.content).toContain('【AI 辅助，仅供参考】'); // R-04 标记
    expect(out.content).toContain('请律师审查修改后使用'); // R-05 审查提示尾
    expect(out.content).toContain('《劳动仲裁申请指引》'); // 命中引用（docTitle）
    expect(out.content).toContain('劳动仲裁申请书应当载明'); // chunk 摘要（前 80 字）
    expect(out.content).toContain('第 3 块'); // chunkIndex+1
  });

  it('无命中容忍（空 hits=「暂无知识库命中」话术）；同输入同输出（确定性零网络）', async () => {
    const adapter = new MockLlmAdapter();
    const input = {
      questionDigest: '被辞退了如何维权',
      intent: 'general',
      hits: [],
    };
    const a = await adapter.generate(input);
    const b = await adapter.generate(input);
    expect(a.content).toBe(b.content);
    expect(a.content).toContain('暂无知识库命中');
  });

  it('故障注入：构造参 fail / 公开字段运行中翻转（降级→恢复两态用例锚）——抛 Error 供管线降级', async () => {
    const adapter = new MockLlmAdapter({ fail: true });
    await expect(
      adapter.generate({ questionDigest: 'q', intent: 'general', hits: [] }),
    ).rejects.toThrow('故障注入');
    adapter.fail = false; // 运行中恢复（W3-7：下一条消息自然重跑的测试面）
    await expect(
      adapter.generate({ questionDigest: 'q', intent: 'general', hits: [] }),
    ).resolves.toHaveProperty('content');
  });
});
