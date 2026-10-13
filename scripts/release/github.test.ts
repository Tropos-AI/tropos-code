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

  test("readAsset: bytes, null on 404, throws otherwise; every request has a timeout", async () => {
    const { fetch, inits } = fakeFetch((url) => (url.endsWith("/latest") ? new Response("1.0.0\n") : url.endsWith("/gone") ? new Response("", { status: 404 }) : new Response("", { status: 503 })));
    const c = ghClient("o/r", undefined, { fetch });
    expect(new TextDecoder().decode((await c.readAsset("channels", "latest"))!)).toBe("1.0.0\n");
    expect(await c.readAsset("channels", "gone")).toBeNull();
    await expect(c.readAsset("channels", "other")).rejects.toThrow("HTTP 503");
    expect(inits.every((i) => i.signal instanceof AbortSignal)).toBe(true);
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
