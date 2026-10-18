/**
 * I3 存档类型契约（M2-W1 T2）：kind 五值 / kind→bucket 映射 / W1 最小分级策略表 / 留存默认。
 *
 * 施工规格：docs/modules/I-平台支撑/I3-文件与存证存储.md（§2 bucket 策略 + §3 kind 值域 +
 * §5 403 KIND_POLICY + §7 R-01/R-04）+ docs/plans/M2-W1-执行计划.md 附录 A.3（DDL 蓝图
 * kind CHECK 五值逐字）。类型即契约——先于实现落位（契约类型先行纪律）。
 */

/** kind 五值（V36 ck_artifacts_kind 值域逐字；§3 领域模型注释行） */
export const ARTIFACT_KINDS = [
  'recording',
  'export',
  'credential',
  'cold_message',
  'recon_file',
] as const;

export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

/** kind 值域收窄守卫（入参校验用；表外值=400 而非 403——形态错非策略拒） */
export function isArtifactKind(value: string): value is ArtifactKind {
  return (ARTIFACT_KINDS as readonly string[]).includes(value);
}

/**
 * kind→bucket 映射（§2 bucket 策略）：
 *   recordings=WORM（put 后禁覆写禁删除——adapter 策略层拒绝+服务层内容寻址幂等短路双保险）；
 *   exports=只增+30min 生命周期（**生命周期规则=IaC/bucket 级后置，W1 不做定时清理**；
 *     RETENTION_PURGE 只管 retention_until 到期处置，不承担 30min 清扫）；
 *   credentials=写入即变换（W1=mock 可逆变换禁明文落盘；真加密=AES 信封 M5 前换装，不引入新依赖）；
 *   cold-messages=90 天转入 3 年到期（D5 冷存消费方经 putArtifact 统一入口写入，W1 T3）；
 *   recon-files=对账文件（§2 未列对应 bucket——W1 裁量命名，仅承载寻址非策略发明；3 年留存同 R-01）。
 */
export const KIND_BUCKET: Readonly<Record<ArtifactKind, string>> = {
  recording: 'recordings',
  export: 'exports',
  credential: 'credentials',
  cold_message: 'cold-messages',
  recon_file: 'recon-files',
};

/**
 * W1 最小分级策略表（§5 403 KIND_POLICY；R-04 L4 差异化管控）：kind→允许的 ref_type 域词汇，
 * null=开放。credential 仅 identity 域 ref、recon_file 仅 payment 域 ref、其余开放。
 * 配置化预留=集中常量单点改（H7 规则化收口时迁移，patrol.config 阈值演进同款路径）。
 */
export const KIND_REF_POLICY: Readonly<Record<ArtifactKind, readonly string[] | null>> = {
  credential: ['identity'],
  recon_file: ['payment'],
  recording: null,
  export: null,
  cold_message: null,
};

/** 默认留存 3 年（R-01 电商法 §31 锚定；⚠04§8-2 留存期法务确认并行中，D2 决策默认值） */
export const DEFAULT_RETENTION_YEARS = 3;

/** retention_until 入参形态（date 列文本 'YYYY-MM-DD'，判定时钟=DB 钟 Asia/Shanghai） */
export const RETENTION_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 日历有效性（评审 M-5）：形态之外再回验真实日历日——Date 解码回读不等即伪日（2026-02-30
 *  → Date 滚动到 03-02 ≠ 原文 → 拒；2027-02-29 非闰、2026-13-01 伪月同拒） */
export function isValidRetentionDate(value: string): boolean {
  if (!RETENTION_DATE_RE.test(value)) return false;
  const parsed = Date.parse(value);
  return !Number.isNaN(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}
