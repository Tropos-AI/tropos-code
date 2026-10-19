// scripts/release/promote.ts
// Convergent promotion of channel pointers and GitHub's latest release.
// Runs only from a checkout of main in a job that executes no code from the release tag.
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

/** `verified-<x>.json` on the mutable channels release. */
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
type Channel = "latest" | "stable";
const READ_BACK_ATTEMPTS = 10;
const READ_BACK_DELAY_MS = 3000; // at least twice the observed --clobber gap

/** A definite "not verified" answer; transport and API errors are never one (they propagate). */
class NotVerified extends Error {}

/** The slot's content without its trailing newline; null when the asset does not exist. */
async function readRaw(d: PromoteDeps, slot: Slot): Promise<string | null> {
  const bytes = await d.channels.readAsset("channels", slot);
  if (!bytes) return null;
  const text = dec(bytes);
  return text.endsWith("\n") ? text.slice(0, -1) : text;
}

const asVersion = (raw: string | null) => (raw !== null && isVersion(raw) ? raw : null);
const show = (raw: string) => JSON.stringify(raw.length > 40 ? `${raw.slice(0, 40)}…` : raw);

/** Both slots of a channel; content that is not a version stops a promotion for a maintainer to resolve. */
async function readChannel(d: PromoteDeps, ch: Channel): Promise<{ primary: string | null; backup: string | null }> {
  const primary = await readRaw(d, ch);
  const backup = await readRaw(d, `${ch}.bak`);
  for (const [slot, raw] of [[ch, primary], [`${ch}.bak`, backup]] as const) {
    if (raw !== null && !isVersion(raw)) throw new Error(`channels/${slot} holds invalid content ${show(raw)}; a maintainer must fix it (see \`promote.ts check\`)`);
  }
  return { primary, backup };
}

const higher = (a: string | null, b: string | null) => (a === null ? b : b === null ? a : compareVersions(a, b) >= 0 ? a : b);

/** Compare-before-write: `expected` is the raw content this run read; anything else was written by someone else. */
async function writeSlot(d: PromoteDeps, slot: Slot, x: string, expected: string | null): Promise<void> {
  const current = await readRaw(d, slot);
  if (current === x) return;
  if (current !== expected) throw new Error(`channels/${slot} changed from ${expected} to ${current} while promoting; refusing to overwrite`);
  await d.channels.uploadAsset("channels", slot, enc(`${x}\n`));
  for (let i = 0; i < READ_BACK_ATTEMPTS; i++) {
    if ((await readRaw(d, slot)) === x) {
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
  if (!isVersion(x)) throw new NotVerified(`not a version: ${x}`);
  const rel = await d.main.getRelease(`v${x}`);
  if (!rel || rel.draft) throw new NotVerified(`v${x} is not published`);
  const [bytes, sig] = await Promise.all([d.main.readAsset(`v${x}`, "manifest.json"), d.main.readAsset(`v${x}`, "manifest.json.sig")]);
  const info = bytes && sig ? await d.verifyManifest(bytes, dec(sig)) : null;
  if (!info || info.version !== x) throw new NotVerified(`v${x}: the manifest signature does not verify against release/allowed_signers`);
  return { commit: info.commit };
}

/** False only for a definite negative; a transport or API error propagates so a check fails instead of repairing. */
async function isVerifiedRelease(d: PromoteDeps, x: string): Promise<boolean> {
  let commit: string;
  try {
    ({ commit } = await validateRelease(d, x));
  } catch (e) {
    if (e instanceof NotVerified) return false;
    throw e;
  }
  const record = await d.records.read(x);
  return record !== null && record.version === x && record.commit === commit;
}

/** `promote.ts latest <x>` — every step checks its own effect first, so re-running resumes. */
export async function promoteLatest(d: PromoteDeps, x: string): Promise<void> {
  const { commit } = await validateRelease(d, x);
  if (!(await d.channels.getRelease("channels"))) {
    await d.channels.createChannelsRelease();
    d.log("created the channels release (prerelease, never latest)");
  }
  const latest = await readChannel(d, "latest");
  await readChannel(d, "stable"); // invalid stable content stops the run before anything is written
  const current = higher(latest.primary, latest.backup);
  if (current !== null && compareVersions(current, x) > 0) throw new Error(`promoting ${x} would move latest backwards from ${current}`);
  const record = await d.records.read(x);
  if (!record) await d.records.write(x, { version: x, commit, runId: d.runId, verifiedAt: d.now().toISOString() });
  else if (record.version !== x || record.commit !== commit) throw new Error(`v${x} already has a different verification record`);
  await writeSlot(d, "latest.bak", x, latest.backup);
  await writeSlot(d, "latest", x, latest.primary);
  const stable = await readChannel(d, "stable");
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

/** `promote.ts stable <x>`. */
export async function promoteStable(d: PromoteDeps, x: string): Promise<void> {
  const { commit } = await validateRelease(d, x);
  const record = await d.records.read(x);
  if (!record || record.version !== x || record.commit !== commit) throw new Error(`v${x} has no verification record; only fully verified releases can become stable`);
  const latestSlots = await readChannel(d, "latest");
  const latest = higher(latestSlots.primary, latestSlots.backup);
  if (latest === null || compareVersions(x, latest) > 0) throw new Error(`stable cannot run ahead of latest (${latest})`);
  const stable = await readChannel(d, "stable");
  const current = higher(stable.primary, stable.backup);
  if (current !== null && compareVersions(x, current) < 0) throw new Error(`promoting ${x} would move stable backwards from ${current}`);
  await writeSlot(d, "stable.bak", x, stable.backup);
  await writeSlot(d, "stable", x, stable.primary);
}

/**
 * `promote.ts check [--repair]`: never points a slot at an unverified release, never lowers a verified slot.
 * Every slot is judged before anything is repaired, so an error while judging changes nothing.
 */
export async function checkChannels(d: PromoteDeps, repair: boolean): Promise<{ ok: boolean; problems: string[]; repaired: string[] }> {
  const problems: string[] = [];
  const repaired: string[] = [];
  const verdicts = new Map<string, boolean>();
  const verified = async (v: string | null): Promise<boolean> => {
    if (v === null) return false;
    if (!verdicts.has(v)) verdicts.set(v, await isVerifiedRelease(d, v));
    return verdicts.get(v)!;
  };
  const slotProblem = (raw: string | null) => (raw === null ? "missing" : isVersion(raw) ? `${raw} is not a verified release` : `invalid content ${show(raw)}`);
  const plans: Array<{ ch: Channel; bak: Slot; p: string | null; b: string | null; target: string | null }> = [];
  for (const ch of ["latest", "stable"] as const) {
    const bak = `${ch}.bak` as Slot;
    const p = await readRaw(d, ch);
    const b = await readRaw(d, bak);
    const pv = await verified(asVersion(p));
    const bv = await verified(asVersion(b));
    if (!pv) problems.push(`${ch}: ${slotProblem(p)}`);
    if (!bv) problems.push(`${bak}: ${slotProblem(b)}`);
    if (pv && bv && p !== b) problems.push(`${ch}: slots differ (${p} vs ${b})`);
    plans.push({ ch, bak, p, b, target: higher(pv ? p : null, bv ? b : null) });
  }
  if (repair) {
    for (const { ch, bak, p, b, target } of plans) {
      if (target === null) {
        problems.push(`${ch}: neither slot names a verified release; not repaired`);
        continue;
      }
      for (const [slot, value] of [[bak, b], [ch, p]] as const) {
        if (value !== target) {
          await writeSlot(d, slot, target, value);
          repaired.push(`${slot} := ${target}`);
        }
      }
    }
  }
  const latest = asVersion(await readRaw(d, "latest"));
  const stable = asVersion(await readRaw(d, "stable"));
  if (latest && stable && compareVersions(stable, latest) > 0) problems.push(`stable ${stable} is ahead of latest ${latest}`);
  if (latest && !(await isGitHubLatest(d, `v${latest}`))) {
    const ghLatest = await d.main.latestReleaseTag();
    const ghVersion = ghLatest?.startsWith("v") ? asVersion(ghLatest.slice(1)) : null;
    if (ghLatest === `v${latest}`) problems.push(`GitHub's public releases/latest/download route does not resolve to v${latest} (channels/latest is ${latest})`);
    else if (ghVersion && compareVersions(ghVersion, latest) > 0) problems.push(`GitHub latest ${ghLatest} is ahead of channels/latest ${latest} — was it marked manually?`);
    else problems.push(`GitHub latest is ${ghLatest}, channels/latest is ${latest}`);
    if (repair && (await verified(latest))) {
      await d.main.markLatest(`v${latest}`);
      repaired.push(`GitHub latest := v${latest}`);
    }
  }
  return { ok: problems.length === 0, problems, repaired };
}

/**
 * For smoke-public b/c. b tests the installer users currently get: the release promoted to
 * channels/latest, which promotion makes GitHub latest. It is read from channels, not from GitHub's latest flag,
 * because the API can name a release published with --latest=false as latest (spike D6a; seen again in the
 * 2026-10-14 dry run for a second release), which would skip b. b is skipped when nothing is promoted yet or the
 * release under test is the promoted one (a resumed run); c when the channels release does not exist.
 * Errors propagate: a gate must never be skipped because GitHub could not be asked.
 */
export async function previousRelease(d: PromoteDeps, x: string): Promise<{ installerTag: string | null; stable: string | null }> {
  if (!isVersion(x)) throw new Error(`not a version: ${x}`);
  if ((await d.channels.getRelease("channels")) === null) return { installerTag: null, stable: null };
  const latest = await readChannel(d, "latest");
  const stable = await readChannel(d, "stable");
  const promoted = higher(latest.primary, latest.backup);
  return { installerTag: promoted === null || promoted === x ? null : `v${promoted}`, stable: higher(stable.primary, stable.backup) };
}

if (import.meta.main) {
  const [command, arg, extra] = process.argv.slice(2);
  const wellFormed = extra === undefined && ((["latest", "stable", "previous"].includes(command ?? "") && arg !== undefined) || (command === "check" && (arg === undefined || arg === "--repair")));
  if (!wellFormed) {
    console.error("usage: promote.ts latest <version> | stable <version> | check [--repair] | previous <version>");
    process.exit(64);
  }
  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo) {
    console.error("GITHUB_REPOSITORY is not set");
    process.exit(64);
  }
  // Writes to the channels repository use only CHANNELS_WRITE_TOKEN, never the ambient token.
  const writesChannels = command === "latest" || command === "stable" || (command === "check" && arg === "--repair");
  const channelsToken = process.env.CHANNELS_WRITE_TOKEN || undefined;
  if (writesChannels && !channelsToken) {
    console.error(`promote.ts ${command}${arg ? ` ${arg}` : ""}: CHANNELS_WRITE_TOKEN is not set; writes to the channels repository use only that token`);
    process.exit(1);
  }
  const { ghClient, sshVerifyManifest } = await import("./github");
  // Slots and verification records live on the channels repository; tropos-code releases are immutable.
  const channelsRepo = process.env.CHANNELS_REPOSITORY || "Tropos-AI/tropos-code-channels";
  const main: GitHubClient = {
    ...ghClient(repo),
    uploadAsset: async (tag) => {
      throw new Error(`refusing to upload to ${repo} release ${tag}: version releases are immutable`);
    },
  };
  const channels = ghClient(channelsRepo, channelsToken);
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
  if (command === "latest") await promoteLatest(deps, arg!);
  else if (command === "stable") await promoteStable(deps, arg!);
  else if (command === "check") {
    const report = await checkChannels(deps, arg === "--repair");
    for (const line of [...report.problems, ...report.repaired]) console.log(line);
    process.exit(report.ok ? 0 : 1);
  } else {
    const prev = await previousRelease(deps, arg!);
    console.log(`installer_tag=${prev.installerTag ?? ""}`);
    console.log(`stable=${prev.stable ?? ""}`);
  }
}
