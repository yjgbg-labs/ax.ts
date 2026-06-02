---
name: agent-browser
description: >
  WSL 环境下的浏览器自动化工具。只要任务涉及浏览器操作——打开网页、点击、填表、截图、抓取内容——都应使用此技能。
  调用方式：`ax.ts agent-browser --session <name> ...`，它会自动管理 Windows 侧 Chrome for Testing 的完整生命周期，无需手动启停浏览器。
  用户说"打开"、"浏览"、"检查网页"、"点一下"时，主动使用本技能。
allowed-tools:
  - Bash(ax.ts agent-browser*)
---

# agent-browser

`ax.ts agent-browser` 封装 Vercel 的 `agent-browser` CLI，把 Chrome for Testing 跑在 Windows 侧、通过 CDP 与 WSL 内的 agent-browser 二进制通信。**每次调用都必须显式指定 `--session <name>`**——一个 session 名对应一个独立的 Chrome 实例 + 独立的 user-data-dir。

不要直接调用 `bunx agent-browser`，统一用 `ax.ts agent-browser`。

## 基本用法

```bash
ax.ts agent-browser --session <name> [启动期参数] [agent-browser 子命令及参数]
```

`--session` 也可通过环境变量 `AGENT_BROWSER_SESSION` 设置。session 名规则：`[A-Za-z0-9._-]`，最长 64 字符。

## Session 生命周期

一个 session 第一次被用到时，wrapper 会：

1. 在 Windows 侧建立 user-data-dir：`%USERPROFILE%\.ax\sessions\<name>`
2. 从 19222 起向上找一个空闲端口
3. 启动 Chrome（带 `--remote-debugging-port=<port> --user-data-dir=<dir>`）

之后调用同一个 session 名时，wrapper 通过 Windows 进程表查 `chrome.exe` 命令行里 `--user-data-dir` 匹配本 session 的进程，再通过 `Get-NetTCPConnection` 反查它监听的 CDP 端口，直接 attach。**整个 WSL 侧不保存任何状态文件**——进程表就是源真理。Chrome 进程死了或被手动杀掉 → 下次调用自动重启（同 user-data-dir，登录态/cookie 保留，可能拿到不同端口）。

显式 `close` 才会结束 session：先让 upstream daemon 断开连接，再 tree-kill Chrome 进程。

## 启动期参数

只在**首次启动该 session 的 Chrome 时**生效；如果 session 已在跑，会被忽略并打印 warning。要换参数得先 close。

| 参数 | 说明 |
|------|------|
| `--headed` | 在 Windows 桌面打开可见的 Chrome 窗口 |
| `--proxy <url>` | HTTP 代理（也可通过 `HTTP_PROXY` / `AGENT_BROWSER_PROXY`） |
| `--proxy-bypass <列表>` | 代理绕过列表（也可通过 `NO_PROXY`） |
| `--allow-file-access` | 允许 Chrome 加载本地文件 |
| `--extension <路径>` | 加载 Chrome 扩展（支持 WSL 或 Windows 路径，可重复） |
| `--args <标志>` | 额外 Chrome 启动参数，逗号或换行分隔 |
| `--executable-path <路径>` | 指定 Chrome 可执行文件路径（跳过自动管理） |

环境变量等价：`AGENT_BROWSER_HEADED=1` / `AGENT_BROWSER_PROXY` / `AGENT_BROWSER_PROXY_BYPASS` / `AGENT_BROWSER_ALLOW_FILE_ACCESS=1` / `AGENT_BROWSER_EXTENSIONS` / `AGENT_BROWSER_ARGS` / `AGENT_BROWSER_EXECUTABLE_PATH` / `CHROME_FOR_TESTING_DIR`。

## 内置子命令

```bash
ax.ts agent-browser install              # 下载/验证 Chrome for Testing
ax.ts agent-browser upgrade              # 升级到最新稳定版
ax.ts agent-browser session list         # 列出所有 session 及运行状态
ax.ts agent-browser doctor               # 检查安装状态、版本

ax.ts agent-browser --session <n> close  # 关闭单个 session（保留 user-data-dir）
ax.ts agent-browser --session <n> delete # 关闭并彻底删除 session 的 user-data-dir
```

`close` 只杀进程，登录态/cookie 留在磁盘上，下次同名 `--session` 调用还会复用。`delete` 才会真正清掉 `%USERPROFILE%\.ax\sessions\<name>` 目录——确认不再需要这份数据时才用。批量操作需自行 `session list` 后循环。

## 示例

```bash
# 一次性页面操作
ax.ts agent-browser --session scratch navigate https://example.com

# 持久登录态：第一次有头登录，之后无头复用
ax.ts agent-browser --session work --headed navigate https://myapp.com
# 手动登录后...
ax.ts agent-browser --session work snapshot
ax.ts agent-browser --session work navigate https://myapp.com/dashboard

# 多个独立浏览器并行（互不干扰，独立 cookie）
ax.ts agent-browser --session a navigate https://site1.com
ax.ts agent-browser --session b navigate https://site2.com
ax.ts agent-browser session list

# 清理
ax.ts agent-browser --session scratch close
```

## 已移除的参数

上游原生的 `--profile` / `--session-name` / `--state` / `--auto-connect` 在 wrapper 中**全部移除**，统一用 `--session` 代替。传这些参数会硬报错。`profiles` 子命令同样移除，用 `sessions` 代替。

## 工作原理

- Chrome 运行在 **Windows 侧**，通过 PowerShell 启动 + `taskkill /T /F` 树杀
- WSL 内的 agent-browser 二进制通过 `localhost:<port>` 经 WSL2 端口转发连到 Windows Chrome 的 CDP
- 端口分配从 19222 起向上扫描，上限 19321（最多 100 个并行 session）
- **WSL 侧不保存任何元数据**——session 状态完全派生自 Windows 进程表（`Get-CimInstance Win32_Process` + `Get-NetTCPConnection`）
- session user-data-dir 存 `%USERPROFILE%\.ax\sessions\<name>`（Windows 侧）
- session 不会自动清理——只有显式 `close` 才结束

## 限制

- 扩展必须位于 Windows 文件系统或可通过 `wslpath` 转换的 WSL 路径
- `captureVisibleTab` Chrome API 在无头模式下不可用（用 `--headed`）
- 仅支持 Windows Chrome for Testing
- 同一个 session 同一时刻只能有一个 Chrome 进程（Chrome 的 user-data-dir SingletonLock 限制）
