# T3 Code（本 fork）安装与使用指南

本仓库是 [pingdotgg/t3code](https://github.com/pingdotgg/t3code) 的 fork，包含其全部源码。
相对上游的改动只有 `.gitignore`（忽略个人工作目录 `agents/`、`.zcode/`），产品功能与官方版完全一致。

## 为什么克隆这个仓库 ≠ 你电脑上"安装好的 T3"

本机已安装的那个 T3 桌面应用（开始菜单/桌面图标那个）是**官方 CI 构建发布的安装包**
（Setup.exe / .dmg，见[上游 Releases](https://github.com/pingdotgg/t3code/releases)）。

而这个 fork 是**源代码仓库**：克隆下来只是代码 + 依赖清单，里面没有任何安装程序。
`pnpm install` 之后得到的是**开发环境**，只能以开发模式从源码启动，不会往系统里安装应用。

| 你想要的               | 用哪个                                                                     |
| ---------------------- | -------------------------------------------------------------------------- |
| 日常使用桌面版（推荐） | 装[官方安装包](https://github.com/pingdotgg/t3code/releases)，自带自动更新 |
| 跑/改这份源码          | 按下面步骤以开发模式运行                                                   |
| 给自己的改动出安装包   | `pnpm build:desktop` + Electron 打包（重量级，目前无此需求）               |

## 从源码运行（开发模式）

前置要求：Node.js ≥ 24.13.1、pnpm 11.10.0（`corepack enable` 会自动匹配版本）。

```bash
git clone https://github.com/yibaul317-ops/t3code_zh.git
cd t3code_zh
pnpm install
```

- **Web 版**：`pnpm dev` —— 启动 server + web，按终端 `[dev-runner]` 行输出的端口用浏览器访问
- **桌面开发模式**：`pnpm dev:desktop` —— 从源码拉起 Electron 窗口（是开发进程，不是安装的应用）

网络受限时（github.com 直连不稳定），先给当前终端挂代理再执行安装/克隆：

```bash
export HTTP_PROXY=http://127.0.0.1:7890 HTTPS_PROXY=http://127.0.0.1:7890   # Git Bash
# PowerShell: $env:HTTP_PROXY='http://127.0.0.1:7890'; $env:HTTPS_PROXY='http://127.0.0.1:7890'
```

## Agent（provider）配置不随仓库走

kimi / dsh / zcode 等 provider 实例配置存放在**每台机器本地**的
`~/.t3/userdata/settings.json`（Windows：`C:\Users\<你>\.t3\userdata\settings.json`），
密钥与登录态也都在本机 `~/.t3` 下——**仓库里没有任何密钥，也不应该有**。

在新机器上复刻 provider 两选一：

1. **官方 ACP Registry 一键添加**（如 kimi）：T3 → Settings → Providers → Add provider → ACP → 搜索 `kimi`
2. **本地命令模式**：Settings → Add provider → ACP → Local ACP command 填 node.exe 路径；
   带参数的（如 kimi）直接在 `settings.json` 的 `providerInstances` 里加：

```json
"acpRegistry_kimi": {
  "driver": "acpRegistry",
  "displayName": "Kimi Code",
  "enabled": true,
  "config": {
    "source": "local",
    "commandPath": "C:\\Program Files\\nodejs\\node.exe",
    "commandArgs": [
      "C:\\Users\\<你>\\AppData\\Roaming\\npm\\node_modules\\@moonshot-ai\\kimi-code\\dist\\main.mjs",
      "acp"
    ]
  }
}
```

（前提：新机器上 `npm i -g @moonshot-ai/kimi-code`；首次使用时在 T3 里完成一次登录。）

## 与官方保持同步

```bash
git fetch upstream                     # upstream 指向 pingdotgg/t3code
git merge upstream/main
pnpm install                           # 依赖有变化时
git push origin main                   # 推回本 fork
```

## 安全红线

- 永远不要提交 `.env`、`~/.t3/`（含 settings.json 里的 apiKey）、`agents/`、`.zcode/`——前三者已被 `.gitignore` 覆盖，提交前仍建议 `git status --short` 扫一眼
- 本 fork 是公开仓库，所有提交全网可见
