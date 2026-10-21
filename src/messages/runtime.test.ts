// src/messages/runtime.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeToolContext } from "../../test/helpers/tool-context";
import { resolveLayout, type Layout } from "../install/layout";
import { toolKind } from "../tools/types";
import { HELPER_VERSION } from "./helper/applet";
import { helperAppPath, helperRunDir, type Exec } from "./helper/install";
import { MESSAGES_PREAMBLE } from "./messages-tool";
import { createMessagesRuntime, MESSAGES_TOOLS, type MessagesRuntime } from "./runtime";
import { buildChatDb } from "./testkit";

let root: string;
let layout: Layout;
let calls: string[];
/** What the fake helper answers per action; a function gets the request's arguments. */
let answers: Record<string, string | ((args: string[]) => string)>;
let runtime: MessagesRuntime | undefined;

/**
 * Plays osacompile/plutil/codesign (osacompile lays out a bare bundle) and the helper behind `open -g`, which
 * answers each waiting request from `answers`; `snapshot` builds a one-chat chat.db in the folder it is given.
 */
const exec: Exec = async (cmd, args) => {
  const name = cmd.split("/").pop()!;
  calls.push(name);
  if (name === "osacompile") {
    const out = args[args.indexOf("-o") + 1]!;
    mkdirSync(join(out, "Contents", "Resources"), { recursive: true });
    writeFileSync(join(out, "Contents", "Info.plist"), "<plist/>");
  }
  if (name === "open") {
    const runDir = helperRunDir(layout);
    for (const file of readdirSync(runDir).sort()) {
      const m = /^req-(.+)\.txt$/.exec(file);
      if (!m) continue;
      const [, action, ...rest] = readFileSync(join(runDir, file), "utf8").split("\n");
      rmSync(join(runDir, file));
      calls.push(`request:${action}`);
      const answer = answers[action!];
      const text = typeof answer === "function" ? answer(rest) : (answer ?? "error\nbad-request\nunknown action");
      writeFileSync(join(runDir, `res-${m[1]}.txt.tmp`), text);
      renameSync(join(runDir, `res-${m[1]}.txt.tmp`), join(runDir, `res-${m[1]}.txt`));
    }
  }
  return { code: 0, stdout: "", stderr: "" };
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tropos-messages-runtime-"));
  layout = resolveLayout({}, join(root, "user"));
  calls = [];
  answers = {
    status: "ok\n0\nfda=yes",
    probe: "ok\n0\naccounts=1",
    contacts: "ok\n0",
    snapshot: ([dest]) => {
      buildChatDb(join(dest!, "chat.db"), {
        chats: [{ guid: "iMessage;-;+306912345678", identifier: "+306912345678", handles: ["+306912345678"] }],
        messages: [{ guid: "m1", chat: "iMessage;-;+306912345678", handle: "+306912345678", text: "see you at eight", at: 1_800_000_000_000 }],
      });
      return "ok\n0";
    },
  };
});
afterEach(() => {
  runtime?.dispose();
  runtime = undefined;
  rmSync(root, { recursive: true, force: true });
});

const make = () => (runtime = createMessagesRuntime({ home: join(root, "tropos"), userHome: join(root, "user"), exec, layout }));
const messagesTool = (r: MessagesRuntime) => r.tools().find((t) => t.name === "Messages")!;

describe("createMessagesRuntime", () => {
  test("MESSAGES_TOOLS names both tools", () => {
    expect([...MESSAGES_TOOLS].sort()).toEqual(["Messages", "SendIMessage"]);
  });

  test("tools: Messages (read) and SendIMessage (exec), built once; nothing runs until one is used", () => {
    const r = make();
    const tools = r.tools();
    expect(tools.map((t) => [t.name, toolKind(t)])).toEqual([
      ["Messages", "read"],
      ["SendIMessage", "exec"],
    ]);
    expect(r.tools()[0]).toBe(tools[0]!);
    expect(r.tools()[1]).toBe(tools[1]!);
    expect(calls).toEqual([]);
  });

  test("status without a helper: not installed, permissions unknown, and nothing is built or launched", async () => {
    const r = make();
    expect(await r.status()).toEqual({ helper: { installed: false, current: HELPER_VERSION }, fullDiskAccess: "unknown", automation: "unknown" });
    expect(calls).toEqual([]);
    expect(existsSync(helperAppPath(layout))).toBe(false);
  });

  test("enable builds the helper; status then asks it about Full Disk Access", async () => {
    const r = make();
    await r.enable();
    expect(calls).toContain("osacompile");
    expect(await r.status()).toEqual({ helper: { installed: true, version: HELPER_VERSION, current: HELPER_VERSION }, fullDiskAccess: "yes", automation: "unknown" });
    answers.status = "ok\n0\nfda=no";
    expect((await r.status()).fullDiskAccess).toBe("no");
    answers.status = "error\ntimeout\nno answer";
    expect((await r.status()).fullDiskAccess).toBe("unknown");
    // Status never asks Messages, which would raise the Automation prompt.
    expect(calls).not.toContain("request:probe");
  });

  test("status with probe asks Messages, and remembers the answer", async () => {
    const r = make();
    await r.enable();
    expect((await r.status({ probe: true })).automation).toBe("yes");
    expect((await r.status()).automation).toBe("yes");
    answers.probe = "error\n-1743\nNot authorized to send Apple events to Messages.";
    expect((await r.status({ probe: true })).automation).toBe("no");
  });

  test("the first tool use builds the helper before asking it for anything", async () => {
    const r = make();
    const out = await messagesTool(r).run({ action: "chats" }, makeToolContext());
    expect(out.isError).toBeFalsy();
    expect(String(out.content)).toContain(MESSAGES_PREAMBLE);
    expect(String(out.content)).toContain("+306912345678");
    expect(calls.indexOf("osacompile")).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf("osacompile")).toBeLessThan(calls.indexOf("request:snapshot"));
  });

  test("a helper deleted after setup is rebuilt on the next use, and status says it was missing", async () => {
    const r = make();
    await r.enable();
    rmSync(helperAppPath(layout), { recursive: true, force: true });
    expect((await r.status()).helper.installed).toBe(false);
    calls = [];
    const out = await messagesTool(r).run({ action: "chats" }, makeToolContext());
    expect(out.isError).toBeFalsy();
    expect(calls[0]).toBe("osacompile");
    expect((await r.status()).helper).toEqual({ installed: true, version: HELPER_VERSION, current: HELPER_VERSION });
  });

  test("a helper that can't be built gives a plain error and never asks for data", async () => {
    const failing: Exec = async (cmd, args, t) => (cmd.endsWith("osacompile") ? { code: 1, stdout: "", stderr: "no compiler here" } : exec(cmd, args, t));
    runtime = createMessagesRuntime({ home: join(root, "tropos"), userHome: join(root, "user"), exec: failing, layout });
    const out = await messagesTool(runtime).run({ action: "chats" }, makeToolContext());
    expect(out.isError).toBe(true);
    expect(String(out.content)).toContain("no compiler here");
    expect(calls).not.toContain("request:snapshot");
    const send = await runtime.tools()[1]!.run({ to: "+306912345678", text: "hi" }, makeToolContext());
    expect(send.isError).toBe(true);
    expect(calls).not.toContain("request:send-handle");
  });

  test("after dispose the tools refuse", async () => {
    const r = make();
    r.dispose();
    const out = await messagesTool(r).run({ action: "chats" }, makeToolContext());
    expect(out.isError).toBe(true);
    expect(calls).not.toContain("request:snapshot");
  });
});
