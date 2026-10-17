-- M1-W3 V29：pricing 模块（C6 改价与补偿）——改价历史表（PricingHistory）
--
-- 施工规格：docs/modules/C-交易/C6-改价与补偿.md（§3 领域模型 + §4 引擎判定 + §5 接口契约
-- + §7 R-01~R-06 + §10 验收清单 + §11 D17 补偿分母口径）。schema pricing / role ljr_pricing
-- 已由 V1 建好（禁增删 schema/role，本文件不触碰）；V1~V28 冻结（T8 修复新增 V28，C6 顺延本号）。
--
-- 表清单与文档对照：
--   pricing.pricing_histories  §3 逐字列（id/lawyer_id/old_version/new_version/direction/
--     change_pct/has_active_group/approval_id/credit_penalty/created_at/revoked_at +
--     CHECK change_pct>=0 + direction 值域 UP|DOWN）+ 三处口径归一（沿 V17 对同款文档裸列
--     的先例，C6 §3 裸列不含 §5/§10 契约所需载体）：
--     ① created_at 补 NOT NULL DEFAULT now()（§3 为裸列名）
--     ② result 列（文档裸列缺失）：§5 契约 {result: EFFECTED|PENDING_APPROVAL|REJECTED}
--        三态与 approve/revoke 幂等（幂等键=history）需要持久载体，否则审批态无事实源
--     ③ approval_source 列（文档裸列缺失）：§10 验收「记录 approval_source=manual」的落点
--        （①期人工兜底=MANUAL；H3=M2 落位时新迁移扩值域）
--     ④ new_version_draft jsonb（文档裸列缺失）：§5 审批回调 {approved, approval_id} 不携带
--        草案——PENDING_APPROVAL 行的生效内容必须随请求持久化（approve 时经 B3 版本服务落版），
--        R-03 版本不可变（禁改历史行）下无 second chance
--     ⑤ credit_penalty CHECK (credit_penalty <= 0)：惩罚快照非正（0=无惩罚；-5/-15/-30=
--        PRD §8.2 在团档位快照；实际扣分执行在 G1 按 credit.rules，本列=审计快照非事实源）
--   UNIQUE(lawyer_id, new_version)（自定，报告注明）：§5「幂等键=lawyer+new_version」的物理
--   兜底——new_version=请求时点分配（当前最大 version+1），同律师并发双请求恰一占号；
--   approve 时点经同款 advisory lock 复核版本链（号被 B3 直改抢占 → 409 审批作废重发起）。
--   索引 ix_pricing_histories_lawyer_created：R-03 频率滑窗（⚠W3-7 裁决=DB 滑窗——按
--   lawyer+created_at 30 天窗口计数；Redis 滑窗为换装适配位头注，开发期无 Redis 基建）
--   与 GET /pricing/histories?lawyer_id= 列表共用。
--
-- 边界纪律：lawyer_id/approval_id 为跨模块 bigint 裸引用（approval_id 指 H3 工单=M2 落位，
-- 跨 schema 禁 FK，W1-W3 惯例）；补偿流水不落本表（F4 承载：points_txns source=
-- price_compensation + 券指令事件，C6 §3 注）。
--
-- 注意：flyway.conf defaultSchema=flyway —— 所有 DDL 一律全限定 pricing.<table>。
-- 幂等性：IF NOT EXISTS / DROP TRIGGER IF EXISTS，reset 整库重放可重复执行。

-- ---------- pricing.pricing_histories：改价历史（§3 + §5/§10 契约载体口径归一） ----------
CREATE TABLE IF NOT EXISTS pricing.pricing_histories (
    id                bigserial      PRIMARY KEY,
    lawyer_id         bigint         NOT NULL,
                                     -- identity 侧用户 id 裸引用（跨 schema 禁 FK，W1-W3 惯例）
    old_version       int            NOT NULL,
                                     -- 改价基线版本号（请求时点 price_versions 当前最大 version）
    new_version       int            NOT NULL,
                                     -- 本请求分配的目标版本号（=old_version+1；生效时经 B3 版本服务落版）
    direction         varchar(8)     NOT NULL,
                                     -- UP|DOWN（§3 值域）
    change_pct        numeric(6,3)   NOT NULL,
                                     -- |新-旧|/旧（审计展示位；档位判定走应用侧整数精确比较）
    has_active_group  boolean        NOT NULL,
                                     -- 在团判定快照（请求时点 C1/C2 导出查询 OR——判定时点口径）
    result            varchar(16)    NOT NULL,
                                     -- EFFECTED|PENDING_APPROVAL|REJECTED（§5 契约三态；②）
    approval_id       bigint         NULL,
                                     -- H3 审批工单 id 裸引用（①期人工兜底=调用方传入；H3=M2）
    approval_source   varchar(16)    NULL,
                                     -- MANUAL=人工兜底（§10 验收锚）；H3 落位新迁移扩值域（③）
    credit_penalty    smallint       NOT NULL DEFAULT 0,
                                     -- 档位惩罚快照（非正；实际扣分在 G1，本列审计位）（⑤）
    new_version_draft jsonb          NOT NULL,
                                     -- PENDING→生效所需的版本草案全文（B3 全量配置形态）（④）
    created_at        timestamptz    NOT NULL DEFAULT now(),
                                     -- 频率滑窗与 24h 撤销窗的锚点（①）
    revoked_at        timestamptz    NULL,
                                     -- 撤销时刻（R-04；NULL=未撤销）
    CONSTRAINT ck_pricing_histories_direction CHECK (direction IN ('UP', 'DOWN')),
    CONSTRAINT ck_pricing_histories_change_pct CHECK (change_pct >= 0),
    CONSTRAINT ck_pricing_histories_result
        CHECK (result IN ('EFFECTED', 'PENDING_APPROVAL', 'REJECTED')),
    CONSTRAINT ck_pricing_histories_approval_source CHECK (approval_source IN ('MANUAL')),
    CONSTRAINT ck_pricing_histories_credit_penalty CHECK (credit_penalty <= 0),
    CONSTRAINT ux_pricing_histories_lawyer_newver UNIQUE (lawyer_id, new_version)
);

COMMENT ON TABLE pricing.pricing_histories IS 'C6 改价历史（PricingHistory）：三档判定/审批/撤销/补偿的请求事实源；版本行经 B3 版本服务落版（本表不持价格内容，草案列仅审批续燃用）';
COMMENT ON COLUMN pricing.pricing_histories.change_pct IS '|新-旧|/旧 三位小数（审计展示）；档位判定在应用侧整数精确比较（delta×10<=old），不读本列';
COMMENT ON COLUMN pricing.pricing_histories.result IS 'EFFECTED|PENDING_APPROVAL|REJECTED（§5 契约三态）；approve/revoke 幂等键=history 的状态载体';
COMMENT ON COLUMN pricing.pricing_histories.approval_source IS 'MANUAL=①期人工兜底（H3=M2）；approve 动作归源审计（§10 验收锚）';
COMMENT ON COLUMN pricing.pricing_histories.credit_penalty IS '档位惩罚快照（UP -5/LE10 -15/GT10 -30，不在团 0）；实际扣分在 G1（credit.rules），本列为 C6 侧审计位';
COMMENT ON COLUMN pricing.pricing_histories.new_version_draft IS 'B3 全量配置草案（PutPricingInput 归一形态 jsonb）：PENDING_APPROVAL 行 approve 生效时的落版内容（R-03 版本不可变，生效只有这一次机会）';

-- 频率滑窗（⚠W3-7：DB 滑窗 lawyer+created_at 30 天计数）+ GET /pricing/histories 列表共用
CREATE INDEX IF NOT EXISTS ix_pricing_histories_lawyer_created
    ON pricing.pricing_histories (lawyer_id, created_at);

-- ---------- 权限（C6 写面=INSERT+审批/撤销状态列 UPDATE；应用账号接线口径同 V17-V28） ----------
GRANT SELECT, INSERT, UPDATE ON pricing.pricing_histories TO ljr_pricing;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA pricing TO ljr_pricing;
