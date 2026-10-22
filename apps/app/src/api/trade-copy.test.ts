import { describe, expect, it } from 'bun:test';
import {
  ENROLL_ACCEPTED_PENDING,
  enrollOutcomeCopy,
  enrollPayStatusCopy,
  enrollRefTypeCopy,
  groupBuyStatusCopy,
  lawyerGroupBuyStatusCopy,
  payOrderStatusCopy,
  realnameStatusCopy,
  refundStatusCopy,
  trainingConsentStatusCopy,
} from './trade-copy';

describe('交易/身份状态文案映射表（单一事实源，≥8 用例）', () => {
  it('C2 拼团八态逐态文案 + tone（PUBLISHED=进行前/EXPIRED=失败链）', () => {
    expect(groupBuyStatusCopy('PUBLISHED')).toEqual({ label: '拼团中', tone: 'open' });
    expect(groupBuyStatusCopy('REACHED').label).toBe('已成团 · 待律师确认');
    expect(groupBuyStatusCopy('PENDING_LAWYER').label).toBe('待律师确认（12h）');
    expect(groupBuyStatusCopy('CONFIRMED').label).toBe('已确认 · 生成履约场次');
    expect(groupBuyStatusCopy('CONVERTED').label).toBe('律师已认领转化');
    expect(groupBuyStatusCopy('EXPIRED')).toEqual({ label: '已流标 · 退款', tone: 'failed' });
    expect(groupBuyStatusCopy('REFUNDED').label).toBe('已退款');
    expect(groupBuyStatusCopy('REJECTED').label).toBe('律师未接 · 退款');
  });

  it('拼团未知状态回退原码（fail-visible 不吞新枚举）', () => {
    expect(groupBuyStatusCopy('SOMETHING_NEW')).toEqual({
      label: 'SOMETHING_NEW',
      tone: 'finished',
    });
  });

  it('M3-W2 T4 律师视角拼团八态（接单大厅/认领转化语境）+ 未知回退', () => {
    expect(lawyerGroupBuyStatusCopy('PENDING_LAWYER')).toEqual({
      label: '待你确认（12h 窗）',
      tone: 'live',
    });
    expect(lawyerGroupBuyStatusCopy('PUBLISHED')).toEqual({
      label: '拼团中 · 可认领转化',
      tone: 'open',
    });
    expect(lawyerGroupBuyStatusCopy('REACHED').label).toBe('已成团 · 待确认');
    expect(lawyerGroupBuyStatusCopy('CONFIRMED').label).toBe('已接单 · 履约场次已生成');
    expect(lawyerGroupBuyStatusCopy('CONVERTED').label).toBe('已认领 · 转为 B2C 场次');
    expect(lawyerGroupBuyStatusCopy('REJECTED')).toEqual({
      label: '已婉拒 · 用户退款',
      tone: 'failed',
    });
    expect(lawyerGroupBuyStatusCopy('EXPIRED').tone).toBe('failed');
    expect(lawyerGroupBuyStatusCopy('REFUNDED').tone).toBe('finished');
    expect(lawyerGroupBuyStatusCopy('FUTURE_STATE')).toEqual({
      label: 'FUTURE_STATE',
      tone: 'finished',
    });
  });

  it('F1 支付单七态（CREATED 待支付/REFUNDING 退款中/…）', () => {
    expect(payOrderStatusCopy('CREATED').label).toBe('待支付');
    expect(payOrderStatusCopy('FROZEN').label).toBe('支付成功 · 冻结中');
    expect(payOrderStatusCopy('PAID').label).toBe('已支付');
    expect(payOrderStatusCopy('REFUNDING').label).toBe('退款中');
    expect(payOrderStatusCopy('REFUNDED').label).toBe('已退款');
    expect(payOrderStatusCopy('SPLIT').label).toBe('已分账');
    expect(payOrderStatusCopy('CLOSED').label).toBe('已关单');
    expect(payOrderStatusCopy('WEIRD').label).toBe('WEIRD');
  });

  it('A2 实名四态 + 未知回退', () => {
    expect(realnameStatusCopy('NONE')).toBe('未实名');
    expect(realnameStatusCopy('PENDING')).toBe('核验中');
    expect(realnameStatusCopy('VERIFIED')).toBe('已实名');
    expect(realnameStatusCopy('FAILED')).toBe('核验未通过（可重新提交）');
    expect(realnameStatusCopy('X')).toBe('X');
  });

  it('A2 训练授权三态 + 未知回退', () => {
    expect(trainingConsentStatusCopy('ABSENT')).toBe('未授权');
    expect(trainingConsentStatusCopy('GRANTED')).toBe('已授权');
    expect(trainingConsentStatusCopy('REVOKED')).toBe('已撤回');
    expect(trainingConsentStatusCopy('Y')).toBe('Y');
  });

  it('报名支付结果态：FULL=已成团 / CREATED=待成团 / FAILED=流标退款收口', () => {
    expect(enrollOutcomeCopy('FULL').title).toBe('报名成功 · 已成团');
    expect(enrollOutcomeCopy('CREATED').title).toBe('报名成功 · 待成团');
    expect(enrollOutcomeCopy('FAILED').title).toBe('支付已受理 · 场次未成团');
    expect(enrollOutcomeCopy('FAILED').note).toContain('全额自动退款');
    expect(enrollOutcomeCopy('SETTLED').title).toBe('报名成功'); // 未知态保守收口
  });

  it('评审 I4 降级收口：ENROLL_ACCEPTED_PENDING（已受理·确认中，不翻失败态）', () => {
    expect(ENROLL_ACCEPTED_PENDING.title).toBe('支付已受理 · 成团确认中');
    expect(ENROLL_ACCEPTED_PENDING.note).toContain('我的报名');
    expect(ENROLL_ACCEPTED_PENDING.note).not.toContain('失败');
  });

  it('T4 C3 报名支付五态 + 未知回退（enrollment.machine 实文）', () => {
    expect(enrollPayStatusCopy('PENDING')).toEqual({ label: '待支付', tone: 'open' });
    expect(enrollPayStatusCopy('PAID')).toEqual({ label: '已支付', tone: 'grouped' });
    expect(enrollPayStatusCopy('REFUNDED').label).toBe('已退款');
    expect(enrollPayStatusCopy('CONVERTED_OUT').label).toBe('已转入拼团场次');
    expect(enrollPayStatusCopy('RESCHEDULED_OUT').label).toBe('已改期迁移');
    expect(enrollPayStatusCopy('NEW_STATE')).toEqual({ label: 'NEW_STATE', tone: 'finished' });
  });

  it('T4 退款态四态 + 未知回退（EnrollmentRefundStatus 实文）', () => {
    expect(refundStatusCopy('NONE').label).toBe('无退款');
    expect(refundStatusCopy('PROCESSING')).toEqual({ label: '退款处理中', tone: 'failed' });
    expect(refundStatusCopy('REFUNDED').label).toBe('已退款');
    expect(refundStatusCopy('FAILED').label).toBe('退款失败');
    expect(refundStatusCopy('QUEUED_LIKE')).toEqual({ label: 'QUEUED_LIKE', tone: 'finished' });
  });

  it('T4 报名对象类型二值 + 未知回退（ref_type）', () => {
    expect(enrollRefTypeCopy('session')).toBe('场次报名');
    expect(enrollRefTypeCopy('groupbuy')).toBe('拼团报名');
    expect(enrollRefTypeCopy('mystery')).toBe('mystery');
  });
});
