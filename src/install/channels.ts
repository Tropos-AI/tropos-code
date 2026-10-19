// src/install/channels.ts
import { InstallError } from "./errors";
import { backoffDelays, fetchLatestReleaseManifest, fetchPointer, type RemoteDeps } from "./remote";

export const CHANNELS = ["latest", "stable"] as const;
export type Channel = (typeof CHANNELS)[number];

export function isChannel(value: string): value is Channel {
  return (CHANNELS as readonly string[]).includes(value);
}

export interface Resolution {
  channel: Channel;
  version: string;
  source: "primary" | "backup" | "github-latest";
}

/**
 * Primary slot, then `.bak`, then (latest only) GitHub's latest release.
 * Each source gets 3 attempts; the 4 s backoff step separates sources.
 */
export async function resolveChannel(channel: Channel, deps: RemoteDeps): Promise<Resolution> {
  const sleep = deps.sleep ?? ((ms: number) => Bun.sleep(ms));
  const between = backoffDelays(deps.random)[2]!;
  const sources: Array<() => Promise<Resolution>> = [
    async () => ({ channel, version: await fetchPointer(deps.urls.channel(channel), deps), source: "primary" }),
    async () => ({ channel, version: await fetchPointer(deps.urls.channel(`${channel}.bak`), deps), source: "backup" }),
  ];
  if (channel === "latest") {
    sources.push(async () => ({ channel, version: (await fetchLatestReleaseManifest(deps)).manifest.version, source: "github-latest" }));
  }
  let last = "";
  for (const [i, source] of sources.entries()) {
    try {
      return await source();
    } catch (e) {
      if (!(e instanceof InstallError && e.kind === "network")) throw e;
      last = e.message;
      if (i < sources.length - 1) await sleep(between);
    }
  }
  const hint = channel === "stable" ? "; try again, or install an explicit version" : "";
  throw new InstallError("network", `cannot resolve the ${channel} channel (${last})${hint}`);
}
