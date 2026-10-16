-- M1-W3 V20：payment 模块（F1 支付网关与回调 Inbox）——支付单 / 回调 Inbox / 指令与对账流水
--
-- 施工规格：docs/modules/F-资金/F1-支付网关与回调Inbox（§3 领域模型 + §7 R-01~R-05；文档名以免
-- 点分词形误报不带 .md 后缀）。
-- schema payment / role ljr_payment 已由 V1 建好（禁增删 schema/role，本文件不触碰）；V1~V19 冻结。
-- 本文件 apply 后冻结禁改（W1 R16 冻结令）；后续口径变化一律走新迁移或在代码注释说明。
--
-- 表清单与文档对照（三表 §3 逐字 + 口径归一，沿 V13/V16~V18 对同款文档裸列的先例）：
--   payment-payment_orders  §3 原文列 + ①created_at 补 NOT NULL DEFAULT now()；②status 补
--                           NOT NULL DEFAULT 'CREATED'（下单初始态）+ ck 值域七态（§3 注释逐字）；
--                           ③biz_type/channel 值域 ck（enroll|ooo|ooo_diff|deposit 与
--                           wechat_ecom|alipay，§2/§3 口径）；④cash_amount/points_amount 非负 ck
--                           （方向语义由业务列/流水 direction 表达，与 shared Money 非负口径一致）。
--                           total 生成列照 §3 原文表达式（cash_amount + points_amount/100.0，
--                           STORED）——拆分不变量 cash+points/100=total 的 DB 兜底层，应用侧
--                           全接口仍断言（双层）。
--   payment-inbox           §3 原文列 + ⑤status 补 NOT NULL DEFAULT 'RECEIVED' + ck 三态
--                           （RECEIVED|CONSUMED|DEAD，§3 注释）；⑥channel/event_type 不设列：
--                           §3 逐字无此二列，随 payload jsonb 携带（§5 回调路径 channel 在 URL）。
--                           biz_idempotency_key 列宽 160=业务幂等号上限 128（简报裁决「照 V11
--                           先例 128 宽」，V11 口径=列宽只放宽不收紧）+ ':' + 事件类型后缀
--                           （§3 构成 {业务幂等号}:{channel_event_type}，事件名 ≤32）。
--                           channel_txn_no 维持 §3 的 varchar(64)（通道流水号，非业务幂等键）。
--   payment-split_ledgers   §3 原文列 + 指令台账口径归一（Task 1 简报裁量「按 §3 模型就近落」）：
--                           ⑦direction/status 值域 ck：direction ∈ SPLIT|DEDUCT|REFUND|DIFF
--                           （解冻分账/违约扣减/退款指令/对账差异行——REFUND 为 R-03 退款指令
--                           流水的就近落位，DIFF 承接 §4「差异行写 diff_reason」）；
--                           status ∈ ISSUED|CONFIRMED|DIFF（§7 巡检第 4 类「分账指令发出但渠道
--                           未确认」要求两态可分；mock 通道同步确认，本批指令行恒 CONFIRMED，
--                           ISSUED 留给 M2 真实异步通道）；⑧period NOT NULL（指令行=指令当日，
--                           差异行=对账期）；⑨idempotency_key varchar(128) NULL UNIQUE：
--                           /pay/split、/pay/deduct、/pay/refund 指令幂等键（§5 三接口均带
--                           幂等键，UNIQUE 为 R-02 真兜底；DIFF 行无业务键，以确定性 recon:* 键
--                           入同列防重跑重复，故可空 + ck_split_ledgers_idem 要求非 DIFF 行必填）；
--                           ⑩detail jsonb NULL：指令上下文（order_id/lawyer_id/splits/channel_txn_no
--                           等）——§3 模型无引用列，就近以 jsonb 承载（同支付单表 split_detail 形态）；⑪amount 非负 ck、created_at NOT NULL DEFAULT now()。
--
-- 派生索引（超出 §3 清单，理由）：
--   ix_payment_orders_biz (biz_type, biz_id)        ——下游 C3/F2 按业务实体定位支付单扫描面；
--   ix_payment_orders_txn (channel_txn_no)          ——回调/对账按通道流水号等值定位；
--   ix_payment_orders_paid_at (paid_at)             ——对账「本地已付单按期核对」扫描面；
--   ix_payment_inbox_status (status, received_at)   ——死信巡检/消费面扫描（H3 死信工单）；
--   ix_split_ledgers_period (period, channel)       ——对账按期+通道核对扫描面；
--   ix_split_ledgers_refund_order ((detail->>'order_id')::bigint) WHERE direction='REFUND'
--                                                   ——R-03 累计退款校验（部分退款累计求和）。
--
-- 边界纪律：biz_id/lawyer_id 为他域 bigint 裸引用（跨 schema 禁 FK，W1/W2 惯例）；
--   金额列 numeric(12,2)，应用侧一律经 @ljr/shared Money 字符串往返（禁 float）；
--   R-01 资金不过平台账户：本 schema 只落指令与对账流水，无资金账户表。
--
-- 注意：flyway.conf defaultSchema=flyway —— 所有 DDL 一律全限定 payment 表。
-- 幂等性：IF NOT EXISTS / DROP TRIGGER IF EXISTS，reset 整库重放可重复执行。
-- 注释纪律：本文件注释以连字符指称表名（payment-payment_orders），规避 check-schema-refs
-- 的点分词形扫描误报；DDL 本体一律全限定名不受此限。

-- ---------- payment.payment_orders：支付单（§3；生命周期经守卫，状态禁裸写） ----------
CREATE TABLE IF NOT EXISTS payment.payment_orders (
    id              bigserial      PRIMARY KEY,
    biz_type        varchar(20)    NOT NULL,
                                      -- enroll|ooo|ooo_diff|deposit（§3 注释；ck 值域）
    biz_id          bigint         NOT NULL,
                                      -- 业务实体 id 裸引用（跨 schema 禁 FK，W1/W2 惯例）
    channel         varchar(16)    NOT NULL,
                                      -- wechat_ecom（主）|alipay（备）（§2 双通道）
    cash_amount     numeric(12,2)  NOT NULL DEFAULT 0,
                                      -- 现金部分（Money 字符串往返，禁 float）
    points_amount   int            NOT NULL DEFAULT 0,
                                      -- 积分部分（1 积分=0.01 元；下单时 F4 冻结核销，§2）
    total           numeric(12,2)  GENERATED ALWAYS AS (cash_amount + points_amount/100.0) STORED,
                                      -- §3 原文生成列：拆分不变量 DB 兜底层
    status          varchar(16)    NOT NULL DEFAULT 'CREATED',
                                      -- CREATED|FROZEN|PAID|REFUNDING|REFUNDED|SPLIT|CLOSED（§3）
    idempotency_key varchar(128)   NOT NULL,
                                      -- R-02 幂等键唯一约束（§5「幂等键=idempotency_key」；
                                      -- 128 宽照 V11 先例——shared 契约合法键最长 98 + 运维余量）
    channel_txn_no  varchar(64)    NULL,
                                      -- 通道流水号（支付成功后回填）
    split_detail    jsonb          NULL,
                                      -- 分账构成透传（F3 构成，本层不解释）
    created_at      timestamptz    NOT NULL DEFAULT now(),
    paid_at         timestamptz    NULL,
                                      -- 支付成功时点（FROZEN 落定时刻，对账核对锚点）
    CONSTRAINT ux_payment_orders_idem UNIQUE (idempotency_key),
    CONSTRAINT ck_payment_orders_biz_type CHECK (biz_type IN ('enroll', 'ooo', 'ooo_diff', 'deposit')),
    CONSTRAINT ck_payment_orders_channel CHECK (channel IN ('wechat_ecom', 'alipay')),
    CONSTRAINT ck_payment_orders_cash CHECK (cash_amount >= 0),
    CONSTRAINT ck_payment_orders_points CHECK (points_amount >= 0),
    CONSTRAINT ck_payment_orders_status
        CHECK (status IN ('CREATED', 'FROZEN', 'PAID', 'REFUNDING', 'REFUNDED', 'SPLIT', 'CLOSED'))
);

COMMENT ON TABLE payment.payment_orders IS 'F1 支付单（R-02 幂等键唯一；total 生成列=拆分不变量兜底；生命周期经守卫+state_transition_log）';
COMMENT ON COLUMN payment.payment_orders.total IS '生成列：cash_amount + points_amount/100.0（§3 原文；应用侧全接口断言同式，双层）';
COMMENT ON COLUMN payment.payment_orders.idempotency_key IS 'R-02 业务幂等键（shared 契约 domain/entity/event）；同键同载荷幂等重放、异载荷 409 E_DUP_KEY';

-- ---------- payment.inbox：回调 Inbox（§3；双唯一去重，乱序容忍） ----------
CREATE TABLE IF NOT EXISTS payment.inbox (
    id                  bigserial    PRIMARY KEY,
    channel_txn_no      varchar(64)  NOT NULL,
                                     -- 渠道流水号（R-02 双唯一之一）
    biz_idempotency_key varchar(160) NOT NULL,
                                     -- R-02 双唯一之二：{业务幂等号}:{channel_event_type}（§3 构成注释）
                                     -- ——同单不同事件（支付成功/退款成功）互不误杀，同类型重复去重；
                                     -- 160=业务幂等号 128（V11 先例宽）+ ':' + 事件名 ≤32
    payload             jsonb        NOT NULL,
                                     -- 通道报文原文（channel/event_type/order_id 随载荷）
    status              varchar(12)  NOT NULL DEFAULT 'RECEIVED',
                                     -- RECEIVED|CONSUMED|DEAD（§3；DEAD=死信语义）
    received_at         timestamptz  NOT NULL DEFAULT now(),
    consumed_at         timestamptz  NULL,
    CONSTRAINT ux_payment_inbox_txn UNIQUE (channel_txn_no),
    CONSTRAINT ux_payment_inbox_biz_key UNIQUE (biz_idempotency_key),
    CONSTRAINT ck_payment_inbox_status CHECK (status IN ('RECEIVED', 'CONSUMED', 'DEAD'))
);

COMMENT ON TABLE payment.inbox IS 'F1 回调 Inbox（R-02 双唯一去重；乱序容忍——非法推进被守卫拒后 DEAD+告警）';
COMMENT ON COLUMN payment.inbox.biz_idempotency_key IS '{业务幂等号}:{channel_event_type}（§3）：同单 PAY_SUCCESS/REFUND_SUCCESS 互不误杀，同类型重复回调去重';

-- ---------- payment.split_ledgers：指令与对账流水（§3；R-01 只指令不留资金） ----------
CREATE TABLE IF NOT EXISTS payment.split_ledgers (
    id              bigserial      PRIMARY KEY,
    period          date           NOT NULL,
                                      -- ⑧指令行=指令当日；差异行=对账期（§4 T+1 口径）
    channel         varchar(16)    NOT NULL,
    direction       varchar(16)    NOT NULL,
                                      -- SPLIT|DEDUCT|REFUND|DIFF（⑦解冻分账/违约扣减/退款/对账差异）
    amount          numeric(12,2)  NOT NULL,
                                      -- 指令金额（方向语义由 direction 表达，非负）
    status          varchar(16)    NOT NULL,
                                      -- ISSUED|CONFIRMED|DIFF（§7 巡检第 4 类区分指令/确认；mock 同步确认恒 CONFIRMED）
    idempotency_key varchar(128)   NULL,
                                      -- ⑨指令幂等键（§5 split/deduct/refund 均带键，UNIQUE 真兜底）；
                                      -- DIFF 行用确定性 recon:{period}:{channel}:{txn}:{kind} 防重跑重复
    detail          jsonb          NULL,
                                      -- ⑩指令上下文（order_id/lawyer_id/from/splits/channel_txn_no/reason）
    diff_reason     text           NULL,
                                      -- §4：差异行写差异原因（CHANNEL_ONLY/LOCAL_ONLY/AMOUNT_MISMATCH + 明细）
    created_at      timestamptz    NOT NULL DEFAULT now(),
    CONSTRAINT ux_split_ledgers_idem UNIQUE (idempotency_key),
    CONSTRAINT ck_split_ledgers_channel CHECK (channel IN ('wechat_ecom', 'alipay')),
    CONSTRAINT ck_split_ledgers_direction CHECK (direction IN ('SPLIT', 'DEDUCT', 'REFUND', 'DIFF')),
    CONSTRAINT ck_split_ledgers_status CHECK (status IN ('ISSUED', 'CONFIRMED', 'DIFF')),
    CONSTRAINT ck_split_ledgers_amount CHECK (amount >= 0),
    CONSTRAINT ck_split_ledgers_idem_required CHECK (direction = 'DIFF' OR idempotency_key IS NOT NULL),
    CONSTRAINT ck_split_ledgers_diff_shape CHECK (
        (direction = 'DIFF' AND status = 'DIFF' AND diff_reason IS NOT NULL)
        OR (direction <> 'DIFF' AND diff_reason IS NULL)
    )
);

COMMENT ON TABLE payment.split_ledgers IS 'F1 指令与对账流水（R-01 资金不过平台：只落指令+对账差异，无资金账户）';
COMMENT ON COLUMN payment.split_ledgers.idempotency_key IS '指令幂等键（R-02 UNIQUE 兜底）；DIFF 行=recon:{period}:{channel}:{txn}:{kind} 确定性键（防对账重跑重复）';
COMMENT ON COLUMN payment.split_ledgers.diff_reason IS '§4 对账差异原因（差异行必填，ck_split_ledgers_diff_shape 固化 DIFF 行形态）';

-- ---------- 派生索引（见头注理由） ----------
CREATE INDEX IF NOT EXISTS ix_payment_orders_biz
    ON payment.payment_orders (biz_type, biz_id);
CREATE INDEX IF NOT EXISTS ix_payment_orders_txn
    ON payment.payment_orders (channel_txn_no);
CREATE INDEX IF NOT EXISTS ix_payment_orders_paid_at
    ON payment.payment_orders (paid_at);
CREATE INDEX IF NOT EXISTS ix_payment_inbox_status
    ON payment.inbox (status, received_at);
CREATE INDEX IF NOT EXISTS ix_split_ledgers_period
    ON payment.split_ledgers (period, channel);
CREATE INDEX IF NOT EXISTS ix_split_ledgers_refund_order
    ON payment.split_ledgers (((detail ->> 'order_id')::bigint)) WHERE direction = 'REFUND';

-- ---------- 权限（应用账号接线是 M1 接线决策，同 V1~V19：只授不验，GRANT 收窄形态照 V17/V18） ----------
-- 三表均需 UPDATE（支付单生命周期推进 / inbox 消费与死信标记 / 差异行回填）；一律无 DELETE
-- （审计流水不可删——指令/回调留痕是 R-02 幂等与对账的事实源）。
GRANT SELECT, INSERT, UPDATE ON payment.payment_orders TO ljr_payment;
GRANT SELECT, INSERT, UPDATE ON payment.inbox TO ljr_payment;
GRANT SELECT, INSERT, UPDATE ON payment.split_ledgers TO ljr_payment;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA payment TO ljr_payment;
