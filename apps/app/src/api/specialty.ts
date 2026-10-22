/**
 * E3 专项问题树 API（M3-W1 T3）：GET /specialty/question-tree?key=（公开只读，无鉴权）：
 *   出参 {specialty, version, questionTree:{root, nodes:[{id,label,children}]}}；
 *   未配置/未知 key=404（E_NOT_FOUND）；空树={root:'',nodes:[]}（seed 初始态）——
 *   两者均属「引导不可用」，视图层空态引导承载（fail-visible，不造默认树）。
 *
 * C2 §2 消费口径：问题树=结构化问题标签引导（多选+补充）——节点 label 即 question_tags
 * 词汇（≤64 字符与 C2 值域一致）；本层只做形状防御，答案→表单映射在视图层（保守直译）。
 * 本模块保持平台无关（无 react-native import），bun test 直接可测。
 */
import { AppClientErrorCode, apiFetch, AppApiError } from './client';

/** E3 QuestionTreeNode 实文（children 顺序即展示顺序） */
export interface QuestionTreeNode {
  readonly id: string;
  readonly label: string;
  readonly children: readonly string[];
}

export interface QuestionTree {
  readonly root: string;
  readonly nodes: readonly QuestionTreeNode[];
}

export interface SpecialtyQuestionTreeView {
  readonly specialty: string;
  readonly version: number;
  readonly questionTree: QuestionTree;
}

/** V1 在册专项 key（E3 SUPPORTED_SPECIALTIES 实文；R-04：V2 才新增） */
export const SPECIALTY_KEY_LABOR = 'labor_arbitration';

function badShape(detail: string): AppApiError {
  return new AppApiError({
    code: AppClientErrorCode.BadResponseBody,
    copy: '服务响应异常，请稍后重试',
    serverMessage: `问题树响应形状非法：${detail}`,
  });
}

const NODE_ID_PATTERN = /^[a-z0-9_-]{1,64}$/;

function parseNode(raw: unknown): QuestionTreeNode {
  if (typeof raw !== 'object' || raw === null) throw badShape('节点非对象');
  const r = raw as Record<string, unknown>;
  if (typeof r['id'] !== 'string' || !NODE_ID_PATTERN.test(r['id'])) {
    throw badShape(`节点 id 形态非法：${JSON.stringify(r['id'])}`);
  }
  if (typeof r['label'] !== 'string' || r['label'].trim().length === 0) {
    throw badShape(`节点 ${String(r['id'])} label 非非空字符串`);
  }
  if (!Array.isArray(r['children'])) throw badShape(`节点 ${String(r['id'])} children 非数组`);
  for (const child of r['children']) {
    if (typeof child !== 'string' || !NODE_ID_PATTERN.test(child)) {
      throw badShape(`节点 ${String(r['id'])} children 引用形态非法：${JSON.stringify(child)}`);
    }
  }
  return { id: r['id'], label: r['label'], children: [...(r['children'] as readonly string[])] };
}

function parseTree(raw: unknown): QuestionTree {
  if (typeof raw !== 'object' || raw === null) throw badShape('questionTree 非对象');
  const r = raw as Record<string, unknown>;
  if (typeof r['root'] !== 'string') throw badShape('root 非字符串');
  if (!Array.isArray(r['nodes'])) throw badShape('nodes 非数组');
  return { root: r['root'], nodes: r['nodes'].map(parseNode) };
}

/** GET /specialty/question-tree?key=：当前问题树 + version（未知 key/未配置 → 404 AppApiError 上抛） */
export async function fetchQuestionTree(key: string): Promise<SpecialtyQuestionTreeView> {
  if (typeof key !== 'string' || key.length === 0) {
    throw new AppApiError({
      code: AppClientErrorCode.BadRequest,
      copy: '请求参数有误，请返回重试',
      serverMessage: `专项 key 非非空字符串：${String(key)}`,
    });
  }
  const raw = await apiFetch<unknown>(`/specialty/question-tree?key=${encodeURIComponent(key)}`);
  if (typeof raw !== 'object' || raw === null) throw badShape('响应非对象');
  const r = raw as Record<string, unknown>;
  if (typeof r['specialty'] !== 'string' || r['specialty'].length === 0) {
    throw badShape('specialty 非非空字符串');
  }
  if (typeof r['version'] !== 'number' || !Number.isInteger(r['version']) || r['version'] < 0) {
    throw badShape('version 非非负整数');
  }
  const tree = parseTree(r['questionTree']);
  if (!isEmptyTree(tree)) {
    // 完整性：节点 id 唯一（treeNodeIndex 抛 badShape）+ 非空树的 root 须在节点集
    const index = treeNodeIndex(tree);
    if (!index.has(tree.root)) throw badShape(`root 不在节点集：${JSON.stringify(tree.root)}`);
  }
  return { specialty: r['specialty'], version: r['version'], questionTree: tree };
}

/** 空树判定（{root:'',nodes:[]} = seed/未配置语义——引导页据此走空态） */
export function isEmptyTree(tree: QuestionTree): boolean {
  return tree.root === '' && tree.nodes.length === 0;
}

/** id → 节点索引（树渲染/校验用；重复 id 视为形状非法 fail-visible） */
export function treeNodeIndex(tree: QuestionTree): ReadonlyMap<string, QuestionTreeNode> {
  const map = new Map<string, QuestionTreeNode>();
  for (const node of tree.nodes) {
    if (map.has(node.id)) throw badShape(`节点 id 重复：${node.id}`);
    map.set(node.id, node);
  }
  return map;
}
