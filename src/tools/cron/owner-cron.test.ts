import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import { makeTmpDir, removeDir } from "../../../test/helpers/tmp";
import { makeToolContext } from "../../../test/helpers/tool-context";
import { gatewayDir } from "../../gateway/config";
import { CronStore } from "../../gateway/cron/store";
import { FilePairing } from "../../gateway/pairing";
import { ownerCronTool } from "./owner-cron";

let home: string;
beforeEach(async () => {
  home = await makeTmpDir();
});
afterEach(() => removeDir(home));

const add = { action: "add" as const, name: "digest", schedule: "every 5m", prompt: "p" };

test("the terminal's Cron tool delivers to the owner's chat by default, or nowhere without an owner", async () => {
  const store = new CronStore(home);
  const none = await ownerCronTool(home);
  await none.run(add, makeToolContext());
  expect(store.list()[0]!.deliver).toBe("none");

  const pairing = new FilePairing({ path: join(gatewayDir(home), "pairing.json") });
  const c = await pairing.challenge("telegram", "42");
  if (c.kind !== "code") throw new Error("expected a code");
  await pairing.approve("telegram", c.code);
  const tool = await ownerCronTool(home);
  await tool.run({ ...add, name: "second" }, makeToolContext());
  expect(new CronStore(home).list().find((j) => j.name === "second")!.deliver).toBe("telegram:42");
  // Sees jobs of every chat.
  const theirs = new CronStore(home).add({ name: "x", schedule: { kind: "every", ms: 120_000 }, prompt: "p", project: "default", deliver: "telegram:99", createdBy: "agent" });
  expect(String((await tool.run({ action: "list" }, makeToolContext())).content)).toContain(theirs.id);
  expect((await tool.run({ action: "disable", id: theirs.id }, makeToolContext())).isError).toBeFalsy();
  expect(new CronStore(home).get(theirs.id)!.enabled).toBe(false);
  expect((await tool.run({ action: "remove", id: theirs.id }, makeToolContext())).isError).toBeFalsy();
  expect(new CronStore(home).get(theirs.id)).toBeUndefined();
});
