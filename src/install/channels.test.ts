// src/install/channels.test.ts
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { resolveChannel } from "./channels";
import { InstallError } from "./errors";
import { serializeManifest } from "./manifest";
import { sampleManifest } from "../../test/install/helpers/manifest-corpus";
import { makeTestKey, sshSign, type TestKey } from "../../test/install/helpers/keys";
import { startReleaseServer, type ReleaseServer } from "../../test/install/helpers/release-server";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";

let dir: string;
let key: TestKey;
let srv: ReleaseServer;
const sleeps: number[] = [];
const deps = (extra = {}) => ({ urls: srv.urls, trusted: key.trusted, sleep: async (ms: number) => void sleeps.push(ms), random: () => 0.5, allowLoopbackHttp: true, ...extra });

beforeAll(async () => {
  dir = await makeTmpDir();
  key = await makeTestKey(dir, "k");
});
afterAll(() => removeDir(dir));
beforeEach(() => {
  srv?.stop();
  srv = startReleaseServer();
  sleeps.length = 0;
});

describe("resolveChannel", () => {
  test("primary slot", async () => {
    srv.put("channels", "latest", "1.0.0\n");
    srv.put("channels", "latest.bak", "0.9.0\n");
    expect(await resolveChannel("latest", deps())).toEqual({ channel: "latest", version: "1.0.0", source: "primary" });
  });

  test("falls back to the .bak slot when the primary is missing (the --clobber window, R3.1)", async () => {
    srv.put("channels", "stable.bak", "1.1.0\n");
    expect(await resolveChannel("stable", deps())).toEqual({ channel: "stable", version: "1.1.0", source: "backup" });
    expect(sleeps).toEqual([1000, 2000, 4000]);
  });

  test("latest falls back to GitHub's latest release when both slots fail", async () => {
    const bytes = serializeManifest(sampleManifest("1.3.0"));
    srv.put("v1.3.0", "manifest.json", bytes);
    srv.put("v1.3.0", "manifest.json.sig", await sshSign(key, bytes, "tropos-manifest", dir));
    srv.setLatest("v1.3.0");
    expect(await resolveChannel("latest", deps())).toEqual({ channel: "latest", version: "1.3.0", source: "github-latest" });
  });

  test("stable has no third fallback", async () => {
    const bytes = serializeManifest(sampleManifest("9.9.9"));
    srv.put("v9.9.9", "manifest.json", bytes);
    srv.put("v9.9.9", "manifest.json.sig", await sshSign(key, bytes, "tropos-manifest", dir));
    srv.setLatest("v9.9.9");
    const e = (await resolveChannel("stable", deps()).catch((x) => x)) as InstallError;
    expect(srv.requests.some((r) => r.includes("/releases/latest/download/"))).toBe(false);
    expect(e.kind).toBe("network");
    expect(e.message).toStartWith("cannot resolve the stable channel");
    expect(e.message).toEndWith("; try again, or install an explicit version");
  });

  test("gives up within the backoff budget when every request fails (Review Focus 5)", async () => {
    const e = (await resolveChannel("latest", deps({ fetch: async () => { throw new Error("offline"); }, random: () => 0.999999 })).catch((x) => x)) as InstallError;
    expect(e.kind).toBe("network");
    expect(sleeps.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(26_000);
  });

  test("an untrusted manifest on the GitHub-latest fallback is an integrity error, not a silent success", async () => {
    const other = await makeTestKey(dir, "other");
    const bytes = serializeManifest(sampleManifest("1.4.0"));
    srv.put("v1.4.0", "manifest.json", bytes);
    srv.put("v1.4.0", "manifest.json.sig", await sshSign(other, bytes, "tropos-manifest", dir));
    srv.setLatest("v1.4.0");
    expect(((await resolveChannel("latest", deps()).catch((x) => x)) as InstallError).kind).toBe("integrity");
  });
});
