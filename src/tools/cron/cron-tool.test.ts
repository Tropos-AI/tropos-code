import { afterEach, beforeEach, expect, test } from "bun:test";
import { makeTmpDir, removeDir } from "../../../test/helpers/tmp";
import { makeToolContext } from "../../../test/helpers/tool-context";
import { CronStore } from "../../gateway/cron/store";
import { toolKind } from "../types";
import { createCronTool } from "./cron-tool";

let home: string;
let store: CronStore;
beforeEach(async () => {
  home = await makeTmpDir();
  store = new CronStore(home);
});
afterEach(() => removeDir(home));

const text = (o: { content: unknown }) => String(o.content);

test("is an exec tool, so it always asks", () => {
  const tool = createCronTool({ store });
  expect(toolKind(tool)).toBe("exec");
  expect(tool.subject({ action: "list" }, "/x")).toEqual({ paths: [], target: "cron:list" });
});

test("add with a human schedule stores an agent-made job delivering to the default chat", async () => {
  const tool = createCronTool({ store, defaultDeliver: () => "telegram:9" });
  const out = await tool.run({ action: "add", name: "digest", schedule: "every day at 09:00", prompt: "summarize the repo" }, makeToolContext());
  expect(out.isError).toBeFalsy();
  const [job] = store.list();
  expect(job).toMatchObject({ name: "digest", createdBy: "agent", deliver: "telegram:9", project: "default", schedule: { kind: "cron", expr: "0 9 * * *" } });
});

test("add with a structured schedule; deliverTo may repeat this chat or say none; none without a chat", async () => {
  const tool = createCronTool({ store, defaultDeliver: () => "telegram:5" });
  await tool.run({ action: "add", name: "a", schedule: { kind: "every", ms: 120_000 }, prompt: "p" }, makeToolContext());
  await tool.run({ action: "add", name: "b", schedule: { kind: "cron", expr: "0 8 * * 1", tz: "Europe/Athens" }, prompt: "p", deliverTo: "telegram:5", project: "web", allowCommands: ["Bash(npm test:*)"] }, makeToolContext());
  const [a, b] = store.list();
  expect(a).toMatchObject({ deliver: "telegram:5", schedule: { kind: "every", ms: 120_000 } });
  expect(b).toMatchObject({ deliver: "telegram:5", project: "web", allowCommands: ["Bash(npm test:*)"], schedule: { tz: "Europe/Athens" } });
});

test("a job can't be delivered to another chat, from a chat or from a session that has none", async () => {
  const inChat = createCronTool({ store, defaultDeliver: () => "telegram:5" });
  const elsewhere = await inChat.run({ action: "add", name: "x", schedule: "every 5m", prompt: "p", deliverTo: "telegram:99" }, makeToolContext());
  expect(elsewhere.isError).toBe(true);
  expect(elsewhere.content).toContain("telegram:99");
  const noChat = createCronTool({ store });
  expect((await noChat.run({ action: "add", name: "y", schedule: "every 5m", prompt: "p", deliverTo: "telegram:5" }, makeToolContext())).isError).toBe(true);
  expect((await noChat.run({ action: "add", name: "z", schedule: "every 5m", prompt: "p", deliverTo: "none" }, makeToolContext())).isError).toBeFalsy();
  expect(store.list().map((j) => j.name)).toEqual(["z"]);
});

test("refuses intervals under a minute and bad schedules, storing nothing", async () => {
  const tool = createCronTool({ store });
  for (const schedule of [{ kind: "every" as const, ms: 30_000 }, "every 10s", { kind: "cron" as const, expr: "61 * * * *" }, { kind: "at" as const, at: "soon" }, "gibberish", { kind: "every" as const }]) {
    const out = await tool.run({ action: "add", name: "x", schedule, prompt: "p" }, makeToolContext());
    expect(out.isError).toBe(true);
  }
  expect(store.list()).toEqual([]);
});

test("add needs name, schedule and prompt", async () => {
  const tool = createCronTool({ store });
  expect((await tool.run({ action: "add", schedule: "every 5m", prompt: "p" }, makeToolContext())).isError).toBe(true);
  expect((await tool.run({ action: "add", name: "n", prompt: "p" }, makeToolContext())).isError).toBe(true);
  expect((await tool.run({ action: "add", name: "n", schedule: "every 5m" }, makeToolContext())).isError).toBe(true);
});

test("the permission preview shows the whole job", () => {
  const tool = createCronTool({ store, defaultDeliver: () => "telegram:9" });
  const preview = tool.preview!({ action: "add", name: "nightly", schedule: "every day at 02:30", prompt: "rm -rf the cache, then report", allowCommands: ["Bash(rm:*)"] });
  expect(preview!.header).toContain("add job");
  for (const part of ["nightly", "cron \"30 2 * * *\"", "rm -rf the cache, then report", "telegram:9", "Bash(rm:*)", "default"]) expect(preview!.text).toContain(part);
});

test("the preview of an invalid add says why; for remove it shows the stored job; list has none", () => {
  const tool = createCronTool({ store });
  expect(tool.preview!({ action: "add", name: "n", schedule: "every 5s", prompt: "p" })!.text).toContain("1 minute");
  const job = store.add({ name: "keep", prompt: "precious prompt", schedule: { kind: "every", ms: 60_000 } });
  expect(tool.preview!({ action: "remove", id: job.id.slice(0, 5) })!.text).toContain("precious prompt");
  expect(tool.preview!({ action: "list" })).toBeUndefined();
});

test("list, disable, enable, remove by prefix", async () => {
  const tool = createCronTool({ store });
  const job = store.add({ name: "j", prompt: "p", schedule: { kind: "every", ms: 60_000 } });
  const ctx = makeToolContext();
  expect(text(await tool.run({ action: "list" }, ctx))).toContain(job.id);
  expect(text(await tool.run({ action: "disable", id: job.id.slice(0, 4) }, ctx))).toContain("disabled");
  expect(store.get(job.id)!.enabled).toBe(false);
  expect(text(await tool.run({ action: "enable", id: job.id }, ctx))).toContain("enabled");
  expect(text(await tool.run({ action: "remove", id: job.id }, ctx))).toContain("Removed");
  expect(text(await tool.run({ action: "list" }, ctx))).toBe("No scheduled jobs.");
  expect((await tool.run({ action: "remove", id: "zzz" }, ctx)).isError).toBe(true);
  expect((await tool.run({ action: "remove" }, ctx)).isError).toBe(true);
});

test("run starts the job without waiting, or is refused without a gateway", async () => {
  const job = store.add({ name: "j", prompt: "p", schedule: { kind: "every", ms: 60_000 } });
  const ctx = makeToolContext();
  expect((await createCronTool({ store }).run({ action: "run", id: job.id }, ctx)).isError).toBe(true);
  const started: string[] = [];
  const tool = createCronTool({
    store,
    runNow: (id) => {
      started.push(id);
      return new Promise(() => {});
    },
  });
  expect((await tool.run({ action: "run", id: job.id.slice(0, 4) }, ctx)).isError).toBeFalsy();
  expect(started).toEqual([job.id]);
});

test("from a chat, other chats' jobs cannot be listed, previewed, changed or run", async () => {
  const mine = createCronTool({ store, defaultDeliver: () => "telegram:1" });
  const theirs = store.add({ name: "secret", schedule: { kind: "every", ms: 120_000 }, prompt: "private", project: "default", deliver: "telegram:2", createdBy: "agent" });
  expect(text(await mine.run({ action: "list" }, makeToolContext()))).toBe("No scheduled jobs.");
  for (const action of ["remove", "enable", "disable", "run"] as const) {
    const out = await mine.run({ action, id: theirs.id }, makeToolContext());
    expect(out.isError).toBe(true);
  }
  expect((await mine.preview?.({ action: "remove", id: theirs.id }))?.text ?? "").not.toContain("private");
  expect(store.list()).toHaveLength(1);
});

test("from a chat, an ambiguous prefix never names jobs of other chats", async () => {
  const mine = createCronTool({ store, defaultDeliver: () => "telegram:1" });
  const a = store.add({ name: "a", schedule: { kind: "every", ms: 120_000 }, prompt: "p", project: "default", deliver: "telegram:2", createdBy: "agent" });
  const b = store.add({ name: "b", schedule: { kind: "every", ms: 120_000 }, prompt: "p", project: "default", deliver: "telegram:3", createdBy: "agent" });
  const common = [...a.id].findIndex((c, i) => c !== b.id[i]);
  const out = await mine.run({ action: "remove", id: a.id.slice(0, Math.max(common, 0)) }, makeToolContext());
  expect(out.isError).toBe(true);
  expect(text(out)).not.toContain(a.id);
  expect(text(out)).not.toContain(b.id);
});

test("with seeAll a session lists every job and new jobs go to the default target", async () => {
  const other = store.add({ name: "theirs", schedule: { kind: "every", ms: 120_000 }, prompt: "p", project: "default", deliver: "telegram:2", createdBy: "agent" });
  const tool = createCronTool({ store, seeAll: true, defaultDeliver: () => "telegram:1" });
  expect(text(await tool.run({ action: "list" }, makeToolContext()))).toContain(other.id);
  expect((await tool.run({ action: "disable", id: other.id }, makeToolContext())).isError).toBeFalsy();
  expect(store.get(other.id)!.enabled).toBe(false);
  expect((await tool.run({ action: "add", name: "mine", schedule: "every 5m", prompt: "p" }, makeToolContext())).isError).toBeFalsy();
  expect(store.list().find((j) => j.name === "mine")!.deliver).toBe("telegram:1");
  expect((await tool.run({ action: "remove", id: other.id }, makeToolContext())).isError).toBeFalsy();
});

test("without a default target a new job delivers nowhere", async () => {
  const tool = createCronTool({ store, seeAll: true, defaultDeliver: () => undefined });
  await tool.run({ action: "add", name: "n", schedule: "every 5m", prompt: "p" }, makeToolContext());
  expect(store.list()[0]!.deliver).toBe("none");
});
