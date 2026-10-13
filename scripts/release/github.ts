// scripts/release/github.ts
// gh-backed GitHubClient and ssh-keygen manifest verification for promote.ts (Bun/Node built-ins only).
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitHubClient } from "./promote";

export function ghClient(repo: string, token?: string): GitHubClient {
  const env = token ? { ...process.env, GH_TOKEN: token } : process.env;
  const gh = (args: string[]) => Bun.$`gh ${args}`.env(env).quiet().nothrow();
  return {
    async getRelease(tag) {
      const r = await gh(["api", `repos/${repo}/releases/tags/${tag}`]);
      if (r.exitCode !== 0) {
        // Drafts are not returned by the tag endpoint; look them up in the list (needs push access).
        const list = await gh(["api", `repos/${repo}/releases?per_page=100`]);
        const found = list.exitCode === 0 ? (JSON.parse(list.stdout.toString()) as Array<{ tag_name: string; draft: boolean; prerelease: boolean; assets: Array<{ name: string }> }>).find((x) => x.tag_name === tag) : undefined;
        return found ? { tag, draft: found.draft, prerelease: found.prerelease, assets: found.assets.map((a) => a.name) } : null;
      }
      const j = JSON.parse(r.stdout.toString()) as { draft: boolean; prerelease: boolean; assets: Array<{ name: string }> };
      return { tag, draft: j.draft, prerelease: j.prerelease, assets: j.assets.map((a) => a.name) };
    },
    async createChannelsRelease() {
      const r = await gh(["release", "create", "channels", "--repo", repo, "--prerelease", "--latest=false", "--title", "Channel pointers", "--notes", "Holds the latest and stable channel pointers and the verification records for the Tropos Code installer. Not a release; do not download."]);
      if (r.exitCode !== 0) throw new Error(`creating the channels release in ${repo} failed (the repository needs an initial commit before \`gh release create channels\` works): ${r.stderr}`);
    },
    async readAsset(tag, name) {
      const res = await fetch(`https://github.com/${repo}/releases/download/${tag}/${name}`, { redirect: "follow" });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`reading ${tag}/${name}: HTTP ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
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
      return r.exitCode === 0 ? r.stdout.toString().trim() || null : null;
    },
    async latestDownloadResolves(tag) {
      // The public route answers 302 to releases/download/<tag>/<asset>, or 404 before anything is marked latest (spike D6a).
      const res = await fetch(`https://github.com/${repo}/releases/latest/download/manifest.json`, { redirect: "manual" });
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

/** Verifies with `ssh-keygen -Y verify` against the given allowed_signers file (spec §4.3); then reads version and commit. */
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
