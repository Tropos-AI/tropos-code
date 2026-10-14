// src/web/serve.test.ts
import { expect, test } from "bun:test";
import { openInBrowser, untilSignal } from "./serve";

test("each platform's opener gets the URL; a missing opener is ignored", () => {
  const calls: string[][] = [];
  const spawn = ((argv: string[]) => {
    calls.push(argv);
    return { unref() {} };
  }) as unknown as typeof Bun.spawn;
  openInBrowser("http://127.0.0.1:1/?token=t", "darwin", spawn);
  openInBrowser("http://127.0.0.1:1/?token=t", "linux", spawn);
  openInBrowser("http://127.0.0.1:1/?token=t", "win32", spawn);
  expect(calls.map((c) => c[0])).toEqual(["open", "xdg-open", "cmd"]);
  const failing = (() => {
    throw new Error("ENOENT");
  }) as unknown as typeof Bun.spawn;
  expect(() => openInBrowser("http://x", "linux", failing)).not.toThrow();
});

test("waits for SIGINT or SIGTERM, then stops listening", async () => {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    const before = process.listenerCount(signal);
    const waiting = untilSignal();
    expect(process.listenerCount(signal)).toBe(before + 1);
    process.emit(signal);
    await waiting;
    expect(process.listenerCount(signal)).toBe(before);
  }
});
