// src/session/store.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFile, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import { projectKey } from "../paths";
import { SessionStore, danglingToolResults, listSessions, projectDir, readSessionFile, type MessageParam } from "./store";

let home: string;
const cwd = "/work/my app";
beforeEach(async () => {
  home = await makeTmpDir();
});
afterEach(() => removeDir(home));

const user = (text: string): MessageParam => ({ role: "user", content: [{ type: "text", text }] });
const assistantText = (text: string): MessageParam => ({ role: "assistant", content: [{ type: "text", text }] });

describe("projectDir", () => {
  test("uses the collision-free project key", () => {
    expect(projectDir("/h", "/work/my app")).toBe(`/h/projects/${projectKey("/work/my app")}`);
    expect(projectDir("/h", "/a/b-c")).not.toBe(projectDir("/h", "/a-b/c"));
  });
});

describe("SessionStore", () => {
  test("round trip", async () => {
    const store = await SessionStore.create(home, { cwd, model: "claude-opus-5-5", version: "0.1.0" });
    await store.appendMessage(user("hello"));
    await store.appendMessage(assistantText("hi"));
    await store.appendEvent("mode", "plan");
    const opened = await SessionStore.open(home, cwd, store.id);
    expect(opened.messages).toEqual([user("hello"), assistantText("hi")]);
    expect(opened.meta).toMatchObject({ sessionId: store.id, cwd, model: "claude-opus-5-5", title: "hello" });
    expect(store.path).toBe(join(projectDir(home, cwd), `${store.id}.jsonl`));
  });

  test("title skips the context and mode blocks and is truncated", async () => {
    const store = await SessionStore.create(home, { cwd, model: "m", version: "v" });
    await store.appendMessage({
      role: "user",
      content: [
        { type: "text", text: "<context>\nstuff\n</context>" },
        { type: "text", text: "<mode>Plan mode is on.</mode>" },
        { type: "text", text: `fix   the\nlogin bug ${"x".repeat(80)}` },
      ],
    });
    const { meta } = await readSessionFile(store.path);
    expect(meta.title).toStartWith("fix the login bug x");
    expect(meta.title!.length).toBeLessThanOrEqual(60);
  });

  test("skips a truncated trailing line", async () => {
    const store = await SessionStore.create(home, { cwd, model: "m", version: "v" });
    await store.appendMessage(user("one"));
    await appendFile(store.path, '{"type":"message","message":{"role":"assis');
    expect((await readSessionFile(store.path)).messages).toEqual([user("one")]);
  });

  test("open repairs a dangling tool_use by appending results", async () => {
    const store = await SessionStore.create(home, { cwd, model: "m", version: "v" });
    await store.appendMessage(user("go"));
    await store.appendMessage({
      role: "assistant",
      content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } }],
    });
    const { messages } = await SessionStore.open(home, cwd, store.id);
    expect(messages.at(-1)).toEqual({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "Not run: the session ended before this tool call finished.", is_error: true }],
    });
    const raw = await readFile(store.path, "utf8");
    expect(raw.trim().split("\n")).toHaveLength(5); // meta + message + title meta + message + repair
  });

  test("open of an unknown id throws", async () => {
    await expect(SessionStore.open(home, cwd, "00000000-0000-4000-8000-000000000000")).rejects.toThrow();
  });

  test("session directories are 0700 and session files 0600", async () => {
    const store = await SessionStore.create(home, { cwd, model: "m", version: "v" });
    await store.appendMessage(user("secret code"));
    expect((await stat(store.path)).mode & 0o777).toBe(0o600);
    expect((await stat(projectDir(home, cwd))).mode & 0o777).toBe(0o700);
  });

  test("open rejects ids that are not UUIDs before touching the path", async () => {
    await expect(SessionStore.open(home, cwd, "../x")).rejects.toThrow("Invalid session id");
  });
});

describe("danglingToolResults", () => {
  test("null when the last message is not an assistant tool_use", () => {
    expect(danglingToolResults([user("x")])).toBeNull();
    expect(danglingToolResults([])).toBeNull();
  });
});

describe("listSessions", () => {
  test("newest first with titles and counts", async () => {
    const a = await SessionStore.create(home, { cwd, model: "m", version: "v" });
    await a.appendMessage(user("first session"));
    await Bun.sleep(15);
    const b = await SessionStore.create(home, { cwd, model: "m", version: "v" });
    await b.appendMessage(user("second session"));
    await b.appendMessage(assistantText("ok"));
    const list = await listSessions(home, cwd);
    expect(list.map((s) => s.title)).toEqual(["second session", "first session"]);
    expect(list[0]!.messageCount).toBe(2);
  });

  test("empty when the project has no sessions", async () => {
    expect(await listSessions(home, "/elsewhere")).toEqual([]);
  });

  test("sessions without messages are not listed", async () => {
    await SessionStore.create(home, { cwd, model: "m", version: "v" });
    expect(await listSessions(home, cwd)).toEqual([]);
  });

  test("ignores .jsonl files whose names are not session ids", async () => {
    const a = await SessionStore.create(home, { cwd, model: "m", version: "v" });
    await a.appendMessage(user("real session"));
    await writeFile(join(projectDir(home, cwd), "notes.jsonl"), `${JSON.stringify({ type: "message", message: user("stray"), ts: "x" })}\n`);
    const list = await listSessions(home, cwd);
    expect(list.map((s) => s.id)).toEqual([a.id]);
  });
});
