# AI Employees — 多会话 AI 员工管理面板

> 基于 Web 的多会话 AI 员工管理面板。每个「员工」对应一个本地项目目录,在其中启动独立的 AI CLI 终端会话(Claude Code / GitHub Copilot / DeepSeek 等),并通过 WebSocket 实时同步到浏览器。

## ✨ 特性

- **多 Provider 支持**:同时接入 Claude Code CLI、GitHub Copilot CLI、DeepSeek(通过 Claude Code CLI + 自定义 API endpoint)
- **多角色管理**:项目角色 + 跨项目工具角色(Code Reviewer、Architect 等),互不干扰
- **会话恢复**:自动捕获 `--resume <uuid>`,服务重启自动续接上次对话
- **对话日志**:PTY 输出实时落盘,结构化提取,过期日志自动摘要
- **自动审查**:项目角色 `git push` 成功后可自动触发 Code Reviewer 审查
- **性格配置**:通过 UI 面板动态调整 Code Reviewer / Architect 的语气、审查风格、关注领域
- **数据库直连**:元仓类角色可直连 MySQL 兼容协议数据库
- **Confluence 集成**:可选 MCP Server,支持任意自建 Confluence(需配置 base URL + Personal Access Token)

## 📐 架构

```
浏览器 (index.html + xterm.js)
       ↕ WebSocket
Node.js 服务端 (server.js)
       ↕ Provider 抽象层 (providers/)
       ↕ node-pty
多个独立的 AI CLI 进程 (每个在不同项目目录)
```

- **后端**:Node.js + Express + `ws` + `node-pty`
- **前端**:单文件 `public/index.html`(xterm.js + 原创样式)
- **持久化**:JSON + 可选 MySQL(存对话摘要)

## 🚀 快速开始

### 1. 前置条件

- Node.js ≥ 18
- 至少安装以下 AI CLI 之一:
  - [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code)(`claude` 命令)
  - [GitHub Copilot CLI](https://docs.github.com/en/copilot/github-copilot-in-the-cli)(`copilot` 命令)

### 2. 安装

```bash
git clone <this-repo> ai-employees
cd ai-employees
npm install
```

### 3. 配置

```bash
# 复制配置模板
cp config.example.json config.json
cp .env.example .env

# 编辑 config.json,把示例员工的 cwd 改成你本地的项目路径
# 编辑 .env,按需填写 Confluence / DB / DeepSeek 等可选凭据
```

### 4. 启动

```bash
npm start
# 打开 http://localhost:3000
```

## ⚙️ 员工配置

`config.json` 中每个员工的字段:

| 字段 | 说明 |
|------|------|
| `id` | 唯一标识,用于 WebSocket 路由 |
| `name` | 显示名称 |
| `provider` | AI CLI 后端:`claude`(默认) / `copilot` / `deepseek` / `cc-connect` |
| `cwd` | 项目目录,AI 会话在此目录启动 |
| `description` | 员工职责描述 |
| `color` | 主题色 |
| `avatar` | Emoji 头像 |
| `skills` | 技能标签列表 |
| `category` | `project`(项目角色) / `utility`(跨项目工具) |
| `cwdMode` | `multi` 表示启动时选择项目目录 |
| `cwdList` | 多项目模式下可选目录 |
| `personality` | 性格配置(仅 utility 角色) |
| `dbConnection` | MySQL 连接信息(元仓类角色) |

### Provider 抽象

`providers/` 下每个文件实现:

| 方法 | 说明 |
|------|------|
| `command` | CLI 命令名 |
| `configFileName` | 项目配置文件名(如 `CLAUDE.md`) |
| `getArgs(employee, resumeId)` | 构建启动参数 |
| `captureResumeId(data)` | 从 PTY 输出捕获 session ID |
| `detectResumeFailed(data)` | 检测 resume 失败 |
| `getSpawnEnv(baseEnv)` | 注入 provider 特有环境变量 |

新增 provider:在 `providers/` 下新建文件实现上述接口,再到 `providers/index.js` 注册。

## 🗂️ 目录结构

```
ai-employees/
├── server.js              # 核心服务端(Express + WebSocket + PTY)
├── config.example.json    # 员工配置模板
├── .env.example           # 环境变量模板
├── db.js                  # MySQL 摘要存储(可选)
├── package.json
│
├── providers/             # Provider 抽象层
│   ├── index.js
│   ├── claude.js
│   ├── copilot.js
│   ├── deepseek.js
│   └── cc-connect.js
│
├── lib/
│   ├── config-md.js       # 项目内 CLAUDE.md 动态生成
│   └── noise-filter.js    # 终端 ANSI 清洗
│
├── mcp-servers/
│   └── confluence.js      # 自建 Confluence 读取(可选)
│
├── public/                # 前端资源
│   ├── index.html
│   ├── fonts/
│   └── img/
│
└── data/                  # 运行时数据(不进 git)
    ├── resume-ids.json
    ├── logs/
    ├── history/
    └── summary/
```

## 🔐 隐私与安全

- **凭据**全部从 `.env` 与 `config.json` 加载,均已列入 `.gitignore`
- **对话日志**存放于本地 `data/` 目录,不会外传
- **Confluence MCP** 需自行配置 base URL + token,默认关闭
- **数据库直连**由本地 `mysql` CLI 承载,不经过第三方

## 📄 License

MIT © Contributors
