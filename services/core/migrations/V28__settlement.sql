-- M1-W3 V28：settlement 模块（F3 分账结算）评审修复轮——违约扣减幂等收据表 + net 列注释勘定
--
-- 施工规格：docs/modules/F-资金/F3-分账结算.md（§5 APPLY_PENALTY 幂等键/§7 R-04/§10-7）
-- + Task 8 评审 F-1（Critical，资损级）/F-3（Important）修复裁决。
-- schema settlement / role ljr_settlement 已由 V1 建好（禁增删 schema/role，本文件不触碰）；
-- V1~V27 冻结。本文件 apply 后冻结禁改（W1 R16 冻结令）；后续口径变化一律走新迁移。
--
-- 表清单与评审裁决对照：
--   settlement-settlement-penalty-receipts  F-1 修复件：APPLY_PENALTY 持久幂等收据（per-key）。
--                     评审实证缺陷：原重放探测只查结算行 deduction_detail 单槽
--                     （last-writer-wins）——P1 首扣全走保证金腿（无行可锚 detail 未落）后同键
--                     重放→settlement 腿 Fresh 再扣；P2 同行二次违约覆盖 anchor→首键重放摊扣
--                     双计。收据表=事务内先 claim（ON CONFLICT DO NOTHING）：冲突=幂等短路返回
--                     原结果；成功才落 detail/发指令。列清单照评审裁决形状（penalty_key UNIQUE/
--                     settlement_id/amount/f1_ledger_keys/created_at）+ result_detail 增补
--                     （重放返原结果所需快照；claim 与落定同事务→提交行必有值，NULL=防御位）。
--   net 列注释勘定（F-3）：V27 对 net 列存在双语义注释（行内 vs COMMENT ON COLUMN）——本文件
--                     以 COMMENT ON COLUMN 覆盖语句统一为勘定口径（Σsplits=net=gross−penalty，
--                     平台服务费为 splits 构成项——R-05 平台不抽违约金）。零冻结令接触：不触碰
--                     V27 文件、不 reset；V27 行内注释（文件层，不入 DB）以本口径为准。
--
-- 边界纪律：settlement_id 为同 schema 同模块 settlements 裸引用（禁 FK，W1/W2 惯例）；
--   amount numeric(12,2)（Money 字符串往返禁 float）；penalty_key 列宽 varchar(128)
--   （V11/V20/V25「只放宽不收紧」同款口径：penalty/ 域三段键 + 保证金腿派生键均 ≤98）。
--   收据行无 DELETE/UPDATE 出授权之外——UPDATE 仅限本模块落定收据（claim 同事务回填），审计锚。
--
-- 注意：flyway.conf defaultSchema=flyway —— 所有 DDL 一律全限定 settlement 表。
-- 幂等性：IF NOT EXISTS，reset 整库重放可重复执行。
-- 注释纪律：本文件注释以连字符指称表名（settlement-settlement-penalty-receipts），规避
--   check-schema-refs 的点分词形扫描误报；DDL 本体一律全限定名不受此限。

-- ---------- settlement.settlement_penalty_receipts：APPLY_PENALTY 幂等收据（F-1 修复件；
-- ---------- per-key 持久锚；claim 先于一切资金/行动作） ----------
CREATE TABLE IF NOT EXISTS settlement.settlement_penalty_receipts (
    id             bigserial      PRIMARY KEY,
    penalty_key    varchar(128)   NOT NULL,
                                    -- R-04/R-W3-A 幂等键（penalty/ 域三段键；UNIQUE=收据锚）
    settlement_id  bigint         NULL,
                                    -- 锚定结算行（deduction_detail 承载行；无行可锚=NULL）
    amount         numeric(12,2)  NOT NULL,
                                    -- 请求违约金额（重放载荷比对锚；同键异载荷 409）
    f1_ledger_keys jsonb          NOT NULL,
                                    -- F1 指令键清单 [{leg,key,status,ledger_id}]（对账/审计）
    result_detail  jsonb          NULL,
                                    -- ApplyPenaltyResult 全量快照（重放返原结果；同事务落定）
    created_at     timestamptz    NOT NULL DEFAULT now(),
    CONSTRAINT ux_penalty_receipts_key UNIQUE (penalty_key),
    CONSTRAINT ck_penalty_receipts_nonneg CHECK (amount >= 0)
);

COMMENT ON TABLE settlement.settlement_penalty_receipts IS 'F3 违约扣减幂等收据（F-1：per-key 持久锚，claim 先于资金/行动作；冲突=短路返回原结果，防 P1 腿 Fresh 重扣/P2 anchor 覆盖双计）';
COMMENT ON COLUMN settlement.settlement_penalty_receipts.f1_ledger_keys IS 'F1 /pay/deduct 指令键清单 [{leg,key,status,ledger_id}]（split-ledgers 对账锚点）';

-- ---------- F-3：net 列注释勘定（COMMENT 覆盖，零冻结令接触；V27 行内注释以本口径为准） ----------
COMMENT ON COLUMN settlement.settlements.net IS '分账净额=gross−penalty（恒等式 Σsplits=net，构成校验锚点；平台服务费为 splits 构成项——R-05 平台不抽违约金）';

-- ---------- 权限（应用账号接线是 M1 接线决策，同 V1~V27：只授不验） ----------
-- 收据：INSERT（claim）+ SELECT（重放读回）+ UPDATE（同事务落定 anchor/keys/result_detail）；
-- 无 DELETE（幂等收据是 §10-7 审计事实源）。
GRANT SELECT, INSERT, UPDATE ON settlement.settlement_penalty_receipts TO ljr_settlement;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA settlement TO ljr_settlement;
