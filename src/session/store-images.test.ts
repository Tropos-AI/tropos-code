// src/session/store-images.test.ts — images are saved beside the transcript, not inline, and come back on resume.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readdir, readFile, rm, stat } from "node:fs/promises";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import { SessionStore, listSessions, type MessageParam } from "./store";

let home: string;
const cwd = "/work/images";
beforeEach(async () => {
  home = await makeTmpDir();
});
afterEach(() => removeDir(home));

const DATA = Buffer.from(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])).toString("base64");
const imageBlock = { type: "image" as const, source: { type: "base64" as const, media_type: "image/png" as const, data: DATA } };
const withImage: MessageParam = {
  role: "user",
  content: [{ type: "text", text: '<attachment name="notes.txt">\nhi\n</attachment>' }, imageBlock, { type: "text", text: "what is in the picture?" }],
};
const filesDir = (store: SessionStore) => store.path.replace(/\.jsonl$/, ".attachments");

describe("SessionStore images", () => {
  test("an image is written beside the transcript, the JSONL holds only a reference, and resume restores it", async () => {
    const store = await SessionStore.create(home, { cwd, model: "m", version: "0" });
    await store.appendMessage(withImage);
    const jsonl = await readFile(store.path, "utf8");
    expect(jsonl).not.toContain(DATA);
    const files = await readdir(filesDir(store));
    expect(files).toEqual([expect.stringMatching(/^[0-9a-f]{32}\.png$/)]);
    expect(Buffer.from(await readFile(`${filesDir(store)}/${files[0]}`)).toString("base64")).toBe(DATA);
    if (process.getuid?.() !== 0) expect((await stat(`${filesDir(store)}/${files[0]}`)).mode & 0o777).toBe(0o600);

    const opened = await SessionStore.open(home, cwd, store.id);
    expect(opened.messages).toEqual([withImage]);
  });

  test("the same image twice is stored once", async () => {
    const store = await SessionStore.create(home, { cwd, model: "m", version: "0" });
    await store.appendMessage(withImage);
    await store.appendMessage({ role: "user", content: [imageBlock] });
    expect(await readdir(filesDir(store))).toHaveLength(1);
  });

  test("an image inside a tool result is stored the same way", async () => {
    const store = await SessionStore.create(home, { cwd, model: "m", version: "0" });
    const result: MessageParam = { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "a picture" }, imageBlock] }] };
    await store.appendMessage(result);
    expect(await readFile(store.path, "utf8")).not.toContain(DATA);
    expect((await SessionStore.open(home, cwd, store.id)).messages).toEqual([result]);
  });

  test("a deleted image comes back as a note, so the session still resumes", async () => {
    const store = await SessionStore.create(home, { cwd, model: "m", version: "0" });
    await store.appendMessage(withImage);
    await rm(filesDir(store), { recursive: true });
    const { messages } = await SessionStore.open(home, cwd, store.id);
    const content = messages[0]!.content as Array<{ type: string; text?: string }>;
    expect(content.map((b) => b.type)).toEqual(["text", "text", "text"]);
    expect(content[1]!.text).toMatch(/image .*no longer available/);
  });

  test("the title is the typed text, not the attached file", async () => {
    const store = await SessionStore.create(home, { cwd, model: "m", version: "0" });
    await store.appendMessage(withImage);
    const [summary] = await listSessions(home, cwd);
    expect(summary!.title).toBe("what is in the picture?");
  });
});
