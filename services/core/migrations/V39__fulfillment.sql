-- M2-W2 V39：fulfillment 模块追加（D3 到场与缺席判定）——attendances 到场判定表
--
-- 事实源：docs/modules/D-履约/D3-到场与缺席判定.md（§3 领域模型 + §4 两级判定 + §7 R-01~R-05）+
-- docs/plans/M2-W2-执行计划.md 附录 A.3 V39 蓝图（T0 契约冻结，列级逐字对齐）。
-- schema fulfillment / role ljr_fulfillment 已由 V1 建好（禁增删 schema/role，本文件不触碰）；
-- V1~V38 冻结。
--
-- 表清单与蓝图对照（附录 A.3 逐字 + 口径归一）：
--   fulfillment-attendances（D3 §3 逐字）：
--     id bigserial PK / room_id bigint NOT NULL（fulfillment-rooms 表 id 同域裸引用）/
--       user_id bigint NOT NULL（identity 域用户 id 裸引用——user|lawyer 皆 identity 账号）/
--       role varchar(8) NOT NULL ck 二值（user|lawyer；presence 载荷 role 透传）/
--       first_join_at timestamptz NULL（首次进入时刻——job2 的 LATE/ABSENT 15min 边界锚：
--       <=grace_end+15min（含）=LATE、>（不含）或 NULL=ABSENT，R-01）/ last_seen_at timestamptz
--       NULL（最近 join/leave 时刻——观测面口径；判定以 presence 序列重放为准，非本列）/
--       status varchar(12) NOT NULL ck 三值（NORMAL|LATE|ABSENT——判定结果字段：D3 §4 两级
--       job 经服务内唯一写点落值+adjudicated_at 幂等，可不经状态机但禁裸 UPDATE 扩散）/
--       adjudicated_at timestamptz NULL（判定时刻；NULL=未判定——重复 presence/判定 job 重放
--       的幂等锚：非空不重写不重发事件，§8）。
--     派生约束：ux_attendances_room_user UNIQUE(room_id, user_id)（蓝图逐字——重复 presence
--       事件不双写：upsert 只推 first_join_at（首次）/last_seen_at，§8 幂等 DB 真兜底）。
--
-- 状态占位口径（蓝图无 PENDING 值域）：presence 写入路径的行以 status='NORMAL' 占位插入
--   （INSERT 非迁移，trade-sessions INSERT 'CREATED'/rooms 失败行 CANCELLED 直插=初始态承载
--   先例）；status 仅在 adjudicated_at 非空时有判定语义（NORMAL=宽限内到场/LATE=宽限后
--   ≤15min/ABSENT=缺席）——查询面（attendance-stats/GET attendance）按 adjudicated_at 过滤。
--
-- 注意：flyway.conf defaultSchema=flyway —— 所有 DDL 一律全限定 fulfillment.<table>。
-- 幂等性：IF NOT EXISTS，reset 演练（drop schema 后整库重放 V1→V39）可重复执行。
-- 注释纪律：本文件注释以连字符指称表名（fulfillment-rooms / trade-sessions），规避
--   check-schema-refs 的点分词形扫描误报；DDL 本体一律全限定名不受此限。

-- ---------- fulfillment.attendances：D3 到场判定（presence 写入 + 两级判定结果；UNIQUE 幂等） ----------
CREATE TABLE IF NOT EXISTS fulfillment.attendances (
    id             bigserial    PRIMARY KEY,
    room_id        bigint       NOT NULL,
                                -- 房间 id（本域 rooms 表 id 同域裸引用）
    user_id        bigint       NOT NULL,
                                -- 参与方（identity 域用户 id 裸引用；user|lawyer 皆账号维度）
    role           varchar(8)   NOT NULL,
                                -- user|lawyer（presence 载荷 role 透传；owner_type 同词汇）
    first_join_at  timestamptz  NULL,
                                -- 首次进入时刻（job2 的 15min 边界锚；NULL=从未进入→ABSENT）
    last_seen_at   timestamptz  NULL,
                                -- 最近 join/leave 时刻（观测口径；判定=presence 序列重放非本列）
    status         varchar(12)  NOT NULL,
                                -- NORMAL|LATE|ABSENT（判定结果；未判定行占位 NORMAL+adjudicated_at NULL）
    adjudicated_at timestamptz  NULL,
                                -- 判定时刻（NULL=未判定；幂等锚——非空不重写不重发事件，§8）
    CONSTRAINT ck_attendances_role CHECK (role IN ('user', 'lawyer')),
    CONSTRAINT ck_attendances_status CHECK (status IN ('NORMAL', 'LATE', 'ABSENT')),
    CONSTRAINT ux_attendances_room_user UNIQUE (room_id, user_id)
                                -- 幂等键=(room,user)：重复 presence 不双写（§8 DB 真兜底）
);

COMMENT ON TABLE fulfillment.attendances IS 'D3 到场判定：presence 幂等写入（first_join_at 首次/last_seen_at 推进）+两级判定结果（grace_end 快照 NORMAL/IN_SERVICE；+15min 边界 LATE/ABSENT，R-01）；UNIQUE(room_id,user_id)=重复 presence 不双写';
COMMENT ON COLUMN fulfillment.attendances.status IS '判定结果三值（NORMAL|LATE|ABSENT）；未判定行以 NORMAL 占位插入——判定语义仅 adjudicated_at 非空时成立，查询面按 adjudicated_at 过滤（占位口径，V39 头注）';
COMMENT ON COLUMN fulfillment.attendances.first_join_at IS '首次进入时刻：job2 边界=first_join_at<=grace_end+15min（含）LATE、>（不含）或 NULL ABSENT（R-01）；confirm-arrival 人工确认=now() 落值（D2 §5 口径）';

-- ---------- 权限（沿 V35/V37 口径：GRANT 收窄形态，只授所需） ----------
-- attendances 需要 UPDATE（presence 推进 last_seen_at + 判定 status/adjudicated_at 落值）；
-- 无 DELETE（判定留痕：缺席费用不退的审计锚，电商法 §31 同口径，架构 §1.3）。
GRANT SELECT, INSERT, UPDATE ON fulfillment.attendances TO ljr_fulfillment;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA fulfillment TO ljr_fulfillment;
