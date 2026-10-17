/**
 * H3 工单闸（R-02「未结纠纷挂起」的查询缝）——W3 无 H3 生产方=恒无未结工单（返回 false，
 * 显性默认而非静默假设：缝位即换装位）；H3=M2 经 registerSource 换装真实工单源
 * （RefundSourceRegistry 同款先例：消费方定义接口，生产方注册实现）。
 *
 * 消费点：releaseDueHold（24h 到期释放前）与 resumeForFirm（进件恢复重驱动前）——
 * 工单未闭则维持 HOLD（hold_reason=OPEN_TICKETS）/回挂起，不得放行分账。
 */
import { Injectable } from '@nestjs/common';
import type { SettlementRefType } from './settlement.types';

/** 工单源接口（H3=M2 注册；hasOpenTicket 恒确定性返回，不抛——查询失败由源实现方重试语义承担） */
export interface OpenTicketSource {
  hasOpenTicket(refType: SettlementRefType, refId: number): Promise<boolean>;
}

@Injectable()
export class OpenTicketGate {
  private source: OpenTicketSource | null = null;

  /** H3=M2 换装位：注册真实工单源（幂等覆盖——重复注册=换装，不抛） */
  registerSource(source: OpenTicketSource): void {
    this.source = source;
  }

  async hasOpenTicket(refType: SettlementRefType, refId: number): Promise<boolean> {
    return this.source ? this.source.hasOpenTicket(refType, refId) : false;
  }
}
