// scripts/release/github.ts
// gh-backed GitHubClient and ssh-keygen manifest verification for promote.ts (Bun/Node built-ins only).
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitHubClient } from "./promote";

export interface GhResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Runs `gh <args>` with the given environment. */
export type GhRunner = (args: string[], env: Record<string, string | undefined>) => Promise<GhResult>;
export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

export const runGh: GhRunner = async (args, env) => {
  const r = await Bun.$`gh ${args}`.env(env).quiet().nothrow();
  return { exitCode: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
};

const HTTP_TIMEOUT_MS = 30_000;
/** `gh api` reports an HTTP 404 as "gh: Not Found (HTTP 404)" on stderr. */
const isNotFound = (r: GhResult) => r.exitCode !== 0 && r.stderr.includes("(HTTP 404)");

/** Null only for a definite absence (HTTP 404); every other failure throws, so no caller mistakes an outage for "absent". */
export function ghClient(repo: string, token?: string, io: { run?: GhRunner; fetch?: Fetcher } = {}): GitHubClient {
  const env = token ? { ...process.env, GH_TOKEN: token } : process.env;
  const run = io.run ?? runGh;
  const get = io.fetch ?? ((url, init) => fetch(url, init));
  const gh = (args: string[]) => run(args, env);
  const fail = (what: string, r: GhResult) => new Error(`${what} failed (exit ${r.exitCode}): ${r.stderr.trim()}`);
  return {
    async getRelease(tag) {
      const r = await gh(["api", `repos/${repo}/releases/tags/${tag}`]);
      if (r.exitCode === 0) {
        const j = JSON.parse(r.stdout) as { draft: boolean; prerelease: boolean; assets: Array<{ name: string }> };
        return { tag, draft: j.draft, prerelease: j.prerelease, assets: j.assets.map((a) => a.name) };
      }
      if (!isNotFound(r)) throw fail(`reading release ${repo}@${tag}`, r);
      // Drafts are not returned by the tag endpoint; look them up in the list (needs push access).
      const list = await gh(["api", `repos/${repo}/releases?per_page=100`]);
      if (list.exitCode !== 0) throw fail(`listing releases of ${repo}`, list);
      const found = (JSON.parse(list.stdout) as Array<{ tag_name: string; draft: boolean; prerelease: boolean; assets: Array<{ name: string }> }>).find((x) => x.tag_name === tag);
      return found ? { tag, draft: found.draft, prerelease: found.prerelease, assets: found.assets.map((a) => a.name) } : null;
    },
    async createChannelsRelease() {
      const r = await gh(["release", "create", "channels", "--repo", repo, "--prerelease", "--latest=false", "--title", "Channel pointers", "--notes", "Holds the latest and stable channel pointers and the verification records for the Tropos Code installer. Not a release; do not download."]);
      if (r.exitCode !== 0) throw new Error(`creating the channels release in ${repo} failed (the repository needs an initial commit before \`gh release create channels\` works): ${r.stderr}`);
    },
    async readAsset(tag, name) {
      // Through the API, never github.com/…/releases/download: that route caches a 404 for about a minute and a
      // replaced asset's old bytes for about two (dry run, 2026-10-14), so a read-back right after an upload would
      // see the old value. A replaced asset gets a new id, so downloading by id is never stale.
      const rel = await gh(["api", `repos/${repo}/releases/tags/${tag}`]);
      if (isNotFound(rel)) return null;
      if (rel.exitCode !== 0) throw fail(`reading release ${repo}@${tag}`, rel);
      const asset = (JSON.parse(rel.stdout) as { assets: Array<{ id: number; name: string }> }).assets.find((a) => a.name === name);
      if (!asset) return null;
      const r = await gh(["api", "-H", "Accept: application/octet-stream", `repos/${repo}/releases/assets/${asset.id}`]);
      if (r.exitCode !== 0) throw fail(`downloading ${repo}@${tag}/${name}`, r);
      return new TextEncoder().encode(r.stdout);
    },
    async uploadAsset(tag, name, data) {
      const dir = await mkdtemp(join(tmpdir(), "promote-"));
      try {
        await writeFile(join(dir, name), data);
        const r = await gh(["release", "upload", tag, join(dir, name), "--clobber", "--repo", repo]);
        if (r.exitCode !== 0) throw new Error(`uploading ${tag}/${name} failed: ${r.stderr}`);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    async latestReleaseTag() {
      const r = await gh(["api", `repos/${repo}/releases/latest`, "--jq", ".tag_name"]);
      if (isNotFound(r)) return null;
      if (r.exitCode !== 0) throw fail(`reading the latest release of ${repo}`, r);
      return r.stdout.trim() || null;
    },
    async latestDownloadResolves(tag) {
      // The public route answers 302 to releases/download/<tag>/<asset>, or 404 before anything is marked latest (spike D6a).
      // The query string bypasses the edge cache, which keeps answering the previous target for about two minutes;
      // this asks whether the route is right now, and users' plain requests follow once the cache expires.
      const res = await get(`https://github.com/${repo}/releases/latest/download/manifest.json?nocache=${crypto.randomUUID()}`, { redirect: "manual", signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
      const location = res.headers.get("location");
      if (res.status < 300 || res.status >= 400 || !location) return false;
      return new URL(location, "https://github.com").pathname.toLowerCase() === `/${repo}/releases/download/${tag}/manifest.json`.toLowerCase();
    },
    async markLatest(tag) {
      const r = await gh(["release", "edit", tag, "--latest", "--repo", repo]);
      if (r.exitCode !== 0) throw new Error(`marking ${tag} latest failed: ${r.stderr}`);
    },
  };
}

/** Verifies with `ssh-keygen -Y verify` against the given allowed_signers file; then reads version and commit. */
export function sshVerifyManifest(signersPath: string) {
  return async (bytes: Uint8Array, signature: string): Promise<{ version: string; commit: string } | null> => {
    const dir = await mkdtemp(join(tmpdir(), "verify-"));
    try {
      await writeFile(join(dir, "m.json"), bytes);
      await writeFile(join(dir, "m.sig"), signature);
      const r = await Bun.$`ssh-keygen -Y verify -f ${signersPath} -I tropos-release -n tropos-manifest -s ${join(dir, "m.sig")} < ${join(dir, "m.json")}`.quiet().nothrow();
      if (r.exitCode !== 0) return null;
      const m = JSON.parse(new TextDecoder().decode(bytes)) as { version: string; commit: string };
      return { version: m.version, commit: m.commit };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };
}
