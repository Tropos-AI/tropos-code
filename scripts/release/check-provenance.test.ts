// scripts/release/check-provenance.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PLATFORMS } from "../../src/install/platform";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import { checkProvenance, runForDispatch, verifyReleaseInputs, type ProvenanceApi, type WorkflowRun } from "./check-provenance";

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
    await expect(verifyReleaseInputs(dir)).rejects.toThrow();
  });

  test("rejects a modified file", async () => {
    await writeFile(join(dir, "tropos-darwin-arm64"), "changed");
    await expect(verifyReleaseInputs(dir)).rejects.toThrow("tropos-darwin-arm64 does not match SHA256SUMS");
  });
});
