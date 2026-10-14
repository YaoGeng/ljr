/**
 * reaper 告警（B2 §2/R-04：锁泄漏兜底「释放 + 告警」）。
 *
 * 外部对接后置约定（工作约定 2026-10-14）：告警为 mock 适配器（零外部调用、记录到内存数组供
 * 测试断言），接口留供应商位——真实电话/IM/工单通道在 M2+ 经同一 SlotLockAlertSink 替换
 * （形态同 SchedulerAlertSink；工单最终落点=H3）。
 *
 * ⚠ 时序口径：告警在 reaper 释放同事务内、提交前发出（mock 零外部调用无副作用）；接真实
 * 供应商时须移至事务提交后（避免事务回滚产生幻影告警），接入点=SlotLockJobExecutors。
 */
import { Injectable } from '@nestjs/common';

export type SlotLockAlertKind = 'LOCK_LEAK';

/** 触发原因：TTL_EXPIRED_BACKSTOP=TTL job 失效后 reaper 兜底；ENTITY_TERMINATED=实体终态超阈残留 */
export type SlotLockAlertReason = 'TTL_EXPIRED_BACKSTOP' | 'ENTITY_TERMINATED';

export interface SlotLockAlert {
  readonly kind: SlotLockAlertKind;
  readonly lockId: number;
  readonly lawyerId: number;
  readonly refType: string;
  readonly refId: number;
  readonly reason: SlotLockAlertReason;
  readonly message: string;
}

/** 告警出口（供应商位：mock=M2+ 替换为真实通道；工单位=H3） */
export interface SlotLockAlertSink {
  send(alert: SlotLockAlert): Promise<void>;
}

/** mock 适配器：零外部调用，记录到内存数组供测试断言 */
@Injectable()
export class MockSlotLockAlertSink implements SlotLockAlertSink {
  readonly alerts: SlotLockAlert[] = [];

  async send(alert: SlotLockAlert): Promise<void> {
    this.alerts.push(alert);
  }
}

/** 告警服务：sink 组合入口（reaper 经此发送；M2+ 在此加收敛/去重而不动调用方） */
export class SlotLockAlertService {
  constructor(private readonly sink: SlotLockAlertSink) {}

  async alertLockLeak(
    alert: Omit<SlotLockAlert, 'message'> & { readonly message?: string },
  ): Promise<boolean> {
    const { lockId, lawyerId, refType, refId, reason } = alert;
    await this.sink.send({
      kind: alert.kind,
      lockId,
      lawyerId,
      refType,
      refId,
      reason,
      message:
        alert.message ??
        `占用锁泄漏兜底（${reason}）：lock=${lockId} lawyer=${lawyerId} ref=${refType}:${String(refId)} 已强制释放`,
    });
    return true;
  }
}
