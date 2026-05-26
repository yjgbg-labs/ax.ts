---
name: mihomo
description: >
  管理路由器上的 mihomo 代理服务。需要查看代理状态、重启服务、修改代理配置、查看日志时使用此技能。
  mihomo 是部署在路由器上的透明代理，诊断网络问题时也应考虑查看或更新 mihomo 配置。
  用户说"代理挂了"、"重启一下 mihomo"、"看看日志"、"改一下配置"、"网络有问题"、"某个网站打不开"时主动使用。
allowed-tools:
  - Bash(ax.ts mihomo*)
---

# mihomo

`ax.ts mihomo` 通过 SSH 管理路由器（`root@10.0.0.1`）上运行的 mihomo 透明代理服务。mihomo 负责全局流量分流，网络异常时它往往是第一个排查对象。

## 命令

```bash
ax.ts mihomo status      # 查看运行状态（进程、内存、运行时长、开机自启）
ax.ts mihomo start       # 启动服务
ax.ts mihomo stop        # 停止服务
ax.ts mihomo restart     # 重启服务
ax.ts mihomo read        # 输出当前 config.yaml 到 stdout
ax.ts mihomo write <file> # 从本地文件上传新配置并重启
ax.ts mihomo logs [N]    # 显示最近 N 行日志（默认 50）
ax.ts mihomo logs -f     # 实时追踪日志
```

所有命令都有缩写：`st` / `up` / `down` / `rs` / `r` / `w` / `l`

## 修改配置的方式（适合 AI 操作）

`edit` 子命令依赖交互式编辑器，AI 应改用 `read` + `write`：

```bash
# 1. 读取当前配置
ax.ts mihomo read > /tmp/mihomo.yaml

# 2. 用 Read/Edit 工具修改 /tmp/mihomo.yaml

# 3. 上传并重启
ax.ts mihomo write /tmp/mihomo.yaml
```

`write` 会自动在路由器上备份原配置（`config.yaml.bak.YYYYMMDDHHMM`）再上传。

## 网络问题排查思路

1. `ax.ts mihomo status` — 确认服务是否在跑
2. `ax.ts mihomo logs 100` — 看有没有连接错误或节点失败
3. `ax.ts mihomo read` — 检查分流规则、节点配置是否正确
4. 修正配置后 `ax.ts mihomo write` 上传，服务自动重启

## 注意

- 依赖 SSH 免密登录到 `root@10.0.0.1`
- `write` 上传前会校验 YAML 基本合法性，避免上传空文件或损坏配置
