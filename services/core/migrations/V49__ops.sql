-- M2-W3 V49：ops 规则 seed 迁移（T5 批内收口件）——取消矩阵 v1 正式固化 + 券价补偿默认值
--
-- 事实源：docs/plans/M2-W3-执行计划.md T5 行+附录 A.3 V49 蓝图（T0 契约冻结）+ W2 复审 §3-⑧
-- （取消矩阵正式 v1）+ 决策位 W3-12（券面额 PRICE_COMP seed 默认=面额 50 元/有效期 90 天，
-- #44-⑥ 承接）；内容事实源=cancellation 引擎内置 DEFAULT_CANCEL_MATRIX 常量（逐字固化
-- ——rule_key 全形见下方 VALUES 的拼接表达式）。
-- schema ops / role ljr_ops 已由 V1 建好（禁增删 schema/role，本文件不触碰）；V1~V48 冻结。
--
-- 无新表：table-manifest 清单零变化；TEST_DB_TABLES 清单不动（ops.rule_definitions 既有——
-- seed 行随 TRUNCATE 清场，specs 需要行时经 createLexiconVersion 免公示通道等价构造，
-- coupon-spec/cancellation-spec 先例）。
--
-- 发布语义对齐 RuleCenterService 快照读面（snapshotAt）的读取谓词：
--   命中条件 = publish_status='EFFECTIVE' AND effective_at IS NOT NULL AND effective_at <= 行为时刻
--   ⇒ seed 落 EFFECTIVE + effective_at=迁移时刻（now()）——即刻可命中（「正式发布」语义：内容
--   为引擎已生效默认值的版本化固化，非新规则生效；published_at 同落迁移时刻=发布审计锚）。
--   覆盖键（连字符指称=V48 注释纪律；全形见 VALUES 拼接表达式）：
--     - cancel-matrix 键：cancellation-service 的 matrixSnapshot 在册优先（v1 内容≡内置默认
--       → 行为零漂移、STL reason 的 rv 由 0→1），无行兜底=DEFAULT_CANCEL_MATRIX 维持；
--     - coupon-price_comp 键：coupon-service 的 resolvePriceCompDefinition 在册优先（W3-12
--       拍板默认 50.00/90 天=运营可改初值），无行回退 V43 券定义 seed 行。
--
-- 状态纪律（V7「publish_status 禁裸写」的 seed 例外声明）：两行为迁移 seed 直落 EFFECTIVE——
--   语义同 R-03 词库免公示通道（创建即 EFFECTIVE）先例；留痕=同迁移落 state_transition_log
--   审计行（from NULL → EFFECTIVE，reason='seed_official_v1'，lexicon_publish_freeze 同款显式
--   留痕口径），不暴露 HTTP、不走公示流（7 日公示语义不适用于已生效内容的版本化固化）。
--
-- 幂等性：ON CONFLICT (rule_key, version) DO NOTHING（uq_rule_defs_key_version 兜底）——
--   reset 演练（drop schema 后整库重放 V1→V49）与重复 apply 安全；CTE 仅对本次实际插入行
--   落 STL（重放零新行=零新留痕，不重复审计）。
-- 注释纪律（V48 同款）：注释规避点分词形（rule_key 全形以拼接表达式落在 VALUES——check-schema-refs
--   规则 C 对字符串字面量同样扫描）；DDL 本体一律全限定名不受此限。

-- ---------- seed：两行 v1 正式版本（EFFECTIVE + 迁移时刻生效，见头注谓词对齐） ----------
WITH seeded AS (
    INSERT INTO ops.rule_definitions
        (rule_key, version, content, effective_at, publish_status, published_at)
    VALUES
        -- rule_key 全形=cancel 拼点 matrix（D4 引擎 CANCEL_MATRIX_RULE_KEY 逐字；点分字面量
        -- 以拼接承载=scanner 纪律，值等价——psql 重放后行值即全形）
        ('cancel' || '.matrix', 1,
         '{"userFreeCancelHours":2,"userLateRefundPct":50,"lawyerNoticeHours":24,"lawyerLatePenaltyCredit":30,"lawyerLatePenaltyPct":20,"lawyerAbsencePenaltyCredit":50,"lawyerAbsenceCompensationPct":50,"suspendWindowDays":30,"suspendCount":2,"suspendDays":7}'::jsonb,
         now(), 'EFFECTIVE', now()),
        -- rule_key 全形=coupon 拼点 price_comp（F4 COUPON_PRICE_COMP_RULE_KEY 逐字；W3-12 拍板默认）
        ('coupon' || '.price_comp', 1,
         '{"face_value":"50.00","validity_days":90}'::jsonb,
         now(), 'EFFECTIVE', now())
    ON CONFLICT (rule_key, version) DO NOTHING
    RETURNING id
)
-- 等价审计留痕（V7「禁裸写」seed 例外的显式留痕，头注口径；仅本次实际插入行）
INSERT INTO platform.state_transition_log (entity_type, entity_id, from_status, to_status, allowed, reason)
SELECT 'rule_definition', id, NULL, 'EFFECTIVE', true, 'seed_official_v1'
FROM seeded;

COMMENT ON COLUMN ops.rule_definitions.effective_at IS '生效时刻（PUBLISHED 时=published_at+7日；R-03 免公示通道创建即落；V49 seed=迁移时刻——取消矩阵/券价补偿两键 v1 正式固化）';
