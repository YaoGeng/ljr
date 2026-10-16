import { describe, expect, it } from 'vitest';
import { ErrorCode } from '@ljr/shared';
import {
  PAYMENT_INBOX_MACHINE,
  PAYMENT_ORDER_MACHINE,
  type PaymentInboxStatus,
  type PaymentOrderStatus,
} from './payment.machine';

/**
 * F1 状态机迁移矩阵（Task 1 简报「迁移矩阵你定义并全用例钉住」）：
 *   - payment_order（entity_type='payment_order'）七态，矩阵含合规红线：
 *     「解冻分账只发生在 PAID 这一个节点」（lj-payment-invariants 五——FROZEN 未确认支付不得
 *     分账）；CLOSED 唯一终态无出边；REFUNDED→REFUNDING 允许（多次部分退款，R-03）。
 *   - payment_inbox（entity_type='payment_inbox'）三态：RECEIVED→CONSUMED/DEAD；
 *     CONSUMED/DEAD 均无出边（死信语义=消费面终局，复活走人工/工单面 H3，不在本批）。
 */

const ORDER_LEGAL: ReadonlyArray<readonly [PaymentOrderStatus, PaymentOrderStatus, string]> = [
  ['CREATED', 'FROZEN', '支付成功（PAY_SUCCESS 回调推进，资金冻结托管，架构 §4.4）'],
  ['CREATED', 'CLOSED', '未支付关单（超时/取消）'],
  ['FROZEN', 'PAID', '业务确认支付（成团/接单确认，Core 指令）'],
  ['FROZEN', 'REFUNDING', '冻结期退款指令（未确认即退——满员/超时场景）'],
  ['PAID', 'REFUNDING', '退款指令下发（§5 POST /pay/refund）'],
  ['PAID', 'SPLIT', '解冻分账（唯一解冻节点：HOLD 结束后，架构 §4.4 合规 R1）'],
  ['REFUNDING', 'REFUNDED', '退款完成（REFUND_SUCCESS 回调推进）'],
  ['REFUNDED', 'REFUNDING', '再次部分退款（R-03 partialRefund 多次指令）'],
  ['REFUNDED', 'CLOSED', '退款关单'],
  ['SPLIT', 'CLOSED', '分账完成归档关单'],
];

const ORDER_ILLEGAL: ReadonlyArray<readonly [PaymentOrderStatus, PaymentOrderStatus]> = [
  ['CREATED', 'PAID'], // 未冻结先确认：跳过冻结托管节点
  ['CREATED', 'SPLIT'], // 未支付分账：BLOCKER 级资金释放路径
  ['CREATED', 'REFUNDING'], // 未冻结退款（无资金可退）
  ['CREATED', 'REFUNDED'],
  ['FROZEN', 'SPLIT'], // 未确认支付不得分账（lj-payment-invariants 五）
  ['FROZEN', 'CLOSED'], // 冻结期资金必须先退（REFUNDING）不得直接关单
  ['FROZEN', 'REFUNDED'],
  ['FROZEN', 'FROZEN'], // 自环非迁移
  ['PAID', 'FROZEN'],
  ['PAID', 'CLOSED'], // 已确认支付须先退款（REFUNDING→REFUNDED）或分账，不得直接关单
  ['PAID', 'PAID'],
  ['REFUNDING', 'PAID'], // 退款失败重试不发起新迁移（停留 REFUNDING）
  ['REFUNDING', 'SPLIT'],
  ['REFUNDED', 'PAID'],
  ['REFUNDED', 'SPLIT'],
  ['SPLIT', 'PAID'],
  ['SPLIT', 'REFUNDING'], // 分账后资金已释放，退款不可达（分账后无法追回，架构 §4.4）
  ['SPLIT', 'SPLIT'],
  ['CLOSED', 'CREATED'],
  ['CLOSED', 'FROZEN'],
  ['CLOSED', 'PAID'],
  ['CLOSED', 'REFUNDING'],
  ['CLOSED', 'REFUNDED'],
  ['CLOSED', 'SPLIT'],
];

describe('F1 payment_order 状态机（entity_type=payment_order，七态迁移矩阵全用例钉住）', () => {
  it('entity_type 与状态全集照 §3 注释七态', () => {
    expect(PAYMENT_ORDER_MACHINE.def.entityType).toBe('payment_order');
    expect([...PAYMENT_ORDER_MACHINE.def.states]).toEqual([
      'CREATED',
      'FROZEN',
      'PAID',
      'REFUNDING',
      'REFUNDED',
      'SPLIT',
      'CLOSED',
    ]);
  });

  it(`合法迁移恰 ${ORDER_LEGAL.length} 条（矩阵冻结）`, () => {
    expect(PAYMENT_ORDER_MACHINE.def.transitions.length).toBe(ORDER_LEGAL.length);
  });

  it.each(ORDER_LEGAL)('合法：%s → %s（%s）', (from, to) => {
    expect(PAYMENT_ORDER_MACHINE.canTransition(from, to)).toBe(true);
    expect(() => PAYMENT_ORDER_MACHINE.assertTransition(from, to)).not.toThrow();
  });

  it.each(ORDER_ILLEGAL)('非法：%s → %s 拒绝（StateIllegalTransition, 409）', (from, to) => {
    expect(PAYMENT_ORDER_MACHINE.canTransition(from, to)).toBe(false);
    try {
      PAYMENT_ORDER_MACHINE.assertTransition(from, to);
      expect.unreachable('非法迁移必须抛出');
    } catch (e) {
      expect((e as { code?: string }).code).toBe(ErrorCode.StateIllegalTransition);
      expect((e as { httpStatus?: number }).httpStatus).toBe(409);
    }
  });
});

describe('F1 payment_inbox 状态机（entity_type=payment_inbox，RECEIVED|CONSUMED|DEAD）', () => {
  it('entity_type 与状态全集照 §3 注释三态', () => {
    expect(PAYMENT_INBOX_MACHINE.def.entityType).toBe('payment_inbox');
    expect([...PAYMENT_INBOX_MACHINE.def.states]).toEqual(['RECEIVED', 'CONSUMED', 'DEAD']);
  });

  it('合法：RECEIVED→CONSUMED（消费成功）/ RECEIVED→DEAD（非法推进被守卫拒→死信+告警位）', () => {
    expect(PAYMENT_INBOX_MACHINE.canTransition('RECEIVED', 'CONSUMED')).toBe(true);
    expect(PAYMENT_INBOX_MACHINE.canTransition('RECEIVED', 'DEAD')).toBe(true);
  });

  it.each([
    ['CONSUMED', 'RECEIVED'],
    ['CONSUMED', 'DEAD'],
    ['CONSUMED', 'CONSUMED'],
    ['DEAD', 'RECEIVED'],
    ['DEAD', 'CONSUMED'],
    ['DEAD', 'DEAD'],
  ] as ReadonlyArray<readonly [PaymentInboxStatus, PaymentInboxStatus]>)(
    '非法：%s → %s（终态无出边，死信复活不在本批）',
    (from, to) => {
      expect(PAYMENT_INBOX_MACHINE.canTransition(from, to)).toBe(false);
      expect(() => PAYMENT_INBOX_MACHINE.assertTransition(from, to)).toThrow();
    },
  );
});
