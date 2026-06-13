# ax.ts

个人效率工具集，基于 Bun + TypeScript 构建。

## 安装

```bash
git clone git@github.com:yjgbg-labs/ax.ts.git
cd ax.ts
bun install
ln -s $(pwd)/bin/ax.ts ~/.local/bin/ax.ts
```

## 子命令

| 命令 | 说明 |
|---|---|
| `ax.ts headscale` | 管理 tailscale 客户端和 headscale VPN 连接 |
| `ax.ts vault` | SSH 后端的 JSON 密钥存储（路由器 `/etc/vault.json`） |
| `ax.ts mihomo` | 管理路由器上的 mihomo 透明代理 |
| `ax.ts telegram` | 通过 Telegram Bot API 收发消息 |
| `ax.ts weixin` | 通过微信 Bot 收发消息 |
| `ax.ts tts` | 小米 MiMo 文本转语音 |
| `ax.ts wiki` | 个人 LLM Wiki 管理 |
| `ax.ts prometheus` | 查询 VictoriaMetrics 监控指标 |
| `ax.ts quickwit` | 搜索 Quickwit 日志和事件 |
| `ax.ts gws` | Google Workspace 操作（Gmail/Calendar/Drive/Sheets） |
| `ax.ts dlna` | DLNA 媒体投屏 |
| `ax.ts zhipin` | Boss 直聘自动化 |

使用 `ax.ts <command> --help` 查看各子命令详细用法。

## 项目结构

```
bin/ax.ts          入口，自动发现 libs/ 下的子命令
libs/<name>/       每个子命令一个目录
  package.json     name, description, bin
  index.ts         入口脚本
skills/<name>/     AI agent 技能文档（SKILL.md）
```

子命令通过 `libs/` 目录自动发现，无需手动注册。

## 技术栈

- **运行时**: Bun
- **语言**: TypeScript
- **包管理**: Bun workspace
