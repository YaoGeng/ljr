import { beforeEach, describe, expect, it } from 'bun:test';
import { ErrorCode } from '@ljr/shared';
import { isAppApiError } from './client';
import { setApiBaseUrl } from './config';
import { fetchQuestionTree, isEmptyTree, treeNodeIndex } from './specialty';
import { jsonResponse, stubFetch } from './test-helpers';

const TREE_BODY = {
  specialty: 'labor_arbitration',
  version: 1,
  questionTree: {
    root: 'dispute',
    nodes: [
      { id: 'dispute', label: '你的劳动争议类型？', children: ['wage', 'termination'] },
      { id: 'wage', label: '拖欠工资', children: [] },
      { id: 'termination', label: '违法解除', children: ['severance'] },
      { id: 'severance', label: '赔偿金 (2N)', children: [] },
    ],
  },
};

beforeEach(() => {
  setApiBaseUrl('http://core.test');
});

describe('E3 问题树 API（GET /specialty/question-tree）', () => {
  it('正常链：树形状解析（含嵌套 children）+ key 经 URL 编码拼接', async () => {
    const seen = stubFetch([jsonResponse(200, TREE_BODY)]);
    const r = await fetchQuestionTree('labor_arbitration');
    expect(r.version).toBe(1);
    expect(r.questionTree.nodes).toHaveLength(4);
    const index = treeNodeIndex(r.questionTree);
    expect(index.get('termination')?.children).toEqual(['severance']);
    expect(seen[0]?.url).toBe('http://core.test/specialty/question-tree?key=labor_arbitration');
  });

  it('未配置专项 → 404 E_NOT_FOUND 上抛（视图层空态引导承载）', async () => {
    stubFetch([jsonResponse(404, { code: ErrorCode.NotFound, message: '专项配置不存在' })]);
    const err = (await fetchQuestionTree('labor_arbitration').then(
      () => null,
      (e: unknown) => e,
    )) as { code: string; httpStatus: number };
    expect(isAppApiError(err)).toBe(true);
    expect(err.code).toBe('E_NOT_FOUND');
    expect(err.httpStatus).toBe(404);
  });

  it('空树判定（{root:"",nodes:[]} = seed 初始态）', () => {
    expect(isEmptyTree({ root: '', nodes: [] })).toBe(true);
    expect(isEmptyTree(TREE_BODY.questionTree)).toBe(false);
  });

  it('形状防御：节点 id 重复 / children 引用非法 → CLIENT_BAD_RESPONSE', async () => {
    stubFetch([
      jsonResponse(200, {
        ...TREE_BODY,
        questionTree: {
          root: 'dispute',
          nodes: [
            { id: 'dispute', label: '题干', children: [] },
            { id: 'dispute', label: '重复', children: [] },
          ],
        },
      }),
    ]);
    const err = (await fetchQuestionTree('labor_arbitration').then(
      () => null,
      (e: unknown) => e,
    )) as { code: string };
    expect(err.code).toBe('CLIENT_BAD_RESPONSE');
  });

  it('本地入参拒绝（空 key）→ CLIENT_BAD_REQUEST 不发请求', async () => {
    const seen = stubFetch([]);
    const err = (await fetchQuestionTree('').then(
      () => null,
      (e: unknown) => e,
    )) as { code: string };
    expect(err.code).toBe('CLIENT_BAD_REQUEST');
    expect(seen).toHaveLength(0);
  });
});
