/**
 * E3 专项配置包服务（机制核心）：问题树/提示词模板的版本化写入（§5 幂等键=key+base_version，
 * 乐观并发同 word-dict.putDictionary 口径）+ 公开只读视图（C2 引导页消费）+ R-04 在册专项门。
 *
 * 版本纪律（R-03/裁决）：prompts 与 question_tree 独立版本线（specialty_configs 两列计数），
 * 变更只推进版本号——「只影响后续生成」的消费方语义=生成时刻读当前版本（E1 M2-W3 接线，
 * getPrompts 机制面即消费口）；W1 无历史版本表（配置包是当前态事实源，§3 无历史面）。
 *
 * 事件纪律（§6）：QuestionTreeUpdated 与树写入同事务出箱；prompts 变更无事件（§6 仅两事件）。
 * 事务形态：管理面方法自带事务（pool.withTransaction，rule-center 同款）。
 *
 * 行缺失自愈（迁移头注③）：seed=labor_arbitration 唯一行，但 truncate/极端运维下行缺失时
 * 管理面 PUT 以「首写创建」兜底（base_version=0 语义）；公开读面行缺失=404（资源语义）。
 *
 * ⚠未接线位：specialty_configs.active（§3 裸列）=整包停用位，W1 无写入路径（V2 多专项管理
 * 面承载）；检索过滤当前只看文档级 active/license_status/process_status。
 */
import { Injectable } from '@nestjs/common';
import { AppError, ErrorCode } from '@ljr/shared';
import { OutboxService } from '../../infrastructure/outbox/outbox.service';
import type { SqlExecutor } from '../../infrastructure/sql';
import { PgPoolService } from '../../infrastructure/sql';
import type {
  PromptTemplates,
  PutSpecialtyConfigResult,
  SpecialtyConfigView,
  SpecialtyQuestionTreeView,
} from './specialty.types';
import { QUESTION_TREE_UPDATED_TOPIC, type QuestionTreeUpdatedPayload } from './specialty.events';
import {
  assertBaseVersionInt,
  assertSupportedSpecialty,
  canonicalJson,
  normalizePromptTemplates,
  normalizeQuestionTree,
  parsePromptTemplatesStored,
  parseQuestionTreeStored,
} from './specialty.validate';

const CONFIG_COLUMNS =
  'id, specialty, active, question_tree, prompts, question_tree_version, prompts_version, updated_at';

/** 首写创建时未提交面的 seed 空形态（与 V9 seed 同值；§3 双 jsonb NOT NULL） */
const EMPTY_TREE_JSON = '{"root":"","nodes":[]}';
const EMPTY_PROMPTS_JSON = '{"templates":{}}';

interface SpecialtyConfigRow {
  readonly id: string;
  readonly specialty: string;
  readonly active: boolean;
  readonly question_tree: Record<string, unknown>;
  readonly prompts: Record<string, unknown>;
  readonly question_tree_version: number;
  readonly prompts_version: number;
  readonly updated_at: Date;
}

@Injectable()
export class SpecialtyConfigService {
  constructor(
    private readonly pool: PgPoolService,
    private readonly outbox: OutboxService,
  ) {}

  // ---------- 公开只读（§5 GET /specialty/question-tree?key=，C2 消费） ----------

  /** 当前问题树（行缺失=404 NotFound；脏数据=InternalError 显性化，不向 C2 吐残缺树） */
  async getQuestionTree(specialty: string): Promise<SpecialtyQuestionTreeView> {
    const row = await this.readRow(this.pool, specialty, { forUpdate: false });
    if (!row) {
      throw new AppError(ErrorCode.NotFound, `专项配置不存在：${JSON.stringify(specialty)}`);
    }
    return {
      specialty: row.specialty,
      version: Number(row.question_tree_version),
      questionTree: parseQuestionTreeStored(row.question_tree),
    };
  }

  // ---------- R-03 提示词机制消费口（E1 生成管线 M2-W3 接线；无 HTTP 面） ----------

  /** 当前提示词模板（结构契约同 getQuestionTree；version=只影响后续生成的版本锚点） */
  async getPrompts(
    specialty: string,
  ): Promise<{ specialty: string; version: number; prompts: PromptTemplates }> {
    const row = await this.readRow(this.pool, specialty, { forUpdate: false });
    if (!row) {
      throw new AppError(ErrorCode.NotFound, `专项配置不存在：${JSON.stringify(specialty)}`);
    }
    return {
      specialty: row.specialty,
      version: Number(row.prompts_version),
      prompts: parsePromptTemplatesStored(row.prompts),
    };
  }

  /** 整包视图（机制面；R-01 配置包语义的读取口，管理台列表 W2+ 接线） */
  async getConfig(specialty: string): Promise<SpecialtyConfigView> {
    const row = await this.readRow(this.pool, specialty, { forUpdate: false });
    if (!row) {
      throw new AppError(ErrorCode.NotFound, `专项配置不存在：${JSON.stringify(specialty)}`);
    }
    return {
      id: Number(row.id),
      specialty: row.specialty,
      active: row.active,
      questionTree: parseQuestionTreeStored(row.question_tree),
      prompts: parsePromptTemplatesStored(row.prompts),
      questionTreeVersion: Number(row.question_tree_version),
      promptsVersion: Number(row.prompts_version),
      updatedAt: new Date(row.updated_at),
    };
  }

  // ---------- 管理面写入（§5 PUT，幂等键=key+base_version） ----------

  /**
   * 问题树提交（§5 PUT {tree, base_version} → {version}；400 INVALID_TREE）：规范化校验后
   * base_version 乐观并发（0=尚无版本，写入版本恒=base+1）；重放（目标版本在册且 canonical
   * 全等）⇒ created:false 幂等回读；过期基数 ⇒ 409 E_CONFLICT。QuestionTreeUpdated（§6）与
   * 写入同事务。
   */
  async putQuestionTree(input: {
    readonly specialty: string;
    readonly tree: unknown;
    readonly baseVersion: number;
  }): Promise<PutSpecialtyConfigResult> {
    assertSupportedSpecialty(input.specialty);
    assertBaseVersionInt(input.baseVersion);
    const tree = normalizeQuestionTree(input.tree);
    const canonical = canonicalJson(tree);
    return this.pool.withTransaction((uow) =>
      this.putFacet(uow, {
        specialty: input.specialty,
        baseVersion: input.baseVersion,
        canonical,
        column: 'question_tree',
        versionColumn: 'question_tree_version',
        currentOf: (row) => ({
          version: Number(row.question_tree_version),
          content: row.question_tree,
        }),
        onCreated: async (uow2, specialty, version) => {
          await this.outbox.recordOutbox(uow2, {
            type: QUESTION_TREE_UPDATED_TOPIC,
            payload: { specialty, version } satisfies QuestionTreeUpdatedPayload,
          });
        },
      }),
    );
  }

  /**
   * 提示词模板提交（§5 PUT {prompts, base_version} → {version}；R-03 变更记 version，只影响
   * 后续生成）：口径与树一致；无事件（§6 无 prompts 事件，写入端不发明）。
   */
  async putPrompts(input: {
    readonly specialty: string;
    readonly prompts: unknown;
    readonly baseVersion: number;
  }): Promise<PutSpecialtyConfigResult> {
    assertSupportedSpecialty(input.specialty);
    assertBaseVersionInt(input.baseVersion);
    const prompts = normalizePromptTemplates(input.prompts);
    const canonical = canonicalJson(prompts);
    return this.pool.withTransaction((uow) =>
      this.putFacet(uow, {
        specialty: input.specialty,
        baseVersion: input.baseVersion,
        canonical,
        column: 'prompts',
        versionColumn: 'prompts_version',
        currentOf: (row) => ({ version: Number(row.prompts_version), content: row.prompts }),
        onCreated: async () => undefined, // §6：提示词变更无领域事件
      }),
    );
  }

  // ---------- 内部件 ----------

  /**
   * 双版本线共用写入核（FOR UPDATE 行锁下重验 → 幂等/冲突判定 → 更新或首写创建 → 事件）。
   * 首写创建兜底见类注（行缺失且 base_version=0 ⇒ INSERT version=1）。
   */
  private async putFacet(
    uow: SqlExecutor,
    facet: {
      readonly specialty: string;
      readonly baseVersion: number;
      readonly canonical: string;
      readonly column: 'question_tree' | 'prompts';
      readonly versionColumn: 'question_tree_version' | 'prompts_version';
      readonly currentOf: (row: SpecialtyConfigRow) => {
        version: number;
        content: Record<string, unknown>;
      };
      readonly onCreated: (uow: SqlExecutor, specialty: string, version: number) => Promise<void>;
    },
  ): Promise<PutSpecialtyConfigResult> {
    let row = await this.readRow(uow, facet.specialty, { forUpdate: true });
    if (!row) {
      // 首写创建兜底（迁移 seed 的自愈路径）：基数非 0 即过期（尚无版本时唯一合法基数=0）
      if (facet.baseVersion !== 0) {
        throw new AppError(
          ErrorCode.Conflict,
          `base_version 过期：${facet.specialty} 尚无版本（应为 0），调用方基于 ${facet.baseVersion}`,
        );
      }
      const inserted = await uow.query<SpecialtyConfigRow>(
        `INSERT INTO agent_assist.specialty_configs
           (specialty, question_tree, prompts, ${facet.versionColumn})
         VALUES ($1, $2::jsonb, $3::jsonb, 1)
         ON CONFLICT (specialty) DO NOTHING
         RETURNING ${CONFIG_COLUMNS}`,
        [
          facet.specialty,
          // 提交面落 canonical；未提交的另一面以 seed 空形态落位（§3 双 jsonb NOT NULL，与 V9 seed 同值）
          facet.column === 'question_tree' ? facet.canonical : EMPTY_TREE_JSON,
          facet.column === 'prompts' ? facet.canonical : EMPTY_PROMPTS_JSON,
        ],
      );
      const created = inserted.rows[0];
      if (created) {
        // 首写即 v1（不再走下方重放判定——RETURNING 行的版本已是 1）
        await facet.onCreated(uow, facet.specialty, 1);
        return { specialty: facet.specialty, version: 1, created: true };
      }
      // 并发竞态：他人先建行 → 落入下方在册行逻辑（FOR UPDATE 重读）
      row = await this.readRow(uow, facet.specialty, { forUpdate: true });
      if (!row) {
        throw new AppError(ErrorCode.InternalError, '配置行首写后不可见（并发异常）');
      }
    }
    const current = facet.currentOf(row);
    const target = facet.baseVersion + 1;
    if (current.version === target) {
      // 重放路径：目标版本已在册且内容 canonical 全等 ⇒ 幂等回读（不出事件）
      if (canonicalJson(current.content) === facet.canonical) {
        return { specialty: facet.specialty, version: current.version, created: false };
      }
      throw new AppError(
        ErrorCode.Conflict,
        `base_version 过期：${facet.specialty} 当前 v${current.version}（内容与提交不等），调用方基于 v${facet.baseVersion}`,
      );
    }
    if (current.version !== facet.baseVersion) {
      throw new AppError(
        ErrorCode.Conflict,
        `base_version 过期：${facet.specialty} 当前 v${current.version}，调用方基于 v${facet.baseVersion}（重取后重试）`,
      );
    }
    await uow.query(
      `UPDATE agent_assist.specialty_configs
         SET ${facet.column} = $2::jsonb, ${facet.versionColumn} = $3, updated_at = now()
       WHERE id = $1`,
      [row.id, facet.canonical, target],
    );
    await facet.onCreated(uow, facet.specialty, target);
    return { specialty: facet.specialty, version: target, created: true };
  }

  private async readRow(
    exec: SqlExecutor,
    specialty: string,
    opts: { forUpdate: boolean },
  ): Promise<SpecialtyConfigRow | null> {
    const res = await exec.query<SpecialtyConfigRow>(
      `SELECT ${CONFIG_COLUMNS} FROM agent_assist.specialty_configs
       WHERE specialty = $1 ${opts.forUpdate ? 'FOR UPDATE' : ''}`,
      [specialty],
    );
    return res.rows[0] ?? null;
  }
}
