// apps/app/e2e/fixtures/seed-admin-risk.mjs —— H5 人审队列待处置夹具（M3-W3 T4）：
// 直插 ops.risk_records 待处置（reviewed_* 全 NULL）行 3 条（legal_industry×2 +
// illegal_content×1），供 apps/admin #/risk 队列对接真实 core API 联调与 T7 E2E J16
// （词库提交新版本 + 队列 verdict 处置 → 跌出）。
//
// 用法：node apps/app/e2e/fixtures/seed-admin-risk.mjs
//   （需先 node scripts/db/start.mjs 起 PG；不依赖 core dist——本表列均明文，无加密面）
//
// 幂等（重跑复位规范态，对照 seed-admin-lawyer.mjs 形态）：
//   - 先清后插：按夹具专属 conversation_id 坐标段（990041~990043，dev 造数约定——真实会话
//     主键远未到达该段）DELETE 本夹具历史行（含已处置行——E2E 处置实验后重放即复位待审态）；
//   - 重插 3 行 reviewed_by/reviewed_at/verdict/reviewed_note 全 NULL（V8 待处置 + V45 留痕列
//     空位的规范态）。
// 列读取对照（直插先例 seed-admin-lawyer/seed-sessions）：core ops/risk-review.service
//   listQueue 读 ops.risk_records（id/message_id/conversation_id/dict_type/word_hits/action/
//   created_at），WHERE reviewed_at IS NULL ORDER BY created_at DESC, id DESC——本夹具
//   reviewed_at NULL 即入列。word_hits 形态=[{word, action, rule_version}]（checkRisk 落行
//   契约 V8），action 恒 'REVIEW'（W1 只落 REVIEW 行=队列面真实形态）；rule_version=词库
//   wordlist.<dict_type> 当前生效版本（无版本=0——审计锚点如实，夹具运行时刻查询）。
// 纪律注记：直插为 dev 造数口径（运行时处置一律走 core review 端点——行内回填+audit_logs
//   同事务双面审计）；夹具不改任何 core 源码/表结构；词例全部虚构无害话术（非真实违法词）。
import process from 'node:process';
import { psql, psqlFirst } from './lib.mjs';

/** 夹具专属 conversation_id 坐标段（幂等清理锚；真实会话主键远未到达） */
const CONV_IDS = [990041, 990042, 990043];

/** 夹具行定义：dict_type / 命中词（虚构无害话术，小写规范形）/ 夹具时点词库版本 */
const rows = [
  {
    convId: 990041,
    dictType: 'legal_industry',
    words: ['加微信返全款', '稳赚不赔包过'],
  },
  {
    convId: 990042,
    dictType: 'legal_industry',
    words: ['私下收款演示词'],
  },
  {
    convId: 990043,
    dictType: 'illegal_content',
    words: ['fixture-涉诈话术演示'],
  },
];

/** 词库当前生效版本（rule-center currentVersion 口径：EFFECTIVE 且已生效的最大 version；无=0） */
function dictVersion(dictType) {
  const raw = psqlFirst(
    `SELECT max(version) FROM ops.rule_definitions
      WHERE rule_key = 'wordlist.${dictType}' AND publish_status = 'EFFECTIVE' AND effective_at <= now();`,
  );
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= 0 ? n : 0;
}

// ---- 幂等清理：夹具坐标段先清（含已处置行——重放即复位待审态） ----
psql(`DELETE FROM ops.risk_records WHERE conversation_id IN (${CONV_IDS.join(', ')});`);

// ---- 直插 3 行待处置记录（V8 列集 + V45 留痕列保持 NULL；created_at 缺省 now()=入队时刻） ----
const versions = new Map(rows.map((r) => [r.dictType, dictVersion(r.dictType)]));
for (const r of rows) {
  const ruleVersion = versions.get(r.dictType) ?? 0;
  const hits = JSON.stringify(
    r.words.map((w) => ({ word: w, action: 'REVIEW', rule_version: ruleVersion })),
  );
  psql(
    `INSERT INTO ops.risk_records (conversation_id, dict_type, word_hits, action)
     VALUES (${r.convId}, '${r.dictType}', '${hits.replaceAll("'", "''")}'::jsonb, 'REVIEW');`,
  );
}

// ---- 回读坐标（record ids——E2E 处置目标）并校验待处置在册 ----
const listed = psql(
  `SELECT id, conversation_id, dict_type FROM ops.risk_records
    WHERE conversation_id IN (${CONV_IDS.join(', ')}) AND reviewed_at IS NULL ORDER BY id;`,
);
const records = listed
  .split(/\r?\n/)
  .filter((l) => l.trim() !== '' && !/^(INSERT|DELETE|SELECT) /.test(l))
  .map((l) => {
    const [id, convId, dictType] = l.split('|');
    return {
      id: Number(id),
      conversation_id: Number(convId),
      dict_type: dictType,
      action: 'REVIEW',
    };
  });
if (records.length !== rows.length) {
  process.stderr.write(`夹具行数不符：期望 ${rows.length} 行待处置，实得 ${records.length} 行\n`);
  process.exit(1);
}

process.stdout.write(
  `${JSON.stringify({
    records,
    state:
      'reviewed_* 全 NULL=待处置（重跑按 conversation_id ' +
      `${CONV_IDS[0]}~${CONV_IDS[CONV_IDS.length - 1]} 先清后插复位规范态）`,
    rule_versions: Object.fromEntries(versions),
    queue: 'GET /admin/risk/queue?dict_type=&action=&limit=&offset=',
    review:
      'POST /admin/risk/records/:id/review {verdict: CONFIRM_BLOCK|FALSE_POSITIVE|MARK_ONLY, note?}',
  })}\n`,
);
