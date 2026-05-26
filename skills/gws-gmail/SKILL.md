---
name: gws-gmail
description: >
  通过 gws CLI 操作 Gmail：收发邮件、查未读、搜邮件、读正文、回复/转发、监听新邮件。
  用户说"发个邮件"、"查一下邮件"、"未读邮件"、"回复 xxx"、"搜一下来自 xxx 的邮件"、
  "把 xxx 的附件下载下来"、"监听新邮件" 时使用此技能。
allowed-tools:
  - Bash(gws*)
---

# gws-gmail

`gws gmail` 操作当前认证账号的 Gmail（`userId=me`）。通用语法、`--params/--json/--format`、分页、认证见 [[gws-basics]]（`skills/_shared/gws-basics.md`）。

## 默认发邮件风格（重要）

**所有代发邮件默认走 HTML 富文本模板**，不是裸文本。规则：

1. **必须 `--html`** —— 用现代化网页风格，不要发素 `<p>` 堆砌的简陋邮件。
2. **不加 footer / 署名** —— 末尾不要出现"由 Claude Code 发送"、"by xxx"、"---" 之类的落款，正文结束就是结束。
3. **复用模板** —— 见同目录 `email-template.html`，每次以它为骨架填空、增删 section。

**移动端硬约束**（别破坏）：

- **单列布局**，不用 `flex` / `grid` —— Gmail Mobile / Outlook 对 flex 支持烂，会塌成挤一坨
- 表格用 `<table role="presentation">` + `<tr>/<td>` —— 邮件客户端最稳的横向布局方式
- 全部块 100% 宽，最大宽度 ≤ 640px
- 单一强调色（indigo `#4f46e5`）+ 灰阶为主，**不要**多种鲜色色块拼贴；暗色代码块可保留作为视觉锚点
- 不要 stat 卡片横排、不要渐变 header、不要大徽章 pill —— 克制就是好看

如果用户**明确**要求"发个纯文本邮件"，才不走模板。

## 优先用 helper 命令

所有高频任务都有封装好的 `+helper`，flag 是自然语言，**优先于 raw API**。

| Helper | 作用 |
|---|---|
| `+send` | 发邮件（支持附件、HTML、CC/BCC、from alias、`--draft`） |
| `+reply` | 回某条消息（自动处理 threading） |
| `+reply-all` | 回复全部 |
| `+forward` | 转发 |
| `+read` | 读某条消息正文或头 |
| `+triage` | 未读收件箱摘要（发件人/标题/日期表格） |
| `+watch` | 监听新邮件，NDJSON 流式输出 |

### 发邮件

```bash
# 基本
gws gmail +send --to alice@example.com --subject 'Hello' --body 'Hi Alice!'

# 多收件人 + CC/BCC
gws gmail +send --to a@x.com,b@x.com --cc c@x.com --bcc d@x.com \
  --subject 'Sync' --body 'Body...'

# HTML 正文
gws gmail +send --to a@x.com --subject 'Hi' --body '<b>Bold</b>' --html

# 用别名发件
gws gmail +send --to a@x.com --subject 'Hi' --body '...' --from alias@example.com

# 附件（可多次 -a）
gws gmail +send --to a@x.com --subject 'Report' --body 'See attached.' -a report.pdf -a notes.md

# 存草稿不发送
gws gmail +send --to a@x.com --subject 'Draft' --body '...' --draft
```

发送前如对内容把握不准，可加 `--dry-run` 先看会发出什么。

### 看未读 / 回复

```bash
# 收件箱 triage（表格）
gws gmail +triage

# 读单条
gws gmail +read --id <messageId>
gws gmail +read --id <messageId> --headers   # 只看 headers
gws gmail +read --id <messageId> --raw       # 原始 base64 信封

# 回复 / 回复全部 / 转发（自动续 thread）
gws gmail +reply       --id <messageId> --body '收到，明天给。'
gws gmail +reply-all   --id <messageId> --body 'FYI 所有人。'
gws gmail +forward     --id <messageId> --to bob@x.com --body 'Forwarding...'
```

### 监听新邮件

```bash
# 默认监听 INBOX，每来一封打印一行 NDJSON
gws gmail +watch

# 按 query 过滤（同 Gmail 搜索语法）
gws gmail +watch --query 'from:boss@company.com is:unread'
```

## Raw API（helper 不覆盖的场景）

资源结构：`gws gmail users <sub-resource> <method>`，`userId` 永远填 `"me"`。

```bash
# 搜邮件
gws gmail users messages list --params '{
  "userId": "me",
  "q": "from:alice@example.com has:attachment newer_than:7d",
  "maxResults": 20
}'

# 拿原始消息（含 payload / parts）
gws gmail users messages get --params '{"userId":"me","id":"<msgId>","format":"full"}'

# 列标签 / 新建标签
gws gmail users labels list --params '{"userId":"me"}'
gws gmail users labels create --params '{"userId":"me"}' \
  --json '{"name":"Auto-archived","labelListVisibility":"labelShow"}'

# 改标签（加 / 删）
gws gmail users messages modify --params '{"userId":"me","id":"<msgId>"}' \
  --json '{"addLabelIds":["Label_123"],"removeLabelIds":["INBOX"]}'

# 批量删除
gws gmail users messages batchDelete --params '{"userId":"me"}' \
  --json '{"ids":["<id1>","<id2>"]}'
```

### Gmail 搜索 query 语法（`q` 字段）

和网页版一致：`from:`、`to:`、`subject:`、`has:attachment`、`is:unread`、`label:xxx`、`newer_than:7d`、`older_than:1y`、`larger:5M`、`category:promotions`，可用 `OR` / `AND` / 圆括号。

## 列表分页

```bash
# 一次拿够（NDJSON，一行一页）
gws gmail users messages list --params '{"userId":"me","q":"newer_than:30d"}' --page-all

# 合并所有页的 messages 数组
gws gmail users messages list --params '{"userId":"me","q":"newer_than:30d"}' --page-all \
  | jq -s 'map(.messages // []) | add | length'
```

## 注意

- 列表接口（`messages list`）返回的只有 `{id, threadId}`，**正文需要再 get**。批量场景可以并行 `get` 或用 `batchGet`（schema 里查）。
- 删邮件用 `trash` 比 `delete` 安全（进垃圾箱可恢复）：`gws gmail users messages trash --params '{"userId":"me","id":"<id>"}'`。
- 涉及他人/敏感信息时，先用 `--dry-run` 看请求体。
