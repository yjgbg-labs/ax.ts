---
name: quickwit
description: >
  搜索 Quickwit 中的日志和事件。需要查看 Kubernetes 容器日志、诊断 Pod 问题、
  搜索 agent 历史事件时使用此技能。
  用户说"看一下日志"、"xxx pod 报什么错"、"查一查某个 namespace 的日志"时主动使用。
allowed-tools:
  - Bash(ax.ts quickwit*)
---

# quickwit

Quickwit 部署在 `http://quickwit.yjgbg.lab`，通过 `ax.ts quickwit` 查询。

## 索引

| 索引 | 内容 |
|------|------|
| `otel-logs-v0_7` | Kubernetes 所有 Pod 的容器日志（OpenTelemetry） |
| `otel-traces-v0_7` | 分布式追踪数据 |
| `agent-events` | Claude Code agent 的事件记录 |

## 命令

```bash
# 搜索 Kubernetes 日志
ax.ts quickwit logs [query] [--namespace NS] [--pod POD] [--container C] [--limit N]

# 搜索 agent 事件
ax.ts quickwit events [query] [--agent AGENT] [--type TYPE] [--session ID] [--limit N]

# 原始搜索任意索引（输出 JSON）
ax.ts quickwit search <index> [query] [--limit N]

# 列出所有索引
ax.ts quickwit indexes
```

## 常用示例

```bash
# 某个 namespace 的最新日志
ax.ts quickwit logs --namespace default --limit 50

# 某个 Pod 的日志
ax.ts quickwit logs --pod my-pod-abc123

# 关键字搜索（跨所有日志）
ax.ts quickwit logs "error" --limit 30
ax.ts quickwit logs "OOMKilled" --limit 10

# 某个 namespace 内关键字搜索
ax.ts quickwit logs "failed" --namespace juicefs --limit 20

# 查看最近的 agent 事件
ax.ts quickwit events --limit 20

# 查某个 agent 的事件
ax.ts quickwit events --agent copilot --limit 20
```

## 查询语法

- 全文搜索：直接写关键词，如 `error`、`OOMKilled`
- 字段过滤通过 `--namespace`、`--pod`、`--container` 参数传入，不需要手写字段名
- `--limit` 默认 50（logs）/ 20（events），最多建议 100
