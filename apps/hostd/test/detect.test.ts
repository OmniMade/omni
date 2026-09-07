import { mkdtemp, chmod, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findInPath } from "../src/detect";

describe("findInPath", () => {
  it("finds an executable binary on the PATH", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omni-detect-"));
    const bin = join(dir, "opencode");
    await writeFile(bin, "#!/bin/sh\necho v1\n", { mode: 0o755 });
    expect(findInPath("opencode", `${dir}`)).toBe(bin);
    expect(findInPath("opencode", `/nonexistent:${dir}`)).toBe(bin);
  });

  it("skips non-executable and missing files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omni-detect-"));
    const bin = join(dir, "claude");
    await writeFile(bin, "not executable\n");
    await chmod(bin, 0o644);
    expect(findInPath("claude", dir)).toBeNull();
    expect(findInPath("absent", dir)).toBeNull();
    expect(findInPath("anything", undefined)).toBeNull();
    expect(findInPath("anything", "")).toBeNull();
  });

  it("treats names containing a slash as direct paths", () => {
    expect(findInPath("/usr/local/bin/thing", "/usr/bin")).toBe("/usr/local/bin/thing");
  });
});
