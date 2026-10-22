import { describe, expect, it } from 'bun:test';
import { notifyTemplateCopy, renderNotifyContent } from './notify-copy';

/**
 * T4 通知文案单源：目录话术=core 种子实文逐字（V4 迁移三档 PRD §8.2 话术 + reminder.service
 * SESSION_REMIND 缺省话术）——全等断言锁拷贝漂移；core 模板修订走新迁移时须同步本目录。
 */
describe('I1 通知文案映射表（模板目录 + 正文渲染，T4）', () => {
  it('三档改价话术与 core V4 种子逐字一致（PRICE_*）', () => {
    expect(renderNotifyContent('PRICE_UP_LOCKED', {})).toBe(
      '您已锁定原价，当前律师已调价，您享受的是涨价前的价格，不受影响。',
    );
    expect(renderNotifyContent('PRICE_DOWN_COMP', {})).toBe(
      '您参与的服务价格有所调整，您已锁定的原价不受影响。为感谢您的信任，我们已为您申请平台积分补偿，将在 24 小时内到账。',
    );
    expect(renderNotifyContent('PRICE_DOWN_BIG', {})).toBe(
      '您参与的服务价格大幅调整。您已锁定的原价不受影响，我们已为您申请积分补偿 + 额外平台优惠券，将在 24 小时内到账。感谢您的信任与支持。',
    );
  });

  it('SESSION_REMIND：{key} 占位替换（ISO 时刻人话化 + kind_label 直替）', () => {
    const out = renderNotifyContent('SESSION_REMIND', {
      session_id: 10,
      kind: 'REMIND_24H',
      slot_start: '2026-11-20T12:00:00.000Z',
      kind_label: '24 小时前',
    });
    expect(out).toContain('将于 2026-11-20 20:00 开始（24 小时前）');
    expect(out).not.toContain('{slot_start}');
    expect(out).not.toContain('{kind_label}');
    // 未消费参数不外泄（session_id 不在话术占位内）
    expect(out).not.toContain('10');
  });

  it('占位符缺值保留原样（core renderTemplate 同形：undefined/null 不替换）', () => {
    const out = renderNotifyContent('SESSION_REMIND', {});
    expect(out).toContain('将于 {slot_start} 开始（{kind_label}）');
  });

  it('五类已知 code 徽标文案 + tone；RESCHEDULE_EXPIRED 无固定话术（content=null）', () => {
    expect(notifyTemplateCopy('PRICE_UP_LOCKED').label).toBe('价格上调 · 原价已锁');
    expect(notifyTemplateCopy('PRICE_DOWN_COMP').label).toBe('价格下调 · 积分补偿');
    expect(notifyTemplateCopy('PRICE_DOWN_BIG').label).toBe('价格大幅下调 · 补偿');
    expect(notifyTemplateCopy('SESSION_REMIND').label).toBe('场次提醒');
    expect(notifyTemplateCopy('RESCHEDULE_EXPIRED').label).toBe('改期请求超时');
    expect(notifyTemplateCopy('RESCHEDULE_EXPIRED').content).toBeNull();
    // 正文=通用文案兜底（RESCHEDULE_EXPIRED 模板未 seed，core 书面上不可达）
    expect(renderNotifyContent('RESCHEDULE_EXPIRED', { request_id: 3 })).toBe(
      '收到一条平台通知（request_id：3）',
    );
  });

  it('未知 code 回退：label=原码 + 通用正文（fail-visible 不吞不编）', () => {
    const copy = notifyTemplateCopy('SOME_FUTURE_CODE');
    expect(copy.label).toBe('SOME_FUTURE_CODE');
    expect(renderNotifyContent('SOME_FUTURE_CODE', {})).toBe('收到一条平台通知');
    expect(renderNotifyContent('SOME_FUTURE_CODE', { amount: '12.00' })).toBe(
      '收到一条平台通知（amount：12.00）',
    );
  });
});
