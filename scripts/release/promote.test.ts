// scripts/release/promote.test.ts
import { beforeEach, describe, expect, test } from "bun:test";
import { checkChannels, previousRelease, promoteLatest, promoteStable, recordsOnChannelsRelease, recordsOnVersionRelease, type GitHubClient, type PromoteDeps, type ReleaseInfo } from "./promote";

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array | null) => (b ? new TextDecoder().decode(b) : null);

/** In-memory GitHub with --clobber semantics (delete, then upload) and fault injection. */
class FakeGitHub implements GitHubClient {
  releases = new Map<string, { draft: boolean; prerelease: boolean; assets: Map<string, Uint8Array> }>();
  /** The release explicitly marked latest. */
  latest: string | null = null;
  /** Where the public `releases/latest/download/…` route redirects; only `markLatest` sets it (spike D6a). */
  downloadLatest: string | null = null;
  /** Release immutability: uploads to a published release fail. */
  immutable = false;
  failUpload: (tag: string, name: string) => boolean = () => false;
  failMarkLatest = false;
  observe: () => void = () => {};
  /** Awaited at the start of every call; R7.2 makes it random to vary the interleaving. */
  delay: () => Promise<void> = async () => {};
  async getRelease(tag: string): Promise<ReleaseInfo | null> {
    await this.delay();
    const r = this.releases.get(tag);
    return r ? { tag, draft: r.draft, prerelease: r.prerelease, assets: [...r.assets.keys()] } : null;
  }
  async createChannelsRelease() {
    this.releases.set("channels", { draft: false, prerelease: true, assets: new Map() });
  }
  async readAsset(tag: string, name: string) {
    await this.delay();
    return this.releases.get(tag)?.assets.get(name) ?? null;
  }
  async uploadAsset(tag: string, name: string, data: Uint8Array) {
    await this.delay();
    const r = this.releases.get(tag)!;
    if (this.immutable && !r.draft) throw new Error(`${tag} is immutable`);
    r.assets.delete(name);
    this.observe();
    if (this.failUpload(tag, name)) throw new Error(`upload of ${name} failed`);
    r.assets.set(name, data);
    this.observe();
  }
  /** Like the API: with nothing marked, the newest published non-prerelease counts as latest (spike D6a). */
  async latestReleaseTag() {
    await this.delay();
    if (this.latest !== null) return this.latest;
    const published = [...this.releases].filter(([, r]) => !r.draft && !r.prerelease);
    return published.at(-1)?.[0] ?? null;
  }
  async latestDownloadResolves(tag: string) {
    await this.delay();
    return this.downloadLatest === tag;
  }
  async markLatest(tag: string) {
    await this.delay();
    if (this.failMarkLatest) throw new Error("mark latest failed");
    this.latest = tag;
    this.downloadLatest = tag;
    this.observe();
  }
  publish(version: string, opts: { goodSignature?: boolean } = {}) {
    const assets = new Map<string, Uint8Array>([
      ["manifest.json", enc(JSON.stringify({ version, commit: "c".repeat(40) }))],
      ["manifest.json.sig", enc(opts.goodSignature === false ? "bad" : `sig:${version}`)],
    ]);
    this.releases.set(`v${version}`, { draft: false, prerelease: false, assets });
  }
  slot(name: string) {
    return dec(this.releases.get("channels")?.assets.get(name) ?? null)?.trim() ?? null;
  }
}

let gh: FakeGitHub;
let deps: PromoteDeps;
beforeEach(() => {
  gh = new FakeGitHub();
  deps = {
    main: gh,
    channels: gh,
    records: recordsOnVersionRelease(gh),
    verifyManifest: async (bytes, sig) => {
      const m = JSON.parse(new TextDecoder().decode(bytes)) as { version: string; commit: string };
      return sig === `sig:${m.version}` ? m : null;
    },
    sleep: async () => {},
    now: () => new Date("2026-10-13T12:00:00Z"),
    runId: "42",
    log: () => {},
  };
});

const endState = () => ({ latest: gh.slot("latest"), latestBak: gh.slot("latest.bak"), stable: gh.slot("stable"), stableBak: gh.slot("stable.bak"), gh: gh.latest });

describe("first release (R7.1)", () => {
  test("creates the channels release and every slot, then marks GitHub latest", async () => {
    gh.publish("1.0.0");
    await promoteLatest(deps, "1.0.0");
    expect(gh.releases.get("channels")).toMatchObject({ draft: false, prerelease: true });
    expect(endState()).toEqual({ latest: "1.0.0", latestBak: "1.0.0", stable: "1.0.0", stableBak: "1.0.0", gh: "v1.0.0" });
    expect(JSON.parse(dec(await gh.readAsset("v1.0.0", "verified.json"))!)).toEqual({ version: "1.0.0", commit: "c".repeat(40), runId: "42", verifiedAt: "2026-10-13T12:00:00.000Z" });
    gh.publish("1.1.0");
    expect(await previousRelease(deps, "1.1.0")).toEqual({ installerTag: "v1.0.0", stable: "1.0.0" });
  });

  test("the API already naming the first release as latest is not enough: it is marked so the public route resolves (D6a)", async () => {
    gh.publish("1.0.0");
    expect(await gh.latestReleaseTag()).toBe("v1.0.0");
    expect(await gh.latestDownloadResolves("v1.0.0")).toBe(false);
    await promoteLatest(deps, "1.0.0");
    expect(await gh.latestDownloadResolves("v1.0.0")).toBe(true);
  });

  test("before any promotion there is no previous release (smoke b/c are skipped)", async () => {
    expect(await previousRelease(deps, "1.0.0")).toEqual({ installerTag: null, stable: null });
  });

  test("the first release, published but not promoted, is not its own old installer (R3)", async () => {
    gh.publish("1.0.0");
    expect(await previousRelease(deps, "1.0.0")).toEqual({ installerTag: null, stable: null });
  });
});

describe("resuming an interrupted promotion (R2.1)", () => {
  const faults: Array<[string, () => void, () => void]> = [
    ["upload of latest.bak", () => (gh.failUpload = (_t, n) => n === "latest.bak"), () => (gh.failUpload = () => false)],
    ["upload of latest", () => (gh.failUpload = (_t, n) => n === "latest"), () => (gh.failUpload = () => false)],
    ["upload of stable (first release)", () => (gh.failUpload = (_t, n) => n === "stable"), () => (gh.failUpload = () => false)],
    ["mark latest (latest == x, GitHub latest unset)", () => (gh.failMarkLatest = true), () => (gh.failMarkLatest = false)],
  ];
  for (const [name, inject, clear] of faults) {
    test(name, async () => {
      gh.publish("1.0.0");
      inject();
      await expect(promoteLatest(deps, "1.0.0")).rejects.toThrow();
      clear();
      await promoteLatest(deps, "1.0.0");
      expect(endState()).toEqual({ latest: "1.0.0", latestBak: "1.0.0", stable: "1.0.0", stableBak: "1.0.0", gh: "v1.0.0" });
    });
  }

  test("a second run after success changes nothing", async () => {
    gh.publish("1.0.0");
    await promoteLatest(deps, "1.0.0");
    let uploads = 0;
    gh.observe = () => void uploads++;
    await promoteLatest(deps, "1.0.0");
    expect(uploads).toBe(0);
  });
});

describe("safety rules", () => {
  test("latest never moves backwards", async () => {
    gh.publish("1.0.0");
    gh.publish("2.0.0");
    await promoteLatest(deps, "2.0.0");
    await expect(promoteLatest(deps, "1.0.0")).rejects.toThrow("would move latest backwards");
  });

  test("a slot changed by someone else is never overwritten (R2.2)", async () => {
    gh.publish("1.0.0");
    gh.publish("1.1.0");
    await promoteLatest(deps, "1.0.0");
    let reads = 0;
    deps.channels = {
      getRelease: (tag) => gh.getRelease(tag),
      createChannelsRelease: () => gh.createChannelsRelease(),
      uploadAsset: (tag, name, data) => gh.uploadAsset(tag, name, data),
      latestReleaseTag: () => gh.latestReleaseTag(),
      latestDownloadResolves: (tag) => gh.latestDownloadResolves(tag),
      markLatest: (tag) => gh.markLatest(tag),
      // Someone else rewrites latest.bak between our first read and our write.
      readAsset: async (tag, name) => {
        if (name === "latest.bak" && ++reads === 2) gh.releases.get("channels")!.assets.set("latest.bak", enc("9.9.9\n"));
        return gh.readAsset(tag, name);
      },
    };
    await expect(promoteLatest(deps, "1.1.0")).rejects.toThrow("changed from 1.0.0 to 9.9.9 while promoting");
  });

  test("a release with a bad signature is refused", async () => {
    gh.publish("1.0.0", { goodSignature: false });
    await expect(promoteLatest(deps, "1.0.0")).rejects.toThrow("manifest signature");
  });

  test("a draft is refused", async () => {
    gh.publish("1.0.0");
    gh.releases.get("v1.0.0")!.draft = true;
    await expect(promoteLatest(deps, "1.0.0")).rejects.toThrow("is not published");
  });
});

describe("stable (spec §7.4, R3.1–R3.2)", () => {
  beforeEach(async () => {
    gh.publish("1.0.0");
    gh.publish("1.1.0");
    gh.publish("1.2.0");
    await promoteLatest(deps, "1.0.0");
    await promoteLatest(deps, "1.2.0");
  });

  test("moves to a verified version not ahead of latest", async () => {
    await promoteLatest(deps, "1.2.0");
    await expect(promoteStable(deps, "1.1.0")).rejects.toThrow("has no verification record");
    await promoteStable(deps, "1.2.0");
    expect([gh.slot("stable"), gh.slot("stable.bak")]).toEqual(["1.2.0", "1.2.0"]);
  });

  test("never ahead of latest, never backwards", async () => {
    gh.publish("3.0.0");
    await recordsOnVersionRelease(gh).write("3.0.0", { version: "3.0.0", commit: "c".repeat(40), runId: "1", verifiedAt: "x" });
    await expect(promoteStable(deps, "3.0.0")).rejects.toThrow("cannot run ahead of latest");
    await promoteStable(deps, "1.2.0");
    await expect(promoteStable(deps, "1.0.0")).rejects.toThrow("would move stable backwards");
  });

  test("a failed upload of stable leaves stable.bak verified; repair restores stable (R3.1)", async () => {
    gh.failUpload = (_t, n) => n === "stable";
    await expect(promoteStable(deps, "1.2.0")).rejects.toThrow();
    gh.failUpload = () => false;
    expect([gh.slot("stable"), gh.slot("stable.bak")]).toEqual([null, "1.2.0"]);
    const report = await checkChannels(deps, true);
    expect(report.repaired).toContain("stable := 1.2.0");
    expect([gh.slot("stable"), gh.slot("stable.bak")]).toEqual(["1.2.0", "1.2.0"]);
  });

  test("a failed upload of stable.bak leaves stable untouched and verified (R3.2)", async () => {
    gh.failUpload = (_t, n) => n === "stable.bak";
    await expect(promoteStable(deps, "1.2.0")).rejects.toThrow();
    gh.failUpload = () => false;
    expect(gh.slot("stable")).toBe("1.0.0");
    await promoteStable(deps, "1.2.0");
    expect([gh.slot("stable"), gh.slot("stable.bak")]).toEqual(["1.2.0", "1.2.0"]);
  });
});

describe("checkChannels (R3.3)", () => {
  test("healthy", async () => {
    gh.publish("1.0.0");
    await promoteLatest(deps, "1.0.0");
    expect(await checkChannels(deps, false)).toEqual({ ok: true, problems: [], repaired: [] });
  });

  test("an invalid slot and an unverified target are repaired to the higher verified value", async () => {
    gh.publish("1.0.0");
    gh.publish("1.1.0");
    await promoteLatest(deps, "1.0.0");
    gh.releases.get("channels")!.assets.set("latest", enc("<html>"));
    gh.releases.get("channels")!.assets.set("stable.bak", enc("1.1.0\n")); // 1.1.0 has no verification record
    const report = await checkChannels(deps, true);
    expect(report.ok).toBe(false);
    expect(endState()).toMatchObject({ latest: "1.0.0", latestBak: "1.0.0", stable: "1.0.0", stableBak: "1.0.0" });
  });

  test("both slots invalid: nothing is changed and the check fails", async () => {
    gh.publish("1.0.0");
    await promoteLatest(deps, "1.0.0");
    gh.releases.get("channels")!.assets.set("stable", enc("x"));
    gh.releases.get("channels")!.assets.delete("stable.bak");
    const report = await checkChannels(deps, true);
    expect(report.problems).toContain("stable: neither slot names a verified release; not repaired");
    expect(gh.slot("stable")).toBe("x");
  });

  test("GitHub latest counts only when the public latest/download route resolves too (D6a)", async () => {
    gh.publish("1.0.0");
    await promoteLatest(deps, "1.0.0");
    gh.downloadLatest = null; // the API still names v1.0.0
    const check = await checkChannels(deps, false);
    expect(check.ok).toBe(false);
    expect(check.problems).toEqual(["GitHub's public releases/latest/download route does not resolve to v1.0.0 (channels/latest is 1.0.0)"]);
    const repair = await checkChannels(deps, true);
    expect(repair.repaired).toEqual(["GitHub latest := v1.0.0"]);
    expect(await checkChannels(deps, false)).toEqual({ ok: true, problems: [], repaired: [] });
  });
});

describe("records on the channels repository (D1-B, production layout)", () => {
  let main: FakeGitHub;
  let channels: FakeGitHub;
  beforeEach(() => {
    main = new FakeGitHub();
    channels = new FakeGitHub();
    main.immutable = true; // tropos-code releases are immutable once published
    deps = { ...deps, main, channels, records: recordsOnChannelsRelease(channels) };
  });
  const state = () => ({ latest: channels.slot("latest"), latestBak: channels.slot("latest.bak"), stable: channels.slot("stable"), stableBak: channels.slot("stable.bak"), gh: main.latest });

  test("the first release writes verified-<x>.json on channels and never uploads to the version release", async () => {
    main.publish("1.0.0");
    await promoteLatest(deps, "1.0.0");
    expect(main.releases.has("channels")).toBe(false);
    expect(channels.releases.get("channels")).toMatchObject({ draft: false, prerelease: true });
    expect(main.releases.get("v1.0.0")!.assets.has("verified.json")).toBe(false);
    expect(JSON.parse(dec(await channels.readAsset("channels", "verified-1.0.0.json"))!)).toEqual({ version: "1.0.0", commit: "c".repeat(40), runId: "42", verifiedAt: "2026-10-13T12:00:00.000Z" });
    expect(state()).toEqual({ latest: "1.0.0", latestBak: "1.0.0", stable: "1.0.0", stableBak: "1.0.0", gh: "v1.0.0" });
    expect(channels.latest).toBeNull();
    expect(await checkChannels(deps, false)).toEqual({ ok: true, problems: [], repaired: [] });
  });

  test("a failed record upload is resumed by running again", async () => {
    main.publish("1.0.0");
    channels.failUpload = (_t, n) => n === "verified-1.0.0.json";
    await expect(promoteLatest(deps, "1.0.0")).rejects.toThrow("upload of verified-1.0.0.json failed");
    expect(channels.slot("latest")).toBeNull();
    channels.failUpload = () => false;
    await promoteLatest(deps, "1.0.0");
    expect(state()).toEqual({ latest: "1.0.0", latestBak: "1.0.0", stable: "1.0.0", stableBak: "1.0.0", gh: "v1.0.0" });
  });

  test("stable requires the record on channels; check refuses slots without one", async () => {
    for (const v of ["1.0.0", "1.1.0", "1.2.0"]) main.publish(v);
    await promoteLatest(deps, "1.0.0");
    await promoteLatest(deps, "1.2.0");
    await expect(promoteStable(deps, "1.1.0")).rejects.toThrow("has no verification record");
    await promoteStable(deps, "1.2.0");
    expect([channels.slot("stable"), channels.slot("stable.bak")]).toEqual(["1.2.0", "1.2.0"]);
    channels.releases.get("channels")!.assets.delete("verified-1.2.0.json");
    const report = await checkChannels(deps, true);
    expect(report.problems).toContain("latest: neither slot names a verified release; not repaired");
    expect(report.problems).toContain("stable: neither slot names a verified release; not repaired");
    expect(state()).toMatchObject({ latest: "1.2.0", stable: "1.2.0", gh: "v1.2.0" });
  });

  test("previousRelease reads GitHub latest from tropos-code and stable from channels", async () => {
    main.publish("1.0.0");
    await promoteLatest(deps, "1.0.0");
    main.publish("1.1.0");
    expect(await previousRelease(deps, "1.1.0")).toEqual({ installerTag: "v1.0.0", stable: "1.0.0" });
  });
});

describe("interleaved promotions (R7.2)", () => {
  for (let seed = 1; seed <= 25; seed++) {
    test(`seed ${seed}`, async () => {
      for (const v of ["1.0.0", "1.1.0", "2.0.0"]) gh.publish(v);
      await promoteLatest(deps, "1.0.0");
      await promoteLatest(deps, "1.1.0");
      let s = seed;
      const rand = () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
      gh.delay = () => new Promise((r) => setTimeout(r, Math.floor(rand() * 3)));
      const verified = new Set(["1.0.0", "1.1.0", "2.0.0"]);
      let lastLatest = "1.1.0";
      gh.observe = () => {
        for (const slot of ["latest", "latest.bak", "stable", "stable.bak"]) {
          const v = gh.slot(slot);
          if (v !== null) expect(verified.has(v)).toBe(true);
        }
        const l = gh.slot("latest");
        if (l) {
          expect(Bun.semver.order(l, lastLatest)).toBeGreaterThanOrEqual(0);
          lastLatest = l;
        }
      };
      await Promise.allSettled([promoteLatest(deps, "2.0.0"), promoteStable(deps, "1.1.0")]);
      const latest = gh.slot("latest") ?? gh.slot("latest.bak");
      const stable = gh.slot("stable") ?? gh.slot("stable.bak");
      expect(Bun.semver.order(stable!, latest!)).toBeLessThanOrEqual(0);
    });
  }
});
