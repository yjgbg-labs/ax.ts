#!/usr/bin/env bun
const { exitCode } = Bun.spawnSync(["bunx", "--bun", "@jeffreycao/copilot-api@1.10.22", ...process.argv.slice(2)], {
  stdin: "inherit", stdout: "inherit", stderr: "inherit",
});
process.exit(exitCode);
