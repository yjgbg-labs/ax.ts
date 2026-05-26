#!/usr/bin/env bun
import { readdir } from "fs/promises";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const LIBS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../libs");

interface Command {
  entrypoint: string;
  description: string;
}

async function readMeta(dir: string): Promise<{ bin: string; description: string } | null> {
  const pkgFile = Bun.file(resolve(dir, "package.json"));
  if (!await pkgFile.exists()) return null;
  const pkg = await pkgFile.json();
  if (!pkg.bin) return null;
  return { bin: pkg.bin, description: pkg.description ?? "" };
}

async function discoverCommands(): Promise<Map<string, Command>> {
  const cmds = new Map<string, Command>();
  const entries = await readdir(LIBS_DIR, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.name.startsWith("_") || !entry.isDirectory()) continue;

    const dir = resolve(LIBS_DIR, entry.name);
    const meta = await readMeta(dir);
    if (!meta) continue;

    const entrypoint = resolve(dir, meta.bin);
    if (!await Bun.file(entrypoint).exists()) continue;

    cmds.set(entry.name, { entrypoint, description: meta.description });
  }

  return cmds;
}

async function main() {
  const cmds = await discoverCommands();
  const [cmd, ...args] = process.argv.slice(2);

  if (!cmd || cmd === "--help" || cmd === "-h") {
    console.log("Usage: ax.ts <command> [args...]\n");
    console.log("Commands:");
    const nameWidth = Math.max(...[...cmds.keys()].map((n) => n.length));
    for (const [name, { description }] of [...cmds.entries()].sort()) {
      const pad = " ".repeat(nameWidth - name.length + 2);
      console.log(`  ${name}${pad}${description}`);
    }
    process.exit(cmd ? 0 : 1);
  }

  const command = cmds.get(cmd);
  if (!command) {
    console.error(`Unknown command: ${cmd}`);
    process.exit(1);
  }

  const proc = Bun.spawn(["bun", command.entrypoint, ...args], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });

  process.exit(await proc.exited);
}

main();
