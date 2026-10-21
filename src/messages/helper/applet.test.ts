// src/messages/helper/applet.test.ts
import { describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { HELPER_BUNDLE_ID, HELPER_NAME, HELPER_VERSION, appleScriptString, appletSource, helperTokenPath } from "./applet";

const ONEIL = { runDir: "/Users/John O'Neil/.local/share/tropos/helpers/run/messages-helper", userHome: '/Users/John O"Neil' };

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
    expect(source).toContain(`"/Users/John O'Neil/.local/share/tropos/helpers/run/messages-helper"`);
    expect(source).toContain(`"/Users/John O'Neil/.local/share/tropos/helpers/run/token"`);
    // Every quote inside the home path is escaped, so no literal ends early.
    expect(source).not.toMatch(/[^\\]"Neil/);
    // With literals removed, no path text is left behind as code.
    expect(withoutLiterals(source)).not.toContain("Neil");
  });

  test("no request text is ever part of the script", () => {
    const source = appletSource(ONEIL);
    // The reply is written with printf '%s', which prints its argument as data; any other %s would be a placeholder.
    expect(source.split("printf '%s' ").join("")).not.toMatch(/\$\{|\{\{|%s|__[A-Z]+__/);
    // The script depends only on the two folders: other folders change only the path literals.
    const other = appletSource({ runDir: "/r", userHome: "/h" });
    const strip = (s: string, o: typeof ONEIL) =>
      s
        .split(appleScriptString(o.runDir))
        .join("RUN")
        .split(appleScriptString(helperTokenPath(o.runDir)))
        .join("TOKEN")
        .split(appleScriptString(o.userHome))
        .join("HOME");
    expect(strip(source, ONEIL)).toBe(strip(other, { runDir: "/r", userHome: "/h" }));
    // Anything joined into a shell command goes through `quoted form of` (pinTo builds the start of one).
    let checked = 0;
    for (const line of withoutLiterals(source).split("\n")) {
      const marker = ["do shell script", 'return "" & quoted form of'].find((m) => line.includes(m));
      if (!marker) continue;
      checked++;
      const start = line.indexOf(marker) + (marker === "do shell script" ? marker.length : "return".length);
      for (const part of line.slice(start).split("&").map((p) => p.trim())) {
        if (/^""\)?$/.test(part) || part.startsWith('"" ')) continue;
        expect(part).toMatch(/^(quoted form of [A-Za-z]+\)?|pinTo\([A-Za-z]+\))$/);
      }
    }
    expect(checked).toBeGreaterThan(10);
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
    // A pending permission prompt can't hold the queue for AppleScript's default two minutes.
    expect(source.match(/with timeout of 30 seconds/g)?.length).toBe(1);
    expect(source.match(/with timeout of 170 seconds/g)?.length).toBe(2);
    expect(source.match(/tell application "Messages"/g)?.length).toBe(4);
    // Properties and globals are saved back into an applet and would break its signature.
    expect(source).not.toMatch(/^\s*(property|global)\b/m);
  });

  test("copies are APFS clones made in a fresh private folder, with the byte copy as the fallback", () => {
    const source = appletSource(ONEIL);
    const copy = source.split("\n").find((l) => l.includes("on copyChecked"))!;
    const body = source.slice(source.indexOf(copy), source.indexOf("end copyChecked"));
    expect(body).toContain("/usr/bin/mktemp -d ./.copy-XXXXXX");
    expect(body).toContain("/bin/cp -c -- ");
    expect(body).toContain("/bin/cat -- ");
    expect(body).toContain("/bin/mv -f -h ");
  });

  test.skipIf(process.platform !== "darwin")("osacompile compiles it", () => {
    const dir = mkdtempSync(join(tmpdir(), "tropos-applet-"));
    try {
      const greek = { runDir: "/Users/Γιώργος/.local/share/tropos/helpers/run/messages-helper", userHome: "/Users/Γιώργος" };
      for (const [i, o] of [ONEIL, greek].entries()) {
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
});

// These run the compiled script with osascript (never the helper app) against a made-up home in a temp
// folder. Only actions that stay inside that folder are exercised: never probe, send or open-settings.
describe.skipIf(process.platform !== "darwin")("the compiled script, against a fake home", () => {
  const TOKEN = "ab".repeat(32);

  /** Lays out a home like a real one, with the install's token; `runDir` is the folder the script watches. */
  function fakeHome(dir: string) {
    const home = join(dir, "John O'Neil");
    const run = join(home, ".local", "share", "tropos", "helpers", "run");
    const runDir = join(run, "messages-helper");
    const messages = join(home, "Library", "Messages");
    const attachments = join(messages, "Attachments", "ab");
    const book = join(home, "Library", "Application Support", "AddressBook", "Sources", "X");
    for (const d of [runDir, attachments, book]) mkdirSync(d, { recursive: true, mode: 0o700 });
    writeFileSync(join(run, "token"), TOKEN, { mode: 0o600 });
    writeFileSync(join(messages, "chat.db"), "db");
    writeFileSync(join(messages, "chat.db-wal"), "wal");
    writeFileSync(join(attachments, "Καλημέρα 👍.jpg"), "pic");
    writeFileSync(join(book, "AddressBook-v22.abcddb"), "ab");
    return { home, runDir, messages, attachments };
  }

  /** The caller's side: snapshot folders are created before the request. */
  const snapFolder = (runDir: string, name: string) => {
    const p = join(runDir, name);
    mkdirSync(p, { mode: 0o700 });
    return p;
  };

  function request(runDir: string, id: string, lines: string[], token = TOKEN) {
    writeFileSync(join(runDir, `req-${id}.txt`), [token, ...lines].join("\n"));
  }

  function runApplet(dir: string, o: { runDir: string; userHome: string }) {
    const src = join(dir, "x.applescript");
    writeFileSync(src, appletSource(o));
    expect(Bun.spawnSync(["/usr/bin/osacompile", "-o", join(dir, "x.scpt"), src]).exitCode).toBe(0);
    const r = Bun.spawnSync(["/usr/bin/osascript", join(dir, "x.scpt")]);
    expect({ code: r.exitCode, stderr: r.stderr.toString() }).toEqual({ code: 0, stderr: "" });
  }

  const reply = (runDir: string, id: string) => readFileSync(join(runDir, `res-${id}.txt`), "utf8");

  test("it answers requests carrying the token", () => {
    const dir = mkdtempSync(join(tmpdir(), "tropos-applet-run-"));
    try {
      const { home, runDir, attachments } = fakeHome(dir);
      const snap = snapFolder(runDir, "snap-a");
      request(runDir, "01", ["status"]);
      request(runDir, "02", ["snapshot", snap]);
      request(runDir, "03", ["contacts", snap]);
      request(runDir, "04", ["attachment", join(attachments, "Καλημέρα 👍.jpg"), snap]);
      request(runDir, "05", ["attachment", join(home, "Library", "Messages", "Attachments", "..", "chat.db"), snap]);
      request(runDir, "06", ["snapshot", `${snap}/../../x`]);
      request(runDir, "07", ["snapshot", join(dir, "elsewhere")]);
      request(runDir, "08", ["frobnicate"]);
      request(runDir, "09", ["snapshot", join(runDir, "snap-missing")]);
      request(runDir, "10", ["status"], "cd".repeat(32));
      runApplet(dir, { runDir, userHome: home });
      expect(reply(runDir, "01")).toBe("ok\n0\nfda=yes");
      expect(reply(runDir, "02")).toBe("ok\n0\nchat.db");
      expect(reply(runDir, "03")).toBe("ok\n0\ncontacts-1/AddressBook-v22.abcddb");
      expect(reply(runDir, "04")).toBe(`ok\n0\n${snap}/Καλημέρα 👍.jpg`);
      for (const id of ["05", "06", "07", "08", "09"]) expect(reply(runDir, id)).toStartWith("error\nbad-request\n");
      expect(reply(runDir, "10")).toStartWith("error\nunauthorized\n");
      expect(readFileSync(join(snap, "chat.db"), "utf8")).toBe("db");
      expect(readFileSync(join(snap, "chat.db-wal"), "utf8")).toBe("wal");
      expect(readFileSync(join(snap, "Καλημέρα 👍.jpg"), "utf8")).toBe("pic");
      expect(readFileSync(join(snap, "contacts-1", "AddressBook-v22.abcddb"), "utf8")).toBe("ab");
      // The private folders the copies were cloned into are gone.
      expect(readdirSync(snap).sort()).toEqual(["chat.db", "chat.db-wal", "contacts-1", "Καλημέρα 👍.jpg"].sort());
      expect(readdirSync(join(snap, "contacts-1"))).toEqual(["AddressBook-v22.abcddb"]);
      expect(existsSync(join(dir, "elsewhere"))).toBe(false);
      expect(existsSync(join(runDir, "snap-missing"))).toBe(false);
      // Every request was consumed and every reply was renamed into place.
      expect(readdirSync(runDir).filter((n) => !n.startsWith("res-") || n.endsWith(".tmp"))).toEqual(["snap-a"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("symlinks never lead it outside its folders", () => {
    const dir = mkdtempSync(join(tmpdir(), "tropos-applet-links-"));
    try {
      const { home, runDir, attachments, messages } = fakeHome(dir);
      const elsewhere = join(dir, "elsewhere");
      mkdirSync(elsewhere);
      symlinkSync(elsewhere, join(runDir, "snap-link"));
      writeFileSync(join(home, "secret.txt"), "secret");
      symlinkSync(join(home, "secret.txt"), join(attachments, "link.jpg"));
      const outside = join(dir, "outside");
      mkdirSync(outside);
      writeFileSync(join(outside, "file.jpg"), "outside");
      symlinkSync(outside, join(messages, "Attachments", "out"));
      const snap = snapFolder(runDir, "snap-b");
      writeFileSync(join(dir, "victim"), "victim");
      symlinkSync(join(dir, "victim"), join(snap, "chat.db"));
      writeFileSync(join(dir, "victim2"), "victim2");
      symlinkSync(join(dir, "victim2"), join(runDir, "res-15.txt.tmp"));
      // A dangling link would make cp create its target; the copy must replace it instead.
      symlinkSync(join(dir, "ghost"), join(snap, "chat.db-wal"));

      request(runDir, "11", ["snapshot", join(runDir, "snap-link")]);
      request(runDir, "12", ["attachment", join(attachments, "link.jpg"), snap]);
      request(runDir, "13", ["attachment", join(messages, "Attachments", "out", "file.jpg"), snap]);
      request(runDir, "14", ["snapshot", snap]);
      request(runDir, "15", ["status"]);
      runApplet(dir, { runDir, userHome: home });

      expect(reply(runDir, "11")).toStartWith("error\nbad-request\n");
      expect(readdirSync(elsewhere)).toEqual([]);
      expect(reply(runDir, "12")).toStartWith("error\nbad-request\n");
      expect(reply(runDir, "13")).toStartWith("error\nbad-request\n");
      expect(existsSync(join(snap, "secret.txt"))).toBe(false);
      expect(existsSync(join(snap, "file.jpg"))).toBe(false);
      // A planted symlink at a copy's name is replaced, never written through.
      expect(reply(runDir, "14")).toBe("ok\n0\nchat.db");
      expect(lstatSync(join(snap, "chat.db")).isSymbolicLink()).toBe(false);
      expect(readFileSync(join(snap, "chat.db"), "utf8")).toBe("db");
      expect(readFileSync(join(dir, "victim"), "utf8")).toBe("victim");
      expect(lstatSync(join(snap, "chat.db-wal")).isSymbolicLink()).toBe(false);
      expect(readFileSync(join(snap, "chat.db-wal"), "utf8")).toBe("wal");
      expect(existsSync(join(dir, "ghost"))).toBe(false);
      expect(readdirSync(snap).sort()).toEqual(["chat.db", "chat.db-wal"]);
      // So is one at the reply's temporary name.
      expect(reply(runDir, "15")).toBe("ok\n0\nfda=yes");
      expect(readFileSync(join(dir, "victim2"), "utf8")).toBe("victim2");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("without a token file, or with an empty one, every request is unauthorized", () => {
    for (const variant of ["missing", "empty"] as const) {
      const dir = mkdtempSync(join(tmpdir(), `tropos-applet-token-${variant}-`));
      try {
        const { home, runDir } = fakeHome(dir);
        const tokenPath = join(dirname(runDir), "token");
        if (variant === "missing") rmSync(tokenPath);
        else writeFileSync(tokenPath, "");
        request(runDir, "01", ["status"]);
        request(runDir, "02", ["status"], "");
        runApplet(dir, { runDir, userHome: home });
        expect(reply(runDir, "01")).toStartWith("error\nunauthorized\n");
        expect(reply(runDir, "02")).toStartWith("error\nunauthorized\n");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  test("a reply never follows a link planted at its name", () => {
    const dir = mkdtempSync(join(tmpdir(), "tropos-applet-reslink-"));
    try {
      const { home, runDir } = fakeHome(dir);
      const victim = join(dir, "victim-dir");
      mkdirSync(victim);
      symlinkSync(victim, join(runDir, "res-16.txt"));
      request(runDir, "16", ["status"]);
      runApplet(dir, { runDir, userHome: home });
      expect(lstatSync(join(runDir, "res-16.txt")).isSymbolicLink()).toBe(false);
      expect(reply(runDir, "16")).toBe("ok\n0\nfda=yes");
      expect(readdirSync(victim)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The race itself: the folder passed its check, then was swapped for a symlink before the write. The
  // handlers are called directly on the loaded script with the physical path that was checked.
  test("a folder swapped for a symlink after its check is never written into", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "tropos-applet-swap-")));
    try {
      const { home, runDir, messages } = fakeHome(dir);
      const src = join(dir, "x.applescript");
      writeFileSync(src, appletSource({ runDir, userHome: home }));
      const scpt = join(dir, "x.scpt");
      expect(Bun.spawnSync(["/usr/bin/osacompile", "-o", scpt, src]).exitCode).toBe(0);
      const call = (handler: string, ...args: string[]) => {
        const script = [
          "on run argv",
          "set s to load script (POSIX file (item 1 of argv))",
          "try",
          handler,
          'return "done"',
          "on error m",
          'return "refused: " & m',
          "end try",
          "end run",
        ];
        const r = Bun.spawnSync(["/usr/bin/osascript", ...script.flatMap((l) => ["-e", l]), scpt, ...args]);
        return r.stdout.toString().trim();
      };
      const elsewhere = join(dir, "elsewhere");
      mkdirSync(elsewhere);
      const real = snapFolder(runDir, "snap-real");
      // A control: the checked folder is still the real one.
      expect(call("tell s to copyChecked(item 2 of argv, item 3 of argv, \"chat.db\")", join(messages, "chat.db"), real)).toBe("done");
      expect(readFileSync(join(real, "chat.db"), "utf8")).toBe("db");
      // Swapped: the same name now points elsewhere.
      const swapped = join(runDir, "snap-swapped");
      symlinkSync(elsewhere, swapped);
      expect(call("tell s to copyChecked(item 2 of argv, item 3 of argv, \"chat.db\")", join(messages, "chat.db"), swapped)).toMatch(
        /^refused: .*folder changed/,
      );
      expect(call("tell s to writeReply(item 2 of argv, \"17\", {\"ok\", \"0\"})", swapped)).toBe("done");
      expect(readdirSync(elsewhere)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a run folder that is a symlink is not served", () => {
    const dir = mkdtempSync(join(tmpdir(), "tropos-applet-runlink-"));
    try {
      const { home, runDir } = fakeHome(dir);
      const linked = join(dirname(runDir), "linked");
      symlinkSync(runDir, linked);
      request(runDir, "01", ["status"]);
      runApplet(dir, { runDir: linked, userHome: home });
      expect(readdirSync(runDir)).toEqual(["req-01.txt"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
