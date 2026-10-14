import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import { LspClient } from "./client";

/**
 * A raw JSON-RPC peer: on start it writes awkward frames (split, batched, malformed), then answers
 * "echo" with its params, "fail" with an error, ignores "never", exits on "die", and sends "ask" as
 * a request of its own, reporting our answer back as an "answered" notification.
 */
const PEER = `
const frame = (m) => { const b = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...m })); return Buffer.concat([Buffer.from("Content-Length: " + b.length + "\\r\\n\\r\\n"), b]); };
const out = (b) => process.stdout.write(b);
out(Buffer.from("X-Junk: 1\\r\\n\\r\\n"));
out(Buffer.from("Content-Length: 3\\r\\n\\r\\n{x}"));
const split = frame({ method: "note", params: { n: "split ✓" } });
out(split.subarray(0, 10));
setTimeout(() => {
  out(split.subarray(10));
  out(Buffer.concat([frame({ method: "note", params: { n: 2 } }), frame({ method: "note", params: { n: 3 } }), frame({ id: 999, result: 1 }), frame({ id: "x", result: 1 })]));
  out(frame({ method: "boom" }));
  out(frame({ method: "unknown" }));
}, 30);
let buf = Buffer.alloc(0);
process.stdin.on("data", (c) => {
  buf = Buffer.concat([buf, c]);
  while (true) {
    const end = buf.indexOf("\\r\\n\\r\\n");
    if (end < 0) return;
    const len = Number(/Content-Length: (\\d+)/.exec(buf.subarray(0, end).toString())[1]);
    if (buf.length < end + 4 + len) return;
    const msg = JSON.parse(buf.subarray(end + 4, end + 4 + len).toString());
    buf = buf.subarray(end + 4 + len);
    if (msg.method === "echo") out(frame({ id: msg.id, result: msg.params }));
    else if (msg.method === "fail") out(frame({ id: msg.id, error: { code: 1, message: "nope" } }));
    else if (msg.method === "blank-error") out(frame({ id: msg.id, error: {} }));
    else if (msg.method === "die") process.exit(3);
    else if (msg.method === "ask") out(frame({ id: "s" + msg.params, method: msg.params === 1 ? "thrower" : "question", params: { q: 1 } }));
    else if (msg.id && msg.id.startsWith?.("s")) out(frame({ method: "answered", params: msg }));
  }
});
`;

let dir: string;
let peer: string;
let clients: LspClient[];

function start(): LspClient {
  const client = new LspClient([process.execPath, peer], { cwd: dir });
  clients.push(client);
  return client;
}

function next(client: LspClient, method: string): Promise<unknown> {
  return new Promise((resolve) => client.onNotification(method, resolve));
}

beforeEach(async () => {
  dir = await makeTmpDir();
  peer = join(dir, "peer.js");
  clients = [];
  await writeFile(peer, PEER);
});
afterEach(async () => {
  for (const c of clients) c.kill();
  await removeDir(dir);
});

describe("LspClient", () => {
  test("parses split, batched and malformed frames", async () => {
    const client = start();
    const notes: unknown[] = [];
    const third = new Promise<void>((resolve) =>
      client.onNotification("note", (p) => {
        notes.push((p as { n: unknown }).n);
        if (notes.length === 3) resolve();
      }),
    );
    client.onNotification("boom", () => {
      throw new Error("handler bug");
    });
    await third;
    expect(notes).toEqual(["split ✓", 2, 3]);
    // The read loop survives the throwing handler and unknown ids.
    expect(await client.request("echo", { a: 1 })).toEqual({ a: 1 });
  });

  test("requests resolve, reject on errors and time out", async () => {
    const client = start();
    expect(await client.request("echo", null, 2000)).toBeNull();
    await expect(client.request("fail", {})).rejects.toThrow("fail: nope");
    await expect(client.request("blank-error", {})).rejects.toThrow("blank-error: error");
    await expect(client.request("never", {}, 100)).rejects.toThrow("never timed out after 100ms");
  });

  test("answers server requests with the handler's result, else null", async () => {
    const client = start();
    client.onRequest("question", (p) => ({ got: p }));
    client.onRequest("thrower", () => {
      throw new Error("x");
    });
    let answered = next(client, "answered");
    client.notify("ask", 2);
    expect(await answered).toMatchObject({ id: "s2", result: { got: { q: 1 } } });
    answered = next(client, "answered");
    client.notify("ask", 1);
    expect(await answered).toMatchObject({ id: "s1", result: null });
  });

  test("a dying server rejects pending requests and later ones", async () => {
    const client = start();
    const pending = client.request("never", {});
    client.notify("die");
    await expect(pending).rejects.toThrow("server exited (code 3)");
    await client.exited;
    expect(client.alive).toBeFalse();
    await expect(client.request("echo", {})).rejects.toThrow("echo: server is not running");
    client.notify("ignored after death");
  });

  test("a missing executable resolves exited without throwing", async () => {
    const client = new LspClient([join(dir, "missing")], { cwd: dir });
    await client.exited;
    expect(client.alive).toBeFalse();
    client.kill();
  });

  test("kill() ends the process", async () => {
    const client = start();
    client.kill();
    await client.exited;
    expect(client.alive).toBeFalse();
  });
});
