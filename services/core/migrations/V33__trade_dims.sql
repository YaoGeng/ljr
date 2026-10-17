-- M1-W3 V33：双维度框架增量批（序 11.5，2026-10-17 决策人指示 D-BP8 翻转）——城市×垂直维度列
--
-- 施工依据：docs/plans/M1-W3-执行计划.md 序 11.5 行（v1.4 更正：V31/V32 已被 T10 占用，本批=V33）
-- + PRD §1.2（垂直×城市=复制双轮，城市/垂直选择提前至 V1 框架位）。运营范围仍单城单垂直
-- （labor_arbitration × 北京）——本批只落维度列、物化与过滤（加数据不加结构）；供给开通/
-- 配置包上下线/灰置门槛=运营侧（04 §8-25），选择器「应用做全套」=M3 前端域任务。
--
-- schema trade / identity 已由 V1 建好（禁增删 schema/role，本文件不触碰）；V1~V32 冻结。
-- 本文件 apply 后冻结禁改（W1 R16 冻结令）；万一需改走整库重放（scripts/db reset），禁 repair。
--
-- 变更内容（四列，全部 NOT NULL DEFAULT，存量行自动回填）：
--   trade.sessions           + specialty varchar(32) NOT NULL DEFAULT 'labor_arbitration'
--                            + city varchar(32) NOT NULL DEFAULT '北京'
--   trade.group_buys         + city varchar(32) NOT NULL DEFAULT '北京'
--                            （specialty 已有=V24 原列，勿动）
--   identity.lawyer_profiles + city varchar(32) NOT NULL DEFAULT '北京'
--                            （执业城市登记面：A3a 提交可携带、缺省北京；重提携带则更新）
--
-- 口径注记（⚠W3-10）：城市码=中文名称字符串（'北京'），不做 GB/T 2260 代码化——多城启动时
-- 评估代码化=04 §8-25 待澄清位。specialty/city 值域防御在应用层（V24 头注同口径，不设 DB CHECK）。
-- DEFAULT 语义：应用层（C1 开团/C2 发布/A3a 提交）显式物化为主路径，DEFAULT 兜底存量行回填与
-- 未接线插入路径（如 C2B 履约 Session=C4=M2 接线位，先落默认值）。
--
-- 无新表：table-manifest 清单零变化（重跑生成器应无 diff）；测试清场 TEST_DB_TABLES 清单不动。
-- 幂等性：reset 演练（drop schema 后整库重放 V1→V33）可重复执行——V23/V24 先建原表、本文件
-- 后补列，重放一次到达目标态（ALTER 类迁移同 V31 口径）。

-- ---------- trade.sessions：双维度列（C1 开团物化；C2B 履约 Session=C4/M2 接线位先落默认） ----------
ALTER TABLE trade.sessions
    ADD COLUMN specialty varchar(32) NOT NULL DEFAULT 'labor_arbitration';

ALTER TABLE trade.sessions
    ADD COLUMN city varchar(32) NOT NULL DEFAULT '北京';

-- ---------- trade.group_buys：城市维（C2 发布物化；specialty=V24 原列勿动） ----------
ALTER TABLE trade.group_buys
    ADD COLUMN city varchar(32) NOT NULL DEFAULT '北京';

-- ---------- identity.lawyer_profiles：执业城市登记面（A3a 提交携带/缺省北京） ----------
ALTER TABLE identity.lawyer_profiles
    ADD COLUMN city varchar(32) NOT NULL DEFAULT '北京';

COMMENT ON COLUMN trade.sessions.city IS '城市维度（序 11.5，⚠W3-10 城市码=中文名称字符串，多城启动评估 GB/T 2260 代码化=04 §8-25）：C1 开团物化=律师执业城市（A3a getPracticeCity 导出面），null 兜底北京';
COMMENT ON COLUMN trade.group_buys.city IS '城市维度（序 11.5，⚠W3-10 同 trade.sessions 城市列口径）：C2 发布物化=目标律师执业城市（发布事务带出）';
COMMENT ON COLUMN identity.lawyer_profiles.city IS '执业城市登记面（序 11.5，⚠W3-10 同口径）：A3a 提交可携带（缺省北京），重提携带则更新/未携带保留原值；C1 开团/C2 发布经 getPracticeCity 导出面消费（禁跨 schema 直查）';

-- 权限：无新表/新序列，授权面不变（列级权限随表，M0 占位口径同 V23/V24/V15）
