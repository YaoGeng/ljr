-- M2-W2 V45：ops 模块追加（H5 风控与敏感词管理·人审闭环切片，T7）——risk_records 处置留痕列
--
-- 施工规格：docs/modules/H-运营后台/H5-风控与敏感词管理.md（§4 人审流程「队列→处置→审计」/
-- §5 POST /admin/risk/records/{id}/review 409 DONE）+ docs/plans/M2-W2-执行计划.md T7 行。
-- schema ops / role ljr_ops 已由 V1 建好（禁增删 schema/role，本文件不触碰）。
--
-- **迁移号占用标注（T8 顺延）**：附录 A.3 原排 H4=V44__ops，实况 V44 已被 F4 comp_snapshots
-- （#39 收口）占用，本文件取 V45 ⇒ T8 H4 顺延 V46__ops（周批 DoD flyway validate 至 V1~V46）。
--
-- 增列两根（控制者裁定列集，处置留痕语义）：
--   verdict varchar(16) NULL
--     CHECK IN ('CONFIRM_BLOCK','FALSE_POSITIVE','MARK_ONLY')——人审处置结论（§4 处置三分支：
--     确认拦截误放 / 误拦 / 纯标记）。**为什么不是 action 列复用**：action=判定时词级处置
--     （BLOCK/REVIEW/MARK，机审事实，V8 契约），verdict=人审结论（处置事实）——两者是判定与
--     复审两个时点的事实，复用会覆盖机审审计锚（word_hits 行内 action 字段的行级对应物），故分行。
--   reviewed_note varchar(500) NULL——处置备注（≤500 上限与列宽同源；空=未留备注合法）。
--   NULL 语义：verdict/reviewed_note 与 reviewed_by/reviewed_at（V8 已建）同为「待审」标记——
--   人审队列扫描面 = reviewed_at IS NULL（ix_risk_records_open 既有，零索引变更）。
--
-- 无新表：table-manifest 清单零变化（重跑生成器应无 diff）；TEST_DB_TABLES 清单不动
-- （ops.risk_records 既有）。
-- 幂等性：reset 演练（drop schema 后整库重放 V1→V45）可重复执行——V8 先建原表、本文件后补
-- 列，重放一次到达目标态（ALTER 类迁移同 V31/V33 口径）。

-- ---------- ops.risk_records：人审处置留痕列（§4 处置→审计；回填面=risk-review.service） ----------
ALTER TABLE ops.risk_records
    ADD COLUMN verdict varchar(16) NULL;

ALTER TABLE ops.risk_records
    ADD COLUMN reviewed_note varchar(500) NULL;

ALTER TABLE ops.risk_records
    ADD CONSTRAINT ck_risk_records_verdict
        CHECK (verdict IN ('CONFIRM_BLOCK', 'FALSE_POSITIVE', 'MARK_ONLY'));

COMMENT ON COLUMN ops.risk_records.verdict IS '人审处置结论（M2-W2 T7）：CONFIRM_BLOCK=确认拦截误放（补拦截 V1 边界=风险记录确认态，消息本体不改）/ FALSE_POSITIVE=误拦（通知位=notify 直发桩）/ MARK_ONLY=纯标记；NULL=待审（与 reviewed_at 同判）';
COMMENT ON COLUMN ops.risk_records.reviewed_note IS '人审处置备注（M2-W2 T7）：admin 自由文本 ≤500，应用层校验不静默截断；NULL=未留备注';

-- 权限：无新表/新序列，授权面不变（列级权限随表，M0 占位口径同 V33/V38）
