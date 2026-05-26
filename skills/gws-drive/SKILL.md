---
name: gws-drive
description: >
  通过 gws CLI 操作 Google Drive：列文件夹、搜文件、上传/下载、改权限、共享、移动、删除。
  用户说"找一下 xxx 文件"、"上传到 Drive"、"分享给 xxx"、"列一下文件夹"、
  "Drive 里 xxx 在哪"、"下载 Drive 上的 xxx"、"改个权限" 时使用此技能。
allowed-tools:
  - Bash(gws*)
---

# gws-drive

`gws drive` 操作当前账号的 Google Drive 文件、文件夹、共享盘和权限。通用语法、`--params/--json/--upload/--output`、认证见 [[gws-basics]]（`skills/_shared/gws-basics.md`）。

## 优先用 helper

| Helper | 作用 |
|---|---|
| `+upload` | 上传本地文件，自动推 MIME，可设父文件夹和重命名 |

### 上传

```bash
gws drive +upload ./report.pdf
gws drive +upload ./report.pdf --parent <FOLDER_ID>
gws drive +upload ./data.csv --name 'Sales 2026.csv'
```

## 文件 / 文件夹（`drive files`）

### 搜索 / 列出

```bash
# 最近的 10 个文件
gws drive files list --params '{"pageSize": 10, "orderBy":"modifiedTime desc"}'

# 名称模糊匹配 + 不在垃圾桶
gws drive files list --params '{
  "q": "name contains '\''季度报告'\'' and trashed=false",
  "pageSize": 20,
  "fields": "files(id,name,mimeType,parents,modifiedTime,owners(emailAddress))"
}'

# 某个文件夹下的内容
gws drive files list --params '{
  "q": "'\''<FOLDER_ID>'\'' in parents and trashed=false",
  "pageSize": 100
}'

# 全量翻页
gws drive files list --params '{"q":"trashed=false"}' --page-all
```

**`q` 查询语法关键操作符**：`name = / contains / != "..."`、`mimeType = "..."`、`'<id>' in parents`、`trashed=true/false`、`'user@x.com' in owners / writers / readers`、`modifiedTime > '2026-01-01T00:00:00'`、`fullText contains '关键词'`、`starred=true`、`sharedWithMe`。

**常用 mimeType**：
- 文件夹 `application/vnd.google-apps.folder`
- Doc `application/vnd.google-apps.document`
- Sheet `application/vnd.google-apps.spreadsheet`
- Slide `application/vnd.google-apps.presentation`
- PDF `application/pdf`
- 快捷方式 `application/vnd.google-apps.shortcut`

### 元信息 / 内容

```bash
# 元信息（指定要的 fields，省流量）
gws drive files get --params '{"fileId":"<id>","fields":"id,name,mimeType,size,webViewLink,parents,owners,permissions"}'

# 下载二进制文件（PDF/图片/普通文件）
gws drive files get --params '{"fileId":"<id>","alt":"media"}' --output ./downloaded.pdf

# 导出 Google 原生格式（Doc → docx，Sheet → xlsx 等）
gws drive files export --params '{
  "fileId":"<docId>",
  "mimeType":"application/vnd.openxmlformats-officedocument.wordprocessingml.document"
}' --output ./out.docx

# Sheet 导出为 csv
gws drive files export --params '{"fileId":"<sheetId>","mimeType":"text/csv"}' --output ./out.csv
```

**Google 原生文档要用 `export`**（不是 `get alt=media`），常见导出 MIME：
- Doc → `application/vnd.openxmlformats-officedocument.wordprocessingml.document` / `application/pdf` / `text/plain` / `text/markdown`
- Sheet → `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` / `text/csv`
- Slide → `application/vnd.openxmlformats-officedocument.presentationml.presentation` / `application/pdf`

### 新建 / 移动 / 复制 / 删除

```bash
# 新建文件夹
gws drive files create --json '{
  "name":"Project X",
  "mimeType":"application/vnd.google-apps.folder",
  "parents":["<parentFolderId>"]
}'

# 移动（增 + 删 parent）
gws drive files update --params '{
  "fileId":"<id>",
  "addParents":"<newFolderId>",
  "removeParents":"<oldFolderId>",
  "fields":"id,parents"
}'

# 重命名
gws drive files update --params '{"fileId":"<id>"}' --json '{"name":"新名字.pdf"}'

# 复制
gws drive files copy --params '{"fileId":"<id>"}' --json '{"name":"副本","parents":["<folderId>"]}'

# 删除（直接删 vs 进垃圾箱）
gws drive files update --params '{"fileId":"<id>"}' --json '{"trashed":true}'   # 进垃圾箱（可恢复）
gws drive files delete --params '{"fileId":"<id>"}'                              # 永久删除
```

## 权限 / 共享

```bash
# 看某文件的所有权限
gws drive permissions list --params '{"fileId":"<id>","fields":"permissions(id,type,role,emailAddress,displayName)"}'

# 共享给某人（reader / commenter / writer / fileOrganizer / organizer）
gws drive permissions create --params '{
  "fileId":"<id>",
  "sendNotificationEmail":false
}' --json '{
  "type":"user",
  "role":"writer",
  "emailAddress":"alice@example.com"
}'

# 设为"知道链接的人可看"
gws drive permissions create --params '{"fileId":"<id>"}' \
  --json '{"type":"anyone","role":"reader"}'

# 改角色
gws drive permissions update --params '{"fileId":"<id>","permissionId":"<pid>"}' \
  --json '{"role":"reader"}'

# 取消共享
gws drive permissions delete --params '{"fileId":"<id>","permissionId":"<pid>"}'
```

`role` 取值：`reader` / `commenter` / `writer` / `fileOrganizer` / `organizer` / `owner`（owner 需 transferOwnership 流程）。

## 共享盘（drives）

```bash
gws drive drives list --params '{"pageSize":50}'

# 在共享盘里搜索文件需要带这俩 flag
gws drive files list --params '{
  "driveId":"<sharedDriveId>",
  "corpora":"drive",
  "includeItemsFromAllDrives":true,
  "supportsAllDrives":true,
  "q":"name contains '\''xxx'\''"
}'
```

## 注意

- 列表默认只返回最小 fields，**几乎所有 list/get 都建议显式写 `fields`** 拿全想要的字段（否则 `mimeType`、`size` 等可能缺）。
- 下载文件时务必加 `--output`，否则二进制 base64 会灌进 stdout。
- 永久 `delete` 不可恢复，常规清理优先 `trashed=true`。
- 共享盘的搜索/读取必须加 `supportsAllDrives=true` + `includeItemsFromAllDrives=true`。
