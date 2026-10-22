import { describe, expect, it } from 'bun:test';
import {
  agentHealthCopy,
  priceChangeDirectionCopy,
  priceChangeResultCopy,
  SETTLEMENT_REF_TYPE_COPY,
  settlementRefTypeCopy,
  settlementStatusCopy,
  slotStatusCopy,
  weekdayCopy,
} from './lawyer-copy';

describe('B1 时段状态文案（slot_locks 状态视图词汇）', () => {
  it('FREE/PENDING_PAYMENT/LOCKED/OCCUPIED 四态 + tone 色档（周视图配色单源）', () => {
    expect(slotStatusCopy('FREE')).toEqual({ label: '空闲', tone: 'free' });
    expect(slotStatusCopy('PENDING_PAYMENT')).toEqual({ label: '待支付锁定', tone: 'lock' });
    expect(slotStatusCopy('LOCKED')).toEqual({ label: '已锁定', tone: 'lock' });
    expect(slotStatusCopy('OCCUPIED')).toEqual({ label: '已占用', tone: 'busy' });
  });

  it('未知值回退原码 + 中性档（fail-visible 不吞不编）', () => {
    expect(slotStatusCopy('RELEASED')).toEqual({ label: 'RELEASED', tone: 'idle' });
  });
});

describe('F3 结算状态文案（settlement.machine 五态）', () => {
  it('五态逐字 + 未知回退原码', () => {
    expect(settlementStatusCopy('PENDING')).toBe('待结算');
    expect(settlementStatusCopy('HOLD')).toBe('结算冻结中');
    expect(settlementStatusCopy('READY')).toBe('待分账');
    expect(settlementStatusCopy('SETTLED')).toBe('已结算');
    expect(settlementStatusCopy('SUSPENDED')).toBe('分账已暂停');
    expect(settlementStatusCopy('WHATEVER')).toBe('WHATEVER');
  });

  it('结算对象类型（session/one_on_one）', () => {
    expect(settlementRefTypeCopy('session')).toBe(SETTLEMENT_REF_TYPE_COPY.session);
    expect(settlementRefTypeCopy('one_on_one')).toBe('1对1');
    expect(settlementRefTypeCopy('other')).toBe('other');
  });
});

describe('周几文案（B1 weekday 0=周日..6=周六——core normalizeTemplate 口径）', () => {
  it('全宽/短标七值 + 越界回退数字', () => {
    expect(weekdayCopy(0)).toBe('周日');
    expect(weekdayCopy(1)).toBe('周一');
    expect(weekdayCopy(6)).toBe('周六');
    expect(weekdayCopy(9)).toBe('周9');
    expect(weekdayCopy(-1)).toBe('周-1');
  });
});

describe('E1 AI 辅助健康文案', () => {
  it('ok/degraded 二值 + 未知回退原码', () => {
    expect(agentHealthCopy('ok')).toBe('AI 辅助正常');
    expect(agentHealthCopy('degraded')).toBe('AI 辅助不可用');
    expect(agentHealthCopy('sick')).toBe('sick');
  });
});

describe('C6 改价记录状态文案（M3-W2 T3：price-change.types 三态 + direction 二值）', () => {
  it('result 三态徽标（EFFECTED/PENDING_APPROVAL/REJECTED）+ tone 色档', () => {
    expect(priceChangeResultCopy('EFFECTED')).toEqual({ label: '已生效', tone: 'grouped' });
    expect(priceChangeResultCopy('PENDING_APPROVAL')).toEqual({
      label: '待平台审批',
      tone: 'open',
    });
    expect(priceChangeResultCopy('REJECTED')).toEqual({ label: '已否决', tone: 'failed' });
  });

  it('result 未知值回退原码 + 中性档（fail-visible）', () => {
    expect(priceChangeResultCopy('MAYBE')).toEqual({ label: 'MAYBE', tone: 'finished' });
  });

  it('direction 二值（UP=涨价/DOWN=降价）+ 未知回退原码', () => {
    expect(priceChangeDirectionCopy('UP')).toBe('涨价');
    expect(priceChangeDirectionCopy('DOWN')).toBe('降价');
    expect(priceChangeDirectionCopy('FLAT')).toBe('FLAT');
  });
});
