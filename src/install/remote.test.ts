// src/install/remote.test.ts
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { serializeManifest } from "./manifest";
import { InstallError } from "./errors";
import { backoffDelays, fetchLatestReleaseManifest, fetchPointer, fetchVersionManifest, withRetries } from "./remote";
import { sampleManifest } from "../../test/install/helpers/manifest-corpus";
import { makeTestKey, sshSign, type TestKey } from "../../test/install/helpers/keys";
import { startReleaseServer, type ReleaseServer } from "../../test/install/helpers/release-server";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";

let dir: string;
let key: TestKey;
let srv: ReleaseServer;
const sleeps: number[] = [];
const deps = () => ({ urls: srv.urls, trusted: key.trusted, sleep: async (ms: number) => void sleeps.push(ms), random: () => 0.5, allowLoopbackHttp: true });

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

async function publish(version: string) {
  const bytes = serializeManifest(sampleManifest(version));
  srv.put(`v${version}`, "manifest.json", bytes);
  srv.put(`v${version}`, "manifest.json.sig", await sshSign(key, bytes, "tropos-manifest", dir));
}

describe("backoff and retries", () => {
  test("1 s, 2 s, 4 s with ±20 % jitter", () => {
    expect(backoffDelays(() => 0.5)).toEqual([1000, 2000, 4000]);
    expect(backoffDelays(() => 0)).toEqual([800, 1600, 3200]);
    expect(backoffDelays(() => 0.999999)).toEqual([1200, 2400, 4800]);
  });

  test("retries network errors only, 3 attempts, sleeping 1 s then 2 s", async () => {
    let calls = 0;
    const err = await withRetries(async () => {
      calls++;
      throw new InstallError("network", "down");
    }, deps()).catch((e) => e);
    expect(calls).toBe(3);
    expect(sleeps).toEqual([1000, 2000]);
    expect((err as InstallError).message).toBe("down");
  });

  test("does not retry integrity errors", async () => {
    let calls = 0;
    await withRetries(async () => {
      calls++;
      throw new InstallError("integrity", "bad");
    }, deps()).catch(() => {});
    expect(calls).toBe(1);
  });
});

describe("fetchPointer", () => {
  test("reads a version with or without the final newline", async () => {
    srv.put("channels", "latest", "1.2.3\n");
    srv.put("channels", "stable", "1.2.0");
    expect(await fetchPointer(srv.urls.channel("latest"), deps())).toBe("1.2.3");
    expect(await fetchPointer(srv.urls.channel("stable"), deps())).toBe("1.2.0");
  });

  test.each([["html", "<html>Not Found</html>"], ["two lines", "1.2.3\n1.2.4\n"], ["spaces", " 1.2.3\n"], ["prerelease", "1.2.3-rc\n"]])(
    "%s counts as a failed attempt and is retried",
    async (_n, body) => {
      srv.put("channels", "latest", body);
      const e = await fetchPointer(srv.urls.channel("latest"), deps()).catch((x) => x);
      expect((e as InstallError).kind).toBe("network");
      expect(srv.requests.filter((r) => r.endsWith("/channels/latest")).length).toBe(3);
    },
  );

  test("recovers when a 500 is followed by success", async () => {
    srv.put("channels", "latest", "1.2.3\n");
    srv.failNext("channels", "latest", 500, 2);
    expect(await fetchPointer(srv.urls.channel("latest"), deps())).toBe("1.2.3");
  });
});

describe("manifests", () => {
  test("fetchVersionManifest verifies signature and version", async () => {
    await publish("1.2.3");
    expect((await fetchVersionManifest("1.2.3", deps())).manifest.version).toBe("1.2.3");
  });

  test("a manifest served under another version's tag is rejected", async () => {
    await publish("1.2.3");
    srv.put("v1.2.4", "manifest.json", serializeManifest(sampleManifest("1.2.3")));
    srv.put("v1.2.4", "manifest.json.sig", await sshSign(key, serializeManifest(sampleManifest("1.2.3")), "tropos-manifest", dir));
    await expect(fetchVersionManifest("1.2.4", deps())).rejects.toThrow("manifest is for version 1.2.3, expected 1.2.4");
  });

  test("fetchLatestReleaseManifest follows GitHub's latest redirect", async () => {
    await publish("2.0.0");
    srv.setLatest("v2.0.0");
    expect((await fetchLatestReleaseManifest(deps())).manifest.version).toBe("2.0.0");
  });
});
