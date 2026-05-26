---
name: vault
description: >
  读写路由器上的 vault 密钥存储（SSH 后端，单文件 JSON）。需要用到任何凭据、密钥、token、
  密码、TOTP 时，优先通过此技能获取，不要让用户手动粘贴敏感信息。用户说"从 vault 里取"、
  "存到 vault"、"有没有 xxx 的密钥"、"给我个 TOTP 验证码"时主动使用。
allowed-tools:
  - Bash(ax.ts vault*)
---

# vault

`ax.ts vault` 是路由器（`root@10.0.0.1`）上 `/etc/vault.json` 的命令行客户端。后端通过 SSH 原子读写一个 JSON 数组，每条记录为 `{ key, value, type }`，type 为 `simple` 或 `totp`。

## 命令

```bash
ax.ts vault list                # 列出所有 key，左边小图标标记 type
ax.ts vault get <key>           # 取值；type=totp 时自动返回当前 6 位 OTP
ax.ts vault put <key>           # 交互式（隐藏输入）写入 simple key
ax.ts vault put <key> --totp    # 同上，但值必须是合法 base32，type 存为 totp
ax.ts vault delete <key>        # 删除
```

`list` 输出图标含义：

| 图标 | type | 含义 |
|---|---|---|
| 🔑 | simple | 普通密钥/token/密码 |
| 🔢 | totp | TOTP 共享密钥（base32 编码） |

## 示例

### 拿一个 API key 用

```bash
TOKEN=$(ax.ts vault get openrouter_management_key)
curl -H "Authorization: Bearer $TOKEN" https://openrouter.ai/api/v1/...
```

### 存新凭据（不要把值写到 shell history）

```bash
# 交互式：终端会提示输入，输入过程不回显
ax.ts vault put my_service_token

# 脚本场景从 stdin 喂：
echo "sk-abc123" | ax.ts vault put my_service_token

# 从另一个命令链式读入：
op item get "Some Service" --field=credential | ax.ts vault put some_service
```

### TOTP

```bash
# 存 TOTP secret（注册某个服务时把 base32 secret 存进来）
ax.ts vault put totp/github --totp
# 终端提示输入，粘贴 base32 secret 即可

# 之后每次需要登录时直接取当前 6 位码
ax.ts vault get totp/github
# 输出：719794
```

约定：**TOTP key 用 `totp/<service>` 命名**，list 时一眼分类，避免和普通密钥混杂。

### 列表过滤常见模式

```bash
ax.ts vault list                                       # 全部
ax.ts vault list | grep '^🔢'                          # 只看 TOTP
ax.ts vault list | grep -E '^🔑.*github'               # github 相关的普通 key
```

## 在 TS 脚本中作为库使用

避免子进程 + SSH 握手开销（多次操作时尤其值得），直接 import：

```typescript
import { get, getEntry, put, list, del, totp } from "agents/libs/vault";

// 简单读
const token = await get("github_token");

// 想拿到 type 信息一起
const e = await getEntry("totp/github");
if (e.type === "totp") console.log(await totp(e.value));

// 写
await put("my_token", "sk-abc", "simple");
await put("totp/svc", "JBSWY3DPEHPK3PXP", "totp");
```

## 注意

- 后端是 `ssh root@10.0.0.1 cat/write /etc/vault.json`，需要 SSH 免密配置好。在路由器不可达时全部命令会失败。
- `put` 永远从 stdin 读值，不接受命令行位置参数 — 避免敏感值进 shell history。
- 任意 key 路径都行，**`/` 是允许字符**，用来做命名空间分组（如 `totp/x`、`db/prod-mysql`）。
- `get` 在 `type=totp` 时直接返回当前 6 位 OTP；如果需要拿原始 base32 secret（迁移设备等），直接 `ssh root@10.0.0.1 'cat /etc/vault.json' | jq` 找对应条目。
- 每次写都是 load-modify-save 全量重写，并发写有 last-write-wins 风险 — 当前低频管理用途下可接受。
