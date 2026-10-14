import 'reflect-metadata';
import { AppError, ErrorCode } from '@ljr/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { ensureTestDatabase } from '../../infrastructure/testing/db';
import { PgPoolService } from '../../infrastructure/sql';
import { NotifyTemplateService, renderTemplate } from './notify-template.service';

/**
 * PRD §8.2「改价通知话术」原文（R-01 全等断言的事实源，逐字复制自 docs/01-产品设计.md §8.2）。
 * 断言用 toBe 全等比较——话术是 PRD 契约数据，一个字符都不许改。
 */
const PRD_PRICE_UP_LOCKED = '您已锁定原价，当前律师已调价，您享受的是涨价前的价格，不受影响。';
const PRD_PRICE_DOWN_COMP =
  '您参与的服务价格有所调整，您已锁定的原价不受影响。为感谢您的信任，我们已为您申请平台积分补偿，将在 24 小时内到账。';
const PRD_PRICE_DOWN_BIG =
  '您参与的服务价格大幅调整。您已锁定的原价不受影响，我们已为您申请积分补偿 + 额外平台优惠券，将在 24 小时内到账。感谢您的信任与支持。';

describe('I1 R-01 三档改价话术（PRD §8.2 逐字一致，需 PG）', () => {
  let pool: Pool;
  let templates: NotifyTemplateService;

  beforeAll(async () => {
    pool = await ensureTestDatabase();
    templates = new NotifyTemplateService(new PgPoolService(pool));
    // 说明：notification_templates 是 V4 迁移 seed 的参照数据（PRD 话术事实源），
    // 不入 TRUNCATE 清场清单（见 infrastructure/testing/db.ts 头注）；本 spec 只读不写。
  });

  afterAll(async () => {
    await pool.end();
  });

  it('三档模板 seed 与 PRD §8.2 话术全等（渠道 INBOX、非关键类、version=1）', async () => {
    const cases = [
      { code: 'PRICE_UP_LOCKED', content: PRD_PRICE_UP_LOCKED },
      { code: 'PRICE_DOWN_COMP', content: PRD_PRICE_DOWN_COMP },
      { code: 'PRICE_DOWN_BIG', content: PRD_PRICE_DOWN_BIG },
    ] as const;
    for (const c of cases) {
      const t = await templates.find(c.code);
      expect(t.content).toBe(c.content); // 全等：多一字少一字都算 R-01 违规
      expect(t.channel).toBe('INBOX');
      expect(t.critical).toBe(false);
      expect(t.version).toBe(1);
    }
  });

  it('渲染（无参数）：三档话术原样返回，逐字不变', async () => {
    const cases = [
      { code: 'PRICE_UP_LOCKED', content: PRD_PRICE_UP_LOCKED },
      { code: 'PRICE_DOWN_COMP', content: PRD_PRICE_DOWN_COMP },
      { code: 'PRICE_DOWN_BIG', content: PRD_PRICE_DOWN_BIG },
    ] as const;
    for (const c of cases) {
      const rendered = await templates.render(c.code, {});
      expect(rendered.content).toBe(c.content);
      expect(rendered.channel).toBe('INBOX');
      expect(rendered.critical).toBe(false);
    }
  });

  it('参数渲染：{占位符} 被 params 替换，未知占位符保留原样', () => {
    expect(
      renderTemplate('您好 {name}，您的单号 {order_no} 已受理。致 {name}', {
        name: '周女士',
        order_no: 'A-2041',
      }),
    ).toBe('您好 周女士，您的单号 A-2041 已受理。致 周女士');
    expect(renderTemplate('验证码 {code}，{missing} 不替换', { code: '882_1' })).toBe(
      '验证码 882_1，{missing} 不替换',
    );
  });

  it('模板缺失：AppError(NotFound, 404)', async () => {
    let err: unknown;
    try {
      await templates.find('NO_SUCH_TEMPLATE');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe(ErrorCode.NotFound);
    expect((err as AppError).httpStatus).toBe(404);
  });
});
