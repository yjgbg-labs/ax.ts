---
name: weixin
description: >
  通过微信 Bot（基于 Tencent/openclaw-weixin 的 ilink/bot 协议）收发消息。
  需要扫码登录、查看新消息、回复对话、发图片/视频/文件、做语义"正在输入"时使用此技能。
  用户说"看看微信"、"回个微信"、"发个微信消息"、"扫码登录微信"、"微信里收到啥了" 时主动使用。
allowed-tools:
  - Bash(ax.ts weixin*)
---

# weixin

`ax.ts weixin` 通过 openclaw-weixin 的同源后端网关（`https://ilinkai.weixin.qq.com`）收发微信消息，凭据本地存在 `~/.local/state/ax-weixin/`，单账号。

## 命令

```bash
ax.ts weixin login                                   # 扫码登录（凭据自动保存）
ax.ts weixin logout                                  # 清除本地凭据 + context_token + sync_buf
ax.ts weixin status [--json]                         # 查看登录状态与已知联系人

ax.ts weixin updates                                 # 拉一次新消息（自动推进 sync_buf）
ax.ts weixin updates --wait                          # 阻塞等待，直到拉到第一批新消息后退出
ax.ts weixin updates --json                          # 输出原始 WeixinMessage JSON
ax.ts weixin updates --reset                         # 清空 sync_buf，下次从头拉

ax.ts weixin send <to_user_id> <text> [--json]       # 发送纯文本
ax.ts weixin send <to_user_id> -f <file> [-t <cap>]  # 上传并发送图片/视频/文件
                                                     # 类型按 MIME 自动判断：image/* → 图片, video/* → 视频, 其余 → 文件附件

ax.ts weixin typing <to_user_id> [--cancel]          # 发送/取消"正在输入"指示器
ax.ts weixin download --param <p> --aes-key <k> -o <file>
                                                     # 从 CDN 下载并 AES-128-ECB 解密媒体
ax.ts weixin download --full-url <url> --plain -o <file>
                                                     # 下载未加密 CDN 资源
```

## 参数

| 参数 | 说明 |
|------|------|
| `<to_user_id>` | 对方微信 user id，从 `updates` 输出的 `from_user_id` 拿 |
| `--json` | 原始 JSON 输出，适合脚本/agent 消费 |
| `--wait` | 阻塞直到收到首批新消息后退出；服务端单次最多挂 35s，超时自动续轮询 |
| `--reset` | 清空 sync_buf；常用于首次登录后跳过历史 |
| `-f <file>` | 待发送的本地文件路径 |
| `-t <caption>` | 媒体附带的文字说明（先发文字、再发媒体，同 context） |
| `--cancel` | 取消之前发出的"正在输入" |
| `--param` | CDNMedia.encrypt_query_param |
| `--full-url` | CDNMedia.full_url（服务端直接给的完整下载链接） |
| `--aes-key` | CDNMedia.aes_key（base64 形式，自动识别 16 字节 raw 或 32 字符 hex） |
| `--plain` | 不解密直接保存原始字节 |

## 上手流程

1. `ax.ts weixin login` — 终端打印二维码（也回退到文字链接），用手机微信扫码 → 自动保存 `bot_token`、`baseUrl`、`ilink_user_id` 到 `~/.local/state/ax-weixin/account.json`。
2. 让目标联系人先给 bot 发一条消息（QR 登录绑定的那个微信号即可）。
3. `ax.ts weixin updates` 拉到这条消息后，工具会把消息里的 `context_token` 按 `from_user_id` 缓存到 `~/.local/state/ax-weixin/context-tokens.json`。
4. 之后 `ax.ts weixin send <from_user_id> "你好"` 就能回复。无 context_token 时仍会发，但服务端可能拒收。

## 媒体收发

- **发**：`-f` 任意路径，扩展名查 MIME（`.jpg/.png/.webp` 等 → IMAGE，`.mp4/.mov` → VIDEO，其它 → FILE 附件）。本地 AES-128-ECB 加密后上传 CDN，再把返回的 `x-encrypted-param` 拼进消息。
- **收**：`updates` 输出的 `image_item.media.encrypt_query_param` + `aes_key`（或 `full_url`）丢给 `ax.ts weixin download --param … --aes-key … -o pic.jpg` 即可解密落盘。语音是 SILK 编码，下载后还需要外部工具转码，本子命令不内置。

## 注意

- 单账号设计：再次 `login` 会覆盖原 token（首次会带上旧 token 走 `local_token_list`，若已绑定本机服务端会回 `binded_redirect`）。
- `updates` 看到 `errcode: -14` 表示 session 失效，重新 `login` 即可。
- `send` 媒体时若返回 4xx 通常是被风控（陌生人/频次/内容），重试无意义。
- 凭据文件权限自动设为 `0600`，不要拷出宿主机。
- 后端是 Tencent 托管的 `ilinkai.weixin.qq.com`，不要塞自定义网关地址（协议未定型）。
