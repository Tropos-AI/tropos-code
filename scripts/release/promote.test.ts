// scripts/release/promote.test.ts
import { beforeEach, describe, expect, test } from "bun:test";
import { checkChannels, previousRelease, promoteLatest, promoteStable, recordsOnChannelsRelease, type GitHubClient, type PromoteDeps, type ReleaseInfo, type VerificationRecords } from "./promote";

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array | null) => (b ? new TextDecoder().decode(b) : null);

/** For these tests only: `verified.json` on the version release (tropos-code releases are immutable, so production keeps the records on the channels release). */
function recordsOnVersionRelease(main: GitHubClient): VerificationRecords {
  return {
    read: async (v) => {
      const text = dec(await main.readAsset(`v${v}`, "verified.json"));
      return text === null ? null : JSON.parse(text);
    },
    write: (v, r) => main.uploadAsset(`v${v}`, "verified.json", enc(`${JSON.stringify(r)}\n`)),
  };
}

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
  /** Awaited at the start of every call; the interleaving tests make it random to vary the order. */
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

describe("first release", () => {
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

  test("the first release, published but not promoted, is not its own old installer", async () => {
    gh.publish("1.0.0");
    expect(await previousRelease(deps, "1.0.0")).toEqual({ installerTag: null, stable: null });
  });
});

describe("resuming an interrupted promotion", () => {
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

  test("a slot changed by someone else is never overwritten", async () => {
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

describe("stable", () => {
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

  test("a failed upload of stable leaves stable.bak verified; repair restores stable", async () => {
    gh.failUpload = (_t, n) => n === "stable";
    await expect(promoteStable(deps, "1.2.0")).rejects.toThrow();
    gh.failUpload = () => false;
    expect([gh.slot("stable"), gh.slot("stable.bak")]).toEqual([null, "1.2.0"]);
    const report = await checkChannels(deps, true);
    expect(report.repaired).toContain("stable := 1.2.0");
    expect([gh.slot("stable"), gh.slot("stable.bak")]).toEqual(["1.2.0", "1.2.0"]);
  });

  test("a failed upload of stable.bak leaves stable untouched and verified", async () => {
    gh.failUpload = (_t, n) => n === "stable.bak";
    await expect(promoteStable(deps, "1.2.0")).rejects.toThrow();
    gh.failUpload = () => false;
    expect(gh.slot("stable")).toBe("1.0.0");
    await promoteStable(deps, "1.2.0");
    expect([gh.slot("stable"), gh.slot("stable.bak")]).toEqual(["1.2.0", "1.2.0"]);
  });
});

describe("checkChannels", () => {
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

  test("a transport error while judging a slot fails the check and repairs nothing (never lowers a verified slot)", async () => {
    gh.publish("1.9.0");
    gh.publish("2.0.0");
    await promoteLatest(deps, "1.9.0");
    gh.failUpload = (_t, n) => n === "latest";
    await expect(promoteLatest(deps, "2.0.0")).rejects.toThrow();
    gh.failUpload = () => false;
    expect([gh.slot("latest"), gh.slot("latest.bak")]).toEqual([null, "2.0.0"]);
    await gh.uploadAsset("channels", "latest", enc("1.9.0\n")); // latest = 1.9.0, latest.bak = 2.0.0
    const readAsset = gh.readAsset.bind(gh);
    gh.readAsset = async (tag, name) => {
      if (tag === "v2.0.0") throw new Error("reading v2.0.0/manifest.json: HTTP 502");
      return readAsset(tag, name);
    };
    let writes = 0;
    gh.observe = () => void writes++;
    await expect(checkChannels(deps, true)).rejects.toThrow("HTTP 502");
    expect(writes).toBe(0);
    expect([gh.slot("latest"), gh.slot("latest.bak")]).toEqual(["1.9.0", "2.0.0"]);
  });

  test("both slots valid and verified but different: both are set to the higher", async () => {
    gh.publish("1.0.0");
    gh.publish("1.1.0");
    await promoteLatest(deps, "1.0.0");
    gh.failUpload = (_t, n) => n === "latest";
    await expect(promoteLatest(deps, "1.1.0")).rejects.toThrow();
    gh.failUpload = () => false;
    await gh.uploadAsset("channels", "latest", enc("1.0.0\n")); // the interrupted --clobber left the old value
    expect((await checkChannels(deps, false)).problems).toContain("latest: slots differ (1.0.0 vs 1.1.0)");
    const report = await checkChannels(deps, true);
    expect(report.repaired).toEqual(["latest := 1.1.0", "GitHub latest := v1.1.0"]);
    expect(endState()).toEqual({ latest: "1.1.0", latestBak: "1.1.0", stable: "1.0.0", stableBak: "1.0.0", gh: "v1.1.0" });
    expect(await checkChannels(deps, false)).toEqual({ ok: true, problems: [], repaired: [] });
  });

  test("a repair write re-reads the slot first and never overwrites someone else's change", async () => {
    gh.publish("1.0.0");
    await promoteLatest(deps, "1.0.0");
    gh.releases.get("channels")!.assets.delete("stable");
    let reads = 0;
    deps.channels = {
      getRelease: (tag) => gh.getRelease(tag),
      createChannelsRelease: () => gh.createChannelsRelease(),
      uploadAsset: (tag, name, data) => gh.uploadAsset(tag, name, data),
      latestReleaseTag: () => gh.latestReleaseTag(),
      latestDownloadResolves: (tag) => gh.latestDownloadResolves(tag),
      markLatest: (tag) => gh.markLatest(tag),
      // A promotion writes stable between the check's read and its repair.
      readAsset: async (tag, name) => {
        if (name === "stable" && ++reads === 2) gh.releases.get("channels")!.assets.set("stable", enc("1.1.0\n"));
        return gh.readAsset(tag, name);
      },
    };
    await expect(checkChannels(deps, true)).rejects.toThrow("channels/stable changed from null to 1.1.0");
    expect(gh.slot("stable")).toBe("1.1.0");
  });

  test("GitHub latest ahead of channels/latest is reported distinctly and set back to channels/latest", async () => {
    gh.publish("1.0.0");
    gh.publish("2.0.0");
    await promoteLatest(deps, "1.0.0");
    await gh.markLatest("v2.0.0");
    expect((await checkChannels(deps, false)).problems).toEqual(["GitHub latest v2.0.0 is ahead of channels/latest 1.0.0 — was it marked manually?"]);
    expect((await checkChannels(deps, true)).repaired).toEqual(["GitHub latest := v1.0.0"]);
    expect(gh.latest).toBe("v1.0.0");
  });
});

describe("invalid slot content (missing is not invalid)", () => {
  beforeEach(async () => {
    gh.publish("1.0.0");
    gh.publish("1.1.0");
    await promoteLatest(deps, "1.0.0");
  });

  test("corrupt stable slots stop promoteLatest before anything is written; stable is never invented", async () => {
    gh.releases.get("channels")!.assets.set("stable", enc("<html>"));
    gh.releases.get("channels")!.assets.set("stable.bak", enc("<html>"));
    await expect(promoteLatest(deps, "1.1.0")).rejects.toThrow('channels/stable holds invalid content "<html>"');
    expect(endState()).toEqual({ latest: "1.0.0", latestBak: "1.0.0", stable: "<html>", stableBak: "<html>", gh: "v1.0.0" });
    const report = await checkChannels(deps, true);
    expect(report.problems).toEqual(['stable: invalid content "<html>"', 'stable.bak: invalid content "<html>"', "stable: neither slot names a verified release; not repaired"]);
    expect([gh.slot("stable"), gh.slot("stable.bak")]).toEqual(["<html>", "<html>"]);
  });

  test("a corrupt stable.bak stops promoteStable", async () => {
    gh.releases.get("channels")!.assets.set("stable.bak", enc("1.0\n"));
    await expect(promoteStable(deps, "1.0.0")).rejects.toThrow('channels/stable.bak holds invalid content "1.0"');
    expect(gh.slot("stable.bak")).toBe("1.0");
  });

  test("a corrupt latest stops promoteLatest; check --repair restores it from latest.bak", async () => {
    gh.releases.get("channels")!.assets.set("latest", enc("garbage"));
    await expect(promoteLatest(deps, "1.1.0")).rejects.toThrow('channels/latest holds invalid content "garbage"');
    expect((await checkChannels(deps, true)).repaired).toEqual(["latest := 1.0.0"]);
    await promoteLatest(deps, "1.1.0");
    expect(endState()).toMatchObject({ latest: "1.1.0", latestBak: "1.1.0", gh: "v1.1.0" });
  });
});

describe("errors from GitHub propagate (a gate never fails open)", () => {
  test("previousRelease rejects when GitHub cannot be asked", async () => {
    gh.publish("1.0.0");
    await promoteLatest(deps, "1.0.0");
    const read = gh.readAsset.bind(gh);
    gh.readAsset = async (tag, name) => {
      if (tag === "channels") throw new Error("reading release channels failed (exit 1): gh: API rate limit exceeded (HTTP 403)");
      return read(tag, name);
    };
    await expect(previousRelease(deps, "1.1.0")).rejects.toThrow("HTTP 403");
  });

  test("previousRelease names the promoted installer even when the API already calls the new release latest (dry run 2026-10-14)", async () => {
    gh.publish("1.0.0");
    await promoteLatest(deps, "1.0.0");
    gh.publish("1.1.0");
    gh.latestReleaseTag = async () => "v1.1.0";
    expect(await previousRelease(deps, "1.1.0")).toEqual({ installerTag: "v1.0.0", stable: "1.0.0" });
    expect(await previousRelease(deps, "1.0.0")).toEqual({ installerTag: null, stable: "1.0.0" }); // a resumed run of the promoted release
  });
});

describe("CLI", () => {
  const cli = (...args: string[]) =>
    Bun.spawnSync([process.execPath, "scripts/release/promote.ts", ...args], {
      cwd: `${import.meta.dir}/../..`,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, GITHUB_REPOSITORY: "Tropos-AI/tropos-code" },
    });

  for (const args of [["latest", "1.0.0"], ["stable", "1.0.0"], ["check", "--repair"]]) {
    test(`${args.join(" ")} fails fast without CHANNELS_WRITE_TOKEN`, () => {
      const r = cli(...args);
      expect(r.exitCode).toBe(1);
      expect(r.stderr.toString()).toContain("CHANNELS_WRITE_TOKEN is not set");
    });
  }

  test("a malformed command is a usage error", () => {
    const r = cli("previous");
    expect(r.exitCode).toBe(64);
    expect(r.stderr.toString()).toContain("usage: promote.ts");
  });
});

describe("records on the channels repository (production layout)", () => {
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

describe("interleaved promotions", () => {
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
