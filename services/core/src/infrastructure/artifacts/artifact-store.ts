/**
 * I3 存储适配器（⚠W1-4 决策位）：ArtifactStore 接口=换装缝——语义映射 S3 兼容对象存储
 * （bucket/object_key 寻址，put/get/delete 对位），prod 前 OSS 真对接=替换实现类只改模块工厂；
 * W1=本地 FS 实现（生产默认根=仓库根 var/artifacts 经 config artifacts.dir 覆写，根 .gitignore
 * 已含 var/；测试经 ARTIFACT_STORE override 指向 os.tmpdir() 子目录）。
 *
 * bucket 策略层（「WORM 覆写被拒（存储层断言）」§10——策略在 adapter 层检查）：
 *   - recordings（WORM，R-02）：put 遇既有对象——同字节幂等返回；入参真前缀=崩溃残留（旧实现
 *     写中途中断只可能产出前缀）→ 经原子 rename 覆盖恢复（评审 I-1）；其余异内容拒绝（禁覆写）；
 *     delete 恒拒（禁删除）；法定到期处置唯一合法出口=purgeObject 特权路径（留存期 R-01 是删除
 *     合法性的唯一锚；服务层另行断言 retention 到期+purged_at 判重，双保险）。
 *   - credentials（L4 加密管控，R-04）：写入前可逆 mock 变换（字节取反——非加密强度，W1 红线=
 *     禁明文落盘；真加密=AES-256-GCM 信封 M5 前换装，不引入新依赖）；读回反变换还原明文。
 *   - exports 30min 生命周期=IaC/bucket 级规则后置（W1 不做定时清理）；cold-messages/
 *     recon-files 无 adapter 层特殊策略（留存处置统一走 purgeObject）。
 *
 * 原子写（评审 I-1）：所有 put=临时文件+同目录 rename 落终路径（同目录=同卷，rename 原子替换
 * ——写中途崩溃不留半截终路径对象；崩溃窗残留的是 .tmp-* 旁路文件，不参与读路径，运维可清）。
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Injectable, type InjectionToken } from '@nestjs/common';
import { AppError, ErrorCode } from '@ljr/shared';

/** 通道绑定 DI 令牌（RTC_PROVIDER/REALNAME_PROVIDER 同款 Symbol 口径）：测试 override 注入、prod 换装 */
export const ARTIFACT_STORE: InjectionToken<ArtifactStore> = Symbol('ARTIFACT_STORE');

/** 存储层策略拒绝（WORM 覆写/删除等；开放 message 词汇非 PII） */
export class ArtifactStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArtifactStoreError';
  }
}

export interface ArtifactStore {
  /** 通道名（审计口径：LOCAL_FS|OSS…） */
  readonly driver: string;
  /** 写入对象（object_key=含 bucket 前缀的内容寻址全键；WORM/加密策略在本层执行；tmp+rename 原子落位） */
  put(bucket: string, objectKey: string, bytes: Uint8Array): Promise<void>;
  /** 读回对象（credentials 域自动反变换还原明文；缺失=404 NotFound） */
  get(bucket: string, objectKey: string): Promise<Buffer>;
  /**
   * 删除对象（WORM bucket 恒拒——常规路径禁删）。**当前无生产调用方（换装缝预留）——勿新增
   * 调用点**：常规生命周期删除（exports 30min）=IaC/bucket 级规则，到期处置=purgeObject。
   */
  delete(bucket: string, objectKey: string): Promise<void>;
  /** 法定到期处置特权路径（唯一允许删 recordings 对象的入口；缺失对象=幂等无操作） */
  purgeObject(bucket: string, objectKey: string): Promise<void>;
}

/** WORM bucket 集（recordings：put 后禁覆写禁删除，§2/R-02） */
const WORM_BUCKETS: ReadonlySet<string> = new Set(['recordings']);

/** 写入即变换 bucket 集（credentials：L4 加密管控，W1=mock 可逆变换） */
const ENCRYPTED_BUCKETS: ReadonlySet<string> = new Set(['credentials']);

/** W1 mock 变换：字节取反（自反可逆；真加密=AES-256-GCM 信封，M5 前换装缝） */
function mockTransform(bytes: Uint8Array): Buffer {
  const out = Buffer.alloc(bytes.length);
  for (let i = 0; i < bytes.length; i += 1) {
    out[i] = bytes[i]! ^ 0xff;
  }
  return out;
}

/** 崩溃残留判定（评审 I-1 选型）：existing=入参真前缀（含空）——顺序写中途断掉只可能产出前缀；
 *  非前缀异内容=违规覆写意图（WORM 拒），前缀=残留（rename 覆盖恢复） */
function isCrashRemnant(existing: Buffer, bytes: Uint8Array): boolean {
  if (existing.length >= bytes.length) return false;
  return Buffer.from(bytes.subarray(0, existing.length)).equals(existing);
}

/** 本地 FS 实现：根目录下按 object_key 自带 bucket 前缀分层落盘（<root>/<bucket>/<kind>/<2>/<64>） */
@Injectable()
export class LocalFsArtifactStore implements ArtifactStore {
  readonly driver = 'LOCAL_FS';

  constructor(private readonly rootDir: string) {}

  async put(bucket: string, objectKey: string, bytes: Uint8Array): Promise<void> {
    const full = this.pathOf(bucket, objectKey);
    if (WORM_BUCKETS.has(bucket)) {
      const existing = await this.readOrNull(full);
      if (existing !== null && existing.equals(bytes)) return; // 同字节幂等（内容寻址重放，零覆写）
      if (existing !== null && !isCrashRemnant(existing, bytes)) {
        throw new ArtifactStoreError(
          `WORM bucket ${bucket} 禁覆写：${objectKey} 已存在且内容不一致（R-02）`,
        );
      }
      // existing===null 或崩溃残留前缀 → 落到下方 tmp+rename（残留被原子覆盖恢复）
    }
    const payload = ENCRYPTED_BUCKETS.has(bucket) ? mockTransform(bytes) : Buffer.from(bytes);
    await mkdir(path.dirname(full), { recursive: true });
    const tmp = `${full}.tmp-${randomUUID()}`;
    try {
      await writeFile(tmp, payload);
      await rename(tmp, full); // 同目录=同卷原子替换（win32=MoveFileEx REPLACE_EXISTING）
    } catch (e) {
      await this.unlinkOrNull(tmp); // best-effort 清理本轮 tmp（终路径未被触碰）
      throw e;
    }
  }

  async get(bucket: string, objectKey: string): Promise<Buffer> {
    const raw = await this.readOrNull(this.pathOf(bucket, objectKey));
    if (raw === null) {
      throw new AppError(ErrorCode.NotFound, `存档对象不存在：${objectKey}`);
    }
    return ENCRYPTED_BUCKETS.has(bucket) ? mockTransform(raw) : raw;
  }

  async delete(bucket: string, objectKey: string): Promise<void> {
    if (WORM_BUCKETS.has(bucket)) {
      throw new ArtifactStoreError(`WORM bucket ${bucket} 禁删除：${objectKey}（R-02）`);
    }
    await this.unlinkOrNull(this.pathOf(bucket, objectKey));
  }

  async purgeObject(bucket: string, objectKey: string): Promise<void> {
    // 特权路径：法定到期处置（R-01 留存期满）——WORM 亦放行；缺失对象=幂等无操作
    await this.unlinkOrNull(this.pathOf(bucket, objectKey));
  }

  /** object_key 自带 bucket 前缀（<bucket>/<kind>/<hash 前两位>/<hash 全值>）——前缀校验后拼根路径 */
  private pathOf(bucket: string, objectKey: string): string {
    if (!objectKey.startsWith(`${bucket}/`)) {
      throw new ArtifactStoreError(`object_key ${objectKey} 与 bucket ${bucket} 前缀不符`);
    }
    return path.join(this.rootDir, ...objectKey.split('/'));
  }

  private async readOrNull(full: string): Promise<Buffer | null> {
    try {
      return await readFile(full);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
  }

  private async unlinkOrNull(full: string): Promise<void> {
    try {
      await unlink(full);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
  }
}
