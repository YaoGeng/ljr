import { Module } from '@nestjs/common';
import { AppConfigModule } from './config/config.module';
import { ObservabilityModule } from './observability/observability.module';
import { InfrastructureModule } from './infrastructure/infrastructure.module';
import { DemoModule } from './modules/demo/demo.module';
import { IdentityModule } from './modules/identity/identity.module';
import { RealnameConsentModule } from './modules/identity/realname-consent.module';
import { LawyerQualificationModule } from './modules/identity/lawyer-qualification.module';
import { NotifyModule } from './modules/notify/notify.module';
import { SchedulerModule } from './modules/schedule/scheduler.module';
import { SlotLockModule } from './modules/schedule/slot-lock.module';
import { TimeTableModule } from './modules/schedule/time-table.module';
import { PricingConfigModule } from './modules/pricing/pricing.module';
import { PricingChangeModule } from './modules/pricing/price-change.module';
import { CreditModule } from './modules/credit/credit.module';
import { RuleCenterModule } from './modules/ops/rule-center.module';
import { WordDictModule } from './modules/ops/word-dict.module';
import { LawyerAdminModule } from './modules/ops/lawyer-admin.module';
import { SpecialtyKnowledgeModule } from './modules/agent-assist/specialty.module';
import { SanitizeModule } from './modules/agent-assist/sanitize.module';
import { DraftModule } from './modules/agent-assist/draft.module';
import { PaymentModule } from './modules/payment/payment.module';
import { BenefitsModule } from './modules/benefits/points.module';
import { BenefitsConsumersModule } from './modules/benefits/absence.consumer';
import { TradeModule } from './modules/trade/trade.module';
import { FulfillmentModule } from './modules/fulfillment/fulfillment.module';
import { ReminderModule } from './modules/notify/reminder.module';
import { SettlementModule } from './modules/settlement/settlement.module';
import { PatrolModule } from './modules/ops/patrol.module';
import { TicketModule } from './modules/ops/ticket.module';
import { MetricsModule } from './modules/ops/metrics.module';
import { ArtifactsModule } from './infrastructure/artifacts/artifacts.module';
import { HealthController } from './health.controller';

// ObservabilityModule 紧随配置之后：http/pg 插桩先于 Infrastructure/Demo 建池注册
//（pg 插桩按 prototype patch，后建池同样生效；前置仅为装配序清晰）。
@Module({
  imports: [
    AppConfigModule,
    ObservabilityModule,
    InfrastructureModule,
    DemoModule,
    IdentityModule, // A1 注册登录与双角色（identity schema owner，M1-W2 Task 1；消费 NotifyModule 限频器）
    RealnameConsentModule, // A2 实名认证与同意管理（identity schema owner，M1-W2 Task 2；R-01 闸口查询面待 W3 C3/F1 消费）
    LawyerQualificationModule, // A3a 律师资质审核（identity schema owner，M1-W2 Task 3；R-01 isAuditPassed 待 W3 C3/接单大厅消费）
    NotifyModule,
    SchedulerModule,
    SlotLockModule, // B2 时间段占用锁（与 I2 同 schedule schema owner，M1-W1 Task 3）
    TimeTableModule, // B1 时间表管理（与 I2/B2 同 schedule schema owner，M1-W2 Task 4；消费 B2 Slot* 事件失效视图缓存）
    PricingConfigModule, // B3 默认价格与1对1价格配置（pricing schema owner，M1-W2 Task 5；版本化配置 R-03 只 INSERT，在团转 C6 适配位 R-W2-9）
    CreditModule, // G1 信用体系（credit schema owner，M1-W2 Task 6；不可变流水+规则表驱动限制令，入口拦截查询面待 W3 C1/C3 消费）
    RuleCenterModule, // H7 规则中心（ops schema owner，M1-W1 Task 4）
    WordDictModule, // H5 风控词库切片（ops schema owner，M1-W1 Task 5；人审闭环 M2-W2）
    LawyerAdminModule, // H1 律师与资质管理（ops schema owner，M1-W3 Task 10 压轴；W2 终审 G-A 前置门关闭承载面：/admin/lawyers @RequireRole('admin')+auditor_id 回填+ops 域审计表同事务审计；A3a 的 admin 占位控制器退役，契约归 A3a、HTTP 面归 ops）
    SpecialtyKnowledgeModule, // E3 专项配置与知识库基建（agent_assist schema owner，M1-W1 Task 6；E1 Task 7 同目录追加）
    SanitizeModule, // E1 实时脱敏层切片（agent_assist schema owner，M1-W1 Task 7；草稿管线接线 M2-W3）
    DraftModule, // E1 Agent 草稿气泡管线（agent_assist schema owner，M2-W3 T4：MessageSent 消费→脱敏→硬拦→意图→RAG→mock LLM→气泡（publishTo 仅律师）→三动作（sendMessage 律师链路=R-01 唯一发送路径）；V48 两表
    PaymentModule, // F1 支付网关与回调 Inbox（payment schema owner，M1-W3 Task 1；指令面+回调验签+Inbox+对账；下游 C3=T7/H3=M2 接线）+ A3b 律所进件子域（M1-W3 Task 3：firm_merchants 状态机/R-01 查询面/FIRM_REVERIFY/保证金指令台账；下游 F3=T8/T10 H1 消费 FirmMerchantService）
    BenefitsModule, // F4 权益①切片（benefits schema owner，M1-W3 Task 2；积分账户/冻结核销解冻/退款还原/过期双路径；下游 C3=T7/F2=T6 消费 PointsService，券/备付=M2-W2 ②全量）
    BenefitsConsumersModule, // F4 ②全量 AttendanceAdjudicated 分成消费装配（M2-W2 T6：paid 聚合经 payment 导出面——PaymentModule imports BenefitsModule 反向即环，故平级装配；文件级无环，见 absence.consumer.ts 头注）
    TradeModule, // C1 B2C 开团（trade schema owner，M1-W3 Task 4；开团事务=B2 加锁+INSERT 同事务、幂等键=lawyer+slot_start、ENROLL_DEADLINE 流标执行器、session 终态 provider；下游 C3=T7 消费 markFull/SessionFull、F2=T6 消费 SessionFailed）
    FulfillmentModule, // D1 房间生命周期 + D5 会话与消息（fulfillment schema owner，M2-W1 T1/T3：ROOM_OPEN/GRACE_END 执行器+grace_end 锚定+close API；T3 追加 conversations/messages/consent_records 统一模型+WSS 网关（core 单进程，/ws）+发送链（checkRisk 同步判定→BLOCKED 拒→单事务持久化+广播）+录制 consent 双门+撤回删除+OneOnOnePaid 桩+COLD_ARCHIVE 冷存；下游 D3/D4=F2=W2，D2=T4 经 ConversationService 写系统消息）
    ReminderModule, // D2 提醒服务（代码位=notify 域，M2-W1 T4：REMIND×4/REMIND_GRACE_END 执行器装配（NO_EXECUTOR 设计内噪音消失并验，04 §8 #33）+四档逐人 I1 通知+ReminderDispatched 出箱+房间内 @Agent 同步提醒（宽限开始=RoomOpened 消费/结束前 1min=REMIND_GRACE_END）+流标路径 REMIND×4 同事务作废钩；不建 notification_jobs（⚠W1-5，schedule_jobs 唯一事实源）；confirm-arrival=无持久化锚推迟 W2 与 D3 attendance 同批；改期重投=C5 W2）
    PricingChangeModule, // C6 改价与补偿（与 B3 同 pricing 域独立装配——TradeModule 依赖 B3，C6 消费 Trade 导出面，并入即环；M1-W3 Task 9：三档引擎/频率 DB 滑窗 ⚠W3-7/①人工兜底审批/24h 撤销/补偿 F4 真链+券指令/I1 三档话术真消费）
    SettlementModule, // F3 分账结算（settlement schema owner，M1-W3 Task 8；分账触发状态机 R-01 唯一解冻节点/HOLD 冻结期/违约扣减 R-04/缺席 70-30 R-03/进件前置 R-07；下游 H4/F4 备付/I1=M2 联调，G1 欠款消费位=M2）
    TicketModule, // H3 纠纷工单（ops schema owner，M2-W2 T1：tickets 七类/SLA 24h-48h 配置化/OPEN→PROCESSING→RESOLVED|REJECTED 守卫流转/ticket_actions 审计行；建单面=ReconciliationDiffFound+RefundFailed relay 消费+人工 API（幂等键=category+ref ⚠W2-9）；处置回调 pricing approve 真链（d4=W2 T3 接线位）；TICKET_RESOLVED 既有 topic 出箱（F3 HOLD 释放消费在位）；R-04 工单源=TicketGateRegistration 生产注册进 F3 闸（修复环 I-1：闸只认未结 dispute，I-2）
    PatrolModule, // H4 资损巡检首轮（ops schema owner，M1-W4 Task 1；架构 §7.2 五类不变量分钟级 RISK_PATROL job：检测 SQL 各域自持+ops 侧聚合，违例台账=patrol-findings 两表 dedup 入账；告警=供应商位 mock）
    MetricsModule, // H4 指标管道（ops schema owner，M2-W2 T8：V46 events_consumed 去重+metrics_daily 日表——事件流聚合「消费即聚合」无独立 T+1 job；20 源 topic relay 消费幂等 R-03；查询面 GET /admin/dashboard/metrics？group=core|health；巡检=PatrolModule 既有零改动）
    ArtifactsModule, // I3 文件与存证（横切基座非业务模块，⚠W1-4：platform schema owner+infrastructure/artifacts 代码位；M2-W1 T2：putArtifact 统一入口 hash 幂等+WORM/加密 bucket 策略+录音上链 mock+RETENTION_PURGE 日扫+/admin/artifacts 调取面双签门。平级挂本表的原因=Scheduler/IdentityAuth 均依赖 Infrastructure，并入基座即成环——见 artifacts.module 头注）
  ],
  controllers: [HealthController],
})
export class AppModule {}
