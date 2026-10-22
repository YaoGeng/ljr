// apps/app/e2e/fixtures/seed-question-tree.mjs —— E3 问题树种子夹具（M3-W1 T3）：
// 若 dev 库的 labor_arbitration 专项问题树为空（V9 seed 初始态 {root:"",nodes:[]}）则种一棵
// 最小两层树（发团 tab 的 E3 问题树引导消费面）；已有非空树则不动（幂等且不覆盖运营配置）。
//
// 口径：
//   - 树结构 {root, nodes:[{id,label,children}]}（E3 specialty.types 实文；id=[a-z0-9_-]{1,64}、
//     label trim 后 1..64）；节点 label 即 C2 question_tags 词汇（C2 §2 消费口径）；
//   - 直插 UPDATE 为 dev 造数口径（运行时变更一律走 admin 面 PUT /admin/specialty/{key}/
//     question-tree——幂等键=key+base_version；夹具不打 admin 面以免要求 admin token）；
//   - 语句经 psql stdin（Windows argv 中文转码坑，lib.mjs 同款）。
import process from 'node:process';
import { psql, psqlFirst, sqlString } from './lib.mjs';

const SPECIALTY_KEY = 'labor_arbitration';

/** 最小两层树：根问题 → 五类争议；「解除/裁员」下再挂两问（嵌套渲染验证位） */
const TREE = {
  root: 'dispute',
  nodes: [
    {
      id: 'dispute',
      label: '你的劳动争议属于哪一类？',
      children: ['wage', 'overtime', 'contract', 'social', 'termination'],
    },
    { id: 'wage', label: '拖欠工资', children: [] },
    { id: 'overtime', label: '加班费', children: [] },
    { id: 'contract', label: '未签书面合同', children: [] },
    { id: 'social', label: '社保公积金', children: [] },
    { id: 'termination', label: '解除/裁员争议', children: ['severance', 'notice'] },
    { id: 'severance', label: '赔偿金（2N）', children: [] },
    { id: 'notice', label: '代通知金（N+1）', children: [] },
  ],
};

const rowExists = psqlFirst(
  `SELECT count(*) FROM agent_assist.specialty_configs WHERE specialty = ${sqlString(SPECIALTY_KEY)};`,
);

let action;
if (rowExists === '0') {
  // 行缺失（core 测试 truncateAll 会清业务表——V9 seed 行被清即此态）→ 连行带树种入
  // （ON CONFLICT DO NOTHING=幂等；prompts 空模板与 V9 seed 同值）
  psql(
    `INSERT INTO agent_assist.specialty_configs (specialty, question_tree, prompts, question_tree_version)
       VALUES (${sqlString(SPECIALTY_KEY)}, ${sqlString(JSON.stringify(TREE))}::jsonb,
               '{"templates":{}}'::jsonb, 1)
     ON CONFLICT (specialty) DO NOTHING;`,
  );
  action = 'seeded(row+tree)';
} else {
  const rootNow = psqlFirst(
    `SELECT question_tree ->> 'root' FROM agent_assist.specialty_configs WHERE specialty = ${sqlString(SPECIALTY_KEY)};`,
  );
  if (rootNow === '') {
    // 空树（->> 'root' 返回空串 = V9 seed 初始态）→ 种最小树（version 0→1；已有非空树不动）
    psql(
      `UPDATE agent_assist.specialty_configs
          SET question_tree = ${sqlString(JSON.stringify(TREE))}::jsonb,
              question_tree_version = 1,
              updated_at = now()
        WHERE specialty = ${sqlString(SPECIALTY_KEY)};`,
    );
    action = 'seeded(tree)';
  } else {
    action = 'exists(kept)';
  }
}

const after = psqlFirst(
  `SELECT question_tree ->> 'root', question_tree_version, jsonb_array_length(question_tree -> 'nodes')
     FROM agent_assist.specialty_configs WHERE specialty = ${sqlString(SPECIALTY_KEY)};`,
);
const [root, version, nodeCount] = after.split('|');

process.stdout.write(
  `${JSON.stringify({
    specialty: SPECIALTY_KEY,
    action,
    root,
    version: Number(version),
    nodes: Number(nodeCount),
  })}\n`,
);
