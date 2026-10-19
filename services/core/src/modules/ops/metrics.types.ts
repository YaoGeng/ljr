/**
 * H4 数据看板·指标管道类型与目录（M2-W2 T8）。
 *
 * 口径唯一事实源=docs/02-架构设计.md §7.2 指标-事件源映射表（H4 §7 R-01：禁自行解释，
 * 疑问入待澄清）。02 §7.2 表头口径：「业务指标经事件流实时聚合」——本管道把映射表的
 * 「来源」列（各域表）落到**该表状态迁移的出箱事件**上消费计数，metrics_daily（ops 域）
 * 是唯一物化层；查询面不跨 schema 读源表（patrol 先例：跨域面=各域导出服务/事件）。
 *
 * 分层：
 *   - 计数器（metrics_daily.metric_key 词汇表，MC_* 常量）：事件消费的原始累加值；
 *   - 指标（METRIC_CATALOG 目录）：查询面出参键，比率在查询时由计数器对（分子/分母）
 *     应用层计算——比率不入表（口径漂移只修一处）。
 */

/** 指标分组（H4 §5：?group=core|health） */
export type MetricGroup = 'core' | 'health';

/** 计数器增量（消费事务内逐条累加进 metrics_daily） */
export interface MetricIncrement {
  readonly key: string;
  /** 维度切片（''=全域；mode:B2C / user:{id} / lawyer:{id} / category:{x} / role:user） */
  readonly dim: string;
  readonly inc: number;
}

/** 查询面单指标出参（H4 §5「指标集」；value=null+stub=桩位显式——PRD 未定义不发明） */
export interface MetricView {
  readonly key: string;
  readonly value: number | null;
  /** 桩位/近似口径注记（null=正常出数；非 null=value 为 null 或口径受限说明） */
  readonly stub: string | null;
}

/** GET /admin/dashboard/metrics 出参 */
export interface MetricsResponse {
  readonly group: MetricGroup;
  /** 窗口回显（null=缺省全量） */
  readonly from: string | null;
  readonly to: string | null;
  readonly metrics: readonly MetricView[];
}

// ---------------------------------------------------------------------------
// 计数器词汇表（metrics_daily.metric_key；列宽 varchar(48)，比率键不入表）
// ---------------------------------------------------------------------------

export const MC = {
  /** 场次创建总数（dim=''；← SessionCreated。载荷无 mode——B2C 分列经查询层算术推导：
   *  b2cCreated=Σ本键−c2b_session_created−converted_session_created，修复环 C-1） */
  SESSION_CREATED: 'session_created',
  /** 满员成团总数（dim=''；← SessionFull。B2C 分子=Σ本键−c2b_session_created——
   *  每次 C4 confirm 恰一次 SessionFull（满员即成团）；convert 无 markFull） */
  SESSION_FULL: 'session_full',
  /** C2B 拼团发布（← GroupBuyPublished） */
  GROUP_BUY_PUBLISHED: 'group_buy_published',
  /** C2B 达 sub_min 锁人（← GroupBuyReached） */
  GROUP_BUY_REACHED: 'group_buy_reached',
  /** 用户到场判定总数（dim=role:user；AttendanceAdjudicated owner_type=user） */
  ATTENDANCE_JUDGED: 'attendance_judged',
  ATTENDANCE_NORMAL: 'attendance_normal',
  ATTENDANCE_LATE: 'attendance_late',
  ATTENDANCE_ABSENT: 'attendance_absent',
  /** 1对1 预付订单（← OneOnOnePaid；D6=W3 生产方未落=恒 0，指标桩位注记） */
  ONE_ON_ONE_PAID: 'one_on_one_paid',
  /** 房间关闭数（dim=lawyer:{id}；← RoomClosed） */
  ROOM_CLOSED: 'room_closed',
  /** 评价提交数（dim=direction:{user_to_lawyer|lawyer_to_user}；← ReviewSubmitted。
   *  修复环 I-1：satisfaction_avg 只读 user_to_lawyer 半边；lawyer_to_user 留 dim 供后续口径） */
  REVIEW_SUBMITTED: 'review_submitted',
  /** 评价维度分和（前缀+维度名，dim 同 direction 切分；G2 四维：overall/professional/response/attitude） */
  REVIEW_DIM_SUM: 'review_dim_sum:',
  /** 支付完成报名数（全域 dim=''；复购去重 dim=user:{id}；← EnrollmentPaid） */
  ENROLLMENT_PAID: 'enrollment_paid',
  /** 退款完成数（← RefundCompleted） */
  REFUND_COMPLETED: 'refund_completed',
  /** 工单创建数（dim=category:{x}；← TicketCreated） */
  TICKET_CREATED: 'ticket_created',
  /** 场次取消数（← SessionCancelled） */
  SESSION_CANCELLED: 'session_cancelled',
  /** C2B 律师确认生成的场次数（← GroupBuyLawyerConfirmed） */
  C2B_SESSION_CREATED: 'c2b_session_created',
  /** 拼团转化生成的场次数（← GroupBuyConverted） */
  CONVERTED_SESSION_CREATED: 'converted_session_created',
  /** 改价审批通过数（← PriceChangeApproved） */
  PRICE_CHANGE_APPROVED: 'price_change_approved',
  /** 补偿积分授予数（← PointsGranted kind=COMPENSATION；其余 kind 记账不计数） */
  COMP_POINTS_GRANTED: 'comp_points_granted',
} as const;

/** 评价四维（G2 §3；顺序=展示序） */
export const REVIEW_DIMS = ['overall', 'professional', 'response', 'attitude'] as const;
export type ReviewDim = (typeof REVIEW_DIMS)[number];

/** 工单类目 dim 前缀 */
export const TICKET_CATEGORY_DIM = (category: string): string => `category:${category}`;

// ---------------------------------------------------------------------------
// 指标目录（查询面注册表；hidden=注册但不展示——价格稳定性指数 04 §8 #8）
// ---------------------------------------------------------------------------

/** 价格稳定性指数键（PRD 未定义口径——注册占位、查询面显式排除，04 §8 #8 / H4 §11） */
export const PRICE_STABILITY_INDEX_KEY = 'price_stability_index';

export interface MetricCatalogEntry {
  readonly key: string;
  readonly group: MetricGroup;
  readonly title: string;
  /** true=注册在册但查询面不展示（占位显式） */
  readonly hidden?: boolean;
}

/**
 * 核心 7 + 健康 11 全量目录（H4 §2）。拆分注记：
 *   - 「到场率/缺席率」一行拆 attendance_rate/punctual_attendance_rate/absence_rate
 *     （三态两读法都出——避免自行解释「LATE 归到场还是缺席」；D3/H1「准时到场率」=NORMAL 口径）；
 *   - 「满意度/复购率」一行拆 satisfaction_avg_{dim}×4 + repurchase_rate；
 *   - 「取消/缺席率」一行拆 cancel_rate + absence_rate（缺席半边与核心同源计数，双列注记）；
 *   - 「1对1 满意度/纠纷率」一行拆两键（双双桩位，D6=W3）。
 */
export const METRIC_CATALOG: readonly MetricCatalogEntry[] = [
  // —— 核心 7 ——
  { key: 'group_buy_rate_b2c', group: 'core', title: '拼单成团率（B2C）' },
  { key: 'group_buy_rate_c2b', group: 'core', title: '拼单成团率（C2B）' },
  { key: 'user_group_buy_rate', group: 'core', title: '用户发起拼团成团率' },
  { key: 'attendance_rate', group: 'core', title: '到场率（normal+late÷判定数）' },
  { key: 'punctual_attendance_rate', group: 'core', title: '准时到场率（normal÷判定数）' },
  // M-4：absence_rate 在 core/health 双目录条目（到场率/缺席率 与 取消/缺席率 两行各占半边）
  // ——双列必须同值：同一计数器对（absent÷judged），禁单侧改口径；spec 分组用例断言相等
  { key: 'absence_rate', group: 'core', title: '缺席率（absent÷判定数）' },
  { key: 'one_on_one_conversion_rate', group: 'core', title: '1对1转化率' },
  { key: 'lawyer_room_count', group: 'core', title: '律师人效·房间数' },
  { key: 'lawyer_room_avg_duration_min', group: 'core', title: '律师人效·房间平均时长（分钟）' },
  { key: 'draft_adoption_rate', group: 'core', title: 'Agent草稿采用率' },
  { key: 'satisfaction_avg_overall', group: 'core', title: '满意度·总体均值' },
  { key: 'satisfaction_avg_professional', group: 'core', title: '满意度·专业均值' },
  { key: 'satisfaction_avg_response', group: 'core', title: '满意度·响应均值' },
  { key: 'satisfaction_avg_attitude', group: 'core', title: '满意度·态度均值' },
  { key: 'repurchase_rate', group: 'core', title: '复购率' },
  // —— 健康 11 ——
  { key: 'dispute_rate', group: 'health', title: '纠纷率' },
  { key: 'refund_rate', group: 'health', title: '退款率' },
  { key: 'lawyer_retention_rate', group: 'health', title: '律师留存率' },
  { key: 'room_avg_duration_min', group: 'health', title: '房间平均时长（分钟）' },
  { key: 'cancel_rate', group: 'health', title: '取消率' },
  {
    key: 'absence_rate',
    group: 'health',
    title: '缺席率（取消/缺席率的缺席半边；与 core 条目同值）',
  },
  { key: 'one_on_one_satisfaction_rate', group: 'health', title: '1对1满意度' },
  { key: 'one_on_one_dispute_rate', group: 'health', title: '1对1纠纷率' },
  { key: 'price_change_frequency', group: 'health', title: '律师改价频率（窗口计数）' },
  { key: 'compensation_grant_rate', group: 'health', title: '降价补偿发放率' },
  { key: 'post_price_change_complaint_rate', group: 'health', title: '改价后用户投诉率' },
  { key: PRICE_STABILITY_INDEX_KEY, group: 'health', title: '价格稳定性指数', hidden: true },
];

/** 桩位/近似口径注记词汇（查询面出参 stub；集中定义避免散写漂移） */
export const METRIC_STUBS = {
  oneOnOneConversion:
    'D6=W3：分子 one_on_one_orders 事件源（OneOnOnePaid）未全量=恒 0；分母参与房间用户数可算——按映射表实现可算面',
  draftAdoption: 'E1=W3：agent_review_logs 无事件源（草稿审查事件未流），不可算',
  lawyerRoomDuration:
    'ROOM_CLOSED 载荷无 opened_at/closed_at（W1 契约形状）——rooms.closed_at-opened_at 口径待事件增补，占位',
  lawyerRetention:
    '§7.2 口径=credit_events+lawyer_profiles 队列（跨域表面，无事件源），占位待口径拍板',
  oneOnOneSatisfaction: 'D6=W3：one_on_one 订单面事件未流，不可算',
  oneOnOneDispute: 'D6=W3：one_on_one 订单面事件未流，不可算',
  postPriceChangeComplaint:
    '近似口径：price_change 类工单与改价 8 自然日窗（工单日 D 与前 7 个自然日）关联（映射表「改价时间窗」未定窗长，待澄清）；分母=窗口内改价审批数',
} as const;
