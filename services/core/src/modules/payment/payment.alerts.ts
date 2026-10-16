/**
 * F1 告警位（B2 slot-lock 告警 mock sink 先例）。
 *
 * 外部对接后置约定（工作约定 2026-10-14）：告警为 mock 适配器（零外部调用、记录到内存数组供
 * 测试断言），接口留供应商位——真实电话/IM/工单通道在 M2+ 经同一 PaymentAlertSink 替换
 * （工单最终落点=H3 死信/对账差异工单面，M2 接线）。⚠ 时序口径同 B2：mock 零外部调用无副作用，
 * 允许在事务提交前发送；接真实供应商时须移至事务提交后（避免事务回滚产生幻影告警）。
 */
import { Injectable } from '@nestjs/common';

export type PaymentAlertKind = 'CALLBACK_DEAD';

export interface PaymentAlert {
  readonly kind: PaymentAlertKind;
  readonly inboxId: number;
  readonly channel: string;
  readonly bizIdempotencyKey: string;
  /** 死信原因（守卫拒绝的迁移路径等审计口径） */
  readonly reason: string;
  readonly message: string;
}

/** 告警出口（供应商位：mock=M2+ 替换为真实通道；工单位=H3） */
export interface PaymentAlertSink {
  send(alert: PaymentAlert): Promise<void>;
}

/** mock 适配器：零外部调用，记录到内存数组供测试断言 */
@Injectable()
export class MockPaymentAlertSink implements PaymentAlertSink {
  readonly alerts: PaymentAlert[] = [];

  async send(alert: PaymentAlert): Promise<void> {
    this.alerts.push(alert);
  }
}

/** 告警服务：sink 组合入口（M2+ 在此加收敛/去重而不动调用方） */
export class PaymentAlertService {
  constructor(private readonly sink: PaymentAlertSink) {}

  /** 回调死信告警（乱序/毒消息：非法推进被守卫拒 → inbox DEAD + 告警位） */
  async alertCallbackDead(
    alert: Omit<PaymentAlert, 'message'> & { readonly message?: string },
  ): Promise<boolean> {
    const { kind, inboxId, channel, bizIdempotencyKey, reason } = alert;
    await this.sink.send({
      kind,
      inboxId,
      channel,
      bizIdempotencyKey,
      reason,
      message:
        alert.message ??
        `回调死信（${reason}）：inbox=${inboxId} channel=${channel} biz=${bizIdempotencyKey}——非法迁移被守卫拒绝，进死信待人工处置（H3 工单 M2 接线）`,
    });
    return true;
  }
}
