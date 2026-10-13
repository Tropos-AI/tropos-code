// scripts/release/promote.ts
// Convergent promotion of channel pointers and GitHub's latest release (spec §7.4–7.6).
// Runs only from a checkout of main in a job that executes no code from the release tag (spec §6.2).
// Imports nothing but src/install/version.ts (no dependencies), so privileged jobs need no `bun install`.
import { compareVersions, isVersion } from "../../src/install/version";

export interface ReleaseInfo {
  tag: string;
  draft: boolean;
  prerelease: boolean;
  assets: string[];
}

export interface GitHubClient {
  getRelease(tag: string): Promise<ReleaseInfo | null>;
  createChannelsRelease(): Promise<void>;
  /** Public download; null on 404. */
  readAsset(tag: string, name: string): Promise<Uint8Array | null>;
  /** `gh release upload --clobber`: deletes the old asset, then uploads. */
  uploadAsset(tag: string, name: string, data: Uint8Array): Promise<void>;
  /** The API's latest release (for a repository's first release this names it before it is marked; spike D6a). */
  latestReleaseTag(): Promise<string | null>;
  /** Whether the public `releases/latest/download/manifest.json` route resolves to `tag`'s manifest. */
  latestDownloadResolves(tag: string): Promise<boolean>;
  markLatest(tag: string): Promise<void>;
}

export interface VerifiedRecord {
  version: string;
  commit: string;
  runId: string;
  verifiedAt: string;
}

export interface VerificationRecords {
  read(version: string): Promise<VerifiedRecord | null>;
  write(version: string, record: VerifiedRecord): Promise<void>;
}

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

function parseRecord(bytes: Uint8Array | null): VerifiedRecord | null {
  if (!bytes) return null;
  try {
    const r = JSON.parse(dec(bytes)) as VerifiedRecord;
    return isVersion(r.version) && typeof r.commit === "string" ? r : null;
  } catch {
    return null;
  }
}

/** Decision D1-A: `verified.json` on the version release itself (tests only; tropos-code releases are immutable). */
export function recordsOnVersionRelease(main: GitHubClient): VerificationRecords {
  return {
    read: async (v) => parseRecord(await main.readAsset(`v${v}`, "verified.json")),
    write: (v, r) => main.uploadAsset(`v${v}`, "verified.json", enc(`${JSON.stringify(r)}\n`)),
  };
}

/** Decision D1-B: `verified-<x>.json` on the mutable channels release. */
export function recordsOnChannelsRelease(channels: GitHubClient): VerificationRecords {
  return {
    read: async (v) => parseRecord(await channels.readAsset("channels", `verified-${v}.json`)),
    write: (v, r) => channels.uploadAsset("channels", `verified-${v}.json`, enc(`${JSON.stringify(r)}\n`)),
  };
}

export interface PromoteDeps {
  main: GitHubClient;
  channels: GitHubClient;
  records: VerificationRecords;
  /** Verifies against main's release/allowed_signers; returns the manifest's version and commit, or null. */
  verifyManifest(bytes: Uint8Array, signature: string): Promise<{ version: string; commit: string } | null>;
  sleep(ms: number): Promise<void>;
  now(): Date;
  runId: string;
  log(line: string): void;
}

type Slot = "latest" | "latest.bak" | "stable" | "stable.bak";
const READ_BACK_ATTEMPTS = 10;
const READ_BACK_DELAY_MS = 3000; // decision D6: at least twice the observed --clobber gap

async function readSlot(d: PromoteDeps, slot: Slot): Promise<string | null> {
  const bytes = await d.channels.readAsset("channels", slot);
  if (!bytes) return null;
  const text = dec(bytes);
  const v = text.endsWith("\n") ? text.slice(0, -1) : text;
  return isVersion(v) ? v : null;
}

const higher = (a: string | null, b: string | null) => (a === null ? b : b === null ? a : compareVersions(a, b) >= 0 ? a : b);

async function writeSlot(d: PromoteDeps, slot: Slot, x: string, expected: string | null): Promise<void> {
  const current = await readSlot(d, slot);
  if (current === x) return;
  if (current !== expected) throw new Error(`channels/${slot} changed from ${expected} to ${current} while promoting; refusing to overwrite`);
  await d.channels.uploadAsset("channels", slot, enc(`${x}\n`));
  for (let i = 0; i < READ_BACK_ATTEMPTS; i++) {
    if ((await readSlot(d, slot)) === x) {
      d.log(`channels/${slot} = ${x}`);
      return;
    }
    await d.sleep(READ_BACK_DELAY_MS);
  }
  throw new Error(`channels/${slot} does not read back as ${x}`);
}

/** GitHub latest counts as `tag` only when the API and the public latest/download route both name it (spike D6a). */
async function isGitHubLatest(d: PromoteDeps, tag: string): Promise<boolean> {
  return (await d.main.latestReleaseTag()) === tag && (await d.main.latestDownloadResolves(tag));
}

async function validateRelease(d: PromoteDeps, x: string): Promise<{ commit: string }> {
  if (!isVersion(x)) throw new Error(`not a version: ${x}`);
  const rel = await d.main.getRelease(`v${x}`);
  if (!rel || rel.draft) throw new Error(`v${x} is not published`);
  const [bytes, sig] = await Promise.all([d.main.readAsset(`v${x}`, "manifest.json"), d.main.readAsset(`v${x}`, "manifest.json.sig")]);
  const info = bytes && sig ? await d.verifyManifest(bytes, dec(sig)) : null;
  if (!info || info.version !== x) throw new Error(`v${x}: the manifest signature does not verify against release/allowed_signers`);
  return { commit: info.commit };
}

async function isVerifiedRelease(d: PromoteDeps, x: string | null): Promise<boolean> {
  if (x === null) return false;
  try {
    const { commit } = await validateRelease(d, x);
    const record = await d.records.read(x);
    return record !== null && record.version === x && record.commit === commit;
  } catch {
    return false;
  }
}

/** `promote.ts latest <x>` — every step checks its own effect first, so re-running resumes (spec §7.4). */
export async function promoteLatest(d: PromoteDeps, x: string): Promise<void> {
  const { commit } = await validateRelease(d, x);
  if (!(await d.channels.getRelease("channels"))) {
    await d.channels.createChannelsRelease();
    d.log("created the channels release (prerelease, never latest)");
  }
  const latest = { primary: await readSlot(d, "latest"), backup: await readSlot(d, "latest.bak") };
  const current = higher(latest.primary, latest.backup);
  if (current !== null && compareVersions(current, x) > 0) throw new Error(`promoting ${x} would move latest backwards from ${current}`);
  const record = await d.records.read(x);
  if (!record) await d.records.write(x, { version: x, commit, runId: d.runId, verifiedAt: d.now().toISOString() });
  else if (record.version !== x || record.commit !== commit) throw new Error(`v${x} already has a different verification record`);
  await writeSlot(d, "latest.bak", x, latest.backup);
  await writeSlot(d, "latest", x, latest.primary);
  const stable = { primary: await readSlot(d, "stable"), backup: await readSlot(d, "stable.bak") };
  // First release: neither slot exists — or only stable.bak, holding x, because a run was interrupted before stable.
  if (stable.primary === null && (stable.backup === null || stable.backup === x)) {
    await writeSlot(d, "stable.bak", x, null);
    await writeSlot(d, "stable", x, null);
  }
  if (!(await isGitHubLatest(d, `v${x}`))) {
    await d.main.markLatest(`v${x}`);
    for (let i = 0; !(await isGitHubLatest(d, `v${x}`)); i++) {
      if (i >= READ_BACK_ATTEMPTS) throw new Error(`GitHub does not report v${x} as the latest release`);
      await d.sleep(READ_BACK_DELAY_MS);
    }
    d.log(`GitHub latest = v${x}`);
  }
}

/** `promote.ts stable <x>` (spec §7.4). */
export async function promoteStable(d: PromoteDeps, x: string): Promise<void> {
  const { commit } = await validateRelease(d, x);
  const record = await d.records.read(x);
  if (!record || record.version !== x || record.commit !== commit) throw new Error(`v${x} has no verification record; only fully verified releases can become stable`);
  const latest = higher(await readSlot(d, "latest"), await readSlot(d, "latest.bak"));
  if (latest === null || compareVersions(x, latest) > 0) throw new Error(`stable cannot run ahead of latest (${latest})`);
  const stable = { primary: await readSlot(d, "stable"), backup: await readSlot(d, "stable.bak") };
  const current = higher(stable.primary, stable.backup);
  if (current !== null && compareVersions(x, current) < 0) throw new Error(`promoting ${x} would move stable backwards from ${current}`);
  await writeSlot(d, "stable.bak", x, stable.backup);
  await writeSlot(d, "stable", x, stable.primary);
}

/** `promote.ts check [--repair]` (spec §7.4): never points a slot at an unverified release, never lowers a verified slot. */
export async function checkChannels(d: PromoteDeps, repair: boolean): Promise<{ ok: boolean; problems: string[]; repaired: string[] }> {
  const problems: string[] = [];
  const repaired: string[] = [];
  for (const ch of ["latest", "stable"] as const) {
    const bak = `${ch}.bak` as Slot;
    const p = await readSlot(d, ch);
    const b = await readSlot(d, bak);
    const pv = await isVerifiedRelease(d, p);
    const bv = await isVerifiedRelease(d, b);
    if (!pv) problems.push(`${ch}: ${p === null ? "missing or invalid" : `${p} is not a verified release`}`);
    if (!bv) problems.push(`${bak}: ${b === null ? "missing or invalid" : `${b} is not a verified release`}`);
    if (pv && bv && p !== b) problems.push(`${ch}: slots differ (${p} vs ${b})`);
    if (!repair) continue;
    const target = higher(pv ? p : null, bv ? b : null);
    if (target === null) {
      problems.push(`${ch}: neither slot names a verified release; not repaired`);
      continue;
    }
    for (const [slot, value] of [[bak, b], [ch, p]] as const) {
      if (value !== target) {
        await d.channels.uploadAsset("channels", slot, enc(`${target}\n`));
        repaired.push(`${slot} := ${target}`);
      }
    }
  }
  const latest = await readSlot(d, "latest");
  const stable = await readSlot(d, "stable");
  if (latest && stable && compareVersions(stable, latest) > 0) problems.push(`stable ${stable} is ahead of latest ${latest}`);
  if (latest && !(await isGitHubLatest(d, `v${latest}`))) {
    const ghLatest = await d.main.latestReleaseTag();
    problems.push(ghLatest === `v${latest}` ? `GitHub's public releases/latest/download route does not resolve to v${latest} (channels/latest is ${latest})` : `GitHub latest is ${ghLatest}, channels/latest is ${latest}`);
    if (repair && (await isVerifiedRelease(d, latest))) {
      await d.main.markLatest(`v${latest}`);
      repaired.push(`GitHub latest := v${latest}`);
    }
  }
  return { ok: problems.length === 0, problems, repaired };
}

/**
 * For smoke-public b/c (spec §7.3 step 7): b (old installer) is skipped when GitHub reports no latest release
 * or reports the release under test itself (a first release; spike D6a); c when the channels release does not exist.
 */
export async function previousRelease(d: PromoteDeps, x: string): Promise<{ installerTag: string | null; stable: string | null }> {
  if (!isVersion(x)) throw new Error(`not a version: ${x}`);
  const hasChannels = (await d.channels.getRelease("channels")) !== null;
  const ghLatest = await d.main.latestReleaseTag();
  const installerTag = ghLatest === `v${x}` ? null : ghLatest;
  const stable = hasChannels ? higher(await readSlot(d, "stable"), await readSlot(d, "stable.bak")) : null;
  return { installerTag, stable };
}

if (import.meta.main) {
  const { ghClient, sshVerifyManifest } = await import("./github");
  const repo = process.env.GITHUB_REPOSITORY!;
  // Decision D1-B: slots and verification records live on the channels repository; tropos-code releases are immutable.
  const channelsRepo = process.env.CHANNELS_REPOSITORY || "Tropos-AI/tropos-code-channels";
  const main: GitHubClient = {
    ...ghClient(repo),
    uploadAsset: async (tag) => {
      throw new Error(`refusing to upload to ${repo} release ${tag}: version releases are immutable`);
    },
  };
  const channels = ghClient(channelsRepo, process.env.CHANNELS_WRITE_TOKEN || undefined);
  const deps: PromoteDeps = {
    main,
    channels,
    records: recordsOnChannelsRelease(channels),
    verifyManifest: sshVerifyManifest("release/allowed_signers"),
    sleep: (ms) => Bun.sleep(ms),
    now: () => new Date(),
    runId: process.env.GITHUB_RUN_ID ?? "local",
    log: (line) => console.log(line),
  };
  const [command, arg] = process.argv.slice(2);
  if (command === "latest") await promoteLatest(deps, arg!);
  else if (command === "stable") await promoteStable(deps, arg!);
  else if (command === "check") {
    const report = await checkChannels(deps, arg === "--repair");
    for (const line of [...report.problems, ...report.repaired]) console.log(line);
    process.exit(report.ok ? 0 : 1);
  } else if (command === "previous" && arg) {
    const prev = await previousRelease(deps, arg);
    console.log(`installer_tag=${prev.installerTag ?? ""}`);
    console.log(`stable=${prev.stable ?? ""}`);
  } else {
    console.error("usage: promote.ts latest <version> | stable <version> | check [--repair] | previous <version>");
    process.exit(64);
  }
}
