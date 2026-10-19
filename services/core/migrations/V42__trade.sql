-- M2-W2 V42：trade 模块追加（C5 改期）——reschedule_requests 表 + enrollments pay_status 值域扩 RESCHEDULED_OUT
--
-- 事实源：docs/modules/C-交易/C5-改期.md（§3 领域模型 reschedule_requests 逐字 + §4 确认事务 +
--   §7 R-01~R-04 + §8 空位守卫并发安全 + §9 新建行铁律）+ docs/plans/M2-W2-执行计划.md T5 行
--   与附录 A.3 V40 蓝图（**迁移号顺延勘误**：V40/V41 已被 C4 占用（ck 扩+session_id 回链列，
--   V41 头注「迁移号顺延连锁」），C5 落 V42；后续 T6 F4=V43__benefits+V44__pricing、
--   T8 H4=V45__ops；周批 DoD flyway validate 至 V1~V45）。
-- schema trade / role ljr_trade 已由 V1 建好（禁增删 schema/role，本文件不触碰）；V1~V41 冻结。
--
-- 变更内容（两件）：
--   ① trade.reschedule_requests（A.3 蓝图逐列）：改期申请行——status 五态 ck
--     （PENDING|CONFIRMED|FAILED|EXPIRED|CANCELLED，C5 §3 逐字；迁移全经守卫+STL，
--     entity_type='reschedule_request'，机件=trade 域 reschedule-machine）；
--     - PENDING：申请事务即插行（同事务预写 RESCHEDULE_CONFIRM_TIMEOUT job，due=expires_at=
--       requested_at+12h，配置化 LJR_TRADE_RESCHEDULE_CONFIRM_TIMEOUT_HOURS）；
--     - PENDING→CONFIRMED：律师确认（§4 确认事务：目标空位守卫→旧行 RESCHEDULED_OUT→新建行
--       →目标 joined+1 同事务）；
--     - PENDING→FAILED：确认时目标空位守卫失败（满员/非 CREATED）——请求终态化，409 NO_SEAT；
--     - PENDING→EXPIRED：RESCHEDULE_CONFIRM_TIMEOUT 执行器超时回退（R-04：原报名不动——幂等回退）；
--     - PENDING→CANCELLED：用户撤回（确认前，§2）——同事务作废超时 job；
--     - requested_at 缺省 now()（DB 钟锚）；expires_at 生成=INSERT 侧 now()+make_interval（同钟，
--       C4 修复环 M-1 口径：窗判定不混用应用钟）；confirmed_at=确认事务落值；
--     - enrollment_id/target_session_id 裸引用（trade 域内语义指针，V26 头注⑤ prev_enrollment_id
--       同款先例，不设 FK——存在性由申请/确认事务内行锁读保证）。
--   ② trade-enrollments（V26 建/V40 扩）的 ck_enrollments_pay_status 值域 +RESCHEDULED_OUT
--     （第五态=C5 改期迁移出标记，V40 CONVERTED_OUT 同款 DROP/ADD 纯放宽）：
--     - PAID→RESCHEDULED_OUT：律师确认改期时旧行的迁移出标记——同事务新建 session 型报名行
--       （快照复制 R-03+prev_enrollment_id 回链+reschedule_used=true），旧行仅 pay_status 位
--       翻转（ref_type/ref_id/快照列禁 UPDATE——审计链铁律，C5 §9）；机终态无出边（退款完成
--       收敛走后继行 advanceToRefunded 迁移链重定向，V40 CONVERTED_OUT 同构）；
--     - 未支付（PENDING）行不可改期（改期锚=已支付报名；R-01 语义先决），不增 PENDING 入边。
--   权限：reschedule_requests 需 UPDATE（status 经守卫推进）；无 DELETE（交易记录法定留存）。
--   ux_enroll_active 谓词（pay_status IN ('PENDING','PAID')）天然将 RESCHEDULED_OUT 行移出
--   活跃集——同场次（目标）同用户活跃唯一不因迁移破坏（V40 头注同款口径）。
--
-- 幂等性：表 CREATE IF NOT EXISTS + 约束替换 DROP IF EXISTS 重建同名同新值域，reset 演练
--   （drop schema 整库重放 V1→V42）可重复执行；列宽 varchar(16) 不变（'RESCHEDULED_OUT'
--   16 字符恰在界内）。
-- 注释纪律：本文件注释以连字符指称表名（trade-reschedule_requests / trade-enrollments），
--   规避 check-schema-refs 的点分词形扫描误报；DDL 本体一律全限定名不受此限。

-- ---------- trade.reschedule_requests：C5 改期申请（§3 逐字；status 五态经守卫，状态禁裸写） ----------
CREATE TABLE IF NOT EXISTS trade.reschedule_requests (
    id                 bigserial      PRIMARY KEY,
    enrollment_id      bigint         NOT NULL,
                                      -- 原报名（trade-enrollments 的 id；PAID 行才可申请，头注①）
    target_session_id  bigint         NOT NULL,
                                      -- 目标场次（trade-sessions 的 id；申请时守卫=同律师+CREATED+有空位）
    status             varchar(16)    NOT NULL,
                                      -- PENDING|CONFIRMED|FAILED|EXPIRED|CANCELLED（§3 逐字，头注①）
    requested_at       timestamptz    NOT NULL DEFAULT now(),
                                      -- 申请时刻（DB 钟锚；12h 确认窗起点）
    confirmed_at       timestamptz    NULL,
                                      -- 律师确认时刻（CONFIRMED 态落值）
    expires_at         timestamptz    NOT NULL,
                                      -- 确认窗到期（requested_at+12h，配置化；RESCHEDULE_CONFIRM_TIMEOUT job 锚）
    CONSTRAINT ck_reschedule_requests_status
        CHECK (status IN ('PENDING', 'CONFIRMED', 'FAILED', 'EXPIRED', 'CANCELLED'))
);

COMMENT ON TABLE trade.reschedule_requests IS 'C5 改期申请（trade 域；status 五态经守卫+state_transition_log，entity_type=reschedule_request；12h 超时=EXPIRED 原报名不动 R-04；确认迁移=旧行 RESCHEDULED_OUT+新建行回链 §9 铁律）';

-- ---------- 派生索引（A.3 蓝图两件） ----------
CREATE INDEX IF NOT EXISTS ix_reschedule_enrollment
    ON trade.reschedule_requests (enrollment_id);
CREATE INDEX IF NOT EXISTS ix_reschedule_expires
    ON trade.reschedule_requests (expires_at) WHERE status = 'PENDING';

-- ---------- trade-enrollments：pay_status 值域扩 RESCHEDULED_OUT（C5 改期迁移出标记） ----------
ALTER TABLE trade.enrollments DROP CONSTRAINT IF EXISTS ck_enrollments_pay_status;
ALTER TABLE trade.enrollments
    ADD CONSTRAINT ck_enrollments_pay_status
    CHECK (pay_status IN ('PENDING', 'PAID', 'REFUNDED', 'CONVERTED_OUT', 'RESCHEDULED_OUT'));

COMMENT ON CONSTRAINT ck_enrollments_pay_status ON trade.enrollments IS
    'PENDING|PAID|REFUNDED 三态（V26 §3 逐字）+ CONVERTED_OUT（M2-W2 T4/C4：转化迁移出标记）+ RESCHEDULED_OUT（M2-W2 T5/C5：改期迁移出标记——新建行回链承载迁移，旧行仅状态位翻转）';

-- ---------- 权限（沿 V26/V38 口径：GRANT 收窄形态，只授所需） ----------
GRANT SELECT, INSERT, UPDATE ON trade.reschedule_requests TO ljr_trade;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA trade TO ljr_trade;
