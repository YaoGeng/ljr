/**
 * D5 WSS 网关（M2-W1 T3；docs/modules/D-履约/D5-会话与消息.md §2/§4/§5——join/leave/send/pull/
 * recording-consent 五信令 + 断线补拉 + 迟到回填）。⚠W1-2：WSS 进 core 单进程（@nestjs/
 * platform-ws + main.ts WsAdapter，路径 /ws）；独立 rtc-im 服务剥离=V2 演进（可剥离纪律：
 * 他域经导出接口/事件消费，本件为模块内部件）。
 *
 * 帧协议（自管 message 监听——适配器默认 {event,data} 解析不承载本协议形状；WsAdapter 仅
 * 负责 upgrade 路由与连接生命周期钩子）：
 *   C→S {type:'auth', token}                      首帧鉴权（⚠W1-6：禁 query 串携带 token——
 *                                                日志泄漏面；10s 无 auth → close 4401）
 *   C→S {type:'join'|'leave', conversation_id}    在场进出（room 型门=房间 OPEN）
 *   C→S {type:'send', conversation_id, msg_client_id?, message:{type?, content, mention?,
 *                                                sender_role?}}  sender_role 若携带必须=JWT
 *                                                claims.role（伪造 agent/system/越权 → 403
 *                                                E_ROLE_FORBIDDEN——隔离铁律）
 *   C→S {type:'pull', conversation_id, after_seq?, limit?}   断线增量（HTTP 读路径同源）
 *   C→S {type:'recording-consent', conversation_id, accept}  录制前置信令（R-03 双门）
 *   S→C auth_ok/auth_failed/joined（含回填 backfill ≤200）/left/message（广播）/sent（ack，
 *                                                deduplicated 标记=持久回执面命中，T5）/messages（pull）/
 *                                                recording_consent/recording_started/error
 *                                                （{code, message, reply_to}，reply_to=客户端帧 type）
 *
 * 客户端幂等（§5 msg_client_id）：持久回执面（M2-W3 T5，V50 fulfillment.message_receipts——
 * W2 复审 §3-④收口）：send 路径判重走 ConversationService.sendMessageDedup——在册回执回放
 * 首访 ack（deduplicated:true，seq=回执行的 message_seq）零新消息零新广播；判重与消息落库
 * 同一事务（命中=重复 → 整事务回滚）；键域=(conversation_id, msg_client_id)——换连接/进程
 * 重启均生效（M2-W1 的 per-connection LRU 形态已删，全周期判重取代崩溃窗判重）。
 *
 * presence：join/leave/断连（隐式离场）→ PresenceJoined/Left 出箱（at-least-once；D3=W2 消费；
 * at=服务器接收时刻）。join 门（顺序=I-3）：会话存在（404）→ room 型经 fulfillment 自有
 * rooms 状态须 OPEN（CLOSED/CANCELLED → 409；IN_SERVICE 迁入边生产者=D3/W2，落位后并入放行集
 * ——头注钉住）→ room 型成员门（C-1：PAID 报名/场次律师经 trade 导出面，非成员 403）→
 * **presence 出箱先行**（失败即止零订阅残留）→ 订阅 → 回填 → joined 帧。
 *
 * 成员门（C-1 四口 + #43 三型分流，M2-W3 T3）：join（本件，经 assertMembership）/
 * send+pull（服务面 sendMessage/listMessages 单点设门）/HTTP GET messages（controller 传
 * asUserId）——room 型=PAID 报名/场次律师；one_on_one 型=订单双方（one_on_one_orders 直查，
 * 不要求订单状态——历史会话可回看）；private 型维持开放（#7 私信通道决策未决）。
 *
 * 发送链顺序在 ConversationService.sendMessage（成员门→BLOCKED 拒=广播前拦截，本件只透传
 * 403 回执，零本地缓冲——「其他成员零收到」由顺序保证）。
 */
import { Inject, Logger, Optional } from '@nestjs/common';
import { WebSocketGateway } from '@nestjs/websockets';
import { JwtService } from '@nestjs/jwt';
import type { IncomingMessage } from 'node:http';
import { WebSocket } from 'ws';
import type { SqlExecutor } from '../../infrastructure/sql';
import { PgPoolService } from '../../infrastructure/sql';
import { AppError, ErrorCode } from '@ljr/shared';
import { ConversationHub } from './conversation.hub';
import { ConversationService } from './conversation.service';
import { RoomService } from './room.service';
import { MAX_PULL_LIMIT, type ConversationView } from './conversation.types';

/** 鉴权超时 DI 令牌（⚠W1-6：默认 10s；测试 override 缩短覆盖同一分支） */
export const WSS_AUTH_TIMEOUT_MS = Symbol('WSS_AUTH_TIMEOUT_MS');
export const DEFAULT_WSS_AUTH_TIMEOUT_MS = 10_000;

/** WSS close code（鉴权失败/超时；4xxx=应用语义） */
const CLOSE_UNAUTHORIZED = 4401;

interface WssIdentity {
  readonly userId: number;
  readonly role: 'user' | 'lawyer';
}

/**
 * per-connection 状态：鉴权后身份 + 已 join 会话集（M2-W3 T5：msg_client_id ackCache LRU
 * 已删——判重态全在 V50 持久回执面，连接态不再承载幂等语义）
 */
interface ConnectionState {
  identity: WssIdentity | null;
  readonly joined: Set<number>;
}

interface ClientFrame {
  readonly type?: unknown;
  readonly token?: unknown;
  readonly conversation_id?: unknown;
  readonly msg_client_id?: unknown;
  readonly message?: unknown;
  readonly after_seq?: unknown;
  readonly limit?: unknown;
  readonly accept?: unknown;
}

function isPositiveInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0;
}

/**
 * 帧大小上限（T3 评审 I-1，64KB）：ws Server maxPayload 透传（WsAdapter create(port, options)
 * 将网关 options 原样并入 `new WebSocketServer({ noServer: true, ...wsOptions })`）——超限帧
 * 由 ws 层拒收并断连（close 1009 message-too-big），应用层不参与。W1 裁量护栏非产品契约，
 * 配置化预留=集中常量单点改。
 */
export const MAX_WS_PAYLOAD_BYTES = 64 * 1024;

@WebSocketGateway({ path: '/ws', maxPayload: MAX_WS_PAYLOAD_BYTES })
export class ConversationGateway {
  private readonly logger = new Logger(ConversationGateway.name);
  /** client → 状态（WeakMap：连接生命周期即状态生命周期，断连即回收） */
  private readonly states = new WeakMap<WebSocket, ConnectionState>();
  /** client → 稳定订阅闭包（同引用保证 hub unsubscribe 生效；与连接同生命周期） */
  private readonly subscriberFns = new WeakMap<WebSocket, (frame: string) => void>();

  constructor(
    private readonly conversations: ConversationService,
    private readonly rooms: RoomService,
    private readonly hub: ConversationHub,
    private readonly jwt: JwtService,
    private readonly pool: PgPoolService,
    @Optional() @Inject(WSS_AUTH_TIMEOUT_MS) private readonly authTimeoutMs?: number,
  ) {
    this.authTimeoutMs ??= DEFAULT_WSS_AUTH_TIMEOUT_MS;
  }

  /** 连接建立：未鉴权态 + 鉴权超时门（超时/失败 → close 4401） */
  handleConnection(client: WebSocket, _req: IncomingMessage): void {
    this.states.set(client, { identity: null, joined: new Set() });
    const timer = setTimeout(() => {
      const state = this.states.get(client);
      if (state && state.identity === null) {
        client.close(CLOSE_UNAUTHORIZED, 'auth timeout');
      }
    }, this.authTimeoutMs);
    client.on('close', () => clearTimeout(timer));
    client.on('message', (data) => {
      void this.onRawMessage(client, data).catch((e: unknown) => {
        // 兜底：帧处理异常不反噬进程（逐帧 try/catch 之外的最后防线）
        this.logger.error(`WSS 帧处理异常：${e instanceof Error ? e.message : String(e)}`);
      });
    });
  }

  /** 断连：隐式离场（逐会话退订+PresenceLeft——D3 快照收敛依赖） */
  handleDisconnect(client: WebSocket): void {
    const state = this.states.get(client);
    if (!state) return;
    const subscriber = this.subscriberFns.get(client);
    for (const conversationId of state.joined) {
      if (subscriber) this.hub.unsubscribe(conversationId, subscriber);
      void this.emitPresenceLeft(client, conversationId, state.identity);
    }
    state.joined.clear();
  }

  // ===========================================================================
  // 帧分发
  // ===========================================================================

  private async onRawMessage(client: WebSocket, data: unknown): Promise<void> {
    const state = this.states.get(client);
    if (!state) return;
    let frame: ClientFrame;
    try {
      frame = JSON.parse(String(data)) as ClientFrame;
      if (frame === null || typeof frame !== 'object' || typeof frame.type !== 'string') {
        throw new Error('bad shape');
      }
    } catch {
      this.sendError(
        client,
        ErrorCode.InvalidArgument,
        '帧须为含 type 字段的 JSON 对象',
        undefined,
      );
      return;
    }
    if (state.identity === null) {
      await this.handlePreAuth(client, state, frame);
      return;
    }
    switch (frame.type) {
      case 'auth':
        // 重复 auth：幂等回执（重连逻辑容错）
        this.send(client, {
          type: 'auth_ok',
          user_id: state.identity.userId,
          role: state.identity.role,
        });
        return;
      case 'join':
        await this.handleJoin(client, state, frame);
        return;
      case 'leave':
        await this.handleLeave(client, state, frame);
        return;
      case 'send':
        await this.handleSend(client, state, frame);
        return;
      case 'pull':
        await this.handlePull(client, frame, state.identity);
        return;
      case 'recording-consent':
        await this.handleRecordingConsent(client, frame, state.identity);
        return;
      default:
        this.sendError(
          client,
          ErrorCode.InvalidArgument,
          `未知帧类型：${String(frame.type)}`,
          String(frame.type),
        );
    }
  }

  /** 鉴权前：仅收 auth；其余一律拒+断连（auth 后才接受 join/send——⚠W1-6） */
  private async handlePreAuth(
    client: WebSocket,
    state: ConnectionState,
    frame: ClientFrame,
  ): Promise<void> {
    if (frame.type !== 'auth') {
      this.sendError(client, ErrorCode.Unauthorized, '未鉴权（首帧须为 auth）', String(frame.type));
      client.close(CLOSE_UNAUTHORIZED, 'unauthenticated');
      return;
    }
    const token = frame.token;
    if (typeof token !== 'string' || token.length === 0) {
      this.send(client, {
        type: 'auth_failed',
        code: ErrorCode.Unauthorized,
        message: '缺少 token',
      });
      client.close(CLOSE_UNAUTHORIZED, 'auth failed');
      return;
    }
    const identity = await this.verifyToken(token);
    if (identity === null) {
      this.send(client, {
        type: 'auth_failed',
        code: ErrorCode.Unauthorized,
        message: '凭证无效或已过期',
      });
      client.close(CLOSE_UNAUTHORIZED, 'auth failed');
      return;
    }
    state.identity = identity;
    this.send(client, { type: 'auth_ok', user_id: identity.userId, role: identity.role });
  }

  /**
   * JWT 校验（identity.guards.ts 同款逻辑的最小复制——HTTP 守卫面向 ExecutionContext，
   * WSS 无该上下文；claims {sub, role, roles} 同源）。WSS 角色=会话语汇 user|lawyer
   * （admin 激活角色无会话语义 → 拒）。
   */
  private async verifyToken(token: string): Promise<WssIdentity | null> {
    let payload: unknown;
    try {
      payload = await this.jwt.verifyAsync(token);
    } catch {
      return null;
    }
    const claims = (payload ?? {}) as { sub?: unknown; role?: unknown };
    const userId = Number(claims.sub);
    if (!Number.isInteger(userId) || userId <= 0) return null;
    if (claims.role !== 'user' && claims.role !== 'lawyer') return null;
    return { userId, role: claims.role };
  }

  // ===========================================================================
  // join / leave（在场 + 回填 + room 门）
  // ===========================================================================

  /**
   * join 顺序（T3 评审 I-3）：门（存在→房间 OPEN→成员）→ **presence 出箱先行**（失败即止
   * ——零订阅残留，客户端收 error 帧）→ 订阅登记 → 回填推送 → joined 帧。
   */
  private async handleJoin(
    client: WebSocket,
    state: ConnectionState,
    frame: ClientFrame,
  ): Promise<void> {
    if (!isPositiveInt(frame.conversation_id)) {
      this.sendError(client, ErrorCode.InvalidArgument, 'conversation_id 须为正整数', 'join');
      return;
    }
    const conversationId = frame.conversation_id;
    try {
      const conversation = await this.joinableConversation(conversationId);
      // C-1 成员门（join 口，#43 三型分流）：room 型非参与方/one_on_one 型非订单双方拒（403）
      await this.conversations.assertMembership(conversation, state.identity!.userId);
      // I-3：presence 先行——出箱失败即止（不订阅不回填，无残留）
      await this.conversations.recordPresence(
        conversation,
        state.identity!.userId,
        state.identity!.role,
        'joined',
      );
      // W3-6：订阅登记携 JWT claims.role——E1 草稿帧（hub.publishTo(['lawyer'])）的 R-04
      // 「仅律师端可见」过滤锚；user 订阅者对角色过滤帧零收到
      this.hub.subscribe(conversationId, this.subscriberOf(client), state.identity!.role);
      state.joined.add(conversationId);
      const backfill = await this.conversations.recentMessages(conversationId);
      this.send(client, {
        type: 'joined',
        conversation_id: conversationId,
        backfill,
      });
    } catch (e) {
      this.sendAppError(client, e, 'join');
    }
  }

  /** 稳定订阅闭包（每连接恰一个——同引用保证 join/leave/断连三路径的订阅登记与退订对齐） */
  private subscriberOf(client: WebSocket): (frame: string) => void {
    let fn = this.subscriberFns.get(client);
    if (!fn) {
      fn = (frame: string): void => {
        if (client.readyState === WebSocket.OPEN) client.send(frame);
      };
      this.subscriberFns.set(client, fn);
    }
    return fn;
  }

  private async handleLeave(
    client: WebSocket,
    state: ConnectionState,
    frame: ClientFrame,
  ): Promise<void> {
    if (!isPositiveInt(frame.conversation_id)) {
      this.sendError(client, ErrorCode.InvalidArgument, 'conversation_id 须为正整数', 'leave');
      return;
    }
    const conversationId = frame.conversation_id;
    if (!state.joined.has(conversationId)) {
      this.sendError(client, ErrorCode.Conflict, `未 join 会话 ${conversationId}`, 'leave');
      return;
    }
    state.joined.delete(conversationId);
    const subscriber = this.subscriberFns.get(client);
    if (subscriber) this.hub.unsubscribe(conversationId, subscriber);
    this.send(client, { type: 'left', conversation_id: conversationId });
    await this.emitPresenceLeft(client, conversationId, state.identity);
  }

  /** join 门：会话存在（404）+ room 型须房间 OPEN（简报口径；IN_SERVICE=D3/W2 落位后并入） */
  private async joinableConversation(conversationId: number): Promise<ConversationView> {
    const conversation = await this.conversations.getConversation(conversationId);
    if (!conversation) {
      throw new AppError(ErrorCode.NotFound, `会话 ${conversationId} 不存在`);
    }
    if (conversation.type === 'room') {
      const status = await this.rooms.statusOf(this.pool as SqlExecutor, conversation.ref_id);
      if (status !== 'OPEN') {
        throw new AppError(
          ErrorCode.Conflict,
          `房间 ${conversation.ref_id} 不可进入（状态 ${status ?? '房间缺失'}，须 OPEN）`,
        );
      }
    }
    return conversation;
  }

  // ===========================================================================
  // send（发送链入口；msg_client_id 持久回执判重；伪造角色拒）
  // ===========================================================================

  private async handleSend(
    client: WebSocket,
    state: ConnectionState,
    frame: ClientFrame,
  ): Promise<void> {
    if (!isPositiveInt(frame.conversation_id)) {
      this.sendError(client, ErrorCode.InvalidArgument, 'conversation_id 须为正整数', 'send');
      return;
    }
    const message = (frame.message ?? {}) as {
      readonly content?: unknown;
      readonly mention?: unknown;
      readonly sender_role?: unknown;
    };
    // 伪造角色拒（隔离铁律）：入参携带 sender_role 必须=JWT claims.role（agent/system 永拒）
    if (message.sender_role !== undefined && message.sender_role !== state.identity!.role) {
      this.sendError(
        client,
        ErrorCode.RoleForbidden,
        `sender_role 禁伪造（claims.role=${state.identity!.role}，收到：${String(message.sender_role)}；agent/system 仅内部系统 API）`,
        'send',
      );
      return;
    }
    const msgClientId =
      typeof frame.msg_client_id === 'string' && frame.msg_client_id.length > 0
        ? frame.msg_client_id
        : null;
    try {
      // 客户端幂等（M2-W3 T5）：持久回执面判重（在册=回放首访 ack，零新消息零新广播）；
      // 未携 msg_client_id=直发（E1 律师链路同款 sendMessage）
      if (msgClientId !== null) {
        const result = await this.conversations.sendMessageDedup({
          conversationId: frame.conversation_id,
          senderId: state.identity!.userId,
          senderRole: state.identity!.role,
          content: typeof message.content === 'string' ? message.content : '',
          mention:
            message.mention === undefined || message.mention === null
              ? undefined
              : (message.mention as 'agent' | 'lawyer'),
          dedupKey: msgClientId,
        });
        if (result.deduplicated) {
          this.send(client, {
            type: 'sent',
            conversation_id: frame.conversation_id,
            seq: result.messageSeq,
            msg_client_id: msgClientId,
            deduplicated: true,
          });
          return;
        }
        this.send(client, {
          type: 'sent',
          conversation_id: frame.conversation_id,
          seq: result.message.seq,
          msg_client_id: msgClientId,
          deduplicated: false,
        });
        return;
      }
      const sent = await this.conversations.sendMessage({
        conversationId: frame.conversation_id,
        senderId: state.identity!.userId,
        senderRole: state.identity!.role,
        content: typeof message.content === 'string' ? message.content : '',
        mention:
          message.mention === undefined || message.mention === null
            ? undefined
            : (message.mention as 'agent' | 'lawyer'),
      });
      this.send(client, {
        type: 'sent',
        conversation_id: frame.conversation_id,
        seq: sent.seq,
      });
    } catch (e) {
      this.sendAppError(client, e, 'send');
    }
  }

  // ===========================================================================
  // pull（断线增量；HTTP 读路径同源）
  // ===========================================================================

  private async handlePull(
    client: WebSocket,
    frame: ClientFrame,
    identity: WssIdentity,
  ): Promise<void> {
    if (!isPositiveInt(frame.conversation_id)) {
      this.sendError(client, ErrorCode.InvalidArgument, 'conversation_id 须为正整数', 'pull');
      return;
    }
    const afterSeq =
      frame.after_seq === undefined || frame.after_seq === null ? 0 : Number(frame.after_seq);
    const limit =
      frame.limit === undefined || frame.limit === null ? undefined : Number(frame.limit);
    try {
      const messages = await this.conversations.listMessages({
        conversationId: frame.conversation_id,
        asUserId: identity.userId, // C-1 成员门（pull 读口——与 HTTP GET 同源单点设门）
        afterSeq: Number.isInteger(afterSeq) && afterSeq >= 0 ? afterSeq : undefined,
        limit:
          limit !== undefined && Number.isInteger(limit) && limit > 0
            ? Math.min(limit, MAX_PULL_LIMIT)
            : undefined,
      });
      this.send(client, {
        type: 'messages',
        conversation_id: frame.conversation_id,
        messages,
      });
    } catch (e) {
      this.sendAppError(client, e, 'pull');
    }
  }

  // ===========================================================================
  // recording-consent（R-03 信令面；双门在服务层）
  // ===========================================================================

  private async handleRecordingConsent(
    client: WebSocket,
    frame: ClientFrame,
    identity: WssIdentity,
  ): Promise<void> {
    if (!isPositiveInt(frame.conversation_id)) {
      this.sendError(
        client,
        ErrorCode.InvalidArgument,
        'conversation_id 须为正整数',
        'recording-consent',
      );
      return;
    }
    if (typeof frame.accept !== 'boolean') {
      this.sendError(client, ErrorCode.InvalidArgument, 'accept 须为布尔值', 'recording-consent');
      return;
    }
    try {
      const result = await this.conversations.recordConsent({
        conversationId: frame.conversation_id,
        partyId: identity.userId,
        accept: frame.accept,
      });
      this.send(client, {
        type: 'recording_consent',
        conversation_id: result.conversation_id,
        recorded: result.recorded,
        both: result.bothPartiesConsented,
      });
      if (result.bothPartiesConsented) {
        // 双门齐告知（云录制已启动——信令面合同「双方齐→启动云录制」的客户端可见面）
        this.hub.publishRaw(result.conversation_id, {
          type: 'recording_started',
          conversation_id: result.conversation_id,
        });
      }
    } catch (e) {
      this.sendAppError(client, e, 'recording-consent');
    }
  }

  // ===========================================================================
  // 内部件
  // ===========================================================================

  private async emitPresenceLeft(
    client: WebSocket,
    conversationId: number,
    identity: WssIdentity | null,
  ): Promise<void> {
    if (!identity) return;
    try {
      const conversation = await this.conversations.getConversation(conversationId);
      if (conversation) {
        await this.conversations.recordPresence(
          conversation,
          identity.userId,
          identity.role,
          'left',
        );
      }
    } catch (e) {
      // presence 出箱失败（at-least-once 语义内不阻断连接路径；D3 快照容忍 30-60s 抖动）
      this.logger.warn(
        `PresenceLeft 出箱失败（conversation ${conversationId}）：${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  private send(client: WebSocket, frame: Record<string, unknown>): void {
    if (client.readyState !== WebSocket.OPEN) return;
    client.send(JSON.stringify(frame));
  }

  private sendError(
    client: WebSocket,
    code: ErrorCode,
    message: string,
    replyTo: string | undefined,
  ): void {
    const frame: Record<string, unknown> = { type: 'error', code, message };
    if (replyTo !== undefined) frame.reply_to = replyTo;
    this.send(client, frame);
  }

  private sendAppError(client: WebSocket, e: unknown, replyTo: string): void {
    if (e instanceof AppError) {
      this.sendError(client, e.code, e.message, replyTo);
      return;
    }
    this.logger.error(`WSS ${replyTo} 处理异常：${e instanceof Error ? e.message : String(e)}`);
    this.sendError(client, ErrorCode.InternalError, '内部错误', replyTo);
  }
}
