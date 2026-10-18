/**
 * I3 上链存证适配器（D-P9 至信链真对接后置——外部对接后置约定 2026-10-14）：EvidenceChain
 * 接口=换装缝，prod 前替换为至信链真实现；MockEvidenceChain=开发期内存实现（零外部调用、
 * 零凭据，realname.provider/rtc-provider 同款 Symbol 令牌形态）。
 *
 * evidence_id 形态：EV-<yyyymmdd>-<seq>（上海日期+进程内日序号）；凭证与订单关联=artifacts 行
 * ref_type/ref_id（§4 关键流程：凭证与订单关联）。真通道换装约束（RtcProvider 头注同款）：
 * **禁在 DB 事务内同步网络外呼**（archiveRecording 事务内调用本 mock 仅因零网络副作用而成立）；
 * 真实现须两段式（事务外先上链拿凭证→事务内回写 evidence_id，失败补偿=凭证孤儿由哈希幂等吸收）。
 * §8 NFR「上链 ≤5min」由真通道承载，mock 即时返回。
 */
import { Injectable, type InjectionToken } from '@nestjs/common';

/** 通道绑定 DI 令牌（ARTIFACT_STORE 同款 Symbol 口径）：测试 override、prod 换装 */
export const EVIDENCE_CHAIN: InjectionToken<EvidenceChain> = Symbol('EVIDENCE_CHAIN');

export interface EvidenceNotarizeInput {
  /** 存证哈希（artifacts.hash_sha256 同源——R-02 录音哈希上链） */
  readonly hash: string;
  readonly ref_type: string;
  readonly ref_id: number;
}

export interface EvidenceChain {
  /** 通道名（审计口径：MOCK|ZHIXIN…） */
  readonly provider: string;
  /** 存证上链：对哈希存证并返回凭证号 */
  notarize(input: EvidenceNotarizeInput): Promise<{ evidence_id: string }>;
}

/** Asia/Shanghai 固定 +08:00（无夏令时） */
const SHANGHAI_OFFSET_MS = 8 * 3_600_000;

/** 内存 mock 通道：EV-<yyyymmdd>-<seq>（进程内日序号自增） */
@Injectable()
export class MockEvidenceChain implements EvidenceChain {
  readonly provider = 'MOCK';
  private readonly counters = new Map<string, number>();
  private readonly log: EvidenceNotarizeInput[] = [];

  async notarize(input: EvidenceNotarizeInput): Promise<{ evidence_id: string }> {
    const yyyymmdd = new Date(Date.now() + SHANGHAI_OFFSET_MS)
      .toISOString()
      .slice(0, 10)
      .replaceAll('-', '');
    const seq = (this.counters.get(yyyymmdd) ?? 0) + 1;
    this.counters.set(yyyymmdd, seq);
    this.log.push(input);
    return { evidence_id: `EV-${yyyymmdd}-${seq}` };
  }

  /** 上链调用轨迹（测试断言用：重放幂等=不重复上链） */
  get calls(): readonly EvidenceNotarizeInput[] {
    return [...this.log];
  }
}
