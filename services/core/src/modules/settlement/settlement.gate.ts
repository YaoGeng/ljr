/**
 * H3 工单闸（R-02「未结纠纷挂起」的查询缝）——W3 无 H3 生产方=恒无未结工单（返回 false，
 * 显性默认而非静默假设：缝位即换装位）；H3=M2 经 registerSource 换装真实工单源
 * （RefundSourceRegistry 同款先例：消费方定义接口，生产方注册实现）。
 *
 * 消费点：releaseDueHold（24h 到期释放前）与 resumeForFirm（进件恢复重驱动前）——
 * 工单未闭则维持 HOLD（hold_reason=OPEN_TICKETS）/回挂起，不得放行分账。
 *
 * SessionAbsenceGate（M2-W4 T2-B1 修复）：D3 缺席判定的查询缝（同文件第二闸、同 registerSource
 * 形态）。消费点=RoomClosed 进结算建行——真实主流时序（PRD §8.5：缺席处理→房间结束→结算）
 * 下 AttendanceAdjudicated 先至而结算行未建（NO_SETTLEMENT warn），建行时回查判定在册补
 * ABSENCE_7030 构成（与既有「关房先→判定后」markAbsenceShare 标记路双覆盖）。D6 1对1 无
 * 缺席分成不经本闸。settlement 依赖树不含 fulfillment（fulfillment.module 头注无环约束）——
 * 源经 FulfillmentModule 侧注册件装配（AttendanceAbsenceRegistration）。
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

/** 缺席判定源接口（D3 生产方注册，M2-W4 T2-B1）：true=该场次存在 user 侧 absent 判定在册；
 *  false=无；null=场次房间不存在（建行语义下收敛为无判定——RoomClosed 刚为该场次触发建行，
 *  房间理应在册，null=防御位）。恒确定性返回不抛——查询失败由源实现方重试语义承担。 */
export interface SessionAbsenceSource {
  sessionUserAbsenceAdjudicated(sessionId: number): Promise<boolean | null>;
}

@Injectable()
export class SessionAbsenceGate {
  private source: SessionAbsenceSource | null = null;

  /** 换装位：注册真实判定源（幂等覆盖——重复注册=换装，不抛；OpenTicketGate 同语义） */
  registerSource(source: SessionAbsenceSource): void {
    this.source = source;
  }

  /** 建行语义：无源/无场次/无判定 全收敛 false（share_mode 缺省 FULL_TO_LAWYER——显性默认） */
  async userAbsenceAdjudicated(sessionId: number): Promise<boolean> {
    return this.source
      ? (await this.source.sessionUserAbsenceAdjudicated(sessionId)) === true
      : false;
  }
}
