/**
 * 模板中心服务（I1 §2/§9）：code 化模板 + 参数渲染。
 * 话术文案统一在模板中心（notify.notification_templates，PRD seed 随迁移版本化），
 * 业务模块禁止硬编码话术（§9）——本服务是渲染的唯一入口。
 */
import { Injectable } from '@nestjs/common';
import { AppError, ErrorCode } from '@ljr/shared';
import type { SqlExecutor } from '../../infrastructure/sql';
import { PgPoolService } from '../../infrastructure/sql';
import type { NotifyChannel } from './notify.channels';

export interface NotifyTemplate {
  readonly code: string;
  readonly channel: NotifyChannel;
  readonly content: string;
  readonly version: number;
  readonly critical: boolean;
}

export interface RenderedTemplate {
  readonly content: string;
  readonly channel: NotifyChannel;
  readonly critical: boolean;
}

/**
 * 参数渲染：`{key}` 占位符被 params[key] 替换；params 缺失的占位符保留原样
 * （不吞不炸——渲染结果可人工比对；三档改价话术无占位符，渲染即原文，R-01 全等可验）。
 */
export function renderTemplate(content: string, params: Record<string, unknown>): string {
  return content.replace(/\{([A-Za-z0-9_]+)\}/g, (raw, key: string) => {
    const value = params[key];
    return value === undefined || value === null ? raw : String(value);
  });
}

@Injectable()
export class NotifyTemplateService {
  constructor(private readonly pool: PgPoolService) {}

  async find(code: string): Promise<NotifyTemplate> {
    return this.findByCode(this.pool, code);
  }

  /** uow 版：供消费/下发事务内取模板（同事务一致性） */
  async findByCode(uow: SqlExecutor, code: string): Promise<NotifyTemplate> {
    const res = await uow.query<{
      code: string;
      channel: NotifyChannel;
      content: string;
      version: number;
      critical: boolean;
    }>(
      `SELECT code, channel, content, version, critical FROM notify.notification_templates WHERE code = $1`,
      [code],
    );
    const row = res.rows[0];
    if (!row) {
      throw new AppError(ErrorCode.NotFound, `通知模板不存在：${JSON.stringify(code)}`);
    }
    return row;
  }

  async render(code: string, params: Record<string, unknown>): Promise<RenderedTemplate> {
    const template = await this.find(code);
    return {
      content: renderTemplate(template.content, params),
      channel: template.channel,
      critical: template.critical,
    };
  }
}
