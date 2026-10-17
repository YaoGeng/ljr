/**
 * H4 资损巡检告警出口（供应商位，简报裁决：patrol 域自建 PatrolAlertSink——kind 语义与
 * SchedulerAlertSink 不同（五类资损不变量 vs 调度告警），接口形态对齐 scheduler-alerts 先例；
 * 不强行上提 shared（复用面 <3 处））。
 *
 * 外部对接后置约定（工作约定 2026-10-14 + W4 许可桩清单增量）：电话/工单通道=M2+ 经同一
 * PatrolAlertSink 替换（FAILED 工单位落 H3 dead_letter 同期）；dev=内存 mock（零外部调用、
 * 零凭据）。dev 口径：CRITICAL 级新入账违例触发 sink.send，WARN 级=台账留痕（severity 映射
 * 见 patrol.types PATROL_KIND_SEVERITY ⚠裁决位）。
 */
import { Injectable } from '@nestjs/common';
import type { InjectionToken } from '@nestjs/common';
import type { PatrolKind, PatrolSeverity } from './patrol.types';

export interface PatrolAlert {
  readonly kind: PatrolKind;
  readonly severity: PatrolSeverity;
  readonly refType: string;
  readonly refId: number;
  readonly message: string;
}

/** 告警出口（供应商位：dev=MockPatrolAlertSink；M2+ 替换真实电话/工单通道） */
export interface PatrolAlertSink {
  send(alert: PatrolAlert): Promise<void>;
}

/** DI 令牌：PATROL_ALERT_SINK 绑定=供应商位缝合点（dev 绑 MockPatrolAlertSink，useExisting） */
export const PATROL_ALERT_SINK: InjectionToken<PatrolAlertSink> = Symbol('PATROL_ALERT_SINK');

/** dev mock：零外部调用，记录到内存数组供测试断言（供应商位=M2+ 换装） */
@Injectable()
export class MockPatrolAlertSink implements PatrolAlertSink {
  readonly alerts: PatrolAlert[] = [];

  async send(alert: PatrolAlert): Promise<void> {
    this.alerts.push(alert);
  }
}
