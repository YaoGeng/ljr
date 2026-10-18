/**
 * job 类型全集注册表（I2 §2 全集 + §4 对照表；「其余调度需求一律入全集」——I2 §2）。
 *
 * 全集口径（⚠计数差异说明，见任务报告）：I2 §2 标称「19 种」但逐项枚举为 20 个名字；
 * §4 job 全集对照表在其之上另有 FIRM_REVERIFY（生产方/执行器/回查锚点齐全）；控制者裁决 R2
 * 追加 RULE_EFFECTIVE（生产方/执行器=H7 规则中心，回查锚点=rule_definitions.publish_status）；
 * M1-W4 T1 追加 RISK_PATROL（H4 资损巡检周期 job，架构 §7.2 五类不变量，回查锚点=patrol_runs
 * 最近一轮状态；I2 文档 §4 表已补行）；M2-W1 T3 追加 COLD_ARCHIVE（D5 消息冷存日扫——
 * 附录 A.2 裁定唯一目录增量：producer/executor=D5，recheckAnchor=messages 冷存水位；
 * I2 文档 §4 表行回写=T6 收尾，不在该任务内）。本注册表取并集 = 24 种——全集是「程序化
 * 一致性检查的准入门」，多收无害、漏收断路。
 *
 * 排除声明（I2 §2）：RESTRICTION_EXPIRE 不建 job——G1 限制令采用惰性失效（查询时比对 until，G1 §3）。
 *
 * ROOM_OPEN highPriority=true：独立高优先级扫描通道，周期 ≤5s（§4/§8）；其余走常规通道 10-15s。
 */
export const SCHEDULE_JOB_TYPES = [
  'REMIND_24H',
  'REMIND_1H',
  'REMIND_10MIN',
  'REMIND_1MIN',
  'ENROLL_DEADLINE',
  'ROOM_OPEN',
  'GRACE_END',
  'ABSENT_15M',
  'NO_SHOW_CLOSE',
  'C2B_CONFIRM_TIMEOUT',
  'RESCHEDULE_CONFIRM_TIMEOUT',
  'OOO_ACCEPT_TIMEOUT',
  'OOO_SETTLE_DEFAULT',
  'DIFF_PAY_TIMEOUT',
  'COMPENSATION_DISPATCH',
  'SETTLE_HOLD_RELEASE',
  'SLOT_REAPER',
  'SLOT_TTL',
  'POINTS_EXPIRE',
  'RETENTION_PURGE',
  'FIRM_REVERIFY',
  'RULE_EFFECTIVE',
  'RISK_PATROL',
  'COLD_ARCHIVE',
] as const;

export type ScheduleJobType = (typeof SCHEDULE_JOB_TYPES)[number];

export interface ScheduleJobDef {
  readonly jobType: ScheduleJobType;
  /** 生产方（§4 对照表；写 job 的业务模块） */
  readonly producer: string;
  /** 执行器（§4 对照表；真实执行器由该模块任务注册，I2 只做机制） */
  readonly executor: string;
  /** 回查锚点（§4 对照表；R-02 幂等回查比对的目标状态） */
  readonly recheckAnchor: string;
  /** 高优先级通道（仅 ROOM_OPEN，≤5s 独立扫描） */
  readonly highPriority?: boolean;
}

export const SCHEDULE_JOB_CATALOG: Readonly<Record<ScheduleJobType, ScheduleJobDef>> = {
  REMIND_24H: {
    jobType: 'REMIND_24H',
    producer: 'C3（成团）/C1（创建）',
    executor: 'D2（提醒）',
    recheckAnchor: '场次状态是否仍有效',
  },
  REMIND_1H: {
    jobType: 'REMIND_1H',
    producer: 'C3（成团）/C1（创建）',
    executor: 'D2（提醒）',
    recheckAnchor: '场次状态是否仍有效',
  },
  REMIND_10MIN: {
    jobType: 'REMIND_10MIN',
    producer: 'C3（成团）/C1（创建）',
    executor: 'D2（提醒）',
    recheckAnchor: '场次状态是否仍有效',
  },
  REMIND_1MIN: {
    jobType: 'REMIND_1MIN',
    producer: 'C3（成团）/C1（创建）',
    executor: 'D2（提醒）',
    recheckAnchor: '场次状态是否仍有效',
  },
  ENROLL_DEADLINE: {
    jobType: 'ENROLL_DEADLINE',
    producer: 'C1（创建时按 deadline）',
    executor: 'C1（流标判定）',
    recheckAnchor: '场次状态是否仍有效',
  },
  ROOM_OPEN: {
    jobType: 'ROOM_OPEN',
    producer: 'C1（创建预写，M1-W3 T4）/D1（M2 执行）', // 同 REMIND 先例：C1 创建时同事务预写 job，开房执行器随 D1（M2）装配
    executor: 'D1（开房）',
    recheckAnchor: 'room 状态与开房结果',
    highPriority: true, // 准点保障：独立通道 ≤5s + 延迟 >30s 电话告警（R-03）
  },
  GRACE_END: {
    jobType: 'GRACE_END',
    producer: 'D1',
    executor: 'D3（宽限结束判定）',
    recheckAnchor: 'room 状态与开房结果',
  },
  ABSENT_15M: {
    jobType: 'ABSENT_15M',
    producer: 'D1',
    executor: 'D3（缺席判定）',
    recheckAnchor: 'room 状态与开房结果',
  },
  NO_SHOW_CLOSE: {
    jobType: 'NO_SHOW_CLOSE',
    producer: 'D1',
    executor: 'D3（无人到场关闭）',
    recheckAnchor: 'room 状态与开房结果',
  },
  C2B_CONFIRM_TIMEOUT: {
    jobType: 'C2B_CONFIRM_TIMEOUT',
    producer: 'C2（REACHED）',
    executor: 'C4（超时自动拒绝+信用事件）',
    recheckAnchor: 'group_buy 状态',
  },
  RESCHEDULE_CONFIRM_TIMEOUT: {
    jobType: 'RESCHEDULE_CONFIRM_TIMEOUT',
    producer: 'C5（申请）',
    executor: 'C5',
    recheckAnchor: 'reschedule_requests 状态',
  },
  OOO_ACCEPT_TIMEOUT: {
    jobType: 'OOO_ACCEPT_TIMEOUT',
    producer: 'D6',
    executor: 'D6',
    recheckAnchor: 'one_on_one_orders 状态',
  },
  OOO_SETTLE_DEFAULT: {
    jobType: 'OOO_SETTLE_DEFAULT',
    producer: 'D6',
    executor: 'D6',
    recheckAnchor: 'one_on_one_orders 状态',
  },
  DIFF_PAY_TIMEOUT: {
    jobType: 'DIFF_PAY_TIMEOUT',
    producer: 'D6',
    executor: 'D6',
    recheckAnchor: 'one_on_one_orders 状态',
  },
  COMPENSATION_DISPATCH: {
    jobType: 'COMPENSATION_DISPATCH',
    producer: 'C6（改价生效时投递）',
    executor: 'F4（补偿 24h 发放）',
    recheckAnchor: 'pricing_histories 补偿发放状态',
  },
  SETTLE_HOLD_RELEASE: {
    jobType: 'SETTLE_HOLD_RELEASE',
    producer: 'F3（进 HOLD）',
    executor: 'F3（24h 到期→READY）',
    recheckAnchor: 'settlements.hold 状态与工单',
  },
  SLOT_REAPER: {
    jobType: 'SLOT_REAPER',
    producer: 'B2',
    executor: 'B2（周期 job：执行 DONE 后同表自投下一周期）',
    recheckAnchor: 'slot_locks 与实体终态',
  },
  SLOT_TTL: {
    jobType: 'SLOT_TTL',
    producer: 'B2',
    executor: 'B2（到期处置）',
    recheckAnchor: 'slot_locks 与实体终态',
  },
  POINTS_EXPIRE: {
    jobType: 'POINTS_EXPIRE',
    producer: 'F4',
    executor: 'F4（周期 job）',
    recheckAnchor: 'points_txns.expires_at',
  },
  RETENTION_PURGE: {
    jobType: 'RETENTION_PURGE',
    producer: 'I3',
    executor: 'I3（周期 job）',
    recheckAnchor: 'artifacts.retention_until',
  },
  FIRM_REVERIFY: {
    jobType: 'FIRM_REVERIFY',
    producer: 'A3b（进件生效时）',
    executor: 'A3b（年度复验）',
    recheckAnchor: 'firm_merchants.reverify_due',
  },
  RULE_EFFECTIVE: {
    jobType: 'RULE_EFFECTIVE',
    producer: 'H7 规则中心',
    executor: 'H7 规则中心',
    recheckAnchor: 'rule_definitions.publish_status', // 控制者裁决 R2（M1-W1 Task 4 消费）
  },
  RISK_PATROL: {
    jobType: 'RISK_PATROL',
    producer: 'H4 资损巡检（main.ts 引导首个 + 执行器自投下一周期，分钟级）',
    executor: 'H4 资损巡检（PatrolService.runOnce：五类不变量检测→违例台账+告警）',
    recheckAnchor: 'patrol_runs 最近一轮状态', // 架构 §7.2 五类（M1-W4 T1；I2 文档 §4 表已补行）
  },
  COLD_ARCHIVE: {
    jobType: 'COLD_ARCHIVE',
    producer: 'D5 会话与消息（main.ts 引导首个 + 执行器自投下一周期，24h 日扫）',
    executor:
      'D5 会话与消息（>90d 消息按会话转 I3 cold_message + 同事务热删；写 artifacts 经 I3 PUT_ARTIFACT 统一入口）',
    recheckAnchor:
      'messages 冷存水位（last_archived_created_at——扫描时刻，进程内+job detail 承载）', // 附录 A.2 唯一目录增量（M2-W1 T3）
  },
};

/** 类型收窄守卫（运维视图/REGISTER 入参校验用） */
export function isScheduleJobType(value: string): value is ScheduleJobType {
  return (SCHEDULE_JOB_TYPES as readonly string[]).includes(value);
}
