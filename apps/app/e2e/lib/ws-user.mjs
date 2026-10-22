// apps/app/e2e/lib/ws-user.mjs —— E2E 用户提问腿（M3-W2 T7，W2-3/W2-6 决策）：
// Node ws 客户端直连 core /ws 真链（auth→join→send 三帧 + 回帧断言 + 超时 + teardown close），
// 供 J12 草稿气泡端到端「用户提问」段。为什么直连 core 而非同源反代：serve-e2e.mjs 只代理
// HTTP（无 /ws upgrade 转发），用户腿不经反代即不引入升级转发面——反代保持零依赖纪律。
//
// 为什么 CLI 形态（而非 spec 内 import）：沿 W1 夹具纪律（helpers.runFixture 子进程调用
// 实物 CLI）——Playwright 转译面零 ESM/CJS 互操作风险；进程退出即 teardown（close 帧），
// 断连隐式离场由网关承载（D5 presence 语义），无残留连接。
//
// 帧协议（conversation.gateway 实文）：C→S {type:'auth',token} / {type:'join',
// conversation_id} / {type:'send',conversation_id,msg_client_id?,message:{content}}；
// S→C auth_ok{user_id,role} / joined{conversation_id,backfill} / sent{seq,msg_client_id?,
// deduplicated?} / error{code,message,reply_to}。send 落库后会广播 message 帧（含自己的
// 回声，可能先于 sent ack 到达）——等待目标回帧时跳过非目标帧。
//
// 用法：node apps/app/e2e/lib/ws-user.mjs --ws ws://127.0.0.1:3000/ws --token <jwt>
//        --conversation 1 --message "问题文本" [--client-id <uuid>] [--timeout-ms 5000]
// 出参（stdout 末行 JSON，失败 exit 1）：{ok, user_id, role, conversation_id,
//   backfill_count, seq, msg_client_id?, deduplicated, frames_seen}
// 凭据纪律：token 经 argv 注入（编排器 env → spec → 本 CLI），不落任何文件。
import process from 'node:process';
import { clearTimeout, setTimeout as sleepMs } from 'node:timers';
import WebSocket from 'ws';

const args = process.argv.slice(2);
function argValue(flag, fallback) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : fallback;
}
const WS_URL = argValue('--ws', '');
const TOKEN = argValue('--token', '');
const CONVERSATION = Number(argValue('--conversation', '0'));
const MESSAGE = argValue('--message', '');
const CLIENT_ID = argValue('--client-id', '');
const FRAME_TIMEOUT_MS = Number(argValue('--timeout-ms', '5000'));

if (!WS_URL || !TOKEN || !Number.isInteger(CONVERSATION) || CONVERSATION <= 0 || !MESSAGE) {
  process.stderr.write(
    '用法: node ws-user.mjs --ws <url> --token <jwt> --conversation <id> --message <text> [--client-id <id>] [--timeout-ms <ms>]\n',
  );
  process.exit(1);
}

/**
 * 帧等待：目标回帧命中即 resolve；非目标帧（send 回声 message/广播）记入 seen 后暂存
 * pending 不消费语义。失败面=应用 error 帧（reply_to 对位）或超时——均显性抛错（fail-visible）。
 */
function waitForFrame(socket, pending, seen, isTarget, isFailure, what) {
  const hit = pending.find((f) => isTarget(f) || isFailure(f));
  if (hit) {
    pending.splice(pending.indexOf(hit), 1);
    return Promise.resolve(hit);
  }
  return new Promise((resolve, reject) => {
    const timer = sleepMs(() => {
      socket.off('message', onMessage);
      reject(
        new Error(
          `等待 ${what} 回帧超时（${FRAME_TIMEOUT_MS}ms）；已见帧=${seen.join(',') || '无'}`,
        ),
      );
    }, FRAME_TIMEOUT_MS);
    function onMessage(data) {
      let frame;
      try {
        frame = JSON.parse(String(data));
      } catch {
        seen.push('bad-json');
        return;
      }
      seen.push(String(frame.type));
      if (isTarget(frame) || isFailure(frame)) {
        clearTimeout(timer);
        socket.off('message', onMessage);
        resolve(frame);
      } else {
        pending.push(frame);
      }
    }
    socket.on('message', onMessage);
  });
}

const seen = [];
const pending = [];
const out = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);

const socket = new WebSocket(WS_URL, { handshakeTimeout: FRAME_TIMEOUT_MS });
try {
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });

  // ① auth（首帧；⚠W1-6：token 不进 query 串，仅帧体携带）
  socket.send(JSON.stringify({ type: 'auth', token: TOKEN }));
  const authOk = await waitForFrame(
    socket,
    pending,
    seen,
    (f) => f.type === 'auth_ok',
    (f) => f.type === 'auth_failed' || (f.type === 'error' && f.reply_to === 'auth'),
    'auth_ok',
  );
  if (authOk.type !== 'auth_ok') {
    throw new Error(`auth 失败：${JSON.stringify(authOk)}`);
  }
  const userId = Number(authOk.user_id);
  if (!Number.isInteger(userId) || userId <= 0) {
    throw new Error(`auth_ok 缺 user_id：${JSON.stringify(authOk)}`);
  }

  // ② join（room 型门=房间 OPEN + 成员门=PAID 报名/场次律师——seed-room 数据底座承载）
  socket.send(JSON.stringify({ type: 'join', conversation_id: CONVERSATION }));
  const joined = await waitForFrame(
    socket,
    pending,
    seen,
    (f) => f.type === 'joined' && Number(f.conversation_id) === CONVERSATION,
    (f) => f.type === 'error' && f.reply_to === 'join',
    'joined',
  );
  if (joined.type !== 'joined') {
    throw new Error(`join 会话 ${CONVERSATION} 失败：${JSON.stringify(joined)}`);
  }
  const backfillCount = Array.isArray(joined.backfill) ? joined.backfill.length : -1;

  // ③ send（msg_client_id=持久回执判重键——J12 每问唯一 uuid）
  socket.send(
    JSON.stringify({
      type: 'send',
      conversation_id: CONVERSATION,
      msg_client_id: CLIENT_ID,
      message: { content: MESSAGE },
    }),
  );
  const sent = await waitForFrame(
    socket,
    pending,
    seen,
    (f) => f.type === 'sent' && Number(f.conversation_id) === CONVERSATION,
    (f) => f.type === 'error' && f.reply_to === 'send',
    'sent',
  );
  if (sent.type !== 'sent') {
    throw new Error(`send 会话 ${CONVERSATION} 失败：${JSON.stringify(sent)}`);
  }
  const seq = Number(sent.seq);
  if (!Number.isInteger(seq) || seq <= 0) {
    throw new Error(`sent 回帧缺正整数 seq：${JSON.stringify(sent)}`);
  }

  out({
    ok: true,
    user_id: userId,
    role: String(authOk.role),
    conversation_id: CONVERSATION,
    backfill_count: backfillCount,
    seq,
    ...(CLIENT_ID !== '' ? { msg_client_id: CLIENT_ID } : {}),
    deduplicated: sent.deduplicated === true,
    frames_seen: seen.join(','),
  });
} catch (e) {
  out({ ok: false, error: String(e?.message ?? e), frames_seen: seen.join(',') });
  process.exitCode = 1;
} finally {
  // teardown：显式 close（1000 正常关闭）+ 等 close 事件落定（断连=隐式离场，presence 出箱）
  if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
    socket.close(1000, 'e2e user leg done');
    await new Promise((resolve) => {
      const timer = sleepMs(() => resolve(), 1000);
      socket.once('close', () => {
        clearTimeout(timer); // close 先到即清兜底 timer（T8 终审 F-3）
        resolve();
      });
    });
  }
}
