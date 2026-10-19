// src/install/remote.ts
import { InstallError } from "./errors";
import { fetchBytes, type FetchLike } from "./fetch";
import { MAX_MANIFEST_BYTES, expectVersion, verifyManifest, type VerifiedManifest } from "./manifest";
import type { TrustedKey } from "./sshsig";
import type { ReleaseUrls } from "./urls";
import { isVersion } from "./version";

export interface RemoteDeps {
  urls: ReleaseUrls;
  trusted: readonly TrustedKey[];
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  allowLoopbackHttp?: boolean;
}

export const SMALL_TIMEOUT_MS = 10_000;
const MAX_SIGNATURE_BYTES = 4096;
const MAX_POINTER_BYTES = 64;

/** 1 s, 2 s, 4 s with ±20 % jitter; `random` returns a number in [0, 1). */
export function backoffDelays(random: () => number = Math.random): number[] {
  return [1000, 2000, 4000].map((ms) => Math.round(ms * (0.8 + 0.4 * random())));
}

/** Up to 3 attempts, sleeping 1 s then 2 s between them; only `network` errors are retried. */
export async function withRetries<T>(attempt: () => Promise<T>, deps: Pick<RemoteDeps, "sleep" | "random">): Promise<T> {
  const sleep = deps.sleep ?? ((ms: number) => Bun.sleep(ms));
  const delays = backoffDelays(deps.random);
  for (let i = 0; ; i++) {
    try {
      return await attempt();
    } catch (e) {
      if (!(e instanceof InstallError && e.kind === "network") || i === 2) throw e;
      await sleep(delays[i]!);
    }
  }
}

const small = (deps: RemoteDeps, maxBytes: number) => ({ maxBytes, timeoutMs: SMALL_TIMEOUT_MS, fetch: deps.fetch, allowLoopbackHttp: deps.allowLoopbackHttp });

/** A pointer is one version and an optional final newline; anything else counts as a failed attempt. */
export async function fetchPointer(url: string, deps: RemoteDeps): Promise<string> {
  return withRetries(async () => {
    let bytes: Uint8Array;
    try {
      bytes = await fetchBytes(url, small(deps, MAX_POINTER_BYTES));
    } catch (e) {
      if (e instanceof InstallError && e.kind === "integrity") throw new InstallError("network", `channel pointer is not usable: ${e.message}`);
      throw e;
    }
    const text = new TextDecoder().decode(bytes);
    const version = text.endsWith("\n") ? text.slice(0, -1) : text;
    if (!isVersion(version)) throw new InstallError("network", `channel pointer ${url} does not contain a version`);
    return version;
  }, deps);
}

async function fetchSigned(manifestUrl: string, signatureUrl: string, deps: RemoteDeps): Promise<VerifiedManifest> {
  const [bytes, sig] = await withRetries(
    () => Promise.all([fetchBytes(manifestUrl, small(deps, MAX_MANIFEST_BYTES)), fetchBytes(signatureUrl, small(deps, MAX_SIGNATURE_BYTES))]),
    deps,
  );
  return verifyManifest(bytes, new TextDecoder().decode(sig), deps.trusted);
}

export async function fetchVersionManifest(version: string, deps: RemoteDeps): Promise<VerifiedManifest> {
  const verified = await fetchSigned(deps.urls.asset(version, "manifest.json"), deps.urls.asset(version, "manifest.json.sig"), deps);
  expectVersion(verified.manifest, version);
  return verified;
}

export async function fetchLatestReleaseManifest(deps: RemoteDeps): Promise<VerifiedManifest> {
  return fetchSigned(deps.urls.latestAsset("manifest.json"), deps.urls.latestAsset("manifest.json.sig"), deps);
}
