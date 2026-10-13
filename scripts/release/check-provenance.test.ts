// scripts/release/check-provenance.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PLATFORMS } from "../../src/install/platform";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import { checkProvenance, ghApi, runForDispatch, verifyReleaseInputs, type GhResult, type GhRunner, type ProvenanceApi, type WorkflowRun } from "./check-provenance";

const REPO = "Tropos-AI/tropos-code";
const SHA = "a".repeat(40);
const zip = new TextEncoder().encode("PK fake zip");
const digest = `sha256:${new Bun.CryptoHasher("sha256").update(zip).digest("hex")}`;

const goodRun = (): WorkflowRun => ({
  id: 7,
  repository: { full_name: REPO },
  head_repository: { full_name: REPO },
  head_branch: "v1.2.3",
  head_sha: SHA,
  path: ".github/workflows/release-build.yml",
  event: "push",
  conclusion: "success",
});

const goodApi = (patch: Partial<ProvenanceApi> = {}): ProvenanceApi => ({
  tagCommit: async () => SHA,
  isOnMain: async () => true,
  runArtifacts: async () => [{ id: 99, name: "release-inputs", expired: false, digest }],
  downloadArtifactZip: async () => zip,
  latestSuccessfulBuildRun: async () => goodRun(),
  ...patch,
});

describe("checkProvenance (R4.2)", () => {
  test("accepts a successful tag build of this repository", async () => {
    expect(await checkProvenance(goodRun(), REPO, goodApi())).toEqual({ tag: "v1.2.3", version: "1.2.3", sha: SHA, runId: 7, zip });
  });

  test.each([
    ["another repository", { repository: { full_name: "evil/fork" } }, "run belongs to evil/fork"],
    ["a fork's head", { head_repository: { full_name: "evil/fork" } }, "head repository is evil/fork"],
    ["a missing head repository", { head_repository: null }, "head repository is unknown"],
    ["another workflow file", { path: ".github/workflows/other.yml" }, "not release-build.yml"],
    ["a pull request event", { event: "pull_request" }, "was triggered by pull_request"],
    ["a failed run", { conclusion: "failure" }, "concluded failure"],
    ["a branch, not a version tag", { head_branch: "main" }, "is not a release tag"],
    ["a malformed tag", { head_branch: "v1.2" }, "is not a release tag"],
  ])("rejects %s", async (_n, patch, message) => {
    await expect(checkProvenance({ ...goodRun(), ...(patch as Partial<WorkflowRun>) }, REPO, goodApi())).rejects.toThrow(message);
  });

  test("rejects a tag that now points at another commit", async () => {
    await expect(checkProvenance(goodRun(), REPO, goodApi({ tagCommit: async () => "b".repeat(40) }))).rejects.toThrow("tag v1.2.3 points at bbbb");
  });

  test("rejects a tag that no longer exists", async () => {
    await expect(checkProvenance(goodRun(), REPO, goodApi({ tagCommit: async () => null }))).rejects.toThrow("tag v1.2.3 points at null");
  });

  test("rejects a commit that is not on main", async () => {
    await expect(checkProvenance(goodRun(), REPO, goodApi({ isOnMain: async () => false }))).rejects.toThrow("is not on main");
  });

  test.each([
    ["no artifact", []],
    ["two artifacts", [{ id: 1, name: "release-inputs", expired: false, digest }, { id: 2, name: "release-inputs", expired: false, digest }]],
    ["an expired artifact", [{ id: 1, name: "release-inputs", expired: true, digest }]],
    ["no digest", [{ id: 1, name: "release-inputs", expired: false, digest: null }]],
  ])("rejects %s", async (_n, artifacts) => {
    await expect(checkProvenance(goodRun(), REPO, goodApi({ runArtifacts: async () => artifacts }))).rejects.toThrow("release-inputs");
  });

  test("rejects a zip whose digest does not match what GitHub recorded (A4)", async () => {
    await expect(checkProvenance(goodRun(), REPO, goodApi({ downloadArtifactZip: async () => new TextEncoder().encode("other") }))).rejects.toThrow("does not match its recorded digest");
  });

  test("propagates API errors instead of accepting", async () => {
    await expect(checkProvenance(goodRun(), REPO, goodApi({ isOnMain: async () => { throw new Error("boom"); } }))).rejects.toThrow("boom");
  });

  test("a dispatched resume finds the latest successful build of the tag's commit", async () => {
    expect((await runForDispatch("v1.2.3", goodApi())).id).toBe(7);
    await expect(runForDispatch("v1.2.3", goodApi({ latestSuccessfulBuildRun: async () => null }))).rejects.toThrow("no successful release-build run");
  });
});

describe("runForDispatch validation", () => {
  test("rejects a non-version tag before touching the API", async () => {
    const api = goodApi({ tagCommit: async () => { throw new Error("api used"); } });
    await expect(runForDispatch("../../main", api)).rejects.toThrow("is not a release tag");
    await expect(runForDispatch("main", api)).rejects.toThrow("is not a release tag");
  });

  test("rejects a run that built another tag", async () => {
    await expect(runForDispatch("v1.2.3", goodApi({ latestSuccessfulBuildRun: async () => ({ ...goodRun(), head_branch: "v9.9.9" }) }))).rejects.toThrow("not v1.2.3");
  });
});

describe("ghApi", () => {
  const ok = (body: unknown): GhResult => ({ exitCode: 0, stdout: new TextEncoder().encode(JSON.stringify(body)), stderr: "" });
  const notFound: GhResult = { exitCode: 1, stdout: new Uint8Array(), stderr: "gh: Not Found (HTTP 404)" };
  const down: GhResult = { exitCode: 1, stdout: new Uint8Array(), stderr: "HTTP 502" };
  const MAIN = "c".repeat(40);
  const routes = (table: Record<string, GhResult>): { run: GhRunner; paths: string[] } => {
    const paths: string[] = [];
    return {
      paths,
      run: async (args) => {
        paths.push(args[1]!);
        const r = table[args[1]!];
        if (!r) throw new Error(`unexpected request ${args[1]}`);
        return r;
      },
    };
  };
  const mainRoutes = (status: unknown) => ({
    [`repos/${REPO}/git/ref/heads/main`]: ok({ object: { type: "commit", sha: MAIN } }),
    [`repos/${REPO}/compare/${SHA}...${MAIN}`]: ok(status === undefined ? {} : { status }),
  });

  test.each([["ahead", true], ["identical", true], ["behind", false], ["diverged", false], [undefined, false]])("isOnMain with status %s is %s", async (status, expected) => {
    const r = routes(mainRoutes(status));
    expect(await ghApi(REPO, r.run).isOnMain(SHA)).toBe(expected);
    expect(r.paths.every((p) => !p.endsWith("...main"))).toBe(true);
  });

  test("isOnMain compares against the resolved heads/main sha, never the bare name", async () => {
    const r = routes(mainRoutes("ahead"));
    await ghApi(REPO, r.run).isOnMain(SHA);
    expect(r.paths).toEqual([`repos/${REPO}/git/ref/heads/main`, `repos/${REPO}/compare/${SHA}...${MAIN}`]);
  });

  test("isOnMain throws when heads/main is missing, unreachable or not a commit", async () => {
    await expect(ghApi(REPO, routes({ [`repos/${REPO}/git/ref/heads/main`]: notFound }).run).isOnMain(SHA)).rejects.toThrow("not found");
    await expect(ghApi(REPO, routes({ [`repos/${REPO}/git/ref/heads/main`]: down }).run).isOnMain(SHA)).rejects.toThrow("failed");
    await expect(ghApi(REPO, routes({ [`repos/${REPO}/git/ref/heads/main`]: ok({ object: { type: "tag", sha: MAIN } }) }).run).isOnMain(SHA)).rejects.toThrow("does not point at a commit");
  });

  test("tagCommit: 404 is null, other errors throw", async () => {
    expect(await ghApi(REPO, routes({ [`repos/${REPO}/git/ref/tags/v1.2.3`]: notFound }).run).tagCommit("v1.2.3")).toBeNull();
    await expect(ghApi(REPO, routes({ [`repos/${REPO}/git/ref/tags/v1.2.3`]: down }).run).tagCommit("v1.2.3")).rejects.toThrow("failed");
  });

  test("tagCommit dereferences annotated tags and rejects non-commits", async () => {
    const t = "d".repeat(40);
    const ref = `repos/${REPO}/git/ref/tags/v1.2.3`;
    expect(await ghApi(REPO, routes({ [ref]: ok({ object: { type: "tag", sha: t } }), [`repos/${REPO}/git/tags/${t}`]: ok({ object: { type: "commit", sha: SHA } }) }).run).tagCommit("v1.2.3")).toBe(SHA);
    await expect(ghApi(REPO, routes({ [ref]: ok({ object: { type: "tag", sha: t } }), [`repos/${REPO}/git/tags/${t}`]: ok({ object: { type: "tree", sha: SHA } }) }).run).tagCommit("v1.2.3")).rejects.toThrow("not a commit");
    await expect(ghApi(REPO, routes({ [ref]: ok({ object: { type: "blob", sha: SHA } }) }).run).tagCommit("v1.2.3")).rejects.toThrow("not a commit");
  });

  test("runArtifacts fails when the listing is truncated or malformed", async () => {
    const p = `repos/${REPO}/actions/runs/7/artifacts?per_page=100`;
    await expect(ghApi(REPO, routes({ [p]: ok({ total_count: 2, artifacts: [{ id: 1, name: "release-inputs", expired: false, digest: null }] }) }).run).runArtifacts(7)).rejects.toThrow("only 1 were listed");
    await expect(ghApi(REPO, routes({ [p]: ok({ artifacts: [] }) }).run).runArtifacts(7)).rejects.toThrow("no artifact list");
    expect(await ghApi(REPO, routes({ [p]: ok({ total_count: 0, artifacts: [] }) }).run).runArtifacts(7)).toEqual([]);
  });

  test("downloadArtifactZip returns raw bytes and throws on failure", async () => {
    const bytes = new Uint8Array([0, 255, 128, 1]);
    const p = `repos/${REPO}/actions/artifacts/99/zip`;
    expect(await ghApi(REPO, routes({ [p]: { exitCode: 0, stdout: bytes, stderr: "" } }).run).downloadArtifactZip(99)).toEqual(bytes);
    await expect(ghApi(REPO, routes({ [p]: down }).run).downloadArtifactZip(99)).rejects.toThrow("failed");
  });
});

describe("verifyReleaseInputs (A4)", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await makeTmpDir();
    const names = ["install.sh", ...PLATFORMS.map((p) => `tropos-${p}`)];
    for (const n of names) await writeFile(join(dir, n), `content of ${n}`);
    await Bun.$`sh -c ${"(sha256sum install.sh tropos-* 2>/dev/null || shasum -a 256 install.sh tropos-*) > SHA256SUMS"}`.cwd(dir).quiet();
  });
  afterEach(() => removeDir(dir));

  test("accepts exactly the expected files with matching sums", async () => {
    await verifyReleaseInputs(dir);
  });

  test("rejects an extra file", async () => {
    await writeFile(join(dir, "extra"), "x");
    await expect(verifyReleaseInputs(dir)).rejects.toThrow("unexpected file extra");
  });

  test("rejects a missing or renamed file", async () => {
    await Bun.$`mv ${join(dir, "tropos-linux-x64")} ${join(dir, "tropos-linux-amd64")}`;
    await expect(verifyReleaseInputs(dir)).rejects.toThrow("unexpected file tropos-linux-amd64");
  });

  test("rejects a symlink standing in for a binary", async () => {
    await Bun.$`rm ${join(dir, "tropos-linux-x64")}`;
    await symlink(join(dir, "install.sh"), join(dir, "tropos-linux-x64"));
    await expect(verifyReleaseInputs(dir)).rejects.toThrow("tropos-linux-x64 in release-inputs is not a regular file");
  });

  test("rejects a directory standing in for a binary", async () => {
    await Bun.$`rm ${join(dir, "tropos-linux-x64")}`;
    await mkdir(join(dir, "tropos-linux-x64"));
    await expect(verifyReleaseInputs(dir)).rejects.toThrow("not a regular file");
  });

  test("rejects duplicate and malformed SHA256SUMS lines", async () => {
    const sums = await readFile(join(dir, "SHA256SUMS"), "utf8");
    await writeFile(join(dir, "SHA256SUMS"), `${sums}${sums.split("\n")[0]}\n`);
    await expect(verifyReleaseInputs(dir)).rejects.toThrow("duplicate SHA256SUMS entry");
    await writeFile(join(dir, "SHA256SUMS"), `${sums}garbage\n`);
    await expect(verifyReleaseInputs(dir)).rejects.toThrow("bad SHA256SUMS line");
  });

  test("rejects a modified file", async () => {
    await writeFile(join(dir, "tropos-darwin-arm64"), "changed");
    await expect(verifyReleaseInputs(dir)).rejects.toThrow("tropos-darwin-arm64 does not match SHA256SUMS");
  });
});
