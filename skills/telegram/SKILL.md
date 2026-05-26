---
name: telegram
description: >
  通过 Telegram Bot API 收发消息。需要发送通知、查看消息、列出聊天时使用此技能。
  用户说"发个消息"、"看看 telegram 消息"、"查一下聊天列表"、"等着收消息"时主动使用。
allowed-tools:
  - Bash(ax.ts telegram*)
---

# telegram

`ax.ts telegram` 通过 Bot API 收发 Telegram 消息，bot token 存储在 vault 的 `telegram_yjgbg_claude_bot_token` 中。

## 命令

```bash
ax.ts telegram send [-c <chat_id>] [-h] <text>   # 发送消息
ax.ts telegram send -c 1274720001 --json "hello" # JSON 输出

ax.ts telegram updates                            # 查看未读消息（看完自动标记已读）
ax.ts telegram updates --wait                     # 持续等待新消息（Ctrl+C 退出）
ax.ts telegram updates --json                     # JSON 格式输出

ax.ts telegram chats                              # 列出可见聊天
ax.ts telegram chats --json                       # JSON 格式输出
```

## 参数

| 参数 | 说明 |
|------|------|
| `-c <chat_id>` | 指定目标 chat（不指定则自动发现，取最近一次消息的 chat） |
| `-h` | 启用 HTML 解析（`<b>` `<i>` `<a>` `<code>` `<pre>` `<s>` `<u>` `<tg-spoiler>`） |
| `--json` | 输出原始 JSON，适合脚本 / agent 解析 |
| `--wait` | 长轮询等待新消息（Telegram 服务端持有连接 50s，超时自动续期） |

## 常用 chat_id

| chat_id | 名称 |
|---------|------|
| 1274720001 | 见 (@wei_c_l) |

## HTML 消息示例

```bash
ax.ts telegram send -h "<b>粗体</b> <i>斜体</i> <a href='https://example.com'>链接</a>
<pre>代码块</pre>"
```

## 注意

- 不要同时运行两个 `updates --wait`，Telegram 只允许一个长轮询连接
- `send` 不带 `-c` 时会调用 `getUpdates` 发现默认 chat，可能与 `updates --wait` 冲突
- 消息看完自动标记已读，`chats` 只能从未确认的 update 中提取聊天列表
