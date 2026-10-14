/**
 * E3 校验与内容结构（纯函数，服务层与 HTTP 入参解析共用；形态沿 rule-center/word-dict.validate）。
 *
 * 读端口径（宁炸不降级，parseNoticeContent/parseLexiconContent 同款）：经管理面写入的结构由
 * normalize* 保证；经其它路径（历史数据/手工 SQL）入册的脏行由 parse*Stored 以 InternalError
 * 显性化——配置消费方（C2/E1）不得静默拿到残缺树/模板。
 */
import { AppError, ErrorCode } from '@ljr/shared';
import type { PromptTemplates, QuestionTree, QuestionTreeNode } from './specialty.types';
import { SUPPORTED_SPECIALTIES } from './specialty.types';
import type { LicenseStatus, SourceType } from './knowledge.types';
import { LICENSE_STATUSES, SOURCE_TYPES } from './knowledge.types';

// ---------- 专项 key（R-04：V1 仅 labor_arbitration，400 E_SPECIALTY_UNSUPPORTED 口径） ----------

export const SPECIALTY_MAX_LEN = 32; // §3 varchar(32)
export const SPECIALTY_PATTERN = /^[a-z][a-z0-9_]*$/;

/**
 * R-04 的 400 口径（控制者裁决授权自定义并报告明示）：不在册专项的管理面写入（上传/树/提示词）
 * 一律 400 E_SPECIALTY_UNSUPPORTED——「未开放的专项」是请求侧错误（客户端可先查在册清单），
 * 不是资源不存在（404 留给公开读面/单资源定位）。
 */
export function assertSupportedSpecialty(specialty: string): void {
  if (
    typeof specialty !== 'string' ||
    specialty.length === 0 ||
    specialty.length > SPECIALTY_MAX_LEN ||
    !SPECIALTY_PATTERN.test(specialty)
  ) {
    throw new AppError(
      ErrorCode.InvalidArgument,
      `specialty key 须为 1-${SPECIALTY_MAX_LEN} 位小写字母开头的 [a-z0-9_]：${JSON.stringify(specialty)}`,
    );
  }
  if (!(SUPPORTED_SPECIALTIES as readonly string[]).includes(specialty)) {
    throw new AppError(
      ErrorCode.SpecialtyUnsupported,
      `专项未开放（V1 仅 ${(SUPPORTED_SPECIALTIES as readonly string[]).join('/')}，R-04）：${JSON.stringify(specialty)}`,
    );
  }
}

/** 幂等键基数（§5=key+base_version；0=尚无版本，写入版本恒=base+1，过期基数 409） */
export function assertBaseVersionInt(baseVersion: unknown): asserts baseVersion is number {
  if (typeof baseVersion !== 'number' || !Number.isSafeInteger(baseVersion) || baseVersion < 0) {
    throw new AppError(
      ErrorCode.InvalidArgument,
      `base_version 须为非负整数（0=尚无版本）：${JSON.stringify(baseVersion ?? null)}`,
    );
  }
}

// ---------- inline 文件引用（W1 最小形态；pdf/docx/i3 解析 M2 后置 ⚠） ----------

export const INLINE_FILE_REF_PREFIX = 'inline:';

/**
 * file_ref 最小形态解析（W1）：`inline:` + UTF-8 纯文本。mode=upload 时违例抛 E_BAD_FORMAT
 * （§5 400 BAD_FORMAT；含「pdf/docx/i3:// 解析 M2 接 I3 后开放」指引）；mode=stored 时违例抛
 * InternalError（落库行只能是上传面放行的形态，违例=不变量破坏）。
 */
export function parseInlineFileRef(
  fileRef: unknown,
  opts: { maxChars: number; mode: 'upload' | 'stored' },
): string {
  const bad = (msg: string): AppError =>
    opts.mode === 'upload'
      ? new AppError(
          ErrorCode.KnowledgeBadFormat,
          `${msg}（W1 仅支持 inline:<UTF-8 纯文本>；pdf/docx/外部存储引用随 M2 I3 与解析器开放）`,
        )
      : new AppError(ErrorCode.InternalError, `file_ref 脏数据（不变量破坏）：${msg}`);
  if (typeof fileRef !== 'string' || !fileRef.startsWith(INLINE_FILE_REF_PREFIX)) {
    throw bad(`file_ref 须为 ${INLINE_FILE_REF_PREFIX} 前缀形态`);
  }
  const text = fileRef.slice(INLINE_FILE_REF_PREFIX.length);
  if (text.trim().length === 0) throw bad('inline 正文不得为空白');
  if (text.length > opts.maxChars) {
    throw bad(`inline 正文超长（${text.length} > ${opts.maxChars} 码点）`);
  }
  return text;
}

// ---------- 枚举断言（上传面 400 E_BAD_FORMAT；§10 验收④「无授权状态文档无法入库」） ----------

export function assertSourceType(value: unknown): asserts value is SourceType {
  if (typeof value !== 'string' || !(SOURCE_TYPES as readonly string[]).includes(value)) {
    throw new AppError(
      ErrorCode.KnowledgeBadFormat,
      `source_type 须为 ${SOURCE_TYPES.join('|')}：${JSON.stringify(value ?? null)}`,
    );
  }
}

export function assertLicenseStatus(value: unknown): asserts value is LicenseStatus {
  if (typeof value !== 'string' || !(LICENSE_STATUSES as readonly string[]).includes(value)) {
    throw new AppError(
      ErrorCode.KnowledgeBadFormat,
      `license_status 须为 ${LICENSE_STATUSES.join('|')}（R-02 授权状态登记，无授权状态不得入库）：${JSON.stringify(value ?? null)}`,
    );
  }
}

/** 文档标题（§3 varchar(256)；可选入参，缺省由正文首行派生） */
export function assertDocTitle(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.trim().length > 256) {
    throw new AppError(
      ErrorCode.KnowledgeBadFormat,
      `title 须为 trim 后 1-256 字符：${JSON.stringify(value ?? null)}`,
    );
  }
}

// ---------- 问题树（§5 400 INVALID_TREE；结构契约见 specialty.types 头注） ----------

export const TREE_NODE_ID_PATTERN = /^[a-z0-9_-]{1,64}$/;
export const TREE_NODE_LABEL_MAX = 128;
export const TREE_MAX_NODES = 512;
export const TREE_MAX_CHILDREN = 32;

/**
 * 问题树规范化与校验：空树 {root:'',nodes:[]} 合法（seed/清空语义）；非空树要求——节点 id
 * 规范形唯一、label trim 后 1..128、children 引用在册且节点内无重复、root 在册、root 可达
 * 全部节点、边数=n-1（连通+无边数冗余 ⇒ 无环树）。输出按 id 升序排序（集合语义：幂等重放的
 * canonical 全等判定与节点提交顺序无关；children 顺序保留=展示顺序语义）。
 */
export function normalizeQuestionTree(raw: unknown): QuestionTree {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new AppError(
      ErrorCode.InvalidQuestionTree,
      'tree 须为 {root, nodes:[{id,label,children}]}',
    );
  }
  const root = (raw as { root?: unknown }).root;
  const nodesRaw = (raw as { nodes?: unknown }).nodes;
  const isEmpty =
    root === '' && (nodesRaw === undefined || (Array.isArray(nodesRaw) && nodesRaw.length === 0));
  if (isEmpty) return { root: '', nodes: [] };

  if (typeof root !== 'string' || !TREE_NODE_ID_PATTERN.test(root)) {
    throw new AppError(
      ErrorCode.InvalidQuestionTree,
      `tree.root 须为在册节点 id（1-64 位 [a-z0-9_-]）：${JSON.stringify(root ?? null)}`,
    );
  }
  if (!Array.isArray(nodesRaw)) {
    throw new AppError(ErrorCode.InvalidQuestionTree, 'tree.nodes 须为数组');
  }
  if (nodesRaw.length > TREE_MAX_NODES) {
    throw new AppError(
      ErrorCode.InvalidQuestionTree,
      `tree.nodes 超限（${nodesRaw.length} > ${TREE_MAX_NODES}）`,
    );
  }
  const byId = new Map<string, QuestionTreeNode>();
  let edgeCount = 0;
  for (const entry of nodesRaw) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new AppError(ErrorCode.InvalidQuestionTree, 'nodes 条目须为 {id, label, children}');
    }
    const id = (entry as { id?: unknown }).id;
    const label = (entry as { label?: unknown }).label;
    const children = (entry as { children?: unknown }).children;
    if (typeof id !== 'string' || !TREE_NODE_ID_PATTERN.test(id)) {
      throw new AppError(
        ErrorCode.InvalidQuestionTree,
        `节点 id 须为 1-64 位 [a-z0-9_-]：${JSON.stringify(id ?? null)}`,
      );
    }
    if (byId.has(id)) {
      throw new AppError(ErrorCode.InvalidQuestionTree, `节点 id 重复：${JSON.stringify(id)}`);
    }
    if (
      typeof label !== 'string' ||
      label.trim().length === 0 ||
      label.trim().length > TREE_NODE_LABEL_MAX
    ) {
      throw new AppError(
        ErrorCode.InvalidQuestionTree,
        `节点 label 须为 trim 后 1-${TREE_NODE_LABEL_MAX} 字符：${JSON.stringify(label ?? null)}`,
      );
    }
    if (!Array.isArray(children)) {
      throw new AppError(ErrorCode.InvalidQuestionTree, `节点 ${id} 的 children 须为数组`);
    }
    if (children.length > TREE_MAX_CHILDREN) {
      throw new AppError(
        ErrorCode.InvalidQuestionTree,
        `节点 ${id} 的 children 超限（${children.length} > ${TREE_MAX_CHILDREN}）`,
      );
    }
    const seen = new Set<string>();
    for (const child of children) {
      if (typeof child !== 'string' || !TREE_NODE_ID_PATTERN.test(child)) {
        throw new AppError(
          ErrorCode.InvalidQuestionTree,
          `children 引用须为节点 id（1-64 位 [a-z0-9_-]）：${JSON.stringify(child ?? null)}`,
        );
      }
      if (seen.has(child)) {
        throw new AppError(
          ErrorCode.InvalidQuestionTree,
          `节点 ${id} 的 children 重复引用 ${child}`,
        );
      }
      seen.add(child);
    }
    edgeCount += children.length;
    byId.set(id, { id, label: label.trim(), children: [...children] });
  }
  if (!byId.has(root)) {
    throw new AppError(ErrorCode.InvalidQuestionTree, `root 不在节点集：${JSON.stringify(root)}`);
  }
  for (const node of byId.values()) {
    for (const child of node.children) {
      if (!byId.has(child)) {
        throw new AppError(
          ErrorCode.InvalidQuestionTree,
          `节点 ${node.id} 的 children 引用不存在：${JSON.stringify(child)}`,
        );
      }
    }
  }
  // 连通性（root 可达全部）+ 无环（边数=n-1 且全可达 ⇒ 恰为树）
  const visited = new Set<string>([root]);
  const stack = [root];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    for (const child of byId.get(cur)!.children) {
      if (!visited.has(child)) {
        visited.add(child);
        stack.push(child);
      }
    }
  }
  if (visited.size !== byId.size) {
    throw new AppError(
      ErrorCode.InvalidQuestionTree,
      `存在 root 不可达节点（${byId.size - visited.size} 个）——树必须从 root 连通`,
    );
  }
  if (edgeCount !== byId.size - 1) {
    throw new AppError(
      ErrorCode.InvalidQuestionTree,
      `边数 ${edgeCount} ≠ 节点数-1 ${byId.size - 1}——存在环或冗余边（须为树）`,
    );
  }
  return {
    root,
    nodes: [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
  };
}

/** 读面提取：结构违例 InternalError 显性化（C2 不得静默拿到残缺树） */
export function parseQuestionTreeStored(content: Record<string, unknown>): QuestionTree {
  try {
    return normalizeQuestionTree(content);
  } catch (e) {
    throw new AppError(
      ErrorCode.InternalError,
      `question_tree 脏数据（只能经问题树管理面写入）：${e instanceof AppError ? e.message : String(e)}`,
    );
  }
}

// ---------- 提示词模板（R-03 版本化；§5 幂等键=key+base_version） ----------

export const PROMPT_KEY_PATTERN = /^[a-z0-9_.]{1,64}$/;
export const PROMPT_CONTENT_MAX = 20_000;
export const PROMPT_MAX_TEMPLATES = 64;

/** 提示词模板规范化与校验（400 E_INVALID_ARGUMENT——§5 未列 prompts 专用码，通用入参错误码） */
export function normalizePromptTemplates(raw: unknown): PromptTemplates {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new AppError(ErrorCode.InvalidArgument, 'prompts 须为 {templates: {<key>: <content>}}');
  }
  const templates = (raw as { templates?: unknown }).templates;
  if (typeof templates !== 'object' || templates === null || Array.isArray(templates)) {
    throw new AppError(ErrorCode.InvalidArgument, 'prompts.templates 须为对象（key → 模板正文）');
  }
  const entries = Object.entries(templates as Record<string, unknown>);
  if (entries.length > PROMPT_MAX_TEMPLATES) {
    throw new AppError(
      ErrorCode.InvalidArgument,
      `prompts.templates 超限（${entries.length} > ${PROMPT_MAX_TEMPLATES}）`,
    );
  }
  const out: Record<string, string> = {};
  for (const [key, value] of entries) {
    if (!PROMPT_KEY_PATTERN.test(key)) {
      throw new AppError(
        ErrorCode.InvalidArgument,
        `模板 key 须为 1-64 位 [a-z0-9_.]：${JSON.stringify(key)}`,
      );
    }
    if (
      typeof value !== 'string' ||
      value.trim().length === 0 ||
      value.length > PROMPT_CONTENT_MAX
    ) {
      throw new AppError(
        ErrorCode.InvalidArgument,
        `模板 ${key} 正文须为 trim 后 1-${PROMPT_CONTENT_MAX} 字符`,
      );
    }
    out[key] = value;
  }
  return { templates: out };
}

/** 读面提取：结构违例 InternalError 显性化（生成消费方不得静默拿到残缺模板，M2-W3 接线） */
export function parsePromptTemplatesStored(content: Record<string, unknown>): PromptTemplates {
  try {
    return normalizePromptTemplates(content);
  } catch (e) {
    throw new AppError(
      ErrorCode.InternalError,
      `prompts 脏数据（只能经提示词管理面写入）：${e instanceof AppError ? e.message : String(e)}`,
    );
  }
}

/** 键序无关的 canonical JSON（幂等重放全等比较口径；同款实现见 rule-center/word-dict.validate——
 * 三处去重是 Task 5 已记账遗留，不新增跨模块代码依赖） */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/** 正文标题派生（title 缺省=首行截 64 码点；码点口径与分块一致） */
export function deriveTitle(text: string, maxCodepoints = 64): string {
  const firstLine = text.split('\n', 1)[0] ?? text;
  const trimmed = firstLine.trim();
  return [...(trimmed.length > 0 ? trimmed : text.trim())].slice(0, maxCodepoints).join('');
}
