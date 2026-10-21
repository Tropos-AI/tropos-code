// src/messages/helper/applet.test.ts
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HELPER_BUNDLE_ID, HELPER_NAME, HELPER_VERSION, appleScriptString, appletSource } from "./applet";

const ONEIL = { runDir: "/Users/John O'Neil/.tropos/run/messages-helper", userHome: '/Users/John O"Neil' };

/** The script with every string literal removed, so what is left is only code. */
function withoutLiterals(source: string): string {
  return source.replace(/"(?:[^"\\]|\\.)*"/g, '""');
}

describe("constants", () => {
  test("the helper's identity", () => {
    expect(HELPER_VERSION).toBe(1);
    expect(HELPER_BUNDLE_ID).toBe("com.troposlabs.messages-helper");
    expect(HELPER_NAME).toBe("Tropos Messages Helper");
  });
});

describe("appleScriptString", () => {
  test("quotes and backslashes are escaped", () => {
    expect(appleScriptString('a "b" \\c')).toBe('"a \\"b\\" \\\\c"');
    expect(appleScriptString("")).toBe('""');
    expect(appleScriptString("O'Neil")).toBe('"O\'Neil"');
  });
});

describe("appletSource", () => {
  test("paths are escaped", () => {
    const source = appletSource(ONEIL);
    expect(source).toContain('"/Users/John O\\"Neil"');
    expect(source).toContain(`"/Users/John O'Neil/.tropos/run/messages-helper"`);
    // Every quote inside the home path is escaped, so no literal ends early.
    expect(source).not.toMatch(/[^\\]"Neil/);
    // With literals removed, no path text is left behind as code.
    expect(withoutLiterals(source)).not.toContain("Neil");
  });

  test("no request text is ever part of the script", () => {
    const source = appletSource(ONEIL);
    expect(source).not.toMatch(/\$\{|\{\{|%s|__[A-Z]+__/);
    // The script depends only on the two folders: other folders change only those literals.
    const other = appletSource({ runDir: "/r", userHome: "/h" });
    const strip = (s: string, o: typeof ONEIL) =>
      s.split(appleScriptString(o.runDir)).join("RUN").split(appleScriptString(o.userHome)).join("HOME");
    expect(strip(source, ONEIL)).toBe(strip(other, { runDir: "/r", userHome: "/h" }));
    // Anything joined into a shell command goes through `quoted form of`.
    for (const line of withoutLiterals(source).split("\n")) {
      const at = line.indexOf("do shell script");
      if (at < 0) continue;
      const parts = line.slice(at + "do shell script".length).split("&").map((p) => p.trim());
      for (const part of parts) {
        if (/^""\)?$/.test(part) || part.startsWith('"" ')) continue;
        expect(part).toMatch(/^quoted form of [A-Za-z]+\)?$/);
      }
    }
  });

  test("both entry points drain the queue, and the actions are all there", () => {
    const source = appletSource(ONEIL);
    expect(source).toMatch(/on run\s+processQueue\(\)/);
    expect(source).toMatch(/on reopen\s+processQueue\(\)/);
    for (const action of ["status", "probe", "snapshot", "contacts", "attachment", "send-handle", "send-chat", "open-settings"]) {
      expect(source).toContain(`"${action}"`);
    }
    expect(source).toContain("send theBody to participant theHandle of (1st account whose service type = iMessage)");
    expect(source).toContain("send theBody to chat id theChat");
    expect(source).toContain("x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles");
    expect(source).toContain("x-apple.systempreferences:com.apple.preference.security?Privacy_Automation");
    // Properties and globals are saved back into an applet and would break its signature.
    expect(source).not.toMatch(/^\s*(property|global)\b/m);
  });

  test.skipIf(process.platform !== "darwin")("osacompile compiles it", () => {
    const dir = mkdtempSync(join(tmpdir(), "tropos-applet-"));
    try {
      for (const [i, o] of [ONEIL, { runDir: "/Users/Γιώργος/.tropos/run/messages-helper", userHome: "/Users/Γιώργος" }].entries()) {
        const src = join(dir, `x${i}.applescript`);
        writeFileSync(src, appletSource(o));
        const r = Bun.spawnSync(["/usr/bin/osacompile", "-o", join(dir, `x${i}.app`), src]);
        // osacompile signs the applet itself and says so on stderr; only the exit code matters.
        expect({ code: r.exitCode, stderr: r.exitCode === 0 ? "" : r.stderr.toString() }).toEqual({ code: 0, stderr: "" });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Runs the compiled script with osascript (not the helper app) against a made-up home in a temp folder.
  // Only actions that stay inside that folder are exercised: never probe, send or open-settings.
  test.skipIf(process.platform !== "darwin")("the compiled script answers requests against a fake home", () => {
    const dir = mkdtempSync(join(tmpdir(), "tropos-applet-run-"));
    try {
      const home = join(dir, "John O'Neil");
      const runDir = join(home, ".tropos", "run", "messages-helper");
      const attachments = join(home, "Library", "Messages", "Attachments", "ab");
      const book = join(home, "Library", "Application Support", "AddressBook", "Sources", "X");
      for (const d of [runDir, attachments, book]) mkdirSync(d, { recursive: true, mode: 0o700 });
      writeFileSync(join(home, "Library", "Messages", "chat.db"), "db");
      writeFileSync(join(home, "Library", "Messages", "chat.db-wal"), "wal");
      writeFileSync(join(attachments, "Καλημέρα 👍.jpg"), "pic");
      writeFileSync(join(book, "AddressBook-v22.abcddb"), "ab");
      const requests: Record<string, string[]> = {
        "01": ["status"],
        "02": ["snapshot", `${runDir}/snap-a`],
        "03": ["contacts", `${runDir}/snap-a/c`],
        "04": ["attachment", join(attachments, "Καλημέρα 👍.jpg"), `${runDir}/snap-a`],
        "05": ["attachment", join(home, "Library", "Messages", "Attachments", "..", "chat.db"), `${runDir}/snap-a`],
        "06": ["snapshot", `${runDir}/snap-a/../../x`],
        "07": ["snapshot", join(dir, "elsewhere")],
        "08": ["frobnicate"],
      };
      for (const [id, lines] of Object.entries(requests)) writeFileSync(join(runDir, `req-${id}.txt`), lines.join("\n"));
      const src = join(dir, "x.applescript");
      writeFileSync(src, appletSource({ runDir, userHome: home }));
      expect(Bun.spawnSync(["/usr/bin/osacompile", "-o", join(dir, "x.scpt"), src]).exitCode).toBe(0);
      const r = Bun.spawnSync(["/usr/bin/osascript", join(dir, "x.scpt")]);
      expect({ code: r.exitCode, stderr: r.stderr.toString() }).toEqual({ code: 0, stderr: "" });
      const reply = (id: string) => readFileSync(join(runDir, `res-${id}.txt`), "utf8");
      expect(reply("01")).toBe("ok\n0\nfda=yes");
      expect(reply("02")).toBe("ok\n0\nchat.db");
      expect(reply("03")).toBe("ok\n0\ncontacts-1/AddressBook-v22.abcddb");
      expect(reply("04")).toBe(`ok\n0\n${runDir}/snap-a/Καλημέρα 👍.jpg`);
      for (const id of ["05", "06", "07", "08"]) expect(reply(id)).toStartWith("error\nbad-request\n");
      expect(readFileSync(join(runDir, "snap-a", "chat.db-wal"), "utf8")).toBe("wal");
      expect(readFileSync(join(runDir, "snap-a", "Καλημέρα 👍.jpg"), "utf8")).toBe("pic");
      expect(existsSync(join(runDir, "snap-a", "c", "contacts-1", "AddressBook-v22.abcddb"))).toBe(true);
      expect(existsSync(join(dir, "elsewhere"))).toBe(false);
      // Every request was consumed and every reply was renamed into place.
      expect(readdirSync(runDir).filter((n) => !n.startsWith("res-") || n.endsWith(".tmp"))).toEqual(["snap-a"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
