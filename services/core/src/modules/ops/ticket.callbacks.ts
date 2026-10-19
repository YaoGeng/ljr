/**
 * H3 处置回调器（§1「不做执行——回调发起方」+ §2「审批动作 → 回调发起方模块（幂等）」）。
 *
 * 注入形态（任务简报）：action_payload 携带 target 时经本注册表路由到对应回调器——
 * 本批接 C6 改价审批一条真链（PriceChangeService.approve 既有 API，幂等键=history 终态
 * 不翻案）；D4 cancellations approve=**W2 T3 接线位**（T3 落位时向本注册表 register
 * target='d4' 即通，H3 侧零改动）。未注册 target 显式 400（resolve 意味着回调已生效——
 * 不静默跳过；§9「禁止审批逻辑内嵌资损规则（只透传决策）」的同向纪律）。
 *
 * 恰一次语义（§8/§10-2）：回调在工单终态迁移事务内、状态更新前发起；目标侧幂等
 * （pricing approve 重放零副作用）收敛 at-least-once 崩溃窗口（回调已落地而工单事务回滚
 * → 重试 resolve：回调目标侧幂等 no-op + 工单再迁移，效果恰一次）。
 */
import { Injectable } from '@nestjs/common';
import { PriceChangeService } from '../pricing/price-change.service';

/**
 * 回调器接口（D4=T3 接线位实现方）：target=action_payload 路由词；idField=发起方实体 id
 * 在 action_payload 中的字段名（pricing=price_change_id / d4=cancellation_id，任务简报形状）。
 */
export interface TicketResolveCallback {
  readonly target: string;
  readonly idField: string;
  /** 发起方续跑（refId=发起方实体 id；approved=决策透传——回调器不得内嵌资损规则） */
  invoke(input: {
    readonly ticketId: number;
    readonly refId: number;
    readonly approved: boolean;
  }): Promise<void>;
}

/** C6 改价审批回调（真链）：POST /pricing/change/{id}/approve 既有 API 的服务面直调 */
export class PricingApproveCallback implements TicketResolveCallback {
  readonly target = 'pricing';
  readonly idField = 'price_change_id';

  constructor(private readonly priceChange: PriceChangeService) {}

  async invoke(input: {
    readonly ticketId: number;
    readonly refId: number;
    readonly approved: boolean;
  }): Promise<void> {
    // approval_id=H3 工单 id（C6 ApproveInput 注释逐字：①期人工兜底=处置凭据 id）；
    // 幂等键=history（终态重放返回既有结果零副作用）→ 本回调 at-least-once 安全
    await this.priceChange.approve(input.refId, {
      approved: input.approved,
      approval_id: input.ticketId,
    });
  }
}

/** 回调器注册表（回调器注入形态的装配点：模块构造期注册 pricing，D4=T3 追加） */
@Injectable()
export class TicketResolveCallbackRegistry {
  private readonly byTarget = new Map<string, TicketResolveCallback>();

  constructor(priceChange: PriceChangeService) {
    this.register(new PricingApproveCallback(priceChange));
    // D4 cancellations approve 回调=W2 T3 接线位（cancellation 表 T3 才落库；
    // 届时 register({target:'d4', idField:'cancellation_id', ...}) 即通，H3 侧零改动）
  }

  /** 注册/换装（幂等覆盖） */
  register(callback: TicketResolveCallback): void {
    this.byTarget.set(callback.target, callback);
  }

  find(target: string): TicketResolveCallback | undefined {
    return this.byTarget.get(target);
  }
}
