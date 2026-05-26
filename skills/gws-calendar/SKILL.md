---
name: gws-calendar
description: >
  通过 gws CLI 操作 Google Calendar：看今日 / 本周日程、新建事件（含 Meet 链接）、
  查 / 改 / 删事件、批量列事件、查 free/busy、列日历列表。用户说"今天有什么会"、
  "明天的日程"、"建个会议"、"约 xxx 开会"、"看看 xxx 有空吗"、"删掉那个会" 时使用此技能。
allowed-tools:
  - Bash(gws*)
---

# gws-calendar

`gws calendar` 操作 Google Calendar。通用语法、`--params/--json/--format`、认证见 [[gws-basics]]（`skills/_shared/gws-basics.md`）。

## 优先用 helper

| Helper | 作用 |
|---|---|
| `+agenda` | 看议程（今天 / 明天 / 本周 / 未来 N 天） |
| `+insert` | 创建事件（可选 Meet、attendee） |

### 看议程

```bash
gws calendar +agenda                            # 默认（近期事件）
gws calendar +agenda --today
gws calendar +agenda --tomorrow
gws calendar +agenda --week --format table
gws calendar +agenda --days 3                   # 未来 3 天
gws calendar +agenda --days 7 --calendar 'Work' # 过滤某个日历
gws calendar +agenda --today --timezone America/New_York
```

默认查所有日历，时区跟随账号；只读，不会修改。

### 新建事件

```bash
# 基本
gws calendar +insert \
  --summary 'Standup' \
  --start '2026-06-17T09:00:00+08:00' \
  --end   '2026-06-17T09:30:00+08:00'

# 带地点、描述、参会人
gws calendar +insert --summary 'Design review' \
  --start '2026-06-17T14:00:00+08:00' --end '2026-06-17T15:00:00+08:00' \
  --location '5F Meeting Room' \
  --description '讨论 Q3 roadmap' \
  --attendee alice@example.com --attendee bob@example.com

# 自动加 Google Meet 链接
gws calendar +insert --summary '1:1' \
  --start '2026-06-17T16:00:00+08:00' --end '2026-06-17T16:30:00+08:00' \
  --attendee alice@example.com --meet

# 指定日历（默认 primary）
gws calendar +insert --calendar work@example.com --summary 'Sync' \
  --start ... --end ...
```

**时间格式**：RFC3339（ISO 8601 + 时区偏移），如 `2026-06-17T09:00:00+08:00` 或 `Z`（UTC）。

## Raw API

### 列事件

```bash
# 时间范围查询（强烈推荐 timeMin/timeMax + singleEvents=true + orderBy=startTime）
gws calendar events list --params '{
  "calendarId":"primary",
  "timeMin":"2026-05-20T00:00:00+08:00",
  "timeMax":"2026-05-27T00:00:00+08:00",
  "singleEvents":true,
  "orderBy":"startTime",
  "maxResults":50
}'

# 关键词搜索
gws calendar events list --params '{
  "calendarId":"primary",
  "q":"design review",
  "timeMin":"2026-01-01T00:00:00Z"
}'

# 全量翻页
gws calendar events list --params '{"calendarId":"primary","singleEvents":true}' --page-all
```

**关键参数**：
- `singleEvents:true` —— 把循环事件展开成单次实例（否则只看到 master event）。**几乎总是要加。**
- `orderBy:"startTime"` —— 仅在 `singleEvents:true` 时可用，按开始时间排
- `showDeleted:true` —— 看已删除的（默认隐藏）
- `timeZone:"Asia/Shanghai"` —— 响应里 `start.dateTime` 用该时区呈现

### 单事件读 / 改 / 删

```bash
# 读详情
gws calendar events get --params '{"calendarId":"primary","eventId":"<eventId>"}'

# 改（patch 只发要改的字段）
gws calendar events patch --params '{"calendarId":"primary","eventId":"<eventId>"}' \
  --json '{
    "summary":"Standup (rescheduled)",
    "start":{"dateTime":"2026-06-17T10:00:00+08:00"},
    "end":{"dateTime":"2026-06-17T10:30:00+08:00"}
  }'

# 加 / 改参会人（注意：events.patch 用整个 attendees 数组覆盖，要保留原有的先 get 再合并）
gws calendar events patch --params '{"calendarId":"primary","eventId":"<eventId>","sendUpdates":"all"}' \
  --json '{"attendees":[{"email":"alice@x.com"},{"email":"bob@x.com"}]}'

# 删除
gws calendar events delete --params '{"calendarId":"primary","eventId":"<eventId>","sendUpdates":"all"}'

# 移动到另一个日历
gws calendar events move --params '{
  "calendarId":"primary",
  "eventId":"<eventId>",
  "destination":"work@example.com"
}'
```

**`sendUpdates`**：`all` / `externalOnly` / `none`，控制是否给参会人发通知邮件。改时间或删会议建议 `all`。

### 创建（raw，比 +insert 灵活）

```bash
gws calendar events insert --params '{"calendarId":"primary","sendUpdates":"all","conferenceDataVersion":1}' \
  --json '{
    "summary":"Quarterly planning",
    "start":{"dateTime":"2026-07-01T09:00:00+08:00","timeZone":"Asia/Shanghai"},
    "end":{"dateTime":"2026-07-01T11:00:00+08:00","timeZone":"Asia/Shanghai"},
    "attendees":[{"email":"alice@x.com"},{"email":"bob@x.com"}],
    "recurrence":["RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=10"],
    "conferenceData":{"createRequest":{"requestId":"unique-id-001","conferenceSolutionKey":{"type":"hangoutsMeet"}}},
    "reminders":{"useDefault":false,"overrides":[{"method":"popup","minutes":10}]}
  }'
```

**全天事件**：用 `start.date` / `end.date`（`YYYY-MM-DD`），不要用 `dateTime`。`end.date` 是开区间（结束日的次日）。

**RRULE**（重复规则）：`RRULE:FREQ=DAILY|WEEKLY|MONTHLY|YEARLY[;BYDAY=MO,TU][;COUNT=N|UNTIL=YYYYMMDDTHHMMSSZ][;INTERVAL=N]`。

### Free/Busy 查询

```bash
gws calendar freebusy query --json '{
  "timeMin":"2026-06-17T00:00:00+08:00",
  "timeMax":"2026-06-17T23:59:59+08:00",
  "timeZone":"Asia/Shanghai",
  "items":[
    {"id":"alice@example.com"},
    {"id":"bob@example.com"}
  ]
}'
```

返回每个日历的繁忙时段（不返回事件标题，仅 busy 区间），用来找共同空档。

### 列我所有日历

```bash
gws calendar calendarList list --params '{}' --format table
```

## 注意

- **时区一律带在 ISO 字符串里**（`+08:00`、`Z`），不要写裸 `2026-06-17T09:00:00`——Google 会按账号默认时区猜，跨时区协作必出错。
- 列事件**默认不展开循环**：忘了加 `singleEvents:true` 会拿不到具体某周的实例。
- `update` 是整体替换，`patch` 只改给定字段——95% 场景用 `patch`。
- 改 / 删别人也参加的会议时，根据需要设 `sendUpdates`，默认可能是 `none` 不发通知。
- 创建带 Meet 链接的事件用 raw API 时记得加 `conferenceDataVersion:1` 这个 query 参数，否则 `conferenceData.createRequest` 不生效。
