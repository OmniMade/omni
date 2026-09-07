import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";

/**
 * Compile omni-hostd into standalone binaries (F001 acceptance criterion).
 * Requires `bun` on PATH; cross-compiles all three targets — execute the one
 * matching the machine you deploy to.
 */
const TARGETS = ["bun-darwin-arm64", "bun-linux-x64", "bun-linux-arm64"] as const;

mkdirSync("bin", { recursive: true });
for (const target of TARGETS) {
  const out = `bin/omni-hostd-${target.replace("bun-", "")}`;
  execFileSync(
    "bun",
    ["build", "src/index.ts", "--compile", `--target=${target}`, "--outfile", out],
    { stdio: "inherit" },
  );
  console.log(`built ${out}`);
}
