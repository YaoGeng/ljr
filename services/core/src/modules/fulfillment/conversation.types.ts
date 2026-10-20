/**
 * D5 会话与消息类型契约（M2-W1 T3；施工规格 docs/modules/D-履约/D5-会话与消息.md §2/§3/§5/§6）。
 * 类型即契约——先于实现落位（契约类型先行纪律）。词汇与 V37 CHECK 值域逐字对齐
 * （附录 A.3 DDL 蓝图）：type 三值 / sender_role 四值 / mention 二值 / risk_flag 三值。
 */

/** 会话形态（D5 §2/§3：room 房间 / private 私聊 / one_on_one 1对1） */
export const CONVERSATION_TYPES = ['room', 'private', 'one_on_one'] as const;
export type ConversationType = (typeof CONVERSATION_TYPES)[number];

export function isConversationType(value: string): value is ConversationType {
  return (CONVERSATION_TYPES as readonly string[]).includes(value);
}

/** WSS 可用发送角色（隔离铁律子集）：agent/system 仅内部系统 API 可写，WSS 禁伪造（D5 §9） */
export const WSS_SENDER_ROLES = ['user', 'lawyer'] as const;
export type WssSenderRole = (typeof WSS_SENDER_ROLES)[number];

/** 消息 sender_role 全集（V37 ck 四值；agent=律师审查后 E1 W3 接线位，system=须知/提醒） */
export type SenderRole = WssSenderRole | 'agent' | 'system';

/** 消息类型（V37 ck 二值：text 用户文本 / system 须知·提醒·存证告知） */
export const MESSAGE_TYPES = ['text', 'system'] as const;
export type MessageType = (typeof MESSAGE_TYPES)[number];

/** @ 提及（V37 ck 二值：agent=E1 管线路由桩（W3）、lawyer=律师端待办高亮；D5 §2） */
export const MENTION_TARGETS = ['agent', 'lawyer'] as const;
export type MentionTarget = (typeof MENTION_TARGETS)[number];

export function isMentionTarget(value: string): value is MentionTarget {
  return (MENTION_TARGETS as readonly string[]).includes(value);
}

/** 落库风控标记（V37 ck 三值；BLOCKED 值在册不可达——拦截即拒无行，词汇完整性锚） */
export type MessageRiskFlag = 'PASS' | 'BLOCKED' | 'REVIEW';

/** consent_records ref_type（V37 ck 二值；W1 落 recording，training_room=A2 消费位） */
export const CONSENT_REF_TYPES = ['recording', 'training_room'] as const;
export type ConsentRefType = (typeof CONSENT_REF_TYPES)[number];

// ---------- 读路径限额（D5 §2/§5：断线补拉 + 迟到回填 N=200） ----------

/** 增量拉取缺省条数（§5 GET /conversations/{id}/messages?limit= 缺省 50） */
export const DEFAULT_PULL_LIMIT = 50;
/** 增量拉取上限（§5 上限 200；超出静默收窄不报错——W1 口径） */
export const MAX_PULL_LIMIT = 200;
/** 迟到回填条数（§2 断线重连 N=200：join 时自动推最近 200 条） */
export const BACKFILL_LIMIT = 200;

/**
 * 消息 content 长度上限（字符，T3 评审 I-1 的 W1 裁量）：PRD/模块文档未定义消息长度——本值
 * 非产品契约，仅为防滥用护栏（超大载荷占发号行锁/广播缓冲）；配置化预留=集中常量单点改
 * （H7 规则化收口时迁移）。内部系统消息（postInternalMessage）同护栏（平台内容亦不豁免）。
 */
export const MESSAGE_MAX_LEN = 8_000;

/** 会话行视图（存在性/形态/ref_id 锚——presence 载荷 ref_id 同源） */
export interface ConversationView {
  readonly conversation_id: number;
  readonly type: ConversationType;
  readonly ref_id: number;
  readonly created_at: Date;
}

/** 消息行视图（§5 GET /conversations/{id}/messages 出参形态；created_at ISO 化由服务面出参承载） */
export interface MessageView {
  readonly message_id: number;
  readonly conversation_id: number;
  readonly seq: number;
  readonly sender_id: number;
  readonly sender_role: SenderRole;
  readonly type: MessageType;
  readonly content: string;
  readonly mention: MentionTarget | null;
  readonly risk_flag: MessageRiskFlag;
  readonly source_msg_id: string | null;
  readonly created_at: string;
}

/** 客户端发送入参（WSS send 帧 data 面；sender 身份取 JWT claims 不入参——防伪造） */
export interface SendMessageInput {
  readonly conversationId: number;
  readonly senderId: number;
  /** WSS 白名单角色（claims.role 派生；agent/system 禁经 WSS——隔离铁律） */
  readonly senderRole: WssSenderRole;
  readonly content: string;
  readonly mention?: MentionTarget;
  /**
   * 客户端幂等键（M2-W3 T5 可选）：WSS send 的 msg_client_id——携带时消息落库事务内同写
   * fulfillment.message_receipts（命中=重复 → 整事务回滚零新行）。网关判重入口=
   * sendMessageDedup；直调 sendMessage（E1 草稿动作链）缺省无判重。
   */
  readonly dedupKey?: string;
}

/** sendMessageDedup 入参（M2-W3 T5：dedupKey 必携——持久回执面判重入口） */
export interface SendMessageDedupInput extends SendMessageInput {
  readonly dedupKey: string;
}

/** sendMessageDedup 出参：新消息 | 重复命中（回放首访 seq——ack 面零新消息零新广播） */
export type SendMessageDedupResult =
  | { readonly message: MessageView; readonly deduplicated: false }
  | { readonly deduplicated: true; readonly messageSeq: number };

/** 发送结果（WSS ack 面：{type:'sent', seq}） */
export interface SendMessageResult {
  readonly message: MessageView;
  /** true=同 msg_client_id 重放（持久回执面命中，M2-W3 T5），未产生新消息行 */
  readonly deduplicated: boolean;
}

/** 断线增量拉取入参（§5 GET /conversations/{id}/messages?after_seq=&limit=；WSS pull 帧同参） */
export interface ListMessagesInput {
  readonly conversationId: number;
  /** 读取者身份（T3 评审 C-1 四口成员门：room 型会话校验成员资格——PAID 报名/场次律师） */
  readonly asUserId: number;
  /** 独占下界（返回 seq > after_seq；缺省 0=从头） */
  readonly afterSeq?: number;
  /** 缺省 50、上限 200（超出静默收窄） */
  readonly limit?: number;
}

/** 录制同意信令入参（§5 WSS recording-consent {conversation_id, accept}） */
export interface RecordingConsentInput {
  readonly conversationId: number;
  readonly partyId: number;
  /** 同意版本锚（W1 缺省 'v1'；A2 policy_version 联动=W2+） */
  readonly version?: string;
  readonly accept: boolean;
}

export interface RecordingConsentResult {
  readonly conversation_id: number;
  readonly party_id: number;
  /** true=新落授权行；false=UNIQUE 幂等命中（重复信令零新行零重复事件） */
  readonly recorded: boolean;
  /** 双门判定：双方 distinct party 齐 → true（调用方据此触达 RTC startRecording） */
  readonly bothPartiesConsented: boolean;
}

/** ensureConversation 出参（幂等键=type+ref_id，ux DB 兜底） */
export interface EnsureConversationResult {
  readonly conversation_id: number;
  readonly type: ConversationType;
  readonly ref_id: number;
  /** true=本次新建；false=在册回读（重放幂等） */
  readonly created: boolean;
}

/**
 * 消息回查视图（agent-assist 专用内部读导出面 readMessageForAgent 的出参，M2-W3 T4：
 * A.4「fulfillment→agent-assist 消息内容读」行）。content=原文（含 PII）——只在进程内传递，
 * 禁入事件载荷与日志（E1 载荷 PII 铁律）；消费方（E1）先过 SanitizeService 再进 RAG/LLM。
 */
export interface AgentMessageRead {
  /** 会话形态（E1 消费过滤锚：仅 room 型用户消息跑草稿管线） */
  readonly type: ConversationType;
  /** 会话 ref_id（room 型=房间 id——E1 草稿行的 room_id 锚） */
  readonly ref_id: number;
  /** 发送者 id（E1 target_user_id 锚） */
  readonly sender_id: number;
  readonly sender_role: SenderRole;
  readonly content: string;
  readonly mention: MentionTarget | null;
}

/** 冷存一轮结果（COLD_ARCHIVE 执行器 detail 承载） */
export interface ColdArchiveResult {
  /** 冷存归档的会话数 */
  readonly conversations: number;
  /** 热删消息行数 */
  readonly messages: number;
  /** 单会话失败数（逐会话隔离不连坐，失败者下轮重扫） */
  readonly failed: number;
  /** 本轮扫描时刻 ISO（水位=进程内+job detail 承载，表列不加） */
  readonly scanned_at: string;
  /** 冷存边界（scanned_at - 90d，ISO） */
  readonly cutoff: string;
}
