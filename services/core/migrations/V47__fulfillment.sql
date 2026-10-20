-- M2-W3 V47：fulfillment 模块追加（D6 1对1 服务闭环）——one_on_one_orders 订单表
--
-- 事实源：docs/modules/D-履约/D6-1对1服务闭环.md（§3 领域模型 + §4 状态机 + §7 R-01~R-05）+
-- docs/plans/M2-W3-执行计划.md 附录 A.3 V47 蓝图（T0 契约冻结，列级逐字对齐）。
-- schema fulfillment / role ljr_fulfillment 已由 V1 建好（禁增删 schema/role，本文件不触碰）；
-- V1~V46 冻结。
--
-- 列清单与蓝图对照（A.3 逐字 + 两处增补列理由，头注钉住）：
--   fulfillment-one_on_one_orders（D6 §3 逐字）：
--     id bigserial PK / room_id bigint NOT NULL（本域 rooms 表 id 同域裸引用——房间内申请锚）/
--       conversation_id bigint NULL【增补理由=W3-13：会话由 D5 消费 OneOnOnePaid 事件异步建
--       （D5 W1 既有消费），§3 裸列 NOT NULL 与事件时序冲突——落 NULL 可空，accept/消息面回填】/
--       user_id bigint NOT NULL（identity 域用户 id 裸引用）/ lawyer_id bigint NOT NULL /
--       service_type varchar(16) NOT NULL ck 三值（deep_answer|doc_revision|strategy——
--       深度解答/文书修改/策略建议，§2 功能点词汇）/ mode varchar(8) NOT NULL ck 三值
--       （text|voice|video）/ unit_price numeric(10,2) NOT NULL（文字=每轮；语音视频=每 15min，
--       B3 one_on_one_prices 现行版快照）/ prepaid numeric(12,2) NOT NULL（预付全额——契约
--       {room_id,service_type,mode} 无数量入参，取 1 单位起付：text=1 轮、voice/video=1 个
--       15min；多消费经实结少补承载）/ consumed_units int NOT NULL DEFAULT 0（文字=已完成轮次；
--       语音视频=15min 段数向上取整；事实源=系统计量 W3-15）/ settle_amount numeric(12,2) NULL
--       （实结落定值——双方确认一致或 30min 默认后写入）/ refund_amount numeric(12,2) NULL
--       （取消/多退已受理退款额）/ diff_order_id bigint NULL（少补 F1 补差支付单 id 锚）/
--       payment_order_id bigint NOT NULL【增补理由：F1 预付单锚——退款/结算定位，enrollments
--       无支付单列同款口径的反向钉：D6 订单行直接携带，退款链免退款源注册表清单定位】/
--       status varchar(24) NOT NULL ck 十三值（CREATED|PAID|ACCEPTED|IN_SERVICE|FINISHED|
--       SETTLING|SETTLED|LAWYER_TIMEOUT|REFUNDED|CANCELLED|PARTIAL_REFUNDED|REFUND_PARTIAL|
--       DIFF_PENDING——§4 状态机全集，禁裸写：经守卫+STL entity_type='one_on_one_order'）/
--       accept_deadline timestamptz NULL（=paid_at+N 接单锅，I2 OOO_ACCEPT_TIMEOUT due 同锚）/
--       started_at timestamptz NULL（IN_SERVICE 锚=W3-8：text=accept 后首条用户消息、
--       voice/video=首次时长回调）/ finished_at timestamptz NULL / settle_deadline timestamptz
--       NULL（=finished_at+30min 实结默认确认锅，D9 配置化）/ created_at+updated_at
--       timestamptz NOT NULL DEFAULT now()（A.3 蓝图增补的审计列，UPDATE 路径维护）。
--
-- 派生索引（A.3 逐字 + 一处口径归一，理由）：
--   ix_ooo_room(room_id) / ix_ooo_user(user_id, status) / ix_ooo_lawyer(lawyer_id, status)
--     ——订单查询面（我的 1对1 单/律师工作台）；
--   ix_ooo_accept_deadline(accept_deadline) WHERE status='PAID'
--     ——接单超时扫描面（executor 回查 + 运维巡检）；
--   ix_ooo_settle_deadline(settle_deadline) WHERE status IN ('FINISHED','SETTLING')
--     ——实结默认确认扫描面；
--   ux_ooo_active(room_id, user_id, service_type) WHERE status IN (活跃八值)
--     ——蓝图「幂等键=UNIQUE(room_id,user_id,service_type)」+ 括号注「同房间同服务类型活跃单
--     唯一」的落位：部分唯一索引（ux-enroll-active 先例同款）——终态（SETTLED/REFUNDED/
--     LAWYER_TIMEOUT/CANCELLED/PARTIAL_REFUNDED）行移出活跃集，服务完成后同房间同类型可再
--     下单（活跃唯一=§5 幂等键语义；裸 UNIQUE 会永久锁死该组合，与括号注矛盾——报告注明）。
--     活跃八值=CREATED|PAID|ACCEPTED|IN_SERVICE|FINISHED|SETTLING|REFUND_PARTIAL|DIFF_PENDING。
--
-- 注意：flyway.conf defaultSchema=flyway —— 所有 DDL 一律全限定 fulfillment.<table>。
-- 幂等性：IF NOT EXISTS，reset 演练（drop schema 后整库重放 V1→V47）可重复执行。
-- 注释纪律：本文件注释以连字符指称跨域表（fulfillment-rooms 等），规避 check-schema-refs
--   的点分词形扫描误报；DDL 本体一律全限定名不受此限。
-- 权限：订单需 UPDATE（状态经守卫推进+计量/回填列）；无 DELETE（交易记录法定留存）。

-- ---------- fulfillment.one_on_one_orders：D6 1对1 订单（状态机全集+计量+实结锚） ----------
CREATE TABLE IF NOT EXISTS fulfillment.one_on_one_orders (
    id               bigserial     PRIMARY KEY,
    room_id          bigint        NOT NULL,
                                   -- 房间 id（本域 rooms 表 id 同域裸引用——房间内申请锚）
    conversation_id  bigint        NULL,
                                   -- D5 异建会话回填锚（W3-13：OneOnOnePaid 事件异步建会话，可空）
    user_id          bigint        NOT NULL,
                                   -- 下单用户（identity 域用户 id 裸引用）
    lawyer_id        bigint        NOT NULL,
                                   -- 服务律师（room→场次属主律师快照）
    service_type     varchar(16)   NOT NULL,
                                   -- deep_answer|doc_revision|strategy（§2 三值）
    mode             varchar(8)    NOT NULL,
                                   -- text|voice|video（§2 三值）
    unit_price       numeric(10,2) NOT NULL,
                                   -- B3 现行版快照：text=每轮；voice/video=每 15min
    prepaid          numeric(12,2) NOT NULL,
                                   -- 预付全额（1 单位起付：text=1 轮、voice/video=1 段）
    consumed_units   int           NOT NULL DEFAULT 0,
                                   -- 系统计量：text=轮次；voice/video=15min 段数（向上取整）
    settle_amount    numeric(12,2) NULL,
                                   -- 实结落定值（双方确认一致/30min 默认后写入）
    refund_amount    numeric(12,2) NULL,
                                   -- 已受理退款额（取消三档/多退/超时全退）
    diff_order_id    bigint        NULL,
                                   -- 少补 F1 补差支付单 id（payment 域支付单同域裸引用）
    payment_order_id bigint        NOT NULL,
                                   -- F1 预付单 id（资金面锚：退款/结算/分账定位）
    status           varchar(24)   NOT NULL,
                                   -- 十三值状态机词汇（ck 钉死；迁移必经守卫+STL）
    accept_deadline  timestamptz   NULL,
                                   -- 接单锅=paid_at+N（OOO_ACCEPT_TIMEOUT due 同锚）
    started_at       timestamptz   NULL,
                                   -- IN_SERVICE 锚（W3-8：text=首条用户消息/voice-video=首次回调）
    finished_at      timestamptz   NULL,
    settle_deadline  timestamptz   NULL,
                                   -- 实结默认确认锅=finished_at+30min（D9 配置化）
    created_at       timestamptz   NOT NULL DEFAULT now(),
    updated_at       timestamptz   NOT NULL DEFAULT now(),
    CONSTRAINT ck_ooo_service_type CHECK (service_type IN ('deep_answer', 'doc_revision', 'strategy')),
    CONSTRAINT ck_ooo_mode CHECK (mode IN ('text', 'voice', 'video')),
    CONSTRAINT ck_ooo_status CHECK (
        status IN ('CREATED', 'PAID', 'ACCEPTED', 'IN_SERVICE', 'FINISHED', 'SETTLING',
                   'SETTLED', 'LAWYER_TIMEOUT', 'REFUNDED', 'CANCELLED', 'PARTIAL_REFUNDED',
                   'REFUND_PARTIAL', 'DIFF_PENDING')
    )
);

COMMENT ON TABLE fulfillment.one_on_one_orders IS 'D6 1对1 订单：申请（房间锚）→预付→接单（N 分钟锅）→服务计量（轮次/15min 段）→实结（多退少补/双方确认或 30min 默认）→取消三档；状态经守卫+STL 推进禁裸写';
COMMENT ON COLUMN fulfillment.one_on_one_orders.conversation_id IS 'D5 会话回填锚（W3-13）：one_on_one 会话由 D5 消费 OneOnOnePaid 异步建——accept/消息面回填，NULL=会话未达';
COMMENT ON COLUMN fulfillment.one_on_one_orders.payment_order_id IS 'F1 预付单 id（资金面锚：F2 退款/结算定位免跨域查）';
COMMENT ON COLUMN fulfillment.one_on_one_orders.consumed_units IS '系统计量值（W3-15 事实源）：text=已完成轮次（用户问+律师答）；voice/video=时长回调 15min 段数向上取整（单调上界幂等 W3-9）';
COMMENT ON COLUMN fulfillment.one_on_one_orders.prepaid IS '预付全额（1 单位起付，契约无数量入参）：实结=unit_price×consumed_units 多退少补（R-02/R-04）';

-- ---------- 派生索引（见头注理由） ----------
CREATE INDEX IF NOT EXISTS ix_ooo_room
    ON fulfillment.one_on_one_orders (room_id);
CREATE INDEX IF NOT EXISTS ix_ooo_user
    ON fulfillment.one_on_one_orders (user_id, status);
CREATE INDEX IF NOT EXISTS ix_ooo_lawyer
    ON fulfillment.one_on_one_orders (lawyer_id, status);
CREATE INDEX IF NOT EXISTS ix_ooo_accept_deadline
    ON fulfillment.one_on_one_orders (accept_deadline)
    WHERE status = 'PAID';
CREATE INDEX IF NOT EXISTS ix_ooo_settle_deadline
    ON fulfillment.one_on_one_orders (settle_deadline)
    WHERE status IN ('FINISHED', 'SETTLING');
CREATE UNIQUE INDEX IF NOT EXISTS ux_ooo_active
    ON fulfillment.one_on_one_orders (room_id, user_id, service_type)
    WHERE status IN ('CREATED', 'PAID', 'ACCEPTED', 'IN_SERVICE', 'FINISHED', 'SETTLING',
                     'REFUND_PARTIAL', 'DIFF_PENDING');

-- ---------- 权限（沿 V35/V39 口径：GRANT 收窄形态，只授所需） ----------
GRANT SELECT, INSERT, UPDATE ON fulfillment.one_on_one_orders TO ljr_fulfillment;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA fulfillment TO ljr_fulfillment;
