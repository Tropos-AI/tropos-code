// src/install/fetch.test.ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { once } from "node:events";
import { createServer, type Server } from "node:net";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import { InstallError } from "./errors";
import { downloadToFile, fetchBytes } from "./fetch";

let dir: string;
let server: ReturnType<typeof Bun.serve>;
let base: string;
let resetServer: Server;

beforeAll(async () => {
  dir = await makeTmpDir();
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const { pathname, origin } = new URL(req.url);
      if (pathname === "/ok") return new Response("hello");
      if (pathname === "/redirect") return Response.redirect(`${origin}/ok`, 302);
      if (pathname === "/loop") return Response.redirect(`${origin}/loop`, 302);
      if (pathname === "/to-http") return Response.redirect("http://example.com/x", 302);
      if (pathname === "/big") return new Response("x".repeat(1000));
      if (pathname === "/slow-headers") {
        await Bun.sleep(500);
        return new Response("late");
      }
      if (pathname === "/stall") {
        return new Response(
          new ReadableStream({
            async start(c) {
              c.enqueue(new TextEncoder().encode("first"));
              await Bun.sleep(1000);
              c.close();
            },
          }),
        );
      }
      if (pathname === "/500") return new Response("<html>oops</html>", { status: 500 });
      return new Response("<html>nope</html>", { status: 404 });
    },
  });
  base = `http://127.0.0.1:${server.port}`;
  // Promises 100 bytes, sends 4, then destroys the socket.
  resetServer = createServer((socket) => {
    socket.on("error", () => {});
    socket.once("data", () => {
      socket.write("HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\nsome");
      setTimeout(() => socket.destroy(), 20);
    });
  }).listen(0, "127.0.0.1");
  await once(resetServer, "listening");
});
afterAll(async () => {
  server.stop(true);
  resetServer.close();
  await removeDir(dir);
});

const opts = { maxBytes: 100, timeoutMs: 2000, allowLoopbackHttp: true };
const failure = async (p: Promise<unknown>) => (await p.then(() => null, (e: unknown) => e)) as InstallError;

describe("fetchBytes", () => {
  test("returns the body", async () => {
    expect(new TextDecoder().decode(await fetchBytes(`${base}/ok`, opts))).toBe("hello");
  });

  test("follows redirects", async () => {
    expect(new TextDecoder().decode(await fetchBytes(`${base}/redirect`, opts))).toBe("hello");
  });

  test("refuses plain http unless loopback was allowed in code", async () => {
    const e = await failure(fetchBytes(`${base}/ok`, { ...opts, allowLoopbackHttp: false }));
    expect(e.kind).toBe("integrity");
    expect(e.message).toStartWith("refusing a non-HTTPS URL");
  });

  test("refuses a redirect to plain http", async () => {
    expect((await failure(fetchBytes(`${base}/to-http`, opts))).message).toBe("refusing a non-HTTPS URL: http://example.com/x");
  });

  test("stops after 5 redirects", async () => {
    expect((await failure(fetchBytes(`${base}/loop`, opts))).message).toStartWith("too many redirects");
  });

  test("non-200 is a network error", async () => {
    const e = await failure(fetchBytes(`${base}/500`, opts));
    expect(e.kind).toBe("network");
    expect(e.message).toBe(`127.0.0.1:${server.port} answered HTTP 500 for /500`);
    expect((await failure(fetchBytes(`${base}/missing`, opts))).kind).toBe("network");
  });

  test("a body over maxBytes is an integrity error", async () => {
    expect((await failure(fetchBytes(`${base}/big`, opts))).kind).toBe("integrity");
  });

  test("timeout", async () => {
    const e = await failure(fetchBytes(`${base}/slow-headers`, { ...opts, timeoutMs: 100 }));
    expect(e.kind).toBe("network");
    expect(e.message).toContain("did not respond within 0.1 s");
  });

  test("connection refused is a network error", async () => {
    const e = await failure(fetchBytes("http://127.0.0.1:9/x", opts));
    expect(e.kind).toBe("network");
    expect(e.message).toStartWith("could not reach 127.0.0.1:9");
  });
});

describe("downloadToFile", () => {
  test("writes, hashes and counts", async () => {
    const dest = join(dir, "ok.bin");
    const r = await downloadToFile(`${base}/ok`, dest, opts);
    expect(r).toEqual({ size: 5, sha256: new Bun.CryptoHasher("sha256").update("hello").digest("hex") });
    expect(await readFile(dest, "utf8")).toBe("hello");
  });

  test("never overwrites an existing file", async () => {
    const dest = join(dir, "exists.bin");
    await Bun.write(dest, "keep");
    await expect(downloadToFile(`${base}/ok`, dest, opts)).rejects.toThrow();
    expect(await readFile(dest, "utf8")).toBe("keep");
  });

  test("stops at maxBytes", async () => {
    expect((await failure(downloadToFile(`${base}/big`, join(dir, "big.bin"), opts))).kind).toBe("integrity");
  });

  test("fails when the stream stalls", async () => {
    const e = await failure(downloadToFile(`${base}/stall`, join(dir, "stall.bin"), { ...opts, idleTimeoutMs: 200 }));
    expect(e.kind).toBe("network");
    expect(e.message).toContain("stalled");
  });

  test("a body that errors mid-transfer is a network error", async () => {
    const e = await failure(downloadToFile(`http://127.0.0.1:${(resetServer.address() as { port: number }).port}/x`, join(dir, "reset.bin"), opts));
    expect(e.kind).toBe("network");
  });

  test.skipIf(process.getuid?.() === 0)("an unwritable destination directory is a local error", async () => {
    const ro = join(dir, "ro");
    await mkdir(ro, { mode: 0o500 });
    expect((await failure(downloadToFile(`${base}/ok`, join(ro, "x.bin"), opts))).kind).toBe("local");
  });
});
