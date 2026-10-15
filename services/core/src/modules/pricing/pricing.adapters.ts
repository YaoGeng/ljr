/**
 * R-W2-9 适配位：在团判定内部接口 isInGroup(lawyerId)——C1/C2（W3）接线转真（真实现经接口/
 * 事件取拼团状态，不跨 schema 直查）；本批默认实现恒 false。
 * I1「通知已参与拼团用户」同理 W3 接线：PriceVersionCreated 事件照发（outbox 同事务），
 * 消费端由 I1 落位——本模块不自带消费端（C6 回流 PriceChangeApproved/Rejected 亦 W3）。
 */
import { Injectable, type InjectionToken } from '@nestjs/common';

export interface InGroupProbe {
  isInGroup(lawyerId: number): Promise<boolean>;
}

/** DI 令牌（PRICING_CACHE_CONFIG 同款 Symbol 口径：纯 interface 无运行时类型 token） */
export const IN_GROUP_PROBE: InjectionToken<InGroupProbe> = Symbol('IN_GROUP_PROBE');

/** 默认实现：恒 false（本批无拼团数据源；W3 换装真实现，接口不变，409 分支经注入钉住） */
@Injectable()
export class InGroupProbeStub implements InGroupProbe {
  async isInGroup(_lawyerId: number): Promise<boolean> {
    return false;
  }
}
