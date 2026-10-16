/**
 * F1 双通道抽象（⚠W3-3 落位）：PaymentChannelAdapter 八原语 + 双 mock 适配器（wechat_ecom 主 /
 * alipay 备）+ 切换路由。开发期通道全 mock（工作约定 2026-10-14「外部对接后置」）；服务剥离=V2
 * 演进路径（架构 §2.1/§3.3），届时真实适配器实现同一接口替换，服务面零改动。
 *
 * mock 口径（E3 embedding 确定性 mock 先例）：
 *   - 零网络请求：pay_params 为 mockpay:// 非网络形态 URL（含 order_id 供模拟器回调用），
 *     assertOutboundTarget 守卫拒绝 http(s) 环回/私网 host——M2 真通道适配器的出站校验缝
 *     （沿 E1/W2 守卫形态；本批 mock 不发真网请求，守卫单测钉住形态）；
 *   - 故障注入（§8 切换演练的 mock 触发器）：adapter.fault = {kind} 公开测试钩子——
 *     CHANNEL_ERROR=通道故障（healthy()=false，路由切换），INSUFFICIENT=业务应答（deduct 专有，
 *     不触发切换）；生产构造无故障标志位；
 *   - 账单日志：指令成功即入内存日志（statement 数据源，period=指令时 UTC 日期，时钟可注入）；
 *   - 流水号确定性递增 MOCK-<CHAN>-<6位>；同参 preorder 的 mock_pay_url 恒同（幂等重放
 *     「原 pay_params」由确定性构造承担，流水号幂等由 DB 唯一约束承担）。
 *
 * ChannelRouter（§8「单通道故障 5min 内切换」）：主→备顺序尝试；CHANNEL_ERROR 翻降级
 * （degradedUntil=now+switchWindowMs，默认 5min=切换 SLA 的窗口承载，恢复=窗口过后由流量探测，
 * M2 换主动探活）；INSUFFICIENT 业务应答不触发切换原样上抛；双通道全故障 E_CHANNEL_UNAVAILABLE。
 * statementOf 直连指定适配器不经 failover——对账必须用指令实际发生通道的账单。
 */
import { AppError, ErrorCode, type Money } from '@ljr/shared';
import { type InjectionToken } from '@nestjs/common';

export type PaymentChannelName = 'wechat_ecom' | 'alipay';

/** DI 令牌：适配器实例数组 [主, 备]（module useFactory 装配；测试可 override） */
export const PAYMENT_CHANNEL_ADAPTERS: InjectionToken<readonly PaymentChannelAdapter[]> = Symbol(
  'PAYMENT_CHANNEL_ADAPTERS',
);

/** 通道指令通用入参（amount=Money 字符串；idempotencyKey=业务幂等键，通道侧透传审计） */
export interface ChannelInstructionRequest {
  /** 本地支付单 id（deduct 无单可挂 → null） */
  readonly orderId: number | null;
  readonly amount: Money;
  readonly idempotencyKey: string;
}

/** 预下单入参（§4 下单：Core 提交含幂等号/金额拆分 → 通道预下单/冻结 → 返回支付参数） */
export interface ChannelPreorderRequest extends ChannelInstructionRequest {
  readonly orderId: number;
  readonly bizType: string;
  readonly bizId: number;
  readonly pointsAmount: number;
}

/** 违约扣减入参（§5 /pay/deduct：lawyer 待结算/保证金专户扣划，余额事实源在业务模块台账） */
export interface ChannelDeductRequest extends ChannelInstructionRequest {
  readonly orderId: null;
  readonly lawyerId: number;
  readonly from: 'settlement' | 'deposit';
}

/** 通道应答（mock 形态；真实通道=M2 换报文转换层，接口不变）。payParams 仅预下单返回。 */
export interface ChannelResult {
  readonly channelTxnNo: string;
  readonly payParams?: {
    /** mockpay:// 非网络形态（真实通道=通道 SDK 报文位） */
    readonly mock_pay_url: string;
    readonly order_id: number;
  };
}

/** 对账账单行（§2/§4：T+1 对账文件行；status 恒 SUCCESS=通道侧成功口径） */
export interface StatementLine {
  readonly channelTxnNo: string;
  readonly direction: 'PAY' | 'REFUND' | 'SPLIT' | 'DEDUCT';
  readonly amount: Money;
  readonly status: 'SUCCESS';
}

/** 通道故障/业务应答错误（非 AppError——通道侧错误≠本服务 API 契约错误） */
export class ChannelFaultError extends Error {
  constructor(
    /** CHANNEL_ERROR=通道故障（可切换）；INSUFFICIENT=余额不足业务应答（不可切换） */
    readonly kind: 'CHANNEL_ERROR' | 'INSUFFICIENT',
    readonly channel: string,
    message: string,
  ) {
    super(`[${channel}] ${message}`);
    this.name = 'ChannelFaultError';
  }
}

export interface PaymentChannelAdapter {
  readonly channel: PaymentChannelName;
  /** 健康检查（mock=故障标志取反；真实通道=M2 探活实现） */
  healthy(): boolean;
  /** 确定性支付参数构造（幂等重放「原 pay_params」的载体——同 (orderId, bizType) 恒同 URL，
   *  与 preorder 报文同构，不产生通道副作用） */
  payParamsFor(
    orderId: number,
    bizType: string,
  ): { readonly mock_pay_url: string; readonly order_id: number };
  preorder(req: ChannelPreorderRequest): Promise<ChannelResult>;
  /** 冻结（§4 下单即冻结托管） */
  freeze(req: ChannelInstructionRequest): Promise<ChannelResult>;
  /** 续冻（成团时仅续冻不释放，架构 §4.4 合规 R1） */
  refreeze(req: ChannelInstructionRequest): Promise<ChannelResult>;
  /** 解冻分账（唯一解冻节点：HOLD 结束后） */
  unfreezeSplit(req: ChannelInstructionRequest): Promise<ChannelResult>;
  /** 全额退款（现金原路退，R-03） */
  refund(req: ChannelInstructionRequest): Promise<ChannelResult>;
  /** 部分退款 */
  partialRefund(req: ChannelInstructionRequest): Promise<ChannelResult>;
  /** 违约扣减（待结算余额 → 保证金专户补足的指令面，架构 §4.4） */
  deduct(req: ChannelDeductRequest): Promise<ChannelResult>;
  /** 对账文件拉取（T+1，R-04） */
  statement(period: string): Promise<StatementLine[]>;
}

const PERIOD_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 指令时点 → 对账期（UTC 日期口径；可注入时钟保测试确定性） */
function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export class MockChannelAdapter implements PaymentChannelAdapter {
  readonly channel: PaymentChannelName;

  /**
   * 故障注入钩子（测试专有；生产构造不设置）。CHANNEL_ERROR：healthy()=false 且全部原语抛错；
   * INSUFFICIENT：仅 deduct 抛（其余原语正常——业务应答≠通道故障）。
   */
  fault: { readonly kind: 'CHANNEL_ERROR' | 'INSUFFICIENT' } | null = null;

  private seq = 0;
  /** 账单金额漂移位（setStatementDiscrepancy 写入；statement 渲染时替换金额，AMOUNT_MISMATCH 构造） */
  private readonly discrepancies = new Map<string, Money>();
  /** 账单日志（statement 数据源）；对账用例可直读/直改以构造差异场景 */
  private readonly journal: Array<{
    readonly period: string;
    readonly channelTxnNo: string;
    readonly direction: StatementLine['direction'];
    readonly amount: Money;
  }> = [];
  private readonly clock: () => Date;

  constructor(
    channel: PaymentChannelName,
    private readonly merchantId: string,
    // 通道密钥经 env 注入（payment.config）；本类不持有真实凭据字面量——mock 密钥仅参与
    // mock_pay_url 确定性构造不参与签名（回调验签密钥在网关服务侧）。
    private readonly channelSecret: string,
    now: () => Date = () => new Date(),
  ) {
    this.channel = channel;
    this.clock = now;
  }

  healthy(): boolean {
    return this.fault?.kind !== 'CHANNEL_ERROR';
  }

  /** 确定性支付参数（与 preorder 同构；同 (orderId, bizType) 恒同 URL——幂等重放口径） */
  payParamsFor(
    orderId: number,
    bizType: string,
  ): { readonly mock_pay_url: string; readonly order_id: number } {
    return {
      mock_pay_url:
        `mockpay://${this.channel}/pay?order_id=${orderId}` +
        `&mch=${encodeURIComponent(this.merchantId)}&biz=${encodeURIComponent(bizType)}`,
      order_id: orderId,
    };
  }

  /** 观测位（测试断言备用通道未沾流量等） */
  journalSize(): number {
    return this.journal.length;
  }

  /**
   * 差异场景构造位（mock 能力，对账用）：模拟通道侧账单多出一行（本地无记录 → CHANNEL_ONLY）。
   * 生产路径不经此方法（真实通道账单来自通道 T+1 文件，R-04）。
   */
  appendStatementLine(input: {
    readonly direction: StatementLine['direction'];
    readonly amount: Money;
    readonly channelTxnNo: string;
    readonly period?: string;
  }): void {
    this.journal.push({
      period: input.period ?? isoDate(this.clock()),
      channelTxnNo: input.channelTxnNo,
      direction: input.direction,
      amount: input.amount,
    });
  }

  /**
   * 差异场景构造位（mock 能力，对账用）：模拟通道账单金额与本方记录不一致（AMOUNT_MISMATCH）——
   * statement() 渲染时对该流水号替换金额，账单日志原值不动。
   */
  setStatementDiscrepancy(channelTxnNo: string, amount: Money): void {
    this.discrepancies.set(channelTxnNo, amount);
  }

  async preorder(req: ChannelPreorderRequest): Promise<ChannelResult> {
    this.assertChannelHealthy();
    const url =
      `mockpay://${this.channel}/pay?order_id=${req.orderId}` +
      `&mch=${encodeURIComponent(this.merchantId)}&biz=${encodeURIComponent(req.bizType)}`;
    // 预下单与冻结在 mock 合一（§4「通道预下单/冻结 → 返回支付参数」）：支付参数回传时资金已入
    // 冻结托管——PAY 为账单资金行；服务层仍可显式调 freeze/refreeze 原语（托管状态操作，不出账单行）
    const txn = this.record('PAY', req.amount);
    return {
      channelTxnNo: txn.channelTxnNo,
      payParams: { mock_pay_url: url, order_id: req.orderId },
    };
  }

  async freeze(_req: ChannelInstructionRequest): Promise<ChannelResult> {
    this.assertChannelHealthy();
    // 托管状态操作：无资金移动不出账单行（账单=资金行口径，R-04 对账只核资金行）
    return { channelTxnNo: this.nextTxnNo() };
  }

  async refreeze(_req: ChannelInstructionRequest): Promise<ChannelResult> {
    this.assertChannelHealthy();
    return { channelTxnNo: this.nextTxnNo() };
  }

  async unfreezeSplit(req: ChannelInstructionRequest): Promise<ChannelResult> {
    this.assertChannelHealthy();
    return { channelTxnNo: this.record('SPLIT', req.amount).channelTxnNo };
  }

  async refund(req: ChannelInstructionRequest): Promise<ChannelResult> {
    this.assertChannelHealthy();
    return { channelTxnNo: this.record('REFUND', req.amount).channelTxnNo };
  }

  async partialRefund(req: ChannelInstructionRequest): Promise<ChannelResult> {
    this.assertChannelHealthy();
    return { channelTxnNo: this.record('REFUND', req.amount).channelTxnNo };
  }

  async deduct(req: ChannelDeductRequest): Promise<ChannelResult> {
    if (this.fault?.kind === 'INSUFFICIENT') {
      // 业务应答：违约扣减余额不足（保证金专户补足由业务模块 F3/A3b 裁量，本层原样上抛）
      throw new ChannelFaultError('INSUFFICIENT', this.channel, 'INSUFFICIENT：扣减余额不足');
    }
    this.assertChannelHealthy();
    return { channelTxnNo: this.record('DEDUCT', req.amount).channelTxnNo };
  }

  async statement(period: string): Promise<StatementLine[]> {
    if (!PERIOD_RE.test(period)) {
      throw new AppError(ErrorCode.InvalidArgument, `对账期须为 YYYY-MM-DD：${period}`);
    }
    return this.journal
      .filter((j) => j.period === period)
      .map((j) => ({
        channelTxnNo: j.channelTxnNo,
        direction: j.direction,
        amount: this.discrepancies.get(j.channelTxnNo) ?? j.amount,
        status: 'SUCCESS' as const,
      }));
  }

  private assertChannelHealthy(): void {
    if (this.fault?.kind === 'CHANNEL_ERROR') {
      throw new ChannelFaultError(
        'CHANNEL_ERROR',
        this.channel,
        'CHANNEL_ERROR：模拟通道 5xx 故障',
      );
    }
  }

  /** 流水号分配（确定性递增；不出账单行的托管状态操作也用） */
  private nextTxnNo(): string {
    const prefix = this.channel === 'wechat_ecom' ? 'MOCK-WECHAT' : 'MOCK-ALIPAY';
    this.seq += 1;
    return `${prefix}-${String(this.seq).padStart(6, '0')}`;
  }

  private record(direction: StatementLine['direction'], amount: Money): { channelTxnNo: string } {
    const channelTxnNo = this.nextTxnNo();
    this.journal.push({ period: isoDate(this.clock()), channelTxnNo, direction, amount });
    return { channelTxnNo };
  }
}

// ---------------------------------------------------------------------------
// 切换路由（§8 单通道故障 5min 内切换）
// ---------------------------------------------------------------------------

export interface ChannelRouterOptions {
  /** [主, 备] 顺序即切换优先级 */
  readonly adapters: readonly [PaymentChannelAdapter, PaymentChannelAdapter];
  /** 降级窗口毫秒（§8 切换 SLA 5min 的窗口承载：窗口内流量恒走备用，窗口过后由流量探测恢复） */
  readonly switchWindowMs: number;
  /** 可注入时钟（测试确定性；生产=Date.now） */
  readonly now?: () => number;
}

export interface ChannelRouterOutcome<T> {
  readonly result: T;
  /** 实际承载本次指令的适配器（落单 channel 列的事实源） */
  readonly adapter: PaymentChannelAdapter;
  /** 本次调用是否恰好把某通道打入降级——true 时调用方须在同一事务出箱 ChannelDegraded */
  readonly degradedNow: boolean;
  /** 被打入降级的通道（degradedNow 的事件载荷口径——降级的是故障方，非接管方） */
  readonly degradedChannel: string | null;
}

export class ChannelRouter {
  private readonly primary: PaymentChannelAdapter;
  private readonly backup: PaymentChannelAdapter;
  private readonly switchWindowMs: number;
  private readonly now: () => number;
  /** channel → 降级截止时刻（进程内内存态；持久化为 M2 真通道批事项，本批报告注明） */
  private readonly degradedUntil = new Map<string, number>();

  constructor(opts: ChannelRouterOptions) {
    this.primary = opts.adapters[0];
    this.backup = opts.adapters[1];
    this.switchWindowMs = opts.switchWindowMs;
    this.now = opts.now ?? (() => Date.now());
  }

  /**
   * 按主→备执行指令：CHANNEL_ERROR 翻降级并落备用；INSUFFICIENT 业务应答原样上抛不切换；
   * 双通道均不可用 → AppError(E_CHANNEL_UNAVAILABLE, 503)。
   */
  async execute<S>(
    op: (adapter: PaymentChannelAdapter) => Promise<S>,
  ): Promise<ChannelRouterOutcome<S>> {
    let degradedNow = false;
    let degradedChannel: string | null = null;
    let lastFault: ChannelFaultError | null = null;

    for (const candidate of [this.primary, this.backup]) {
      if (this.isInDegradedWindow(candidate.channel)) continue;
      try {
        const result = await op(candidate);
        return { result, adapter: candidate, degradedNow, degradedChannel };
      } catch (e) {
        if (e instanceof ChannelFaultError && e.kind === 'INSUFFICIENT') throw e;
        if (!(e instanceof ChannelFaultError)) throw e;
        // 通道故障：翻降级（degradedNow 恰首次 flip 为 true）后试下一通道
        if (this.markDegraded(candidate.channel)) {
          degradedNow = true;
          degradedChannel = candidate.channel;
        }
        lastFault = e;
      }
    }
    throw new AppError(
      ErrorCode.ChannelUnavailable,
      `支付通道全部不可用：${lastFault ? String(lastFault.message) : '主备均在降级窗口'}`,
    );
  }

  /** 对账账单拉取：直连指定适配器（不经 failover——必须用指令实际发生通道的账单，R-04） */
  statementOf(channel: PaymentChannelName, period: string): Promise<StatementLine[]> {
    const adapter = channel === this.primary.channel ? this.primary : this.backup;
    if (adapter.channel !== channel) {
      throw new AppError(ErrorCode.NotFound, `未知支付通道：${channel}`);
    }
    return adapter.statement(period);
  }

  /** 确定性支付参数重放（幂等重放「原 pay_params」：按单上存续通道构造，无通道副作用） */
  payParamsFor(
    channel: PaymentChannelName,
    orderId: number,
    bizType: string,
  ): { readonly mock_pay_url: string; readonly order_id: number } {
    const adapter = channel === this.primary.channel ? this.primary : this.backup;
    if (adapter.channel !== channel) {
      throw new AppError(ErrorCode.NotFound, `未知支付通道：${channel}`);
    }
    return adapter.payParamsFor(orderId, bizType);
  }

  /** 观测位（测试/运维：通道当前是否处于降级窗口） */
  isDegraded(channel: PaymentChannelName): boolean {
    return this.isInDegradedWindow(channel);
  }

  private isInDegradedWindow(channel: string): boolean {
    const until = this.degradedUntil.get(channel);
    if (until === undefined) return false;
    if (this.now() >= until) {
      this.degradedUntil.delete(channel); // 窗口过后清除，允许流量探测恢复
      return false;
    }
    return true;
  }

  /** 翻降级：返回是否「新降级」（窗口外首次故障/探测复败）；窗口内重复故障不重复翻动 */
  private markDegraded(channel: string): boolean {
    if (this.isInDegradedWindow(channel)) return false;
    this.degradedUntil.set(channel, this.now() + this.switchWindowMs);
    return true;
  }
}

// ---------------------------------------------------------------------------
// 出站校验（沿 E1/W2 守卫形态；M2 真通道适配器的出站缝——环回/私网 host 拒绝）
// ---------------------------------------------------------------------------

const PRIVATE_V4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/;

function isLoopbackOrPrivateHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host === '0.0.0.0' || host === '::1' || host === '::') return true;
  // IPv6 环回/私网（fc00::/7 唯一本地、fe80::/10 链路本地、::ffff: 映射 v4）
  const v6mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(host);
  if (host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80')) return true;
  const v4 = PRIVATE_V4.exec(v6mapped ? v6mapped[1]! : host);
  if (!v4) return false;
  const [a, b] = [Number(v4[1]), Number(v4[2])];
  if (a === 127 || a === 10 || a === 0) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

/**
 * 出站目标校验：http(s) 目标 host 命中环回/私网 → AppError(E_CONFIG_INVALID)；
 * 非网络形态（mockpay:// 等自定义 scheme）放行。mock 适配器不发真网请求——本守卫是
 * M2 真通道接入的统一出站缝，形态由单测钉住。
 */
export function assertOutboundTarget(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new AppError(ErrorCode.ConfigInvalid, `出站目标非法 URL：${JSON.stringify(url)}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return;
  if (isLoopbackOrPrivateHost(parsed.hostname)) {
    throw new AppError(
      ErrorCode.ConfigInvalid,
      `出站目标拒绝环回/私网 host（架构硬约束）：${parsed.hostname}`,
    );
  }
}
