/**
 * B2 时间段占用锁类型契约（施工规格 docs/modules/B-律师配置/B2-时间段占用锁.md §3/§4/§5/§6）。
 *
 * 机制定位（§1）：具体场次时刻占用锁的唯一事实源；同事务加锁/释放——调用方（C1/C2/C5）在自己的
 * 业务事务内以 uow 调机制方法，同 commit/rollback（R-02，与 I2 registerJob(uow,…) 同形态）。
 * B2 不做场次业务状态（trade 域）、不解释锁的业务含义（§1 边界）。
 */

/** 锁状态（§3/§4：PENDING_PAYMENT|LOCKED|OCCUPIED|RELEASED；迁移经 slot-lock.machine 守卫） */
export type SlotLockStatus = 'PENDING_PAYMENT' | 'LOCKED' | 'OCCUPIED' | 'RELEASED';

/** 关联业务实体类型（§3 ref_type 注释枚举；终态判定经 TerminalStateProvider 注册表，禁跨域 join） */
export const SLOT_LOCK_REF_TYPES = ['session', 'groupbuy', 'reschedule'] as const;
export type SlotLockRefType = (typeof SLOT_LOCK_REF_TYPES)[number];

/** §5 LOCK_SLOT 拒绝码：SLOT_TAKEN=段已被进行中锁占用；SLOT_ABUSE_LIMIT=R-03 滥用超限 */
export type LockSlotRejectReason = 'SLOT_TAKEN' | 'SLOT_ABUSE_LIMIT';

export interface LockSlotInput {
  readonly lawyerId: number;
  readonly slotStart: Date;
  /** 发起人（R-03 滥用计数锚点：每用户对同律师进行中锁 ≤1、全局 ≤3） */
  readonly initiatorUserId: number;
  readonly refType: SlotLockRefType;
  readonly refId: number;
  /**
   * 支付单绑定（C2B 发布锁绑定支付单，§2）：传入 ⇒ 创建为 PENDING_PAYMENT（10min TTL ⚠，同事务注册
   * SLOT_TTL job）；缺省 ⇒ 创建为 LOCKED（C1「创建即锁」/C5 改期新段，无支付等待）。
   */
  readonly paymentOrderId?: number;
}

/**
 * §5 LOCK_SLOT 出参：lock_id 或 SLOT_TAKEN / SLOT_ABUSE_LIMIT。
 * 调用方契约：收到 ok=false 必须中止（回滚）其业务事务——SLOT_TAKEN 时事务已被唯一索引冲突污染
 * （PG 语义上只能 ROLLBACK）；SLOT_ABUSE_LIMIT 时调用方应回滚发布/开团写入（滥用计数在 B2 侧
 * 已按同事务口径校验，锁行未写入）。
 */
export type LockSlotResult =
  | { readonly ok: true; readonly lockId: number; readonly status: SlotLockStatus }
  | { readonly ok: false; readonly reason: LockSlotRejectReason };

export interface ReleaseSlotInput {
  readonly refType: SlotLockRefType;
  readonly refId: number;
  /** 释放原因（流标/拒绝/取消/超时等调用方语义），落 SlotReleased 载荷与守卫留痕 reason */
  readonly reason: string;
}

/** §5 RELEASE_SLOT 出参：ok / ALREADY_RELEASED（幂等）；NOT_FOUND=该 ref 从无锁行（异常，显性化） */
export type ReleaseSlotResult =
  | { readonly ok: true; readonly lockId: number }
  | { readonly ok: false; readonly reason: 'ALREADY_RELEASED' | 'NOT_FOUND' };

/**
 * §5 CONFIRM_PAYMENT 出参：ok / NOT_FOUND。transitioned=false = 支付回调重放幂等短路
 * （锁已是 LOCKED/OCCUPIED，支付早已体现）；锁已 RELEASED（退款/取消后迟到的回调）无可确认对象
 * ⇒ NOT_FOUND。
 */
export type ConfirmPaymentResult =
  | { readonly ok: true; readonly lockId: number; readonly transitioned: boolean }
  | { readonly ok: false; readonly reason: 'NOT_FOUND' };

/** START_OCCUPY（§2/§4）出参；非 LOCKED 状态迁移经守卫拒绝（AppError StateIllegalTransition） */
export type StartOccupyResult =
  | { readonly ok: true; readonly lockId: number }
  | { readonly ok: false; readonly reason: 'NOT_FOUND' };

// ---------- reaper 的关联实体终态判定抽象（R-04；禁跨域 join trade.* 表——边界纪律） ----------

/** 终态判定信息：since=进入终态时刻（超阈判定锚点；terminal=false 时为 null） */
export interface EntityTerminalInfo {
  readonly terminal: boolean;
  readonly since: Date | null;
}

/**
 * ref_type → 终态判定器：reaper 判定「关联实体已终态」的唯一通道。真实 provider 随 C1（session）、
 * C2（groupbuy）、C5（reschedule）落位注册（各自经接口/事件取业务态，B2 不直连他域表）；
 * W1 以测试 stub 验证机制。
 */
export interface TerminalStateProvider {
  /** 实体不存在/无法判定返回 null（reaper 跳过该锁，宁漏不误杀） */
  isTerminal(refId: number): Promise<EntityTerminalInfo | null>;
}
