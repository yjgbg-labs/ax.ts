#!/usr/bin/env bun
import { readdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const LIBS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface Setup {
  desc: string;
  run: string;
}

async function discover(): Promise<Map<string, Setup>> {
  const setups = new Map<string, Setup>();
  const entries = await readdir(LIBS_DIR, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.name.startsWith("_") || !entry.isDirectory()) continue;
    const pkgFile = Bun.file(resolve(LIBS_DIR, entry.name, "package.json"));
    if (!await pkgFile.exists()) continue;
    const pkg = await pkgFile.json();
    if (pkg.setup) setups.set(entry.name, pkg.setup as Setup);
  }

  return setups;
}

const [target] = process.argv.slice(2);

if (target === "-h" || target === "--help") {
  console.log("Usage: ax.ts setup [name]\n\n  无参数列出所有初始化操作，指定 name 执行。");
  process.exit(0);
}

const setups = await discover();

if (!target) {
  if (setups.size === 0) {
    console.log("没有需要初始化的命令。");
    process.exit(0);
  }
  const nameWidth = Math.max(...[...setups.keys()].map((n) => n.length));
  for (const [name, { desc }] of [...setups.entries()].sort()) {
    console.log(`  ${name.padEnd(nameWidth + 2)}${desc}`);
  }
  process.exit(0);
}

const s = setups.get(target);
if (!s) {
  console.error(`没有找到 ${target} 的初始化配置。`);
  process.exit(1);
}

console.log(`→ ${s.desc}`);
const [bin, ...args] = s.run.split(" ");
const proc = Bun.spawn([bin, ...args], {
  stdin: "inherit", stdout: "inherit", stderr: "inherit",
});
process.exit(await proc.exited);
