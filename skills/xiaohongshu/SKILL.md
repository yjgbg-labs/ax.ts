# xiaohongshu

`ax.ts xiaohongshu` 通过 `ax.ts agent-browser` wrapper（session 名 `xiaohongshu`）操作小红书创作者平台。登录态、cookie 自动持久化在 `%USERPROFILE%\.ax\sessions\xiaohongshu`。

**这个 skill 只发图文笔记**：必须有图，文本仅支持可选的短标题 + 一行 `#tag` 标签。纯文字笔记不支持——交给上游生图工具配图后再调本工具。

## 命令

```bash
ax.ts xiaohongshu login                       # 短信登录（自动用有头窗口，登录态保存）
ax.ts xiaohongshu status [--headed] [--json]  # 查看登录状态
ax.ts xiaohongshu publish --images <paths> [--tags <list>] [--title <text>] [--headed] [--json]
```

## publish 参数

| 参数 | 必填 | 说明 |
|------|------|------|
| `--images <paths>` | ✓ | 图片路径，逗号分隔（如 `a.jpg,b.jpg`）。支持 WSL 路径，自动 `wslpath -w` 转 Windows 路径 |
| `--tags <tags>` |  | 标签，逗号分隔；提交时作为一行 `#tag1 #tag2 ...` 写入正文 |
| `--title <text>` |  | 标题（≤20 字），不传则留空 |
| `--headed` |  | 强制有头浏览器（自动 close 当前 session 再以有头窗口重启） |
| `--json` |  | 输出结构化 JSON |

## 浏览器窗口策略

- **`login`**：未登录时用有头窗口（短信验证码必须人工输入）；已登录直接返回。
- **`status` / `publish`**：默认无头；传 `--headed` 时先 `close --session xiaohongshu` 再以有头模式重启。
- 登录态在两种模式间共享。

## 发布流程（自动化的 9 步）

1. navigate 到 publish 页（如被重定向到 `/login` 直接报错让用户先 login）
2. snapshot 找出所有 "上传图文" 标签 ref，挨个 click（命中真正的 tab 切换器）
3. 对每张图：`wslpath -w` 转 Windows 路径 → `upload input[type="file"] <win>`
4. 等编辑器 SPA 渲染完成，重新 snapshot
5. 从 snapshot 用正则提取 titleRef / contentRef / publishRef
6. 可选填标题
7. 把 tags 拼成 `#a #b #c` 一行填进正文
8. click 发布
9. 轮询 URL 含 `/publish/success` 即视为成功

## 示例

```bash
# 首次使用：登录
ax.ts xiaohongshu login

# 检查登录状态
ax.ts xiaohongshu status

# 最简：一张图 + 几个标签
ax.ts xiaohongshu publish --images /mnt/c/Users/me/Pictures/cover.jpg --tags "日常,生活"

# 多图 + 标题 + 标签
ax.ts xiaohongshu publish \
  --images /path/photo1.jpg,/path/photo2.jpg \
  --title "今日份快乐" \
  --tags "plog,日常"

# 有头模式（看着流程跑，调试用）
ax.ts xiaohongshu publish --headed --images pic.jpg --tags "测试"

# 手动关闭浏览器（不影响下次自动启动，登录态保留）
ax.ts agent-browser --session xiaohongshu close

# 彻底删除登录态（下次需要重新登录）
ax.ts agent-browser --session xiaohongshu delete
```

## 限制 / 已知陷阱

- **必须有图**：传 `--images` 是硬约束。要发纯文字，先用别的工具把文字生成图片（备忘录截图、文字配图工具等），再调本命令。
- **同名 session 单实例**：Chrome 的 user-data-dir 锁，不能并行跑两个 xiaohongshu publish。
- **路径必须是 Windows 可解析的**：WSL 路径自动转换；其他形态（如 UNC 共享）未测过。
- **标签是写入正文的 `#tag` 文本**，不是从下拉建议里选的"官方标签"。如果你介意官方标签的统计/分发待遇，自己手动加。
- **发布页 DOM 改版**会让正则失配：失败时跑 `ax.ts xiaohongshu publish --headed ... --json` 看出错点，按 snapshot 调正则。
