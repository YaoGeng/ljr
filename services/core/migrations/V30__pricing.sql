-- M1-W3 V30：pricing 模块（C6 改价与补偿·评审修复轮 R-W3-Q②）——幂等键对齐 §5 的 PENDING 面索引
--
-- 施工规格：docs/modules/C-交易/C6-改价与补偿.md §5（「幂等键=lawyer+new_version」）+
-- task-9 评审台账 R-W3-Q②。V29 已 apply 冻结（禁改），本索引改动走新迁移。
--
-- 语义（评审裁定）：
--   ux_pricing_histories_lawyer_newver_effected（V29 既有，EFFECTED 面）：一个版本号在该律师
--   名下至多生效一次——不变。
--   ux_pricing_histories_lawyer_newver_pending（本迁移，PENDING 面）：同一 (lawyer,new_version)
--   至多一行待审请求。同键同草案重复提交=幂等重放原行（应用侧比对 new_version_draft 全等后
--   返回既有 history_id，不落新行）；同键异草案=409 显性拒绝（应用侧，索引兜底并发）。
--   REJECTED 不入本索引=否决即释放槽位（同号可再发起）。
--
-- 注意：flyway.conf defaultSchema=flyway —— 全限定 pricing.<table>。
-- 幂等性：IF NOT EXISTS，reset 整库重放可重复执行。

CREATE UNIQUE INDEX IF NOT EXISTS ux_pricing_histories_lawyer_newver_pending
    ON pricing.pricing_histories (lawyer_id, new_version) WHERE result = 'PENDING_APPROVAL';
