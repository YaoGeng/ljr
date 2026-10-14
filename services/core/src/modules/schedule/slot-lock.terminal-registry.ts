/**
 * 终态判定器注册表（ref_type → TerminalStateProvider；R-04 reaper 的关联实体终态判定通道）。
 *
 * 边界纪律（架构 §3.2）：B2 禁直连 trade.* 业务表——判定经各业务模块注册的 provider 抽象完成
 * （真实 provider 随 C1/C2/C5 落位注册，W1 以测试 stub 验证）。形态同 ScheduleExecutorRegistry：
 * 默认空表；重复注册同一 ref_type 即抛（配置错误不静默吞）。
 */
import { Injectable } from '@nestjs/common';
import { AppError, ErrorCode } from '@ljr/shared';
import type { SlotLockRefType, TerminalStateProvider } from './slot-lock.types';

@Injectable()
export class TerminalStateRegistry {
  private readonly providers = new Map<SlotLockRefType, TerminalStateProvider>();

  register(refType: SlotLockRefType, provider: TerminalStateProvider): this {
    if (this.providers.has(refType)) {
      throw new AppError(ErrorCode.ConfigInvalid, `终态判定器重复注册：${refType}`);
    }
    this.providers.set(refType, provider);
    return this;
  }

  /** 未注册 ref_type 返回 null（reaper 跳过该锁，宁漏不误杀） */
  get(refType: SlotLockRefType): TerminalStateProvider | null {
    return this.providers.get(refType) ?? null;
  }
}
