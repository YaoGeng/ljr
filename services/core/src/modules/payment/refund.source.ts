/**
 * R-W3-M 退款源注册表（F2 模块内部件）：refType → RefundSource 的进程内注册表——
 * SessionFailed 消费器经此取付款人清单；T6 期 trade 侧真实实现不存在（测试注册假源跑全流程），
 * 无源注册时消费端 resolve=null → warn 跳过不炸；T7 C3 落真实实现并注册（trade 侧经
 * PaymentModule 导出注入本注册表——接口契约在 @ljr/shared，实现禁 import 本模块内部件）。
 */
import { Injectable } from '@nestjs/common';
import type { RefundSource } from '@ljr/shared';

@Injectable()
export class RefundSourceRegistry {
  private readonly sources = new Map<string, RefundSource>();

  /** 注册（同键覆盖=后到实现接管；T7 真实实现替换测试假源的同形通道） */
  register(refType: string, source: RefundSource): void {
    this.sources.set(refType, source);
  }

  /** 未注册键返回 null（消费端 warn 跳过——不炸不静默烧重试） */
  resolve(refType: string): RefundSource | null {
    return this.sources.get(refType) ?? null;
  }
}
