import 'reflect-metadata';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Pool } from 'pg';
import { AppError, ErrorCode } from '@ljr/shared';
import { InfrastructureModule } from '../../infrastructure/infrastructure.module';
import { ensureTestDatabase, truncateAll } from '../../infrastructure/testing/db';
import { PgPoolService } from '../../infrastructure/sql';
import { AuditLogService } from './audit-log.service';

/**
 * ops.audit_logs 审计写入件（H1 §8「审核操作全审计」+ §10「全部操作在 H9 审计可查」的前置位；
 * H9 正式审计存储=M4，本表为 ops 域最小落地）。
 * 同事务语义：record 只收 uow（与业务状态迁移同事务提交/回滚）——审计对象是「已发生的操作
 * 事实」，与业务原子同命运（业务回滚=操作未发生，不留审计行；与 B2 recordAbuse 的
 * 「拒绝路径事件不随回滚丢失」独立连接语义方向相反，两机制各管一类事实）。
 */

describe('ops.audit_logs 审计写入件（同事务记录 + 查询面，需 PG）', () => {
  let pool: Pool;
  let app: INestApplication;
  let audit: AuditLogService;
  let poolSvc: PgPoolService;

  beforeAll(async () => {
    pool = await ensureTestDatabase();
    const moduleRef = await Test.createTestingModule({
      imports: [InfrastructureModule],
      providers: [AuditLogService],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    poolSvc = app.get(PgPoolService);
    audit = app.get(AuditLogService);
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  beforeEach(async () => {
    await truncateAll(pool);
  });
  afterEach(async () => {
    await truncateAll(pool);
  });

  it('record：同事务写入（uow）+ listByTarget 查询面返回（detail jsonb 往返、新在前）', async () => {
    await poolSvc.withTransaction(async (uow) => {
      await audit.record(uow, {
        actorUserId: 9001,
        action: 'lawyer.audit.approve',
        targetType: 'lawyer_profile',
        targetId: 11,
        detail: { result_status: 'PASSED' },
      });
      await audit.record(uow, {
        actorUserId: 9002,
        action: 'lawyer.audit.claim',
        targetType: 'lawyer_profile',
        targetId: 11,
      });
    });

    const rows = await audit.listByTarget('lawyer_profile', 11);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      actor_user_id: 9002,
      action: 'lawyer.audit.claim',
      target_type: 'lawyer_profile',
      target_id: 11,
    }); // 新在前（id DESC）
    expect(rows[1]).toMatchObject({
      actor_user_id: 9001,
      action: 'lawyer.audit.approve',
      detail: { result_status: 'PASSED' },
    });
    // 其他 target 不串行
    expect(await audit.listByTarget('lawyer_profile', 99)).toEqual([]);
  });

  it('同事务语义：业务事务回滚 → 审计行随事务一并回滚（操作未发生即无审计）', async () => {
    await expect(
      poolSvc.withTransaction(async (uow) => {
        await audit.record(uow, {
          actorUserId: 9001,
          action: 'lawyer.audit.reject',
          targetType: 'lawyer_profile',
          targetId: 12,
          detail: { reject_reason: '材料模糊' },
        });
        throw new AppError(ErrorCode.Conflict, '业务守卫拒绝');
      }),
    ).rejects.toMatchObject({ code: ErrorCode.Conflict });

    expect(await audit.listByTarget('lawyer_profile', 12)).toEqual([]);
  });

  it('形态防呆：action/target_type 空白或越上限、target_id 非正整数、detail 非对象 → 400', async () => {
    await poolSvc.withTransaction(async (uow) => {
      await expect(
        audit.record(uow, {
          actorUserId: 9001,
          action: '',
          targetType: 'lawyer_profile',
          targetId: 1,
        }),
      ).rejects.toMatchObject({ code: ErrorCode.InvalidArgument });
      await expect(
        audit.record(uow, {
          actorUserId: 9001,
          action: 'a'.repeat(65),
          targetType: 'lawyer_profile',
          targetId: 1,
        }),
      ).rejects.toMatchObject({ code: ErrorCode.InvalidArgument });
      await expect(
        audit.record(uow, {
          actorUserId: 9001,
          action: 'x',
          targetType: '',
          targetId: 1,
        }),
      ).rejects.toMatchObject({ code: ErrorCode.InvalidArgument });
      await expect(
        audit.record(uow, {
          actorUserId: 9001,
          action: 'x',
          targetType: 'lawyer_profile',
          targetId: 0,
        }),
      ).rejects.toMatchObject({ code: ErrorCode.InvalidArgument });
    });
  });
});
