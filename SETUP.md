# AI 员工管理系统 - 设置指南

## 系统概述

这是一个基于 Web 的多会话 AI 员工管理面板，支持 **Claude CLI** 和 **GitHub Copilot CLI** 双后端。每个"员工"对应 `IdeaProjects` 目录下的一个项目，系统在对应项目目录中启动独立的 AI CLI 终端会话，通过 WebSocket 实时同步到前端界面。

## 多 Provider 支持

系统通过 **Provider 抽象层** 支持多种 AI CLI 后端，每个员工可独立配置使用哪个 Provider。

### 可用 Provider

| Provider | 命令 | 配置文件 | 会话恢复 | 说明 |
|----------|------|---------|---------|------|
| `claude`（默认） | `claude` | `CLAUDE.md` | `--resume <uuid>` | Anthropic Claude Code CLI |
| `copilot` | `copilot` | `COPILOT.md` | `--resume <uuid>` | GitHub Copilot CLI |
| `deepseek` | `claude` | `DEEPSEEK.md` | `--resume <uuid>` | Claude Code CLI + DeepSeek Anthropic 兼容 API |

DeepSeek Provider 使用官方推荐的 `https://api.deepseek.com/anthropic` 端点，并通过独立的运行时 settings 文件隔离认证配置，避免被用户级 Claude Code Token 覆盖。

管理面板支持为每个 DeepSeek 员工独立选择模型：

- `deepseek-v4-flash`
- `deepseek-v4-pro`
- `deepseek-v4-flash-vision-exp`

在线员工修改模型后会自动重启会话，并通过 `--model` 参数强制使用新模型。

### 配置方式

在 `config.json` 中为员工添加 `"provider"` 字段即可切换后端：

```json
{
  "id": "spark",
  "name": "Spark",
  "provider": "copilot",
  "cwd": "~/IdeaProjects/spark",
  ...
}
```

- 不设置 `provider` 字段时默认使用 `claude`（向后兼容）
- 不同 Provider 的员工可以同时运行
- 同一项目目录下的不同 Provider 员工互不冲突（各自写独立的配置文件）

### Provider 架构

```
providers/
  index.js      # Provider 工厂：根据员工配置返回对应 Provider
  claude.js     # Claude CLI 适配：命令、参数、resume 捕获、环境变量
  copilot.js    # Copilot CLI 适配：命令、参数、resume 捕获
  deepseek.js   # DeepSeek V4 适配：复用 Claude CLI，注入 DeepSeek API key/endpoint
```

每个 Provider 实现以下接口：

| 方法 | 说明 |
|------|------|
| `command` | CLI 命令名（`"claude"` / `"copilot"`） |
| `configFileName` | 项目配置文件名（`"CLAUDE.md"` / `"COPILOT.md"`） |
| `getArgs(employee, resumeId)` | 构建启动参数 |
| `captureResumeId(data)` | 从 PTY 输出捕获会话恢复 ID |
| `detectResumeFailed(data)` | 检测会话恢复失败 |
| `getSpawnEnv(baseEnv)` | 处理 Provider 特有的环境变量 |

### 扩展新 Provider

1. 在 `providers/` 下创建新文件（如 `gemini.js`）
2. 实现上述接口
3. 在 `providers/index.js` 中注册
4. 在 `config.json` 中使用 `"provider": "gemini"`

## 员工（项目）列表

| 员工 ID | 名称 | 对应项目目录 | 模式 | 职责描述 |
|---------|------|-------------|------|---------|
| `spark` | Spark ⚡ | `~/IdeaProjects/spark` | 单项目 | Apache Spark 开发专家，负责 Spark 核心引擎开发与优化 |
| `celeborn` | Celeborn 🌟 | `~/IdeaProjects/remoteshuffleservice` | 单项目 | Apache Celeborn (Remote Shuffle Service) 开发专家 |
| `shuffle-proxy` | Shuffle Proxy 🔀 | `~/IdeaProjects/shuffle-proxy` | 单项目 | Shuffle 代理层开发专家，负责代理层开发与调优 |
| `code-reviewer` | Code Reviewer 🔍 | 多项目（启动时选择） | 多项目 | 代码审查专家，负责跨项目代码质量把关与最佳实践推广 |
| `architect` | Architect 🏗️ | 多项目（启动时选择） | 多项目 | 架构设计专家，负责系统整体架构规划与技术方案评审 |

每个员工在启动时会读取对应目录下的代码内容，AI 会基于该项目的上下文进行工作。

### 多项目角色

Code Reviewer 和 Architect 属于跨项目角色（`cwdMode: "multi"`），启动时会弹出项目选择器，让用户选择要在哪个项目目录下工作。它们可以访问所有三个项目。

其中 Code Reviewer 还支持**系统自动审查**：当任一项目角色在其 PTY 会话中 `git push` 成功后，服务端会自动检测 push 输出，并向 Code Reviewer 会话注入一条 `[自动审查] ...` 任务消息，要求其对目标项目目录执行审查。也就是说，自动触发能力属于服务端编排，Code Reviewer 本身负责接收并执行该自动下发的审查任务。

### 性格配置

Code Reviewer 和 Architect 支持性格配置功能，可在"管理"面板中设置：

- **语气风格**：严格专业 / 导师引导 / 友好协作 / 简洁高效
- **审查风格**（仅 Code Reviewer）：逐行审查 / 整体概览 / 仅关键问题
- **关注领域**：可选择多个关注方向
- **补充指令**：自定义额外指令

保存后会自动在对应项目目录下生成/更新配置文件（`CLAUDE.md` 或 `COPILOT.md`，取决于员工的 Provider），该文件会真正影响 AI 的行为表现。

## 前端界面

前端采用**原神尘歌壶**风格设计，房间场景、家具和角色动画资源统一存放在 `public/img/`：

- **房间场景**：顶部展示一个温馨的小屋场景，每个员工以 Q 版小人（chibi）形象分布在房间中
  - 沙发、书架、窗户等家具装饰
  - 小人有待机动画（浮动、眨眼等）
  - 点击小人可选中对应员工
- **终端面板**：下方为 xterm.js 终端区域，显示选中员工的 AI 会话
- **侧边栏**：右侧/左侧展示员工列表、状态指示、技能标签等信息
- **交互**：
  - 可展开/收起房间场景
  - 支持启动/停止员工会话
  - 终端支持输入，可直接与对应项目的 AI 交互
  - 支持终端窗口 resize

## 技术架构

```
┌─────────────────────────────────────────────────────┐
│                   浏览器前端                          │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────┐ │
│  │  原神风格房间  │  │  xterm.js    │  │  员工面板   │ │
│  │  (Chibi 小人) │  │  终端显示     │  │  状态/技能  │ │
│  └──────┬───────┘  └──────┬───────┘  └─────┬──────┘ │
│         └──────────┬──────┘────────────────┘         │
│                    │ WebSocket                        │
└────────────────────┼────────────────────────────────┘
                     │
┌────────────────────┼────────────────────────────────┐
│              Node.js 服务端 (server.js)               │
│                    │                                  │
│    ┌───────────────┼───────────────┐                 │
│    │          WebSocket Server     │                 │
│    │    (会话路由 & 消息转发)        │                 │
│    └───────────────┬───────────────┘                 │
│                    │                                  │
│    ┌───────────────┼───────────────┐                 │
│    │    Provider 抽象层 (providers/)│                 │
│    │    ┌─────────┬─────────┐     │                 │
│    │    │ Claude  │ Copilot │ ... │                 │
│    │    └─────────┴─────────┘     │                 │
│    └───────────────┬───────────────┘                 │
│                    │                                  │
│    ┌───────────────┼───────────────┐                 │
│    │         node-pty 会话管理       │                 │
│    ├───────┬────────┬────────┬──────────┬──────────┤  │
│    │ Spark │Celeborn│Shuffle │  Code    │Architect │  │
│    │  PTY  │  PTY   │ Proxy  │ Reviewer │   PTY    │  │
│    │       │        │  PTY   │   PTY    │          │  │
│    └───┬───┴───┬────┴───┬───┴────┬─────┴────┬─────┘  │
│        │       │        │        │          │         │
└────────┼───────┼────────┼────────┼──────────┼────────┘
         │       │        │        │          │
         ▼       ▼        ▼        ▼          ▼
   ┌──────┐ ┌────────┐ ┌──────────┐  (动态选择项目)
   │spark/│ │remote- │ │shuffle-  │
   │      │ │shuffle │ │proxy/    │
   │      │ │service/│ │          │
   └──────┘ └────────┘ └──────────┘
   IdeaProjects 目录下的各项目
```

## 配置文件

员工配置位于 `config.json`，每个员工包含以下字段：

```json
{
  "id": "spark",
  "name": "Spark",
  "provider": "claude",
  "cwd": "~/IdeaProjects/spark",
  "description": "Apache Spark 开发专家，负责 Spark 核心引擎开发与优化",
  "color": "#E25A1C",
  "avatar": "⚡",
  "skills": ["Spark Core", "Spark SQL", "Catalyst Optimizer", "Shuffle", "Memory Management"]
}
```

多项目角色还包含额外字段：

```json
{
  "id": "code-reviewer",
  "name": "Code Reviewer",
  "cwd": "~/IdeaProjects",
  "cwdMode": "multi",
  "cwdList": [
    "~/IdeaProjects/spark",
    "~/IdeaProjects/remoteshuffleservice",
    "~/IdeaProjects/shuffle-proxy"
  ],
  "personality": {
    "tone": "strict",
    "focusAreas": ["安全性", "性能", "可读性", "错误处理"],
    "reviewStyle": "line-by-line",
    "language": "zh-CN"
  }
}
```

- **id**：唯一标识，用于 WebSocket 路由
- **name**：显示名称
- **provider**：AI CLI 后端，可选 `"claude"`（默认）或 `"copilot"`
- **cwd**：对应 IdeaProjects 下的项目路径，AI 会话将在此目录启动
- **cwdMode**：`"multi"` 表示多项目模式，启动时需选择项目目录
- **cwdList**：多项目模式下可选的项目目录列表
- **description**：员工职责描述
- **color**：主题色，用于前端 UI 区分
- **avatar**：Emoji 头像
- **skills**：技能标签列表

管理页面的 Skill 列表分为两类：

- **实际 Skill**：扫描 `~/.claude/skills/*/SKILL.md` 和 `~/.agents/skills/*/SKILL.md`，支持查看、新建和编辑内容。
- **内置 Skill**：由 Claude Code 内部提供，只读展示，不能通过文件编辑。

实际 Skill 文件操作被限制在上述两个目录内，Skill 名称只允许字母、数字、点、下划线和连字符。
- **personality**：性格配置，保存后会生成配置 MD 影响 AI 行为

## 可移植性与工作室扩展

### 当前可移植性

当前项目的可移植性属于**中等**：可以迁移到另一台 macOS 电脑运行，但还不是复制目录后即可零配置启动。系统主体、前端资源和员工配置都位于项目目录中，以下内容仍依赖具体用户和机器环境：

- `config.json` 中员工的 `cwd`、`cwdList`、查询文件等字段可能使用 `/Users/<用户名>/...` 绝对路径。
- `lib/config-md.js` 中仍存在部分固定项目路径和特殊角色映射。
- `data/cron-jobs.json` 的任务消息可能直接引用项目或输出目录的绝对路径。
- Claude Code、Copilot CLI、cc-connect、Node.js 和 `node-pty` 需要在新电脑重新安装或编译。
- `~/.claude/skills/`、`~/.agents/skills/` 和 `~/.cc-connect/` 位于项目目录之外，需要单独迁移或重新配置。
- macOS `launchd` 配置、完全磁盘访问权限和 Claude Code 的目录授权需要在新电脑重新设置。
- API Key、数据库连接和其他认证信息不能随代码公开分发，应在新电脑单独配置。

迁移到新电脑时，建议按以下顺序操作：

1. 安装 Node.js、目标 AI CLI，并执行 `npm install`。
2. 复制 `ai-employees` 项目和需要保留的业务项目。
3. 修改 `config.json` 中的本机项目路径、Provider 和认证配置。
4. 迁移需要保留的自定义 Skill；不要覆盖新电脑已有的同名 Skill。
5. 检查定时任务中的绝对路径、员工 ID 和外部服务地址。
6. 按需迁移 `data/resume-ids.json`、`data/history/` 和 `data/cron-jobs.json`；日志通常不必迁移。
7. 重新配置 macOS 权限、`launchd` 和 cc-connect，然后启动服务验证各角色。

### 当前可自定义范围

| 能力 | 当前方式 | 限制 |
|------|----------|------|
| 角色名称、头像、颜色和职责 | 修改 `config.json` | 页面暂不支持新增或删除角色 |
| 角色工作目录 | 配置 `cwd`、`cwdList` | 修改后通常需要重启服务 |
| AI Provider 和模型 | 按角色配置 | 不同 Provider 的历史会话不能互相恢复 |
| 员工能力标签 | 管理页面编辑 `skills` | 仅用于展示和能力描述 |
| 实际 Skill | 技能页面管理 `SKILL.md` | 当前为用户级共享，不属于某个工作室 |
| 性格和关注领域 | 管理页面或 `config.json` | 生成对应角色的配置 MD |
| 定时任务 | 定时任务页面配置 | 当前为全局任务列表，通过目标员工 ID 路由 |

目前可以通过手动编辑 `config.json` 增加角色，但应确保：

- `id` 全局唯一，并只使用稳定、便于 URL 和目录使用的标识。
- `cwd` 指向新电脑上真实存在且允许访问的目录。
- `provider` 已安装并完成认证。
- 角色引用的 Skill、外部命令和服务在新电脑可用。
- 修改后重启服务，使角色列表和动态生成的配置文件生效。

### “工作室”能力现状

当前系统采用单一 `employees` 列表，尚未提供正式的“工作室”一级数据模型。因此：

- 所有角色显示在同一个管理面板中。
- 实际 Skill 从用户目录统一扫描，所有工作室会共享同一套 Skill 文件。
- 定时任务保存在同一个全局列表中，只能绑定目标角色，不能直接绑定工作室。
- 角色之间的 `@提及` 路由默认基于全局员工列表生成。
- 页面尚不支持创建工作室、切换工作室或导入/导出工作室。

如果只是增加一组角色，可以先在 `config.json` 中增加多个员工，并通过命名或 `category` 进行区分；这属于配置层面的临时分组，不具备工作室级隔离能力。

### 推荐的工作室数据模型

后续可增加 `studios` 配置，将项目根目录、输出目录、成员和共享 Skill 收敛到工作室边界：

```json
{
  "studios": [
    {
      "id": "bigdata",
      "name": "大数据工作室",
      "projectRoot": "${HOME}/IdeaProjects",
      "outputRoot": "${HOME}/IdeaProjects/ai-output",
      "employees": ["spark", "celeborn", "architect"],
      "skills": ["spark-weekly-report"],
      "enabled": true
    }
  ],
  "employees": [
    {
      "id": "celeborn",
      "studioId": "bigdata",
      "name": "Celeborn",
      "cwd": "${PROJECT_ROOT}/remoteshuffleservice",
      "provider": "claude",
      "skills": ["celeborn-agent"]
    }
  ]
}
```

完整的工作室能力建议包括：

1. 工作室新增、编辑、删除、启停和页面切换。
2. 角色新增、复制、编辑、移动和删除。
3. 全局、工作室共享、角色专属三级 Skill 作用域。
4. 定时任务增加 `studioId`，并支持绑定工作室或具体角色。
5. 使用 `${HOME}`、`${PROJECT_ROOT}`、`${OUTPUT_ROOT}` 等变量替代用户名绝对路径。
6. 将 API Key、数据库密码等敏感配置迁移到 `.env` 或独立密钥文件。
7. 支持工作室配置导入、导出，并在导入时重新映射本机路径。

完成上述改造后，目标迁移流程可以简化为：复制程序、导入工作室配置、选择本机项目根目录、配置认证信息并启动服务。

## 持久记忆

系统支持服务重启后自动恢复 AI 对话上下文，并可查看历史对话记录。

### 数据存储结构

```
data/
  resume-ids.json              # { "spark": "uuid", "celeborn": "uuid", ... }
  logs/
    spark/
      2026-03-06.log           # 按天分割，含原始 ANSI 码
    celeborn/
      2026-03-06.log
    ...（每个员工独立目录）
```

### Resume ID 持久化

- 每次 AI CLI 输出 `<command> --resume <uuid>` 时，由对应 Provider 自动捕获并写入 `data/resume-ids.json`
- 服务启动时从文件加载所有 resume ID 到内存
- 服务退出（SIGINT）时保存当前状态
- 启动员工会话时自动带 `--resume` 参数恢复上次对话

### 对话日志

- PTY 输出实时追加到 `data/logs/{employeeId}/{YYYY-MM-DD}.log`
- 每次会话启动时写入分隔标记（含时间戳和 resume ID）
- 服务启动时处理超过 7 天的旧日志
- 旧日志先经过清洗和对话提取，追加到 `data/summary/{employeeId}.md`，成功后才删除原始日志

### 历史上下文缓存

每次启动员工会话时，系统会根据近期日志生成：

```text
data/history/{employeeId}.md
```

生成过程如下：

1. 读取最近最多 3 个日志文件，总原始内容不超过约 300KB。
2. 删除 ANSI、Spinner 和终端界面噪音。
3. 提取用户问题与 AI 回复。
4. 合并 `data/summary/{employeeId}.md` 中的长期摘要。
5. 将最终内容控制在约 30KB，并优先保留较新的历史。
6. 在角色配置 MD 中写入历史文件路径，要求新会话启动时主动读取。

历史缓存目前不是直接注入模型请求，而是由 AI CLI 根据 `CLAUDE.md`、`DEEPSEEK.md` 或 `COPILOT.md` 中的指令读取。

### MySQL 记忆现状

项目已有 `db.js` 和 `employee_summaries` 表定义，可表示近期对话和摘要，但当前主流程只执行数据库初始化，尚未将日志解析结果持续写入 MySQL。因此当前实际生效的长期记忆仍以文件为主。

## MySQL 结构化记忆规划

> 本节描述后续演进方案，以下表结构和处理链路尚未全部实现。

### 目标架构

MySQL 作为结构化长期记忆的主存储，文件继续承担原始证据、故障补偿和启动缓存：

```text
Provider 原生会话
        │
        ├── Resume ID：恢复完整上下文
        │
PTY 原始日志
        │
        ├── 增量清洗与对话提取
        ▼
MySQL 结构化记忆
        ├── 会话
        ├── 对话轮次
        ├── 会话/每日摘要
        └── 固化的重要事实
        │
        ▼
data/history/{employeeId}.md
        │
        ▼
新会话启动时读取
```

推荐的记忆层级：

| 层级 | 内容 | 主存储 |
|------|------|--------|
| L0 | Provider 当前完整上下文 | Resume ID 和 Provider 自身会话 |
| L1 | 最近的结构化对话 | MySQL `memory_turns` |
| L2 | 会话、每日或主题摘要 | MySQL `memory_summaries` |
| L3 | 用户确认的重要事实和约定 | MySQL `memory_facts` |
| 审计层 | 未加工的终端输出 | `data/logs/` |

### 推荐表结构

#### 会话表

```sql
CREATE TABLE memory_sessions (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  employee_id VARCHAR(80) NOT NULL,
  studio_id VARCHAR(80),
  provider VARCHAR(30) NOT NULL,
  provider_session_id VARCHAR(100),
  cwd VARCHAR(1000),
  started_at DATETIME NOT NULL,
  ended_at DATETIME,
  status VARCHAR(30) NOT NULL,
  INDEX idx_employee_started (employee_id, started_at)
);
```

#### 对话轮次表

```sql
CREATE TABLE memory_turns (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  session_id BIGINT,
  employee_id VARCHAR(80) NOT NULL,
  studio_id VARCHAR(80),
  turn_index INT,
  role VARCHAR(20) NOT NULL,
  content MEDIUMTEXT NOT NULL,
  tool_calls JSON,
  log_file VARCHAR(500),
  content_hash CHAR(64) NOT NULL,
  occurred_at DATETIME NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_employee_hash (employee_id, content_hash),
  INDEX idx_employee_time (employee_id, occurred_at)
);
```

`content_hash` 用于保证日志重复扫描时不会重复插入同一段对话。

#### 摘要表

```sql
CREATE TABLE memory_summaries (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  employee_id VARCHAR(80) NOT NULL,
  studio_id VARCHAR(80),
  scope_type VARCHAR(20) NOT NULL,
  scope_key VARCHAR(100) NOT NULL,
  content MEDIUMTEXT NOT NULL,
  source_start DATETIME,
  source_end DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_employee_scope (
    employee_id,
    scope_type,
    scope_key
  )
);
```

`scope_type` 可使用 `session`、`daily`、`weekly` 或 `topic`。

#### 固化记忆表

```sql
CREATE TABLE memory_facts (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  employee_id VARCHAR(80),
  studio_id VARCHAR(80),
  scope VARCHAR(20) NOT NULL,
  category VARCHAR(50) NOT NULL,
  content TEXT NOT NULL,
  source_turn_id BIGINT,
  status VARCHAR(20) DEFAULT 'active',
  expires_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    ON UPDATE CURRENT_TIMESTAMP
);
```

固化记忆只保存用户明确要求记住的约定、经过确认的项目事实、构建命令和架构结论，不自动把所有对话提升为永久事实。

#### 日志消费进度表

```sql
CREATE TABLE memory_ingestion_offsets (
  employee_id VARCHAR(80) NOT NULL,
  log_file VARCHAR(500) NOT NULL,
  byte_offset BIGINT NOT NULL DEFAULT 0,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (employee_id, log_file)
);
```

### 记忆写入链路

第一阶段继续复用现有 `deepClean()` 和 `extractConversations()`，按日志增量写入：

1. 定时或在会话结束时读取日志新增部分。
2. 从 `memory_ingestion_offsets.byte_offset` 继续消费，避免全量重复解析。
3. 清洗 PTY 内容并提取用户、AI 对话块。
4. 在同一个事务中写入 `memory_turns` 并更新 offset。
5. 数据库写入失败时不推进 offset，等待下一次重试。
6. 只有对话和摘要成功入库后，才能删除超过保留期的原始日志。

### 记忆读取链路

`generateHistoryContext()` 后续改为优先从 MySQL 组装上下文：

1. 加载角色或工作室范围内的固化记忆。
2. 加载最近一次会话摘要。
3. 加载最近 1～3 天的完整对话。
4. 加载更早的每日或主题摘要。
5. 按约 20～30KB 的内容预算裁剪。
6. 写入 `data/history/{employeeId}.md`，保持现有 Provider 接入方式不变。

MySQL 查询失败时回退到现有日志和摘要文件，不阻止员工会话启动。

### 故障与一致性策略

- MySQL 在第一阶段是可降级依赖，数据库不可用时仍继续运行终端并记录原始日志。
- 数据库失败必须记录明确错误，不能返回成功形态或静默丢弃。
- 对话写入和消费 offset 更新必须处于同一事务。
- `employee_id + content_hash` 保证重复消费幂等。
- 摘要写入成功前不得删除对应原始日志。
- MySQL 恢复后从未推进的 offset 自动补录。
- 角色之间默认按 `employee_id` 隔离；未来通过 `studio_id` 支持工作室共享记忆。

### 工作室记忆作用域

未来增加工作室后，记忆可分为四种作用域：

| 作用域 | 可见范围 | 示例 |
|--------|----------|------|
| `global` | 所有工作室 | 通用操作规范 |
| `studio` | 当前工作室成员 | 工作室架构决策 |
| `employee` | 指定角色 | Celeborn 排障经验 |
| `session` | 单次会话 | 当前临时分析过程 |

默认将对话记忆保存为 `employee` 或 `session`，只有经过确认的结论才提升为 `studio` 或 `global`。

### 分阶段实施

1. 新增会话、对话轮次和日志消费进度表，接通增量写入。
2. 让 `generateHistoryContext()` 优先从 MySQL 读取，失败时回退文件。
3. 将旧日志摘要写入 MySQL，并保证提交成功后才清理日志。
4. 将“重置会话”和“清除全部记忆”拆成两个独立操作。
5. 增加记忆查看、搜索、删除、置顶和手动固化页面。
6. 增加工作室级记忆作用域和权限边界。
7. 数据量增长后先评估 MySQL `FULLTEXT`，确有语义检索需求时再引入向量检索。

### 前端历史查看

- 终端面板头部显示 resume 状态指示器（绿点=可恢复 / 灰点=无记忆）
- 点击「历史」按钮打开历史面板，展示日志文件列表
- 选择日志文件后使用独立只读 xterm.js 终端渲染日志内容

### API 端点

| 端点 | 描述 |
|------|------|
| `GET /api/resume-status` | 返回所有员工的 resume ID 状态 |
| `GET /api/logs/:employeeId` | 返回指定员工的日志文件列表（日期、大小） |
| `GET /api/logs/:employeeId/:filename?tail=N` | 读取日志内容（默认尾部 200KB） |

## 快速启动

### 1. 前置条件

- Node.js >= 18
- 至少安装以下 CLI 之一：
  - `claude` — Anthropic Claude Code CLI（[安装指南](https://docs.anthropic.com/en/docs/claude-code)）
  - `copilot` — GitHub Copilot CLI（[安装指南](https://docs.github.com/en/copilot/github-copilot-in-the-cli)）
- IdeaProjects 下各项目目录已存在且包含代码

验证 CLI 是否可用：

```bash
# 验证 Claude CLI
claude --version

# 验证 Copilot CLI
copilot --version
```

### 2. 安装与启动

```bash
cd ~/claude-employees
npm install
npm start
# 浏览器打开 http://localhost:3000
```

启动后控制台会显示所有员工及其 Provider：

```
  ╔══════════════════════════════════════╗
  ║   AI Employees Dashboard             ║
  ╠══════════════════════════════════════╣
  ║   http://localhost:3000              ║
  ╚══════════════════════════════════════╝

  员工列表:
    ⚡ Spark           [Claude]  → ~/IdeaProjects/spark
    🌟 Celeborn        [Claude]  → ~/IdeaProjects/remoteshuffleservice
    🔀 Shuffle Proxy   [Copilot] → ~/IdeaProjects/shuffle-proxy
    ...
```

### 3. 自定义端口

```bash
PORT=8080 npm start
```

### 4. macOS 文件输出目录

macOS 可能通过 TCC 隐私保护限制 `node-pty` 子进程访问 `~/Documents/`、`~/Desktop/` 和 `~/Downloads/`。为实际启动服务的终端或 Node.js 授予完全磁盘访问权限后，服务会优先将分析文件写入 `~/Documents/ai-analysis/`。如果启动时检测到该目录不可访问，则自动使用 `~/IdeaProjects/ai-output/` 下的回退目录。

系统会自动创建并要求 AI 员工使用以下目录：

| 用途 | 路径 |
|------|------|
| 分析报告 | `~/Documents/ai-analysis/` |
| 周会/周报 | `~/IdeaProjects/ai-output/周会/` |
| Celeborn 相关 | `~/Documents/ai-analysis/celeborn/` |
| Log Warden 相关 | `~/Documents/ai-analysis/log-warden/` |
| 其他分析文档 | `~/Documents/ai-analysis/others/` |

分析目录写入返回 `EPERM` 或 `EACCES` 时，AI 员工会回退到 `~/IdeaProjects/ai-output/ai-analysis/` 的对应目录并告知实际路径。

## Provider 切换指南

### 切换单个员工的 Provider

编辑 `config.json`，为目标员工添加或修改 `"provider"` 字段：

```jsonc
// 从默认的 Claude 切换到 Copilot
{
  "id": "spark",
  "name": "Spark",
  "provider": "copilot",   // 新增此行，改为 "copilot"
  "cwd": "~/IdeaProjects/spark",
  ...
}
```

修改后需重启服务：

```bash
# 停止服务 (Ctrl+C)，然后重新启动
npm start
```

> **注意**：切换 Provider 后，之前的 resume ID 会保留但可能无法恢复（不同 CLI 的会话不互通）。系统会自动检测恢复失败并以新会话启动。

### 混合部署示例

不同员工可以使用不同的 Provider，互不影响：

```jsonc
{
  "employees": [
    {
      "id": "spark",
      "name": "Spark",
      "provider": "claude",     // 使用 Claude
      "cwd": "~/IdeaProjects/spark",
      ...
    },
    {
      "id": "celeborn",
      "name": "Celeborn",
      "provider": "copilot",    // 使用 Copilot
      "cwd": "~/IdeaProjects/remoteshuffleservice",
      ...
    },
    {
      "id": "code-reviewer",
      "name": "Code Reviewer",
      // 不设置 provider → 默认 "claude"
      ...
    }
  ]
}
```

同一项目目录下的不同 Provider 员工各自生成独立的配置文件（`CLAUDE.md` / `COPILOT.md`），互不覆盖。

### 将所有员工批量切换到 Copilot

可用以下命令一键修改（或手动编辑 `config.json`）：

```bash
# 使用 node 一键切换（执行后需重启服务）
node -e "
const fs = require('fs');
const cfg = JSON.parse(fs.readFileSync('config.json','utf-8'));
cfg.employees.forEach(e => e.provider = 'copilot');
fs.writeFileSync('config.json', JSON.stringify(cfg, null, 2));
console.log('已将所有员工切换到 Copilot');
"
npm start
```

### 前端识别

切换 Provider 后，前端会自动显示对应标识：

- 每个房间卡片左上角显示 Provider 角标（橙色 `CLAUDE` / 蓝色 `COPILOT`）
- 管理面板中的提示词配置文件名会动态显示为 `CLAUDE.md` 或 `COPILOT.md`

## 目录结构

```
claude-employees/
├── server.js           # 核心服务端 - Express + WebSocket + PTY 管理
├── config.json         # 员工配置文件（含 provider 字段）
├── package.json        # 依赖：express, node-pty, ws
├── SETUP.md            # 本文档
│
├── providers/          # Provider 抽象层
│   ├── index.js        # Provider 工厂函数
│   ├── claude.js       # Claude CLI 适配
│   └── copilot.js      # Copilot CLI 适配
│
├── public/             # 前端静态资源
│   ├── index.html      # 单页面应用（含完整 UI + JS）
│   ├── fonts/          # 字体文件
│   └── img/            # 原神风格图片资源
│
├── data/               # 运行时数据
│   ├── resume-ids.json # 会话恢复 ID 持久化
│   ├── logs/           # PTY 输出日志（按员工/日期分割）
│   ├── history/        # 提取的结构化对话历史
│   └── summary/        # 过期日志的摘要
│
└── mcp-servers/        # MCP 服务扩展
    └── confluence.js   # Confluence 内网页面读取工具
```
