---
name: find-docs
description: >
  通过 Context7 查询第三方库的最新官方文档。引入新依赖、不确定 API 用法、需要查看某个库的文档时使用此技能。
  用户说"查一下 xxx 的文档"、"xxx 怎么用"、"帮我查查 xxx API" 时主动使用。
  适合查询具体库的用法，不适合通用概念性问题（用 research 技能）。
allowed-tools:
  - Bash(bunx ctx7*)
---

# find-docs

通过 `bunx ctx7` 查询第三方库的官方文档，始终获取最新版本内容。

## 两步工作流

### 第一步：找到库的 Context7 ID

```bash
bunx ctx7 library <库名> [相关查询]
```

输出会列出候选库及其 ID（如 `/reactjs/react.dev`），选择 Source Reputation 高、Benchmark Score 高的。

### 第二步：查询具体文档

```bash
bunx ctx7 docs <libraryId> <查询内容>
```

## 示例

```bash
# 查 Bun 的文件 API
bunx ctx7 library bun "file api"
bunx ctx7 docs /oven-sh/bun "how to read and write files"

# 查 ZIO 的并发用法
bunx ctx7 library zio "concurrency"
bunx ctx7 docs /zio/zio "fiber and concurrency"

# 查 Remix 的路由
bunx ctx7 library remix "routing"
bunx ctx7 docs /remix-run/remix "file-based routing"
```

## 注意

- `bunx ctx7` 每次调用会有依赖解析开销，属正常现象
- 如果第一步返回多个候选，优先选 Source Reputation 为 High 且 Benchmark Score 最高的
- 查询内容越具体，返回文档越精准
