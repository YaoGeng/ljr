/**
 * 用户通知偏好服务（I1 §2「可关非关键类」+ §5 GET/PUT /notification-prefs）。
 * 持久层 notify.notification_prefs（控制者裁决 R6：模块文档 §3 未列属文档缺口，最小结构满足）。
 * 偏好粒度=(user_id, template_code)：模板 code 即通知类别，缺省（无记录）=投递。
 */
import { Injectable } from '@nestjs/common';
import { AppError, ErrorCode } from '@ljr/shared';
import type { SqlExecutor } from '../../infrastructure/sql';
import { PgPoolService } from '../../infrastructure/sql';
import { NotifyTemplateService } from './notify-template.service';

export interface NotificationPref {
  readonly templateCode: string;
  readonly enabled: boolean;
  readonly updatedAt: Date;
}

export interface PrefItem {
  readonly templateCode: string;
  readonly enabled: boolean;
}

@Injectable()
export class NotifyPrefsService {
  constructor(
    private readonly pool: PgPoolService,
    private readonly templates: NotifyTemplateService,
  ) {}

  async getPrefs(userId: number): Promise<NotificationPref[]> {
    return this.getPrefsBy(this.pool, userId);
  }

  /**
   * 批量设置偏好（PUT 契约）。校验：模板必须存在（NotFound）；关键类不可关（InvalidArgument，
   * R「可关非关键类」的服务层闸——下发层 isDeliverable 对 critical 另有兜底放行）。
   */
  async putPrefs(userId: number, items: ReadonlyArray<PrefItem>): Promise<NotificationPref[]> {
    return this.pool.withTransaction(async (uow) => {
      for (const item of items) {
        const template = await this.templates.findByCode(uow, item.templateCode);
        if (!item.enabled && template.critical) {
          throw new AppError(ErrorCode.InvalidArgument, `关键类通知不可关闭：${item.templateCode}`);
        }
        await uow.query(
          `INSERT INTO notify.notification_prefs (user_id, template_code, enabled)
           VALUES ($1, $2, $3)
           ON CONFLICT (user_id, template_code)
           DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now()`,
          [userId, item.templateCode, item.enabled],
        );
      }
      return this.getPrefsBy(uow, userId); // 同事务回读，避免读到未提交外的旧值
    });
  }

  /**
   * 偏好过滤（§4 下发链第 3 步）：关键类恒投递；非关键类按偏好行，无记录=投递。
   */
  async isDeliverable(userId: number, templateCode: string): Promise<boolean> {
    const template = await this.templates.find(templateCode);
    if (template.critical) return true;
    const res = await this.pool.query<{ enabled: boolean }>(
      `SELECT enabled FROM notify.notification_prefs WHERE user_id = $1 AND template_code = $2`,
      [userId, templateCode],
    );
    return res.rows[0]?.enabled ?? true;
  }

  private async getPrefsBy(uow: SqlExecutor, userId: number): Promise<NotificationPref[]> {
    const res = await uow.query<{
      template_code: string;
      enabled: boolean;
      updated_at: Date;
    }>(
      `SELECT template_code, enabled, updated_at FROM notify.notification_prefs
        WHERE user_id = $1 ORDER BY template_code`,
      [userId],
    );
    return res.rows.map((r) => ({
      templateCode: r.template_code,
      enabled: r.enabled,
      updatedAt: r.updated_at,
    }));
  }
}
