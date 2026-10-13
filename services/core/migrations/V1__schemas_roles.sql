-- M0-3 V1：13 业务 schema + 13 DB role 脚手架（模块化单体的 DB 边界强制，架构 §2.1 / §3.2）
--
-- 事实源：docs/02-架构设计.md §3.2 模块边界表（13 模块 = 13 schema + 13 DB role，逐项对应）。
-- 本文件不得增删 schema：模块增删属架构变更，须先改架构文档再新增迁移（ADR 流程）。
--
-- 命名与权限口径：
--   * role = ljr_<schema>；NOLOGIN 占位——后续各模块施工迁移按服务开通 LOGIN（口令经 env 注入）
--     并授予表级最小权限，本迁移只给 CONNECT + USAGE（M0 最小权限口径）。
--   * 每个业务 schema：REVOKE PUBLIC（默认 PUBLIC 对新 schema 有 USAGE，收回以落实
--     「禁止跨模块直连他域表」）；再仅对本模块 role 授 USAGE；schema 归属迁移账号（表级授权后续按需）。
--   * 每模块 role 的 search_path 定位到本模块 schema（连接即落位，避免误写 public）。
--
-- 偏离声明（唯一一处）：架构 §3.2 模块名 agent-assist 含连字符，PG 非引定界符不允许连字符，
--   schema/role 归一化为 agent_assist / ljr_agent_assist（详见 task-2 报告「有意偏离」节）。
--
-- 幂等性：CREATE ROLE 无 IF NOT EXISTS（PG15），用 DO 守卫；其余语句天然幂等
--（reset 演练 drop schema 重放时 role 仍存在，本文件必须可重复执行）。
-- PG15 起 public schema 默认已无 PUBLIC CREATE 权限，无需额外收紧。

-- ---------- 13 个业务 role（ljr_<schema>，NOLOGIN 占位） ----------
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ljr_identity') THEN
        EXECUTE 'CREATE ROLE ljr_identity NOLOGIN';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ljr_schedule') THEN
        EXECUTE 'CREATE ROLE ljr_schedule NOLOGIN';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ljr_pricing') THEN
        EXECUTE 'CREATE ROLE ljr_pricing NOLOGIN';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ljr_trade') THEN
        EXECUTE 'CREATE ROLE ljr_trade NOLOGIN';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ljr_fulfillment') THEN
        EXECUTE 'CREATE ROLE ljr_fulfillment NOLOGIN';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ljr_payment') THEN
        EXECUTE 'CREATE ROLE ljr_payment NOLOGIN';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ljr_settlement') THEN
        EXECUTE 'CREATE ROLE ljr_settlement NOLOGIN';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ljr_credit') THEN
        EXECUTE 'CREATE ROLE ljr_credit NOLOGIN';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ljr_review') THEN
        EXECUTE 'CREATE ROLE ljr_review NOLOGIN';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ljr_notify') THEN
        EXECUTE 'CREATE ROLE ljr_notify NOLOGIN';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ljr_benefits') THEN
        EXECUTE 'CREATE ROLE ljr_benefits NOLOGIN';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ljr_agent_assist') THEN
        EXECUTE 'CREATE ROLE ljr_agent_assist NOLOGIN';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ljr_ops') THEN
        EXECUTE 'CREATE ROLE ljr_ops NOLOGIN';
    END IF;
END
$$;

-- ---------- CONNECT（对当前库授权，环境无关：库名取 current_database()，勿再硬编码） ----------
DO $$
BEGIN
    EXECUTE format(
        'GRANT CONNECT ON DATABASE %I TO ljr_identity, ljr_schedule, ljr_pricing, ljr_trade, ljr_fulfillment, ljr_payment, ljr_settlement, ljr_credit, ljr_review, ljr_notify, ljr_benefits, ljr_agent_assist, ljr_ops',
        current_database()
    );
END
$$;

-- ---------- 13 个业务 schema：CREATE + 收回 PUBLIC + 授本模块 USAGE + role 落位 search_path ----------
-- identity：注册登录、双角色切换、实名认证、律师资质审核流、账号注销状态机（§3.2）
CREATE SCHEMA IF NOT EXISTS identity;
REVOKE ALL ON SCHEMA identity FROM PUBLIC;
GRANT USAGE ON SCHEMA identity TO ljr_identity;
ALTER ROLE ljr_identity SET search_path TO identity;
COMMENT ON SCHEMA identity IS '架构§3.2 identity：注册登录/双角色/实名/资质审核/注销状态机';

-- schedule：律师时间表（周模板）、单场时长、时间段占用锁（§3.2）
CREATE SCHEMA IF NOT EXISTS schedule;
REVOKE ALL ON SCHEMA schedule FROM PUBLIC;
GRANT USAGE ON SCHEMA schedule TO ljr_schedule;
ALTER ROLE ljr_schedule SET search_path TO schedule;
COMMENT ON SCHEMA schedule IS '架构§3.2 schedule：时间表模板/时间段占用锁';

-- pricing：默认价格配置与版本、改价规则引擎、补偿触发、规则版本化（§3.2）
CREATE SCHEMA IF NOT EXISTS pricing;
REVOKE ALL ON SCHEMA pricing FROM PUBLIC;
GRANT USAGE ON SCHEMA pricing TO ljr_pricing;
ALTER ROLE ljr_pricing SET search_path TO pricing;
COMMENT ON SCHEMA pricing IS '架构§3.2 pricing：价格配置版本/改价规则引擎/规则版本化';

-- trade：B2C 开团、C2B 拼团、报名、成团/流标状态机、价格快照、改期（§3.2）
CREATE SCHEMA IF NOT EXISTS trade;
REVOKE ALL ON SCHEMA trade FROM PUBLIC;
GRANT USAGE ON SCHEMA trade TO ljr_trade;
ALTER ROLE ljr_trade SET search_path TO trade;
COMMENT ON SCHEMA trade IS '架构§3.2 trade：开团/拼团/报名/成团流标状态机/价格快照/改期';

-- fulfillment：房间生命周期、提醒、宽限、到场/缺席判定、取消/改期、会话模型、1对1（§3.2）
CREATE SCHEMA IF NOT EXISTS fulfillment;
REVOKE ALL ON SCHEMA fulfillment FROM PUBLIC;
GRANT USAGE ON SCHEMA fulfillment TO ljr_fulfillment;
ALTER ROLE ljr_fulfillment SET search_path TO fulfillment;
COMMENT ON SCHEMA fulfillment IS '架构§3.2 fulfillment：房间/提醒/宽限/到场缺席判定/取消改期/会话/1对1';

-- payment：支付下单、分账指令、冻结/解冻、退款、违约金扣划指令、对账、回调 Inbox（§3.2）
CREATE SCHEMA IF NOT EXISTS payment;
REVOKE ALL ON SCHEMA payment FROM PUBLIC;
GRANT USAGE ON SCHEMA payment TO ljr_payment;
ALTER ROLE ljr_payment SET search_path TO payment;
COMMENT ON SCHEMA payment IS '架构§3.2 payment：下单/分账/冻结解冻/退款/对账/回调Inbox';

-- settlement：履约完成后结算（缺席 70/30 分成）、违约金扣减、平台服务费、冻结期与 HOLD（§3.2）
CREATE SCHEMA IF NOT EXISTS settlement;
REVOKE ALL ON SCHEMA settlement FROM PUBLIC;
GRANT USAGE ON SCHEMA settlement TO ljr_settlement;
ALTER ROLE ljr_settlement SET search_path TO settlement;
COMMENT ON SCHEMA settlement IS '架构§3.2 settlement：结算/违约金扣减/服务费费率版本/冻结期HOLD';

-- credit：用户/律师信用分事件流、惩罚与限制；credit_accounts 唯一事实源（§3.2）
CREATE SCHEMA IF NOT EXISTS credit;
REVOKE ALL ON SCHEMA credit FROM PUBLIC;
GRANT USAGE ON SCHEMA credit TO ljr_credit;
ALTER ROLE ljr_credit SET search_path TO credit;
COMMENT ON SCHEMA credit IS '架构§3.2 credit：信用分事件流/惩罚限制/credit_accounts事实源';

-- review：互评、匿名评价（凭证分离存储）、信用联动、排序因子输出（§3.2）
CREATE SCHEMA IF NOT EXISTS review;
REVOKE ALL ON SCHEMA review FROM PUBLIC;
GRANT USAGE ON SCHEMA review TO ljr_review;
ALTER ROLE ljr_review SET search_path TO review;
COMMENT ON SCHEMA review IS '架构§3.2 review：互评/匿名评价凭证分离/信用联动';

-- notify：推送/SMS/站内信、提醒编排、房间内 Agent 同步提醒（双通道）（§3.2）
CREATE SCHEMA IF NOT EXISTS notify;
REVOKE ALL ON SCHEMA notify FROM PUBLIC;
GRANT USAGE ON SCHEMA notify TO ljr_notify;
ALTER ROLE ljr_notify SET search_path TO notify;
COMMENT ON SCHEMA notify IS '架构§3.2 notify：推送/SMS/站内信/提醒编排/Agent同步提醒';

-- benefits：平台积分、优惠券、积分兑付备付金台账（§3.2）
CREATE SCHEMA IF NOT EXISTS benefits;
REVOKE ALL ON SCHEMA benefits FROM PUBLIC;
GRANT USAGE ON SCHEMA benefits TO ljr_benefits;
ALTER ROLE ljr_benefits SET search_path TO benefits;
COMMENT ON SCHEMA benefits IS '架构§3.2 benefits：积分/优惠券/备付金台账';

-- agent_assist：实时脱敏层、草稿气泡、结构化问题标签、快捷回复、待办、RAG、专项配置包（§3.2，模块名 agent-assist）
CREATE SCHEMA IF NOT EXISTS agent_assist;
REVOKE ALL ON SCHEMA agent_assist FROM PUBLIC;
GRANT USAGE ON SCHEMA agent_assist TO ljr_agent_assist;
ALTER ROLE ljr_agent_assist SET search_path TO agent_assist;
COMMENT ON SCHEMA agent_assist IS '架构§3.2 agent-assist：脱敏层/草稿气泡/快捷回复/RAG/专项配置（模块名归一化去连字符）';

-- ops：运营后台 BFF：审核、监控、工单、退款审核、风控人审闭环、撮合台、规则中心、PIA 台账（§3.2）
CREATE SCHEMA IF NOT EXISTS ops;
REVOKE ALL ON SCHEMA ops FROM PUBLIC;
GRANT USAGE ON SCHEMA ops TO ljr_ops;
ALTER ROLE ljr_ops SET search_path TO ops;
COMMENT ON SCHEMA ops IS '架构§3.2 ops：审核/监控/工单/风控人审/撮合台/规则中心/PIA台账';
