import { stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultConfigPath, readConfig, writeConfig } from "../src/config";

function tempPath(name: string): string {
  return join(tmpdir(), `omni-hostd-test-${process.pid}-${name}.json`);
}

describe("hostd config file", () => {
  it("defaults into ~/.omni, overridable via OMNI_HOSTD_CONFIG", () => {
    expect(defaultConfigPath({})).toMatch(/[/\\]\.omni[/\\]hostd\.json$/);
    expect(defaultConfigPath({ OMNI_HOSTD_CONFIG: "/etc/omni/hostd.json" })).toBe("/etc/omni/hostd.json");
  });

  it("round-trips and reads as null before first write", async () => {
    const path = tempPath("roundtrip");
    expect(await readConfig(path)).toBeNull();
    await writeConfig({ serverUrl: "https://omni.example.com", credential: "omni_host_x" }, path);
    expect(await readConfig(path)).toEqual({ serverUrl: "https://omni.example.com", credential: "omni_host_x" });
  });

  it("writes with owner-only permissions (0600)", async () => {
    const path = tempPath("perms");
    await writeConfig({ serverUrl: "https://x", credential: "omni_host_y" }, path);
    const stats = await stat(path);
    // Keep only the permission bits; platforms differ in higher bits.
    expect(stats.mode & 0o777).toBe(0o600);
  });

  it("tightens permissions of a pre-existing looser file", async () => {
    const path = tempPath("retighten");
    const { writeFile, chmod } = await import("node:fs/promises");
    await writeFile(path, "{}\n", { mode: 0o644 });
    await chmod(path, 0o644);
    await writeConfig({ serverUrl: "https://x", credential: "omni_host_z" }, path);
    const stats = await stat(path);
    expect(stats.mode & 0o777).toBe(0o600);
  });
});
