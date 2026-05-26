---
name: agent-browser
description: >
  WSL 环境下的浏览器自动化工具。只要任务涉及浏览器操作——打开网页、点击、填表、截图、抓取内容——都应使用此技能。
  调用方式：`ax.ts agent-browser`，它会自动管理 Windows 侧 Chrome for Testing 的完整生命周期，无需手动启停浏览器。
  用户说"打开"、"浏览"、"检查网页"、"点一下"时，主动使用本技能。
allowed-tools:
  - Bash(ax.ts agent-browser*)
---

# agent-browser

`ax.ts agent-browser` 封装了 Vercel 的 `agent-browser` CLI，并自动完成：

1. 按需下载安装 Chrome for Testing（Windows 侧）
2. 通过 CDP 在 19222 端口启动 Chrome
3. 将子命令透传给 agent-browser
4. 退出时自动清理

不要直接调用 `bunx agent-browser`，统一用 `ax.ts agent-browser`。

## 基本用法

```bash
ax.ts agent-browser [参数] [agent-browser 子命令及参数]
```

不带子命令时，进入 agent-browser 交互会话。

## 参数

| 参数 | 说明 |
|------|------|
| `--headed` | 在 Windows 桌面打开可见的 Chrome 窗口 |
| `--profile <名称>` | 持久化 Chrome 配置（存储于 `%USERPROFILE%\.ax\profiles\<名称>`） |
| `--proxy <url>` | HTTP 代理（也可通过 `HTTP_PROXY` 环境变量设置） |
| `--proxy-bypass <列表>` | 代理绕过列表（也可通过 `NO_PROXY` 环境变量设置） |
| `--allow-file-access` | 允许 Chrome 加载本地文件 |
| `--extension <路径>` | 加载 Chrome 扩展（支持 WSL 或 Windows 路径） |
| `--args <标志>` | 额外 Chrome 启动参数，逗号或换行分隔 |
| `--executable-path <路径>` | 指定 Chrome 可执行文件路径（跳过自动管理） |

以上参数也可通过环境变量设置：

| 环境变量 | 对应参数 |
|----------|----------|
| `AGENT_BROWSER_HEADED=1` | `--headed` |
| `AGENT_BROWSER_PROFILE=<名称>` | `--profile` |
| `AGENT_BROWSER_PROXY=<url>` | `--proxy` |
| `AGENT_BROWSER_PROXY_BYPASS=<列表>` | `--proxy-bypass` |
| `AGENT_BROWSER_ALLOW_FILE_ACCESS=1` | `--allow-file-access` |
| `AGENT_BROWSER_EXTENSIONS=<路径,...>` | `--extension` |
| `AGENT_BROWSER_ARGS=<标志>` | `--args` |
| `AGENT_BROWSER_EXECUTABLE_PATH=<路径>` | `--executable-path` |
| `CHROME_FOR_TESTING_DIR=<路径>` | 覆盖 Chrome 安装目录 |

## 内置子命令

这些命令操作托管的 Chrome 安装，不会启动浏览器：

```bash
ax.ts agent-browser install    # 下载/验证 Chrome for Testing
ax.ts agent-browser upgrade    # 升级到最新稳定版
ax.ts agent-browser profiles   # 列出已保存的配置
ax.ts agent-browser doctor     # 检查安装状态、版本、端口占用
```

## 示例

```bash
# 导航到指定 URL
ax.ts agent-browser navigate https://example.com

# 有头模式（在 Windows 桌面显示窗口）
ax.ts agent-browser --headed navigate https://example.com

# 持久会话（登录状态跨次保留）
ax.ts agent-browser --profile work navigate https://myapp.com

# 检查 Chrome 安装状况
ax.ts agent-browser doctor
```

## 工作原理

- Chrome 运行在 **Windows 侧**，通过 PowerShell 启动
- 通过 `localhost:19222` CDP 与 agent-browser 通信
- 默认无头模式；`--headed` 在 Windows 桌面打开真实窗口
- 每次会话使用临时配置目录（除非指定 `--profile`）
- 命令退出时自动关闭 Chrome

## 限制

- 扩展必须位于 Windows 文件系统或可通过 `wslpath` 转换的 WSL 路径
- `captureVisibleTab` Chrome API 在无头模式下不可用（有头模式正常）
- 仅支持 Windows Chrome for Testing，不支持其他引擎
