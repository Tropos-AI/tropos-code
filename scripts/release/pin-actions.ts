// scripts/release/pin-actions.ts
// Rewrites `uses: owner/repo@vN` to `uses: owner/repo@<40-hex sha> # vN` (spec §6.2). Run after editing workflows:
//   bun scripts/release/pin-actions.ts .github/workflows/*.yml
import { readFile, writeFile } from "node:fs/promises";

const USES = /^(\s*-?\s*uses:\s*)([\w.-]+\/[\w./-]+)@([^\s#]+)\s*$/;

export async function pinActions(text: string, resolve: (repo: string, ref: string) => Promise<string>): Promise<string> {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const m = USES.exec(line);
    if (!m || /^[0-9a-f]{40}$/.test(m[3]!)) {
      out.push(line);
      continue;
    }
    const repo = m[2]!.split("/").slice(0, 2).join("/");
    out.push(`${m[1]}${m[2]}@${await resolve(repo, m[3]!)} # ${m[3]}`);
  }
  return out.join("\n");
}

if (import.meta.main) {
  const resolve = async (repo: string, ref: string) => {
    const sha = (await Bun.$`gh api repos/${repo}/commits/${ref} --jq .sha`.text()).trim();
    if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`${repo}@${ref} resolved to ${JSON.stringify(sha)}, not a commit SHA`);
    return sha;
  };
  for (const file of process.argv.slice(2)) await writeFile(file, await pinActions(await readFile(file, "utf8"), resolve));
}
