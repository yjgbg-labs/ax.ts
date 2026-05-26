# 技术栈偏好

## JavaScript / TypeScript

- 运行时与包管理：使用 **bun**，按需通过 `bunx` 调用工具，不全局安装任何 JS 工具。
- 语言：只写 **TypeScript**，不写裸 JS。
- 框架偏好：**Remix**、**Tailwind CSS**。

## Python

- 包管理：一律使用 **uv**，禁止使用 pip / poetry 等。

## Scala

- 构建工具：使用 **scala-cli**（本机 `scala` 命令即 scala-cli，无需额外安装），不使用 SBT / Mill。
- 库偏好：**ZIO** 技术栈。

## 通用

引入任何第三方包前，先通过 **ctx7** 查阅文档，确认使用最新稳定版本。
