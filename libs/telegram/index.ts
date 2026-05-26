#!/usr/bin/env bun

const VAULT_KEY = "telegram_yjgbg_claude_bot_token";

function vaultGet(key: string): string {
  const r = Bun.spawnSync(["ax.ts", "vault", "get", key], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) {
    console.error(`vault get ${key} failed: ${r.stderr.toString().trim()}`);
    process.exit(1);
  }
  return r.stdout.toString().trim();
}

async function api(method: string, body: Record<string, unknown>) {
  const token = vaultGet(VAULT_KEY);
  const url = `https://api.telegram.org/bot${token}/${method}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    console.error(`Telegram API error: ${res.status} ${await res.text()}`);
    process.exit(1);
  }
  return res.json();
}

async function discoverChatId(): Promise<number> {
  const env = Bun.env.TELEGRAM_CHAT_ID;
  if (env) return Number(env);
  try {
    const token = vaultGet(VAULT_KEY);
    const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates?limit=1`);
    const r = await res.json();
    const msg = r.result?.[0]?.message ?? r.result?.[0]?.channel_post;
    if (msg?.chat?.id) return msg.chat.id;
  } catch {}
  console.error(
    "无法确定默认 chat_id。请先给 bot 发一条消息，或通过 -c 指定，或设置 TELEGRAM_CHAT_ID 环境变量。"
  );
  process.exit(1);
}

function formatUpdate(u: any): string {
  const msg = u.message ?? u.channel_post ?? u.edited_message;
  if (!msg) return JSON.stringify(u);
  const from = msg.from?.username ?? msg.from?.first_name ?? msg.chat?.title ?? "unknown";
  const text = msg.text ?? msg.caption ?? `[${msg.photo ? "photo" : Object.keys(msg).filter(k => k !== "message_id" && k !== "date" && k !== "chat" && k !== "from").join(",")}]`;
  const date = new Date(msg.date * 1000).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
  return `[${date}] ${from} (chat ${msg.chat.id}): ${text.slice(0, 100)}`;
}

const HELP = `Usage: ax.ts telegram <subcommand> [args...]

  send [-c <chat_id>] [-h] <text>   发送消息（-c 指定 chat，-h HTML，--json 输出 JSON）
  updates [--wait]                  查看最近消息（--wait 持续等待，--json 输出 JSON）
  chats                             列出聊天列表（--json 输出 JSON）
`;

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === "-h" || args[0] === "--help") {
    console.log(HELP);
    process.exit(args.length === 0 ? 1 : 0);
  }

  const sub = args[0];
  const rest = args.slice(1);

  switch (sub) {
    case "send": {
      const json = rest.includes("--json");
      let chatId: number | null = null;
      let html = false;
      let textParts: string[] = [];

      let i = 0;
      while (i < rest.length) {
        const a = rest[i];
        if (a === "-c" && i + 1 < rest.length) {
          chatId = Number(rest[++i]);
        } else if (a === "-h") {
          html = true;
        } else if (a === "--json") {
          // skip, handled above
        } else {
          textParts.push(a);
        }
        i++;
      }

      const text = textParts.join(" ");
      if (!text) {
        console.error("请提供要发送的文本。");
        process.exit(1);
      }

      const cid = chatId ?? await discoverChatId();
      const body: Record<string, unknown> = { chat_id: cid, text };
      if (html) body.parse_mode = "HTML";

      const r = await api("sendMessage", body);
      if (json) console.log(JSON.stringify(r.result));
      else console.log(`sent to ${cid} (msg_id: ${r.result.message_id})`);
      break;
    }

    case "updates": {
      const wait = rest.includes("--wait");
      const json = rest.includes("--json");

      for (;;) {
        const r = await api("getUpdates", { limit: 20, timeout: wait ? 50 : 0 });

        if (r.result?.length) {
          if (json) {
            for (const u of r.result) console.log(JSON.stringify(u));
          } else {
            for (const u of r.result) console.log(formatUpdate(u));
          }
          await api("getUpdates", { offset: r.result.at(-1).update_id + 1, timeout: 0 });
          break;
        }
        if (!wait) {
          console.log(json ? "[]" : "没有新消息。");
          break;
        }
      }
      break;
    }

    case "chats": {
      const json = rest.includes("--json");
      const r = await api("getUpdates", { limit: 100 });
      const chats = new Map<number, { type: string; name: string; username?: string }>();
      for (const u of r.result ?? []) {
        const msg = u.message ?? u.channel_post ?? u.edited_message;
        if (!msg?.chat) continue;
        const c = msg.chat;
        if (!chats.has(c.id)) {
          chats.set(c.id, {
            type: c.type,
            name: c.title ?? `${c.first_name ?? ""} ${c.last_name ?? ""}`.trim(),
            username: c.username,
          });
        }
      }
      if (chats.size === 0) {
        console.log(json ? "[]" : "没有聊天记录。请先给 bot 发一条消息。");
        break;
      }
      if (json) {
        const arr = [...chats].map(([id, info]) => ({ id, ...info }));
        console.log(JSON.stringify(arr));
      } else {
        console.log(`${"CHAT_ID".padEnd(14)} ${"TYPE".padEnd(10)} NAME`);
        for (const [id, info] of [...chats].sort((a, b) => a[0] - b[0])) {
          const tag = info.username ? ` (@${info.username})` : "";
          console.log(`${String(id).padEnd(14)} ${info.type.padEnd(10)} ${info.name}${tag}`);
        }
      }
      break;
    }

    default:
      console.error(`未知子命令: ${sub}\n\n${HELP}`);
      process.exit(1);
  }
}

main();
