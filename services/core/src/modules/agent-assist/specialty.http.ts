/**
 * E3 HTTP 面共用件：入参解析（§5 四接口）。
 * 错误体过滤器已收敛至 infrastructure 的 AppHttpExceptionFilter（G-B 做项1，6→1；
 * 错误体形态 {code, message} 不变）。
 * 后台鉴权 ⚠决策位：admin 角色鉴权随 H1/H2（W2+）接入后替换，本批次只交付接口形态
 * （rule-admin/scheduler-admin/word-admin 同口径）；/specialty/question-tree 公开只读无鉴权。
 */
import { AppError, ErrorCode } from '@ljr/shared';
import {
  assertBaseVersionInt,
  assertDocTitle,
  assertSupportedSpecialty,
} from './specialty.validate';

/** 管理面路径专项 key（R-04 门：不在册 400 E_SPECIALTY_UNSUPPORTED） */
export function parseSpecialtyKey(raw: string): string {
  assertSupportedSpecialty(raw);
  return raw;
}

/** 公开只读面的 key（缺省/形态非法 400；未知专项由配置行缺失给 404——公网不暴露在册清单口径） */
export function parsePublicSpecialtyKey(raw: string | undefined): string {
  if (typeof raw !== 'string' || raw === '') {
    throw new AppError(ErrorCode.InvalidArgument, `key 必填：${JSON.stringify(raw ?? null)}`);
  }
  return raw;
}

/** POST /admin/specialty/{key}/knowledge 体：{file_ref, source_type, license_status, title?}（§5 键名随契约词汇） */
export function parseUploadKnowledgeBody(body: unknown): {
  readonly fileRef: unknown;
  readonly sourceType: unknown;
  readonly licenseStatus: unknown;
  readonly title?: string;
} {
  if (typeof body !== 'object' || body === null) {
    throw new AppError(
      ErrorCode.KnowledgeBadFormat,
      '请求体须为 {file_ref, source_type, license_status, title?}',
    );
  }
  const fileRef = (body as { file_ref?: unknown }).file_ref;
  const sourceType = (body as { source_type?: unknown }).source_type;
  const licenseStatus = (body as { license_status?: unknown }).license_status;
  const title = (body as { title?: unknown }).title;
  if (fileRef === undefined) {
    throw new AppError(ErrorCode.KnowledgeBadFormat, '请求体缺 file_ref');
  }
  if (sourceType === undefined) {
    throw new AppError(ErrorCode.KnowledgeBadFormat, '请求体缺 source_type');
  }
  if (licenseStatus === undefined) {
    throw new AppError(
      ErrorCode.KnowledgeBadFormat,
      '请求体缺 license_status（R-02 授权状态登记，无授权状态不得入库）',
    );
  }
  if (title !== undefined && title !== null) {
    assertDocTitle(title);
    return { fileRef, sourceType, licenseStatus, title };
  }
  return { fileRef, sourceType, licenseStatus };
}

/** PUT .../question-tree 体：{tree, base_version}（tree 结构校验在服务层，400 INVALID_TREE） */
export function parsePutQuestionTreeBody(body: unknown): {
  readonly tree: unknown;
  readonly baseVersion: number;
} {
  if (typeof body !== 'object' || body === null) {
    throw new AppError(ErrorCode.InvalidArgument, '请求体须为 {tree, base_version}');
  }
  const tree = (body as { tree?: unknown }).tree;
  const baseVersion = (body as { base_version?: unknown }).base_version;
  if (tree === undefined) {
    throw new AppError(ErrorCode.InvalidQuestionTree, '请求体缺 tree');
  }
  assertBaseVersionInt(baseVersion);
  return { tree, baseVersion };
}

/** PUT .../prompts 体：{prompts, base_version}（结构校验在服务层，400 E_INVALID_ARGUMENT） */
export function parsePutPromptsBody(body: unknown): {
  readonly prompts: unknown;
  readonly baseVersion: number;
} {
  if (typeof body !== 'object' || body === null) {
    throw new AppError(ErrorCode.InvalidArgument, '请求体须为 {prompts, base_version}');
  }
  const prompts = (body as { prompts?: unknown }).prompts;
  const baseVersion = (body as { base_version?: unknown }).base_version;
  if (prompts === undefined) {
    throw new AppError(ErrorCode.InvalidArgument, '请求体缺 prompts');
  }
  assertBaseVersionInt(baseVersion);
  return { prompts, baseVersion };
}
