# config/ —— 三环境非敏感配置骨架（M0-8）

## 结构与装载

```
config/
  dev/app.env       dev 默认值（与代码默认同值，显式化可入库面）
  staging/app.env   staging 骨架（A3：部署后移 M1，当前为结构性占位）
  prod/app.env      prod 骨架（结构性占位）
  README.md         本文件（入库边界与 secrets 规范）
```

装载链路（`services/core/src/config/app.config.ts`，@nestjs/config 承载）：

**优先级：进程 env >（dev 专属：`.secrets/dev.env` 凭据键白名单）> `config/<LJR_ENV>/app.env` > 代码默认值**

| 层           | 来源                             | 内容边界                                    | 示例                                                |
| ------------ | -------------------------------- | ------------------------------------------- | --------------------------------------------------- |
| env（最高）  | 进程环境 / CI / 部署平台 secrets | 任意键，**密钥唯一合法通路**                | `LJR_PG_PASSWORD`、`PORT`、CI 的 `LJR_PG_PORT=5432` |
| 文件         | `config/<LJR_ENV>/app.env`       | **仅非敏感默认值**（地址/端口/库名/账号名） | `LJR_PG_HOST=127.0.0.1`                             |
| 默认（兜底） | `app.config.ts` 代码内           | dev 便携轨口径                              | `LJR_PG_PORT` 缺省 5435                             |

环境选择：`LJR_ENV`（仅可经进程 env 指定，缺省 `dev`；取值 dev/staging/prod 之外启动即失败）。

## 何者可入库、何者必须 env 注入

- **可入库**：连接地址、端口、库名、账号名（非口令）、特性开关等非敏感默认值——即各 `app.env` 现有内容。
- **必须 env 注入（禁入文件/代码/skill）**：
  - `LJR_PG_PASSWORD`、`LJR_REDIS_PASSWORD`（数据库/缓存口令）
  - `LJR_IDENTITY_PHONE_DATA_KEY`、`LJR_IDENTITY_PHONE_BLIND_PEPPER`、`LJR_AUTH_JWT_SECRET`（A1 身份密钥，M1-W2；dev 缺省走 dev-only 派生默认——非生产强度仅限本机便携轨，staging/prod 缺失即 `E_CONFIG_MISSING`）
  - 后续接入时的 `LJR_NACOS_AUTH_ADMIN_TOKEN`、LLM API Key、支付通道密钥等一切凭据
  - `LJR_ENV` 本身（环境选择是部署动作，不是仓库内容）
- **机器强制**（非口头约定）：
  1. `ENV_ONLY_KEYS`（`app.config.ts`）中的键出现在任何 `app.env` → 启动抛 `E_CONFIG_INVALID`；
  2. 任何环境缺 `LJR_PG_PASSWORD` → 启动抛 `E_CONFIG_MISSING`（fail-fast；dev 由 start.mjs 生成的 `.secrets/dev.env` 兜住）；
  3. CI gitleaks 全历史扫描兜底（`.gitleaks.toml`，豁免面只精确到两条 `.env.example` 路径）。

> 命名提示：本目录文件叫 `app.env`（非 `.env*`）——`.gitignore` 的 `.env.*` 规则不吞它，
> 它本身就是「确认非敏感、可入库」的默认值文件；真实凭据目录是 `.secrets/`（已 gitignore）。

## secrets 注入路径（与既有约定衔接）

- **dev（docker 轨）**：`docker/dev/.env.example` 复制为 `docker/dev/.env`（gitignore）→ `docker compose --env-file` 注入；dev 占位口令 `ljr-dev-only` 仅限本机。
- **dev（portable 轨）**：`node scripts/db/start.mjs` 首跑生成随机口令写入 `.secrets/dev.env`（进程 env `LJR_PG_PASSWORD` 可覆盖）；core 装载层在 dev 分支从该文件补凭据键（白名单 `LJR_PG_PASSWORD`/`LJR_REDIS_PASSWORD`，见 `app.config.ts` 的 `withDevSecrets`）。
- **本机真实凭据**：`.secrets/`（见 `.secrets/README.md`；对 git 与 agent/容器均不可见）；注入走 env 文件 + 进程环境，禁命令行参数（argv 对同机进程可见）。
- **CI**：GitHub Actions secrets，不落盘（现有 workflow 尚未引用任何 secrets，属有意）。
- **staging/prod**：部署平台密钥服务（架构 §5.2 KMS 口径）；staging 起接 Nacos 后，Nacos 侧访问凭据同样只走平台 secrets。

## 环境形态登记（A3 降级口径）

- 本机无 Docker（Ruling-6）：`docker/dev/docker-compose.yml` 的 redis/RocketMQ/Nacos 扩展以
  「结构断言测试」（`scripts/check-compose.test.mjs`）锁定，**待 docker 环境补全栈演练**。
- **staging 部署骨架应用后移 M1**（用户 2026-10-13 确认暂无云资源）：`staging/app.env` 为占位，
  正式回写 docs/05 由 M0 收尾（T10）统一做；风险与缓解见 `docs/plans/M0-8-环境与配置说明.md §6`。
- Nacos 接入时点：**staging 起**（dev 不接 nacos-sdk，`ConfigProvider` 接口已留实现位）。
