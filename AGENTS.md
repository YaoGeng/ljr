# AGENTS.md — 律聚人（LJR）工作区指南

律聚人：AI 增强型法律服务交易平台 = **组团解决法律问题的多垂直平台**（专项=垂直方向，劳动仲裁为首发垂直——2026-10-17 决策人拍板，PRD §1.2；垂直×城市为复制双轮）。当前仓库 = **文档体系 + 静态 HTML 原型 + pnpm monorepo 产品代码骨架（M0 工程基建已就位）**。三端形态：App 用户端、App 律师端（双角色同 App）、Web 运营后台。

## 目录

```
docs/                    需求与设计的唯一事实源（改动代码/原型前先读对应文档）
  01-产品设计.md          PRD（定位口径 §1.2、业务规则 §6-§9、合规边界 §14、路线图 §13）
  02-架构设计.md          架构 v2.5（模块边界 §3、领域机制 §4、硬约束 §1.3、演进路径 §8）
  03-AI开发技能指南.md     技能选型与分阶段装载（§9.2）
  04-功能模块设计.md       42 模块总览 + 角色权限矩阵 + 待澄清点 §8（#21-24=V2+ 候选）
  05-开发计划与里程碑.md    里程碑与排期（M0 已收尾，M1 起逐模块施工）
  06-成本与回报测算.md      项目财务测算（成本/回报/ROI/回本时间；⚠ 假设参数制，试运行后回写）
  07-部署方案与云资源成本.md  部署分档与云账单（V1 初期 ¥700-1000/月）+ 三方服务接入盘点
  08-商业计划书BP.md       融资底稿（八问结构、拍板位 §12 D-BP1-8 已落账）
  modules/<域>/<ID>-*.md  每模块施工规格：DDL、接口契约、事件、R-xx 规则、验收清单
prototype/               单文件全量 UI 原型 v4.0（index.html 内嵌 CSS/JS，三端 SPA 共 37 视图；说明 README.md）
  tools/check.js          原型完整性检查（断链/外链/UTF-8/结构）
services/core            NestJS 单体 @ljr/core（M0 基座就位：config/观测/outbox+状态机+demo 样板；13 schema/14 role 已在 V1 落库，**业务模块自 M1 才落位**=docs/02 §3.2；vitest；子目录另有 AGENTS.md）
services/{rtc-im,agent-assist,payment-gateway}  独立服务空壳（实现栈随各自施工定）
apps/app（Expo/RN）  apps/admin（React/Vite）  packages/shared（类型+事件契约，bun test）
scripts/db               portable PG15/Flyway 本地栈（start/stop/migrate/validate/reset）
scripts/                 check-schema-refs（跨 schema 静态检查）、sandbox/（隔离首跑）、backup/（basebackup/WAL 归档/PITR）等
config/                  分环境 app.env（dev/staging/prod）；密钥禁入文件层，优先级=进程 env > config/<LJR_ENV>/app.env > 代码默认
skills/                  技能唯一事实源（vendor P0 六件套 + lj-* 自建五件 + manifest.json）
docs/plans/              M0 全套报告（执行/复审/技能验收/隔离演练/供应商选型/环境与观测说明）；docs/decisions/ ADR-0001/0002
```

## 常用命令

- 原型完整性检查：`cd prototype && node tools/check.js`（校验全部 HTML：断链/外链/UTF-8/闭合标签）
- **Monorepo 常用命令（仓库根）**：`pnpm lint`（ESLint9+Prettier）· `pnpm typecheck` · `pnpm -r build` · `pnpm -r test`（core=vitest 连真实 PG，其余=bun test）· `node scripts/check-schema-refs.mjs`（跨 schema 静态检查）· `bun test scripts/`（脚本自测）
- **本地数据库（portable 双轨，Ruling-6：本机无 docker）**：`node scripts/db/start.mjs` → `node scripts/db/migrate.mjs`（Flyway 13.10.0，工具在 .tools/ 勿提交；默认端口 **5435**=LJR_PG_PORT）；`reset.mjs`=drop schema 整库重放。docker 轨 compose 在 docker/dev/（纯 infra 观测栈，不含 core），真跑待 docker 环境
- **顺序敏感**：本机 typecheck/test core 前先 `pnpm --filter @ljr/shared build`（@ljr/shared 源外消费、dist 不入库）；core 测试连真实 PG、不自动起库。CI 六 job 并行，该构建序被 `scripts/check-ci-workflow.test.mjs` 断言锁定（改 .github/workflows/ci.yml 先读它）
- 已定技术栈（ADR-0001/0002）：App=Expo（RN）；后端=NestJS（TS）+ PostgreSQL 15；**迁移=Flyway 社区版（用户已拍板）**，SQL-first，down 演练=整库重放口径。**测试运行器**：services/core=vitest，app/admin/shared 与 Node 脚本=bun test，全仓不混用
- 环境：本机 Python 是 WindowsApps 占位 stub 不可用，脚本一律用 Node（v24）；**本机无 Docker/WSL 发行版**（compose 只交付不本机跑）；node/pnpm/bun = v24.6.0/12.11.2/1.3.13

## 开发工作约定（用户 2026-10-14 指示）

- **待澄清项**：执行时提问；AI 可自主给出推荐决策并按默认值开工（标 ⚠ 决策位），需拍板项集中列出一次性问；仅重大/不可逆（资金/证照/对外发布）才阻塞等待
- **外部对接后置**：应用开发完成、本地跑通之前不对接外部服务（支付通道/ICP-EDI 证照/RTC 开通/LLM 商务）——开发期一律 mock/适配器/通道模拟器，不催办用户办证申请
- **模型 apikey**：开发需要真实 LLM 时提问，用户提供 url+apikey；凭据只经 env 注入（.secrets/），源码/测试/文档禁出现可用凭据字面量；出站请求仅 http/https 且校验拒绝环回/私网 host
- **调度器**：弃用 XXL-Job（Java 系），TS 平替=自研轻量调度器（NestJS interval 轮询 + schedule_jobs 表 + SKIP LOCKED，ADR-0003）；机制仍为 DB 到期任务表事实源 + 锚定约定开始时刻

## 架构硬约束（改代码/设计前必读对应文档）

- **模块化单体 + 三个独立服务**（RTC/IM、AI agent-assist、支付网关），共库分域 schema。一个功能模块只写一个架构 schema 的表；跨模块取数走接口或事件，发现要跨表 join 即停下在 PR 提出
- **金额一律 NUMERIC(12,2) 禁 float；时间一律 timestamptz（Asia/Shanghai）；状态字段禁裸写**（须经状态机守卫 + 迁移日志）
- 资金不过平台账户（持牌机构分账）；律师费入律所对公账户；**生产支付通道禁止封装为 agent 可调用工具**
- Agent 输出永不直接进入房间公屏，必须经律师审查（草稿管线与消息发送物理隔离）；用户原文进 LLM 前必须过实时脱敏层
- 调度以 DB 到期任务表为事实源；宽限期/缺席判定锚定**约定开始时刻**
- PRD/架构未定义的行为不得自行发明 → 列入 docs/04 §8 待澄清点
- 五条产线纪律：TDD 先行（每条 R-xx 规则至少 1 用例）· 完成必须附测试/构建证据 · payment/settlement/信用 变更必须交叉审查 · 边界纪律 · 完成前验证（verification-before-completion）

## 原型（prototype/）约定

- **形态**：单文件 SPA——`index.html` 内嵌全部 CSS/JS，`VIEWS` 视图注册表 + `go()` 路由承载三端 36 业务视图 + hub 导航（用户端 12 / 律师端 11 / 后台 13）；顶栏 seg 切端，App 端渲染 390 宽手机框（tabbar），后台渲染 sidebar 布局；数据为内置虚构 Mock（`DB` 对象跨端共享，操作即改内存状态并重渲染）；图表为运行时生成 SVG，图标为内置细线库
- 设计体系 v4.0「人民币双色系 · 玻璃拟态 · 简约」（2026-10-14 重构，输入=PRD/功能模块；演进：墨蓝契约印章 → v2.0 薄荷绿 → v3.0 纸币绿多页 → v4.0 单文件）：**一元纸币橄榄绿为主色（约 90% 面积）**：底 `#F4F6F1`、主色 `#3E5C3A`、苔绿 `#6B8E5A`/浅灰绿 `#A8B89B`、文字 `#2C3E28`/`#7A8B74`、高光 `#C9D6C0`；**点缀=百元纸币豆沙红 `#C25E5E` 仅极小面积**：单张焦点卡（一组仅 1 张）/ 价格数字 / 主按钮 / 危险超阈状态 / 图表焦点数据条，严禁大面积铺色与红绿五五开；玻璃卡 `rgba(255,255,255,.5)`+blur(20px)+1px 半透明白边+16px 圆角，点缀卡 `rgba(194,94,94,.15)`；背景橄榄绿光晕漂浮 + 角落极少量红晕；系统无衬线字体，全页无深色
- 禁止外链资源（CDN/字体/图标库/图片）；交互为原生 JS（弹层/Toast/抽屉/底部面板/表单校验均内嵌）
- 样例数据为虚构且跨端共享（律师张明远/李慧敏/王振宇/陈晓薇，用户周女士）；**多时点叙事**：浏览/配置类视图锚定 10-13，房间直播（u-room/l-room）与后台监控（a-monitor）锚定 10-16 周五 20:32 同刻（S-2041）——改场次状态/时间先读 prototype/README.md「多时点叙事」，避免跨屏矛盾
- 新增/修改页面后必须跑 `node tools/check.js`；改内嵌 JS 建议提取 `<script>` 后 `node --check` 语法校验

## 敏感区前置阅读

- 动钱/支付/结算/退款 → docs/modules/F-资金/* + 架构 §4.4（先读 F1）
- 履约/缺席/取消/房间 → docs/modules/D-履约/*（规则在 PRD §8）
- 改价/价格快照 → PRD §8.2 + docs/modules/C-交易/C6-改价与补偿.md（三档=信用 -5/-15/-30，补偿=（原-新）×支付金额占比）
- 合规/隐私/训练授权 → 架构 §5.2 + docs/modules/H-运营后台/H9

## Git

- 分支 main，远程 origin = github.com/YaoGeng/ljr.git
- 提交风格：中文 conventional 前缀（`docs:` / `feat:` / `fix:`），正文列要点与证据
