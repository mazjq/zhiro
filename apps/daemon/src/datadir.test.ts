/** ADR-051: one answer for where the data is, and never an empty directory in place of data that should be somewhere. */
import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { findDataDir, legacyDir, defaultDir, pointerFile, writePointer } from "./datadir.js";

function world(platform: NodeJS.Platform = process.platform) {
  const home = mkdtempSync(join(tmpdir(), "zhiro-home-"));
  const env: NodeJS.ProcessEnv = { APPDATA: join(home, "AppData", "Roaming") };
  return { argv: ["node", "zhiro"], env, platform, home };
}

describe("where the data is", () => {
  it("a new person: the platform's usual place, per platform", () => {
    expect(findDataDir(world("win32"))).toMatchObject({ source: "default", dir: expect.stringMatching(/Roaming[\\/]Zhiro[\\/]data$/) });
    const mac = world("darwin");
    expect(findDataDir(mac).dir).toBe(join(mac.home, "Library", "Application Support", "Zhiro"));
    const linux = world("linux");
    expect(findDataDir(linux).dir).toBe(join(linux.home, ".local", "share", "zhiro"));
    linux.env.XDG_DATA_HOME = join(linux.home, "xdg");
    expect(findDataDir(linux).dir).toBe(join(linux.home, "xdg", "zhiro"));
  });

  it("order: --data, then ZHIRO_DATA / JOBOS_VAULT, then the pointer, then the old place", () => {
    const w = world();
    mkdirSync(legacyDir(w), { recursive: true });
    expect(findDataDir(w)).toMatchObject({ source: "legacy", dir: legacyDir(w) });
    const chosen = join(w.home, "chosen"); mkdirSync(chosen);
    writePointer(chosen, w);
    expect(findDataDir(w)).toMatchObject({ source: "pointer", dir: resolve(chosen) });
    w.env.JOBOS_VAULT = join(w.home, "old-env");
    expect(findDataDir(w)).toMatchObject({ source: "env", dir: resolve(w.home, "old-env") });
    w.env.ZHIRO_DATA = join(w.home, "new-env");
    expect(findDataDir(w)).toMatchObject({ source: "env", dir: resolve(w.home, "new-env") });
    expect(findDataDir({ ...w, argv: ["node", "zhiro", "--data", join(w.home, "arg")] })).toMatchObject({ source: "arg", dir: resolve(w.home, "arg") });
    expect(findDataDir({ ...w, argv: ["node", "zhiro", `--data=${join(w.home, "arg2")}`] }).dir).toBe(resolve(w.home, "arg2"));
  });

  it("the pointer lives outside the data directory", () => {
    const w = world();
    expect(pointerFile(w).startsWith(defaultDir(w) + sep)).toBe(false);
  });

  it("a pointer that leads nowhere stops the start (no empty directory elsewhere)", () => {
    const w = world();
    writePointer(join(w.home, "unplugged-disk", "data"), w);
    expect(() => findDataDir(w)).toThrow(/找不到/);
    writeFileSync(pointerFile(w), "  \n");
    expect(() => findDataDir(w)).toThrow(/空的/);
  });

  it("the old place counts even when its link's disk is away, or only its move record is left", () => {
    const w = world();
    const target = join(w.home, "E-drive", "data"); mkdirSync(target, { recursive: true });
    mkdirSync(resolve(legacyDir(w), ".."), { recursive: true });
    symlinkSync(target, legacyDir(w), "junction");
    rmSync(target, { recursive: true }); // the disk behind the link is not there right now
    expect(findDataDir(w)).toMatchObject({ source: "legacy" }); // not the new default: move.ts then says the data cannot be reached
    const w2 = world();
    mkdirSync(resolve(legacyDir(w2), ".."), { recursive: true });
    writeFileSync(`${legacyDir(w2)}.move.json`, "{}");
    expect(findDataDir(w2)).toMatchObject({ source: "legacy" });
  });
});
