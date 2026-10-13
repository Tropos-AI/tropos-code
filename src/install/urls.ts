// src/install/urls.ts
import { isVersion } from "./version";

export interface ReleaseUrls {
  /** A channel pointer slot: "latest", "latest.bak", "stable" or "stable.bak". */
  channel(slot: string): string;
  /** An asset of release v<version>. */
  asset(version: string, name: string): string;
  /** An asset of GitHub's latest release (fallback for the latest channel, spec §10.4). */
  latestAsset(name: string): string;
}

export const RELEASE_REPO = "Tropos-AI/tropos-code";
/** Where the `channels` release lives. A separate repository because tropos-code releases are immutable (decision D1-B). */
export const CHANNELS_REPO = "Tropos-AI/tropos-code-channels";

const ASSET_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SLOT_RE = /^(latest|stable)(\.bak)?$/;

function assetName(name: string): string {
  if (!ASSET_RE.test(name) || name.includes("..")) throw new Error(`bad asset name: ${name}`);
  return name;
}

export function githubReleaseUrls(opts: { base?: string; repo?: string; channelsRepo?: string } = {}): ReleaseUrls {
  const base = (opts.base ?? "https://github.com").replace(/\/+$/, "");
  const repo = opts.repo ?? RELEASE_REPO;
  const channelsRepo = opts.channelsRepo ?? CHANNELS_REPO;
  return {
    channel(slot) {
      if (!SLOT_RE.test(slot)) throw new Error(`bad channel slot: ${slot}`);
      return `${base}/${channelsRepo}/releases/download/channels/${slot}`;
    },
    asset(version, name) {
      if (!isVersion(version)) throw new Error(`not a version: ${JSON.stringify(version)}`);
      return `${base}/${repo}/releases/download/v${version}/${assetName(name)}`;
    },
    latestAsset: (name) => `${base}/${repo}/releases/latest/download/${assetName(name)}`,
  };
}

export const RELEASE_URLS: ReleaseUrls = githubReleaseUrls();
