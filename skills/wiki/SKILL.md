---
name: wiki
description: >
  操作个人 LLM Wiki（~/wiki）：从历史对话/文章 ingest 成结构化笔记、查询既往结论、
  维护页面连接、清理噪声会话。触发措辞：
  "记到 wiki 里"、"存下来"、"ingest 这个"、
  "查一下 wiki"、"wiki 里有 xxx 吗"、"之前研究过的 xxx"、
  "打捞历史对话"、"从 ccc/copilot/claude 导入"、"harvest 一下"、
  "这个对话没价值/拉黑"、"wiki 健康检查 / lint"。
allowed-tools:
  - Bash(ax.ts wiki*)
---

# wiki

`~/wiki/` 是用户的 LLM Wiki（[[llm-wiki]] pattern）。三层：

- `raw/` 原始资料（**只读**，你绝对不能改）
- `wiki/` 你写的结构化页面（entity / concept / source / overview）
- `CLAUDE.md` schema（页面格式与工作流的 source of truth）

**做任何写操作前先 `ax.ts wiki schema` 读完整约定**——本 skill 只是入口提示。

## 第一步永远是

```bash
ax.ts wiki schema     # 读完整约定
ax.ts wiki list       # cat index.md，看现状
```

不要凭印象操作 wiki。

## 触发场景 → 动作

| 用户说 | 你做 |
|---|---|
| "记到 wiki" / "存下来" / "ingest 这段" | Ingest 流程（schema 里有完整步骤） |
| "查 wiki 里的 xxx" / "之前研究过 xxx 吗" | `wiki search` → `wiki show` |
| "wiki 里有 xxx 吗" | `wiki list --tag T` 或 `wiki search` |
| "打捞历史对话" / "harvest" | `wiki harvest --dry-run` 先看，再去掉 dry-run |
| "只 harvest 某个 backend" | `wiki harvest --source ccc\|ccds\|mimo\|claude\|copilot` |
| "这个对话没价值" / "拉黑这个" / "永久跳过" | `wiki ignore <raw 文件路径>`（**会删文件 + 加黑名单**，下次 harvest 不会拉回来） |
| "wiki 健康检查" / "有没有死链" | `wiki lint` |
| "wiki 是空的" / 首次 | `wiki init` |

## 命令清单（细节看 schema）

```bash
ax.ts wiki list [--type T] [--tag T] [--limit N]
ax.ts wiki show <slug>
ax.ts wiki search <query> [--type T] [--limit N]
ax.ts wiki backlinks <slug>
ax.ts wiki graph [--from slug --depth N] [--format json|dot]

ax.ts wiki new <type> <slug> [--title T] [--tags t1,t2]
ax.ts wiki touch <slug> [--add-source S] [--add-tag T]
ax.ts wiki log-append <op> <message>

ax.ts wiki harvest [--source NAME] [--project P] [--since YYYY-MM-DD] [--min-turns N] [--dry-run]
ax.ts wiki ignore <raw-path>...   # 删文件并加入 .ignore 黑名单
ax.ts wiki lint
ax.ts wiki schema
```

## Harvest 现状

支持 5 个 backend，对话格式自动分发：

- claude 格式：`~/.ccc`、`~/.ccds`、`~/.mimo`、`~/.claude`
- copilot 格式：`~/.copilot`

输出到 `raw/conversations/<backend>/<file>.md`。`.ignore` 按 session_id 黑名单，删除文件不会自动加黑名单——用 `wiki ignore` 一步完成。

## 红线

- `raw/**` 绝对不写、不改、不重命名（只能通过 `wiki ignore` 删）
- 每次 ingest / 大批 harvest / lint 之后 `wiki log-append` 留痕
- Ingest 之前先跟用户讨论 takeaways 再动手——不要默不作声写一堆页面
- 怀疑 wiki 状态时，先 `wiki schema` + `wiki list`，不要凭记忆
