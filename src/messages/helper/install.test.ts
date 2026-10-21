// src/messages/helper/install.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveLayout, type Layout } from "../../install/layout";
import { HELPER_BUNDLE_ID, HELPER_NAME, HELPER_VERSION, appleScriptString } from "./applet";
import { ensureHelper, helperAppPath, helperRunDir, type Exec } from "./install";

let root: string;
let layout: Layout;
let calls: { cmd: string; args: string[] }[];
/** The script osacompile was given, read when it ran. */
let compiled: string | undefined;

/** Pretends to be osacompile/plutil/codesign: osacompile lays out a bare bundle, the rest only get recorded. */
const fakeExec: Exec = async (cmd, args) => {
  calls.push({ cmd, args });
  if (cmd.endsWith("osacompile")) {
    const out = args[args.indexOf("-o") + 1]!;
    compiled = readFileSync(args.at(-1)!, "utf8");
    mkdirSync(join(out, "Contents", "Resources"), { recursive: true });
    writeFileSync(join(out, "Contents", "Info.plist"), "<plist/>");
    writeFileSync(join(out, "Contents", "Resources", "Scripts-main.scpt"), "compiled");
  }
  return { code: 0, stdout: "", stderr: "" };
};

const names = () => calls.map((c) => c.cmd.split("/").pop());
const marker = () => join(helperAppPath(layout), "Contents", "Resources", "tropos-helper-version");

/** Puts an already-built helper in place, with the given version marker. */
function installed(version: string) {
  mkdirSync(join(helperAppPath(layout), "Contents", "Resources"), { recursive: true });
  writeFileSync(marker(), version);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tropos-helper-install-"));
  layout = resolveLayout({}, join(root, "user"));
  calls = [];
  compiled = undefined;
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const ensure = () => ensureHelper({ userHome: join(root, "user"), exec: fakeExec, layout });

describe("ensureHelper", () => {
  test("the app lives in the data folder's helpers", () => {
    expect(helperAppPath(layout)).toBe(join(layout.data, "helpers", `${HELPER_NAME}.app`));
    expect(helperRunDir(layout)).toBe(join(layout.data, "helpers", "run", "messages-helper"));
  });

  test("a fresh install compiles, re-identifies, marks and signs the applet", async () => {
    const r = await ensure();
    expect(r).toEqual({ path: helperAppPath(layout), installed: "new" });
    expect(names()).toEqual(["osacompile", "plutil", "plutil", "plutil", "plutil", "codesign"]);
    const plist = calls.filter((c) => c.cmd.endsWith("plutil")).map((c) => c.args.slice(0, 4));
    expect(plist).toEqual([
      ["-replace", "CFBundleIdentifier", "-string", HELPER_BUNDLE_ID],
      ["-replace", "CFBundleName", "-string", HELPER_NAME],
      ["-replace", "LSUIElement", "-bool", "true"],
      ["-replace", "NSAppleEventsUsageDescription", "-string", "Tropos uses Messages to send the texts you approve."],
    ]);
    const sign = calls.at(-1)!.args;
    expect(sign.slice(0, 5)).toEqual(["--force", "--sign", "-", "--identifier", HELPER_BUNDLE_ID]);
    expect(readFileSync(marker(), "utf8").trim()).toBe(String(HELPER_VERSION));
    // The compiled script is the generated one, pointed at this user's folders.
    const src = calls[0]!.args.at(-1)!;
    expect(src.endsWith(".applescript")).toBe(true);
    expect(compiled).toContain(appleScriptString(helperRunDir(layout)));
    expect(compiled).toContain(appleScriptString(join(layout.data, "helpers", "run", "token")));
    expect(compiled).toContain(appleScriptString(join(root, "user")));
    // Nothing is left behind next to the app.
    expect(readdirSync(join(layout.data, "helpers"))).toEqual([`${HELPER_NAME}.app`]);
  });

  test("the version marker is written before the bundle is signed", async () => {
    let markedAtSign: boolean | undefined;
    const exec: Exec = async (cmd, args) => {
      if (cmd.endsWith("codesign")) markedAtSign = existsSync(join(args.at(-1)!, "Contents", "Resources", "tropos-helper-version"));
      return fakeExec(cmd, args);
    };
    await ensureHelper({ userHome: join(root, "user"), exec, layout });
    expect(markedAtSign).toBe(true);
  });

  test("a helper at this version is left alone", async () => {
    installed(String(HELPER_VERSION));
    expect(await ensure()).toEqual({ path: helperAppPath(layout), installed: "already" });
    expect(calls).toEqual([]);
  });

  test("a newer helper is left alone too", async () => {
    installed(String(HELPER_VERSION + 1));
    expect((await ensure()).installed).toBe("already");
    expect(calls).toEqual([]);
  });

  test("an older helper is rebuilt and replaced", async () => {
    installed("0");
    writeFileSync(join(helperAppPath(layout), "Contents", "old-file"), "x");
    expect((await ensure()).installed).toBe("upgraded");
    expect(names()).toContain("osacompile");
    expect(readFileSync(marker(), "utf8").trim()).toBe(String(HELPER_VERSION));
    expect(existsSync(join(helperAppPath(layout), "Contents", "old-file"))).toBe(false);
    expect(readdirSync(join(layout.data, "helpers"))).toEqual([`${HELPER_NAME}.app`]);
  });

  test("a helper the user deleted is built again", async () => {
    installed(String(HELPER_VERSION));
    rmSync(helperAppPath(layout), { recursive: true });
    expect((await ensure()).installed).toBe("new");
    expect(names()).toContain("osacompile");
  });

  test("a helper another process installed meanwhile is accepted", async () => {
    const exec: Exec = async (cmd, args) => {
      // While this build signs, another Tropos process finishes its own install.
      if (cmd.endsWith("codesign")) installed(String(HELPER_VERSION));
      return fakeExec(cmd, args);
    };
    const r = await ensureHelper({ userHome: join(root, "user"), exec, layout });
    expect(r).toEqual({ path: helperAppPath(layout), installed: "new" });
    expect(readdirSync(join(layout.data, "helpers"))).toEqual([`${HELPER_NAME}.app`]);
  });

  test("an older helper another process is replacing right now doesn't stop the upgrade", async () => {
    installed("0");
    const exec: Exec = async (cmd, args) => {
      // While this build signs, another Tropos process moves the old helper aside.
      if (cmd.endsWith("codesign")) rmSync(helperAppPath(layout), { recursive: true });
      return fakeExec(cmd, args);
    };
    const r = await ensureHelper({ userHome: join(root, "user"), exec, layout });
    expect(r).toEqual({ path: helperAppPath(layout), installed: "upgraded" });
    expect(readFileSync(marker(), "utf8").trim()).toBe(String(HELPER_VERSION));
  });

  test("a failed build says why and keeps the old helper", async () => {
    installed("0");
    const exec: Exec = async (cmd, args) => {
      if (cmd.endsWith("codesign")) return { code: 1, stdout: "", stderr: "codesign: no identity" };
      return fakeExec(cmd, args);
    };
    await expect(ensureHelper({ userHome: join(root, "user"), exec, layout })).rejects.toThrow(
      /codesign.*no identity/,
    );
    expect(readFileSync(marker(), "utf8")).toBe("0");
    expect(readdirSync(join(layout.data, "helpers"))).toEqual([`${HELPER_NAME}.app`]);
  });
});
