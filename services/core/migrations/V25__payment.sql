-- M1-W3 V25：payment 模块（F2 退款处理）——退款单
--
-- 施工规格：docs/modules/F-资金/F2-退款处理.md（§3 领域模型 + §2 原因枚举 + §4/§7 R-01~R-04）。
-- schema payment / role ljr_payment 已由 V1 建好（禁增删 schema/role，本文件不触碰）；V1~V24 冻结。
-- 本文件 apply 后冻结禁改（W1 R16 冻结令）；后续口径变化一律走新迁移或在代码注释说明。
--
-- 表清单与文档对照（§3 逐字 + 口径归一，沿 V20/V22 对同款文档裸列的先例）：
--   payment-refunds   §3 原文列 + ①status 补 NOT NULL DEFAULT 'REQUESTED'（受理初始态）+ ck 值域
--                     四态（REQUESTED|PROCESSING|DONE|FAILED，简报状态机逐字；迁移矩阵=core
--                     侧 refund 状态机件，全用例钉住，经守卫+state_transition_log
--                     留痕，entity_type='refund'）；②reason 值域 ck（§2 枚举九值逐字：
--                     GROUP_FAIL|LAWYER_REJECT|TIMEOUT|CONVERT_WINDOW|NO_SHOW_ALL|CANCEL_RULE|
--                     OOO_CANCEL|OOO_TIMEOUT|SETTLE_REFUND）；③requested_at 补 NOT NULL DEFAULT
--                     now()（受理时点；V20/V22 created_at 口径归一，§3 列名照原文不另设 created_at）；
--                     ④cash_amount/points_amount 非负 ck + numeric(12,2)/int（Money 字符串往返
--                     禁 float，1 积分=0.01 元与 F1/F4 同口径）。
--                     文档缺口增补列（⚠T6 裁决位，报告偏差节注明；均超出 §3 裸列，理由如下）：
--                     ⑤user_id bigint NOT NULL：付款人账号——R-03 积分还原（F4 refundRestore 需
--                     付款人定位）、§5 GET /refunds/mine 本人过滤、I1 通知（§4 下游）三者的事实源；
--                     §3 裸列无付款人而 §5/§7 必需，受理入参增补（批量经退款源载荷自带）。
--                     ⑥attempt_count int NOT NULL DEFAULT 0：下发重试计数（§4「失败重试 3 次」
--                     的计数事实源；耗尽→PROCESSING→FAILED）。
--                     ⑦next_retry_at timestamptz NULL：退避重试时点（platform.outbox.next_retry_at
--                     同形先例；PROCESSING 且到期才重试，NULL=无待重试）。
--                     ⑧last_error text NULL：最近一次下发失败摘要（RefundFailed 载荷与 H3 工单
--                     记账锚点；成功下发不清除——留末次失败痕）。
--                     ⑨idempotency_key 列宽 varchar(128)：§3 逐字 varchar(64) 只放宽不收紧
--                     （V11/V20 同款口径：shared 契约合法键最长 98，64 会拒合法键）。
--
-- 派生索引（超出 §3 清单，理由）：
--   ix_refunds_order (payment_order_id)          ——R-04 金额守恒累计求和/回调按单收敛扫描面；
--   ix_refunds_user (user_id, status)            ——§5 GET /refunds/mine 本人状态列表扫描面；
--   ix_refunds_retry (status, next_retry_at)
--       WHERE status = 'PROCESSING' AND next_retry_at IS NOT NULL
--                                                ——§4 重试驱动拾取面（到期在途单）。
--
-- 边界纪律：payment_order_id/user_id 为裸引用（payment_order_id 同 schema 同模块 F1 表、
--   user_id 他域 identity——均跨引用禁 FK，W1/W2 惯例）；金额列 numeric(12,2)，应用侧一律经
--   @ljr/shared Money 字符串往返（禁 float）；R-01 资金不过平台账户：本表只是退款受理与状态
--   事实源，通道执行在 F1（refund 指令面），无资金账户表。
--
-- 注意：flyway.conf defaultSchema=flyway —— 所有 DDL 一律全限定 payment 表。
-- 幂等性：IF NOT EXISTS / DROP TRIGGER IF EXISTS，reset 整库重放可重复执行。
-- 注释纪律：本文件注释以连字符指称表名（payment-refunds），规避 check-schema-refs
-- 的点分词形扫描误报；DDL 本体一律全限定名不受此限。

-- ---------- payment.refunds：退款单（§3；R-04 幂等键唯一；状态迁移经守卫，状态禁裸写） ----------
CREATE TABLE IF NOT EXISTS payment.refunds (
    id               bigserial      PRIMARY KEY,
    payment_order_id bigint         NOT NULL,
                                    -- F1 支付单 id（同 schema 同模块 F1 表；禁 FK，W1/W2 惯例）
    user_id          bigint         NOT NULL,
                                    -- ⑤付款人账号（identity 侧；R-03 还原/§5 mine/I1 通知定位）
    cash_amount      numeric(12,2)  NOT NULL DEFAULT 0,
                                    -- ④现金退款（原路退回；Money 字符串往返，禁 float）
    points_amount    int            NOT NULL DEFAULT 0,
                                    -- ④积分退款（R-03 还原为积分不退现；1 积分=0.01 元）
    reason           varchar(32)    NOT NULL,
                                    -- ②§2 枚举九值（ck 逐字）
    status           varchar(16)    NOT NULL DEFAULT 'REQUESTED',
                                    -- ①REQUESTED|PROCESSING|DONE|FAILED（简报状态机；经守卫+STL）
    attempt_count    int            NOT NULL DEFAULT 0,
                                    -- ⑥下发重试计数（§4 失败重试 3 次的计数事实源）
    next_retry_at    timestamptz    NULL,
                                    -- ⑦退避重试时点（outbox 同形；到期才重试）
    last_error       text           NULL,
                                    -- ⑧最近一次下发失败摘要（RefundFailed/H3 工单锚点）
    idempotency_key  varchar(128)   NOT NULL,
                                    -- ⑨R-04 幂等键唯一（§5「幂等键」；128 照 V11/V20 列宽只放宽不收紧）
    requested_at     timestamptz    NOT NULL DEFAULT now(),
                                    -- ③受理时点（§3 列名照原文）
    done_at          timestamptz    NULL,
                                    -- 退款完成时点（PROCESSING→DONE 回调推进时刻）
    CONSTRAINT ux_refunds_idem UNIQUE (idempotency_key),
    CONSTRAINT ck_refunds_reason CHECK (reason IN (
        'GROUP_FAIL', 'LAWYER_REJECT', 'TIMEOUT', 'CONVERT_WINDOW', 'NO_SHOW_ALL',
        'CANCEL_RULE', 'OOO_CANCEL', 'OOO_TIMEOUT', 'SETTLE_REFUND')),
    CONSTRAINT ck_refunds_status CHECK (status IN ('REQUESTED', 'PROCESSING', 'DONE', 'FAILED')),
    CONSTRAINT ck_refunds_cash CHECK (cash_amount >= 0),
    CONSTRAINT ck_refunds_points CHECK (points_amount >= 0)
);

COMMENT ON TABLE payment.refunds IS 'F2 退款单（R-04 幂等键唯一；R-04 金额守恒=同单累计退款≤支付额；状态迁移经守卫+state_transition_log entity_type=refund）';
COMMENT ON COLUMN payment.refunds.user_id IS '付款人账号（文档缺口增补⑤：R-03 积分还原/§5 mine/I1 通知定位事实源）';
COMMENT ON COLUMN payment.refunds.attempt_count IS '下发重试计数（文档缺口增补⑥：§4 失败重试 3 次耗尽→FAILED）';
COMMENT ON COLUMN payment.refunds.next_retry_at IS '退避重试时点（文档缺口增补⑦；platform.outbox.next_retry_at 同形）';
COMMENT ON COLUMN payment.refunds.idempotency_key IS 'R-04 幂等键（同键同载荷幂等重放原单、异载荷 409 E_DUP_KEY，F1 replayOrder 同口径）';

-- ---------- 派生索引（见头注理由） ----------
CREATE INDEX IF NOT EXISTS ix_refunds_order
    ON payment.refunds (payment_order_id);
CREATE INDEX IF NOT EXISTS ix_refunds_user
    ON payment.refunds (user_id, status);
CREATE INDEX IF NOT EXISTS ix_refunds_retry
    ON payment.refunds (status, next_retry_at)
    WHERE status = 'PROCESSING' AND next_retry_at IS NOT NULL;

-- ---------- 权限（应用账号接线是 M1 接线决策，同 V1~V24：只授不验，GRANT 收窄形态照 V20/V22） ----------
-- 需 UPDATE（状态迁移经守卫推进 / 重试计数与时点回写 / done_at 落定）；无 DELETE
-- （退款单是 R-04 幂等与金额守恒的事实源，审计流水不可删）。
GRANT SELECT, INSERT, UPDATE ON payment.refunds TO ljr_payment;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA payment TO ljr_payment;
