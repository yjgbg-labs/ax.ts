# zhihu

`ax.ts zhihu` 查看知乎问题、回答和评论。通过 Chrome CDP (agent-browser) 抓取页面并提取结构化内容。

## 命令

```bash
ax.ts zhihu <url>                     # 查看指定问答页的问题和回答内容
ax.ts zhihu <url> --comments          # 同时展开并显示评论（需要 JS 执行）
ax.ts zhihu <url> --json              # 输出结构化 JSON 而非文本
```

## 示例

```bash
# 查看问题及回答
ax.ts zhihu https://www.zhihu.com/question/22796619

# 查看特定回答
ax.ts zhihu https://www.zhihu.com/question/22796619/answer/2042624060656505856

# 查看回答及评论
ax.ts zhihu https://www.zhihu.com/question/22796619/answer/2042624060656505856 --comments

# JSON 输出（方便 AI / 脚本消费）
ax.ts zhihu https://www.zhihu.com/question/22796619 --json
```

## 工作原理

1. 检查是否已有 Chrome CDP 连接（端口 19222），无则启动
2. 通过 agent-browser 导航到目标 URL
3. 通过 DOM eval（`extract.js`）提取页面结构化数据：
   - 标题、话题标签
   - 关注者数、浏览数
   - 回答列表（作者、赞同数、评论数、时间、地点、正文）
4. `--comments` 时，先通过 JS 点击评论展开按钮，再用 `comments.js` 提取评论

## 依赖

- Chrome for Testing（由 agent-browser 自动管理）
- 代理（默认 `http://10.0.0.1:7890`，可设 `ZHIHU_PROXY` 覆盖）：知乎屏蔽非中国 IP

## 限制

- 评论区展开可能需要登录，未登录时评论可能无法加载
- 首次抓取需要 Chrome 启动时间（约 10-30 秒），后续调用复用已有会话
- 页面抓取依赖知乎 DOM 结构，知乎改版可能影响提取效果

## 文件结构

```
libs/zhihu/
  index.ts         # CLI 入口，命令路由、输出格式化
  extract.js        # 页面内容提取脚本（DOM eval）
  comments.js       # 评论提取脚本
  expand_comments.js # 评论展开脚本
  package.json      # 命令注册（name → ax.ts 子命令）
```
