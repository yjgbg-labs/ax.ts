---
name: prometheus
description: >
  查询 VictoriaMetrics 监控指标。需要了解系统状态、资源使用、服务健康时使用此技能。
  用户说"看一下内存/CPU/流量/磁盘"、"监控怎么样"、"xxx 服务健康吗"、"juicefs 状态"时主动使用。
allowed-tools:
  - Bash(ax.ts prometheus*)
---

# prometheus

VictoriaMetrics 部署在 `http://vm.yjgbg.lab`，通过 `ax.ts prometheus` 查询。

## 命令

```bash
ax.ts prometheus query '<promql>'    # 即时查询
ax.ts prometheus metrics [filter]    # 列出 metric 名（可按关键字过滤）
```

## 可用 Metric 分类

| 前缀 | 覆盖内容 |
|------|----------|
| `node_*` | 路由器/节点：CPU、内存、网络、磁盘、连接数 |
| `container_*` | 容器：CPU、内存、文件系统 |
| `mihomo_*` | 代理：连接数、上下行流量、内存、线程 |
| `juicefs_*` | 分布式文件系统：FUSE ops、缓存、元数据、对象存储 |
| `redis_*` | Redis：内存、命中率、连接、命令、持久化 |

## 常用 PromQL 示例

```bash
# 节点负载
ax.ts prometheus query 'node_load1'
ax.ts prometheus query 'node_load5'

# 内存使用率（路由器）
ax.ts prometheus query '1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes'

# 网络流量（入/出，bytes/s）
ax.ts prometheus query 'rate(node_network_receive_bytes_total[5m])'
ax.ts prometheus query 'rate(node_network_transmit_bytes_total[5m])'

# 容器内存
ax.ts prometheus query 'container_memory_usage_bytes'

# mihomo 代理流量
ax.ts prometheus query 'rate(mihomo_download_bytes_total[5m])'
ax.ts prometheus query 'rate(mihomo_upload_bytes_total[5m])'
ax.ts prometheus query 'mihomo_connections'

# JuiceFS 空间
ax.ts prometheus query 'juicefs_used_space'
ax.ts prometheus query 'juicefs_total_space'

# Redis 内存
ax.ts prometheus query 'redis_memory_used_bytes'
ax.ts prometheus query 'redis_memory_used_bytes / redis_memory_max_bytes'

# 所有服务是否在线
ax.ts prometheus query 'up'
```

## 使用技巧

- 不知道 metric 全名时，先用 `metrics <关键字>` 搜索，再 `query`
- counter 类 metric（`_total` 结尾）需要用 `rate()` 或 `increase()` 才有意义
- 多个 label 时结果会有多行，每行对应一个 time series
