// scripts/release/github.test.ts
import { describe, expect, test } from "bun:test";
import { ghClient, type Fetcher, type GhResult, type GhRunner } from "./github";

const ok = (stdout: string): GhResult => ({ exitCode: 0, stdout, stderr: "" });
const httpError = (status: number, message: string): GhResult => ({ exitCode: 1, stdout: `{"message":"${message}"}`, stderr: `gh: ${message} (HTTP ${status})\n` });
const notFound = httpError(404, "Not Found");

/** A fake `gh`: answers by the API path (or subcommand) and records every call with its environment. */
function fakeGh(answers: Record<string, GhResult>) {
  const calls: Array<{ args: string[]; token: string | undefined }> = [];
  const run: GhRunner = async (args, env) => {
    calls.push({ args, token: env.GH_TOKEN });
    const key = args[0] === "api" ? args[1]! : args.slice(0, 2).join(" ");
    const answer = answers[key];
    if (!answer) throw new Error(`unexpected gh call: ${args.join(" ")}`);
    return answer;
  };
  return { run, calls };
}

const release = (draft: boolean) => JSON.stringify({ draft, prerelease: false, assets: [{ name: "manifest.json" }] });
const TAG = "repos/o/r/releases/tags/v1.0.0";
const LIST = "repos/o/r/releases?per_page=100";
const LATEST = "repos/o/r/releases/latest";

describe("getRelease", () => {
  test("a published release", async () => {
    const { run } = fakeGh({ [TAG]: ok(release(false)) });
    expect(await ghClient("o/r", undefined, { run }).getRelease("v1.0.0")).toEqual({ tag: "v1.0.0", draft: false, prerelease: false, assets: ["manifest.json"] });
  });

  test("a 404 falls back to the list, which finds drafts", async () => {
    const { run } = fakeGh({ [TAG]: notFound, [LIST]: ok(JSON.stringify([{ tag_name: "v1.0.0", draft: true, prerelease: false, assets: [] }])) });
    expect(await ghClient("o/r", undefined, { run }).getRelease("v1.0.0")).toEqual({ tag: "v1.0.0", draft: true, prerelease: false, assets: [] });
  });

  test("absent only when the tag endpoint answers 404 and the list does not contain it", async () => {
    const { run } = fakeGh({ [TAG]: notFound, [LIST]: ok("[]") });
    expect(await ghClient("o/r", undefined, { run }).getRelease("v1.0.0")).toBeNull();
  });

  for (const [name, answer] of [
    ["rate limit", httpError(403, "API rate limit exceeded")],
    ["bad credentials", httpError(401, "Bad credentials")],
    ["server error", httpError(502, "Bad Gateway")],
    ["network failure", { exitCode: 1, stdout: "", stderr: "error connecting to api.github.com\n" }],
  ] as const) {
    test(`${name} on the tag endpoint throws instead of reporting "absent"`, async () => {
      const { run } = fakeGh({ [TAG]: answer });
      await expect(ghClient("o/r", undefined, { run }).getRelease("v1.0.0")).rejects.toThrow("reading release o/r@v1.0.0 failed");
    });
  }

  test("a failing list after a 404 throws", async () => {
    const { run } = fakeGh({ [TAG]: notFound, [LIST]: httpError(502, "Bad Gateway") });
    await expect(ghClient("o/r", undefined, { run }).getRelease("v1.0.0")).rejects.toThrow("listing releases of o/r failed");
  });
});

describe("latestReleaseTag", () => {
  test("names the tag", async () => {
    const { run } = fakeGh({ [LATEST]: ok("v1.2.3\n") });
    expect(await ghClient("o/r", undefined, { run }).latestReleaseTag()).toBe("v1.2.3");
  });

  test("null only on 404 (no release yet)", async () => {
    const { run } = fakeGh({ [LATEST]: notFound });
    expect(await ghClient("o/r", undefined, { run }).latestReleaseTag()).toBeNull();
  });

  test("any other failure throws", async () => {
    const { run } = fakeGh({ [LATEST]: httpError(403, "API rate limit exceeded") });
    await expect(ghClient("o/r", undefined, { run }).latestReleaseTag()).rejects.toThrow("HTTP 403");
  });
});

test("the token, when given, is the only credential passed to gh", async () => {
  const { run, calls } = fakeGh({ [LATEST]: ok("v1.0.0") });
  await ghClient("o/r", "channels-token", { run }).latestReleaseTag();
  expect(calls[0]!.token).toBe("channels-token");
});

test("createChannelsRelease explains that the repository needs an initial commit", async () => {
  const { run } = fakeGh({ "release create": httpError(422, "Repository is empty") });
  await expect(ghClient("o/r", undefined, { run }).createChannelsRelease()).rejects.toThrow("needs an initial commit");
});

describe("public downloads", () => {
  function fakeFetch(respond: (url: string) => Response) {
    const inits: RequestInit[] = [];
    const fetch: Fetcher = async (url, init) => {
      inits.push(init);
      return respond(url);
    };
    return { fetch, inits };
  }

  test("latestDownloadResolves asks past the edge cache (a unique query string on every request)", async () => {
    const urls: string[] = [];
    const fetch: Fetcher = async (url) => {
      urls.push(url);
      return new Response(null, { status: 302, headers: { location: "https://github.com/o/r/releases/download/v1.0.0/manifest.json" } });
    };
    const c = ghClient("o/r", undefined, { fetch });
    expect(await c.latestDownloadResolves("v1.0.0")).toBe(true);
    expect(await c.latestDownloadResolves("v1.0.0")).toBe(true);
    expect(urls.every((u) => u.startsWith("https://github.com/o/r/releases/latest/download/manifest.json?nocache="))).toBe(true);
    expect(new Set(urls).size).toBe(2);
  });

  test("latestDownloadResolves follows only the redirect's target, with a timeout", async () => {
    let location: string | null = "https://github.com/o/r/releases/download/v1.0.0/manifest.json";
    const { fetch, inits } = fakeFetch(() => (location ? new Response(null, { status: 302, headers: { location } }) : new Response("", { status: 404 })));
    const c = ghClient("o/r", undefined, { fetch });
    expect(await c.latestDownloadResolves("v1.0.0")).toBe(true);
    expect(await c.latestDownloadResolves("v0.9.0")).toBe(false);
    location = null;
    expect(await c.latestDownloadResolves("v1.0.0")).toBe(false);
    expect(inits.every((i) => i.signal instanceof AbortSignal && i.redirect === "manual")).toBe(true);
  });
});

describe("readAsset (through the API, never the cached public download route)", () => {
  const CH = "repos/o/r/releases/tags/channels";
  const rel = JSON.stringify({ draft: false, prerelease: true, assets: [{ id: 7, name: "latest" }, { id: 9, name: "stable" }] });
  test("downloads the asset by id: bytes, null when the release or the asset is absent", async () => {
    const { run, calls } = fakeGh({ [CH]: ok(rel), "-H": ok("1.0.0\n") });
    const c = ghClient("o/r", "t", { run, fetch: async () => { throw new Error("no public downloads"); } });
    expect(new TextDecoder().decode((await c.readAsset("channels", "latest"))!)).toBe("1.0.0\n");
    expect(calls.at(-1)!.args).toEqual(["api", "-H", "Accept: application/octet-stream", "repos/o/r/releases/assets/7"]);
    expect(await c.readAsset("channels", "gone")).toBeNull();
    const { run: none } = fakeGh({ [CH]: notFound });
    expect(await ghClient("o/r", "t", { run: none }).readAsset("channels", "latest")).toBeNull();
  });
  test("an outage reading the release or the asset throws (never 'absent')", async () => {
    const { run } = fakeGh({ [CH]: httpError(502, "Bad Gateway") });
    await expect(ghClient("o/r", "t", { run }).readAsset("channels", "latest")).rejects.toThrow("HTTP 502");
    const { run: run2 } = fakeGh({ [CH]: ok(rel), "-H": httpError(404, "Not Found") });
    await expect(ghClient("o/r", "t", { run: run2 }).readAsset("channels", "latest")).rejects.toThrow("downloading");
  });
});
