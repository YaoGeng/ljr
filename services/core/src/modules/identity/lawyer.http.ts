/**
 * A3a HTTP 面请求解析与形态防呆（§5 契约词汇 snake_case）：只做「形状→领域入参」的搬运，
 * 错误映射经 infrastructure 的 AppHttpExceptionFilter（G-B 做项1 全仓唯一过滤器——不新增
 * 过滤器副本，T1 评审 minor-5 口径延续）。
 * 形态校验函数（assertLicenseNo/parseQualificationFiles）同时供领域服务直调入口复用
 * （realname.provider 同口径：REST 与服务层共用同一防呆事实源）。
 */
import { AppError, ErrorCode } from '@ljr/shared';

/** 律师资质材料类别（§2：执业证照片/律所授权书；kind 形态自由文本，DB 不 CHECK 以免迁移锁型） */
export interface QualificationFileInput {
  readonly kind: string;
  readonly ref: string;
}

export interface QualificationBody {
  readonly licenseNo: string;
  readonly firmName?: string;
  readonly files: QualificationFileInput[];
}

/** R-W2-12 同源：license_no 格式校验自定最小合理——非空 + 长度上限 32（执业证号无全国统一格式，不做格式推断） */
export function assertLicenseNo(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new AppError(ErrorCode.InvalidArgument, 'license_no 必须为字符串');
  }
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed.length > 32) {
    throw new AppError(ErrorCode.InvalidArgument, 'license_no 必须为 1-32 位非空字符串');
  }
  return trimmed;
}

/** firm_name：可选，空白归 absent，上限 128（§3 varchar(128)） */
export function parseFirmName(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string') {
    throw new AppError(ErrorCode.InvalidArgument, 'firm_name 必须为字符串');
  }
  const trimmed = raw.trim();
  if (trimmed === '') return undefined;
  if (trimmed.length > 128) {
    throw new AppError(ErrorCode.InvalidArgument, 'firm_name 不得超过 128 字符');
  }
  return trimmed;
}

/** files[]：1-20 件，每件 {kind, ref} 非空且有界（R-W2-7：ref 仅引用文本，不做上传） */
export function parseQualificationFiles(raw: unknown): QualificationFileInput[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 20) {
    throw new AppError(ErrorCode.InvalidArgument, 'files 必须为 1-20 件的材料数组');
  }
  return raw.map((item) => {
    if (typeof item !== 'object' || item === null) {
      throw new AppError(ErrorCode.InvalidArgument, 'files 每项须为对象 {kind, ref}');
    }
    const { kind, ref } = item as { kind?: unknown; ref?: unknown };
    if (typeof kind !== 'string' || kind.trim() === '' || kind.length > 32) {
      throw new AppError(ErrorCode.InvalidArgument, 'files[].kind 必须为 1-32 位非空字符串');
    }
    if (typeof ref !== 'string' || ref.trim() === '' || ref.length > 512) {
      throw new AppError(ErrorCode.InvalidArgument, 'files[].ref 必须为 1-512 位非空引用文本');
    }
    return { kind: kind.trim(), ref: ref.trim() };
  });
}

/** POST /lawyer/qualification 体：{license_no, firm_name?, files[]}（§5） */
export function parseQualificationBody(body: unknown): QualificationBody {
  if (typeof body !== 'object' || body === null) {
    throw new AppError(ErrorCode.InvalidArgument, '请求体须为 JSON 对象 {license_no, files}');
  }
  const raw = body as { license_no?: unknown; firm_name?: unknown; files?: unknown };
  return {
    licenseNo: assertLicenseNo(raw.license_no),
    firmName: parseFirmName(raw.firm_name),
    files: parseQualificationFiles(raw.files),
  };
}

/** H1 审核动作（简报：领取/通过/拒绝/停用/恢复） */
export type LawyerAuditAction = 'claim' | 'approve' | 'reject' | 'suspend' | 'resume';

export interface AuditActionBody {
  readonly action: LawyerAuditAction;
  /** reject 必填：拒绝事由（落 reject_reason，本人可见） */
  readonly rejectReason?: string;
  /** suspend 必填：停用事由（LawyerSuspended 载荷 reason） */
  readonly reason?: string;
}

const AUDIT_ACTIONS: readonly LawyerAuditAction[] = [
  'claim',
  'approve',
  'reject',
  'suspend',
  'resume',
];

/** POST /admin/lawyers/{id}/audit 体：{action, reject_reason?, reason?}（action 词汇=英文动词，报告注） */
export function parseAuditActionBody(body: unknown): AuditActionBody {
  if (typeof body !== 'object' || body === null) {
    throw new AppError(ErrorCode.InvalidArgument, '请求体须为 JSON 对象 {action}');
  }
  const raw = body as { action?: unknown; reject_reason?: unknown; reason?: unknown };
  if (typeof raw.action !== 'string' || !AUDIT_ACTIONS.includes(raw.action as LawyerAuditAction)) {
    throw new AppError(ErrorCode.InvalidArgument, `action 必须为 ${AUDIT_ACTIONS.join('|')} 之一`);
  }
  const action = raw.action as LawyerAuditAction;
  if (action === 'reject') {
    if (
      typeof raw.reject_reason !== 'string' ||
      raw.reject_reason.trim() === '' ||
      raw.reject_reason.length > 1000
    ) {
      throw new AppError(ErrorCode.InvalidArgument, 'reject_reason 必须为 1-1000 位非空字符串');
    }
    return { action, rejectReason: raw.reject_reason };
  }
  if (action === 'suspend') {
    if (typeof raw.reason !== 'string' || raw.reason.trim() === '' || raw.reason.length > 256) {
      throw new AppError(
        ErrorCode.InvalidArgument,
        'suspend 必须携带 reason（1-256 位非空字符串）',
      );
    }
    return { action, reason: raw.reason };
  }
  return { action };
}

/** 路由参数 {id}：lawyer_profiles.id 正整数 */
export function parseProfileId(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new AppError(ErrorCode.InvalidArgument, '律师资质档案 id 必须为正整数');
  }
  return n;
}
