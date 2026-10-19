// src/tools/setup/download.test.ts
import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { busyBackend, recordingBackend } from "../../../test/helpers/swap-backend";
import { makeTmpDir, removeDir } from "../../../test/helpers/tmp";
import { makeToolContext } from "../../../test/helpers/tool-context";
import { download, downloadName, downloadTarget, MAX_DOWNLOAD_BYTES } from "./download";
import { type ExtendKit, performExtend } from "./extend";

let root: string;
let project: string;
let fetched: string[];

beforeEach(async () => {
  root = await makeTmpDir();
  project = join(root, "project");
  await mkdir(project);
  fetched = [];
});
afterEach(() => removeDir(root));

const BODY = "hello, file\n";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** Answers every URL with `body` (or a redirect), recording what was asked. */
function server(body: string | ReadableStream<Uint8Array> = BODY, headers: Record<string, string> = {}, status = 200) {
  return (async (url: string) => {
    fetched.push(url);
    return new Response(body, { status, headers });
  }) as unknown as typeof fetch;
}

const place = () => ({ cwd: project, allowedDirs: [project] });
/** A stub DNS: example.com is public, intranet.example points into the local network. */
const DNS = async (host: string) => {
  if (host === "example.com") return ["93.184.216.34"];
  if (host === "intranet.example") return ["192.168.1.20"];
  throw new Error("ENOTFOUND");
};

test("a name that resolves to a private address is refused before anything is fetched, as a first URL or a redirect", async () => {
  await expect(download({ url: "https://intranet.example/a.zip" }, place(), { resolve: DNS, fetch: server() })).rejects.toThrow(/local network/);
  expect(fetched).toEqual([]);
  await expect(download({ url: "https://example.com/a" }, place(), { resolve: DNS, fetch: server("", { location: "https://intranet.example/a" }, 302) })).rejects.toThrow(/local network/);
  expect(fetched).toEqual(["https://example.com/a"]);
  expect(await readdir(project)).toEqual([]);
});

test("the file is named after the URL unless a path is given", () => {
  expect(downloadName("https://example.com/files/report%202026.pdf?x=1")).toBe("report 2026.pdf");
  expect(downloadName("https://example.com/")).toBe("download");
  expect(downloadName("https://example.com/..")).toBe("download");
  expect(downloadName("https://example.com/a%2Fb")).toBe("download");
  expect(downloadTarget({ url: "https://example.com/a.zip" }, project)).toBe(join(project, "a.zip"));
  expect(downloadTarget({ url: "https://example.com/a.zip", path: "vendor/b.zip" }, project)).toBe(join(project, "vendor", "b.zip"));
});

test("a download lands inside the project and reports its path, size and sha256", async () => {
  const out = await download({ url: "https://example.com/data/notes.txt", path: "data/notes.txt" }, place(), { resolve: DNS, fetch: server() });
  expect(out).toEqual({ path: join(project, "data", "notes.txt"), size: BODY.length, sha256: sha(BODY) });
  expect(await readFile(out.path, "utf8")).toBe(BODY);
  expect((await readdir(join(project, "data"))).filter((n) => n.startsWith("."))).toEqual([]);
});

test("an existing file is never replaced unless overwrite was asked for", async () => {
  await writeFile(join(project, "a.txt"), "mine");
  await expect(download({ url: "https://example.com/a.txt" }, place(), { resolve: DNS, fetch: server() })).rejects.toThrow(/already exists/);
  expect(await readFile(join(project, "a.txt"), "utf8")).toBe("mine");
  expect(fetched).toEqual([]);
  await download({ url: "https://example.com/a.txt", overwrite: true }, place(), { resolve: DNS, fetch: server() });
  expect(await readFile(join(project, "a.txt"), "utf8")).toBe(BODY);
});

test("over the size cap nothing is kept: a declared length is refused up front, a streamed body when it passes the cap", async () => {
  expect(MAX_DOWNLOAD_BYTES).toBe(200 * 1024 * 1024);
  await expect(download({ url: "https://example.com/big.bin" }, place(), { resolve: DNS, fetch: server("x".repeat(64), { "content-length": "64" }), maxBytes: 32 })).rejects.toThrow(/bigger than/);
  const stream = new ReadableStream<Uint8Array>({
    pull(c) {
      c.enqueue(new Uint8Array(16));
    },
  });
  await expect(download({ url: "https://example.com/big.bin" }, place(), { resolve: DNS, fetch: server(stream), maxBytes: 32 })).rejects.toThrow(/bigger than/);
  expect(await readdir(project)).toEqual([]);
});

test("a path outside the project, into .git, or through a link that leaves the project is refused", async () => {
  await mkdir(join(project, ".git", "hooks"), { recursive: true });
  await symlink(root, join(project, "out"));
  for (const path of ["../escape.txt", "/etc/x", ".git/hooks/post-checkout", "out/x.txt", ".tropos/settings.json"]) {
    await expect(download({ url: "https://example.com/x", path }, place(), { resolve: DNS, fetch: server() })).rejects.toThrow(/inside this project|runs code later/);
  }
  expect(fetched).toEqual([]);
  expect(existsSync(join(root, "x.txt"))).toBe(false);
});

test("only https from a public host: http, credentials and private hosts are refused, and so is a redirect to one", async () => {
  for (const url of ["http://example.com/a", "https://u:p@example.com/a", "https://127.0.0.1/a", "https://169.254.169.254/latest/meta-data"]) {
    await expect(download({ url }, place(), { resolve: DNS, fetch: server() })).rejects.toThrow();
  }
  expect(fetched).toEqual([]);
  await expect(download({ url: "https://example.com/a" }, place(), { resolve: DNS, fetch: server("", { location: "https://10.0.0.1/a" }, 302) })).rejects.toThrow(/local network/);
  expect(fetched).toEqual(["https://example.com/a"]);
  expect(await readdir(project)).toEqual([]);
});

test("an HTTP error saves nothing", async () => {
  await expect(download({ url: "https://example.com/a" }, place(), { resolve: DNS, fetch: server("nope", {}, 404) })).rejects.toThrow(/404/);
  expect(await readdir(project)).toEqual([]);
});

test("a folder swapped for a link after the target was checked: no folder is created outside and nothing is fetched", async () => {
  const outside = join(root, "outside");
  await mkdir(outside);
  await mkdir(join(project, "vendor"));
  // The host lookup runs after the target was checked: a racing command acts then.
  const racing = async (host: string) => {
    await rename(join(project, "vendor"), join(project, "vendor.old"));
    await symlink(outside, join(project, "vendor"));
    return DNS(host);
  };
  await expect(download({ url: "https://example.com/a.zip", path: "vendor/lib/a.zip" }, place(), { resolve: racing, fetch: server() })).rejects.toThrow(/changed while it was being opened/);
  expect(await readdir(outside)).toEqual([]);
  expect(fetched).toEqual([]);
});

test("a folder swapped for a link while the file downloads: the file isn't put in place, here or outside", async () => {
  const outside = join(root, "outside");
  await mkdir(outside);
  await mkdir(join(project, "vendor"));
  const racing = (async (url: string) => {
    fetched.push(url);
    await rename(join(project, "vendor"), join(project, "vendor.old"));
    await symlink(outside, join(project, "vendor"));
    return new Response(BODY);
  }) as unknown as typeof fetch;
  await expect(download({ url: "https://example.com/a.zip", path: "vendor/a.zip" }, place(), { resolve: DNS, fetch: racing })).rejects.toThrow(/changed while it was being opened/);
  expect(await readdir(outside)).toEqual([]);
  expect(existsSync(join(project, "vendor.old", "a.zip"))).toBe(false);
});

test("the download waits for the chat's sandbox like the other file tools, and refuses while a command runs there", async () => {
  const ctx = makeToolContext({ root: project, exec: busyBackend("A background command is still running.") });
  const kit = { fetch: server(), resolve: DNS } as unknown as ExtendKit;
  await expect(performExtend("download", { action: "download", url: "https://example.com/a.zip" }, ctx, kit)).rejects.toThrow("A background command is still running.");
  expect(fetched).toEqual([]);
  const events: string[] = [];
  const ok = await performExtend("download", { action: "download", url: "https://example.com/a.zip" }, makeToolContext({ root: project, exec: recordingBackend(events) }), kit);
  expect(ok).toContain("Downloaded");
  expect(events).toEqual(["held", "released"]);
});
