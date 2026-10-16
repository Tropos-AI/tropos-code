// src/gateway/router.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import { FakeSessions } from "../../test/helpers/telegram-fakes";
import { addProject, setDefaultProject, removeProject } from "./projects";
import { ChatRouter, RoutedSessions, parseSessionKey, sessionKey } from "./router";

let dir: string;
let home: string;
beforeEach(async () => {
  dir = await makeTmpDir("gateway-router");
  home = join(dir, "tropos");
  await mkdir(home, { recursive: true });
  await mkdir(join(dir, "user", "app"), { recursive: true });
  await mkdir(join(dir, "user", "api"), { recursive: true });
  await addProject(home, { path: join(dir, "user", "app") }, { userHome: join(dir, "nobody") });
  await addProject(home, { path: join(dir, "user", "api") }, { userHome: join(dir, "nobody") });
});
afterEach(() => removeDir(dir));

describe("ChatRouter", () => {
  test("a chat is in the default project until it picks, and the pick survives a restart", async () => {
    const router = new ChatRouter({ home });
    expect((await router.current("telegram:1")).id).toBe("default");
    await setDefaultProject(home, "api");
    expect((await router.current("telegram:1")).id).toBe("api");

    expect((await router.select("telegram:1", "app")).id).toBe("app");
    expect((await new ChatRouter({ home }).current("telegram:1")).id).toBe("app");
    expect((await router.current("telegram:2")).id).toBe("api");
  });

  test("selecting a project that doesn't exist fails and changes nothing", async () => {
    const router = new ChatRouter({ home });
    await expect(router.select("telegram:1", "ghost")).rejects.toThrow(/no project "ghost"/);
    expect((await router.current("telegram:1")).id).toBe("default");
  });

  test("a chat whose project was removed falls back to the default", async () => {
    const router = new ChatRouter({ home });
    await router.select("telegram:1", "app");
    await removeProject(home, "app");
    expect((await router.current("telegram:1")).id).toBe("default");
  });

  test("chats.json is private, and concurrent selects don't lose each other", async () => {
    const router = new ChatRouter({ home });
    await Promise.all([router.select("telegram:1", "app"), router.select("telegram:2", "api"), router.select("telegram:3", "app")]);
    expect([(await router.current("telegram:1")).id, (await router.current("telegram:2")).id, (await router.current("telegram:3")).id]).toEqual(["app", "api", "app"]);
    if (process.platform !== "win32") expect((await stat(join(home, "gateway", "chats.json"))).mode & 0o777).toBe(0o600);
  });
});

describe("session keys", () => {
  test("are <chat>@<project> and parse back", () => {
    expect(sessionKey("telegram:42", "app")).toBe("telegram:42@app");
    expect(parseSessionKey("telegram:42@app")).toEqual({ chatKey: "telegram:42", projectId: "app" });
    expect(parseSessionKey("telegram:42")).toBeUndefined();
  });

  test("RoutedSessions opens the session of the chat's current project, and switching opens another", async () => {
    const pool = new FakeSessions();
    const router = new ChatRouter({ home });
    const sessions = new RoutedSessions(router, pool);
    await sessions.open("telegram:1");
    await router.select("telegram:1", "app");
    await sessions.open("telegram:1");
    expect([...pool.sessions.keys()]).toEqual(["telegram:1@default", "telegram:1@app"]);
    await sessions.close("telegram:1");
    expect([...pool.sessions.keys()]).toEqual(["telegram:1@default"]);
  });
});
