// src/session/store.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFile, chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
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
const isRoot = process.getuid?.() === 0;

/** Every assistant tool_use is answered by a user message that directly follows it. */
function assertToolPairs(messages: MessageParam[]) {
  messages.forEach((m, i) => {
    if (m.role !== "assistant" || typeof m.content === "string") return;
    const ids = m.content.flatMap((b) => (b.type === "tool_use" ? [b.id] : []));
    if (ids.length === 0) return;
    const next = messages[i + 1];
    expect(next?.role).toBe("user");
    const content = next!.content;
    expect(typeof content).not.toBe("string");
    const results = (content as Array<{ type: string; tool_use_id?: string }>).flatMap((b) =>
      b.type === "tool_result" ? [b.tool_use_id] : [],
    );
    expect(results).toEqual(ids);
  });
}

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

  test("a subagent transcript is saved under its parent session and isn't listed as a session", async () => {
    const parent = await SessionStore.create(home, { cwd, model: "claude-opus-5-5", version: "0.1.0" });
    await parent.appendMessage(user("main"));
    const child = await SessionStore.createSubagent(home, { cwd, parentId: parent.id, agent: "explore", model: "claude-haiku-5-5", version: "0.1.0" });
    await child.appendMessage(user("child task"));
    expect(child.path).toBe(join(projectDir(home, cwd), "subagents", parent.id, `${child.id}.jsonl`));
    const saved = await readSessionFile(child.path);
    expect(saved.meta).toMatchObject({ parentId: parent.id, agent: "explore", sessionId: child.id });
    expect(saved.messages).toEqual([user("child task")]);
    expect((await listSessions(home, cwd)).map((s) => s.id)).toEqual([parent.id]);
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

  test("a torn tail is terminated before the repair, and reopening does not repair twice", async () => {
    const store = await SessionStore.create(home, { cwd, model: "m", version: "v" });
    await store.appendMessage(user("go"));
    await store.appendMessage({
      role: "assistant",
      content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } }],
    });
    await appendFile(store.path, '{"type":"message","message":{"role":"assis');
    const first = await SessionStore.open(home, cwd, store.id);
    assertToolPairs(first.messages);
    const second = await SessionStore.open(home, cwd, store.id);
    expect(second.messages).toHaveLength(3);
    expect(second.messages.at(-1)).toEqual(first.messages.at(-1));
    assertToolPairs(second.messages);
    const raw = await readFile(store.path, "utf8");
    expect(raw.match(/Not run:/g)).toHaveLength(1);
  });

  test.skipIf(isRoot)("a failed append does not poison later appends", async () => {
    const store = await SessionStore.create(home, { cwd, model: "m", version: "v" });
    await store.appendMessage(user("one"));
    await chmod(store.path, 0o400);
    await expect(store.appendMessage(user("two"))).rejects.toThrow();
    await chmod(store.path, 0o600);
    await store.appendMessage(user("three"));
    expect((await readSessionFile(store.path)).messages).toEqual([user("one"), user("three")]);
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

describe("malformed lines", () => {
  test("lines that are not objects and message lines without a message are skipped", async () => {
    const store = await SessionStore.create(home, { cwd, model: "m", version: "v" });
    await store.appendMessage(user("one"));
    await appendFile(store.path, `null\n42\n${JSON.stringify({ type: "message", ts: "x" })}\n`);
    await store.appendMessage(user("two"));
    expect((await readSessionFile(store.path)).messages).toEqual([user("one"), user("two")]);
    expect((await listSessions(home, cwd)).map((x) => x.messageCount)).toEqual([2]);
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

  test("entries that cannot be read are skipped instead of failing the listing", async () => {
    const a = await SessionStore.create(home, { cwd, model: "m", version: "v" });
    await a.appendMessage(user("real"));
    await mkdir(join(projectDir(home, cwd), "11111111-1111-4111-8111-111111111111.jsonl"));
    expect((await listSessions(home, cwd)).map((s) => s.id)).toEqual([a.id]);
  });
});
