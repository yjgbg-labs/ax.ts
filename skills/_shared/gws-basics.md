# gws basics — shared reference

`gws` 是 Google Workspace CLI（npm 包 `@googleworkspace/cli`，全局已装）。所有 `gws-*` skill 都基于它，本文是通用语法、认证、输出格式参考——具体某个服务的用法请看对应 skill。

## 调用模式

两种：
1. **Helper 命令**：`gws <service> +<helper> [flags]` —— 高频任务的快捷封装，flag 自然语言、自带示例。优先用。
2. **Raw API**：`gws <service> <resource> [sub-resource] <method> [flags]` —— 直接映射到 Google API。能力全但要查 schema。

```bash
# helper 例
gws gmail +send --to a@b.com --subject 'Hi' --body 'Hello'

# raw 例
gws drive files list --params '{"pageSize": 10}'
```

## 通用 flag

| flag | 作用 |
|---|---|
| `--params <JSON>` | URL / query 参数 |
| `--json <JSON>` | 请求体（POST/PATCH/PUT 用） |
| `--upload <PATH>` | 上传本地文件（multipart） |
| `--upload-content-type <MIME>` | 显式 MIME（默认按扩展名推断） |
| `--output <PATH>` | 二进制响应写入文件 |
| `--format <FMT>` | `json`（默认）/ `table` / `yaml` / `csv` |
| `--api-version <VER>` | 覆盖 API 版本（如 `v2`、`v3`） |
| `--page-all` | 自动分页，每页一行 NDJSON |
| `--page-limit <N>` | 配合 `--page-all`，默认 10 页 |
| `--page-delay <MS>` | 配合 `--page-all`，默认 100ms |
| `--dry-run` | 本地校验请求，不实发 |
| `--sanitize <TPL>` | 用 Model Armor 模板过滤响应（敏感场景） |

## 查 API schema

不确定 raw 调用的字段时：
```bash
gws schema drive.files.list
gws schema drive.files.list --resolve-refs
```

返回该 method 的请求/响应 JSON Schema，可以直接照着填 `--params` / `--json`。

## 认证

凭据优先级（高到低）：
1. `GOOGLE_WORKSPACE_CLI_TOKEN` —— 预先拿到的 access token，最高优先
2. `GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE` —— OAuth 凭据 JSON 路径
3. `~/.config/gws/` 下默认配置目录

可通过 `GOOGLE_WORKSPACE_CLI_CONFIG_DIR` 覆盖默认目录。

首次使用要 `gws auth login`（需 `GOOGLE_WORKSPACE_CLI_CLIENT_ID` + `..._CLIENT_SECRET`）。**敏感凭据应通过 vault skill 取**，不要让用户粘贴明文。

## 输出处理建议

- **管道处理**：默认 JSON，配合 `jq` 用最顺。`--format table` 给人看，`--format csv` 灌表格。
- **分页**：列表类调用务必加 `--page-all`，否则只拿首页（默认 50–100 条）；NDJSON 一行一页，用 `jq -s 'map(.items[])'` 合并。
- **二进制**：下载附件、文件用 `--output PATH`，否则 base64 会写到 stdout 撑爆 context。

## 常见坑

- `--params` 和 `--json` 都是**JSON 字符串**，单引号包裹避免 shell 转义。
- Google API 的 `userId` 几乎都填 `"me"`（当前认证账号）。
- 分页字段叫 `pageToken`，不是 `nextPageToken`（响应里有 `nextPageToken`，下一次请求把它放进 `params.pageToken`）。
- 写表格时 `valueInputOption` 要选对：`RAW`（按字面写）vs `USER_ENTERED`（解析公式/日期）。
