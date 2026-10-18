/**
 * RTC 建房适配器（D1 §1「到点开房→RTC 服务建房」；⚠W1-2 决策位）：接口=换装缝，prod 前替换为
 * 声网（R11，M3-W1 开通）真实现；MockRtcProvider=开发期内存实现（零外部调用、零凭据，
 * 外部对接后置约定 2026-10-14）。realname.provider（A2 通道适配器）同款 Symbol 令牌形态。
 *
 * 失败形态可注入：failNextRoom(reason) 令下一次 buildRoom 抛 RtcProviderError——开房失败分支
 * （room CANCELLED+RoomOpenFailed）的确定性测试锚；真通道的错误码同经 Error.message 透传
 * open_fail_reason（varchar(64) 截断）。
 *
 * rtc_room_id 不落 rooms 表（V35 附录 A.3 蓝图逐字无该列）：D1 W1 mock 期房间定位=rooms.id；
 * 真通道接线（M3）若需持久化厂商房间号，走新迁移加列——本接口返回值先行承载换装语义。
 *
 * 真通道换装约束（M3 接线时遵守，T1 评审 Minor-8 注记）：**禁在 DB 事务内同步 HTTP 外呼**
 * （长事务+供应商侧孤儿房不可随本地回滚——网络抖动放大锁持有时间）；须两段式（事务外预建
 * 房→事务内落状态）或事务外预建后补偿（失败回收厂商房），本 mock 的「事务内调用」形态
 * 仅因零网络副作用而成立。
 */
import { Injectable } from '@nestjs/common';

/** 通道绑定 DI 令牌（REALNAME_PROVIDER 同款 Symbol 口径）：测试 override 注入可控通道，
 *  prod 换装（声网）只改模块工厂，服务与用例不感知实现 */
export const RTC_PROVIDER = Symbol('RTC_PROVIDER');

export interface RtcBuildRoomInput {
  readonly sessionId: number;
  readonly mode: 'text' | 'voice' | 'video';
}

export interface RtcBuildRoomResult {
  /** 厂商侧房间标识（mock 期不持久化，见类注换装语义） */
  readonly rtc_room_id: string;
}

export interface RtcProvider {
  /** 通道名（审计口径：AGORA|MOCK…） */
  readonly kind: string;
  buildRoom(input: RtcBuildRoomInput): Promise<RtcBuildRoomResult>;
}

/** 建房失败（通道错误码经 message 透传 open_fail_reason/RoomOpenFailed.reason——开放词汇非 PII） */
export class RtcProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RtcProviderError';
  }
}

/** 内存 mock 通道：sessionId→确定性房间号映射；失败形态可注入（failNextRoom） */
@Injectable()
export class MockRtcProvider implements RtcProvider {
  readonly kind = 'MOCK';
  private readonly builtRooms = new Map<number, string>();
  private readonly buildLog: RtcBuildRoomInput[] = [];
  private failNextReason: string | null = null;

  async buildRoom(input: RtcBuildRoomInput): Promise<RtcBuildRoomResult> {
    if (this.failNextReason !== null) {
      const reason = this.failNextReason;
      this.failNextReason = null;
      throw new RtcProviderError(reason);
    }
    const rtcRoomId = `mock-rtc-${input.sessionId}`;
    this.builtRooms.set(input.sessionId, rtcRoomId);
    this.buildLog.push(input);
    return { rtc_room_id: rtcRoomId };
  }

  /** 注入下一次建房失败（确定性开房失败分支测试锚） */
  failNextRoom(reason: string): void {
    this.failNextReason = reason;
  }

  /** 建房调用轨迹（透传 mode 断言用） */
  get built(): readonly RtcBuildRoomInput[] {
    return [...this.buildLog];
  }
}
