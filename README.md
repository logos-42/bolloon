# Bolloon — P2P AI 智能体平台

Bolloon 是一个本地优先、P2P 协作的 AI 智能体平台。它在你的设备上运行，通过 DHT 网络发现并连接其他节点。

> 中文 · [English](#english)

---

## 快速安装

### macOS / Linux

```bash
# 方式一：npm（需 Node.js ≥ 18）
npm install -g @bolloon/bolloon-agent

# 方式二：一键脚本
curl -fsSL https://raw.githubusercontent.com/logos-42/bolloon/master/scripts/install.sh | sh
```

### Windows

```powershell
# 方式一：npm（需 Node.js ≥ 18）
npm install -g @bolloon/bolloon-agent

# 方式二：一键脚本
# 以管理员身份运行 PowerShell：
iwr -useb https://raw.githubusercontent.com/logos-42/bolloon/master/scripts/install.ps1 | iex
```

> **Node.js 安装**：如果尚未安装，访问 [nodejs.org](https://nodejs.org) 下载 LTS 版本，或使用包管理器：
> - macOS: `brew install node`
> - Windows: `winget install -e --id OpenJS.NodeJS.LTS`
> - Linux: `sudo apt install -y nodejs npm`

---

## 快速启动

```bash
bolloon              # CLI 交互模式（默认）
bolloon --web        # Web UI 模式（浏览器）
bolloon --cli        # 强制 CLI 模式
bolloon --help       # 查看所有命令
```

首次启动会自动配置 LLM（需要 `OPENAI_API_KEY` 或 `DEEPSEEK_API_KEY` 环境变量）。

---

## 功能概览

| 功能 | 描述 |
|------|------|
| 🤖 AI 对话 | 本地运行的智能体，支持多轮对话 |
| 🌐 P2P 网络 | 自动发现并连接其他 Bolloon 节点 |
| 📄 文档处理 | 接收和管理文档，支持 DID 签名验证 |
| 🔧 工具调用 | shell 命令、文件操作、代码分析等 |
| 🔄 自我改进 | 自动检查更新、质量门控 |

---

## 项目结构

```
bolloon/
├── src/
│   ├── agents/          # 智能体核心（pi-sdk、工具、session）
│   ├── cli/             # CLI 界面（Ink TUI 渲染引擎）
│   ├── network/         # P2P 网络（Hyperswarm / DIAP）
│   ├── security/        # 安全层（工具闸门、守卫）
│   ├── llm/             # LLM 接入层
│   └── web/             # Web UI
├── dist/                # 编译输出
├── docs/                # 文档
└── scripts/             # 构建和安装脚本
```

---

## 从源码构建

```bash
git clone https://github.com/logos-42/bolloon.git
cd bolloon
npm install
npm run build:all
npm start
```

---

## 环境变量

| 变量 | 说明 |
|------|------|
| `OPENAI_API_KEY` | OpenAI 提供商（可选） |
| `DEEPSEEK_API_KEY` | DeepSeek 提供商（可选） |
| `ANTHROPIC_API_KEY` | Anthropic 提供商（可选） |
| `BOLLOON_LLM_PROVIDER` | 指定 LLM 提供商 |

---

<a name="english"></a>

## English

**Bolloon** — A local-first, P2P-collaborative AI agent platform that runs on your device and discovers other nodes through a DHT network.

### Quick Install

**macOS / Linux:**
```bash
npm install -g @bolloon/bolloon-agent
```

**Windows (PowerShell):**
```powershell
npm install -g @bolloon/bolloon-agent
```

### Quick Start

```bash
bolloon            # CLI interactive mode
bolloon --web      # Web UI mode
bolloon --help     # All commands
```

Requires Node.js ≥ 18 and an LLM API key (`OPENAI_API_KEY` or `DEEPSEEK_API_KEY`).

### License

MIT
