---
name: gws-sheets
description: >
  通过 gws CLI 操作 Google Sheets：读单元格 / 范围、追加行、写入、清空、批量更新、
  新建表格、改格式。用户说"读一下表格"、"追加一行到 xxx 表"、"把 xxx 写到 Sheet"、
  "查 Sheet 里的数据"、"创建一个 Sheet"、"清空 A 列" 时使用此技能。
allowed-tools:
  - Bash(gws*)
---

# gws-sheets

`gws sheets` 读写 Google Sheets。通用语法、`--params/--json/--format`、认证见 [[gws-basics]]（`skills/_shared/gws-basics.md`）。

## 优先用 helper

| Helper | 作用 |
|---|---|
| `+read` | 从指定范围读 values |
| `+append` | 追加一行到表 |

### 读

```bash
# 默认整个第一个 sheet
gws sheets +read --spreadsheet <SPREADSHEET_ID>

# 指定范围（A1 表示法）
gws sheets +read --spreadsheet <ID> --range 'Sheet1!A1:D20'
gws sheets +read --spreadsheet <ID> --range '数据!B:B'        # 整列

# 表格输出（人看）
gws sheets +read --spreadsheet <ID> --range 'Sheet1!A1:D20' --format table

# CSV（喂下游工具）
gws sheets +read --spreadsheet <ID> --range 'Sheet1!A:Z' --format csv > out.csv
```

### 追加一行

```bash
gws sheets +append --spreadsheet <ID> --range 'Sheet1' \
  --values '["2026-05-20", "BTC", 79790, "no-op"]'

# JSON values 数组，每个元素就是一格；按出现顺序写到下一空行
```

## Raw API（精细控制）

资源：`gws sheets spreadsheets [values] <method>`。

### Range 表示法（A1 notation）

- `'Sheet1!A1'` 单格
- `'Sheet1!A1:C10'` 矩形区域
- `'Sheet1!A:A'` 整列
- `'Sheet1!1:1'` 整行
- `'Sheet1'` 整个 sheet
- `'数据'` 中文 sheet 名也行；含空格/特殊字符需单引号包裹：`"'Sales Data'!A1"`

### 读

```bash
# 单个范围
gws sheets spreadsheets values get --params '{
  "spreadsheetId":"<ID>",
  "range":"Sheet1!A1:D20",
  "valueRenderOption":"FORMATTED_VALUE"
}'

# 多范围（batchGet）
gws sheets spreadsheets values batchGet --params '{
  "spreadsheetId":"<ID>",
  "ranges":["Sheet1!A1:B5","Sheet2!C:C"]
}'
```

**`valueRenderOption`**：
- `FORMATTED_VALUE`（默认）—— 显示值，日期/货币按格式串呈现
- `UNFORMATTED_VALUE` —— 原始数字 / 日期序列号
- `FORMULA` —— 拿公式本身

### 写 / 覆盖

```bash
# 覆盖某范围
gws sheets spreadsheets values update --params '{
  "spreadsheetId":"<ID>",
  "range":"Sheet1!A1:B2",
  "valueInputOption":"USER_ENTERED"
}' --json '{
  "values":[
    ["Name","Score"],
    ["Alice",95]
  ]
}'
```

**`valueInputOption`**：
- `RAW` —— 按字面写入，`=A1+1` 是字符串
- `USER_ENTERED` —— 像用户在 UI 输入，解析公式、日期、百分号

### 追加（不覆盖）

```bash
gws sheets spreadsheets values append --params '{
  "spreadsheetId":"<ID>",
  "range":"Sheet1!A1",
  "valueInputOption":"USER_ENTERED",
  "insertDataOption":"INSERT_ROWS"
}' --json '{"values":[["2026-05-20","BTC",79790]]}'
```

`range` 给一个起点，sheet 会自己找下一空行追加。

### 清空

```bash
gws sheets spreadsheets values clear --params '{
  "spreadsheetId":"<ID>",
  "range":"Sheet1!A2:Z"
}' --json '{}'
```

### 批量写（一次多个范围）

```bash
gws sheets spreadsheets values batchUpdate --params '{"spreadsheetId":"<ID>"}' --json '{
  "valueInputOption":"USER_ENTERED",
  "data":[
    {"range":"Sheet1!A1","values":[["Title"]]},
    {"range":"Sheet2!B2:C3","values":[[1,2],[3,4]]}
  ]
}'
```

### 新建表格 / 加 sheet 页

```bash
# 新建 spreadsheet
gws sheets spreadsheets create --json '{
  "properties":{"title":"我的新表"},
  "sheets":[{"properties":{"title":"Data"}}]
}'

# 在已有 spreadsheet 加一个新 sheet 页
gws sheets spreadsheets batchUpdate --params '{"spreadsheetId":"<ID>"}' --json '{
  "requests":[{"addSheet":{"properties":{"title":"NewTab"}}}]
}'
```

`spreadsheets batchUpdate`（注意：和 `values batchUpdate` 不同！）是结构性变更入口，覆盖添加/删除 sheet、改格式、合并单元格、设条件格式、冻结行列、过滤、保护范围等等——能力非常大，用前 `gws schema sheets.spreadsheets.batchUpdate --resolve-refs` 看 request 类型。

### 元信息

```bash
# 看有几个 sheet、各自 ID 和大小
gws sheets spreadsheets get --params '{
  "spreadsheetId":"<ID>",
  "fields":"properties.title,sheets(properties(sheetId,title,gridProperties))"
}'
```

## 注意

- 写之前必须确认 **`valueInputOption`**：写公式或日期一定要 `USER_ENTERED`，纯数据建议 `RAW` 避免被自动解析（比如 `0123` 会被吃掉前导 0）。
- 追加用 `values append`（自动找下一空行），不要 `values update` 到一个手算的 range。
- `values batchUpdate` 是改数据，`spreadsheets batchUpdate` 是改结构——别搞混。
- 行列编号：Sheets API 是**0-based**（`startRowIndex:0` 是第 1 行），但 A1 表示法是 1-based。
