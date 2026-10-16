import { describe, expect, it } from 'bun:test';
import {
  REFUND_COMPLETED_TOPIC,
  RefundCompletedPayload,
  REFUND_FAILED_TOPIC,
  RefundFailedPayload,
} from './events';
import { REFUND_SOURCE_REF_TYPE_SESSION, RefundSource, RefundSourceOrder } from './refund-source';
import { assertMoney } from './money';

describe('F2 退款事件契约（M1-W3 T6）：topic 命名 + 载荷形状（金额 Money 字符串禁 float）', () => {
  it('RefundCompleted：topic=payment.refund.completed，{refund_id, order_id, amounts{cash,points}}', () => {
    expect(REFUND_COMPLETED_TOPIC).toBe('payment.refund.completed');
    const payload: RefundCompletedPayload = {
      refund_id: 1,
      order_id: 2,
      amounts: { cash: '80.00', points: 2000 },
    };
    expect(payload.refund_id).toBe(1);
    assertMoney(payload.amounts.cash);
    expect(payload.amounts.points).toBe(2000);
  });

  it('RefundFailed：topic=payment.refund.failed，{refund_id, order_id, reason, attempts, last_error}', () => {
    expect(REFUND_FAILED_TOPIC).toBe('payment.refund.failed');
    const payload: RefundFailedPayload = {
      refund_id: 3,
      order_id: 4,
      reason: 'GROUP_FAIL',
      attempts: 3,
      last_error: 'channel unavailable',
    };
    expect(payload.attempts).toBe(3);
    expect(payload.reason).toBe('GROUP_FAIL');
  });
});

describe('R-W3-M 退款源接口契约（Ruling：付款人清单经 trade 退款源接口）', () => {
  it('RefundSourceOrder：{payment_order_id, user_id, cash_amount, points_amount}（原支付拆分快照）', () => {
    const row: RefundSourceOrder = {
      payment_order_id: 11,
      user_id: 601,
      cash_amount: '100.00',
      points_amount: 0,
    };
    assertMoney(row.cash_amount);
    expect(row.payment_order_id).toBe(11);
  });

  it('RefundSource：listPaidPaymentOrders(refId)→已支付单清单；会话源注册键常量=session', async () => {
    expect(REFUND_SOURCE_REF_TYPE_SESSION).toBe('session');
    const fake: RefundSource = {
      listPaidPaymentOrders: async (refId) =>
        refId === 7
          ? [{ payment_order_id: 11, user_id: 601, cash_amount: '100.00', points_amount: 0 }]
          : [],
    };
    const rows = await fake.listPaidPaymentOrders(7);
    expect(rows).toHaveLength(1);
    expect((await fake.listPaidPaymentOrders(8)).length).toBe(0);
  });
});
