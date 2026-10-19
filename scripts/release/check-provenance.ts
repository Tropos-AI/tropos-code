// scripts/release/check-provenance.ts
// Before anything is signed: was this artifact built by release-build.yml, from a version tag of this repository,
// at the exact tagged commit, which is on main — and is it byte-for-byte what GitHub recorded?
import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { PLATFORMS } from "../../src/install/platform";
import { isVersion } from "../../src/install/version";

export const RELEASE_BUILD_PATH = ".github/workflows/release-build.yml";

export interface WorkflowRun {
  id: number;
  repository: { full_name: string };
  head_repository: { full_name: string } | null;
  head_branch: string;
  head_sha: string;
  path: string;
  event: string;
  conclusion: string | null;
}

export interface ProvenanceApi {
  /** The commit a tag points at, dereferencing annotated tags; null if the tag does not exist. */
  tagCommit(tag: string): Promise<string | null>;
  isOnMain(sha: string): Promise<boolean>;
  runArtifacts(runId: number): Promise<Array<{ id: number; name: string; expired: boolean; digest: string | null }>>;
  downloadArtifactZip(id: number): Promise<Uint8Array>;
  latestSuccessfulBuildRun(tag: string, sha: string): Promise<WorkflowRun | null>;
}

export interface Provenance {
  tag: string;
  version: string;
  sha: string;
  runId: number;
  zip: Uint8Array;
}

export async function checkProvenance(run: WorkflowRun, repo: string, api: ProvenanceApi): Promise<Provenance> {
  if (run.repository.full_name !== repo) throw new Error(`run belongs to ${run.repository.full_name}, not ${repo}`);
  if (run.head_repository?.full_name !== repo) throw new Error(`head repository is ${run.head_repository?.full_name ?? "unknown"}, not ${repo}`);
  if (run.path !== RELEASE_BUILD_PATH) throw new Error(`run ${run.id} is ${run.path}, not release-build.yml`);
  if (run.event !== "push") throw new Error(`run ${run.id} was triggered by ${run.event}, not a tag push`);
  if (run.conclusion !== "success") throw new Error(`run ${run.id} concluded ${run.conclusion}`);
  const version = run.head_branch.startsWith("v") ? run.head_branch.slice(1) : "";
  if (!isVersion(version)) throw new Error(`${run.head_branch} is not a release tag`);
  const tagged = await api.tagCommit(run.head_branch);
  if (tagged !== run.head_sha) throw new Error(`tag ${run.head_branch} points at ${tagged}, but run ${run.id} built ${run.head_sha}`);
  if (!(await api.isOnMain(run.head_sha))) throw new Error(`commit ${run.head_sha} is not on main`);
  const artifacts = (await api.runArtifacts(run.id)).filter((a) => a.name === "release-inputs");
  if (artifacts.length !== 1) throw new Error(`expected exactly one release-inputs artifact, found ${artifacts.length}`);
  const artifact = artifacts[0]!;
  if (artifact.expired) throw new Error("the release-inputs artifact has expired");
  if (!artifact.digest || !/^sha256:[0-9a-f]{64}$/.test(artifact.digest)) throw new Error("the release-inputs artifact has no sha256 digest");
  const zip = await api.downloadArtifactZip(artifact.id);
  const actual = `sha256:${new Bun.CryptoHasher("sha256").update(zip).digest("hex")}`;
  if (actual !== artifact.digest) throw new Error("the downloaded release-inputs zip does not match its recorded digest");
  return { tag: run.head_branch, version, sha: run.head_sha, runId: run.id, zip };
}

export async function runForDispatch(tag: string, api: ProvenanceApi): Promise<WorkflowRun> {
  if (!tag.startsWith("v") || !isVersion(tag.slice(1))) throw new Error(`${tag} is not a release tag`);
  const sha = await api.tagCommit(tag);
  if (!sha) throw new Error(`tag ${tag} does not exist`);
  const run = await api.latestSuccessfulBuildRun(tag, sha);
  if (!run) throw new Error(`no successful release-build run for ${tag} at ${sha}`);
  if (run.head_branch !== tag) throw new Error(`run ${run.id} built ${run.head_branch}, not ${tag}`);
  return run;
}

/** The unzipped inputs must be exactly install.sh + six binaries + SHA256SUMS, each matching its sum. */
export async function verifyReleaseInputs(dir: string): Promise<void> {
  const expected = ["install.sh", ...PLATFORMS.map((p) => `tropos-${p}`)].sort();
  const present = (await readdir(dir)).filter((n) => n !== "SHA256SUMS").sort();
  for (const n of present) if (!expected.includes(n)) throw new Error(`unexpected file ${n} in release-inputs`);
  for (const n of expected) if (!present.includes(n)) throw new Error(`missing ${n} in release-inputs`);
  for (const n of [...expected, "SHA256SUMS"]) {
    if (!(await lstat(join(dir, n))).isFile()) throw new Error(`${n} in release-inputs is not a regular file`);
  }
  const sums = new Map<string, string>();
  for (const line of (await readFile(join(dir, "SHA256SUMS"), "utf8")).trim().split("\n")) {
    const m = /^([0-9a-f]{64}) [ *]?(\S+)$/.exec(line.trim());
    if (!m) throw new Error(`bad SHA256SUMS line: ${line}`);
    if (sums.has(m[2]!)) throw new Error(`duplicate SHA256SUMS entry for ${m[2]}`);
    sums.set(m[2]!, m[1]!);
  }
  if ([...sums.keys()].sort().join() !== expected.join()) throw new Error("SHA256SUMS does not list exactly the release inputs");
  for (const n of expected) {
    const actual = new Bun.CryptoHasher("sha256").update(await readFile(join(dir, n))).digest("hex");
    if (actual !== sums.get(n)) throw new Error(`${n} does not match SHA256SUMS`);
  }
}

class NotFound extends Error {}

export interface GhResult {
  exitCode: number;
  stdout: Uint8Array;
  stderr: string;
}
/** Runs `gh <args>`; stdout stays binary so artifact zips survive. */
export type GhRunner = (args: string[]) => Promise<GhResult>;

export const runGh: GhRunner = async (args) => {
  const r = await Bun.$`gh ${args}`.quiet().nothrow();
  return { exitCode: r.exitCode, stdout: new Uint8Array(r.stdout), stderr: r.stderr.toString() };
};

type GitObject = { type: string; sha: string };

/** Every API failure throws; only an explicit HTTP 404 is surfaced as NotFound, never as an empty result. */
export function ghApi(repo: string, run: GhRunner = runGh): ProvenanceApi {
  const call = async (path: string): Promise<GhResult> => {
    const r = await run(["api", path]);
    if (r.exitCode !== 0) {
      if (/HTTP 404/.test(r.stderr)) throw new NotFound(`GitHub API ${path}: not found`);
      throw new Error(`GitHub API ${path} failed: ${r.stderr.trim() || `exit ${r.exitCode}`}`);
    }
    return r;
  };
  const json = async <T>(path: string): Promise<T> => JSON.parse(new TextDecoder().decode((await call(path)).stdout)) as T;
  return {
    async tagCommit(tag) {
      let ref: { object: GitObject };
      try {
        ref = await json(`repos/${repo}/git/ref/tags/${tag}`);
      } catch (e) {
        if (e instanceof NotFound) return null;
        throw e;
      }
      if (ref.object.type === "commit") return ref.object.sha;
      if (ref.object.type !== "tag") throw new Error(`tag ${tag} points at a ${ref.object.type}, not a commit`);
      const annotated = await json<{ object: GitObject }>(`repos/${repo}/git/tags/${ref.object.sha}`);
      if (annotated.object.type !== "commit") throw new Error(`tag ${tag} points at a ${annotated.object.type}, not a commit`);
      return annotated.object.sha;
    },
    async isOnMain(sha) {
      // Resolve refs/heads/main explicitly: the bare name `main` could resolve to a tag of that name.
      const head = await json<{ object: GitObject }>(`repos/${repo}/git/ref/heads/main`);
      if (head.object?.type !== "commit" || !head.object.sha) throw new Error("refs/heads/main does not point at a commit");
      const cmp = await json<{ status?: string }>(`repos/${repo}/compare/${sha}...${head.object.sha}`);
      return cmp.status === "ahead" || cmp.status === "identical";
    },
    async runArtifacts(runId) {
      const body = await json<{ total_count?: number; artifacts?: Array<{ id: number; name: string; expired: boolean; digest: string | null }> }>(`repos/${repo}/actions/runs/${runId}/artifacts?per_page=100`);
      if (!Array.isArray(body.artifacts) || typeof body.total_count !== "number") throw new Error(`GitHub returned no artifact list for run ${runId}`);
      if (body.total_count > body.artifacts.length) throw new Error(`run ${runId} has ${body.total_count} artifacts but only ${body.artifacts.length} were listed`);
      return body.artifacts;
    },
    async downloadArtifactZip(id) {
      return (await call(`repos/${repo}/actions/artifacts/${id}/zip`)).stdout;
    },
    async latestSuccessfulBuildRun(_tag, sha) {
      const runs = await json<{ workflow_runs?: WorkflowRun[] }>(`repos/${repo}/actions/workflows/release-build.yml/runs?event=push&status=success&head_sha=${sha}&per_page=1`);
      if (!Array.isArray(runs.workflow_runs)) throw new Error("GitHub returned no workflow_runs list");
      return runs.workflow_runs[0] ?? null;
    },
  };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args[0] === "--verify-inputs") {
    if (!args[1]) throw new Error("--verify-inputs <dir> requires a directory");
    await verifyReleaseInputs(args[1]);
    process.exit(0);
  }
  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo) throw new Error("GITHUB_REPOSITORY is not set");
  const api = ghApi(repo);
  const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH!, "utf8")) as { workflow_run?: WorkflowRun };
  const tagInput = process.env.TAG_INPUT;
  const run = event.workflow_run ?? (tagInput ? await runForDispatch(tagInput, api) : undefined);
  if (!run) throw new Error("no workflow_run in the event and no TAG_INPUT to resume from");
  const outIdx = args.indexOf("--out");
  const out = outIdx < 0 ? undefined : args[outIdx + 1];
  if (!out) throw new Error("--out <path> is required");
  const p = await checkProvenance(run, repo, api);
  await Bun.write(out, p.zip);
  console.log(`tag=${p.tag}`);
  console.log(`version=${p.version}`);
  console.log(`sha=${p.sha}`);
}
