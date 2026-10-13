# Tropos Code Install and Update System — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a signed, fail-closed native install and update system for `tropos` — `curl | sh` installer, versioned installs behind an atomically switched symlink, `tropos install | update | upgrade | rollback`, background updates, and a gated GitHub Releases pipeline — exactly as specified.

**Architecture:** Pure, dependency-injected TypeScript modules under `src/install/` (formats, trust, network, filesystem engine) are composed by `installer.ts`/`recovery.ts` and exposed through exact-shape CLI subcommands. A POSIX `install.sh` bootstraps trust with `ssh-keygen -Y verify` and hands off to `tropos install --self`. Release tooling (`scripts/release/`) runs only from `main` in a privileged workflow that treats everything from the tag as data.

**Tech Stack:** Bun 1.4 (runtime, `bun test`, `bun build --compile`, `bun:ffi`, `node:zlib` zstd), TypeScript 5.9, zod 4.6, POSIX `sh` + `awk`, OpenSSH `ssh-keygen -Y`, GitHub Actions, `gh` CLI.

**Spec:** `docs/superpowers/specs/2026-10-13-install-update-design.md` at commit `8de9685` (plus the amendments recorded by Task 2). Read the spec section cited by each task before starting it.

## Global Constraints

- Platforms, exactly and in this order: `darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`, `linux-x64-musl`, `linux-arm64-musl`.
- Version regex (no prerelease): `^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$`.
- Signer principal `tropos-release`; namespaces `tropos-manifest` (manifest) and `tropos-installer` (`install.sh`). Never `ssh-keygen -Y check-novalidate`.
- No runtime override of the trusted key set or release URLs (no env var, flag or setting). Tests inject them through function parameters; compiled e2e tests use a build-time test flag that production builds compile out (Task 21).
- Every verification fails closed. There is no checksum-only mode.
- Manifest: canonical bytes only (`JSON.stringify(m, null, 2) + "\n"`, key order as in spec §5.3); sizes 1…1073741824; sha256 `^[0-9a-f]{64}$`; commit `^[0-9a-f]{40}$`; buildDate `^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$`.
- Health check: `<bin> --version` exits 0 with stdout exactly `<v> (Tropos Code)\n` within 10 s, run with the §11 environment allow-list.
- Exit codes: 0 ok · 1 other · 64 usage · 65 integrity · 69 network · 73 local · 75 busy.
- Retries: 3 attempts per URL, backoff 1 s / 2 s / 4 s with ±20 % jitter, 10 s timeout for pointers and manifests.
- Background updates: 6 h throttle; failure backoff `6 h × 2^failures` capped at 48 h; never downgrade; minimal environment (spec §11 list, verbatim).
- Retention: keep current, previous, pending versions, the 3 newest Verified versions, and any version whose `<v>.lock` is held; staging older than 1 h and quarantine older than 7 days are removed (quarantine only under `LOCK_EX`).
- `install.sh`: POSIX `sh`, whole body inside `main()`, no pipeline in which a non-final command's exit status matters, no `head -c`, every download and decompression under `ulimit -f`.
- No new runtime dependencies in `package.json`. Release tooling uses only Bun/Node built-ins, `gh`, `ssh-keygen`, `zstd`, `awk`.
- Style: match the surrounding code — first-line `// src/…` path comment in source files, JSDoc only where the existing code would have it, kebab-case file names, tests next to source (`*.test.ts`) except multi-process/e2e suites under `test/install/`.
- Coverage: every new `src/` file ≥ 80 % lines (`bun run test:coverage`).
- Every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Work on branch `feat/install-update`.

## Review Focus

1. **Ubuntu's `umask 002` makes `~/.local/bin` group-writable (0775) with a user-private group.** A user expects the install to work; a literal "refuse if group-writable" (spec §10.3) would break most Ubuntu installs. Rule implemented: refuse if world-writable or owned by another user; refuse group-writable only when the directory's group is not the user's primary group. Recorded as a spec amendment in Task 2. Test: Task 10 "accepts group-writable dir owned by the user's primary group".
2. **A `HOME` path with spaces** (`/Users/Jane Doe`) — the installer, symlink switch and health check must work. Tests: Task 22 "installs into a HOME containing spaces", Task 16 "installs under a layout path with spaces".
3. **An existing local-build install** (`~/.local/bin/tropos` → `~/.local/share/tropos/versions/0.1.0`, no stored manifest) — the first `install.sh` run replaces the symlink without `--force` and leaves `0.1.0` on disk. Tests: Task 16 "replaces an unmanaged symlink into versions/ without --force", Task 15 "never deletes unmanaged versions".
4. **The system clock moved backwards** so `autoUpdate.nextCheck` lies far in the future — updates must not stop forever. Rule: a `nextCheck` more than 48 h ahead of now counts as due. Test: Task 19 "treats a nextCheck more than 48 h ahead as due".
5. **`tropos update` while offline** — the user expects a clear `network` error (exit 69) quickly, not a multi-minute hang. Bound: with immediate connection failures, total scheduled backoff ≤ 2 × 7 s × 1.2 + fallback ≤ 26 s. Test: Task 9 "gives up within the backoff budget when every request fails".

## Spec Amendments Introduced by This Plan

These refine the approved spec without changing its intent. Task 2 writes them into the spec (together with the spike results) before any engine code exists.

| # | Spec section | Amendment | Reason |
|---|---|---|---|
| A1 | §10.3 pre-switch checks, §4.4 | "Group-writable" is refused only when the directory's gid differs from the user's primary gid; world-writable or foreign-owned is always refused | Review Focus 1 |
| A2 | §12.2 rule 1 | `--` as `argv[0]` skips subcommand recognition and passes `argv` **unchanged** to the existing parser (which already treats `--` as end-of-options). "Drop it" would turn `tropos -- -p` into a flag | Compatibility |
| A3 | §4.2, §13 | Compiled-binary e2e tests use a **build-time** `TROPOS_TEST_BUILD` flag (test keys and test release base URL); production builds define it `false`, so the code path is removed; a test asserts the production binary contains no test hooks | Compiled tests need test keys without a runtime override |
| A4 | §7.3 step 1 | `prepare` downloads `release-inputs` as a zip through the REST API, checks its SHA-256 against the artifact's GitHub-recorded `digest`, then checks every file against `SHA256SUMS` written by `release-build` | Artifact integrity without third-party actions (user requirement) |
| A5 | §6, §13 | `release/allowed_signers` ships **empty** until the key ceremony (Task 29); with no trusted key every verification fails closed and the release workflow refuses to run | No placeholder key can ever be trusted |
| A6 | §10.1 | `flock` is only ever called with `LOCK_NB`; waiting is a poll loop with sleeps, so the FFI call never blocks the event loop | Bun FFI calls are synchronous |
| A7 | §5.4, §7 (conditional) | If release immutability is (or will be) enabled for `Tropos-AI/tropos-code`, decision **D1-B** applies (Task 2) | Immutable releases lock published assets |
| A8 | §11 environment | The allow-list also passes `TROPOS_HOME`, so the background updater reads the same trusted settings as the session that started it | Not a credential; without it a custom `TROPOS_HOME` would be ignored |
| A9 | §10.3 step 3 | An existing `versions/<v>` that has no stored manifest (a local build) and does not match the signed hash is renamed to `versions/.unmanaged-<v>-<ts>` and never deleted, instead of being quarantined as `.corrupt-*` | Unmanaged files are never deleted (spec §9) |
| A10 | §10.3 step 5 | The signed manifest is stored **before** the binary is renamed into `versions/<v>`, so a crash between the two leaves a manifest without a binary (cleaned up) rather than an unmanaged binary | Crash consistency |
| A11 | §10.6 "No Healthy candidate" | Recovery reports the fatal condition to the command: `rollback` and background updates fail with it; `install`/`update` print it and continue, because installing a verified version is the fix | Avoids blocking the repair path |
| A12 | §7.3 steps 3–6 | A `fetch-draft` job (holds `contents: write`, executes nothing) downloads the draft's assets with an authenticated `gh release download` and passes them to the read-only smoke jobs as a workflow artifact | Drafts are visible only with push access, and no job with a write token may run tag code |

## File Structure

```
src/install/
  version.ts          isVersion, compareVersions, VERSION_RE
  errors.ts           InstallError, kinds, EXIT_CODES, exitCodeFor, fromFsError
  platform.ts         PLATFORMS, Platform, platformFromProbe, probeHost, detectPlatform
  sshsig.ts           parseAllowedSigners, verifySshSig (SSHSIG + ed25519 via node:crypto)
  trust.ts            SIGNER_PRINCIPAL, NAMESPACE_*, TRUSTED_KEYS (from release/allowed_signers)
  build-flags.ts      IS_TEST_BUILD, test-only base URL / trust hooks (compiled out in production)
  manifest.ts         Manifest types, serializeManifest, parseManifest, verifyManifest
  fetch.ts            fetchBytes, downloadToFile (bounded, HTTPS-only, hashing)
  decompress.ts       decompressZstdFile (bounded, exact-size, decoder errors)
  urls.ts             ReleaseUrls, githubReleaseUrls, RELEASE_URLS
  remote.ts           withRetries, backoffDelays, fetchVerifiedManifest
  channels.ts         Channel, resolveChannel
  layout.ts           Layout, resolveLayout, path helpers, ensureLayout, checkSafeDir, nativeVersionOf
  env.ts              ENV_ALLOW_LIST, minimalEnv
  flock.ts            loadFlock, LOCK_* constants
  locks.ts            acquireInstallLock, tryLockVersionExclusive, lockVersionShared
  state.ts            InstallState, readState, writeState, EMPTY_STATE
  files.ts            sha256File, fsyncDir, writeFileAtomic
  verify.ts           storeManifest, readStoredManifest, isVerified, healthCheck, isHealthy, listVersions
  link.ts             readLink, switchLink, removeOurLink
  engine.ts           EngineDeps, CrashPoint, withInstallLock
  installer.ts        installVersion, installTarget, installSelf
  cleanup.ts          cleanup
  recovery.ts         recover, selectFallback
  rollback.ts         rollback
  autoupdate.ts       shouldCheck, nextCheckAfter, spawnBackgroundUpdate, runBackgroundUpdate, announcement
  session.ts          startNativeSession (in-use lock, re-exec check, announcement, auto-update spawn)
  commands.ts         InstallCommand, runInstallCommand, notices
src/types/text-imports.d.ts      declare module for `*allowed_signers` text import
src/cli/args.ts                  + parseInvocation (exact-shape subcommands)
src/cli/usage.ts                 + Commands block, per-command help texts
src/cli/main.tsx                 dispatch subcommands; native session hooks
src/config/settings.ts           + autoUpdates, autoUpdatesChannel (trusted layers only)
release/allowed_signers          pinned keys (empty until Task 28)
install.sh                       public installer (replaces the local-build script)
scripts/install-local.sh         the former install.sh
scripts/release/
  make-manifest.sh  manifest.awk  promote.ts  github.ts  check-provenance.ts  pin-actions.ts
.github/workflows/
  release-build.yml  release.yml  promote.yml  channels-health.yml  ci.yml (modified)
build.ts                         + musl targets, --test-build flags
docs/install.md                  install, verify-first route, key ceremony, recovery from key compromise
test/helpers/cli-cases.ts        the CLI compatibility case table
test/install/helpers/            keys.ts, release-server.ts, fixture-release.ts, sh-runner.ts, crash-child.ts, hold-lock.ts
test/install/*.test.ts           multi-process, crash, install.sh, parity, policy and e2e suites
```

## Milestones

| Milestone | Tasks | Independently verifiable outcome |
|---|---|---|
| M0 Baseline and infrastructure | 1–2 | CLI snapshot locked on unchanged code; spike results + decisions D1–D6 recorded; spec amended |
| M1 Trust and release formats | 3–7 | `bun test src/install` passes: versions, errors, platform, SSHSIG, manifest; `make-manifest.sh` and `manifest.awk` agree with TS |
| M2 Network layer | 8–9 | Bounded downloads, zstd validation corpus, channel resolution with slots and fallback, all against a local server |
| M3 Local engine | 10–17 | Install / switch / health / cleanup / recovery / rollback on a temp `HOME`, including multi-process locking and SIGKILL crash suites |
| M4 CLI integration | 18–21 | `tropos install|update|upgrade|rollback` in dev and compiled binaries; snapshot unchanged; background updates |
| M5 Installer | 22–24 | `install.sh` passes the happy path, the negative security suite under four shells, and parity with TS |
| M6 Release pipeline | 25–28 | Musl builds, convergent `promote.ts`, provenance checks, workflows with a passing policy test, 6-platform CI |
| M7 Ceremony and end-to-end | 29–30 | Docs, real pinned key, full compiled e2e on 6 platforms, release dry run in a scratch repository |

Each milestone ends green on `bun run typecheck && bun test` (M6–M7 also on the CI matrix). Do not start a milestone until the previous one is green.

---

## M0 — Baseline and infrastructure

### Task 1: Lock today's CLI parsing with a snapshot

Spec: §12.2, §13 layer 6. This task changes **no** source file; it records `parseCli` behaviour before any change.

**Files:**
- Create: `test/helpers/cli-cases.ts`
- Create: `src/cli/args.snapshot.test.ts`
- Create (generated): `src/cli/__snapshots__/args.snapshot.test.ts.snap`

**Interfaces:**
- Produces: `CLI_CASES: readonly CliCase[]`, `interface CliCase { argv: string[]; note: string }`, `parseOutcome(argv): { ok: true; options: CliOptions } | { ok: false; error: string }` — used again by Task 18.

- [ ] **Step 1: Write the case table**

```ts
// test/helpers/cli-cases.ts
import { CliError, parseCli, type CliOptions } from "../../src/cli/args";

export interface CliCase {
  argv: string[];
  note: string;
}

const ID = "3f2b8c1e-9a4d-4e2f-8b1c-0d9e8f7a6b5c";

/** Every invocation shape we promise to keep (spec §12.2). Never remove a case; only add. */
export const CLI_CASES: readonly CliCase[] = [
  { argv: [], note: "no arguments" },
  { argv: ["hello"], note: "one-word prompt" },
  { argv: ["hello", "world"], note: "multi-word prompt" },
  { argv: ["-p", "x"], note: "print short" },
  { argv: ["--print", "x"], note: "print long" },
  { argv: ["-p", "x", "--output-format", "json"], note: "json output" },
  { argv: ["-p", "x", "--output-format", "stream-json"], note: "stream-json output" },
  { argv: ["--output-format", "xml"], note: "bad output format" },
  { argv: ["--max-turns", "3", "-p", "x"], note: "max turns" },
  { argv: ["--max-turns", "0"], note: "max turns zero" },
  { argv: ["--max-turns", "1.5"], note: "max turns fractional" },
  { argv: ["--allowed-tools", "Read,Bash(git diff:*)"], note: "allowed tools" },
  { argv: ["--allowed-tools", "A", "--allowed-tools", "B"], note: "allowed tools repeated" },
  { argv: ["--model", "claude-sonnet-5-5"], note: "model" },
  { argv: ["--model", "deepseek/deepseek-flash"], note: "provider model" },
  { argv: ["--effort", "max"], note: "effort" },
  { argv: ["--effort", "huge"], note: "bad effort" },
  { argv: ["-c"], note: "continue short" },
  { argv: ["--continue"], note: "continue long" },
  { argv: ["-r"], note: "resume picker" },
  { argv: ["--resume"], note: "resume picker long" },
  { argv: ["-r", ID], note: "resume id" },
  { argv: ["--resume", ID, "fix", "it"], note: "resume id with prompt" },
  { argv: ["-r", "not-a-uuid"], note: "resume with non-uuid word" },
  { argv: ["-c", "-r"], note: "continue and resume" },
  { argv: ["--permission-mode", "plan"], note: "permission mode" },
  { argv: ["--permission-mode", "bypass"], note: "bypass mode rejected" },
  { argv: ["--permission-mode", "nope"], note: "bad permission mode" },
  { argv: ["--dangerously-skip-permissions"], note: "skip permissions" },
  { argv: ["--add-dir", "../x", "--add-dir", "/y"], note: "add dirs" },
  { argv: ["-h"], note: "help short" },
  { argv: ["--help"], note: "help long" },
  { argv: ["-v"], note: "version short" },
  { argv: ["--version"], note: "version long" },
  { argv: ["--bogus"], note: "unknown long flag" },
  { argv: ["-x"], note: "unknown short flag" },
  { argv: ["--", "-p"], note: "double dash then flag-like word" },
  { argv: ["--", "install"], note: "double dash then subcommand word" },
  { argv: ["install"], note: "bare install (becomes a subcommand)" },
  { argv: ["install", "stable"], note: "install channel (becomes a subcommand)" },
  { argv: ["install", "latest", "--force"], note: "install latest force (becomes a subcommand)" },
  { argv: ["install", "1.2.3"], note: "install version (becomes a subcommand)" },
  { argv: ["install", "--force"], note: "install force (becomes a subcommand)" },
  { argv: ["install", "--help"], note: "install help (becomes a subcommand)" },
  { argv: ["install", "--self", "--manifest", "m", "--signature", "s"], note: "install self (becomes a subcommand)" },
  { argv: ["update"], note: "bare update (becomes a subcommand)" },
  { argv: ["update", "-h"], note: "update help (becomes a subcommand)" },
  { argv: ["update", "--background"], note: "background update (becomes a subcommand)" },
  { argv: ["upgrade"], note: "bare upgrade (becomes a subcommand)" },
  { argv: ["rollback"], note: "bare rollback (becomes a subcommand)" },
  { argv: ["update", "the", "readme"], note: "prompt starting with update" },
  { argv: ["update", "-p"], note: "print mode with prompt update" },
  { argv: ["-p", "install"], note: "print mode with prompt install" },
  { argv: ["install", "foo"], note: "prompt install foo" },
  { argv: ["install", "1.2"], note: "prompt install 1.2 (not a version)" },
  { argv: ["install", "stable", "now"], note: "prompt install stable now" },
  { argv: ["rollback", "now"], note: "prompt rollback now" },
  { argv: ["install", "--force", "--bogus"], note: "subcommand word with unknown flag" },
  { argv: ["update", "--background", "-p"], note: "update background with print" },
];

export type ParseOutcome = { ok: true; options: CliOptions } | { ok: false; error: string };

export function parseOutcome(argv: string[]): ParseOutcome {
  try {
    return { ok: true, options: parseCli(argv) };
  } catch (e) {
    if (e instanceof CliError) return { ok: false, error: e.message };
    throw e;
  }
}
```

- [ ] **Step 2: Write the snapshot test**

```ts
// src/cli/args.snapshot.test.ts
import { describe, expect, test } from "bun:test";
import { CLI_CASES, parseOutcome } from "../../test/helpers/cli-cases";

// Records parseCli exactly as it behaved before the install subcommands existed (spec §12.2).
// The .snap file is committed and must never be regenerated by later tasks.
describe("parseCli compatibility snapshot", () => {
  for (const c of CLI_CASES) {
    test(`${JSON.stringify(c.argv)} — ${c.note}`, () => {
      expect(parseOutcome(c.argv)).toMatchSnapshot();
    });
  }
});
```

- [ ] **Step 3: Record the snapshot on unchanged code**

Run: `git stash list && git status --short src/cli` (expected: no modified files under `src/cli`), then `bun test src/cli/args.snapshot.test.ts`
Expected: PASS, `snapshots: 59 added` (one per case), file `src/cli/__snapshots__/args.snapshot.test.ts.snap` created.

- [ ] **Step 4: Prove the snapshot is enforced**

Run: `bun test src/cli/args.snapshot.test.ts` again — expected PASS with `0 added`. Then edit `src/cli/__snapshots__/args.snapshot.test.ts.snap`, change the first `"outputFormat": "text"` to `"outputFormat": "json"`, run the test again and expect FAIL (`Snapshot ... mismatched`), then restore the file with `git checkout -- src/cli/__snapshots__/args.snapshot.test.ts.snap` (if not yet committed: undo the edit by hand) and re-run to PASS.

- [ ] **Step 5: Run the full suite and typecheck**

Run: `bun run typecheck && bun test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add test/helpers/cli-cases.ts src/cli/args.snapshot.test.ts src/cli/__snapshots__/args.snapshot.test.ts.snap
git commit -m "test(cli): snapshot parseCli for every invocation we keep compatible

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 2: Six-platform and GitHub infrastructure spike, decisions D1–D6, spec amendments

Spec: §16, plus the two checks added at approval: release immutability and `workflow_run` provenance. Output is **knowledge**, not product code: a results document, recorded decisions, and spec amendments. The spike workflow and probe scripts are deleted at the end of the task.

**Owner checkpoints:** Steps 6–9 push a branch, run CI, create a scratch repository and change repository settings. These are outward-facing; do them only with the owner's explicit go-ahead. `gh` must be authenticated (`! gh auth login`; the local token currently returns "Bad credentials").

**Files:**
- Create: `scripts/spike/flock-probe.ts`
- Create: `scripts/spike/shell-probe.sh`
- Create: `scripts/spike/github-probe.sh`
- Create: `.github/workflows/spike.yml`
- Create: `docs/superpowers/specs/2026-10-13-install-update-spike-results.md`
- Modify: `docs/superpowers/specs/2026-10-13-install-update-design.md` (amendments A1–A7, decisions)
- Delete at the end: `scripts/spike/`, `.github/workflows/spike.yml`

**Interfaces:**
- Produces decisions consumed by later tasks:
  - D1 release immutability → urls and promotion target (Tasks 9, 26, 28)
  - D2 Bun inside Alpine → CI and release jobs (Tasks 28, 30)
  - D3 `ssh-keygen -Y` support probe string → `install.sh` (Task 22)
  - D4 `ulimit -f` block unit per shell → `install.sh` limit formula (Task 22)
  - D5 libc library names for `flock` → `flock.ts` (Task 11)
  - D6 first-release "latest" behaviour and `--clobber` gap → `promote.ts` and `install.sh` messages (Tasks 22, 26)
  - P1 `workflow_run` payload fields and artifact digests → `check-provenance.ts` (Task 27)
  - P2 draft visibility to a read-only token → the `fetch-draft` job (Task 28, amendment A12)

- [ ] **Step 1: Write the flock probe**

```ts
// scripts/spike/flock-probe.ts
// Spike only (deleted at the end of Task 2): checks flock(2) through bun:ffi on this platform.
import { dlopen, FFIType } from "bun:ffi";
import { closeSync, constants, openSync } from "node:fs";

const candidates =
  process.platform === "darwin"
    ? ["libSystem.B.dylib"]
    : ["libc.so.6", `/lib/ld-musl-${process.arch === "arm64" ? "aarch64" : "x86_64"}.so.1`, "libc.so"];

const LOCK_SH = 1, LOCK_EX = 2, LOCK_NB = 4;
let loaded: { name: string; flock: (fd: number, op: number) => number } | undefined;
const tried: Record<string, string> = {};
for (const name of candidates) {
  try {
    const lib = dlopen(name, { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } });
    loaded = { name, flock: lib.symbols.flock as (fd: number, op: number) => number };
    break;
  } catch (e) {
    tried[name] = (e as Error).message;
  }
}
const path = process.argv[2] ?? "spike.lock";
const role = process.argv[3] ?? "report";
if (!loaded) {
  console.log(JSON.stringify({ ok: false, tried }));
  process.exit(1);
}
const fd = openSync(path, constants.O_RDWR | constants.O_CREAT, 0o600);
if (role === "hold-ex") {
  console.log(JSON.stringify({ role, rc: loaded.flock(fd, LOCK_EX | LOCK_NB) }));
  await Bun.sleep(Number(process.argv[4] ?? 3000));
} else if (role === "hold-sh") {
  console.log(JSON.stringify({ role, rc: loaded.flock(fd, LOCK_SH | LOCK_NB) }));
  await Bun.sleep(Number(process.argv[4] ?? 3000));
} else {
  const ex = loaded.flock(fd, LOCK_EX | LOCK_NB);
  console.log(JSON.stringify({ ok: true, lib: loaded.name, tried, exNb: ex, platform: process.platform, arch: process.arch }));
}
closeSync(fd);
```

- [ ] **Step 2: Write the shell probe**

```sh
#!/bin/sh
# scripts/spike/shell-probe.sh — spike only (deleted at the end of Task 2).
# Prints facts install.sh depends on, for every shell present.
set -u
work=$(mktemp -d) || exit 1
echo "== uname: $(uname -s) $(uname -m)"
echo "== musl loader: $(ls /lib/ld-musl-*.so.1 2>/dev/null || echo none)"
echo "== ldd /bin/sh: $(ldd /bin/sh 2>&1 | head -n 3 | tr '\n' ' ')"
echo "== curl: $(curl --version 2>/dev/null | head -n 1 || echo none)"
echo "== wget: $(wget --version 2>&1 | head -n 1 || echo none)"
echo "== wget --https-only: $(wget --help 2>&1 | grep -c https-only)"
echo "== sha256sum: $(command -v sha256sum || echo none); shasum: $(command -v shasum || echo none)"
echo "== ssh-keygen: $(command -v ssh-keygen || echo none) $(ssh -V 2>&1)"
echo "== ssh-keygen -Y (no op) output:"; ssh-keygen -Y 2>&1 | head -n 5
echo "== ssh-keygen -Y verify (no args) output:"; ssh-keygen -Y verify 2>&1 | head -n 5
echo "== zstd: $(zstd --version 2>/dev/null || echo none)"
for sh in sh dash bash "busybox ash" zsh; do
  set -- $sh
  command -v "$1" >/dev/null 2>&1 || { echo "== shell $sh: absent"; continue; }
  # Write 8 KiB under a 4-block limit; the byte count shows the unit (512 → 2048, 1024 → 4096).
  out=$($sh -c 'cd "$1" && rm -f f && ( ulimit -f 4; dd if=/dev/zero of=f bs=1024 count=8 2>/dev/null ); echo "rc=$? bytes=$(wc -c < f | tr -d " ")"' _ "$work" 2>&1)
  echo "== shell $sh: ulimit -f 4 → $out"
done
if command -v zstd >/dev/null 2>&1; then
  cd "$work" || exit 1
  dd if=/dev/urandom of=raw bs=1024 count=64 2>/dev/null
  zstd -q -19 --check -o good.zst raw
  size=$(wc -c < good.zst | tr -d ' ')
  dd if=good.zst of=trunc.zst bs=1 count=$((size - 7)) 2>/dev/null
  cp good.zst trailing.zst && printf 'garbage' >> trailing.zst
  cat good.zst good.zst > double.zst
  cp good.zst flipped.zst && printf '\377' | dd of=flipped.zst bs=1 seek=$((size - 2)) conv=notrunc 2>/dev/null
  printf 'not zstd at all' > notzstd.zst
  : > empty.zst
  for f in good trunc trailing double flipped notzstd empty; do
    zstd -d -q -c -- "$f.zst" > "$f.out" 2>/dev/null
    echo "== zstd -d $f: rc=$? bytes=$(wc -c < "$f.out" | tr -d ' ')"
  done
fi
echo "== tail -c 1 / od: $(printf 'ab\n' | tail -c 1 | od -An -c | tr -d ' ')"
rm -rf "$work"
```

- [ ] **Step 3: Write the spike workflow**

```yaml
# .github/workflows/spike.yml — spike only (deleted at the end of Task 2)
name: spike
on:
  workflow_dispatch:
  push:
    branches: [spike/install-infra]
permissions:
  contents: read
jobs:
  native:
    strategy:
      fail-fast: false
      matrix:
        os: [macos-15, macos-15-intel, ubuntu-24.04, ubuntu-24.04-arm]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v5
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: 1.4.0
      - run: sh scripts/spike/shell-probe.sh
      - run: bun scripts/spike/flock-probe.ts "$RUNNER_TEMP/a.lock"
      - name: flock contention across processes
        run: |
          bun scripts/spike/flock-probe.ts "$RUNNER_TEMP/b.lock" hold-ex 4000 & sleep 1
          bun scripts/spike/flock-probe.ts "$RUNNER_TEMP/b.lock"   # expect exNb -1
          wait
          bun scripts/spike/flock-probe.ts "$RUNNER_TEMP/b.lock"   # expect exNb 0
      - name: flock from a compiled binary
        run: |
          bun build scripts/spike/flock-probe.ts --compile --outfile "$RUNNER_TEMP/probe"
          "$RUNNER_TEMP/probe" "$RUNNER_TEMP/c.lock"
  alpine:
    strategy:
      fail-fast: false
      matrix:
        include:
          - { runner: ubuntu-24.04, bunzip: bun-linux-x64-musl }
          - { runner: ubuntu-24.04-arm, bunzip: bun-linux-aarch64-musl }
    runs-on: ${{ matrix.runner }}
    container: alpine:3.22
    steps:
      - run: apk add --no-cache git openssh-keygen zstd curl unzip libstdc++ libgcc
      - uses: actions/checkout@v5
      - name: setup-bun inside Alpine (record whether it works)
        id: setupbun
        continue-on-error: true
        uses: oven-sh/setup-bun@v2
        with:
          bun-version: 1.4.0
      - name: Bun musl build fallback
        if: steps.setupbun.outcome != 'success'
        run: |
          curl -fsSLo bun.zip "https://github.com/oven-sh/bun/releases/download/bun-v1.4.0/${{ matrix.bunzip }}.zip"
          unzip -q bun.zip && install -m 0755 ${{ matrix.bunzip }}/bun /usr/local/bin/bun
      - run: bun --version
      - run: sh scripts/spike/shell-probe.sh
      - run: bun scripts/spike/flock-probe.ts /tmp/a.lock
      - run: |
          bun build scripts/spike/flock-probe.ts --compile --outfile /tmp/probe
          /tmp/probe /tmp/c.lock
```

- [ ] **Step 4: Write the GitHub probe (run by the owner against a scratch repository)**

```sh
#!/bin/sh
# scripts/spike/github-probe.sh <scratch-owner/repo> — spike only (deleted at the end of Task 2).
# Requires: gh authenticated with admin rights on the scratch repo; the scratch repo exists and is public.
set -eu
repo=$1
main=Tropos-AI/tropos-code
work=$(mktemp -d)
cd "$work"
say() { printf '\n== %s\n' "$*"; }

say "D1a immutability status of $main (repository endpoint)"
gh api -i "repos/$main/immutable-releases" 2>&1 | sed -n '1p;/^{/p' || true
say "D1a immutability policy of the organization"
gh api -i "orgs/${main%%/*}/settings/immutable-releases" 2>&1 | sed -n '1p;/^{/p' || true

say "D6a first release published with --latest=false: what is latest?"
echo 1 > a.txt
gh release create v0.0.1 a.txt --repo "$repo" --draft --title v0.0.1 --notes spike
gh release edit v0.0.1 --repo "$repo" --draft=false --latest=false
gh api -i "repos/$repo/releases/latest" 2>&1 | sed -n '1p;/"tag_name"/p' || true
curl -sS -o /dev/null -w 'releases/latest/download/a.txt → %{http_code}\n' -L "https://github.com/$repo/releases/latest/download/a.txt"

say "D6b --clobber gap: poll the asset while it is replaced"
gh release create channels --repo "$repo" --prerelease --latest=false --title channels --notes spike
echo 1.0.0 > latest
gh release upload channels latest --repo "$repo"
( i=0; while [ $i -lt 120 ]; do curl -sS -o /dev/null -w '%{http_code} ' -L "https://github.com/$repo/releases/download/channels/latest"; i=$((i+1)); sleep 0.25; done; echo ) > poll.txt &
sleep 2; echo 1.0.1 > latest; gh release upload channels latest --repo "$repo" --clobber; wait
tr ' ' '\n' < poll.txt | sort | uniq -c

say "D1b with immutability ON (enable it in the scratch repo's settings now, then press enter)"
read -r _
echo 2 > b.txt
gh release create v0.0.2 a.txt --repo "$repo" --draft --title v0.0.2 --notes spike
gh release edit v0.0.2 --repo "$repo" --draft=false --latest=false
echo "upload a NEW asset to the published immutable release:"; gh release upload v0.0.2 b.txt --repo "$repo" && echo ALLOWED || echo REFUSED
echo "clobber an existing asset:"; gh release upload v0.0.2 a.txt --repo "$repo" --clobber && echo ALLOWED || echo REFUSED
echo "mark as latest:"; gh release edit v0.0.2 --repo "$repo" --latest && echo ALLOWED || echo REFUSED
echo "create + clobber a prerelease created after enabling:"
gh release create channels2 --repo "$repo" --prerelease --latest=false --title channels2 --notes spike
gh release upload channels2 latest --repo "$repo" && echo "upload after publish: ALLOWED" || echo "upload after publish: REFUSED"
gh release upload channels2 latest --repo "$repo" --clobber && echo "clobber: ALLOWED" || echo "clobber: REFUSED"
gh api "repos/$repo/attestations?per_page=1" >/dev/null 2>&1 && echo "attestations endpoint reachable" || true
rm -rf "$work"
```

The `workflow_run` probe needs two workflow files in the scratch repository. Create them there (not in this repo):

```yaml
# scratch repo: .github/workflows/build.yml
name: build
on: { push: { tags: ["v*"] } }
permissions: { contents: read }
jobs:
  build:
    runs-on: ubuntu-24.04
    steps:
      - run: mkdir out && echo hello > out/file.txt && (cd out && sha256sum file.txt > SHA256SUMS)
      - uses: actions/upload-artifact@v4
        with: { name: release-inputs, path: out/ }
```

```yaml
# scratch repo: .github/workflows/consume.yml
name: consume
on:
  workflow_run:
    workflows: [build]
    types: [completed]
permissions: { contents: read, actions: read }
jobs:
  inspect:
    runs-on: ubuntu-24.04
    environment: spike-main-only   # create it with "Deployment branches: main" only
    steps:
      - env:
          GH_TOKEN: ${{ github.token }}
          RUN_ID: ${{ github.event.workflow_run.id }}
        run: |
          jq '{repository: .workflow_run.repository.full_name, head_repository: .workflow_run.head_repository.full_name,
               head_branch: .workflow_run.head_branch, head_sha: .workflow_run.head_sha, path: .workflow_run.path,
               event: .workflow_run.event, conclusion: .workflow_run.conclusion, ref: env.GITHUB_REF, sha: env.GITHUB_SHA}' "$GITHUB_EVENT_PATH"
          gh api "repos/$GITHUB_REPOSITORY/actions/runs/$RUN_ID/artifacts" --jq '.artifacts[] | {id, name, expired, digest, size_in_bytes}'
          id=$(gh api "repos/$GITHUB_REPOSITORY/actions/runs/$RUN_ID/artifacts" --jq '.artifacts[0].id')
          gh api "repos/$GITHUB_REPOSITORY/actions/artifacts/$id/zip" > a.zip
          echo "zip sha256: $(sha256sum a.zip | cut -d' ' -f1)"
          # P2: is a draft visible to this read-only token? (create draft v0.0.0-draft in the repo first)
          gh api "repos/$GITHUB_REPOSITORY/releases?per_page=100" --jq '[.[] | select(.draft)] | length'
```

- [ ] **Step 5: Commit the spike files**

```bash
git add scripts/spike .github/workflows/spike.yml
git commit -m "chore(spike): probes for flock, shells, zstd, ssh-keygen and GitHub release behaviour

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 6 (owner checkpoint): Run the platform spike**

Run: `git push origin HEAD:spike/install-infra` then `gh run watch` on the `spike` run.
Expected: all six jobs finish. Copy each job's probe output into the results document (Step 10). A failing job is a result, not a blocker — record it.

- [ ] **Step 7 (owner checkpoint): Run the GitHub probe**

Create a public scratch repository (e.g. `Tropos-AI/tropos-release-spike`), then run: `sh scripts/spike/github-probe.sh Tropos-AI/tropos-release-spike` and follow its prompt to enable release immutability in the scratch repository when asked.
Expected: output for D1a, D1b, D6a, D6b.

- [ ] **Step 8 (owner checkpoint): Run the workflow_run probe**

In the scratch repository add `build.yml` and `consume.yml` above, create the `spike-main-only` environment restricted to `main`, push a tag `v0.0.3`.
Expected: `consume` runs (proving a `main`-restricted environment accepts `workflow_run` jobs) and prints `repository`, `head_repository`, `head_branch` = `v0.0.3`, `head_sha`, `path` = `.github/workflows/build.yml`, `event` = `push`, `conclusion` = `success`, the artifact's `digest` (`sha256:…`), and the zip's sha256. Record whether `digest` equals `sha256:` + the zip's sha256.

- [ ] **Step 9 (owner checkpoint): Record the main repository's immutability intent**

Ask the owner: "Will release immutability be enabled for `Tropos-AI/tropos-code` (now or later)?" Record the answer as D1.

- [ ] **Step 10: Write the results and decisions**

Create `docs/superpowers/specs/2026-10-13-install-update-spike-results.md` with one section per probe (raw output pasted in fenced blocks) and this decision table, filled in from the evidence:

```markdown
| ID | Question | Evidence | Decision |
|---|---|---|---|
| D1 | Release immutability on Tropos-AI/tropos-code? Published assets mutable? | D1a, D1b, owner answer | D1-A or D1-B (below) |
| D2 | How Bun runs in Alpine containers | alpine job: setup-bun outcome | "setup-bun" or "musl zip" |
| D3 | How install.sh detects an ssh-keygen without -Y | `ssh-keygen -Y` outputs per runner | the `case` patterns to use |
| D4 | ulimit -f unit per shell | rc/bytes per shell | formula stays ⌊size/512⌋+2 if every shell enforces ≤ 1024-byte units |
| D5 | flock library per libc | flock-probe lib per job | ordered candidate list for flock.ts |
| D6 | First release with --latest=false: GitHub latest? --clobber gap length | D6a, D6b | install.sh first-release message; promote read-back retry budget (≥ 2 × the observed gap) |
| P1 | workflow_run payload fields and artifact digest | Step 8 output | fields check-provenance.ts relies on (Task 27) |
| P2 | Can a `contents: read` token see a draft release? | Step 8 output | expected "no": confirms the fetch-draft design (A12) |
```

**D1-A (immutability off, and the owner does not intend to enable it):** the spec stands.

**D1-B (immutability on or intended) — the design adjustment, to be written into the spec before Task 9:**
- Version releases in `Tropos-AI/tropos-code` become immutable: every asset (§5.2 minus `verified.json`) is attached to the draft, then the release is published once. The automatically generated release attestation is kept and documented in `docs/install.md` as an extra verification route.
- All mutable state moves to a separate repository, `Tropos-AI/tropos-code-channels`, excluded from the organization's immutability policy: its `channels` release holds `latest`, `latest.bak`, `stable`, `stable.bak` and `verified-<x>.json` records (replacing the per-version `verified.json`).
- `urls.ts` gets a separate channels base (`https://github.com/Tropos-AI/tropos-code-channels/releases/download/channels/<name>`); everything else keeps its URL.
- `promote.ts` writes slots and verification records through a GitHub client bound to the channels repository, using a fine-grained token with `contents: write` on that repository only, stored as secret `CHANNELS_WRITE_TOKEN` in a `channels-write` environment restricted to `main`. Marking GitHub latest still targets the main repository (the latest flag stays editable on immutable releases).
- Invariants §7.6 read "has a verification record" instead of "has `verified.json`".

Code in Tasks 9, 26 and 28 is written so that D1-B changes only `urls.ts`'s channel base, `promote.ts`'s `GitHubClient` binding for channel/verification operations, and the workflow's token for the promote job.

- [ ] **Step 11: Amend the spec**

Edit `docs/superpowers/specs/2026-10-13-install-update-design.md`: apply A1–A6 and A8–A12 in the cited sections, apply A7/D1-B if chosen, replace §16's "confirmed in the first plan task" items with the recorded answers and a link to the results document, and add "Revision 3" to Appendix B listing A1–A12, D1–D6 and P1–P2.

- [ ] **Step 12: Remove the spike code and commit**

```bash
git rm -r scripts/spike .github/workflows/spike.yml
git add docs/superpowers/specs/2026-10-13-install-update-spike-results.md docs/superpowers/specs/2026-10-13-install-update-design.md
git commit -m "docs(spec): record infrastructure spike results and decisions D1-D6

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 13 (owner checkpoint): Decision gate**

Present the decision table and spec diff to the owner. Do not start Task 3 until the owner approves the amended spec. If D1-B is chosen, the owner also creates `Tropos-AI/tropos-code-channels` and excludes it from the immutability policy before Task 26.

---

## M1 — Trust and release formats

### Task 3: Versions and install errors

Spec: §5.3 (version rule), §10.8 (error kinds and exit codes).

**Files:**
- Create: `src/install/version.ts`, `src/install/version.test.ts`
- Create: `src/install/errors.ts`, `src/install/errors.test.ts`

**Interfaces:**
- Produces: `VERSION_RE: RegExp`, `isVersion(value: unknown): value is string`, `compareVersions(a: string, b: string): number`, `newestFirst(versions: string[]): string[]`
- Produces: `type InstallErrorKind = "usage" | "integrity" | "network" | "local" | "busy"`, `class InstallError extends Error { kind }`, `EXIT_CODES`, `exitCodeFor(e: unknown): number`, `fromFsError(e: unknown, action: string): unknown`

- [ ] **Step 1: Write the failing tests**

```ts
// src/install/version.test.ts
import { describe, expect, test } from "bun:test";
import { compareVersions, isVersion, newestFirst } from "./version";

describe("isVersion", () => {
  test.each(["0.0.0", "1.2.3", "10.20.30", "0.1.0"])("accepts %s", (v) => expect(isVersion(v)).toBe(true));
  test.each(["", "1.2", "1.2.3.4", "01.2.3", "1.02.3", "1.2.03", "1.2.3-beta", "v1.2.3", "../1.2.3", " 1.2.3", "1.2.3\n", "1".repeat(40) + ".0.0"])(
    "rejects %j",
    (v) => expect(isVersion(v)).toBe(false),
  );
  test("rejects non-strings", () => {
    expect(isVersion(1)).toBe(false);
    expect(isVersion(null)).toBe(false);
  });
});

describe("compareVersions", () => {
  test("orders numerically, not lexically", () => {
    expect(compareVersions("1.10.0", "1.9.0")).toBeGreaterThan(0);
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
    expect(compareVersions("0.9.9", "1.0.0")).toBeLessThan(0);
  });
  test("handles numbers beyond 2^53", () => {
    expect(compareVersions("9007199254740993.0.0", "9007199254740992.0.0")).toBeGreaterThan(0);
  });
  test("throws on non-versions", () => {
    expect(() => compareVersions("1.2", "1.2.3")).toThrow("not a version");
  });
  test("newestFirst", () => {
    expect(newestFirst(["0.2.0", "0.10.0", "0.9.1"])).toEqual(["0.10.0", "0.9.1", "0.2.0"]);
  });
});
```

```ts
// src/install/errors.test.ts
import { describe, expect, test } from "bun:test";
import { EXIT_CODES, InstallError, exitCodeFor, fromFsError } from "./errors";

describe("install errors", () => {
  test("exit codes follow sysexits", () => {
    expect(EXIT_CODES).toEqual({ ok: 0, other: 1, usage: 64, integrity: 65, network: 69, local: 73, busy: 75 });
    expect(exitCodeFor(new InstallError("integrity", "x"))).toBe(65);
    expect(exitCodeFor(new InstallError("busy", "x"))).toBe(75);
    expect(exitCodeFor(new Error("x"))).toBe(1);
  });

  test("maps actionable filesystem errors to local", () => {
    for (const code of ["EACCES", "EPERM", "ENOSPC", "EROFS", "EDQUOT", "ELOOP", "ENOTDIR"]) {
      const mapped = fromFsError(Object.assign(new Error("boom"), { code }), "writing x");
      expect(mapped).toBeInstanceOf(InstallError);
      expect((mapped as InstallError).kind).toBe("local");
      expect((mapped as InstallError).message).toBe("writing x: boom");
    }
  });

  test("leaves other errors unchanged", () => {
    const e = Object.assign(new Error("gone"), { code: "ENOENT" });
    expect(fromFsError(e, "x")).toBe(e);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `bun test src/install/version.test.ts src/install/errors.test.ts`
Expected: FAIL — `Cannot find module './version'` / `'./errors'`.

- [ ] **Step 3: Implement**

```ts
// src/install/version.ts
/** Release versions are plain MAJOR.MINOR.PATCH (spec §5.3); no prerelease or build suffixes. */
export const VERSION_RE = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

export function isVersion(value: unknown): value is string {
  return typeof value === "string" && value.length <= 32 && VERSION_RE.test(value);
}

function parts(v: string): [bigint, bigint, bigint] {
  if (!isVersion(v)) throw new Error(`not a version: ${JSON.stringify(v)}`);
  const [a, b, c] = v.split(".").map((n) => BigInt(n));
  return [a!, b!, c!];
}

/** Negative when a < b, 0 when equal, positive when a > b. */
export function compareVersions(a: string, b: string): number {
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i]! < pb[i]! ? -1 : 1;
  }
  return 0;
}

export function newestFirst(versions: string[]): string[] {
  return [...versions].sort((a, b) => compareVersions(b, a));
}
```

```ts
// src/install/errors.ts
export type InstallErrorKind = "usage" | "integrity" | "network" | "local" | "busy";

/** sysexits.h codes (spec §10.8); `usage` matches EXIT_USAGE in src/cli/main.tsx. */
export const EXIT_CODES = { ok: 0, other: 1, usage: 64, integrity: 65, network: 69, local: 73, busy: 75 } as const;

export class InstallError extends Error {
  constructor(
    readonly kind: InstallErrorKind,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "InstallError";
  }
}

export function exitCodeFor(e: unknown): number {
  return e instanceof InstallError ? EXIT_CODES[e.kind] : EXIT_CODES.other;
}

const LOCAL_CODES = new Set(["EACCES", "EPERM", "ENOSPC", "EROFS", "EDQUOT", "ELOOP", "ENOTDIR"]);

/** Filesystem errors the user can act on become `local` errors; anything else is returned unchanged. */
export function fromFsError(e: unknown, action: string): unknown {
  const code = (e as NodeJS.ErrnoException | undefined)?.code;
  if (code && LOCAL_CODES.has(code)) return new InstallError("local", `${action}: ${(e as Error).message}`, { cause: e });
  return e;
}
```

- [ ] **Step 4: Run them to see them pass**

Run: `bun test src/install/version.test.ts src/install/errors.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/install/version.ts src/install/version.test.ts src/install/errors.ts src/install/errors.test.ts
git commit -m "feat(install): version rules and install error kinds

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 4: Platform detection

Spec: §5.1, §8.2 step 4 (same rules in `install.sh`).

**Files:**
- Create: `src/install/platform.ts`, `src/install/platform.test.ts`

**Interfaces:**
- Consumes: `InstallError` (Task 3)
- Produces: `PLATFORMS`, `type Platform`, `isPlatform(s)`, `interface PlatformProbe { os: string; machine: string; rosetta: boolean; musl: boolean }`, `platformFromProbe(p): Platform`, `interface ProbeDeps { platform?: NodeJS.Platform; arch?: string; run?: (cmd: string[]) => string | null; libDir?: string }`, `probeHost(deps?): PlatformProbe`, `detectPlatform(deps?): Platform`

- [ ] **Step 1: Write the failing tests**

```ts
// src/install/platform.test.ts
import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import { InstallError } from "./errors";
import { PLATFORMS, detectPlatform, isPlatform, platformFromProbe, probeHost } from "./platform";

const probe = (os: string, machine: string, extra: Partial<{ rosetta: boolean; musl: boolean }> = {}) => ({ os, machine, rosetta: false, musl: false, ...extra });

describe("platformFromProbe", () => {
  test.each([
    [probe("Darwin", "arm64"), "darwin-arm64"],
    [probe("Darwin", "x86_64"), "darwin-x64"],
    [probe("Darwin", "x86_64", { rosetta: true }), "darwin-arm64"],
    [probe("Linux", "x86_64"), "linux-x64"],
    [probe("Linux", "amd64"), "linux-x64"],
    [probe("Linux", "aarch64"), "linux-arm64"],
    [probe("Linux", "arm64"), "linux-arm64"],
    [probe("Linux", "x86_64", { musl: true }), "linux-x64-musl"],
    [probe("Linux", "aarch64", { musl: true }), "linux-arm64-musl"],
  ])("%j → %s", (p, expected) => expect(platformFromProbe(p)).toBe(expected as never));

  test.each([probe("FreeBSD", "amd64"), probe("MINGW64_NT-10.0", "x86_64"), probe("Linux", "i686"), probe("Linux", "armv7l")])("rejects %j", (p) => {
    expect(() => platformFromProbe(p)).toThrow(InstallError);
  });

  test("Rosetta only matters on Darwin x64; musl only on Linux", () => {
    expect(platformFromProbe(probe("Darwin", "arm64", { rosetta: true }))).toBe("darwin-arm64");
    expect(platformFromProbe(probe("Darwin", "arm64", { musl: true }))).toBe("darwin-arm64");
  });
});

describe("probeHost", () => {
  test("maps node names to uname names and reads Rosetta", () => {
    const ran: string[][] = [];
    const p = probeHost({ platform: "darwin", arch: "x64", run: (cmd) => (ran.push(cmd), "1\n") });
    expect(p).toEqual({ os: "Darwin", machine: "x86_64", rosetta: true, musl: false });
    expect(ran).toEqual([["sysctl", "-n", "sysctl.proc_translated"]]);
  });

  test("detects musl from the loader in libDir or from ldd", async () => {
    const dir = await makeTmpDir();
    try {
      await mkdir(join(dir, "lib"));
      await writeFile(join(dir, "lib", "ld-musl-x86_64.so.1"), "");
      expect(probeHost({ platform: "linux", arch: "x64", libDir: join(dir, "lib"), run: () => null }).musl).toBe(true);
      expect(probeHost({ platform: "linux", arch: "x64", libDir: join(dir, "none"), run: () => "musl libc (x86_64)" }).musl).toBe(true);
      expect(probeHost({ platform: "linux", arch: "x64", libDir: join(dir, "none"), run: () => "GNU C Library" }).musl).toBe(false);
    } finally {
      await removeDir(dir);
    }
  });

  test("this machine maps to a supported platform", () => {
    expect(PLATFORMS).toContain(detectPlatform());
    expect(isPlatform("linux-x64")).toBe(true);
    expect(isPlatform("win32-x64")).toBe(false);
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `bun test src/install/platform.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/install/platform.ts
import { readdirSync } from "node:fs";
import { InstallError } from "./errors";

export const PLATFORMS = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64", "linux-x64-musl", "linux-arm64-musl"] as const;
export type Platform = (typeof PLATFORMS)[number];

export function isPlatform(value: string): value is Platform {
  return (PLATFORMS as readonly string[]).includes(value);
}

/** What `uname -s`, `uname -m`, the Rosetta sysctl and musl detection report; install.sh applies the same rules. */
export interface PlatformProbe {
  os: string;
  machine: string;
  rosetta: boolean;
  musl: boolean;
}

export function platformFromProbe(p: PlatformProbe): Platform {
  const os = p.os === "Darwin" ? "darwin" : p.os === "Linux" ? "linux" : undefined;
  if (!os) throw new InstallError("local", `unsupported operating system: ${p.os}`);
  const arch = p.machine === "x86_64" || p.machine === "amd64" ? "x64" : p.machine === "arm64" || p.machine === "aarch64" ? "arm64" : undefined;
  if (!arch) throw new InstallError("local", `unsupported CPU architecture: ${p.machine}`);
  if (os === "darwin") return arch === "x64" && p.rosetta ? "darwin-arm64" : `darwin-${arch}`;
  return p.musl ? `linux-${arch}-musl` : `linux-${arch}`;
}

export interface ProbeDeps {
  platform?: NodeJS.Platform;
  arch?: string;
  run?: (cmd: string[]) => string | null;
  libDir?: string;
}

function runQuiet(cmd: string[]): string | null {
  try {
    const r = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
    return r.stdout.toString() + r.stderr.toString();
  } catch {
    return null;
  }
}

function hasMuslLoader(libDir: string): boolean {
  try {
    return readdirSync(libDir).some((f) => /^ld-musl-.+\.so\.1$/.test(f));
  } catch {
    return false;
  }
}

export function probeHost(deps: ProbeDeps = {}): PlatformProbe {
  const platform = deps.platform ?? process.platform;
  const arch = deps.arch ?? process.arch;
  const run = deps.run ?? runQuiet;
  const os = platform === "darwin" ? "Darwin" : platform === "linux" ? "Linux" : platform;
  const machine = arch === "x64" ? "x86_64" : arch;
  const rosetta = platform === "darwin" && arch === "x64" && run(["sysctl", "-n", "sysctl.proc_translated"])?.trim() === "1";
  const musl = platform === "linux" && (hasMuslLoader(deps.libDir ?? "/lib") || /musl/i.test(run(["ldd", "/bin/sh"]) ?? ""));
  return { os, machine, rosetta, musl };
}

export function detectPlatform(deps?: ProbeDeps): Platform {
  return platformFromProbe(probeHost(deps));
}
```

- [ ] **Step 4: Run to see it pass**

Run: `bun test src/install/platform.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/install/platform.ts src/install/platform.test.ts
git commit -m "feat(install): detect the release platform like install.sh does

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 5: SSHSIG verification and the pinned key set

Spec: §4.2, §4.3, §6. Test vectors come from the real `ssh-keygen` at test time (macOS and Linux runners have it; Alpine needs `apk add openssh-keygen`).

**Files:**
- Create: `src/install/sshsig.ts`, `src/install/sshsig.test.ts`
- Create: `src/install/trust.ts`, `src/install/trust.test.ts`
- Create: `src/types/text-imports.d.ts`
- Create: `release/allowed_signers`
- Create: `test/install/helpers/keys.ts`

**Interfaces:**
- Produces: `interface TrustedKey { principal: string; publicKey: Uint8Array; fingerprint: string }`, `parseAllowedSigners(text): TrustedKey[]`, `fingerprint(publicKey): string`, `verifySshSig(req: VerifyRequest): VerifyResult`, `interface VerifyRequest { message: Uint8Array; armoredSignature: string; namespace: string; principal: string; trusted: readonly TrustedKey[] }`, `type VerifyResult = { ok: true; key: TrustedKey } | { ok: false; reason: string }`
- Produces: `SIGNER_PRINCIPAL = "tropos-release"`, `NAMESPACE_MANIFEST = "tropos-manifest"`, `NAMESPACE_INSTALLER = "tropos-installer"`, `TRUSTED_KEYS: readonly TrustedKey[]`, `ALLOWED_SIGNERS_TEXT: string`
- Produces (tests): `interface TestKey { name; privatePath; signersLine; trusted }`, `makeTestKey(dir, name, type?)`, `sshSign(key, data, namespace, dir, extra?)`, `allowedSignersText(...keys)`

- [ ] **Step 1: Create the empty pinned key file and the text-import declaration**

```text
# release/allowed_signers — trusted Tropos Code release signing keys (spec §4.2, §6).
# One line per key: tropos-release ssh-ed25519 <base64-key> <comment>
# Intentionally empty until the key ceremony (plan Task 29): with no key, every signature check fails closed.
```

```ts
// src/types/text-imports.d.ts
declare module "*allowed_signers" {
  const text: string;
  export default text;
}
```

- [ ] **Step 2: Write the key helper**

```ts
// test/install/helpers/keys.ts
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseAllowedSigners, type TrustedKey } from "../../../src/install/sshsig";

export interface TestKey {
  name: string;
  privatePath: string;
  /** "tropos-release <type> <base64>" */
  signersLine: string;
  /** Empty for non-ed25519 keys, which Tropos never trusts. */
  trusted: TrustedKey[];
}

export async function makeTestKey(dir: string, name: string, type: "ed25519" | "ecdsa" = "ed25519"): Promise<TestKey> {
  const privatePath = join(dir, `${name}.key`);
  await Bun.$`ssh-keygen -q -t ${type} -N "" -C ${name} -f ${privatePath}`.quiet();
  const [keyType, b64] = (await readFile(`${privatePath}.pub`, "utf8")).trim().split(/\s+/);
  const signersLine = `tropos-release ${keyType} ${b64}`;
  return { name, privatePath, signersLine, trusted: type === "ed25519" ? parseAllowedSigners(signersLine) : [] };
}

let counter = 0;

/** Signs `data` with `ssh-keygen -Y sign` and returns the armored signature. */
export async function sshSign(key: TestKey, data: Uint8Array | string, namespace: string, dir: string, extra: string[] = []): Promise<string> {
  const file = join(dir, `to-sign-${process.pid}-${counter++}`);
  await writeFile(file, data);
  await Bun.$`ssh-keygen -Y sign -f ${key.privatePath} -n ${namespace} ${extra} ${file}`.quiet();
  return readFile(`${file}.sig`, "utf8");
}

export function allowedSignersText(...keys: TestKey[]): string {
  return keys.map((k) => k.signersLine).join("\n") + "\n";
}
```

- [ ] **Step 3: Write the failing tests**

```ts
// src/install/sshsig.test.ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTestKey, sshSign, type TestKey } from "../../test/install/helpers/keys";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import { parseAllowedSigners, verifySshSig } from "./sshsig";

let dir: string;
let k1: TestKey, k2: TestKey, ec: TestKey;
const message = new TextEncoder().encode('{"hello":"world"}\n');

beforeAll(async () => {
  dir = await makeTmpDir();
  [k1, k2, ec] = await Promise.all([makeTestKey(dir, "k1"), makeTestKey(dir, "k2"), makeTestKey(dir, "ec", "ecdsa")]);
});
afterAll(() => removeDir(dir));

const req = (armoredSignature: string, overrides: Partial<Parameters<typeof verifySshSig>[0]> = {}) => ({
  message,
  armoredSignature,
  namespace: "tropos-manifest",
  principal: "tropos-release",
  trusted: k1.trusted,
  ...overrides,
});

async function sshKeygenAccepts(sig: string, signers: string, data: Uint8Array, namespace = "tropos-manifest"): Promise<boolean> {
  await writeFile(join(dir, "s.sig"), sig);
  await writeFile(join(dir, "signers"), signers);
  await writeFile(join(dir, "data"), data);
  const r = await Bun.$`ssh-keygen -Y verify -f ${join(dir, "signers")} -I tropos-release -n ${namespace} -s ${join(dir, "s.sig")} < ${join(dir, "data")}`.quiet().nothrow();
  return r.exitCode === 0;
}

describe("verifySshSig", () => {
  test("accepts a signature from a trusted key (sha512, the ssh-keygen default)", async () => {
    const sig = await sshSign(k1, message, "tropos-manifest", dir);
    const r = verifySshSig(req(sig));
    expect(r.ok).toBe(true);
    expect(await sshKeygenAccepts(sig, k1.signersLine + "\n", message)).toBe(true);
  });

  test("accepts hashalg=sha256", async () => {
    const sig = await sshSign(k1, message, "tropos-manifest", dir, ["-O", "hashalg=sha256"]);
    expect(verifySshSig(req(sig)).ok).toBe(true);
  });

  test("rejects another namespace", async () => {
    const sig = await sshSign(k1, message, "tropos-installer", dir);
    const r = verifySshSig(req(sig));
    expect(r).toEqual({ ok: false, reason: 'signature is for namespace "tropos-installer", expected "tropos-manifest"' });
    expect(await sshKeygenAccepts(sig, k1.signersLine + "\n", message)).toBe(false);
  });

  test("rejects an untrusted key", async () => {
    const sig = await sshSign(k2, message, "tropos-manifest", dir);
    const r = verifySshSig(req(sig));
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toStartWith("signed by an untrusted key (SHA256:");
  });

  test("rejects a trusted key listed under another principal", async () => {
    const sig = await sshSign(k1, message, "tropos-manifest", dir);
    const other = parseAllowedSigners(k1.signersLine.replace("tropos-release", "someone-else"));
    expect(verifySshSig(req(sig, { trusted: other })).ok).toBe(false);
  });

  test("rejects a modified message", async () => {
    const sig = await sshSign(k1, message, "tropos-manifest", dir);
    const changed = new Uint8Array(message);
    changed[3]! ^= 1;
    expect(verifySshSig(req(sig, { message: changed }))).toEqual({ ok: false, reason: "signature does not match" });
  });

  test("rejects a modified signature", async () => {
    const sig = await sshSign(k1, message, "tropos-manifest", dir);
    const lines = sig.trim().split("\n");
    const body = lines.slice(1, -1).join("");
    const raw = Buffer.from(body, "base64");
    raw[raw.length - 5]! ^= 1; // inside the 64-byte ed25519 signature at the end of the blob
    const tampered = [lines[0], raw.toString("base64"), lines.at(-1)].join("\n");
    expect(verifySshSig(req(tampered)).ok).toBe(false);
  });

  test.each([
    ["missing END line", (s: string) => s.trim().split("\n").slice(0, -1).join("\n")],
    ["empty", () => ""],
    ["not base64", (s: string) => s.replace(/\n[A-Za-z0-9+/]/, "\n!")],
    ["truncated body", (s: string) => { const l = s.trim().split("\n"); return [l[0], l[1]!.slice(0, 20), l.at(-1)].join("\n"); }],
  ])("rejects an unreadable signature: %s", async (_name, mangle) => {
    const sig = await sshSign(k1, message, "tropos-manifest", dir);
    const r = verifySshSig(req(mangle(sig)));
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toStartWith("unreadable signature");
  });

  test("rejects non-ed25519 signatures", async () => {
    const sig = await sshSign(ec, message, "tropos-manifest", dir);
    expect(verifySshSig(req(sig)).ok).toBe(false);
  });

  test("an empty trusted set rejects everything", async () => {
    const sig = await sshSign(k1, message, "tropos-manifest", dir);
    expect(verifySshSig(req(sig, { trusted: [] })).ok).toBe(false);
  });
});

describe("parseAllowedSigners", () => {
  test("skips comments and blanks; fingerprint matches ssh-keygen -l", async () => {
    const keys = parseAllowedSigners(`# comment\n\n${k1.signersLine} k1-comment\n${k2.signersLine}\n`);
    expect(keys.map((k) => k.principal)).toEqual(["tropos-release", "tropos-release"]);
    const listed = (await Bun.$`ssh-keygen -lf ${k1.privatePath}.pub`.text()).split(" ")[1];
    expect(keys[0]!.fingerprint).toBe(listed!);
  });

  test.each([
    ["wrong key type", "tropos-release ssh-rsa AAAAB3NzaC1yc2E="],
    ["options before the key type", 'tropos-release namespaces="x" ssh-ed25519 AAAA'],
    ["missing key", "tropos-release ssh-ed25519"],
    ["bad base64", "tropos-release ssh-ed25519 !!!!"],
  ])("rejects %s", (_name, line) => {
    expect(() => parseAllowedSigners(line)).toThrow("allowed_signers line 1");
  });
});
```

```ts
// src/install/trust.test.ts
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { ALLOWED_SIGNERS_TEXT, NAMESPACE_INSTALLER, NAMESPACE_MANIFEST, SIGNER_PRINCIPAL, TRUSTED_KEYS } from "./trust";
import { parseAllowedSigners } from "./sshsig";

describe("trust", () => {
  test("pinned identities", () => {
    expect(SIGNER_PRINCIPAL).toBe("tropos-release");
    expect(NAMESPACE_MANIFEST).toBe("tropos-manifest");
    expect(NAMESPACE_INSTALLER).toBe("tropos-installer");
  });

  test("the compiled-in keys are exactly release/allowed_signers", async () => {
    const file = await readFile(new URL("../../release/allowed_signers", import.meta.url), "utf8");
    expect(ALLOWED_SIGNERS_TEXT).toBe(file);
    expect(TRUSTED_KEYS.map((k) => k.fingerprint)).toEqual(parseAllowedSigners(file).map((k) => k.fingerprint));
    expect(Object.isFrozen(TRUSTED_KEYS)).toBe(true);
  });
});
```

- [ ] **Step 4: Run to see them fail**

Run: `bun test src/install/sshsig.test.ts src/install/trust.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 5: Implement `sshsig.ts`**

```ts
// src/install/sshsig.ts
import { createHash, createPublicKey, verify as cryptoVerify } from "node:crypto";

/** A key from an allowed_signers file. Only ssh-ed25519 keys are ever trusted. */
export interface TrustedKey {
  principal: string;
  publicKey: Uint8Array;
  fingerprint: string;
}

const BEGIN = "-----BEGIN SSH SIGNATURE-----";
const END = "-----END SSH SIGNATURE-----";
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

class Reader {
  private offset = 0;
  constructor(private readonly buf: Buffer) {}
  bytes(n: number): Buffer {
    if (n < 0 || this.offset + n > this.buf.length) throw new Error("truncated");
    const out = this.buf.subarray(this.offset, this.offset + n);
    this.offset += n;
    return out;
  }
  uint32(): number {
    return this.bytes(4).readUInt32BE(0);
  }
  string(): Buffer {
    const n = this.uint32();
    if (n > 1 << 16) throw new Error("field too long");
    return this.bytes(n);
  }
  done(): boolean {
    return this.offset === this.buf.length;
  }
}

function sshString(data: Uint8Array): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  return Buffer.concat([len, Buffer.from(data)]);
}

function decodeEd25519Blob(blob: Buffer): Uint8Array {
  const r = new Reader(blob);
  if (r.string().toString("latin1") !== "ssh-ed25519") throw new Error("not an ssh-ed25519 key");
  const key = r.string();
  if (key.length !== 32 || !r.done()) throw new Error("malformed ssh-ed25519 key");
  return new Uint8Array(key);
}

/** OpenSSH-style fingerprint, as printed by `ssh-keygen -l`. */
export function fingerprint(publicKey: Uint8Array): string {
  const blob = Buffer.concat([sshString(Buffer.from("ssh-ed25519")), sshString(publicKey)]);
  return `SHA256:${createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}`;
}

/** Parses "principal ssh-ed25519 <base64> [comment]" lines; '#' lines and blank lines are ignored. */
export function parseAllowedSigners(text: string): TrustedKey[] {
  const keys: TrustedKey[] = [];
  for (const [i, raw] of text.split("\n").entries()) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const [principal, type, b64] = line.split(/\s+/);
    try {
      if (!principal || type !== "ssh-ed25519" || !b64 || !BASE64_RE.test(b64)) throw new Error("bad fields");
      const publicKey = decodeEd25519Blob(Buffer.from(b64, "base64"));
      keys.push({ principal, publicKey, fingerprint: fingerprint(publicKey) });
    } catch {
      throw new Error(`allowed_signers line ${i + 1}: expected "<principal> ssh-ed25519 <key> [comment]"`);
    }
  }
  return keys;
}

interface SshSig {
  publicKey: Uint8Array;
  namespace: string;
  reserved: Buffer;
  hashAlg: "sha256" | "sha512";
  signature: Buffer;
}

function parseSshSig(armored: string): SshSig {
  const text = armored.trim();
  if (!text.startsWith(BEGIN) || !text.endsWith(END)) throw new Error("missing SSH SIGNATURE armour");
  const body = text.slice(BEGIN.length, text.length - END.length).replace(/\s+/g, "");
  if (!BASE64_RE.test(body)) throw new Error("bad base64");
  const r = new Reader(Buffer.from(body, "base64"));
  if (r.bytes(6).toString("latin1") !== "SSHSIG") throw new Error("bad magic");
  if (r.uint32() !== 1) throw new Error("unsupported SSHSIG version");
  const publicKey = decodeEd25519Blob(r.string());
  const namespace = r.string().toString("utf8");
  const reserved = r.string();
  const hashAlg = r.string().toString("latin1");
  if (hashAlg !== "sha256" && hashAlg !== "sha512") throw new Error(`unsupported hash ${hashAlg}`);
  const sigBlob = new Reader(r.string());
  if (sigBlob.string().toString("latin1") !== "ssh-ed25519") throw new Error("not an ed25519 signature");
  const signature = sigBlob.string();
  if (signature.length !== 64 || !sigBlob.done() || !r.done()) throw new Error("malformed signature");
  return { publicKey, namespace, reserved, hashAlg, signature };
}

export interface VerifyRequest {
  message: Uint8Array;
  armoredSignature: string;
  namespace: string;
  principal: string;
  trusted: readonly TrustedKey[];
}

export type VerifyResult = { ok: true; key: TrustedKey } | { ok: false; reason: string };

/** Verifies an SSHSIG signature the way `ssh-keygen -Y verify -I <principal> -n <namespace>` does. */
export function verifySshSig(req: VerifyRequest): VerifyResult {
  let sig: SshSig;
  try {
    sig = parseSshSig(req.armoredSignature);
  } catch (e) {
    return { ok: false, reason: `unreadable signature: ${(e as Error).message}` };
  }
  if (sig.namespace !== req.namespace) {
    return { ok: false, reason: `signature is for namespace "${sig.namespace}", expected "${req.namespace}"` };
  }
  const key = req.trusted.find((k) => k.principal === req.principal && Buffer.from(k.publicKey).equals(Buffer.from(sig.publicKey)));
  if (!key) return { ok: false, reason: `signed by an untrusted key (${fingerprint(sig.publicKey)})` };
  const digest = createHash(sig.hashAlg).update(req.message).digest();
  const signed = Buffer.concat([
    Buffer.from("SSHSIG"),
    sshString(Buffer.from(req.namespace)),
    sshString(sig.reserved),
    sshString(Buffer.from(sig.hashAlg)),
    sshString(digest),
  ]);
  const publicKey = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(key.publicKey)]), format: "der", type: "spki" });
  return cryptoVerify(null, signed, publicKey, sig.signature) ? { ok: true, key } : { ok: false, reason: "signature does not match" };
}
```

- [ ] **Step 6: Implement `trust.ts`**

```ts
// src/install/trust.ts
import allowedSigners from "../../release/allowed_signers" with { type: "text" };
import { parseAllowedSigners, type TrustedKey } from "./sshsig";

export const SIGNER_PRINCIPAL = "tropos-release";
export const NAMESPACE_MANIFEST = "tropos-manifest";
export const NAMESPACE_INSTALLER = "tropos-installer";

/** release/allowed_signers, embedded at build time. There is no runtime override (spec §4.2). */
export const ALLOWED_SIGNERS_TEXT: string = allowedSigners;

/** Empty until the key ceremony; an empty set makes every verification fail closed. */
export const TRUSTED_KEYS: readonly TrustedKey[] = Object.freeze(parseAllowedSigners(ALLOWED_SIGNERS_TEXT));
```

- [ ] **Step 7: Run to see them pass**

Run: `bun test src/install/sshsig.test.ts src/install/trust.test.ts && bun run typecheck`
Expected: PASS (13 + 2 tests).

- [ ] **Step 8: Commit**

```bash
git add release/allowed_signers src/types/text-imports.d.ts src/install/sshsig.ts src/install/sshsig.test.ts src/install/trust.ts src/install/trust.test.ts test/install/helpers/keys.ts
git commit -m "feat(install): verify SSHSIG ed25519 signatures against pinned keys

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 6: Strict canonical manifest

Spec: §5.3 (format, canonical form, field rules), §4.3 (signature before parsing).

**Files:**
- Create: `src/install/manifest.ts`, `src/install/manifest.test.ts`
- Create: `test/install/helpers/manifest-corpus.ts`

**Interfaces:**
- Consumes: `PLATFORMS`, `Platform` (Task 4); `verifySshSig`, `TrustedKey` (Task 5); `TRUSTED_KEYS`, `NAMESPACE_MANIFEST`, `SIGNER_PRINCIPAL` (Task 5); `VERSION_RE` (Task 3); `InstallError` (Task 3)
- Produces: `interface AssetEntry { asset: string; sha256: string; size: number }`, `interface PlatformEntry extends AssetEntry { zst: AssetEntry }`, `interface Manifest { schema: 1; version: string; commit: string; buildDate: string; platforms: Record<Platform, PlatformEntry> }`, `MAX_MANIFEST_BYTES = 65536`, `MAX_ASSET_SIZE = 1073741824`, `serializeManifest(m): string`, `parseManifest(bytes: Uint8Array): Manifest`, `interface VerifiedManifest { manifest: Manifest; bytes: Uint8Array; signature: string }`, `verifyManifest(bytes, signature, trusted?): VerifiedManifest`, `expectVersion(m, version): void`
- Produces (tests): `sampleManifest(version?)`, `VALID_CORPUS: CorpusCase[]`, `INVALID_CORPUS: CorpusCase[]`, `interface CorpusCase { name: string; text: string }`

- [ ] **Step 1: Write the corpus**

```ts
// test/install/helpers/manifest-corpus.ts
// The shared manifest corpus (spec §13 layers 1 and 7): manifest.ts, manifest.awk and install.sh must agree on every case.
import { serializeManifest, type Manifest } from "../../../src/install/manifest";
import { PLATFORMS } from "../../../src/install/platform";

export interface CorpusCase {
  name: string;
  text: string;
}

const hex = (i: number, c: string) => (String(i) + c.repeat(64)).slice(0, 64);

export function sampleManifest(version = "1.2.3", size = (i: number) => 1000 + i): Manifest {
  const platforms = Object.fromEntries(
    PLATFORMS.map((p, i) => [p, { asset: `tropos-${p}`, sha256: hex(i, "a"), size: size(i), zst: { asset: `tropos-${p}.zst`, sha256: hex(i, "b"), size: 500 + i } }]),
  );
  return { schema: 1, version, commit: "0123456789abcdef0123456789abcdef01234567", buildDate: "2026-10-13T12:00:00Z", platforms } as Manifest;
}

const VALID = serializeManifest(sampleManifest());

function replaceOnce(text: string, from: string, to: string): string {
  if (!text.includes(from)) throw new Error(`corpus: "${from}" not found`);
  return text.replace(from, () => to);
}

function json(obj: unknown): string {
  return `${JSON.stringify(obj, null, 2)}\n`;
}

function withPlatforms(mutate: (platforms: Record<string, unknown>) => Record<string, unknown>): string {
  const m = JSON.parse(VALID) as { platforms: Record<string, unknown> };
  return json({ ...m, platforms: mutate(m.platforms) });
}

const firstSha = hex(0, "a");

export const VALID_CORPUS: CorpusCase[] = [
  { name: "sample", text: VALID },
  { name: "version-0.0.1", text: serializeManifest(sampleManifest("0.0.1")) },
  { name: "size-bounds", text: serializeManifest(sampleManifest("2.0.0", (i) => (i % 2 === 0 ? 1 : 1073741824))) },
];

export const INVALID_CORPUS: CorpusCase[] = [
  { name: "empty", text: "" },
  { name: "not-json", text: "hello\n" },
  { name: "bom", text: `﻿${VALID}` },
  { name: "crlf", text: VALID.replace(/\n/g, "\r\n") },
  { name: "tab-indent", text: replaceOnce(VALID, '  "schema"', '\t"schema"') },
  { name: "trailing-space", text: replaceOnce(VALID, '"schema": 1,', '"schema": 1, ') },
  { name: "no-final-newline", text: VALID.slice(0, -1) },
  { name: "two-final-newlines", text: `${VALID}\n` },
  { name: "huge", text: `{${" ".repeat(70_000)}\n` },
  { name: "nul-byte", text: replaceOnce(VALID, '"commit": "0', '"commit": "\u00000') },
  { name: "duplicate-version-key", text: replaceOnce(VALID, '  "version": "1.2.3",\n', '  "version": "1.2.3",\n  "version": "9.9.9",\n') },
  { name: "duplicate-identical-key", text: replaceOnce(VALID, '  "version": "1.2.3",\n', '  "version": "1.2.3",\n  "version": "1.2.3",\n') },
  { name: "extra-field", text: replaceOnce(VALID, '  "platforms": {', '  "extra": 1,\n  "platforms": {') },
  { name: "reordered-keys", text: replaceOnce(VALID, '  "version": "1.2.3",\n  "commit": "0123456789abcdef0123456789abcdef01234567",\n', '  "commit": "0123456789abcdef0123456789abcdef01234567",\n  "version": "1.2.3",\n') },
  { name: "schema-2", text: replaceOnce(VALID, '"schema": 1', '"schema": 2') },
  { name: "version-two-parts", text: replaceOnce(VALID, '"version": "1.2.3"', '"version": "1.2"') },
  { name: "version-leading-zero", text: replaceOnce(VALID, '"version": "1.2.3"', '"version": "01.2.3"') },
  { name: "version-prerelease", text: replaceOnce(VALID, '"version": "1.2.3"', '"version": "1.2.3-beta"') },
  { name: "version-traversal", text: replaceOnce(VALID, '"version": "1.2.3"', '"version": "../1.2.3"') },
  { name: "version-escaped", text: replaceOnce(VALID, '"version": "1.2.3"', '"version": "\\u0031.2.3"') },
  { name: "commit-short", text: replaceOnce(VALID, "0123456789abcdef0123456789abcdef01234567", "0123456789abcdef0123456789abcdef0123456") },
  { name: "build-date", text: replaceOnce(VALID, "2026-10-13T12:00:00Z", "2026-10-13 12:00:00Z") },
  { name: "sha-uppercase", text: replaceOnce(VALID, firstSha, firstSha.toUpperCase()) },
  { name: "sha-63", text: replaceOnce(VALID, firstSha, firstSha.slice(1)) },
  { name: "size-zero", text: replaceOnce(VALID, '"size": 1000,', '"size": 0,') },
  { name: "size-leading-zero", text: replaceOnce(VALID, '"size": 1000,', '"size": 01000,') },
  { name: "size-too-large", text: replaceOnce(VALID, '"size": 1000,', '"size": 1073741825,') },
  { name: "size-fraction", text: replaceOnce(VALID, '"size": 1000,', '"size": 1000.5,') },
  { name: "size-negative", text: replaceOnce(VALID, '"size": 1000,', '"size": -1000,') },
  { name: "size-string", text: replaceOnce(VALID, '"size": 1000,', '"size": "1000",') },
  { name: "asset-name", text: replaceOnce(VALID, '"asset": "tropos-darwin-arm64",', '"asset": "tropos-darwin-x64",') },
  { name: "asset-traversal", text: replaceOnce(VALID, '"asset": "tropos-darwin-arm64",', '"asset": "../tropos-darwin-arm64",') },
  { name: "zst-asset-name", text: replaceOnce(VALID, '"asset": "tropos-darwin-arm64.zst"', '"asset": "tropos-darwin-arm64"') },
  { name: "missing-platform", text: withPlatforms(({ "linux-arm64-musl": _, ...rest }) => rest) },
  { name: "extra-platform", text: withPlatforms((p) => ({ ...p, "win32-x64": p["linux-x64"] })) },
  { name: "platform-order", text: withPlatforms(({ "darwin-arm64": first, ...rest }) => ({ ...rest, "darwin-arm64": first })) },
];
```

- [ ] **Step 2: Write the failing tests**

```ts
// src/install/manifest.test.ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { INVALID_CORPUS, VALID_CORPUS, sampleManifest } from "../../test/install/helpers/manifest-corpus";
import { makeTestKey, sshSign, type TestKey } from "../../test/install/helpers/keys";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import { InstallError } from "./errors";
import { expectVersion, parseManifest, serializeManifest, verifyManifest } from "./manifest";

const enc = (s: string) => new TextEncoder().encode(s);
let dir: string;
let key: TestKey;
let other: TestKey;
beforeAll(async () => {
  dir = await makeTmpDir();
  [key, other] = await Promise.all([makeTestKey(dir, "k"), makeTestKey(dir, "other")]);
});
afterAll(() => removeDir(dir));

describe("manifest", () => {
  test("serializeManifest is the canonical form of spec §5.3", () => {
    const text = serializeManifest(sampleManifest());
    const lines = text.split("\n");
    expect(lines.length).toBe(69); // 68 lines + the empty string after the final newline
    expect(lines.slice(0, 7)).toEqual(["{", '  "schema": 1,', '  "version": "1.2.3",', '  "commit": "0123456789abcdef0123456789abcdef01234567",', '  "buildDate": "2026-10-13T12:00:00Z",', '  "platforms": {', '    "darwin-arm64": {']);
    expect(lines.slice(-3)).toEqual(["  }", "}", ""]);
  });

  test.each(VALID_CORPUS.map((c) => [c.name, c.text]))("accepts %s", (_name, text) => {
    expect(serializeManifest(parseManifest(enc(text)))).toBe(text);
  });

  test.each(INVALID_CORPUS.map((c) => [c.name, c.text]))("rejects %s", (_name, text) => {
    const run = () => parseManifest(enc(text));
    expect(run).toThrow(InstallError);
    try {
      run();
    } catch (e) {
      expect((e as InstallError).kind).toBe("integrity");
    }
  });

  test("rejects invalid UTF-8", () => {
    const bytes = enc(serializeManifest(sampleManifest()));
    bytes[20] = 0xff;
    expect(() => parseManifest(bytes)).toThrow("manifest is not UTF-8");
  });

  test("verifyManifest checks the signature before parsing", async () => {
    const bytes = enc("not even json\n");
    const sig = await sshSign(other, bytes, "tropos-manifest", dir);
    expect(() => verifyManifest(bytes, sig, key.trusted)).toThrow("manifest signature rejected: signed by an untrusted key");
  });

  test("verifyManifest accepts a signed canonical manifest", async () => {
    const bytes = enc(serializeManifest(sampleManifest("0.4.0")));
    const sig = await sshSign(key, bytes, "tropos-manifest", dir);
    const v = verifyManifest(bytes, sig, key.trusted);
    expect(v.manifest.version).toBe("0.4.0");
    expect(v.signature).toBe(sig);
  });

  test("verifyManifest rejects a signed but malformed manifest", async () => {
    const bytes = enc(INVALID_CORPUS.find((c) => c.name === "duplicate-version-key")!.text);
    const sig = await sshSign(key, bytes, "tropos-manifest", dir);
    expect(() => verifyManifest(bytes, sig, key.trusted)).toThrow("manifest is not in canonical form");
  });

  test("verifyManifest with the default (empty) key set fails closed", async () => {
    const bytes = enc(serializeManifest(sampleManifest()));
    const sig = await sshSign(key, bytes, "tropos-manifest", dir);
    expect(() => verifyManifest(bytes, sig)).toThrow("untrusted key");
  });

  test("expectVersion", () => {
    expect(() => expectVersion(sampleManifest("1.0.0"), "1.0.1")).toThrow("manifest is for version 1.0.0, expected 1.0.1");
    expect(() => expectVersion(sampleManifest("1.0.0"), "1.0.0")).not.toThrow();
  });
});
```

- [ ] **Step 3: Run to see it fail**

Run: `bun test src/install/manifest.test.ts`
Expected: FAIL — module `./manifest` not found.

- [ ] **Step 4: Implement**

```ts
// src/install/manifest.ts
import { z } from "zod";
import { InstallError } from "./errors";
import { PLATFORMS, type Platform } from "./platform";
import { verifySshSig, type TrustedKey } from "./sshsig";
import { NAMESPACE_MANIFEST, SIGNER_PRINCIPAL, TRUSTED_KEYS } from "./trust";
import { VERSION_RE } from "./version";

export const MAX_MANIFEST_BYTES = 64 * 1024;
export const MAX_ASSET_SIZE = 1073741824;

export interface AssetEntry {
  asset: string;
  sha256: string;
  size: number;
}

export interface PlatformEntry extends AssetEntry {
  zst: AssetEntry;
}

export interface Manifest {
  schema: 1;
  version: string;
  commit: string;
  buildDate: string;
  platforms: Record<Platform, PlatformEntry>;
}

export interface VerifiedManifest {
  manifest: Manifest;
  bytes: Uint8Array;
  signature: string;
}

const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const size = z.number().int().min(1).max(MAX_ASSET_SIZE);

function entrySchema(p: Platform) {
  return z
    .object({
      asset: z.literal(`tropos-${p}`),
      sha256,
      size,
      zst: z.object({ asset: z.literal(`tropos-${p}.zst`), sha256, size }).strict(),
    })
    .strict();
}

const manifestSchema = z
  .object({
    schema: z.literal(1),
    version: z.string().max(32).regex(VERSION_RE),
    commit: z.string().regex(/^[0-9a-f]{40}$/),
    buildDate: z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/),
    platforms: z.object(Object.fromEntries(PLATFORMS.map((p) => [p, entrySchema(p)])) as Record<Platform, ReturnType<typeof entrySchema>>).strict(),
  })
  .strict();

const integrity = (message: string) => new InstallError("integrity", message);

/** The one canonical byte form (spec §5.3): fixed key and platform order, two-space indent, LF, one final newline. */
export function serializeManifest(m: Manifest): string {
  const platforms: Record<string, unknown> = {};
  for (const p of PLATFORMS) {
    const e = m.platforms[p];
    platforms[p] = { asset: e.asset, sha256: e.sha256, size: e.size, zst: { asset: e.zst.asset, sha256: e.zst.sha256, size: e.zst.size } };
  }
  return `${JSON.stringify({ schema: m.schema, version: m.version, commit: m.commit, buildDate: m.buildDate, platforms }, null, 2)}\n`;
}

/** Strict parse: schema-valid AND byte-identical to its canonical serialisation (rejects duplicate keys, reordering, whitespace). */
export function parseManifest(bytes: Uint8Array): Manifest {
  if (bytes.length > MAX_MANIFEST_BYTES) throw integrity("manifest is too large");
  let text: string;
  try {
    // ignoreBOM keeps a BOM in the text, so JSON.parse rejects it instead of it being silently stripped.
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw integrity("manifest is not UTF-8");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw integrity("manifest is not JSON");
  }
  const parsed = manifestSchema.safeParse(raw);
  if (!parsed.success) {
    throw integrity(`manifest is malformed: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`);
  }
  const manifest = parsed.data as Manifest;
  if (serializeManifest(manifest) !== text) throw integrity("manifest is not in canonical form");
  return manifest;
}

/** Verifies the signature with the pinned keys, then parses (spec §4.3). */
export function verifyManifest(bytes: Uint8Array, signature: string, trusted: readonly TrustedKey[] = TRUSTED_KEYS): VerifiedManifest {
  const result = verifySshSig({ message: bytes, armoredSignature: signature, namespace: NAMESPACE_MANIFEST, principal: SIGNER_PRINCIPAL, trusted });
  if (!result.ok) {
    // Spec §6.1: a binary that predates a key rotation cannot verify new releases and must be reinstalled.
    const hint = result.reason.startsWith("signed by an untrusted key") ? "; if the Tropos release key was rotated, reinstall with install.sh" : "";
    throw integrity(`manifest signature rejected: ${result.reason}${hint}`);
  }
  return { manifest: parseManifest(bytes), bytes, signature };
}

export function expectVersion(m: Manifest, expected: string): void {
  if (m.version !== expected) throw integrity(`manifest is for version ${m.version}, expected ${expected}`);
}
```

- [ ] **Step 5: Run to see it pass**

Run: `bun test src/install/manifest.test.ts && bun run typecheck`
Expected: PASS (3 valid + 36 invalid + 7 other tests).

- [ ] **Step 6: Commit**

```bash
git add src/install/manifest.ts src/install/manifest.test.ts test/install/helpers/manifest-corpus.ts
git commit -m "feat(install): strict canonical manifest with signature-first verification

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 7: Release manifest tooling (`make-manifest.sh`, `manifest.awk`) with TS parity

Spec: §5.3, §7.3 step 1, §13 layer 7.

**Files:**
- Create: `scripts/release/make-manifest.sh`
- Create: `scripts/release/manifest.awk`
- Create: `test/install/manifest-parity.test.ts`

**Interfaces:**
- Consumes: `serializeManifest`, `parseManifest`, `Manifest` (Task 6); `INVALID_CORPUS`, `VALID_CORPUS`, `sampleManifest` (Task 6)
- Produces: `make-manifest.sh <version> <commit> <build-date> <assets-dir>` → canonical manifest on stdout; `awk -v want=<platform> -f manifest.awk <file>` → prints `version=…` (and `sha256=`, `size=`, `zst_sha256=`, `zst_size=` when `want` is set), exit 1 on any deviation. A manifest is valid for shell callers only if its last byte is `\n` **and** the awk program accepts it (`checkManifestSh` below — the same pair `install.sh` uses in Task 21).

- [ ] **Step 1: Write the failing parity test**

```ts
// test/install/manifest-parity.test.ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseManifest, serializeManifest, type Manifest } from "../../src/install/manifest";
import { PLATFORMS } from "../../src/install/platform";
import { makeTmpDir, removeDir } from "../helpers/tmp";
import { INVALID_CORPUS, VALID_CORPUS } from "./helpers/manifest-corpus";

const AWK = join(import.meta.dir, "../../scripts/release/manifest.awk");
const MAKE = join(import.meta.dir, "../../scripts/release/make-manifest.sh");
const AWKS = [["awk"], ["busybox", "awk"], ["mawk"], ["gawk"]].filter((cmd) => Bun.which(cmd[0]!) && (cmd[0] !== "busybox" || Bun.spawnSync(["busybox", "awk", "BEGIN{}"]).exitCode === 0));

let dir: string;
beforeAll(async () => {
  dir = await makeTmpDir();
});
afterAll(() => removeDir(dir));

/** The shell-side validity check: final byte is a newline, then the awk grammar. */
async function checkManifestSh(awk: string[], text: string, want = ""): Promise<{ code: number; out: string }> {
  const file = join(dir, `m-${Math.random().toString(36).slice(2)}.json`);
  await writeFile(file, text);
  // $1 is the file; the rest is the awk command line. od prints a final newline as the two characters \n.
  const script = '[ "$(tail -c 1 "$1" | od -An -c | tr -d " ")" = "\\n" ] || exit 1; shift; exec "$@"';
  const proc = Bun.spawn(["sh", "-c", script, "sh", file, ...awk, "-v", `want=${want}`, "-f", AWK, file], { stdout: "pipe", stderr: "pipe" });
  return { code: await proc.exited, out: await new Response(proc.stdout).text() };
}

describe.each(AWKS.map((a) => [a.join(" "), a]))("manifest.awk under %s", (_name, awk) => {
  test.each(VALID_CORPUS.map((c) => [c.name, c.text]))("accepts %s like manifest.ts", async (_n, text) => {
    const m = parseManifest(new TextEncoder().encode(text));
    const r = await checkManifestSh(awk as string[], text, "linux-x64-musl");
    expect(r.code).toBe(0);
    const e = m.platforms["linux-x64-musl"];
    expect(r.out).toBe(`version=${m.version}\nsha256=${e.sha256}\nsize=${e.size}\nzst_sha256=${e.zst.sha256}\nzst_size=${e.zst.size}\n`);
  });

  test.each(INVALID_CORPUS.map((c) => [c.name, c.text]))("rejects %s like manifest.ts", async (_n, text) => {
    expect(() => parseManifest(new TextEncoder().encode(text))).toThrow();
    expect((await checkManifestSh(awk as string[], text)).code).not.toBe(0);
  });

  test("rejects a platform that is not in the manifest", async () => {
    expect((await checkManifestSh(awk as string[], VALID_CORPUS[0]!.text, "win32-x64")).code).not.toBe(0);
  });
});

describe("make-manifest.sh", () => {
  test("writes the canonical manifest for real files", async () => {
    const assets = join(dir, "assets");
    await mkdir(assets);
    const expected: Manifest = { schema: 1, version: "3.1.4", commit: "a".repeat(40), buildDate: "2026-10-13T00:00:00Z", platforms: {} as Manifest["platforms"] };
    for (const [i, p] of PLATFORMS.entries()) {
      const raw = new Uint8Array(1000 + i).fill(i + 1);
      const zst = Bun.zstdCompressSync(raw);
      await writeFile(join(assets, `tropos-${p}`), raw);
      await writeFile(join(assets, `tropos-${p}.zst`), zst);
      const hash = (b: Uint8Array) => new Bun.CryptoHasher("sha256").update(b).digest("hex");
      expected.platforms[p] = { asset: `tropos-${p}`, sha256: hash(raw), size: raw.length, zst: { asset: `tropos-${p}.zst`, sha256: hash(zst), size: zst.length } };
    }
    const r = await Bun.$`sh ${MAKE} 3.1.4 ${"a".repeat(40)} 2026-10-13T00:00:00Z ${assets}`.quiet();
    expect(r.stdout.toString()).toBe(serializeManifest(expected));
    expect((await checkManifestSh(["awk"], r.stdout.toString(), "darwin-x64")).code).toBe(0);
  });

  test("fails when an asset is missing", async () => {
    const r = await Bun.$`sh ${MAKE} 3.1.4 ${"a".repeat(40)} 2026-10-13T00:00:00Z ${join(dir, "nowhere")}`.quiet().nothrow();
    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain("make-manifest: missing");
  });

  test("usage error without four arguments", async () => {
    expect((await Bun.$`sh ${MAKE} 1.0.0`.quiet().nothrow()).exitCode).toBe(64);
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `bun test test/install/manifest-parity.test.ts`
Expected: FAIL — `manifest.awk`/`make-manifest.sh` do not exist (awk exits 2, sh exits 127).

- [ ] **Step 3: Write `manifest.awk`**

```awk
# scripts/release/manifest.awk — validates a canonical Tropos manifest (spec §5.3) and prints one platform's fields.
# Usage: awk -v want=<platform> -f manifest.awk manifest.json
# Prints version= (and sha256=, size=, zst_sha256=, zst_size= when want is set); exits 1 on any deviation.
# Callers must also check that the file's last byte is a newline. install.sh embeds an identical copy of this
# program between its "manifest-awk" markers (checked by test/install/parity.test.ts). No single quotes here.
function fail(msg) { printf "manifest: %s\n", msg > "/dev/stderr"; exit 1 }
function strip(s, pre, post) {
  if (index(s, pre) != 1) return ""
  s = substr(s, length(pre) + 1)
  if (length(post) > length(s) || substr(s, length(s) - length(post) + 1) != post) return ""
  return substr(s, 1, length(s) - length(post))
}
function is_hex(s, n) { return length(s) == n && s ~ /^[0-9a-f]+$/ }
function is_size(s) { return s ~ /^[1-9][0-9]*$/ && length(s) <= 10 && s + 0 <= 1073741824 }
function field(i, pre, post, what,    v) { v = strip(L[i], pre, post); if (v == "") fail("line " i ": expected " what); return v }
{ L[NR] = $0 }
END {
  if (NR != 68) fail("expected 68 lines, found " NR)
  np = split("darwin-arm64 darwin-x64 linux-x64 linux-arm64 linux-x64-musl linux-arm64-musl", P, " ")
  if (L[1] != "{") fail("line 1")
  if (L[2] != "  \"schema\": 1,") fail("line 2: schema")
  version = field(3, "  \"version\": \"", "\",", "version")
  if (length(version) > 32 || version !~ /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/) fail("bad version")
  if (!is_hex(field(4, "  \"commit\": \"", "\",", "commit"), 40)) fail("bad commit")
  d = field(5, "  \"buildDate\": \"", "\",", "buildDate")
  if (d !~ /^[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z$/) fail("bad buildDate")
  if (L[6] != "  \"platforms\": {") fail("line 6: platforms")
  found = 0
  for (k = 1; k <= np; k++) {
    p = P[k]; b = 7 + (k - 1) * 10
    if (L[b] != "    \"" p "\": {") fail("line " b ": expected platform " p)
    if (L[b + 1] != "      \"asset\": \"tropos-" p "\",") fail("line " (b + 1) ": asset")
    sha = field(b + 2, "      \"sha256\": \"", "\",", "sha256"); if (!is_hex(sha, 64)) fail("bad sha256 for " p)
    size = field(b + 3, "      \"size\": ", ",", "size"); if (!is_size(size)) fail("bad size for " p)
    if (L[b + 4] != "      \"zst\": {") fail("line " (b + 4) ": zst")
    if (L[b + 5] != "        \"asset\": \"tropos-" p ".zst\",") fail("line " (b + 5) ": zst asset")
    zsha = field(b + 6, "        \"sha256\": \"", "\",", "zst sha256"); if (!is_hex(zsha, 64)) fail("bad zst sha256 for " p)
    zsize = field(b + 7, "        \"size\": ", "", "zst size"); if (!is_size(zsize)) fail("bad zst size for " p)
    if (L[b + 8] != "      }") fail("line " (b + 8))
    if (L[b + 9] != (k < np ? "    }," : "    }")) fail("line " (b + 9))
    if (p == want) { found = 1; osha = sha; osize = size; ozsha = zsha; ozsize = zsize }
  }
  if (L[67] != "  }" || L[68] != "}") fail("closing lines")
  if (want != "" && !found) fail("no entry for " want)
  printf "version=%s\n", version
  if (want != "") printf "sha256=%s\nsize=%s\nzst_sha256=%s\nzst_size=%s\n", osha, osize, ozsha, ozsize
}
```

- [ ] **Step 4: Write `make-manifest.sh`**

```sh
#!/bin/sh
# scripts/release/make-manifest.sh <version> <commit> <build-date> <assets-dir>
# Prints the canonical manifest (spec §5.3) for tropos-<platform> and tropos-<platform>.zst in <assets-dir>.
# Runs only from a checkout of main (spec §6.2). The caller validates the output with manifest.awk and manifest.ts.
set -eu
[ $# -eq 4 ] || { echo "usage: make-manifest.sh <version> <commit> <build-date> <assets-dir>" >&2; exit 64; }
version=$1 commit=$2 build_date=$3 dir=$4

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sum=$(sha256sum "$1"); else sum=$(shasum -a 256 "$1"); fi
  printf '%s\n' "${sum%% *}"
}
size_of() {
  n=$(wc -c < "$1")
  printf '%s\n' $n
}

printf '{\n  "schema": 1,\n  "version": "%s",\n  "commit": "%s",\n  "buildDate": "%s",\n  "platforms": {\n' "$version" "$commit" "$build_date"
n=0
for p in darwin-arm64 darwin-x64 linux-x64 linux-arm64 linux-x64-musl linux-arm64-musl; do
  n=$((n + 1))
  raw="$dir/tropos-$p"
  zst="$raw.zst"
  if [ ! -f "$raw" ] || [ ! -f "$zst" ]; then
    echo "make-manifest: missing $raw or $zst" >&2
    exit 1
  fi
  raw_sha=$(sha256_of "$raw"); raw_size=$(size_of "$raw")
  zst_sha=$(sha256_of "$zst"); zst_size=$(size_of "$zst")
  printf '    "%s": {\n      "asset": "tropos-%s",\n      "sha256": "%s",\n      "size": %s,\n' "$p" "$p" "$raw_sha" "$raw_size"
  printf '      "zst": {\n        "asset": "tropos-%s.zst",\n        "sha256": "%s",\n        "size": %s\n      }\n' "$p" "$zst_sha" "$zst_size"
  if [ "$n" -lt 6 ]; then printf '    },\n'; else printf '    }\n'; fi
done
printf '  }\n}\n'
```

Note: `make-manifest.sh` prints the header before checking assets, so on a missing asset stdout holds a partial manifest; callers redirect to a file and treat a non-zero exit as failure (Task 27).

- [ ] **Step 5: Run to see it pass**

Run: `chmod +x scripts/release/make-manifest.sh && bun test test/install/manifest-parity.test.ts`
Expected: PASS for every awk found on this machine (at least `awk`; on macOS that is BWK awk, on Ubuntu mawk, on Alpine busybox).

- [ ] **Step 6: Commit**

```bash
git add scripts/release/make-manifest.sh scripts/release/manifest.awk test/install/manifest-parity.test.ts
git commit -m "feat(release): canonical manifest writer and awk validator in parity with manifest.ts

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## M2 — Network layer

### Task 8: Bounded downloads and validated zstd decompression

Spec: §10.4 (`fetch.ts`), §10.3 step 4 (zstd), §4.4 (bombs), tests R8.1–R8.2. Measured on Bun 1.4 while planning: the streaming decoder **raises** for trailing garbage and corrupted data, but returns **without error** for a truncated frame (0 bytes), an empty file (0 bytes) and two concatenated frames (double output) — so the byte-count guard and the exact-size check are what reject those.

**Files:**
- Create: `src/install/fetch.ts`, `src/install/fetch.test.ts`
- Create: `src/install/decompress.ts`, `src/install/decompress.test.ts`
- Create: `test/install/helpers/zstd-corpus.ts`

**Interfaces:**
- Consumes: `InstallError`, `fromFsError` (Task 3)
- Produces: `type FetchLike = (url: string, init?: RequestInit) => Promise<Response>`, `interface FetchOptions { maxBytes: number; timeoutMs: number; idleTimeoutMs?: number; fetch?: FetchLike; allowLoopbackHttp?: boolean }`, `fetchBytes(url, opts): Promise<Uint8Array>`, `interface DownloadResult { size: number; sha256: string }`, `downloadToFile(url, dest, opts): Promise<DownloadResult>` (creates `dest` with `wx`, mode 0600; leaves a partial file on failure — callers delete staging files)
- Produces: `decompressZstdFile(src: string, dest: string, expected: { size: number; sha256: string }): Promise<void>` (throws `integrity`)
- Produces (tests): `interface ZstdCase { name: string; zst: Uint8Array; promised: Uint8Array; valid: boolean }`, `zstdCorpus(raw?: Uint8Array): ZstdCase[]`, `expectedOf(c): { size: number; sha256: string }`, `sha256Hex(bytes): string`

- [ ] **Step 1: Write the zstd corpus**

```ts
// test/install/helpers/zstd-corpus.ts
// The shared zstd corpus (spec R8.1): decompress.ts and install.sh must reject every invalid case.
// Each case carries the bytes the manifest promises (`promised`), so a test can serve them as an
// honest raw fallback and check that only the .zst is rejected.
export interface ZstdCase {
  name: string;
  zst: Uint8Array;
  promised: Uint8Array;
  valid: boolean;
}

export const sha256Hex = (b: Uint8Array) => new Bun.CryptoHasher("sha256").update(b).digest("hex");
export const expectedOf = (c: ZstdCase) => ({ size: c.promised.length, sha256: sha256Hex(c.promised) });

const concat = (...parts: Array<Uint8Array | string>) => new Uint8Array(Buffer.concat(parts.map((p) => (typeof p === "string" ? Buffer.from(p) : Buffer.from(p)))));

/** `raw` must be at least 16 bytes; its second-to-last byte is flipped for the wrong-sha256 case. */
export function zstdCorpus(raw: Uint8Array = new Uint8Array(65536).map((_, i) => (i * 7919) % 251)): ZstdCase[] {
  const good = Bun.zstdCompressSync(raw);
  const flipped = new Uint8Array(good);
  flipped[flipped.length - 2]! ^= 0xff;
  const altered = new Uint8Array(raw);
  altered[altered.length - 2]! ^= 0x01;
  return [
    { name: "good", zst: good, promised: raw, valid: true },
    { name: "truncated-frame", zst: good.subarray(0, good.length - 7), promised: raw, valid: false },
    { name: "trailing-garbage", zst: concat(good, "garbage"), promised: raw, valid: false },
    { name: "extra-frame", zst: concat(good, good), promised: raw, valid: false },
    { name: "corrupted-checksum", zst: flipped, promised: raw, valid: false },
    { name: "not-zstd", zst: concat("not zstd at all"), promised: raw, valid: false },
    { name: "empty", zst: new Uint8Array(0), promised: raw, valid: false },
    { name: "output-one-byte-too-long", zst: good, promised: raw.subarray(0, raw.length - 1), valid: false },
    { name: "output-one-byte-too-short", zst: Bun.zstdCompressSync(raw.subarray(0, raw.length - 1)), promised: raw, valid: false },
    { name: "wrong-sha256", zst: good, promised: altered, valid: false },
    { name: "bomb", zst: Bun.zstdCompressSync(new Uint8Array(64 * 1024 * 1024)), promised: raw, valid: false },
  ];
}
```

- [ ] **Step 2: Write the failing tests**

```ts
// src/install/decompress.test.ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expectedOf, zstdCorpus } from "../../test/install/helpers/zstd-corpus";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import { decompressZstdFile } from "./decompress";
import { InstallError } from "./errors";

let dir: string;
beforeAll(async () => {
  dir = await makeTmpDir();
});
afterAll(() => removeDir(dir));

describe("decompressZstdFile", () => {
  for (const c of zstdCorpus()) {
    test(`${c.valid ? "accepts" : "rejects"} ${c.name}`, async () => {
      const src = join(dir, `${c.name}.zst`);
      const dest = join(dir, `${c.name}.out`);
      await writeFile(src, c.zst);
      const expected = expectedOf(c);
      const run = decompressZstdFile(src, dest, expected);
      if (c.valid) {
        await run;
        expect((await stat(dest)).size).toBe(expected.size);
      } else {
        const err = await run.then(() => null, (e: unknown) => e);
        expect(err).toBeInstanceOf(InstallError);
        expect((err as InstallError).kind).toBe("integrity");
        // Never more than the promised size on disk, whatever the input expands to.
        const written = await stat(dest).then((s) => s.size, () => 0);
        expect(written).toBeLessThanOrEqual(expected.size);
      }
    });
  }

  test("refuses to overwrite an existing destination", async () => {
    const c = zstdCorpus()[0]!;
    const src = join(dir, "again.zst");
    const dest = join(dir, "again.out");
    await writeFile(src, c.zst);
    await writeFile(dest, "existing");
    await expect(decompressZstdFile(src, dest, expectedOf(c))).rejects.toThrow();
  });
});
```

```ts
// src/install/fetch.test.ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import { InstallError } from "./errors";
import { downloadToFile, fetchBytes } from "./fetch";

let dir: string;
let server: ReturnType<typeof Bun.serve>;
let base: string;

beforeAll(async () => {
  dir = await makeTmpDir();
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const { pathname, origin } = new URL(req.url);
      if (pathname === "/ok") return new Response("hello");
      if (pathname === "/redirect") return Response.redirect(`${origin}/ok`, 302);
      if (pathname === "/loop") return Response.redirect(`${origin}/loop`, 302);
      if (pathname === "/to-http") return Response.redirect("http://example.com/x", 302);
      if (pathname === "/big") return new Response("x".repeat(1000));
      if (pathname === "/slow-headers") {
        await Bun.sleep(500);
        return new Response("late");
      }
      if (pathname === "/stall") {
        return new Response(
          new ReadableStream({
            async start(c) {
              c.enqueue(new TextEncoder().encode("first"));
              await Bun.sleep(1000);
              c.close();
            },
          }),
        );
      }
      if (pathname === "/500") return new Response("<html>oops</html>", { status: 500 });
      return new Response("<html>nope</html>", { status: 404 });
    },
  });
  base = `http://127.0.0.1:${server.port}`;
});
afterAll(async () => {
  server.stop(true);
  await removeDir(dir);
});

const opts = { maxBytes: 100, timeoutMs: 2000, allowLoopbackHttp: true };
const failure = async (p: Promise<unknown>) => (await p.then(() => null, (e: unknown) => e)) as InstallError;

describe("fetchBytes", () => {
  test("returns the body", async () => {
    expect(new TextDecoder().decode(await fetchBytes(`${base}/ok`, opts))).toBe("hello");
  });

  test("follows redirects", async () => {
    expect(new TextDecoder().decode(await fetchBytes(`${base}/redirect`, opts))).toBe("hello");
  });

  test("refuses plain http unless loopback was allowed in code", async () => {
    const e = await failure(fetchBytes(`${base}/ok`, { ...opts, allowLoopbackHttp: false }));
    expect(e.kind).toBe("integrity");
    expect(e.message).toStartWith("refusing a non-HTTPS URL");
  });

  test("refuses a redirect to plain http", async () => {
    expect((await failure(fetchBytes(`${base}/to-http`, opts))).message).toBe("refusing a non-HTTPS URL: http://example.com/x");
  });

  test("stops after 5 redirects", async () => {
    expect((await failure(fetchBytes(`${base}/loop`, opts))).message).toStartWith("too many redirects");
  });

  test("non-200 is a network error", async () => {
    const e = await failure(fetchBytes(`${base}/500`, opts));
    expect(e.kind).toBe("network");
    expect(e.message).toBe(`127.0.0.1:${server.port} answered HTTP 500 for /500`);
    expect((await failure(fetchBytes(`${base}/missing`, opts))).kind).toBe("network");
  });

  test("a body over maxBytes is an integrity error", async () => {
    expect((await failure(fetchBytes(`${base}/big`, opts))).kind).toBe("integrity");
  });

  test("timeout", async () => {
    const e = await failure(fetchBytes(`${base}/slow-headers`, { ...opts, timeoutMs: 100 }));
    expect(e.kind).toBe("network");
    expect(e.message).toContain("did not respond within 0.1 s");
  });

  test("connection refused is a network error", async () => {
    const e = await failure(fetchBytes("http://127.0.0.1:9/x", opts));
    expect(e.kind).toBe("network");
    expect(e.message).toStartWith("could not reach 127.0.0.1:9");
  });
});

describe("downloadToFile", () => {
  test("writes, hashes and counts", async () => {
    const dest = join(dir, "ok.bin");
    const r = await downloadToFile(`${base}/ok`, dest, opts);
    expect(r).toEqual({ size: 5, sha256: new Bun.CryptoHasher("sha256").update("hello").digest("hex") });
    expect(await readFile(dest, "utf8")).toBe("hello");
  });

  test("never overwrites an existing file", async () => {
    const dest = join(dir, "exists.bin");
    await Bun.write(dest, "keep");
    await expect(downloadToFile(`${base}/ok`, dest, opts)).rejects.toThrow();
    expect(await readFile(dest, "utf8")).toBe("keep");
  });

  test("stops at maxBytes", async () => {
    expect((await failure(downloadToFile(`${base}/big`, join(dir, "big.bin"), opts))).kind).toBe("integrity");
  });

  test("fails when the stream stalls", async () => {
    const e = await failure(downloadToFile(`${base}/stall`, join(dir, "stall.bin"), { ...opts, idleTimeoutMs: 200 }));
    expect(e.kind).toBe("network");
    expect(e.message).toContain("stalled");
  });
});
```

- [ ] **Step 3: Run to see them fail**

Run: `bun test src/install/fetch.test.ts src/install/decompress.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 4: Implement `fetch.ts`**

```ts
// src/install/fetch.ts
import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { InstallError, fromFsError } from "./errors";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface FetchOptions {
  /** Fail as soon as the body exceeds this many bytes. */
  maxBytes: number;
  /** Time allowed for the response headers (fetchBytes: for the whole body). */
  timeoutMs: number;
  /** downloadToFile: fail when no data arrives for this long. Default 30 s. */
  idleTimeoutMs?: number;
  fetch?: FetchLike;
  /** Set only by tests, in code — never from the environment: allow http to 127.0.0.1/localhost. */
  allowLoopbackHttp?: boolean;
}

export interface DownloadResult {
  size: number;
  sha256: string;
}

const MAX_REDIRECTS = 5;

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function checkUrl(url: string, allowLoopbackHttp: boolean): void {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new InstallError("integrity", `invalid download URL: ${url}`);
  }
  if (u.protocol === "https:") return;
  if (allowLoopbackHttp && u.protocol === "http:" && (u.hostname === "127.0.0.1" || u.hostname === "localhost")) return;
  throw new InstallError("integrity", `refusing a non-HTTPS URL: ${url}`);
}

const timedOut = (url: string, ms: number) => new InstallError("network", `${hostOf(url)} did not respond within ${ms / 1000} s`);

async function openOk(url: string, opts: FetchOptions, signal: AbortSignal): Promise<Response> {
  const doFetch = opts.fetch ?? fetch;
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    checkUrl(current, opts.allowLoopbackHttp ?? false);
    let res: Response;
    try {
      res = await doFetch(current, { redirect: "manual", signal });
    } catch (e) {
      if (signal.aborted) throw timedOut(current, opts.timeoutMs);
      throw new InstallError("network", `could not reach ${hostOf(current)}: ${(e as Error).message}`, { cause: e });
    }
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      await res.body?.cancel();
      if (!location) throw new InstallError("network", `${hostOf(current)} sent a redirect without a location`);
      current = new URL(location, current).toString();
      continue;
    }
    if (res.status === 200) return res;
    await res.body?.cancel();
    throw new InstallError("network", `${hostOf(current)} answered HTTP ${res.status} for ${new URL(current).pathname}`);
  }
  throw new InstallError("network", `too many redirects for ${url}`);
}

/** Small downloads (pointers, manifests, signatures): the whole transfer must finish within timeoutMs. */
export async function fetchBytes(url: string, opts: FetchOptions): Promise<Uint8Array> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  try {
    const res = await openOk(url, opts, controller.signal);
    const chunks: Uint8Array[] = [];
    let total = 0;
    if (res.body) {
      try {
        for await (const chunk of res.body) {
          total += chunk.length;
          if (total > opts.maxBytes) throw new InstallError("integrity", `${hostOf(url)} sent more than ${opts.maxBytes} bytes`);
          chunks.push(chunk);
        }
      } catch (e) {
        if (e instanceof InstallError) throw e;
        if (controller.signal.aborted) throw timedOut(url, opts.timeoutMs);
        throw new InstallError("network", `download from ${hostOf(url)} failed: ${(e as Error).message}`, { cause: e });
      }
    }
    return new Uint8Array(Buffer.concat(chunks));
  } finally {
    clearTimeout(timer);
  }
}

/** Large downloads (binaries): headers within timeoutMs, then no gap longer than idleTimeoutMs. Hashes while writing. */
export async function downloadToFile(url: string, dest: string, opts: FetchOptions): Promise<DownloadResult> {
  const idle = opts.idleTimeoutMs ?? 30_000;
  const controller = new AbortController();
  let timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  const arm = (ms: number) => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(), ms);
  };
  let file;
  try {
    file = await open(dest, "wx", 0o600);
  } catch (e) {
    throw fromFsError(e, `creating ${dest}`);
  }
  const hash = createHash("sha256");
  let total = 0;
  try {
    const res = await openOk(url, opts, controller.signal);
    arm(idle);
    if (res.body) {
      try {
        for await (const chunk of res.body) {
          total += chunk.length;
          if (total > opts.maxBytes) throw new InstallError("integrity", `${hostOf(url)} sent more than the expected ${opts.maxBytes} bytes`);
          hash.update(chunk);
          try {
            await file.write(chunk);
          } catch (e) {
            throw fromFsError(e, `writing ${dest}`);
          }
          arm(idle);
        }
      } catch (e) {
        if (e instanceof InstallError || (e as NodeJS.ErrnoException).code) throw e;
        if (controller.signal.aborted) throw new InstallError("network", `download from ${hostOf(url)} stalled for ${idle / 1000} s`);
        throw new InstallError("network", `download from ${hostOf(url)} failed: ${(e as Error).message}`, { cause: e });
      }
    }
    await file.sync();
    return { size: total, sha256: hash.digest("hex") };
  } finally {
    clearTimeout(timer);
    await file.close();
  }
}
```

- [ ] **Step 5: Implement `decompress.ts`**

```ts
// src/install/decompress.ts
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createZstdDecompress } from "node:zlib";
import { InstallError } from "./errors";

/**
 * Decompresses an already hash-verified .zst into `dest` (created, never overwritten).
 * The decoder reports corrupt frames and trailing data; the byte guard stops extra frames and bombs
 * before they are written; the exact size and sha256 catch truncated or empty input (spec §10.3 step 4).
 */
export async function decompressZstdFile(src: string, dest: string, expected: { size: number; sha256: string }): Promise<void> {
  const hash = createHash("sha256");
  let count = 0;
  const guard = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      count += chunk.length;
      if (count > expected.size) {
        done(new InstallError("integrity", `decompressed data exceeds the expected ${expected.size} bytes`));
        return;
      }
      hash.update(chunk);
      done(null, chunk);
    },
  });
  try {
    await pipeline(createReadStream(src), createZstdDecompress(), guard, createWriteStream(dest, { flags: "wx", mode: 0o600 }));
  } catch (e) {
    if (e instanceof InstallError) throw e;
    if ((e as NodeJS.ErrnoException).code === "EEXIST") throw e;
    throw new InstallError("integrity", `zstd data is invalid: ${(e as Error).message}`, { cause: e });
  }
  if (count !== expected.size) throw new InstallError("integrity", `decompressed ${count} bytes, expected ${expected.size}`);
  if (hash.digest("hex") !== expected.sha256) throw new InstallError("integrity", "decompressed data does not match the manifest's sha256");
}
```

- [ ] **Step 6: Run to see them pass**

Run: `bun test src/install/fetch.test.ts src/install/decompress.test.ts && bun run typecheck`
Expected: PASS. If the `bomb` case writes more than 4096 bytes, the guard is not ahead of the writer — fix by keeping the guard before `createWriteStream` (as above), not after.

- [ ] **Step 7: Commit**

```bash
git add src/install/fetch.ts src/install/fetch.test.ts src/install/decompress.ts src/install/decompress.test.ts test/install/helpers/zstd-corpus.ts
git commit -m "feat(install): bounded HTTPS downloads and exact-size zstd decompression

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 9: Release URLs, retries, verified manifests and channel resolution

Spec: §5.4 (slots), §10.4, §8.2 step 5 (same order in `install.sh`), Review Focus 5. With decision D1-B (Task 2), only `CHANNELS_REPO` changes here.

**Files:**
- Create: `src/install/urls.ts`, `src/install/urls.test.ts`
- Create: `src/install/remote.ts`, `src/install/remote.test.ts`
- Create: `src/install/channels.ts`, `src/install/channels.test.ts`
- Create: `test/install/helpers/release-server.ts`

**Interfaces:**
- Consumes: `fetchBytes`, `FetchLike` (Task 8); `verifyManifest`, `expectVersion`, `MAX_MANIFEST_BYTES`, `VerifiedManifest` (Task 6); `TrustedKey` (Task 5); `isVersion` (Task 3); `InstallError` (Task 3)
- Produces: `interface ReleaseUrls { channel(slot: string): string; asset(version: string, name: string): string; latestAsset(name: string): string }`, `RELEASE_REPO`, `CHANNELS_REPO`, `githubReleaseUrls(opts?: { base?: string; repo?: string; channelsRepo?: string }): ReleaseUrls`, `RELEASE_URLS`
- Produces: `interface RemoteDeps { urls: ReleaseUrls; trusted: readonly TrustedKey[]; fetch?: FetchLike; sleep?: (ms: number) => Promise<void>; random?: () => number; allowLoopbackHttp?: boolean }`, `SMALL_TIMEOUT_MS = 10000`, `backoffDelays(random?): number[]`, `withRetries<T>(attempt, deps): Promise<T>`, `fetchPointer(url, deps): Promise<string>`, `fetchVersionManifest(version, deps): Promise<VerifiedManifest>`, `fetchLatestReleaseManifest(deps): Promise<VerifiedManifest>`
- Produces: `CHANNELS = ["latest", "stable"] as const`, `type Channel`, `isChannel(s)`, `interface Resolution { channel: Channel; version: string; source: "primary" | "backup" | "github-latest" }`, `resolveChannel(channel, deps): Promise<Resolution>`
- Produces (tests): `startReleaseServer(): ReleaseServer` with `base`, `urls`, `requests`, `put(tag, name, data)`, `remove(tag, name)`, `setLatest(tag | null)`, `failNext(tag, name, status, times?)`, `stop()`

- [ ] **Step 1: Write the release server helper**

```ts
// test/install/helpers/release-server.ts
// A local stand-in for GitHub Releases with the same URL shapes, including the releases/latest redirect.
import { githubReleaseUrls, type ReleaseUrls } from "../../../src/install/urls";

export interface ReleaseServer {
  base: string;
  urls: ReleaseUrls;
  requests: string[];
  put(tag: string, name: string, data: Uint8Array | string): void;
  remove(tag: string, name: string): void;
  setLatest(tag: string | null): void;
  failNext(tag: string, name: string, status: number, times?: number): void;
  stop(): void;
}

export const TEST_REPO = "t/r";

export function startReleaseServer(): ReleaseServer {
  const assets = new Map<string, Uint8Array>();
  const failures = new Map<string, { status: number; times: number }>();
  const requests: string[] = [];
  let latest: string | null = null;
  const prefix = `/${TEST_REPO}/releases/`;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const { pathname, origin } = new URL(req.url);
      requests.push(pathname);
      if (!pathname.startsWith(prefix)) return new Response("<html>Not Found</html>", { status: 404 });
      const rest = pathname.slice(prefix.length);
      const viaLatest = /^latest\/download\/([^/]+)$/.exec(rest);
      if (viaLatest) {
        return latest ? Response.redirect(`${origin}${prefix}download/${latest}/${viaLatest[1]}`, 302) : new Response("<html>Not Found</html>", { status: 404 });
      }
      const direct = /^download\/([^/]+)\/([^/]+)$/.exec(rest);
      if (!direct) return new Response("<html>Not Found</html>", { status: 404 });
      const key = `${direct[1]}/${direct[2]}`;
      const failure = failures.get(key);
      if (failure && failure.times > 0) {
        failure.times--;
        return new Response("<html>error</html>", { status: failure.status });
      }
      const data = assets.get(key);
      return data ? new Response(data) : new Response("<html>Not Found</html>", { status: 404 });
    },
  });
  const base = `http://127.0.0.1:${server.port}`;
  return {
    base,
    urls: githubReleaseUrls({ base, repo: TEST_REPO, channelsRepo: TEST_REPO }),
    requests,
    put: (tag, name, data) => void assets.set(`${tag}/${name}`, typeof data === "string" ? new TextEncoder().encode(data) : data),
    remove: (tag, name) => void assets.delete(`${tag}/${name}`),
    setLatest: (tag) => void (latest = tag),
    failNext: (tag, name, status, times = 1) => void failures.set(`${tag}/${name}`, { status, times }),
    stop: () => void server.stop(true),
  };
}
```

- [ ] **Step 2: Write the failing tests**

```ts
// src/install/urls.test.ts
import { describe, expect, test } from "bun:test";
import { RELEASE_URLS, githubReleaseUrls } from "./urls";

describe("release URLs", () => {
  test("production URLs (spec §5.4)", () => {
    expect(RELEASE_URLS.channel("latest")).toBe("https://github.com/Tropos-AI/tropos-code/releases/download/channels/latest");
    expect(RELEASE_URLS.channel("stable.bak")).toBe("https://github.com/Tropos-AI/tropos-code/releases/download/channels/stable.bak");
    expect(RELEASE_URLS.asset("1.2.3", "manifest.json")).toBe("https://github.com/Tropos-AI/tropos-code/releases/download/v1.2.3/manifest.json");
    expect(RELEASE_URLS.latestAsset("manifest.json")).toBe("https://github.com/Tropos-AI/tropos-code/releases/latest/download/manifest.json");
  });

  test("a separate channels repository (decision D1-B)", () => {
    const u = githubReleaseUrls({ channelsRepo: "o/channels" });
    expect(u.channel("latest")).toBe("https://github.com/o/channels/releases/download/channels/latest");
    expect(u.asset("1.0.0", "x")).toBe("https://github.com/Tropos-AI/tropos-code/releases/download/v1.0.0/x");
  });

  test("refuses to build URLs from non-versions or odd names", () => {
    expect(() => RELEASE_URLS.asset("../1.0.0", "x")).toThrow("not a version");
    expect(() => RELEASE_URLS.asset("1.0.0", "../x")).toThrow("bad asset name");
    expect(() => RELEASE_URLS.channel("latest/../x")).toThrow("bad channel slot");
  });
});
```

```ts
// src/install/remote.test.ts
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { serializeManifest } from "./manifest";
import { InstallError } from "./errors";
import { backoffDelays, fetchLatestReleaseManifest, fetchPointer, fetchVersionManifest, withRetries } from "./remote";
import { sampleManifest } from "../../test/install/helpers/manifest-corpus";
import { makeTestKey, sshSign, type TestKey } from "../../test/install/helpers/keys";
import { startReleaseServer, type ReleaseServer } from "../../test/install/helpers/release-server";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";

let dir: string;
let key: TestKey;
let srv: ReleaseServer;
const sleeps: number[] = [];
const deps = () => ({ urls: srv.urls, trusted: key.trusted, sleep: async (ms: number) => void sleeps.push(ms), random: () => 0.5, allowLoopbackHttp: true });

beforeAll(async () => {
  dir = await makeTmpDir();
  key = await makeTestKey(dir, "k");
});
afterAll(() => removeDir(dir));
beforeEach(() => {
  srv?.stop();
  srv = startReleaseServer();
  sleeps.length = 0;
});

async function publish(version: string) {
  const bytes = serializeManifest(sampleManifest(version));
  srv.put(`v${version}`, "manifest.json", bytes);
  srv.put(`v${version}`, "manifest.json.sig", await sshSign(key, bytes, "tropos-manifest", dir));
}

describe("backoff and retries", () => {
  test("1 s, 2 s, 4 s with ±20 % jitter", () => {
    expect(backoffDelays(() => 0.5)).toEqual([1000, 2000, 4000]);
    expect(backoffDelays(() => 0)).toEqual([800, 1600, 3200]);
    expect(backoffDelays(() => 0.999999)).toEqual([1200, 2400, 4800]);
  });

  test("retries network errors only, 3 attempts, sleeping 1 s then 2 s", async () => {
    let calls = 0;
    const err = await withRetries(async () => {
      calls++;
      throw new InstallError("network", "down");
    }, deps()).catch((e) => e);
    expect(calls).toBe(3);
    expect(sleeps).toEqual([1000, 2000]);
    expect((err as InstallError).message).toBe("down");
  });

  test("does not retry integrity errors", async () => {
    let calls = 0;
    await withRetries(async () => {
      calls++;
      throw new InstallError("integrity", "bad");
    }, deps()).catch(() => {});
    expect(calls).toBe(1);
  });
});

describe("fetchPointer", () => {
  test("reads a version with or without the final newline", async () => {
    srv.put("channels", "latest", "1.2.3\n");
    srv.put("channels", "stable", "1.2.0");
    expect(await fetchPointer(srv.urls.channel("latest"), deps())).toBe("1.2.3");
    expect(await fetchPointer(srv.urls.channel("stable"), deps())).toBe("1.2.0");
  });

  test.each([["html", "<html>Not Found</html>"], ["two lines", "1.2.3\n1.2.4\n"], ["spaces", " 1.2.3\n"], ["prerelease", "1.2.3-rc\n"]])(
    "%s counts as a failed attempt and is retried",
    async (_n, body) => {
      srv.put("channels", "latest", body);
      const e = await fetchPointer(srv.urls.channel("latest"), deps()).catch((x) => x);
      expect((e as InstallError).kind).toBe("network");
      expect(srv.requests.filter((r) => r.endsWith("/channels/latest")).length).toBe(3);
    },
  );

  test("recovers when a 500 is followed by success", async () => {
    srv.put("channels", "latest", "1.2.3\n");
    srv.failNext("channels", "latest", 500, 2);
    expect(await fetchPointer(srv.urls.channel("latest"), deps())).toBe("1.2.3");
  });
});

describe("manifests", () => {
  test("fetchVersionManifest verifies signature and version", async () => {
    await publish("1.2.3");
    expect((await fetchVersionManifest("1.2.3", deps())).manifest.version).toBe("1.2.3");
  });

  test("a manifest served under another version's tag is rejected", async () => {
    await publish("1.2.3");
    srv.put("v1.2.4", "manifest.json", serializeManifest(sampleManifest("1.2.3")));
    srv.put("v1.2.4", "manifest.json.sig", await sshSign(key, serializeManifest(sampleManifest("1.2.3")), "tropos-manifest", dir));
    await expect(fetchVersionManifest("1.2.4", deps())).rejects.toThrow("manifest is for version 1.2.3, expected 1.2.4");
  });

  test("fetchLatestReleaseManifest follows GitHub's latest redirect", async () => {
    await publish("2.0.0");
    srv.setLatest("v2.0.0");
    expect((await fetchLatestReleaseManifest(deps())).manifest.version).toBe("2.0.0");
  });
});
```

```ts
// src/install/channels.test.ts
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { resolveChannel } from "./channels";
import { InstallError } from "./errors";
import { serializeManifest } from "./manifest";
import { sampleManifest } from "../../test/install/helpers/manifest-corpus";
import { makeTestKey, sshSign, type TestKey } from "../../test/install/helpers/keys";
import { startReleaseServer, type ReleaseServer } from "../../test/install/helpers/release-server";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";

let dir: string;
let key: TestKey;
let srv: ReleaseServer;
const sleeps: number[] = [];
const deps = (extra = {}) => ({ urls: srv.urls, trusted: key.trusted, sleep: async (ms: number) => void sleeps.push(ms), random: () => 0.5, allowLoopbackHttp: true, ...extra });

beforeAll(async () => {
  dir = await makeTmpDir();
  key = await makeTestKey(dir, "k");
});
afterAll(() => removeDir(dir));
beforeEach(() => {
  srv?.stop();
  srv = startReleaseServer();
  sleeps.length = 0;
});

describe("resolveChannel", () => {
  test("primary slot", async () => {
    srv.put("channels", "latest", "1.0.0\n");
    srv.put("channels", "latest.bak", "0.9.0\n");
    expect(await resolveChannel("latest", deps())).toEqual({ channel: "latest", version: "1.0.0", source: "primary" });
  });

  test("falls back to the .bak slot when the primary is missing (the --clobber window, R3.1)", async () => {
    srv.put("channels", "stable.bak", "1.1.0\n");
    expect(await resolveChannel("stable", deps())).toEqual({ channel: "stable", version: "1.1.0", source: "backup" });
    expect(sleeps).toEqual([1000, 2000, 4000]);
  });

  test("latest falls back to GitHub's latest release when both slots fail", async () => {
    const bytes = serializeManifest(sampleManifest("1.3.0"));
    srv.put("v1.3.0", "manifest.json", bytes);
    srv.put("v1.3.0", "manifest.json.sig", await sshSign(key, bytes, "tropos-manifest", dir));
    srv.setLatest("v1.3.0");
    expect(await resolveChannel("latest", deps())).toEqual({ channel: "latest", version: "1.3.0", source: "github-latest" });
  });

  test("stable has no third fallback", async () => {
    srv.setLatest("v9.9.9");
    const e = (await resolveChannel("stable", deps()).catch((x) => x)) as InstallError;
    expect(e.kind).toBe("network");
    expect(e.message).toStartWith("cannot resolve the stable channel");
    expect(e.message).toEndWith("; try again, or install an explicit version");
  });

  test("gives up within the backoff budget when every request fails (Review Focus 5)", async () => {
    const e = (await resolveChannel("latest", deps({ fetch: async () => { throw new Error("offline"); }, random: () => 0.999999 })).catch((x) => x)) as InstallError;
    expect(e.kind).toBe("network");
    expect(sleeps.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(26_000);
  });

  test("an untrusted manifest on the GitHub-latest fallback is an integrity error, not a silent success", async () => {
    const other = await makeTestKey(dir, "other");
    const bytes = serializeManifest(sampleManifest("1.4.0"));
    srv.put("v1.4.0", "manifest.json", bytes);
    srv.put("v1.4.0", "manifest.json.sig", await sshSign(other, bytes, "tropos-manifest", dir));
    srv.setLatest("v1.4.0");
    expect(((await resolveChannel("latest", deps()).catch((x) => x)) as InstallError).kind).toBe("integrity");
  });
});
```

- [ ] **Step 3: Run to see them fail**

Run: `bun test src/install/urls.test.ts src/install/remote.test.ts src/install/channels.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 4: Implement `urls.ts`**

```ts
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
/** Where the `channels` release lives. Decision D1-B (Task 2) moves it to its own repository. */
export const CHANNELS_REPO = "Tropos-AI/tropos-code";

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
```

- [ ] **Step 5: Implement `remote.ts`**

```ts
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

/** 1 s, 2 s, 4 s with ±20 % jitter (spec §10.4); `random` returns a number in [0, 1). */
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
```

- [ ] **Step 6: Implement `channels.ts`**

```ts
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
 * Primary slot, then `.bak`, then (latest only) GitHub's latest release — spec §10.4.
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
```

- [ ] **Step 7: Run to see them pass**

Run: `bun test src/install/urls.test.ts src/install/remote.test.ts src/install/channels.test.ts && bun run typecheck`
Expected: PASS. The "falls back to the .bak slot" test records `[1000, 2000, 4000]`: two waits inside the primary's three attempts, then the 4 s step to `.bak`.

- [ ] **Step 8: Commit**

```bash
git add src/install/urls.ts src/install/urls.test.ts src/install/remote.ts src/install/remote.test.ts src/install/channels.ts src/install/channels.test.ts test/install/helpers/release-server.ts
git commit -m "feat(install): resolve channels through primary and backup slots with retries

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## M3 — Local engine

### Task 10: On-disk layout, safe-directory checks and the minimal environment

Spec: §9, §10.3 pre-switch checks (with amendment A1), §11 environment (with A8).

**Files:**
- Create: `src/install/layout.ts`, `src/install/layout.test.ts`
- Create: `src/install/env.ts`, `src/install/env.test.ts`

**Interfaces:**
- Consumes: `InstallError`, `fromFsError` (Task 3); `isVersion` (Task 3)
- Produces: `interface Layout { data; versions; manifests; staging; state; stateFile; locks; log; binDir; binLink }` (all absolute paths), `resolveLayout(env?, home?): Layout`, `versionPath(l, v)`, `manifestDir(l, v)`, `versionLockPath(l, v)`, `installLockPath(l)`, `ensureLayout(l): Promise<void>`, `interface DirOwner { uid: number; gid: number }`, `currentUser(): DirOwner`, `checkSafeDir(path, user?): Promise<void>`, `nativeVersionOf(l, execPath): string | null`
- Produces: `ENV_ALLOW_LIST`, `minimalEnv(env): Record<string, string>`

- [ ] **Step 1: Write the failing tests**

```ts
// src/install/layout.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import { InstallError } from "./errors";
import { checkSafeDir, currentUser, ensureLayout, installLockPath, manifestDir, nativeVersionOf, resolveLayout, versionLockPath, versionPath } from "./layout";

let dir: string;
beforeEach(async () => {
  dir = await makeTmpDir();
});
afterEach(() => removeDir(dir));

describe("resolveLayout", () => {
  test("defaults under HOME", () => {
    const l = resolveLayout({ HOME: "/h" });
    expect(l).toEqual({
      data: "/h/.local/share/tropos",
      versions: "/h/.local/share/tropos/versions",
      manifests: "/h/.local/share/tropos/manifests",
      staging: "/h/.local/share/tropos/staging",
      state: "/h/.local/state/tropos",
      stateFile: "/h/.local/state/tropos/install.json",
      locks: "/h/.local/state/tropos/locks",
      log: "/h/.local/state/tropos/update.log",
      binDir: "/h/.local/bin",
      binLink: "/h/.local/bin/tropos",
    });
  });

  test("honours absolute XDG variables only", () => {
    expect(resolveLayout({ HOME: "/h", XDG_DATA_HOME: "/d", XDG_STATE_HOME: "/s" }).versions).toBe("/d/tropos/versions");
    expect(resolveLayout({ HOME: "/h", XDG_DATA_HOME: "/d", XDG_STATE_HOME: "/s" }).stateFile).toBe("/s/tropos/install.json");
    expect(resolveLayout({ HOME: "/h", XDG_DATA_HOME: "rel/d" }).data).toBe("/h/.local/share/tropos");
  });

  test("version paths refuse anything that is not a version (path traversal)", () => {
    const l = resolveLayout({ HOME: "/h" });
    expect(versionPath(l, "1.2.3")).toBe("/h/.local/share/tropos/versions/1.2.3");
    expect(manifestDir(l, "1.2.3")).toBe("/h/.local/share/tropos/manifests/1.2.3");
    expect(versionLockPath(l, "1.2.3")).toBe("/h/.local/state/tropos/locks/1.2.3.lock");
    expect(installLockPath(l)).toBe("/h/.local/state/tropos/locks/install.lock");
    for (const bad of ["../x", "1.0.0/../../", "1.2", ""]) expect(() => versionPath(l, bad)).toThrow(InstallError);
  });

  test("ensureLayout creates private directories and works with spaces in HOME", async () => {
    const l = resolveLayout({ HOME: join(dir, "Jane Doe") });
    await ensureLayout(l);
    for (const d of [l.data, l.versions, l.manifests, l.staging, l.state, l.locks]) expect((await stat(d)).mode & 0o777).toBe(0o700);
    expect((await stat(l.binDir)).isDirectory()).toBe(true);
  });
});

describe("checkSafeDir", () => {
  const user = currentUser();

  test("accepts a private directory", async () => {
    await chmod(dir, 0o700);
    await checkSafeDir(dir, user);
  });

  test("accepts group-writable dir owned by the user's primary group (Ubuntu umask 002, amendment A1)", async () => {
    await chmod(dir, 0o775);
    const st = await stat(dir);
    await checkSafeDir(dir, { uid: user.uid, gid: st.gid });
  });

  test("refuses group-writable for another group", async () => {
    await chmod(dir, 0o775);
    const st = await stat(dir);
    await expect(checkSafeDir(dir, { uid: user.uid, gid: st.gid + 1 })).rejects.toThrow("is writable by group");
  });

  test("refuses world-writable", async () => {
    await chmod(dir, 0o777);
    await expect(checkSafeDir(dir, user)).rejects.toThrow("is writable by every user");
  });

  test("refuses another owner", async () => {
    await expect(checkSafeDir(dir, { uid: user.uid + 1, gid: user.gid })).rejects.toThrow("is owned by another user");
  });

  test("refuses a symlink and a file", async () => {
    await mkdir(join(dir, "real"));
    await symlink(join(dir, "real"), join(dir, "link"));
    await writeFile(join(dir, "file"), "");
    await expect(checkSafeDir(join(dir, "link"), user)).rejects.toThrow("is a symbolic link");
    await expect(checkSafeDir(join(dir, "file"), user)).rejects.toThrow("is not a directory");
  });
});

describe("nativeVersionOf", () => {
  test("is the version only for a binary directly inside versions/", async () => {
    const l = resolveLayout({ HOME: dir });
    await ensureLayout(l);
    await writeFile(join(l.versions, "1.2.3"), "");
    expect(nativeVersionOf(l, join(l.versions, "1.2.3"))).toBe("1.2.3");
    expect(nativeVersionOf(l, "/usr/local/bin/bun")).toBeNull();
    expect(nativeVersionOf(l, join(l.versions, "nested", "1.2.3"))).toBeNull();
    expect(nativeVersionOf(l, join(l.versions, "not-a-version"))).toBeNull();
    await symlink(join(l.versions, "1.2.3"), l.binLink);
    expect(nativeVersionOf(l, l.binLink)).toBe("1.2.3");
  });
});
```

```ts
// src/install/env.test.ts
import { describe, expect, test } from "bun:test";
import { minimalEnv } from "./env";

describe("minimalEnv", () => {
  test("keeps only the allow-list (spec §11, amendment A8)", () => {
    const env = minimalEnv({
      HOME: "/h",
      PATH: "/bin",
      TMPDIR: "/t",
      LANG: "en_US.UTF-8",
      LC_ALL: "C",
      XDG_DATA_HOME: "/d",
      XDG_STATE_HOME: "/s",
      HTTPS_PROXY: "http://p",
      https_proxy: "http://p",
      NO_PROXY: "x",
      SSL_CERT_FILE: "/c",
      SSL_CERT_DIR: "/cd",
      TROPOS_HOME: "/th",
      ANTHROPIC_API_KEY: "secret",
      OPENAI_API_KEY: "secret",
      GITHUB_TOKEN: "secret",
      AWS_SECRET_ACCESS_KEY: "secret",
      DEEPSEEK_API_KEY: "secret",
      SHELL: "/bin/zsh",
    });
    expect(env).toEqual({
      HOME: "/h",
      PATH: "/bin",
      TMPDIR: "/t",
      LANG: "en_US.UTF-8",
      LC_ALL: "C",
      XDG_DATA_HOME: "/d",
      XDG_STATE_HOME: "/s",
      HTTPS_PROXY: "http://p",
      https_proxy: "http://p",
      NO_PROXY: "x",
      SSL_CERT_FILE: "/c",
      SSL_CERT_DIR: "/cd",
      TROPOS_HOME: "/th",
    });
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `bun test src/install/layout.test.ts src/install/env.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

```ts
// src/install/layout.ts
import { realpathSync } from "node:fs";
import { lstat, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { InstallError, fromFsError } from "./errors";
import { isVersion } from "./version";

export interface Layout {
  data: string;
  versions: string;
  manifests: string;
  staging: string;
  state: string;
  stateFile: string;
  locks: string;
  log: string;
  binDir: string;
  binLink: string;
}

/** Spec §9. XDG variables count only when absolute; install.sh applies the same rule. */
export function resolveLayout(env: NodeJS.ProcessEnv = process.env, home?: string): Layout {
  const h = home ?? (env.HOME && isAbsolute(env.HOME) ? env.HOME : homedir());
  const xdg = (name: string, fallback: string) => {
    const value = env[name];
    return value && isAbsolute(value) ? value : fallback;
  };
  const data = join(xdg("XDG_DATA_HOME", join(h, ".local", "share")), "tropos");
  const state = join(xdg("XDG_STATE_HOME", join(h, ".local", "state")), "tropos");
  const binDir = join(h, ".local", "bin");
  return {
    data,
    versions: join(data, "versions"),
    manifests: join(data, "manifests"),
    staging: join(data, "staging"),
    state,
    stateFile: join(state, "install.json"),
    locks: join(state, "locks"),
    log: join(state, "update.log"),
    binDir,
    binLink: join(binDir, "tropos"),
  };
}

function checked(v: string): string {
  if (!isVersion(v)) throw new InstallError("integrity", `refusing to use ${JSON.stringify(v)} as a version in a path`);
  return v;
}

export const versionPath = (l: Layout, v: string) => join(l.versions, checked(v));
export const manifestDir = (l: Layout, v: string) => join(l.manifests, checked(v));
export const versionLockPath = (l: Layout, v: string) => join(l.locks, `${checked(v)}.lock`);
export const installLockPath = (l: Layout) => join(l.locks, "install.lock");

export async function ensureLayout(l: Layout): Promise<void> {
  try {
    for (const d of [l.data, l.versions, l.manifests, l.staging, l.state, l.locks]) {
      await mkdir(dirname(d), { recursive: true });
      await mkdir(d, { recursive: true, mode: 0o700 });
    }
    await mkdir(l.binDir, { recursive: true, mode: 0o755 });
  } catch (e) {
    throw fromFsError(e, "creating the install directories");
  }
}

export interface DirOwner {
  uid: number;
  gid: number;
}

export function currentUser(): DirOwner {
  return { uid: process.getuid?.() ?? -1, gid: process.getgid?.() ?? -1 };
}

/**
 * A real directory owned by the user, never world-writable, and group-writable only when the group is
 * the user's primary group (spec §10.3 with amendment A1: Ubuntu's umask 002 and user-private groups).
 */
export async function checkSafeDir(path: string, user: DirOwner = currentUser()): Promise<void> {
  let st;
  try {
    st = await lstat(path);
  } catch (e) {
    throw fromFsError(e, `checking ${path}`);
  }
  if (st.isSymbolicLink()) throw new InstallError("local", `${path} is a symbolic link; refusing to install through it`);
  if (!st.isDirectory()) throw new InstallError("local", `${path} is not a directory`);
  if (st.uid !== user.uid) throw new InstallError("local", `${path} is owned by another user (uid ${st.uid})`);
  if (st.mode & 0o002) throw new InstallError("local", `${path} is writable by every user; fix it with: chmod o-w "${path}"`);
  if (st.mode & 0o020 && st.gid !== user.gid) throw new InstallError("local", `${path} is writable by group ${st.gid}; fix it with: chmod g-w "${path}"`);
}

const real = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

/** The version of a native install running from `execPath` (resolving ~/.local/bin/tropos), or null for dev runs. */
export function nativeVersionOf(l: Layout, execPath: string): string | null {
  const resolved = real(execPath);
  const name = basename(resolved);
  if (!isVersion(name)) return null;
  return real(dirname(resolved)) === real(l.versions) ? name : null;
}
```

```ts
// src/install/env.ts
/** The only variables background updates and health checks receive (spec §11, amendment A8). */
export const ENV_ALLOW_LIST: readonly string[] = [
  "HOME",
  "PATH",
  "TMPDIR",
  "LANG",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
  "https_proxy",
  "http_proxy",
  "no_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "TROPOS_HOME",
];

export function minimalEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && (ENV_ALLOW_LIST.includes(name) || name.startsWith("LC_"))) out[name] = value;
  }
  return out;
}
```

- [ ] **Step 4: Run to see them pass**

Run: `bun test src/install/layout.test.ts src/install/env.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/install/layout.ts src/install/layout.test.ts src/install/env.ts src/install/env.test.ts
git commit -m "feat(install): XDG-aware layout, safe-directory checks and minimal environment

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 11: Kernel file locks

Spec: §10.1 with amendment A6 (never a blocking `flock` call), decision D5 (library names). Concurrency tests run real processes.

**Files:**
- Create: `src/install/flock.ts`, `src/install/flock.test.ts`
- Create: `src/install/locks.ts`
- Create: `test/install/helpers/hold-lock.ts`
- Create: `test/install/locks.test.ts`

**Interfaces:**
- Consumes: `InstallError`, `fromFsError` (Task 3); `Layout`, `installLockPath`, `versionLockPath` (Task 10)
- Produces: `LOCK_SH = 1`, `LOCK_EX = 2`, `LOCK_NB = 4`, `LOCK_UN = 8`, `type FlockFn = (fd: number, op: number) => number`, `libcCandidates(platform?, arch?): string[]`, `loadFlock(candidates?): FlockFn`
- Produces: `interface LockHandle { readonly path: string; readonly fd: number; release(): void }`, `interface LockInfo { pid: number; token: string; version: string; acquiredAt: string }`, `tryLock(path, mode, flock?): LockHandle | null`, `readLockInfo(path): LockInfo | null`, `interface AcquireOptions { wait: boolean; version: string; timeoutMs?: number; pollMs?: number; flock?: FlockFn; sleep?: (ms: number) => Promise<void>; now?: () => number; onWait?: (holder: LockInfo | null) => void }`, `acquireInstallLock(l, opts): Promise<LockHandle | null>`, `tryLockVersionExclusive(l, v, flock?): LockHandle | null`, `lockVersionShared(l, v, opts?): Promise<LockHandle | null>`

- [ ] **Step 1: Write the hold-lock helper**

```ts
// test/install/helpers/hold-lock.ts
// Usage: bun hold-lock.ts <path> <sh|ex>. Locks the file, prints "locked" (or "busy"), then waits to be killed.
import { LOCK_EX, LOCK_SH } from "../../../src/install/flock";
import { tryLock } from "../../../src/install/locks";

const [path, mode] = process.argv.slice(2);
const handle = tryLock(path!, mode === "ex" ? LOCK_EX : LOCK_SH);
console.log(handle ? "locked" : "busy");
if (!handle) process.exit(1);
setInterval(() => {}, 1 << 30);
```

- [ ] **Step 2: Write the failing tests**

```ts
// src/install/flock.test.ts
import { describe, expect, test } from "bun:test";
import { InstallError } from "./errors";
import { libcCandidates, loadFlock } from "./flock";

describe("flock loading", () => {
  test("candidates per platform (decision D5)", () => {
    expect(libcCandidates("darwin", "arm64")).toEqual(["libSystem.B.dylib"]);
    expect(libcCandidates("linux", "x64")).toEqual(["libc.so.6", "/lib/ld-musl-x86_64.so.1", "/lib/libc.musl-x86_64.so.1"]);
    expect(libcCandidates("linux", "arm64")).toEqual(["libc.so.6", "/lib/ld-musl-aarch64.so.1", "/lib/libc.musl-aarch64.so.1"]);
  });

  test("loads on this machine", () => {
    expect(typeof loadFlock()).toBe("function");
  });

  test("no usable library is a local error", () => {
    expect(() => loadFlock(["/nonexistent/libc.so"])).toThrow(InstallError);
    expect(() => loadFlock(["/nonexistent/libc.so"])).toThrow("file locking is unavailable");
  });
});
```

```ts
// test/install/locks.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { renameSync, statSync, symlinkSync, writeFileSync, fstatSync } from "node:fs";
import { join } from "node:path";
import { InstallError } from "../../src/install/errors";
import { LOCK_EX, LOCK_SH, loadFlock } from "../../src/install/flock";
import { ensureLayout, installLockPath, resolveLayout, type Layout } from "../../src/install/layout";
import { acquireInstallLock, lockVersionShared, readLockInfo, tryLock, tryLockVersionExclusive } from "../../src/install/locks";
import { makeTmpDir, removeDir } from "../helpers/tmp";

let dir: string;
let l: Layout;
const children: Array<ReturnType<typeof Bun.spawn>> = [];
beforeEach(async () => {
  dir = await makeTmpDir();
  l = resolveLayout({ HOME: dir });
  await ensureLayout(l);
});
afterEach(async () => {
  for (const c of children.splice(0)) c.kill("SIGKILL");
  await removeDir(dir);
});

async function holdInChild(path: string, mode: "sh" | "ex") {
  const child = Bun.spawn(["bun", join(import.meta.dir, "helpers/hold-lock.ts"), path, mode], { stdout: "pipe" });
  children.push(child);
  const reader = child.stdout.getReader();
  const { value } = await reader.read();
  expect(new TextDecoder().decode(value).trim()).toBe("locked");
  return child;
}

describe("tryLock", () => {
  test("exclusive excludes everything; shared excludes only exclusive", () => {
    const path = join(l.locks, "a.lock");
    const ex = tryLock(path, LOCK_EX)!;
    expect(tryLock(path, LOCK_EX)).toBeNull();
    expect(tryLock(path, LOCK_SH)).toBeNull();
    ex.release();
    const sh1 = tryLock(path, LOCK_SH)!;
    const sh2 = tryLock(path, LOCK_SH)!;
    expect(tryLock(path, LOCK_EX)).toBeNull();
    sh1.release();
    sh2.release();
    expect(tryLock(path, LOCK_EX)).not.toBeNull();
  });

  test("another process holding the lock blocks us; kill -9 releases it at once", async () => {
    const path = join(l.locks, "b.lock");
    const child = await holdInChild(path, "ex");
    expect(tryLock(path, LOCK_EX)).toBeNull();
    child.kill("SIGKILL");
    await child.exited;
    expect(tryLock(path, LOCK_EX)).not.toBeNull();
  });

  test("detects a lock file replaced between open and flock (inode check)", () => {
    const path = join(l.locks, "c.lock");
    writeFileSync(path, "");
    const real = loadFlock();
    let replaced = false;
    const flock = (fd: number, op: number) => {
      const rc = real(fd, op);
      if (!replaced) {
        replaced = true;
        writeFileSync(`${path}.new`, "");
        renameSync(`${path}.new`, path);
      }
      return rc;
    };
    const handle = tryLock(path, LOCK_EX, flock)!;
    expect(fstatSync(handle.fd).ino).toBe(statSync(path).ino);
  });

  test("a lock path that is a symlink is refused", () => {
    const path = join(l.locks, "d.lock");
    symlinkSync(join(dir, "elsewhere"), path);
    expect(() => tryLock(path, LOCK_EX)).toThrow(InstallError);
  });
});

describe("acquireInstallLock", () => {
  test("records who holds it", async () => {
    const h = (await acquireInstallLock(l, { wait: false, version: "1.2.3" }))!;
    expect(readLockInfo(installLockPath(l))).toMatchObject({ pid: process.pid, version: "1.2.3" });
    h.release();
  });

  test("non-waiting returns null when busy", async () => {
    await holdInChild(installLockPath(l), "ex");
    expect(await acquireInstallLock(l, { wait: false, version: "1.2.3" })).toBeNull();
  });

  test("waiting gives up with busy after the timeout and names the holder", async () => {
    const h = (await acquireInstallLock(l, { wait: false, version: "0.9.0" }))!;
    let clock = 0;
    let told: unknown;
    const err = (await acquireInstallLock(l, {
      wait: true,
      version: "1.0.0",
      timeoutMs: 60_000,
      now: () => clock,
      sleep: async (ms) => void (clock += ms),
      onWait: (holder) => void (told = holder),
    }).catch((e) => e)) as InstallError;
    expect(err.kind).toBe("busy");
    expect(err.message).toContain(`pid ${process.pid}, version 0.9.0`);
    expect(told).toMatchObject({ version: "0.9.0" });
    h.release();
  });
});

describe("version locks", () => {
  test("a session's shared lock blocks cleanup's exclusive lock", async () => {
    const shared = (await lockVersionShared(l, "1.0.0"))!;
    expect(tryLockVersionExclusive(l, "1.0.0")).toBeNull();
    shared.release();
    expect(tryLockVersionExclusive(l, "1.0.0")).not.toBeNull();
  });

  test("lockVersionShared waits briefly for cleanup, then gives up with null", async () => {
    const ex = tryLockVersionExclusive(l, "2.0.0")!;
    expect(await lockVersionShared(l, "2.0.0", { attempts: 3, pollMs: 1 })).toBeNull();
    ex.release();
  });
});
```

- [ ] **Step 3: Run to see them fail**

Run: `bun test src/install/flock.test.ts test/install/locks.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 4: Implement `flock.ts`**

```ts
// src/install/flock.ts
import { FFIType, dlopen } from "bun:ffi";
import { InstallError } from "./errors";

export const LOCK_SH = 1;
export const LOCK_EX = 2;
export const LOCK_NB = 4;
export const LOCK_UN = 8;

/** flock(2): returns 0 on success, -1 on failure. Only ever called with LOCK_NB or LOCK_UN (amendment A6). */
export type FlockFn = (fd: number, operation: number) => number;

/** C libraries to try, in order (decision D5). */
export function libcCandidates(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string[] {
  if (platform === "darwin") return ["libSystem.B.dylib"];
  const musl = arch === "arm64" ? "aarch64" : "x86_64";
  return ["libc.so.6", `/lib/ld-musl-${musl}.so.1`, `/lib/libc.musl-${musl}.so.1`];
}

let cached: FlockFn | undefined;

export function loadFlock(candidates?: string[]): FlockFn {
  if (!candidates && cached) return cached;
  const errors: string[] = [];
  for (const name of candidates ?? libcCandidates()) {
    try {
      const lib = dlopen(name, { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } });
      const fn = lib.symbols.flock as FlockFn;
      if (!candidates) cached = fn;
      return fn;
    } catch (e) {
      errors.push(`${name}: ${(e as Error).message}`);
    }
  }
  throw new InstallError("local", `file locking is unavailable on this system (${errors.join("; ")})`);
}
```

- [ ] **Step 5: Implement `locks.ts`**

```ts
// src/install/locks.ts
import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, ftruncateSync, openSync, readFileSync, statSync, writeSync } from "node:fs";
import { InstallError, fromFsError } from "./errors";
import { LOCK_EX, LOCK_NB, LOCK_SH, LOCK_UN, loadFlock, type FlockFn } from "./flock";
import { installLockPath, versionLockPath, type Layout } from "./layout";

export interface LockHandle {
  readonly path: string;
  readonly fd: number;
  release(): void;
}

/** Informational only: who holds the install lock. Correctness never depends on it (spec §10.1). */
export interface LockInfo {
  pid: number;
  token: string;
  version: string;
  acquiredAt: string;
}

const OPEN_FLAGS = constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW;

/**
 * One non-blocking attempt. After flock succeeds, the locked file must still be the file at `path`
 * (same inode); otherwise it was replaced in between and we try again. Lock files are never deleted.
 */
export function tryLock(path: string, mode: typeof LOCK_SH | typeof LOCK_EX, flock: FlockFn = loadFlock()): LockHandle | null {
  for (let attempt = 0; attempt < 5; attempt++) {
    let fd: number;
    try {
      fd = openSync(path, OPEN_FLAGS, 0o600);
    } catch (e) {
      throw fromFsError(e, `opening the lock file ${path}`);
    }
    if (flock(fd, mode | LOCK_NB) !== 0) {
      closeSync(fd);
      return null;
    }
    let same = false;
    try {
      same = fstatSync(fd).ino === statSync(path).ino;
    } catch {
      same = false;
    }
    if (same) {
      let released = false;
      return {
        path,
        fd,
        release() {
          if (released) return;
          released = true;
          flock(fd, LOCK_UN);
          closeSync(fd);
        },
      };
    }
    flock(fd, LOCK_UN);
    closeSync(fd);
  }
  throw new InstallError("local", `the lock file ${path} keeps being replaced`);
}

export function readLockInfo(path: string): LockInfo | null {
  try {
    const info = JSON.parse(readFileSync(path, "utf8")) as LockInfo;
    return typeof info.pid === "number" ? info : null;
  } catch {
    return null;
  }
}

export interface AcquireOptions {
  wait: boolean;
  version: string;
  timeoutMs?: number;
  pollMs?: number;
  flock?: FlockFn;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  onWait?: (holder: LockInfo | null) => void;
}

/** The install lock (spec §10.1): foreground callers wait up to 60 s, then `busy`; background callers don't wait. */
export async function acquireInstallLock(l: Layout, opts: AcquireOptions): Promise<LockHandle | null> {
  const path = installLockPath(l);
  const sleep = opts.sleep ?? ((ms: number) => Bun.sleep(ms));
  const now = opts.now ?? Date.now;
  const deadline = now() + (opts.timeoutMs ?? 60_000);
  let told = false;
  for (;;) {
    const handle = tryLock(path, LOCK_EX, opts.flock);
    if (handle) {
      const info: LockInfo = { pid: process.pid, token: randomUUID(), version: opts.version, acquiredAt: new Date().toISOString() };
      ftruncateSync(handle.fd, 0);
      writeSync(handle.fd, JSON.stringify(info), 0);
      return handle;
    }
    if (!opts.wait) return null;
    if (!told) {
      opts.onWait?.(readLockInfo(path));
      told = true;
    }
    if (now() >= deadline) {
      const holder = readLockInfo(path);
      const who = holder ? ` (pid ${holder.pid}, version ${holder.version}, since ${holder.acquiredAt})` : "";
      throw new InstallError("busy", `another Tropos install or update is still running${who}; try again when it has finished`);
    }
    await sleep(opts.pollMs ?? 250);
  }
}

/** Cleanup and damaged-binary replacement: succeeds only when no process runs version `v`. */
export function tryLockVersionExclusive(l: Layout, v: string, flock?: FlockFn): LockHandle | null {
  return tryLock(versionLockPath(l, v), LOCK_EX, flock);
}

/** Sessions: a shared lock on their own version. Waits briefly while cleanup holds the exclusive lock. */
export async function lockVersionShared(l: Layout, v: string, opts: { attempts?: number; pollMs?: number; flock?: FlockFn } = {}): Promise<LockHandle | null> {
  const attempts = opts.attempts ?? 40;
  for (let i = 0; i < attempts; i++) {
    const handle = tryLock(versionLockPath(l, v), LOCK_SH, opts.flock);
    if (handle) return handle;
    await Bun.sleep(opts.pollMs ?? 50);
  }
  return null;
}
```

- [ ] **Step 6: Run to see them pass**

Run: `bun test src/install/flock.test.ts test/install/locks.test.ts && bun run typecheck`
Expected: PASS on macOS and Linux.

- [ ] **Step 7: Commit**

```bash
git add src/install/flock.ts src/install/flock.test.ts src/install/locks.ts test/install/helpers/hold-lock.ts test/install/locks.test.ts
git commit -m "feat(install): kernel flock locks with inode check and no blocking calls

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 12: Atomic files and engine state

Spec: §9 (`install.json`, atomic writes, generation).

**Files:**
- Create: `src/install/files.ts`, `src/install/files.test.ts`
- Create: `src/install/state.ts`, `src/install/state.test.ts`

**Interfaces:**
- Consumes: `fromFsError` (Task 3); `Layout` (Task 10); `isVersion` (Task 3)
- Produces: `sha256File(path): Promise<{ sha256: string; size: number }>`, `fsyncDir(dir): Promise<void>`, `fsyncFile(path): Promise<void>`, `writeFileAtomic(path, data, mode?): Promise<void>`
- Produces: `type SkipReason = "health-check" | "rolled-back"`, `interface PendingSwitch { op: "switch"; from: string | null; to: string }`, `interface AutoUpdateState { lastCheck: string | null; failures: number; nextCheck: string | null; lastUpdated: string | null; announced: boolean }`, `interface InstallState { schema: 1; generation: number; current: string | null; previous: string | null; pending: PendingSwitch | null; skip: Record<string, SkipReason>; autoUpdate: AutoUpdateState }`, `emptyState(): InstallState`, `type ReadStateResult = { kind: "missing" } | { kind: "corrupt"; reason: string } | { kind: "ok"; state: InstallState }`, `readState(l): Promise<ReadStateResult>`, `writeState(l, s): Promise<InstallState>` (returns the state with `generation + 1`)

- [ ] **Step 1: Write the failing tests**

```ts
// src/install/files.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import { fsyncDir, sha256File, writeFileAtomic } from "./files";

let dir: string;
beforeEach(async () => {
  dir = await makeTmpDir();
});
afterEach(() => removeDir(dir));

describe("files", () => {
  test("sha256File", async () => {
    await writeFile(join(dir, "f"), "hello");
    expect(await sha256File(join(dir, "f"))).toEqual({ sha256: new Bun.CryptoHasher("sha256").update("hello").digest("hex"), size: 5 });
  });

  test("writeFileAtomic replaces content, sets the mode and leaves no temp files", async () => {
    const path = join(dir, "state.json");
    await writeFileAtomic(path, "one");
    await writeFileAtomic(path, "two", 0o600);
    expect(await readFile(path, "utf8")).toBe("two");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readdir(dir)).toEqual(["state.json"]);
  });

  test("fsyncDir works on a directory", async () => {
    await fsyncDir(dir);
  });
});
```

```ts
// src/install/state.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import { ensureLayout, resolveLayout, type Layout } from "./layout";
import { emptyState, readState, writeState } from "./state";

let dir: string;
let l: Layout;
beforeEach(async () => {
  dir = await makeTmpDir();
  l = resolveLayout({ HOME: dir });
  await ensureLayout(l);
});
afterEach(() => removeDir(dir));

describe("install state", () => {
  test("missing, then written and read back with an increasing generation", async () => {
    expect(await readState(l)).toEqual({ kind: "missing" });
    const s1 = await writeState(l, { ...emptyState(), current: "1.0.0" });
    expect(s1.generation).toBe(1);
    const s2 = await writeState(l, { ...s1, previous: "1.0.0", current: "1.1.0", pending: null, skip: { "1.0.1": "health-check" } });
    expect(s2.generation).toBe(2);
    expect(await readState(l)).toEqual({ kind: "ok", state: s2 });
  });

  test("emptyState returns a fresh object each time", () => {
    const a = emptyState();
    a.skip["1.0.0"] = "rolled-back";
    expect(emptyState().skip).toEqual({});
  });

  test.each([
    ["not JSON", "{"],
    ["torn write", '{"schema": 1, "generation": 3, "curr'],
    ["traversal in current", JSON.stringify({ ...emptyState(), current: "../../x" })],
    ["bad skip reason", JSON.stringify({ ...emptyState(), skip: { "1.0.0": "because" } })],
    ["unknown field", JSON.stringify({ ...emptyState(), extra: true })],
    ["pending to missing", JSON.stringify({ ...emptyState(), pending: { op: "switch", from: null } })],
  ])("corrupt: %s", async (_name, text) => {
    await writeFile(l.stateFile, text);
    expect((await readState(l)).kind).toBe("corrupt");
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `bun test src/install/files.test.ts src/install/state.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement `files.ts`**

```ts
// src/install/files.ts
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fromFsError } from "./errors";

export async function sha256File(path: string): Promise<{ sha256: string; size: number }> {
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer);
    size += (chunk as Buffer).length;
  }
  return { sha256: hash.digest("hex"), size };
}

export async function fsyncDir(dir: string): Promise<void> {
  const fh = await open(dir, "r");
  try {
    await fh.sync();
  } catch (e) {
    // Some filesystems refuse fsync on directories; the rename itself is still atomic.
    if (!["EINVAL", "EBADF", "EISDIR", "ENOTSUP"].includes((e as NodeJS.ErrnoException).code ?? "")) throw e;
  } finally {
    await fh.close();
  }
}

export async function fsyncFile(path: string): Promise<void> {
  const fh = await open(path, "r+");
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
}

/** Temp file in the same directory, fsync, rename over `path`, fsync the directory (spec §9). */
export async function writeFileAtomic(path: string, data: string | Uint8Array, mode = 0o600): Promise<void> {
  const tmp = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    const fh = await open(tmp, "wx", mode);
    try {
      await fh.writeFile(data);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmp, path);
    await fsyncDir(dirname(path));
  } catch (e) {
    await rm(tmp, { force: true });
    throw fromFsError(e, `writing ${path}`);
  }
}
```

- [ ] **Step 4: Implement `state.ts`**

```ts
// src/install/state.ts
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { fromFsError } from "./errors";
import { writeFileAtomic } from "./files";
import type { Layout } from "./layout";
import { isVersion } from "./version";

export type SkipReason = "health-check" | "rolled-back";

export interface PendingSwitch {
  op: "switch";
  from: string | null;
  to: string;
}

export interface AutoUpdateState {
  lastCheck: string | null;
  failures: number;
  nextCheck: string | null;
  lastUpdated: string | null;
  announced: boolean;
}

export interface InstallState {
  schema: 1;
  generation: number;
  current: string | null;
  previous: string | null;
  pending: PendingSwitch | null;
  skip: Record<string, SkipReason>;
  autoUpdate: AutoUpdateState;
}

export function emptyState(): InstallState {
  return {
    schema: 1,
    generation: 0,
    current: null,
    previous: null,
    pending: null,
    skip: {},
    autoUpdate: { lastCheck: null, failures: 0, nextCheck: null, lastUpdated: null, announced: true },
  };
}

const version = z.string().refine(isVersion, "not a version");
const instant = z.iso.datetime().nullable();
const stateSchema = z
  .object({
    schema: z.literal(1),
    generation: z.number().int().min(0),
    current: version.nullable(),
    previous: version.nullable(),
    pending: z.object({ op: z.literal("switch"), from: version.nullable(), to: version }).strict().nullable(),
    skip: z.record(version, z.enum(["health-check", "rolled-back"])),
    autoUpdate: z
      .object({ lastCheck: instant, failures: z.number().int().min(0).max(64), nextCheck: instant, lastUpdated: version.nullable(), announced: z.boolean() })
      .strict(),
  })
  .strict();

export type ReadStateResult = { kind: "missing" } | { kind: "corrupt"; reason: string } | { kind: "ok"; state: InstallState };

export async function readState(l: Layout): Promise<ReadStateResult> {
  let text: string;
  try {
    text = await readFile(l.stateFile, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
    throw fromFsError(e, `reading ${l.stateFile}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { kind: "corrupt", reason: "not JSON" };
  }
  const parsed = stateSchema.safeParse(raw);
  if (!parsed.success) return { kind: "corrupt", reason: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
  return { kind: "ok", state: parsed.data as InstallState };
}

/** Writes atomically and returns the state as written (generation + 1). State is never trusted for integrity. */
export async function writeState(l: Layout, next: InstallState): Promise<InstallState> {
  const written: InstallState = { ...next, generation: next.generation + 1 };
  await writeFileAtomic(l.stateFile, `${JSON.stringify(written, null, 2)}\n`, 0o600);
  return written;
}
```

- [ ] **Step 5: Run to see them pass**

Run: `bun test src/install/files.test.ts src/install/state.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/install/files.ts src/install/files.test.ts src/install/state.ts src/install/state.test.ts
git commit -m "feat(install): atomic file writes and validated install state

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 13: Verified and Healthy predicates, stored manifests, the symlink

Spec: §10.2 (predicates), §10.3 steps 5–8 (switch), §9 (stored manifests).

**Files:**
- Create: `src/install/verify.ts`, `src/install/verify.test.ts`
- Create: `src/install/link.ts`, `src/install/link.test.ts`
- Create: `test/install/helpers/fixture-release.ts`

**Interfaces:**
- Consumes: Tasks 3–12 (`Layout`, `versionPath`, `manifestDir`, `currentUser`, `DirOwner`, `sha256File`, `writeFileAtomic`, `fsyncDir`, `verifyManifest`, `expectVersion`, `VerifiedManifest`, `PlatformEntry`, `Platform`, `TrustedKey`, `minimalEnv`, `isVersion`, `newestFirst`, `InstallError`, `fromFsError`)
- Produces: `type HealthCheck = (bin: string, version: string) => Promise<boolean>`, `interface VerifyContext { layout: Layout; platform: Platform; trusted: readonly TrustedKey[]; health: HealthCheck; user?: DirOwner }`, `type Check = { ok: true } | { ok: false; reason: string }`, `HEALTH_TIMEOUT_MS = 10000`, `defaultHealthCheck(bin, version, env?, timeoutMs?): Promise<boolean>`, `storeManifest(l, v, vm): Promise<void>`, `readStoredManifest(ctx, v): Promise<VerifiedManifest>`, `isManaged(l, v): Promise<boolean>`, `checkFileAgainst(path, entry, user?): Promise<Check>`, `checkVerified(ctx, v): Promise<Check>`, `checkHealthy(ctx, v): Promise<Check>`, `listVersionFiles(l): Promise<string[]>`, `listManagedVersions(l): Promise<string[]>` (both newest first)
- Produces: `type LinkState = { kind: "missing" } | { kind: "ours"; version: string } | { kind: "dangling-ours"; version: string } | { kind: "foreign"; target: string | null }`, `readLink(l): Promise<LinkState>`, `switchLink(l, v): Promise<void>`, `removeOurLink(l): Promise<boolean>`, `linkResolvesTo(l, v): Promise<boolean>`
- Produces (tests): `fakeBinary(version, extra?)`, `interface FixtureRelease { version; binary: Uint8Array; zst: Uint8Array; verified: VerifiedManifest }`, `makeFixtureRelease(opts: { version; key: TestKey; dir; binary?: Uint8Array | string; zst?: Uint8Array }): Promise<FixtureRelease>`, `publishFixture(srv, r)`, `installDirect(l, r): Promise<void>`

- [ ] **Step 1: Write the fixture helper**

```ts
// test/install/helpers/fixture-release.ts
// Fake releases: a shell-script "binary" that answers --version like tropos, signed with a test key.
import { chmod, copyFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { versionPath, type Layout } from "../../../src/install/layout";
import { serializeManifest, verifyManifest, type Manifest, type VerifiedManifest } from "../../../src/install/manifest";
import { PLATFORMS } from "../../../src/install/platform";
import { storeManifest } from "../../../src/install/verify";
import { sshSign, type TestKey } from "./keys";
import type { ReleaseServer } from "./release-server";
import { sha256Hex } from "./zstd-corpus";

export function fakeBinary(version: string, extra = ""): string {
  return `#!/bin/sh\n${extra}\nif [ "$1" = "--version" ]; then echo "${version} (Tropos Code)"; exit 0; fi\necho "fake tropos ${version} $*"\n`;
}

export interface FixtureRelease {
  version: string;
  binary: Uint8Array;
  zst: Uint8Array;
  verified: VerifiedManifest;
}

export async function makeFixtureRelease(opts: { version: string; key: TestKey; dir: string; binary?: Uint8Array | string; zst?: Uint8Array }): Promise<FixtureRelease> {
  const binary = typeof opts.binary === "string" ? new TextEncoder().encode(opts.binary) : (opts.binary ?? new TextEncoder().encode(fakeBinary(opts.version)));
  const zst = opts.zst ?? Bun.zstdCompressSync(binary);
  const entry = (p: string) => ({ asset: `tropos-${p}`, sha256: sha256Hex(binary), size: binary.length, zst: { asset: `tropos-${p}.zst`, sha256: sha256Hex(zst), size: zst.length } });
  const manifest = { schema: 1, version: opts.version, commit: "f".repeat(40), buildDate: "2026-10-13T00:00:00Z", platforms: Object.fromEntries(PLATFORMS.map((p) => [p, entry(p)])) } as Manifest;
  const bytes = new TextEncoder().encode(serializeManifest(manifest));
  const signature = await sshSign(opts.key, bytes, "tropos-manifest", opts.dir);
  return { version: opts.version, binary, zst, verified: verifyManifest(bytes, signature, opts.key.trusted) };
}

export function publishFixture(srv: ReleaseServer, r: FixtureRelease): void {
  const tag = `v${r.version}`;
  srv.put(tag, "manifest.json", r.verified.bytes);
  srv.put(tag, "manifest.json.sig", r.verified.signature);
  for (const p of PLATFORMS) {
    srv.put(tag, `tropos-${p}`, r.binary);
    srv.put(tag, `tropos-${p}.zst`, r.zst);
  }
}

/** Puts a release straight into versions/ with its stored manifest, as a completed install would. */
export async function installDirect(l: Layout, r: FixtureRelease): Promise<void> {
  const tmp = join(l.staging, `direct-${r.version}`);
  await writeFile(tmp, r.binary);
  await chmod(tmp, 0o755);
  await storeManifest(l, r.version, r.verified);
  await copyFile(tmp, versionPath(l, r.version));
  await chmod(versionPath(l, r.version), 0o755);
}
```

- [ ] **Step 2: Write the failing tests**

```ts
// src/install/verify.test.ts
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { appendFile, chmod, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fakeBinary, installDirect, makeFixtureRelease, type FixtureRelease } from "../../test/install/helpers/fixture-release";
import { makeTestKey, type TestKey } from "../../test/install/helpers/keys";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import { ensureLayout, manifestDir, resolveLayout, versionPath, type Layout } from "./layout";
import { detectPlatform } from "./platform";
import { checkHealthy, checkVerified, defaultHealthCheck, isManaged, listManagedVersions, listVersionFiles, type VerifyContext } from "./verify";

let root: string;
let key: TestKey;
let r1: FixtureRelease;
let dir: string;
let l: Layout;
let ctx: VerifyContext;

beforeAll(async () => {
  root = await makeTmpDir();
  key = await makeTestKey(root, "k");
  r1 = await makeFixtureRelease({ version: "1.0.0", key, dir: root });
});
afterAll(() => removeDir(root));
beforeEach(async () => {
  dir = await makeTmpDir();
  l = resolveLayout({ HOME: dir });
  await ensureLayout(l);
  ctx = { layout: l, platform: detectPlatform(), trusted: key.trusted, health: defaultHealthCheck };
});

describe("Verified and Healthy", () => {
  test("a direct install is managed, Verified and Healthy", async () => {
    await installDirect(l, r1);
    expect(await isManaged(l, "1.0.0")).toBe(true);
    expect(await checkVerified(ctx, "1.0.0")).toEqual({ ok: true });
    expect(await checkHealthy(ctx, "1.0.0")).toEqual({ ok: true });
  });

  test("a modified binary is not Verified (unexpected file modification)", async () => {
    await installDirect(l, r1);
    await appendFile(versionPath(l, "1.0.0"), "\n# changed");
    expect(await checkVerified(ctx, "1.0.0")).toMatchObject({ ok: false });
  });

  test("a binary replaced by a symlink is not Verified", async () => {
    await installDirect(l, r1);
    await writeFile(join(dir, "elsewhere"), r1.binary);
    await rm(versionPath(l, "1.0.0"));
    await symlink(join(dir, "elsewhere"), versionPath(l, "1.0.0"));
    expect(await checkVerified(ctx, "1.0.0")).toEqual({ ok: false, reason: "is a symbolic link" });
  });

  test("a tampered stored manifest or a foreign key fails", async () => {
    await installDirect(l, r1);
    await appendFile(join(manifestDir(l, "1.0.0"), "manifest.json"), " ");
    expect((await checkVerified(ctx, "1.0.0")).ok).toBe(false);
    await installDirect(l, await makeFixtureRelease({ version: "1.0.1", key, dir: root }));
    expect((await checkVerified({ ...ctx, trusted: [] }, "1.0.1")).ok).toBe(false);
  });

  test("missing binary or manifest", async () => {
    expect(await checkVerified(ctx, "9.9.9")).toMatchObject({ ok: false });
    await installDirect(l, r1);
    await rm(versionPath(l, "1.0.0"));
    expect(await checkVerified(ctx, "1.0.0")).toEqual({ ok: false, reason: "missing" });
  });

  test("health check: exact output, exit 0, minimal environment, timeout", async () => {
    const bin = join(dir, "bin.sh");
    const write = async (body: string) => {
      await writeFile(bin, body);
      await chmod(bin, 0o755);
    };
    await write(fakeBinary("2.0.0"));
    expect(await defaultHealthCheck(bin, "2.0.0")).toBe(true);
    expect(await defaultHealthCheck(bin, "2.0.1")).toBe(false);
    await write('#!/bin/sh\necho "2.0.0 (Tropos Code)"; exit 3\n');
    expect(await defaultHealthCheck(bin, "2.0.0")).toBe(false);
    await write('#!/bin/sh\n[ -n "$ANTHROPIC_API_KEY" ] && exit 9\necho "2.0.0 (Tropos Code)"\n');
    expect(await defaultHealthCheck(bin, "2.0.0", { ...process.env, ANTHROPIC_API_KEY: "secret" })).toBe(true);
    await write("#!/bin/sh\nsleep 5\n");
    expect(await defaultHealthCheck(bin, "2.0.0", process.env, 200)).toBe(false);
    expect(await defaultHealthCheck(join(dir, "missing"), "2.0.0")).toBe(false);
  });

  test("listings ignore non-version names and sort newest first", async () => {
    await installDirect(l, r1);
    await installDirect(l, await makeFixtureRelease({ version: "1.10.0", key, dir: root }));
    await writeFile(join(l.versions, ".corrupt-1.0.0-1"), "");
    await writeFile(join(l.versions, "0.1.0"), "local build");
    expect(await listVersionFiles(l)).toEqual(["1.10.0", "1.0.0", "0.1.0"]);
    expect(await listManagedVersions(l)).toEqual(["1.10.0", "1.0.0"]);
  });
});
```

```ts
// src/install/link.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readdir, readlink, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import { ensureLayout, resolveLayout, versionPath, type Layout } from "./layout";
import { linkResolvesTo, readLink, removeOurLink, switchLink } from "./link";

let dir: string;
let l: Layout;
beforeEach(async () => {
  dir = await makeTmpDir();
  l = resolveLayout({ HOME: join(dir, "with space") });
  await ensureLayout(l);
  await writeFile(versionPath(l, "1.0.0"), "a");
  await writeFile(versionPath(l, "1.1.0"), "b");
});
afterEach(() => removeDir(dir));

describe("the tropos symlink", () => {
  test("missing, then ours, switched atomically with no temp leftovers", async () => {
    expect(await readLink(l)).toEqual({ kind: "missing" });
    await switchLink(l, "1.0.0");
    expect(await readLink(l)).toEqual({ kind: "ours", version: "1.0.0" });
    await switchLink(l, "1.1.0");
    expect(await readlink(l.binLink)).toBe(versionPath(l, "1.1.0"));
    expect(await linkResolvesTo(l, "1.1.0")).toBe(true);
    expect(await readdir(l.binDir)).toEqual(["tropos"]);
  });

  test("an unmanaged symlink into versions/ from the old local-build installer counts as ours", async () => {
    await writeFile(versionPath(l, "0.1.0"), "local build");
    await symlink(versionPath(l, "0.1.0"), l.binLink);
    expect(await readLink(l)).toEqual({ kind: "ours", version: "0.1.0" });
  });

  test("dangling and foreign links", async () => {
    await symlink(versionPath(l, "2.0.0"), l.binLink);
    expect(await readLink(l)).toEqual({ kind: "dangling-ours", version: "2.0.0" });
    expect(await removeOurLink(l)).toBe(true);
    await symlink("/usr/local/bin/something", l.binLink);
    expect(await readLink(l)).toEqual({ kind: "foreign", target: "/usr/local/bin/something" });
    expect(await removeOurLink(l)).toBe(false);
  });

  test("a regular file is foreign", async () => {
    await writeFile(l.binLink, "#!/bin/sh\n");
    expect(await readLink(l)).toEqual({ kind: "foreign", target: null });
  });
});
```

- [ ] **Step 3: Run to see them fail**

Run: `bun test src/install/verify.test.ts src/install/link.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 4: Implement `verify.ts`**

```ts
// src/install/verify.ts
import { lstat, mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { minimalEnv } from "./env";
import { sha256File, writeFileAtomic } from "./files";
import { currentUser, manifestDir, versionPath, type DirOwner, type Layout } from "./layout";
import { expectVersion, verifyManifest, type PlatformEntry, type VerifiedManifest } from "./manifest";
import type { Platform } from "./platform";
import type { TrustedKey } from "./sshsig";
import { isVersion, newestFirst } from "./version";

export type HealthCheck = (bin: string, version: string) => Promise<boolean>;

export interface VerifyContext {
  layout: Layout;
  platform: Platform;
  trusted: readonly TrustedKey[];
  health: HealthCheck;
  user?: DirOwner;
}

export type Check = { ok: true } | { ok: false; reason: string };

export const HEALTH_TIMEOUT_MS = 10_000;

/** `<bin> --version` must exit 0 printing exactly "<v> (Tropos Code)\n" within the timeout (spec §10.2). */
export async function defaultHealthCheck(bin: string, version: string, env: NodeJS.ProcessEnv = process.env, timeoutMs = HEALTH_TIMEOUT_MS): Promise<boolean> {
  let proc;
  try {
    proc = Bun.spawn([bin, "--version"], { env: minimalEnv(env), stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  } catch {
    return false;
  }
  const timer = setTimeout(() => proc.kill("SIGKILL"), timeoutMs);
  try {
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return code === 0 && out === `${version} (Tropos Code)\n`;
  } finally {
    clearTimeout(timer);
  }
}

/** manifest.json is written last: its presence is what makes a version "managed". */
export async function storeManifest(l: Layout, version: string, vm: VerifiedManifest): Promise<void> {
  const dir = manifestDir(l, version);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFileAtomic(join(dir, "manifest.json.sig"), vm.signature);
  await writeFileAtomic(join(dir, "manifest.json"), vm.bytes);
}

export async function readStoredManifest(ctx: VerifyContext, version: string): Promise<VerifiedManifest> {
  const dir = manifestDir(ctx.layout, version);
  const [bytes, signature] = await Promise.all([readFile(join(dir, "manifest.json")), readFile(join(dir, "manifest.json.sig"), "utf8")]);
  const vm = verifyManifest(new Uint8Array(bytes), signature, ctx.trusted);
  expectVersion(vm.manifest, version);
  return vm;
}

export async function isManaged(l: Layout, version: string): Promise<boolean> {
  return lstat(join(manifestDir(l, version), "manifest.json")).then(
    () => true,
    () => false,
  );
}

export async function checkFileAgainst(path: string, entry: PlatformEntry, user: DirOwner = currentUser()): Promise<Check> {
  let st;
  try {
    st = await lstat(path);
  } catch {
    return { ok: false, reason: "missing" };
  }
  if (st.isSymbolicLink()) return { ok: false, reason: "is a symbolic link" };
  if (!st.isFile()) return { ok: false, reason: "is not a regular file" };
  if (st.uid !== user.uid) return { ok: false, reason: "is owned by another user" };
  if (st.size !== entry.size) return { ok: false, reason: `has ${st.size} bytes, expected ${entry.size}` };
  return (await sha256File(path)).sha256 === entry.sha256 ? { ok: true } : { ok: false, reason: "does not match its signed sha256" };
}

export async function checkVerified(ctx: VerifyContext, version: string): Promise<Check> {
  if (!isVersion(version)) return { ok: false, reason: "not a version" };
  let vm: VerifiedManifest;
  try {
    vm = await readStoredManifest(ctx, version);
  } catch (e) {
    return { ok: false, reason: `stored manifest: ${(e as Error).message}` };
  }
  return checkFileAgainst(versionPath(ctx.layout, version), vm.manifest.platforms[ctx.platform], ctx.user);
}

export async function checkHealthy(ctx: VerifyContext, version: string): Promise<Check> {
  const verified = await checkVerified(ctx, version);
  if (!verified.ok) return verified;
  return (await ctx.health(versionPath(ctx.layout, version), version)) ? { ok: true } : { ok: false, reason: "failed its health check" };
}

async function versionEntries(dir: string): Promise<string[]> {
  try {
    return newestFirst((await readdir(dir)).filter(isVersion));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
}

export const listVersionFiles = (l: Layout) => versionEntries(l.versions);
/** Versions with a stored manifest (their binary may be missing). */
export const listManagedVersions = (l: Layout) => versionEntries(l.manifests);
```

- [ ] **Step 5: Implement `link.ts`**

```ts
// src/install/link.ts
import { randomUUID } from "node:crypto";
import { lstat, readlink, realpath, rename, rm, symlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fromFsError } from "./errors";
import { fsyncDir } from "./files";
import { versionPath, type Layout } from "./layout";
import { isVersion } from "./version";

export type LinkState = { kind: "missing" } | { kind: "ours"; version: string } | { kind: "dangling-ours"; version: string } | { kind: "foreign"; target: string | null };

const real = (p: string) => realpath(p).catch(() => p);

/** "ours" means a symlink straight into versions/ — managed or not (the old local-build installer made those too). */
export async function readLink(l: Layout): Promise<LinkState> {
  let st;
  try {
    st = await lstat(l.binLink);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
    throw fromFsError(e, `reading ${l.binLink}`);
  }
  if (!st.isSymbolicLink()) return { kind: "foreign", target: null };
  const raw = await readlink(l.binLink);
  const target = resolve(l.binDir, raw);
  const name = basename(target);
  const inVersions = dirname(target) === l.versions || (await real(dirname(target))) === (await real(l.versions));
  if (!inVersions || !isVersion(name)) return { kind: "foreign", target: raw };
  const exists = await lstat(target).then(
    () => true,
    () => false,
  );
  return exists ? { kind: "ours", version: name } : { kind: "dangling-ours", version: name };
}

/** New symlink beside the old one, then rename over it: there is never a moment without `tropos` (spec §10.3 step 7). */
export async function switchLink(l: Layout, version: string): Promise<void> {
  const tmp = join(l.binDir, `.tropos.${randomUUID()}`);
  try {
    await symlink(versionPath(l, version), tmp);
    await rename(tmp, l.binLink);
  } catch (e) {
    await rm(tmp, { force: true });
    throw fromFsError(e, `switching ${l.binLink}`);
  }
  await fsyncDir(l.binDir);
}

export async function removeOurLink(l: Layout): Promise<boolean> {
  const state = await readLink(l);
  if (state.kind !== "ours" && state.kind !== "dangling-ours") return false;
  await rm(l.binLink);
  await fsyncDir(l.binDir);
  return true;
}

export async function linkResolvesTo(l: Layout, version: string): Promise<boolean> {
  try {
    return (await realpath(l.binLink)) === (await realpath(versionPath(l, version)));
  } catch {
    return false;
  }
}
```

- [ ] **Step 6: Run to see them pass**

Run: `bun test src/install/verify.test.ts src/install/link.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/install/verify.ts src/install/verify.test.ts src/install/link.ts src/install/link.test.ts test/install/helpers/fixture-release.ts
git commit -m "feat(install): Verified/Healthy predicates, stored manifests and atomic symlink switch

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 14: Engine session, install lock wrapper and recovery

Spec: §10.6 (recovery table, fallback order, activation rule), §10.2, amendment A11. Recovery comes before the installer because every command runs it first.

**Files:**
- Create: `src/install/engine.ts`
- Create: `src/install/recovery.ts`
- Create: `test/install/helpers/engine.ts`
- Create: `test/install/recovery.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 3–13
- Produces: `type CrashPoint = "after-download" | "after-rename" | "after-pending" | "after-swap" | "after-state" | "mid-cleanup"`, `interface EngineDeps extends RemoteDeps { layout: Layout; platform: Platform; health: HealthCheck; selfVersion: string; user?: DirOwner; flock?: FlockFn; lockTimeoutMs?: number; now?: () => Date; log?: (line: string) => void; crash?: (point: CrashPoint) => void }`, `verifyContext(d): VerifyContext`, `class EngineSession { deps; ctx; state; save(patch): Promise<void>; crash(p); log(s); now(): Date }`, `interface LockedRun<T> { value: T; recovery: RecoveryReport }`, `withInstallLock<T>(deps, opts: { wait: boolean; onWait?: (holder: LockInfo | null) => void }, fn: (s: EngineSession, recovery: RecoveryReport) => Promise<T>): Promise<LockedRun<T> | null>`
- Produces: `interface RecoveryReport { actions: string[]; fatal: string | null }`, `selectFallback(s, exclude?): Promise<string | null>`, `recover(s, read: ReadStateResult): Promise<RecoveryReport>`
- Produces (tests): `makeEngineFixture(extra?): Promise<EngineFixture>` with `root, home, layout, key, srv, deps, release(v, binary?), direct(v), setup({ versions, current?, previous?, link? }), state(), recoverNow(), close()`

- [ ] **Step 1: Write the engine fixture**

```ts
// test/install/helpers/engine.ts
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { withInstallLock, type EngineDeps } from "../../../src/install/engine";
import { ensureLayout, resolveLayout, type Layout } from "../../../src/install/layout";
import { switchLink } from "../../../src/install/link";
import { detectPlatform } from "../../../src/install/platform";
import type { RecoveryReport } from "../../../src/install/recovery";
import { emptyState, readState, writeState, type InstallState } from "../../../src/install/state";
import { defaultHealthCheck } from "../../../src/install/verify";
import { makeTmpDir, removeDir } from "../../helpers/tmp";
import { installDirect, makeFixtureRelease, publishFixture, type FixtureRelease } from "./fixture-release";
import { makeTestKey, type TestKey } from "./keys";
import { startReleaseServer, type ReleaseServer } from "./release-server";

export interface EngineFixture {
  root: string;
  home: string;
  layout: Layout;
  key: TestKey;
  srv: ReleaseServer;
  deps: EngineDeps;
  release(version: string, binary?: string): Promise<FixtureRelease>;
  direct(version: string): Promise<void>;
  setup(opts: { versions: string[]; current?: string; previous?: string; link?: string }): Promise<void>;
  state(): Promise<InstallState>;
  recoverNow(): Promise<RecoveryReport>;
  close(): Promise<void>;
}

export async function makeEngineFixture(extra: Partial<EngineDeps> = {}): Promise<EngineFixture> {
  const root = await makeTmpDir();
  const home = join(root, "home dir");
  await mkdir(home);
  const key = await makeTestKey(root, "release");
  const srv = startReleaseServer();
  const layout = resolveLayout({ HOME: home });
  await ensureLayout(layout);
  const deps: EngineDeps = {
    layout,
    platform: detectPlatform(),
    trusted: key.trusted,
    urls: srv.urls,
    allowLoopbackHttp: true,
    health: (bin, v) => defaultHealthCheck(bin, v),
    selfVersion: "test",
    sleep: (ms) => Bun.sleep(Math.min(ms, 5)),
    lockTimeoutMs: 5000,
    ...extra,
  };
  const releases = new Map<string, FixtureRelease>();
  const release = async (version: string, binary?: string) => {
    let r = releases.get(version);
    if (!r || binary) {
      r = await makeFixtureRelease({ version, key, dir: root, binary });
      releases.set(version, r);
      publishFixture(srv, r);
    }
    return r;
  };
  return {
    root,
    home,
    layout,
    key,
    srv,
    deps,
    release,
    direct: async (v) => installDirect(layout, await release(v)),
    async setup({ versions, current, previous, link }) {
      for (const v of versions) await installDirect(layout, await release(v));
      if (link) await switchLink(layout, link);
      await writeState(layout, { ...emptyState(), current: current ?? null, previous: previous ?? null });
    },
    async state() {
      const r = await readState(layout);
      if (r.kind !== "ok") throw new Error(`install state is ${r.kind}`);
      return r.state;
    },
    recoverNow: async () => (await withInstallLock(deps, { wait: true }, async () => undefined))!.recovery,
    async close() {
      srv.stop();
      await removeDir(root);
    },
  };
}
```

- [ ] **Step 2: Write the failing recovery tests**

```ts
// test/install/recovery.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import { appendFile, rm, symlink, writeFile } from "node:fs/promises";
import { versionPath } from "../../src/install/layout";
import { readLink, switchLink } from "../../src/install/link";
import { lockVersionShared } from "../../src/install/locks";
import { emptyState, writeState } from "../../src/install/state";
import { makeEngineFixture, type EngineFixture } from "./helpers/engine";

let f: EngineFixture;
afterEach(() => f?.close());

describe("recovery (spec §10.6)", () => {
  test("nothing installed: nothing to do", async () => {
    f = await makeEngineFixture();
    expect(await f.recoverNow()).toEqual({ actions: [], fatal: null });
  });

  test("a local build linked by the old installer is left alone", async () => {
    f = await makeEngineFixture();
    await writeFile(versionPath(f.layout, "0.1.0"), "local build");
    await symlink(versionPath(f.layout, "0.1.0"), f.layout.binLink);
    expect(await f.recoverNow()).toEqual({ actions: [], fatal: null });
    expect(await readLink(f.layout)).toEqual({ kind: "ours", version: "0.1.0" });
  });

  test("unreadable state is rebuilt from the symlink", async () => {
    f = await makeEngineFixture();
    await f.setup({ versions: ["1.0.0", "1.1.0"], current: "1.1.0", link: "1.1.0" });
    await writeFile(f.layout.stateFile, '{"schema": 1, "gen');
    const r = await f.recoverNow();
    expect(r.actions[0]).toStartWith("install state was unreadable");
    expect(await f.state()).toMatchObject({ current: "1.1.0", previous: "1.0.0", pending: null });
  });

  test("interrupted first install with the link already switched: finish it", async () => {
    f = await makeEngineFixture();
    await f.direct("1.0.0");
    await switchLink(f.layout, "1.0.0");
    await writeState(f.layout, { ...emptyState(), pending: { op: "switch", from: null, to: "1.0.0" } });
    await f.recoverNow();
    expect(await f.state()).toMatchObject({ current: "1.0.0", pending: null });
  });

  test("interrupted first install before the switch: no link, clear message", async () => {
    f = await makeEngineFixture();
    await f.direct("1.0.0");
    await writeState(f.layout, { ...emptyState(), pending: { op: "switch", from: null, to: "1.0.0" } });
    const r = await f.recoverNow();
    expect(r.fatal).toBe("installation did not complete; run install.sh again");
    expect(await readLink(f.layout)).toEqual({ kind: "missing" });
    expect(await f.state()).toMatchObject({ current: null, pending: null });
  });

  test("interrupted first install never removes the user's old local-build link", async () => {
    f = await makeEngineFixture();
    await f.direct("1.0.0");
    await writeFile(versionPath(f.layout, "0.1.0"), "local build");
    await symlink(versionPath(f.layout, "0.1.0"), f.layout.binLink);
    await writeState(f.layout, { ...emptyState(), pending: { op: "switch", from: null, to: "1.0.0" } });
    await f.recoverNow();
    expect(await readLink(f.layout)).toEqual({ kind: "ours", version: "0.1.0" });
  });

  test("interrupted upgrade whose target is broken: back to from", async () => {
    f = await makeEngineFixture();
    await f.setup({ versions: ["1.0.0", "1.1.0"], link: "1.1.0" });
    await writeState(f.layout, { ...emptyState(), current: "1.0.0", pending: { op: "switch", from: "1.0.0", to: "1.1.0" } });
    await appendFile(versionPath(f.layout, "1.1.0"), "x");
    await f.recoverNow();
    expect(await readLink(f.layout)).toEqual({ kind: "ours", version: "1.0.0" });
    expect(await f.state()).toMatchObject({ current: "1.0.0", pending: null });
  });

  test("symlink moved to another healthy managed version: adopted", async () => {
    f = await makeEngineFixture();
    await f.setup({ versions: ["1.0.0", "1.1.0"], current: "1.0.0", link: "1.1.0" });
    await f.recoverNow();
    expect(await f.state()).toMatchObject({ current: "1.1.0", previous: "1.0.0" });
  });

  test("current deleted: first healthy fallback (R6.2)", async () => {
    f = await makeEngineFixture();
    await f.setup({ versions: ["1.0.0", "1.1.0"], current: "1.1.0", previous: "1.0.0", link: "1.1.0" });
    await rm(versionPath(f.layout, "1.1.0"));
    await f.recoverNow();
    expect(await readLink(f.layout)).toEqual({ kind: "ours", version: "1.0.0" });
    expect(await f.state()).toMatchObject({ current: "1.0.0", previous: null });
  });

  test("current corrupted while a session runs it: link moves, file stays (R5.2)", async () => {
    f = await makeEngineFixture();
    await f.setup({ versions: ["1.0.0", "1.1.0"], current: "1.1.0", previous: "1.0.0", link: "1.1.0" });
    const session = (await lockVersionShared(f.layout, "1.1.0"))!;
    await appendFile(versionPath(f.layout, "1.1.0"), "corrupt");
    const before = await Bun.file(versionPath(f.layout, "1.1.0")).text();
    await f.recoverNow();
    expect(await readLink(f.layout)).toEqual({ kind: "ours", version: "1.0.0" });
    expect(await Bun.file(versionPath(f.layout, "1.1.0")).text()).toBe(before);
    session.release();
  });

  test("previous corrupted: previous becomes null (R6.3)", async () => {
    f = await makeEngineFixture();
    await f.setup({ versions: ["1.0.0", "1.1.0"], current: "1.1.0", previous: "1.0.0", link: "1.1.0" });
    await appendFile(versionPath(f.layout, "1.0.0"), "x");
    await f.recoverNow();
    expect((await f.state()).previous).toBeNull();
  });

  test("no healthy candidate: our link is removed and the condition is fatal", async () => {
    f = await makeEngineFixture();
    await f.setup({ versions: ["1.0.0"], current: "1.0.0", link: "1.0.0" });
    await appendFile(versionPath(f.layout, "1.0.0"), "x");
    const r = await f.recoverNow();
    expect(r.fatal).toBe("no verified Tropos version is installed; reinstall with install.sh");
    expect(await readLink(f.layout)).toEqual({ kind: "missing" });
    expect((await f.state()).current).toBeNull();
  });

  test("the fallback tail skips versions that failed a health check here", async () => {
    f = await makeEngineFixture();
    await f.setup({ versions: ["1.0.0", "1.1.0", "1.2.0"], current: "1.2.0", link: "1.2.0" });
    await writeState(f.layout, { ...(await f.state()), skip: { "1.1.0": "health-check" } });
    await rm(versionPath(f.layout, "1.2.0"));
    await f.recoverNow();
    expect(await readLink(f.layout)).toEqual({ kind: "ours", version: "1.0.0" });
  });

  test("a foreign link is never touched", async () => {
    f = await makeEngineFixture();
    await f.setup({ versions: ["1.0.0"], current: "1.0.0" });
    await symlink("/usr/bin/true", f.layout.binLink);
    await f.recoverNow();
    expect(await readLink(f.layout)).toEqual({ kind: "foreign", target: "/usr/bin/true" });
  });
});
```

- [ ] **Step 3: Run to see them fail**

Run: `bun test test/install/recovery.test.ts`
Expected: FAIL — `src/install/engine` / `recovery` not found.

- [ ] **Step 4: Implement `engine.ts`**

```ts
// src/install/engine.ts
import type { FlockFn } from "./flock";
import { checkSafeDir, ensureLayout, type DirOwner, type Layout } from "./layout";
import { acquireInstallLock, type LockInfo } from "./locks";
import type { Platform } from "./platform";
import { recover, type RecoveryReport } from "./recovery";
import type { RemoteDeps } from "./remote";
import { emptyState, readState, writeState, type InstallState } from "./state";
import type { HealthCheck, VerifyContext } from "./verify";

/** Named points where tests kill the process to prove crash consistency (spec §13 layer 4). Not reachable from the CLI. */
export type CrashPoint = "after-download" | "after-rename" | "after-pending" | "after-swap" | "after-state" | "mid-cleanup";

export interface EngineDeps extends RemoteDeps {
  layout: Layout;
  platform: Platform;
  health: HealthCheck;
  /** The running binary's version; recorded in the install lock for "who holds it" messages. */
  selfVersion: string;
  user?: DirOwner;
  flock?: FlockFn;
  lockTimeoutMs?: number;
  now?: () => Date;
  log?: (line: string) => void;
  crash?: (point: CrashPoint) => void;
}

export function verifyContext(d: EngineDeps): VerifyContext {
  return { layout: d.layout, platform: d.platform, trusted: d.trusted, health: d.health, user: d.user };
}

export class EngineSession {
  readonly ctx: VerifyContext;

  constructor(
    readonly deps: EngineDeps,
    public state: InstallState,
  ) {
    this.ctx = verifyContext(deps);
  }

  async save(patch: Partial<InstallState>): Promise<void> {
    this.state = await writeState(this.deps.layout, { ...this.state, ...patch });
  }

  crash(point: CrashPoint): void {
    this.deps.crash?.(point);
  }

  log(line: string): void {
    this.deps.log?.(line);
  }

  now(): Date {
    return this.deps.now?.() ?? new Date();
  }
}

export interface LockedRun<T> {
  value: T;
  recovery: RecoveryReport;
}

/** Every engine operation: safe directories, install lock, state, recovery — then `fn` (spec §10.3 step 1). */
export async function withInstallLock<T>(
  deps: EngineDeps,
  opts: { wait: boolean; onWait?: (holder: LockInfo | null) => void },
  fn: (s: EngineSession, recovery: RecoveryReport) => Promise<T>,
): Promise<LockedRun<T> | null> {
  await ensureLayout(deps.layout);
  await checkSafeDir(deps.layout.data, deps.user);
  await checkSafeDir(deps.layout.state, deps.user);
  const lock = await acquireInstallLock(deps.layout, {
    wait: opts.wait,
    version: deps.selfVersion,
    timeoutMs: deps.lockTimeoutMs,
    flock: deps.flock,
    sleep: deps.sleep,
    onWait: opts.onWait,
  });
  if (!lock) return null;
  try {
    const read = await readState(deps.layout);
    const session = new EngineSession(deps, read.kind === "ok" ? read.state : emptyState());
    const recovery = await recover(session, read);
    return { value: await fn(session, recovery), recovery };
  } finally {
    lock.release();
  }
}
```

- [ ] **Step 5: Implement `recovery.ts`**

```ts
// src/install/recovery.ts
import type { EngineSession } from "./engine";
import { readLink, removeOurLink, switchLink } from "./link";
import type { ReadStateResult } from "./state";
import { checkHealthy, checkVerified, isManaged, listManagedVersions } from "./verify";

export interface RecoveryReport {
  actions: string[];
  /** Set when no verified version can be active (amendment A11: rollback and background updates fail with it). */
  fatal: string | null;
}

const NO_VERIFIED = "no verified Tropos version is installed; reinstall with install.sh";
const FIRST_INSTALL_INCOMPLETE = "installation did not complete; run install.sh again";

/** First Healthy of: current, pending.to, pending.from, previous, then other managed versions newest first (spec §10.6). */
export async function selectFallback(s: EngineSession, exclude: ReadonlySet<string> = new Set()): Promise<string | null> {
  const st = s.state;
  const named = [st.current, st.pending?.to ?? null, st.pending?.from ?? null, st.previous];
  const rest = (await listManagedVersions(s.deps.layout)).filter((v) => st.skip[v] !== "health-check");
  const seen = new Set<string>();
  for (const v of [...named, ...rest]) {
    if (!v || seen.has(v) || exclude.has(v)) continue;
    seen.add(v);
    if ((await checkHealthy(s.ctx, v)).ok) return v;
  }
  return null;
}

/** Never activates a version that is not Healthy; never deletes files (spec §10.6). Runs under the install lock. */
export async function recover(s: EngineSession, read: ReadStateResult): Promise<RecoveryReport> {
  const l = s.deps.layout;
  const actions: string[] = [];
  let fatal: string | null = null;
  const link = await readLink(l);
  const linked = link.kind === "ours" ? link.version : null;
  const linkedManaged = linked !== null && (await isManaged(l, linked));
  const healthy = async (v: string | null): Promise<boolean> => v !== null && (await checkHealthy(s.ctx, v)).ok;

  const toFallback = async (why: string, exclude?: ReadonlySet<string>): Promise<string | null> => {
    const f = await selectFallback(s, exclude);
    if (f) {
      await switchLink(l, f);
      actions.push(`${why}; switched to ${f}`);
      return f;
    }
    if (await removeOurLink(l)) actions.push(`${why}; removed ${l.binLink}`);
    fatal = NO_VERIFIED;
    return null;
  };

  if (read.kind !== "ok") {
    if (read.kind === "missing" && !linkedManaged) return { actions, fatal }; // nothing managed, or a user's local build
    if (read.kind === "corrupt") actions.push(`install state was unreadable (${read.reason}); rebuilt it`);
    const current = linkedManaged && (await healthy(linked)) ? linked : await toFallback("the active version could not be verified");
    let previous: string | null = null;
    for (const v of await listManagedVersions(l)) {
      if (v !== current && (await healthy(v))) {
        previous = v;
        break;
      }
    }
    await s.save({ current, previous, pending: null });
    return { actions, fatal };
  }

  const st = s.state;
  if (st.pending) {
    const { from, to } = st.pending;
    if (linked === to && (await healthy(to))) {
      await s.save({ current: to, previous: from && from !== to ? from : st.previous, pending: null });
      actions.push(`finished the interrupted switch to ${to}`);
    } else if (from !== null && (await healthy(from))) {
      if (linked !== from) await switchLink(l, from);
      await s.save({ current: from, pending: null });
      actions.push(`undid the interrupted switch to ${to}; using ${from}`);
    } else if (from === null) {
      // Only remove a link that points at the half-installed version; an old local-build link stays.
      if ((link.kind === "ours" || link.kind === "dangling-ours") && link.version === to) await removeOurLink(l);
      await s.save({ current: null, pending: null });
      fatal = FIRST_INSTALL_INCOMPLETE;
      actions.push(FIRST_INSTALL_INCOMPLETE);
    } else {
      const f = await toFallback(`the interrupted switch to ${to} could not be completed`, new Set([to]));
      await s.save({ current: f, pending: null });
    }
  } else if (link.kind === "foreign") {
    // Not ours: never touched (spec §4.4).
  } else if (link.kind === "ours" && !linkedManaged && st.current === null) {
    // A local build the user linked themselves.
  } else if (linked !== null && linked !== st.current) {
    if (linkedManaged && (await healthy(linked))) {
      await s.save({ current: linked, previous: (await healthy(st.current)) ? st.current : st.previous });
      actions.push(`adopted ${linked}, which ${l.binLink} points to`);
    } else if (await healthy(st.current)) {
      await switchLink(l, st.current!);
      actions.push(`${l.binLink} pointed to ${linked}, which could not be verified; switched back to ${st.current}`);
    } else {
      await s.save({ current: await toFallback(`${l.binLink} pointed to an unverified version`) });
    }
  } else if (linked !== null) {
    if (!(await healthy(linked))) {
      const f = await toFallback(`${linked} could not be verified`, new Set([linked]));
      await s.save({ current: f, previous: f !== null && f === st.previous ? null : st.previous });
    }
  } else if (st.current !== null || link.kind === "dangling-ours") {
    await s.save({ current: await toFallback(`${l.binLink} was missing`) });
  }

  const prev = s.state.previous;
  if (prev !== null && (prev === s.state.current || !(await checkVerified(s.ctx, prev)).ok)) {
    await s.save({ previous: null });
    actions.push(`previous version ${prev} could not be verified; rollback is unavailable until another version is installed`);
  }
  return { actions, fatal };
}
```

- [ ] **Step 6: Run to see them pass**

Run: `bun test test/install/recovery.test.ts && bun run typecheck`
Expected: PASS (14 tests).

- [ ] **Step 7: Commit**

```bash
git add src/install/engine.ts src/install/recovery.ts test/install/helpers/engine.ts test/install/recovery.test.ts
git commit -m "feat(install): engine session under the install lock and Healthy-only recovery

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 15: Cleanup

Spec: §10.5 (keep rules, quarantine, staging), R5.4, Review Focus 3.

**Files:**
- Create: `src/install/cleanup.ts`
- Create: `test/install/cleanup.test.ts`

**Interfaces:**
- Consumes: `EngineSession` (Task 14); `listManagedVersions`, `checkVerified` (Task 13); `tryLockVersionExclusive` (Task 11); `versionPath`, `manifestDir` (Task 10); `isVersion` (Task 3)
- Produces: `KEEP_NEWEST = 3`, `cleanup(s: EngineSession): Promise<string[]>` (names removed)

- [ ] **Step 1: Write the failing tests**

```ts
// test/install/cleanup.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import { readdir, utimes, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { cleanup } from "../../src/install/cleanup";
import { withInstallLock } from "../../src/install/engine";
import { versionPath } from "../../src/install/layout";
import { lockVersionShared } from "../../src/install/locks";
import { makeEngineFixture, type EngineFixture } from "./helpers/engine";

let f: EngineFixture;
afterEach(() => f?.close());

const runCleanup = async (now?: Date) => (await withInstallLock(now ? { ...f.deps, now: () => now } : f.deps, { wait: true }, (s) => cleanup(s)))!.value;

describe("cleanup (spec §10.5)", () => {
  test("keeps current, previous and the 3 newest verified; removes the rest with their manifests", async () => {
    f = await makeEngineFixture();
    await f.setup({ versions: ["1.0.0", "1.1.0", "1.2.0", "1.3.0", "1.4.0"], current: "1.2.0", previous: "1.0.0", link: "1.2.0" });
    expect(await runCleanup()).toEqual(["1.1.0"]);
    expect((await readdir(f.layout.versions)).sort()).toEqual(["1.0.0", "1.2.0", "1.3.0", "1.4.0"]);
    expect((await readdir(f.layout.manifests)).sort()).toEqual(["1.0.0", "1.2.0", "1.3.0", "1.4.0"]);
  });

  test("never deletes a version a session is running (R5.4)", async () => {
    f = await makeEngineFixture();
    await f.setup({ versions: ["1.0.0", "1.1.0", "1.2.0", "1.3.0", "1.4.0"], current: "1.4.0", previous: "1.3.0", link: "1.4.0" });
    const session = (await lockVersionShared(f.layout, "1.0.0"))!;
    expect(await runCleanup()).toEqual(["1.1.0"]);
    session.release();
    expect(await runCleanup()).toEqual(["1.0.0"]);
  });

  test("never deletes unmanaged versions (Review Focus 3)", async () => {
    f = await makeEngineFixture();
    await f.setup({ versions: ["1.0.0", "1.1.0", "1.2.0", "1.3.0"], current: "1.3.0", link: "1.3.0" });
    await writeFile(versionPath(f.layout, "0.1.0"), "local build");
    await writeFile(join(f.layout.versions, ".unmanaged-0.0.9-1"), "old local build");
    expect(await runCleanup()).toEqual(["1.0.0"]);
    expect(await readdir(f.layout.versions)).toContain("0.1.0");
    expect(await readdir(f.layout.versions)).toContain(".unmanaged-0.0.9-1");
  });

  test("removes a manifest whose binary is gone (crash between the two writes, amendment A10)", async () => {
    f = await makeEngineFixture();
    await f.setup({ versions: ["1.0.0", "1.1.0", "1.2.0", "1.3.0"], current: "1.3.0", link: "1.3.0" });
    await Bun.$`rm ${versionPath(f.layout, "1.2.0")}`;
    const removed = await runCleanup();
    expect(removed).toContain("1.2.0");
    expect(await readdir(f.layout.manifests)).not.toContain("1.2.0");
  });

  test("quarantine is deleted after 7 days, staging after 1 hour", async () => {
    f = await makeEngineFixture();
    await f.setup({ versions: ["1.0.0"], current: "1.0.0", link: "1.0.0" });
    const now = Date.UTC(2026, 9, 13);
    await writeFile(join(f.layout.versions, `.corrupt-1.0.0-${now - 8 * 86_400_000}`), "old");
    await writeFile(join(f.layout.versions, `.corrupt-1.0.0-${now - 86_400_000}`), "recent");
    await mkdir(join(f.layout.staging, "1.0.0.abc"));
    await writeFile(join(f.layout.staging, "1.0.0.def"), "partial");
    await utimes(join(f.layout.staging, "1.0.0.abc"), new Date(now - 7_200_000), new Date(now - 7_200_000));
    await utimes(join(f.layout.staging, "1.0.0.def"), new Date(now - 60_000), new Date(now - 60_000));
    const removed = await runCleanup(new Date(now));
    expect(removed.sort()).toEqual([`.corrupt-1.0.0-${now - 8 * 86_400_000}`, "staging/1.0.0.abc"].sort());
  });

  test("quarantine of a version a process still runs is kept", async () => {
    f = await makeEngineFixture();
    await f.setup({ versions: ["1.0.0"], current: "1.0.0", link: "1.0.0" });
    const now = Date.UTC(2026, 9, 13);
    const name = `.corrupt-1.0.0-${now - 8 * 86_400_000}`;
    await writeFile(join(f.layout.versions, name), "old");
    const session = (await lockVersionShared(f.layout, "1.0.0"))!;
    expect(await runCleanup(new Date(now))).toEqual([]);
    session.release();
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `bun test test/install/cleanup.test.ts`
Expected: FAIL — `src/install/cleanup` not found.

- [ ] **Step 3: Implement**

```ts
// src/install/cleanup.ts
import { lstat, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { EngineSession } from "./engine";
import { manifestDir, versionPath } from "./layout";
import { tryLockVersionExclusive } from "./locks";
import { checkVerified, listManagedVersions } from "./verify";
import { isVersion } from "./version";

export const KEEP_NEWEST = 3;
const STAGING_MAX_AGE_MS = 60 * 60 * 1000;
const QUARANTINE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const QUARANTINE_RE = /^\.corrupt-(.+)-(\d+)$/;

/**
 * Spec §10.5. Deletes only managed versions outside the keep set, and only while holding their exclusive
 * version lock, which no running session shares. Unmanaged files and `.unmanaged-*` are never touched.
 */
export async function cleanup(s: EngineSession): Promise<string[]> {
  const l = s.deps.layout;
  const now = s.now().getTime();
  const removed: string[] = [];
  const st = s.state;

  const managed = await listManagedVersions(l);
  const verified: string[] = [];
  for (const v of managed) if ((await checkVerified(s.ctx, v)).ok) verified.push(v);
  const keep = new Set([st.current, st.previous, st.pending?.from ?? null, st.pending?.to ?? null, ...verified.slice(0, KEEP_NEWEST)].filter((v): v is string => v !== null));

  for (const v of managed) {
    if (keep.has(v)) continue;
    const lock = tryLockVersionExclusive(l, v, s.deps.flock);
    if (!lock) {
      s.log(`kept ${v}: a running session uses it`);
      continue;
    }
    try {
      s.crash("mid-cleanup");
      await rm(versionPath(l, v), { force: true });
      await rm(manifestDir(l, v), { recursive: true, force: true });
      removed.push(v);
    } finally {
      lock.release();
    }
  }

  for (const name of await readdir(l.versions)) {
    const m = QUARANTINE_RE.exec(name);
    if (!m || !isVersion(m[1]) || now - Number(m[2]) < QUARANTINE_MAX_AGE_MS) continue;
    const lock = tryLockVersionExclusive(l, m[1], s.deps.flock);
    if (!lock) continue;
    try {
      await rm(join(l.versions, name), { force: true });
      removed.push(name);
    } finally {
      lock.release();
    }
  }

  for (const name of await readdir(l.staging)) {
    const path = join(l.staging, name);
    const info = await lstat(path).catch(() => null);
    if (info && now - info.mtimeMs > STAGING_MAX_AGE_MS) {
      await rm(path, { recursive: true, force: true });
      removed.push(`staging/${name}`);
    }
  }
  return removed;
}
```

- [ ] **Step 4: Run to see them pass**

Run: `bun test test/install/cleanup.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/install/cleanup.ts test/install/cleanup.test.ts
git commit -m "feat(install): lock-guarded cleanup that never removes versions in use

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 16: Installer and rollback

Spec: §10.3 (all steps, `--self`, `--force`, immutability rule), §10.7, amendments A9–A10, R1.1–R1.3, R5.1–R5.3, Review Focus 2–3.

**Files:**
- Create: `src/install/installer.ts`
- Create: `src/install/rollback.ts`
- Create: `test/install/installer.test.ts`
- Create: `test/install/rollback.test.ts`

**Interfaces:**
- Consumes: Tasks 3–15
- Produces: `type InstallSource = { kind: "remote" } | { kind: "self"; execPath: string; manifestPath: string; signaturePath: string; compiledVersion: string }`, `interface InstallOptions { force: boolean; source: InstallSource }`, `interface InstallOutcome { version: string; previous: string | null; changed: boolean }`, `installVersion(s, version, opts): Promise<InstallOutcome>`, `installTarget(deps, target: string, force: boolean, onWait?): Promise<LockedRun<InstallOutcome>>`, `installSelf(deps, source): Promise<LockedRun<InstallOutcome>>`, `type UpdateResult = { kind: "updated"; outcome: InstallOutcome } | { kind: "up-to-date"; current: string | null; available: string } | { kind: "skipped"; version: string; reason: SkipReason }`, `updateChannel(deps, channel, opts: { wait: boolean; onWait? }): Promise<LockedRun<UpdateResult> | null>`
- Produces: `rollback(deps): Promise<LockedRun<InstallOutcome>>`

- [ ] **Step 1: Write the failing installer tests**

```ts
// test/install/installer.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import { appendFile, chmod, mkdir, readdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { InstallError } from "../../src/install/errors";
import { installSelf, installTarget, updateChannel } from "../../src/install/installer";
import { versionPath } from "../../src/install/layout";
import { readLink } from "../../src/install/link";
import { lockVersionShared } from "../../src/install/locks";
import { writeState } from "../../src/install/state";
import { fakeBinary } from "./helpers/fixture-release";
import { makeTestKey, sshSign } from "./helpers/keys";
import { makeEngineFixture, type EngineFixture } from "./helpers/engine";

let f: EngineFixture;
afterEach(() => f?.close());
const err = async (p: Promise<unknown>) => (await p.then(() => null, (e: unknown) => e)) as InstallError;

describe("install from the network", () => {
  test("first install of an explicit version via the zst asset", async () => {
    f = await makeEngineFixture();
    await f.release("1.0.0");
    const { value } = await installTarget(f.deps, "1.0.0", false);
    expect(value).toEqual({ version: "1.0.0", previous: null, changed: true });
    expect(await readLink(f.layout)).toEqual({ kind: "ours", version: "1.0.0" });
    expect(await f.state()).toMatchObject({ current: "1.0.0", previous: null, pending: null });
    expect(f.srv.requests.some((r) => r.endsWith(".zst"))).toBe(true);
    expect((await stat(versionPath(f.layout, "1.0.0"))).mode & 0o777).toBe(0o755);
    expect(await readdir(f.layout.staging)).toEqual([]);
  });

  test("installs under a layout path with spaces (Review Focus 2)", async () => {
    f = await makeEngineFixture();
    expect(f.home).toContain(" ");
    await f.release("1.0.0");
    await installTarget(f.deps, "1.0.0", false);
    expect(await readLink(f.layout)).toEqual({ kind: "ours", version: "1.0.0" });
  });

  test("resolves a channel, upgrades and records previous", async () => {
    f = await makeEngineFixture();
    await f.release("1.0.0");
    await f.release("1.1.0");
    await installTarget(f.deps, "1.0.0", false);
    f.srv.put("channels", "latest", "1.1.0\n");
    const { value } = await installTarget(f.deps, "latest", false);
    expect(value).toEqual({ version: "1.1.0", previous: "1.0.0", changed: true });
    expect(await f.state()).toMatchObject({ current: "1.1.0", previous: "1.0.0" });
  });

  test("reinstalling the current version is a no-op without network access", async () => {
    f = await makeEngineFixture();
    await f.release("1.0.0");
    await installTarget(f.deps, "1.0.0", false);
    const before = f.srv.requests.length;
    expect((await installTarget(f.deps, "1.0.0", false)).value.changed).toBe(false);
    expect(f.srv.requests.length).toBe(before);
  });

  test("falls back to the raw asset when the zst is corrupt", async () => {
    f = await makeEngineFixture();
    const r = await f.release("1.0.0");
    f.srv.put("v1.0.0", `tropos-${f.deps.platform}.zst`, r.zst.subarray(0, 10));
    await installTarget(f.deps, "1.0.0", false);
    expect(f.srv.requests.some((p) => p.endsWith(`/tropos-${f.deps.platform}`))).toBe(true);
  });

  test("a raw asset that never matches fails with integrity after 3 tries; nothing activated", async () => {
    f = await makeEngineFixture();
    await f.release("1.0.0");
    f.srv.put("v1.0.0", `tropos-${f.deps.platform}.zst`, "junk");
    f.srv.put("v1.0.0", `tropos-${f.deps.platform}`, "not the binary");
    const e = await err(installTarget(f.deps, "1.0.0", false));
    expect(e.kind).toBe("integrity");
    expect(await readLink(f.layout)).toEqual({ kind: "missing" });
    expect(await readdir(f.layout.staging)).toEqual([]);
  });

  test("a release that fails its health check is skipped and never activated", async () => {
    f = await makeEngineFixture();
    await f.release("1.0.0");
    await installTarget(f.deps, "1.0.0", false);
    await f.release("1.1.0", "#!/bin/sh\nexit 1\n");
    const e = await err(installTarget(f.deps, "1.1.0", false));
    expect(e.message).toBe("release 1.1.0 does not run on this machine");
    expect(await readLink(f.layout)).toEqual({ kind: "ours", version: "1.0.0" });
    expect((await f.state()).skip).toEqual({ "1.1.0": "health-check" });
  });

  test("a foreign ~/.local/bin/tropos needs --force", async () => {
    f = await makeEngineFixture();
    await f.release("1.0.0");
    await writeFile(f.layout.binLink, "#!/bin/sh\n");
    expect((await err(installTarget(f.deps, "1.0.0", false))).message).toContain("is not managed by Tropos");
    await installTarget(f.deps, "1.0.0", true);
    expect(await readLink(f.layout)).toEqual({ kind: "ours", version: "1.0.0" });
  });

  test("replaces an unmanaged symlink into versions/ without --force (Review Focus 3)", async () => {
    f = await makeEngineFixture();
    await f.release("1.0.0");
    await writeFile(versionPath(f.layout, "0.1.0"), "local build");
    await symlink(versionPath(f.layout, "0.1.0"), f.layout.binLink);
    await installTarget(f.deps, "1.0.0", false);
    expect(await readLink(f.layout)).toEqual({ kind: "ours", version: "1.0.0" });
    expect(await readFile(versionPath(f.layout, "0.1.0"), "utf8")).toBe("local build");
    expect((await f.state()).previous).toBeNull();
  });

  test("an unmanaged local build with a release's version number is moved aside, never deleted (A9)", async () => {
    f = await makeEngineFixture();
    await f.release("1.0.0");
    await writeFile(versionPath(f.layout, "1.0.0"), "local build of 1.0.0");
    await installTarget(f.deps, "1.0.0", false);
    expect((await readdir(f.layout.versions)).some((n) => n.startsWith(".unmanaged-1.0.0-"))).toBe(true);
  });

  test("versions/<v> planted as a symlink is never followed or trusted", async () => {
    f = await makeEngineFixture();
    await f.release("1.0.0");
    const decoy = join(f.root, "decoy");
    await writeFile(decoy, "decoy");
    await symlink(decoy, versionPath(f.layout, "1.0.0"));
    await installTarget(f.deps, "1.0.0", false);
    expect(await readFile(decoy, "utf8")).toBe("decoy");
    expect((await stat(versionPath(f.layout, "1.0.0"))).isFile()).toBe(true);
  });

  test("world-writable bin directory is refused", async () => {
    f = await makeEngineFixture();
    await f.release("1.0.0");
    await chmod(f.layout.binDir, 0o777);
    expect((await err(installTarget(f.deps, "1.0.0", false))).kind).toBe("local");
  });
});

describe("--force and damaged versions (R5.1–R5.3)", () => {
  test("--force on the current version keeps the verified file (same inode) and re-checks it", async () => {
    f = await makeEngineFixture();
    await f.release("1.0.0");
    await installTarget(f.deps, "1.0.0", false);
    const inode = (await stat(versionPath(f.layout, "1.0.0"))).ino;
    let healthChecks = 0;
    const deps = { ...f.deps, health: async (b: string, v: string) => (healthChecks++, f.deps.health(b, v)) };
    expect((await installTarget(deps, "1.0.0", true)).value.version).toBe("1.0.0");
    expect((await stat(versionPath(f.layout, "1.0.0"))).ino).toBe(inode);
    expect(healthChecks).toBeGreaterThan(0);
  });

  test("a damaged version in use is not touched; the link moves to a healthy fallback; exit busy", async () => {
    f = await makeEngineFixture();
    await f.release("1.0.0");
    await f.release("1.1.0");
    await installTarget(f.deps, "1.0.0", false);
    await installTarget(f.deps, "1.1.0", false);
    const session = (await lockVersionShared(f.layout, "1.1.0"))!;
    await appendFile(versionPath(f.layout, "1.1.0"), "damage");
    const damaged = await readFile(versionPath(f.layout, "1.1.0"));
    // Recovery (run first) already moves the link; the install then refuses to replace the file in use.
    const e = await err(installTarget(f.deps, "1.1.0", true));
    expect(e.kind).toBe("busy");
    expect(await readFile(versionPath(f.layout, "1.1.0"))).toEqual(damaged);
    expect(await readLink(f.layout)).toEqual({ kind: "ours", version: "1.0.0" });
    session.release();
  });

  test("a damaged version not in use is quarantined and replaced", async () => {
    f = await makeEngineFixture();
    await f.release("1.0.0");
    await installTarget(f.deps, "1.0.0", false);
    await appendFile(versionPath(f.layout, "1.0.0"), "damage");
    await installTarget(f.deps, "1.0.0", true);
    expect((await readdir(f.layout.versions)).some((n) => n.startsWith(".corrupt-1.0.0-"))).toBe(true);
    expect(await readLink(f.layout)).toEqual({ kind: "ours", version: "1.0.0" });
  });
});

describe("install --self (R1.1–R1.3)", () => {
  async function selfSource(version: string, opts: { tamperBinary?: boolean; untrusted?: boolean; manifestVersion?: string } = {}) {
    const r = await f.release(opts.manifestVersion ?? version);
    const tmp = join(f.root, `tmp-${Math.random().toString(36).slice(2)}`);
    await mkdir(tmp);
    const exe = join(tmp, "tropos");
    await writeFile(exe, opts.tamperBinary ? fakeBinary(version, "# tampered") : r.binary);
    await chmod(exe, 0o700);
    await writeFile(join(tmp, "manifest.json"), r.verified.bytes);
    const sig = opts.untrusted ? await sshSign(await makeTestKey(f.root, `u${Date.now()}`), r.verified.bytes, "tropos-manifest", f.root) : r.verified.signature;
    await writeFile(join(tmp, "manifest.json.sig"), sig);
    return { kind: "self" as const, execPath: exe, manifestPath: join(tmp, "manifest.json"), signaturePath: join(tmp, "manifest.json.sig"), compiledVersion: version };
  }

  test("installs from a verified temporary executable outside $DATA", async () => {
    f = await makeEngineFixture();
    const { value } = await installSelf(f.deps, await selfSource("1.0.0"));
    expect(value.version).toBe("1.0.0");
    expect(await readLink(f.layout)).toEqual({ kind: "ours", version: "1.0.0" });
    expect(f.srv.requests.filter((r) => r.includes("/tropos-")).length).toBe(0);
  });

  test.each([
    ["a binary whose bytes differ from the manifest", { tamperBinary: true }, "integrity"],
    ["a signature from an untrusted key", { untrusted: true }, "integrity"],
    ["a manifest for another version", { manifestVersion: "1.0.1" }, "integrity"],
  ])("rejects %s", async (_n, opts, kind) => {
    f = await makeEngineFixture();
    const e = await err(installSelf(f.deps, await selfSource("1.0.0", opts)));
    expect(e.kind).toBe(kind as never);
    expect(await readLink(f.layout)).toEqual({ kind: "missing" });
  });

  test("a missing manifest file is a usage error", async () => {
    f = await makeEngineFixture();
    const src = { ...(await selfSource("1.0.0")), manifestPath: join(f.root, "nope.json") };
    expect((await err(installSelf(f.deps, src))).kind).toBe("usage");
  });
});

describe("updateChannel", () => {
  test("up to date, skipped, updated, never a downgrade", async () => {
    f = await makeEngineFixture();
    await f.release("1.0.0");
    await f.release("1.1.0");
    await f.release("0.9.0");
    await installTarget(f.deps, "1.0.0", false);
    f.srv.put("channels", "stable", "0.9.0\n");
    expect((await updateChannel(f.deps, "stable", { wait: true }))!.value).toEqual({ kind: "up-to-date", current: "1.0.0", available: "0.9.0" });
    f.srv.put("channels", "latest", "1.1.0\n");
    await writeState(f.layout, { ...(await f.state()), skip: { "1.1.0": "rolled-back" } });
    expect((await updateChannel(f.deps, "latest", { wait: true }))!.value).toEqual({ kind: "skipped", version: "1.1.0", reason: "rolled-back" });
    await writeState(f.layout, { ...(await f.state()), skip: {} });
    expect((await updateChannel(f.deps, "latest", { wait: true }))!.value.kind).toBe("updated");
  });
});
```

```ts
// test/install/rollback.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import { appendFile } from "node:fs/promises";
import { InstallError } from "../../src/install/errors";
import { installTarget } from "../../src/install/installer";
import { versionPath } from "../../src/install/layout";
import { readLink } from "../../src/install/link";
import { rollback } from "../../src/install/rollback";
import { makeEngineFixture, type EngineFixture } from "./helpers/engine";

let f: EngineFixture;
afterEach(() => f?.close());

describe("rollback (spec §10.7)", () => {
  test("switches to previous and skips the version rolled back from", async () => {
    f = await makeEngineFixture();
    await f.release("1.0.0");
    await f.release("1.1.0");
    await installTarget(f.deps, "1.0.0", false);
    await installTarget(f.deps, "1.1.0", false);
    const { value } = await rollback(f.deps);
    expect(value).toEqual({ version: "1.0.0", previous: "1.1.0", changed: true });
    expect(await readLink(f.layout)).toEqual({ kind: "ours", version: "1.0.0" });
    expect(await f.state()).toMatchObject({ current: "1.0.0", previous: "1.1.0", skip: { "1.1.0": "rolled-back" } });
  });

  test("without a previous version it fails with integrity", async () => {
    f = await makeEngineFixture();
    await f.release("1.0.0");
    await installTarget(f.deps, "1.0.0", false);
    const e = (await rollback(f.deps).catch((x) => x)) as InstallError;
    expect(e.kind).toBe("integrity");
    expect(e.message).toStartWith("no verified previous version to roll back to");
  });

  test("a corrupted previous version is never activated (R6.3)", async () => {
    f = await makeEngineFixture();
    await f.release("1.0.0");
    await f.release("1.1.0");
    await f.release("1.2.0");
    await installTarget(f.deps, "1.0.0", false);
    await installTarget(f.deps, "1.1.0", false);
    await installTarget(f.deps, "1.2.0", false);
    await appendFile(versionPath(f.layout, "1.1.0"), "x");
    const e = (await rollback(f.deps).catch((x) => x)) as InstallError;
    expect(e.kind).toBe("integrity");
    expect(e.message).toContain("verified versions: 1.0.0");
    expect(await readLink(f.layout)).toEqual({ kind: "ours", version: "1.2.0" });
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `bun test test/install/installer.test.ts test/install/rollback.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement `installer.ts`**

```ts
// src/install/installer.ts
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, copyFile, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { isChannel, resolveChannel, type Channel } from "./channels";
import { cleanup } from "./cleanup";
import { decompressZstdFile } from "./decompress";
import { withInstallLock, type EngineDeps, type EngineSession, type LockedRun } from "./engine";
import { InstallError } from "./errors";
import { downloadToFile } from "./fetch";
import { fsyncDir, fsyncFile, sha256File } from "./files";
import { checkSafeDir, versionPath } from "./layout";
import { linkResolvesTo, readLink, removeOurLink, switchLink, type LinkState } from "./link";
import type { LockInfo, LockHandle } from "./locks";
import { tryLockVersionExclusive } from "./locks";
import { expectVersion, verifyManifest, type PlatformEntry, type VerifiedManifest } from "./manifest";
import { selectFallback } from "./recovery";
import { SMALL_TIMEOUT_MS, fetchVersionManifest, withRetries } from "./remote";
import type { SkipReason } from "./state";
import { checkFileAgainst, checkHealthy, isManaged, storeManifest } from "./verify";
import { compareVersions, isVersion } from "./version";

export type InstallSource =
  | { kind: "remote" }
  | { kind: "self"; execPath: string; manifestPath: string; signaturePath: string; compiledVersion: string };

export interface InstallOptions {
  force: boolean;
  source: InstallSource;
}

export interface InstallOutcome {
  version: string;
  previous: string | null;
  changed: boolean;
}

async function obtainManifest(s: EngineSession, version: string, source: InstallSource): Promise<VerifiedManifest> {
  if (source.kind === "remote") return fetchVersionManifest(version, s.deps);
  if (version !== source.compiledVersion) throw new InstallError("integrity", `this binary is ${source.compiledVersion}, not ${version}`);
  let bytes: Buffer;
  let signature: string;
  try {
    [bytes, signature] = await Promise.all([readFile(source.manifestPath), readFile(source.signaturePath, "utf8")]);
  } catch (e) {
    throw new InstallError("usage", `cannot read the manifest or its signature: ${(e as Error).message}`);
  }
  const vm = verifyManifest(new Uint8Array(bytes), signature, s.deps.trusted);
  expectVersion(vm.manifest, source.compiledVersion);
  return vm;
}

async function preSwitchChecks(s: EngineSession, link: LinkState, force: boolean): Promise<void> {
  const l = s.deps.layout;
  await checkSafeDir(l.data, s.deps.user);
  await checkSafeDir(l.binDir, s.deps.user);
  if (link.kind === "foreign" && !force) {
    throw new InstallError("local", `${l.binLink} exists and is not managed by Tropos; move it away or rerun with --force`);
  }
}

/** zst first (verified before decompression), raw as fallback; a raw mismatch is retried twice (spec §10.3 step 4). */
async function downloadVerified(s: EngineSession, version: string, entry: PlatformEntry, staged: string): Promise<void> {
  const d = s.deps;
  const opts = { timeoutMs: SMALL_TIMEOUT_MS, fetch: d.fetch, allowLoopbackHttp: d.allowLoopbackHttp };
  const zstPath = `${staged}.zst`;
  try {
    const got = await withRetries(async () => {
      await rm(zstPath, { force: true });
      return downloadToFile(d.urls.asset(version, entry.zst.asset), zstPath, { ...opts, maxBytes: entry.zst.size });
    }, d);
    if (got.size !== entry.zst.size || got.sha256 !== entry.zst.sha256) throw new InstallError("integrity", "the compressed download does not match the manifest");
    await decompressZstdFile(zstPath, staged, entry);
    return;
  } catch (e) {
    if (!(e instanceof InstallError)) throw e;
    s.log(`compressed download failed (${e.message}); downloading the uncompressed binary`);
    await rm(staged, { force: true });
  } finally {
    await rm(zstPath, { force: true });
  }
  for (let attempt = 1; ; attempt++) {
    const got = await withRetries(async () => {
      await rm(staged, { force: true });
      return downloadToFile(d.urls.asset(version, entry.asset), staged, { ...opts, maxBytes: entry.size });
    }, d);
    if (got.size === entry.size && got.sha256 === entry.sha256) return;
    if (attempt === 3) throw new InstallError("integrity", `the download of ${entry.asset} does not match the manifest (tried 3 times)`);
  }
}

async function stage(s: EngineSession, version: string, entry: PlatformEntry, source: InstallSource): Promise<string> {
  const staged = join(s.deps.layout.staging, `${version}.${randomUUID()}`);
  try {
    if (source.kind === "self") {
      await copyFile(source.execPath, staged, constants.COPYFILE_EXCL);
      // Hash the copy that will be installed, not the source, so a later change to the source cannot slip through.
      const got = await sha256File(staged);
      if (got.size !== entry.size || got.sha256 !== entry.sha256) throw new InstallError("integrity", "this binary does not match its signed manifest");
    } else {
      await downloadVerified(s, version, entry, staged);
    }
    await chmod(staged, 0o755);
    await fsyncFile(staged);
    return staged;
  } catch (e) {
    await rm(staged, { force: true });
    throw e;
  }
}

/** Spec §10.3 steps 2–10. Caller holds the install lock and has run recovery. */
export async function installVersion(s: EngineSession, version: string, opts: InstallOptions): Promise<InstallOutcome> {
  const d = s.deps;
  const l = d.layout;
  const link = await readLink(l);
  if (!opts.force && s.state.current === version && link.kind === "ours" && link.version === version && (await checkHealthy(s.ctx, version)).ok) {
    return { version, previous: s.state.previous, changed: false };
  }

  const vm = await obtainManifest(s, version, opts.source);
  await preSwitchChecks(s, link, opts.force);
  const entry = vm.manifest.platforms[d.platform];
  const target = versionPath(l, version);

  let exclusive: LockHandle | null = null;
  try {
    const existing = await checkFileAgainst(target, entry, d.user);
    if (!existing.ok && existing.reason !== "missing") {
      // Immutability rule (spec §10.2): replace a damaged file only while no process runs it.
      exclusive = tryLockVersionExclusive(l, version, d.flock);
      if (!exclusive) {
        if (s.state.current === version) {
          const fallback = await selectFallback(s, new Set([version]));
          if (fallback) {
            await switchLink(l, fallback);
            await s.save({ current: fallback, previous: s.state.previous === fallback ? null : s.state.previous });
          }
        }
        throw new InstallError("busy", `version ${version} is damaged and in use by running sessions; close them and run \`tropos install ${version} --force\` again`);
      }
      const aside = join(l.versions, `${(await isManaged(l, version)) ? ".corrupt" : ".unmanaged"}-${version}-${s.now().getTime()}`);
      await rename(target, aside);
      s.log(`moved the unverifiable ${target} to ${aside}`);
    }
    await storeManifest(l, version, vm); // A10: the signed manifest is stored before the binary appears
    if (!existing.ok) {
      const staged = await stage(s, version, entry, opts.source);
      s.crash("after-download");
      await rename(staged, target);
      await fsyncDir(l.versions);
      s.crash("after-rename");
    }
  } finally {
    exclusive?.release();
  }

  if (!(await checkHealthy(s.ctx, version)).ok) {
    await s.save({ skip: { ...s.state.skip, [version]: "health-check" } });
    throw new InstallError("integrity", `release ${version} does not run on this machine`);
  }

  const from = s.state.current;
  await s.save({ pending: { op: "switch", from, to: version } });
  s.crash("after-pending");
  await switchLink(l, version);
  s.crash("after-swap");

  if (!(await linkResolvesTo(l, version)) || !(await d.health(l.binLink, version))) {
    const restored = from !== null && (await checkHealthy(s.ctx, from)).ok ? from : await selectFallback(s, new Set([version]));
    if (restored) await switchLink(l, restored);
    else await removeOurLink(l);
    await s.save({ current: restored, pending: null, skip: { ...s.state.skip, [version]: "health-check" } });
    throw new InstallError("integrity", `release ${version} failed its check after switching; ${restored ? `still using ${restored}` : "no verified version is active"}`);
  }

  const skip = { ...s.state.skip };
  delete skip[version];
  await s.save({ current: version, previous: from !== null && from !== version ? from : s.state.previous, pending: null, skip });
  s.crash("after-state");
  try {
    await cleanup(s);
  } catch (e) {
    s.log(`cleanup failed: ${(e as Error).message}`);
  }
  return { version, previous: from, changed: from !== version };
}

/** `tropos install [stable|latest|<version>] [--force]`. An explicit install clears the version's skip entry. */
export async function installTarget(deps: EngineDeps, target: string, force: boolean, onWait?: (holder: LockInfo | null) => void): Promise<LockedRun<InstallOutcome>> {
  const run = await withInstallLock(deps, { wait: true, onWait }, async (s) => {
    const version = isChannel(target) ? (await resolveChannel(target, deps)).version : target;
    if (!isVersion(version)) throw new InstallError("usage", `not a version or channel: ${target}`);
    if (s.state.skip[version]) {
      const skip = { ...s.state.skip };
      delete skip[version];
      await s.save({ skip });
    }
    return installVersion(s, version, { force, source: { kind: "remote" } });
  });
  return run!;
}

/** `tropos install --self …`, run by install.sh from its temporary folder (spec §10.3). */
export async function installSelf(deps: EngineDeps, source: Extract<InstallSource, { kind: "self" }>): Promise<LockedRun<InstallOutcome>> {
  const run = await withInstallLock(deps, { wait: true }, (s) => installVersion(s, source.compiledVersion, { force: false, source }));
  return run!;
}

export type UpdateResult =
  | { kind: "updated"; outcome: InstallOutcome }
  | { kind: "up-to-date"; current: string | null; available: string }
  | { kind: "skipped"; version: string; reason: SkipReason };

/** `tropos update` and background updates: only ever moves forward, never to a skipped version (spec §11). */
export async function updateChannel(deps: EngineDeps, channel: Channel, opts: { wait: boolean; onWait?: (holder: LockInfo | null) => void }): Promise<LockedRun<UpdateResult> | null> {
  return withInstallLock(deps, opts, async (s): Promise<UpdateResult> => {
    const available = (await resolveChannel(channel, deps)).version;
    const current = s.state.current;
    if (current !== null && compareVersions(available, current) <= 0) return { kind: "up-to-date", current, available };
    const reason = s.state.skip[available];
    if (reason) return { kind: "skipped", version: available, reason };
    return { kind: "updated", outcome: await installVersion(s, available, { force: false, source: { kind: "remote" } }) };
  });
}
```

- [ ] **Step 4: Implement `rollback.ts`**

```ts
// src/install/rollback.ts
import { withInstallLock, type EngineDeps, type LockedRun } from "./engine";
import { InstallError } from "./errors";
import type { InstallOutcome } from "./installer";
import { linkResolvesTo, switchLink } from "./link";
import { checkHealthy, listManagedVersions } from "./verify";

/** Spec §10.7: only to a Healthy `previous`; the version rolled back from is skipped by background updates. */
export async function rollback(deps: EngineDeps): Promise<LockedRun<InstallOutcome>> {
  const run = await withInstallLock(deps, { wait: true }, async (s, recovery) => {
    if (recovery.fatal) throw new InstallError("integrity", recovery.fatal);
    const l = deps.layout;
    const current = s.state.current;
    const previous = s.state.previous;
    if (previous === null || !(await checkHealthy(s.ctx, previous)).ok) {
      const healthy: string[] = [];
      for (const v of await listManagedVersions(l)) if (v !== current && (await checkHealthy(s.ctx, v)).ok) healthy.push(v);
      const hint = healthy.length ? `; verified versions: ${healthy.join(", ")} — install one with tropos install <version>` : "";
      throw new InstallError("integrity", `no verified previous version to roll back to${hint}`);
    }
    await s.save({ pending: { op: "switch", from: current, to: previous } });
    s.crash("after-pending");
    await switchLink(l, previous);
    s.crash("after-swap");
    if (!(await linkResolvesTo(l, previous)) || !(await deps.health(l.binLink, previous))) {
      if (current !== null) await switchLink(l, current);
      await s.save({ pending: null });
      throw new InstallError("integrity", `version ${previous} failed its check; still using ${current}`);
    }
    const skip = current !== null ? { ...s.state.skip, [current]: "rolled-back" as const } : s.state.skip;
    await s.save({ current: previous, previous: current, pending: null, skip });
    s.crash("after-state");
    return { version: previous, previous: current, changed: true };
  });
  return run!;
}
```

- [ ] **Step 5: Run to see them pass**

Run: `bun test test/install/installer.test.ts test/install/rollback.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/install/installer.ts src/install/rollback.ts test/install/installer.test.ts test/install/rollback.test.ts
git commit -m "feat(install): atomic verified install, --self, --force semantics and rollback

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 17: Crash, property and multi-process concurrency suites

Spec: §13 layers 3–4, R5.x, R6.1–R6.4. Child processes are killed with `SIGKILL` at the engine's crash points; the parent then runs recovery and checks the invariants.

**Files:**
- Create: `test/install/helpers/crash-child.ts`
- Create: `test/install/crash.test.ts`
- Create: `test/install/property.test.ts`
- Create: `test/install/concurrency.test.ts`

**Interfaces:**
- Consumes: `installTarget`, `rollback`, `cleanup`, `withInstallLock`, `recover` (Tasks 14–16); `makeEngineFixture` (Task 14)
- Produces (tests): `crash-child.ts <config.json>` — config `{ home, base, signers, op: "install" | "rollback" | "cleanup", target?, crashAt? }`; prints the operation's JSON result as its last stdout line

- [ ] **Step 1: Write the crash child**

```ts
// test/install/helpers/crash-child.ts
// Runs one engine operation in its own process and SIGKILLs itself at config.crashAt (spec §13 layer 4).
import { readFileSync } from "node:fs";
import { cleanup } from "../../../src/install/cleanup";
import { withInstallLock, type EngineDeps } from "../../../src/install/engine";
import { installTarget } from "../../../src/install/installer";
import { resolveLayout } from "../../../src/install/layout";
import { detectPlatform } from "../../../src/install/platform";
import { rollback } from "../../../src/install/rollback";
import { parseAllowedSigners } from "../../../src/install/sshsig";
import { githubReleaseUrls } from "../../../src/install/urls";
import { defaultHealthCheck } from "../../../src/install/verify";
import { TEST_REPO } from "./release-server";

const cfg = JSON.parse(readFileSync(process.argv[2]!, "utf8")) as {
  home: string;
  base: string;
  signers: string;
  op: "install" | "rollback" | "cleanup";
  target?: string;
  crashAt?: string;
};

const deps: EngineDeps = {
  layout: resolveLayout({ HOME: cfg.home }),
  platform: detectPlatform(),
  trusted: parseAllowedSigners(cfg.signers),
  urls: githubReleaseUrls({ base: cfg.base, repo: TEST_REPO, channelsRepo: TEST_REPO }),
  allowLoopbackHttp: true,
  health: (bin, v) => defaultHealthCheck(bin, v),
  selfVersion: "test",
  sleep: (ms) => Bun.sleep(Math.min(ms, 5)),
  lockTimeoutMs: 20_000,
  crash: (point) => {
    if (point === cfg.crashAt) process.kill(process.pid, "SIGKILL");
  },
};

let result: unknown;
if (cfg.op === "install") result = (await installTarget(deps, cfg.target!, false)).value;
else if (cfg.op === "rollback") result = (await rollback(deps)).value;
else result = (await withInstallLock(deps, { wait: true }, (s) => cleanup(s)))!.value;
console.log(JSON.stringify(result));
```

- [ ] **Step 2: Write the crash suite**

```ts
// test/install/crash.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cleanup } from "../../src/install/cleanup";
import { withInstallLock } from "../../src/install/engine";
import { installTarget } from "../../src/install/installer";
import { readLink } from "../../src/install/link";
import { readState } from "../../src/install/state";
import { checkHealthy } from "../../src/install/verify";
import { verifyContext } from "../../src/install/engine";
import { makeEngineFixture, type EngineFixture } from "./helpers/engine";

let f: EngineFixture;
afterEach(() => f?.close());

async function runChild(op: "install" | "rollback" | "cleanup", crashAt: string, target?: string) {
  const config = join(f.root, `child-${crashAt}.json`);
  await writeFile(config, JSON.stringify({ home: f.home, base: f.srv.base, signers: f.key.signersLine, op, target, crashAt }));
  const child = Bun.spawn(["bun", join(import.meta.dir, "helpers/crash-child.ts"), config], { stdout: "pipe", stderr: "pipe" });
  await child.exited;
  return child;
}

/** The invariant of spec §10.6: our link is absent or points at a Healthy version; state agrees; nothing pending. */
async function assertConsistent(allowAbsent: boolean) {
  const report = await f.recoverNow();
  const link = await readLink(f.layout);
  const read = await readState(f.layout);
  const state = read.kind === "ok" ? read.state : null;
  if (link.kind === "missing") {
    expect(allowAbsent).toBe(true);
    expect(state?.current ?? null).toBeNull();
  } else {
    expect(link.kind).toBe("ours");
    const v = (link as { version: string }).version;
    expect(await checkHealthy(verifyContext(f.deps), v)).toEqual({ ok: true });
    expect(state?.current).toBe(v);
  }
  expect(state?.pending ?? null).toBeNull();
  await withInstallLock({ ...f.deps, now: () => new Date(Date.now() + 2 * 3_600_000) }, { wait: true }, (s) => cleanup(s));
  expect(await readdir(f.layout.staging)).toEqual([]);
  return { report, link, state };
}

const POINTS = ["after-download", "after-rename", "after-pending", "after-swap", "after-state"] as const;

describe("SIGKILL during an upgrade (R6.x)", () => {
  const expected: Record<(typeof POINTS)[number], string> = {
    "after-download": "1.0.0",
    "after-rename": "1.0.0",
    "after-pending": "1.0.0",
    "after-swap": "1.1.0",
    "after-state": "1.1.0",
  };
  for (const point of POINTS) {
    test(point, async () => {
      f = await makeEngineFixture();
      await f.release("1.0.0");
      await f.release("1.1.0");
      await installTarget(f.deps, "1.0.0", false);
      const child = await runChild("install", point, "1.1.0");
      expect(child.signalCode).toBe("SIGKILL");
      const { state } = await assertConsistent(false);
      expect(state!.current).toBe(expected[point]);
    });
  }
});

describe("SIGKILL during a first install (R6.1)", () => {
  for (const point of POINTS) {
    test(point, async () => {
      f = await makeEngineFixture();
      await f.release("1.1.0");
      const child = await runChild("install", point, "1.1.0");
      expect(child.signalCode).toBe("SIGKILL");
      const { link, report } = await assertConsistent(true);
      if (point === "after-pending") expect(report.fatal).toBe("installation did not complete; run install.sh again");
      if (point === "after-swap" || point === "after-state") expect(link).toEqual({ kind: "ours", version: "1.1.0" });
      else expect(link).toEqual({ kind: "missing" });
    });
  }
});

describe("SIGKILL during rollback and cleanup", () => {
  test.each(["after-pending", "after-swap", "after-state"])("rollback %s", async (point) => {
    f = await makeEngineFixture();
    await f.release("1.0.0");
    await f.release("1.1.0");
    await installTarget(f.deps, "1.0.0", false);
    await installTarget(f.deps, "1.1.0", false);
    expect((await runChild("rollback", point)).signalCode).toBe("SIGKILL");
    await assertConsistent(false);
  });

  test("mid-cleanup", async () => {
    f = await makeEngineFixture();
    await f.setup({ versions: ["0.7.0", "0.8.0", "0.9.0", "1.0.0"], current: "1.0.0", previous: "0.9.0", link: "1.0.0" });
    expect((await runChild("cleanup", "mid-cleanup")).signalCode).toBe("SIGKILL");
    await assertConsistent(false);
    expect(await readdir(f.layout.versions)).not.toContain("0.7.0");
  });

  test("a torn install.json is rebuilt", async () => {
    f = await makeEngineFixture();
    await f.release("1.0.0");
    await installTarget(f.deps, "1.0.0", false);
    await writeFile(f.layout.stateFile, '{"schema": 1, "gen');
    const { state } = await assertConsistent(false);
    expect(state!.current).toBe("1.0.0");
  });
});
```

- [ ] **Step 3: Write the property suite (R6.4)**

```ts
// test/install/property.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import { appendFile, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { verifyContext } from "../../src/install/engine";
import { manifestDir, versionPath } from "../../src/install/layout";
import { readLink } from "../../src/install/link";
import { emptyState, writeState } from "../../src/install/state";
import { checkHealthy } from "../../src/install/verify";
import { makeEngineFixture, type EngineFixture } from "./helpers/engine";

let f: EngineFixture;
afterEach(() => f?.close());

/** mulberry32: small deterministic PRNG so every failure is reproducible from its seed. */
function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const VERSIONS = ["1.0.0", "1.1.0", "1.2.0"];

describe("recovery never activates an unverified binary (R6.4)", () => {
  for (let seed = 1; seed <= 40; seed++) {
    test(`seed ${seed}`, async () => {
      const random = rng(seed);
      const pick = <T,>(xs: readonly T[]) => xs[Math.floor(random() * xs.length)]!;
      f = await makeEngineFixture();
      await f.setup({ versions: VERSIONS, current: "1.2.0", previous: "1.1.0", link: "1.2.0" });
      const mutations = [
        async (v: string) => truncate(versionPath(f.layout, v), 10),
        async (v: string) => appendFile(versionPath(f.layout, v), "x"),
        async (v: string) => rm(versionPath(f.layout, v), { force: true }),
        async (v: string) => {
          await rm(versionPath(f.layout, v), { force: true });
          await symlink("/bin/sh", versionPath(f.layout, v));
        },
        async (v: string) => appendFile(join(manifestDir(f.layout, v), "manifest.json"), " "),
        async (v: string) => rm(join(manifestDir(f.layout, v), "manifest.json.sig"), { force: true }),
        async () => rm(f.layout.binLink, { force: true }),
        async () => {
          await rm(f.layout.binLink, { force: true });
          await symlink(versionPath(f.layout, pick([...VERSIONS, "9.9.9"])), f.layout.binLink);
        },
        async () => rm(f.layout.stateFile, { force: true }),
        async () => writeFile(f.layout.stateFile, "garbage"),
        async () => writeState(f.layout, { ...emptyState(), current: pick([...VERSIONS, "9.9.9"]), previous: pick(VERSIONS) }),
        async () => writeState(f.layout, { ...emptyState(), current: "1.2.0", pending: { op: "switch", from: pick([null, ...VERSIONS]), to: pick(VERSIONS) } }),
      ];
      const count = 1 + Math.floor(random() * 4);
      for (let i = 0; i < count; i++) await pick(mutations)(pick(VERSIONS));
      await f.recoverNow();
      const link = await readLink(f.layout);
      expect(link.kind === "missing" || link.kind === "ours").toBe(true);
      if (link.kind === "ours") expect(await checkHealthy(verifyContext(f.deps), link.version)).toEqual({ ok: true });
    });
  }
});
```

- [ ] **Step 4: Write the concurrency suite**

```ts
// test/install/concurrency.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { installTarget } from "../../src/install/installer";
import { readLink } from "../../src/install/link";
import { makeEngineFixture, type EngineFixture } from "./helpers/engine";

let f: EngineFixture;
afterEach(() => f?.close());

async function child(op: "install" | "cleanup", target?: string): Promise<{ code: number; result: unknown }> {
  const config = join(f.root, `c-${Math.random().toString(36).slice(2)}.json`);
  await writeFile(config, JSON.stringify({ home: f.home, base: f.srv.base, signers: f.key.signersLine, op, target }));
  const proc = Bun.spawn(["bun", join(import.meta.dir, "helpers/crash-child.ts"), config], { stdout: "pipe", stderr: "pipe" });
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return { code, result: JSON.parse(out.trim().split("\n").at(-1)!) };
}

describe("concurrency (spec §13 layer 3)", () => {
  test("two installs at once: one installs, the other waits and finds nothing to do", async () => {
    f = await makeEngineFixture();
    await f.release("1.0.0");
    const [a, b] = await Promise.all([child("install", "1.0.0"), child("install", "1.0.0")]);
    expect([a.code, b.code]).toEqual([0, 0]);
    const changed = [a, b].map((r) => (r.result as { changed: boolean }).changed);
    expect(changed.filter(Boolean).length).toBe(1);
    expect(await readLink(f.layout)).toEqual({ kind: "ours", version: "1.0.0" });
  });

  test("cleanup keeps a version another process is running, and removes it once that process exits (R5.4)", async () => {
    f = await makeEngineFixture();
    for (const v of ["0.7.0", "0.8.0", "0.9.0", "1.0.0"]) await f.release(v);
    for (const v of ["0.7.0", "0.8.0", "0.9.0"]) await installTarget(f.deps, v, false);
    const holder = Bun.spawn(["bun", join(import.meta.dir, "helpers/hold-lock.ts"), join(f.layout.locks, "0.7.0.lock"), "sh"], { stdout: "pipe" });
    await holder.stdout.getReader().read();
    await installTarget(f.deps, "1.0.0", false); // its cleanup must keep the held 0.7.0
    expect(await readdir(f.layout.versions)).toContain("0.7.0");
    expect((await child("cleanup")).result).toEqual([]);
    holder.kill("SIGKILL");
    await holder.exited;
    expect((await child("cleanup")).result).toEqual(["0.7.0"]);
  });
});
```

- [ ] **Step 5: Run the suites**

Run: `bun test test/install/crash.test.ts test/install/property.test.ts test/install/concurrency.test.ts`
Expected: PASS. A failing seed in the property suite is a real recovery bug: reproduce it with `bun test test/install/property.test.ts -t "seed <n>"`, fix `recovery.ts`, and add a named regression test for that case to `test/install/recovery.test.ts`.

- [ ] **Step 6: Run the milestone gate**

Run: `bun run typecheck && bun test && bun run test:coverage`
Expected: PASS; every `src/install/*.ts` ≥ 80 % lines.

- [ ] **Step 7: Commit**

```bash
git add test/install/helpers/crash-child.ts test/install/crash.test.ts test/install/property.test.ts test/install/concurrency.test.ts
git commit -m "test(install): SIGKILL crash points, randomized recovery and multi-process locking

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## M4 — CLI integration

### Task 18: Exact-shape subcommand recognition

Spec: §12.2 with amendment A2, §12.1, R1.4 (usage side), §13 layer 6. `parseCli` itself is **not** changed, so Task 1's snapshot keeps passing untouched.

**Files:**
- Modify: `src/cli/args.ts` (append `matchSubcommand`, `parseInvocation`, types)
- Modify: `src/cli/usage.ts` (Commands block, per-command help)
- Create: `src/cli/args.invocation.test.ts`

**Interfaces:**
- Consumes: `CLI_CASES`, `parseOutcome` (Task 1); `isVersion` (Task 3)
- Produces: `type InstallCommand = { kind: "install"; target?: string; force: boolean } | { kind: "install-self"; manifest: string; signature: string } | { kind: "update"; background: boolean; alias: "update" | "upgrade" } | { kind: "rollback" } | { kind: "help"; command: "install" | "update" | "upgrade" | "rollback" }`, `type Invocation = { kind: "subcommand"; command: InstallCommand } | { kind: "session"; options: CliOptions }`, `matchSubcommand(argv): InstallCommand | null`, `parseInvocation(argv): Invocation` (throws `CliError`)
- Produces: `INSTALL_HELP`, `UPDATE_HELP`, `ROLLBACK_HELP` in `usage.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// src/cli/args.invocation.test.ts
import { describe, expect, test } from "bun:test";
import { CLI_CASES, parseOutcome } from "../../test/helpers/cli-cases";
import { CliError, matchSubcommand, parseCli, parseInvocation } from "./args";

describe("parseInvocation keeps every existing invocation (spec §12.2)", () => {
  for (const c of CLI_CASES) {
    const becomes = c.note.includes("(becomes a subcommand)");
    test(`${JSON.stringify(c.argv)} — ${becomes ? "subcommand" : "unchanged"}`, () => {
      expect(matchSubcommand(c.argv) !== null && c.argv[0] !== "--").toBe(becomes);
      if (becomes) return;
      const before = parseOutcome(c.argv);
      if (before.ok) {
        expect(parseInvocation(c.argv)).toEqual({ kind: "session", options: before.options });
      } else {
        const e = (() => {
          try {
            parseInvocation(c.argv);
          } catch (x) {
            return x as CliError;
          }
          throw new Error("expected a CliError");
        })();
        expect(e).toBeInstanceOf(CliError);
        expect(e.message.startsWith(before.error)).toBe(true);
      }
    });
  }
});

describe("subcommand shapes", () => {
  test.each([
    [["install"], { kind: "install", target: undefined, force: false }],
    [["install", "stable"], { kind: "install", target: "stable", force: false }],
    [["install", "latest", "--force"], { kind: "install", target: "latest", force: true }],
    [["install", "--force", "1.2.3"], { kind: "install", target: "1.2.3", force: true }],
    [["install", "--self", "--manifest", "/t/m.json", "--signature", "/t/m.sig"], { kind: "install-self", manifest: "/t/m.json", signature: "/t/m.sig" }],
    [["update"], { kind: "update", background: false, alias: "update" }],
    [["upgrade"], { kind: "update", background: false, alias: "upgrade" }],
    [["update", "--background"], { kind: "update", background: true, alias: "update" }],
    [["rollback"], { kind: "rollback" }],
    [["install", "-h"], { kind: "help", command: "install" }],
    [["upgrade", "--help"], { kind: "help", command: "upgrade" }],
  ])("%j", (argv, expected) => {
    expect(parseInvocation(argv as string[])).toEqual({ kind: "subcommand", command: expected as never });
  });

  test.each([
    [["install", "foo"]],
    [["install", "1.2"]],
    [["install", "1.2.3", "4.5.6"]],
    [["install", "--force", "--force"]],
    [["install", "--self"]],
    [["install", "--self", "--manifest", "", "--signature", "s"]],
    [["rollback", "now"]],
    [["update", "the", "readme"]],
    [["update", "-p"]],
    [["--", "install"]],
    [["--", "update"]],
  ])("%j is not a subcommand", (argv) => {
    expect(parseInvocation(argv).kind).toBe("session");
  });

  test("-- keeps argv unchanged for the existing parser (amendment A2)", () => {
    expect(parseInvocation(["--", "-p"])).toEqual({ kind: "session", options: parseCli(["--", "-p"]) });
  });

  test("a subcommand word with an unknown flag gets the existing error plus a hint", () => {
    expect(() => parseInvocation(["install", "--force", "--bogus"])).toThrow("For install, see tropos install --help.");
    expect(() => parseInvocation(["update", "--background", "-p"])).toThrow("For update, see tropos update --help.");
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `bun test src/cli/args.invocation.test.ts`
Expected: FAIL — `matchSubcommand` / `parseInvocation` are not exported.

- [ ] **Step 3: Append to `src/cli/args.ts`**

Add `import { isVersion } from "../install/version";` to the imports, then append:

```ts
export type InstallCommand =
  | { kind: "install"; target?: string; force: boolean }
  | { kind: "install-self"; manifest: string; signature: string }
  | { kind: "update"; background: boolean; alias: "update" | "upgrade" }
  | { kind: "rollback" }
  | { kind: "help"; command: "install" | "update" | "upgrade" | "rollback" };

export type Invocation = { kind: "subcommand"; command: InstallCommand } | { kind: "session"; options: CliOptions };

const SUBCOMMAND_WORDS = new Set(["install", "update", "upgrade", "rollback"]);

/** Spec §12.2: a subcommand only when the whole argv has one of these exact shapes. */
export function matchSubcommand(argv: string[]): InstallCommand | null {
  const [word, ...rest] = argv;
  if (!word || !SUBCOMMAND_WORDS.has(word)) return null;
  const command = word as "install" | "update" | "upgrade" | "rollback";
  if (rest.length === 1 && (rest[0] === "-h" || rest[0] === "--help")) return { kind: "help", command };
  if (command === "rollback") return rest.length === 0 ? { kind: "rollback" } : null;
  if (command === "update" || command === "upgrade") {
    if (rest.length === 0) return { kind: "update", background: false, alias: command };
    if (rest.length === 1 && rest[0] === "--background") return { kind: "update", background: true, alias: command };
    return null;
  }
  if (rest.length === 5 && rest[0] === "--self" && rest[1] === "--manifest" && rest[3] === "--signature" && rest[2] && rest[4]) {
    return { kind: "install-self", manifest: rest[2], signature: rest[4] };
  }
  let target: string | undefined;
  let force = false;
  for (const arg of rest) {
    if (arg === "--force" && !force) force = true;
    else if (target === undefined && (arg === "stable" || arg === "latest" || isVersion(arg))) target = arg;
    else return null;
  }
  return { kind: "install", target, force };
}

/** Subcommands first (unless argv starts with "--", amendment A2), otherwise exactly the old parser. */
export function parseInvocation(argv: string[]): Invocation {
  if (argv[0] !== "--") {
    const command = matchSubcommand(argv);
    if (command) return { kind: "subcommand", command };
  }
  try {
    return { kind: "session", options: parseCli(argv) };
  } catch (e) {
    const word = argv[0];
    if (e instanceof CliError && word && SUBCOMMAND_WORDS.has(word)) throw new CliError(`${e.message}\nFor ${word}, see tropos ${word} --help.`);
    throw e;
  }
}
```

- [ ] **Step 4: Add the help texts to `src/cli/usage.ts`**

Insert this block into `USAGE` directly after the two `tropos …` lines under `Usage:` (keep everything else as it is):

```text

Commands:
  tropos install [stable|latest|<version>] [--force]
                                   install a release and make it the active tropos
  tropos update                    update to the newest release of your channel (also: upgrade)
  tropos rollback                  return to the previous version
  tropos -- <prompt>               everything after -- is the prompt (e.g. tropos -- update)
```

Append:

```ts
export const INSTALL_HELP = `Usage: tropos install [stable|latest|<version>] [--force]

Installs a Tropos Code release and makes it the active tropos. Without a target, installs latest.
This is a one-time install: background updates keep following "autoUpdatesChannel" in
~/.tropos/settings.json.

Options:
      --force    re-verify and re-activate even if the version is already installed, and replace
                 a ~/.local/bin/tropos that Tropos did not create
  -h, --help     show this help
`;

export const UPDATE_HELP = `Usage: tropos update   (or: tropos upgrade)

Updates to the newest release of your update channel ("autoUpdatesChannel": "latest" or "stable"
in ~/.tropos/settings.json). Never installs an older version.

Options:
  -h, --help     show this help
`;

export const ROLLBACK_HELP = `Usage: tropos rollback

Returns to the previous installed version after verifying it. Background updates then skip the
version you rolled back from until a newer release appears.

Options:
  -h, --help     show this help
`;
```

- [ ] **Step 5: Run to see it pass, and prove the snapshot is untouched**

Run: `bun test src/cli && git diff --exit-code src/cli/__snapshots__ && bun run typecheck`
Expected: PASS; no snapshot diff.

- [ ] **Step 6: Commit**

```bash
git add src/cli/args.ts src/cli/usage.ts src/cli/args.invocation.test.ts
git commit -m "feat(cli): exact-shape install/update/upgrade/rollback subcommands

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 19: Update settings and background auto-update

Spec: §11 (all bullets), amendments A8, Review Focus 4, §13 layer 10, R9.3.

**Files:**
- Modify: `src/config/settings.ts`
- Create: `src/config/settings.autoupdate.test.ts`
- Create: `src/install/autoupdate.ts`, `src/install/autoupdate.test.ts`
- Create: `test/install/autoupdate.test.ts`

**Interfaces:**
- Consumes: `updateChannel` (Task 16); `EngineDeps` (Task 14); `minimalEnv` (Task 10); `acquireInstallLock` (Task 11); `readState`, `writeState`, `InstallState` (Task 12); `Channel` (Task 9)
- Produces (settings): `Settings.autoUpdates: boolean` (default `true`), `Settings.autoUpdatesChannel: "latest" | "stable"` (default `"latest"`); repo layers drop both with the standard warning
- Produces: `CHECK_INTERVAL_MS`, `MAX_INTERVAL_MS`, `interface AutoUpdateInputs { env: NodeJS.ProcessEnv; native: boolean; print: boolean; stdinTTY: boolean; stdoutTTY: boolean; autoUpdates: boolean; state: InstallState | null; now: Date }`, `type CheckDecision = { check: true } | { check: false; reason: string }`, `shouldCheck(i): CheckDecision`, `nextCheckAfter(now, failures): Date`, `announcement(state): string | null`, `spawnBackgroundUpdate(execPath, layout, env, spawn?): boolean`, `runBackgroundUpdate(deps, channel): Promise<void>`, `markAnnounced(deps): Promise<void>`

- [ ] **Step 1: Write the failing settings test**

```ts
// src/config/settings.autoupdate.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import { DEFAULT_SETTINGS, loadSettings, settingsPaths } from "./settings";

let dir: string;
beforeEach(async () => {
  dir = await makeTmpDir();
});
afterEach(() => removeDir(dir));

describe("update settings (spec §11)", () => {
  test("defaults", () => {
    expect(DEFAULT_SETTINGS.autoUpdates).toBe(true);
    expect(DEFAULT_SETTINGS.autoUpdatesChannel).toBe("latest");
  });

  test("the user layer sets them", async () => {
    const paths = settingsPaths(join(dir, "proj"), join(dir, "home"));
    await mkdir(join(dir, "home"), { recursive: true });
    await writeFile(paths.user, JSON.stringify({ autoUpdates: false, autoUpdatesChannel: "stable" }));
    const { settings } = await loadSettings(paths);
    expect(settings.autoUpdates).toBe(false);
    expect(settings.autoUpdatesChannel).toBe("stable");
  });

  test("a repo cannot set them (it could pin users to an old version)", async () => {
    const paths = settingsPaths(join(dir, "proj"), join(dir, "home"));
    await mkdir(join(dir, "proj", ".tropos"), { recursive: true });
    await writeFile(paths.project, JSON.stringify({ autoUpdates: false, autoUpdatesChannel: "stable" }));
    const { settings, warnings } = await loadSettings(paths);
    expect(settings.autoUpdates).toBe(true);
    expect(settings.autoUpdatesChannel).toBe("latest");
    expect(warnings.join("\n")).toContain("ignored autoUpdates, autoUpdatesChannel");
  });

  test("bad values are a settings error", async () => {
    const paths = settingsPaths(join(dir, "proj"), join(dir, "home"));
    await mkdir(join(dir, "home"), { recursive: true });
    await writeFile(paths.user, JSON.stringify({ autoUpdatesChannel: "nightly" }));
    await expect(loadSettings(paths)).rejects.toThrow("autoUpdatesChannel");
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `bun test src/config/settings.autoupdate.test.ts`
Expected: FAIL — `autoUpdates` is undefined.

- [ ] **Step 3: Extend `src/config/settings.ts`**

1. In `interface Settings` add after `providers`:

```ts
  /** Background updates (spec §11). Only the user's own layers may set these. */
  autoUpdates: boolean;
  autoUpdatesChannel: "latest" | "stable";
```

2. In `DEFAULT_SETTINGS` add `autoUpdates: true, autoUpdatesChannel: "latest",`.
3. In `layerSchema` add `autoUpdates: z.boolean().optional(), autoUpdatesChannel: z.enum(["latest", "stable"]).optional(),`.
4. In `mergeSettings` add `autoUpdates: layer.autoUpdates ?? base.autoUpdates, autoUpdatesChannel: layer.autoUpdatesChannel ?? base.autoUpdatesChannel,`.
5. In `restrictRepoLayer`, before `const model = …`, add:

```ts
  // A repo that turns updates off or picks the channel could keep its users on an old version.
  if (layer.autoUpdates !== undefined) ignored.push("autoUpdates");
  if (layer.autoUpdatesChannel !== undefined) ignored.push("autoUpdatesChannel");
```

(`restricted` already lists only the keys a repo may set, so both are dropped.)

- [ ] **Step 4: Run the settings tests**

Run: `bun test src/config`
Expected: the new file PASSES. If an existing test compares a whole `Settings` object literal, add `autoUpdates: true, autoUpdatesChannel: "latest"` to its expected object — no other change.

- [ ] **Step 5: Write the failing auto-update tests**

```ts
// src/install/autoupdate.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import { CHECK_INTERVAL_MS, announcement, nextCheckAfter, shouldCheck, spawnBackgroundUpdate, type AutoUpdateInputs } from "./autoupdate";
import { ensureLayout, resolveLayout } from "./layout";
import { emptyState } from "./state";

const now = new Date("2026-10-13T12:00:00Z");
const base: AutoUpdateInputs = { env: {}, native: true, print: false, stdinTTY: true, stdoutTTY: true, autoUpdates: true, state: null, now };
const withNext = (iso: string | null) => ({ ...emptyState(), autoUpdate: { ...emptyState().autoUpdate, nextCheck: iso } });

describe("shouldCheck (spec §11)", () => {
  test("due on a native interactive session", () => {
    expect(shouldCheck(base)).toEqual({ check: true });
  });

  test.each([
    [{ native: false }, "not-native"],
    [{ print: true }, "print-mode"],
    [{ stdinTTY: false }, "not-a-terminal"],
    [{ stdoutTTY: false }, "not-a-terminal"],
    [{ env: { CI: "true" } }, "ci"],
    [{ env: { TROPOS_DISABLE_AUTOUPDATER: "1" } }, "disabled-by-env"],
    [{ autoUpdates: false }, "disabled-by-setting"],
    [{ state: withNext("2026-10-13T13:00:00.000Z") }, "not-due"],
  ])("%j → %s", (patch, reason) => {
    expect(shouldCheck({ ...base, ...(patch as Partial<AutoUpdateInputs>) })).toEqual({ check: false, reason });
  });

  test("CI=false does not disable", () => {
    expect(shouldCheck({ ...base, env: { CI: "false" } })).toEqual({ check: true });
  });

  test("treats a nextCheck more than 48 h ahead as due (clock moved back, Review Focus 4)", () => {
    expect(shouldCheck({ ...base, state: withNext("2026-10-20T12:00:00.000Z") })).toEqual({ check: true });
  });
});

describe("throttle and backoff", () => {
  test("6 h, then 12 h, 24 h, capped at 48 h", () => {
    const h = (n: number) => new Date(now.getTime() + n * 3_600_000);
    expect(nextCheckAfter(now, 0)).toEqual(h(6));
    expect(nextCheckAfter(now, 1)).toEqual(h(12));
    expect(nextCheckAfter(now, 2)).toEqual(h(24));
    expect(nextCheckAfter(now, 3)).toEqual(h(48));
    expect(nextCheckAfter(now, 9)).toEqual(h(48));
    expect(CHECK_INTERVAL_MS).toBe(6 * 3_600_000);
  });
});

describe("announcement", () => {
  test("once after an update", () => {
    const s = { ...emptyState(), autoUpdate: { ...emptyState().autoUpdate, lastUpdated: "1.2.0", announced: false } };
    expect(announcement(s)).toBe("Updated to 1.2.0");
    expect(announcement({ ...s, autoUpdate: { ...s.autoUpdate, announced: true } })).toBeNull();
  });
});

describe("spawnBackgroundUpdate", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await makeTmpDir();
  });
  afterEach(() => removeDir(dir));

  test("returns at once and gives the child only the allow-listed environment (credential isolation)", async () => {
    const l = resolveLayout({ HOME: dir });
    await ensureLayout(l);
    const fake = join(dir, "fake-tropos");
    await writeFile(fake, `#!/bin/sh\nsleep 1\necho "$@" > "${dir}/args"\nenv > "${dir}/env"\n`);
    await chmod(fake, 0o755);
    const t0 = Date.now();
    expect(spawnBackgroundUpdate(fake, l, { ...process.env, HOME: dir, ANTHROPIC_API_KEY: "secret", GITHUB_TOKEN: "secret", OPENAI_API_KEY: "secret" })).toBe(true);
    expect(Date.now() - t0).toBeLessThan(500);
    for (let i = 0; i < 50 && !(await Bun.file(join(dir, "env")).exists()); i++) await Bun.sleep(100);
    expect((await readFile(join(dir, "args"), "utf8")).trim()).toBe("update --background");
    const env = await readFile(join(dir, "env"), "utf8");
    expect(env).toContain(`HOME=${dir}`);
    expect(env).not.toContain("ANTHROPIC_API_KEY");
    expect(env).not.toContain("GITHUB_TOKEN");
    expect(env).not.toContain("OPENAI_API_KEY");
  });
});
```

```ts
// test/install/autoupdate.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import { runBackgroundUpdate } from "../../src/install/autoupdate";
import { installTarget } from "../../src/install/installer";
import { readLink } from "../../src/install/link";
import { acquireInstallLock } from "../../src/install/locks";
import { writeState } from "../../src/install/state";
import { makeEngineFixture, type EngineFixture } from "./helpers/engine";

let f: EngineFixture;
afterEach(() => f?.close());
const now = new Date("2026-10-13T12:00:00Z");

describe("runBackgroundUpdate (spec §11, layer 10)", () => {
  test("installs a newer version and records it for the announcement", async () => {
    f = await makeEngineFixture({ now: () => now });
    await f.release("1.0.0");
    await f.release("1.1.0");
    await installTarget(f.deps, "1.0.0", false);
    f.srv.put("channels", "latest", "1.1.0\n");
    await runBackgroundUpdate(f.deps, "latest");
    expect(await readLink(f.layout)).toEqual({ kind: "ours", version: "1.1.0" });
    expect((await f.state()).autoUpdate).toEqual({ lastCheck: now.toISOString(), failures: 0, nextCheck: "2026-10-13T18:00:00.000Z", lastUpdated: "1.1.0", announced: false });
  });

  test("a network failure only backs off", async () => {
    f = await makeEngineFixture({ now: () => now });
    await f.release("1.0.0");
    await installTarget(f.deps, "1.0.0", false);
    await runBackgroundUpdate({ ...f.deps, fetch: async () => { throw new Error("offline"); } }, "latest");
    expect((await f.state()).current).toBe("1.0.0");
    expect((await f.state()).autoUpdate).toMatchObject({ failures: 1, nextCheck: "2026-10-14T00:00:00.000Z" });
  });

  test("never downgrades and never installs a skipped version", async () => {
    f = await makeEngineFixture({ now: () => now });
    for (const v of ["0.9.0", "1.0.0", "1.1.0"]) await f.release(v);
    await installTarget(f.deps, "1.0.0", false);
    f.srv.put("channels", "stable", "0.9.0\n");
    await runBackgroundUpdate(f.deps, "stable");
    expect((await f.state()).current).toBe("1.0.0");
    await writeState(f.layout, { ...(await f.state()), skip: { "1.1.0": "rolled-back" } });
    f.srv.put("channels", "latest", "1.1.0\n");
    await runBackgroundUpdate(f.deps, "latest");
    expect((await f.state()).current).toBe("1.0.0");
  });

  test("channel above current: stays (R9.3)", async () => {
    f = await makeEngineFixture({ now: () => now });
    for (const v of ["1.0.0", "1.1.0"]) await f.release(v);
    await installTarget(f.deps, "1.1.0", false);
    f.srv.put("channels", "stable", "1.0.0\n");
    await runBackgroundUpdate(f.deps, "stable");
    expect((await f.state()).current).toBe("1.1.0");
  });

  test("does not wait for a busy install lock and changes nothing", async () => {
    f = await makeEngineFixture({ now: () => now });
    await f.release("1.0.0");
    await installTarget(f.deps, "1.0.0", false);
    const before = await f.state();
    const held = (await acquireInstallLock(f.layout, { wait: false, version: "x" }))!;
    await runBackgroundUpdate(f.deps, "latest");
    held.release();
    expect(await f.state()).toEqual(before);
  });
});
```

- [ ] **Step 6: Run to see them fail**

Run: `bun test src/install/autoupdate.test.ts test/install/autoupdate.test.ts`
Expected: FAIL — `./autoupdate` not found.

- [ ] **Step 7: Implement `autoupdate.ts`**

```ts
// src/install/autoupdate.ts
import { closeSync, openSync, renameSync, statSync } from "node:fs";
import type { Channel } from "./channels";
import type { EngineDeps } from "./engine";
import { minimalEnv } from "./env";
import { updateChannel } from "./installer";
import type { Layout } from "./layout";
import { acquireInstallLock } from "./locks";
import { readState, writeState, type InstallState } from "./state";

export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const MAX_INTERVAL_MS = 48 * 60 * 60 * 1000;
const MAX_LOG_BYTES = 1024 * 1024;

export interface AutoUpdateInputs {
  env: NodeJS.ProcessEnv;
  native: boolean;
  print: boolean;
  stdinTTY: boolean;
  stdoutTTY: boolean;
  autoUpdates: boolean;
  state: InstallState | null;
  now: Date;
}

export type CheckDecision = { check: true } | { check: false; reason: string };

const truthy = (v: string | undefined) => v !== undefined && v !== "" && v !== "0" && v.toLowerCase() !== "false";

/** Spec §11 "When". A nextCheck more than 48 h ahead means the clock moved back; it counts as due. */
export function shouldCheck(i: AutoUpdateInputs): CheckDecision {
  if (!i.native) return { check: false, reason: "not-native" };
  if (i.print) return { check: false, reason: "print-mode" };
  if (!i.stdinTTY || !i.stdoutTTY) return { check: false, reason: "not-a-terminal" };
  if (truthy(i.env.CI)) return { check: false, reason: "ci" };
  if (truthy(i.env.TROPOS_DISABLE_AUTOUPDATER)) return { check: false, reason: "disabled-by-env" };
  if (!i.autoUpdates) return { check: false, reason: "disabled-by-setting" };
  const next = i.state?.autoUpdate.nextCheck ? Date.parse(i.state.autoUpdate.nextCheck) : 0;
  const ahead = next - i.now.getTime();
  if (ahead > 0 && ahead <= MAX_INTERVAL_MS) return { check: false, reason: "not-due" };
  return { check: true };
}

export function nextCheckAfter(now: Date, failures: number): Date {
  return new Date(now.getTime() + Math.min(CHECK_INTERVAL_MS * 2 ** failures, MAX_INTERVAL_MS));
}

export function announcement(state: InstallState): string | null {
  const a = state.autoUpdate;
  return a.lastUpdated && !a.announced ? `Updated to ${a.lastUpdated}` : null;
}

/** Detached `tropos update --background` with the minimal environment; output appended to update.log. */
export function spawnBackgroundUpdate(execPath: string, layout: Layout, env: NodeJS.ProcessEnv, spawn: typeof Bun.spawn = Bun.spawn): boolean {
  try {
    try {
      if (statSync(layout.log).size > MAX_LOG_BYTES) renameSync(layout.log, `${layout.log}.1`);
    } catch {
      // no log yet
    }
    const fd = openSync(layout.log, "a", 0o600);
    try {
      const proc = spawn([execPath, "update", "--background"], { env: minimalEnv(env), stdin: "ignore", stdout: fd, stderr: fd, detached: true } as Parameters<typeof Bun.spawn>[1]);
      proc.unref();
    } finally {
      closeSync(fd);
    }
    return true;
  } catch {
    return false;
  }
}

async function recordCheck(deps: EngineDeps, now: Date, ok: boolean, updatedTo: string | null): Promise<void> {
  const lock = await acquireInstallLock(deps.layout, { wait: false, version: deps.selfVersion, flock: deps.flock });
  if (!lock) return;
  try {
    const read = await readState(deps.layout);
    if (read.kind !== "ok") return;
    const prev = read.state.autoUpdate;
    const failures = ok ? 0 : Math.min(prev.failures + 1, 8);
    await writeState(deps.layout, {
      ...read.state,
      autoUpdate: {
        lastCheck: now.toISOString(),
        failures,
        nextCheck: nextCheckAfter(now, failures).toISOString(),
        lastUpdated: updatedTo ?? prev.lastUpdated,
        announced: updatedTo ? false : prev.announced,
      },
    });
  } finally {
    lock.release();
  }
}

/** `tropos update --background`: never waits for the lock, only moves forward, records the check (spec §11). */
export async function runBackgroundUpdate(deps: EngineDeps, channel: Channel): Promise<void> {
  const now = deps.now?.() ?? new Date();
  let ok = true;
  let updatedTo: string | null = null;
  try {
    const run = await updateChannel(deps, channel, { wait: false });
    if (!run) {
      deps.log?.("another Tropos install is running; skipping this check");
      return;
    }
    if (run.recovery.fatal) deps.log?.(run.recovery.fatal);
    if (run.value.kind === "updated" && run.value.outcome.changed) updatedTo = run.value.outcome.version;
    deps.log?.(`background check: ${run.value.kind}`);
  } catch (e) {
    ok = false;
    deps.log?.(`background update failed: ${(e as Error).message}`);
  }
  await recordCheck(deps, now, ok, updatedTo);
}

export async function markAnnounced(deps: Pick<EngineDeps, "layout" | "selfVersion" | "flock">): Promise<void> {
  const lock = await acquireInstallLock(deps.layout, { wait: false, version: deps.selfVersion, flock: deps.flock });
  if (!lock) return;
  try {
    const read = await readState(deps.layout);
    if (read.kind === "ok" && !read.state.autoUpdate.announced) {
      await writeState(deps.layout, { ...read.state, autoUpdate: { ...read.state.autoUpdate, announced: true } });
    }
  } finally {
    lock.release();
  }
}
```

- [ ] **Step 8: Run to see them pass**

Run: `bun test src/install/autoupdate.test.ts test/install/autoupdate.test.ts src/config && bun run typecheck`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/config/settings.ts src/config/settings.autoupdate.test.ts src/install/autoupdate.ts src/install/autoupdate.test.ts test/install/autoupdate.test.ts
git commit -m "feat(install): trusted-only update settings and throttled background updates

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

If Step 4 required edits to existing settings tests, add those files to this commit too.

### Task 20: Command handlers and CLI dispatch

Spec: §12.1, §11 one-time-install notices, §10.8 messages and exit codes, R1.4, R9.1–R9.2.

**Files:**
- Create: `src/install/commands.ts`, `src/install/commands.test.ts`
- Modify: `src/cli/main.tsx` (dispatch subcommands; `MainDeps` gains `execPath` and `engine`)
- Create: `src/cli/main.install.test.ts`

**Interfaces:**
- Consumes: `InstallCommand`, `parseInvocation` (Task 18); `installTarget`, `installSelf`, `updateChannel` (Task 16); `rollback` (Task 16); `runBackgroundUpdate` (Task 19); `resolveLayout`, `nativeVersionOf` (Task 10); `exitCodeFor`, `InstallError` (Task 3); `TRUSTED_KEYS` (Task 5); `RELEASE_URLS` (Task 9); `detectPlatform` (Task 4); `defaultHealthCheck` (Task 13); help texts (Task 18)
- Produces: `interface CommandContext { out: (s: string) => void; err: (s: string) => void; env: NodeJS.ProcessEnv; execPath: string; version: string; settings: { autoUpdates: boolean; autoUpdatesChannel: Channel }; engine?: (log: (line: string) => void) => EngineDeps }`, `productionEngineDeps(env, version, log): EngineDeps`, `oneTimeInstallNotice(target, settings): string | null`, `runInstallCommand(cmd, ctx): Promise<number>`; `MainDeps.execPath?: string`, `MainDeps.engine?: CommandContext["engine"]`

- [ ] **Step 1: Write the failing tests**

```ts
// src/install/commands.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import { writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { makeEngineFixture, type EngineFixture } from "../../test/install/helpers/engine";
import { runInstallCommand, oneTimeInstallNotice, type CommandContext } from "./commands";
import { versionPath } from "./layout";

let f: EngineFixture;
afterEach(() => f?.close());

function ctx(overrides: Partial<CommandContext> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const c: CommandContext = {
    out: (s) => void out.push(s),
    err: (s) => void err.push(s),
    env: { HOME: f.home },
    execPath: versionPath(f.layout, "1.0.0"),
    version: "1.0.0",
    settings: { autoUpdates: true, autoUpdatesChannel: "latest" },
    engine: (log) => ({ ...f.deps, log }),
    ...overrides,
  };
  return { c, out, err };
}

describe("oneTimeInstallNotice (spec §11)", () => {
  test.each([
    ["stable", { autoUpdates: true, autoUpdatesChannel: "latest" }, `Background updates follow the 'latest' channel and may move you to a newer version. To stay on 'stable', set "autoUpdatesChannel": "stable" in ~/.tropos/settings.json.`],
    ["1.2.3", { autoUpdates: true, autoUpdatesChannel: "latest" }, `Background updates follow the 'latest' channel and may move you to a newer version. To stay on 1.2.3, set "autoUpdates": false in ~/.tropos/settings.json.`],
    ["stable", { autoUpdates: true, autoUpdatesChannel: "stable" }, null],
    ["1.2.3", { autoUpdates: false, autoUpdatesChannel: "latest" }, null],
  ])("%s with %j", (target, settings, expected) => {
    expect(oneTimeInstallNotice(target, settings as CommandContext["settings"])).toBe(expected);
  });
});

describe("runInstallCommand", () => {
  test("help", async () => {
    f = await makeEngineFixture();
    const { c, out } = ctx();
    expect(await runInstallCommand({ kind: "help", command: "rollback" }, c)).toBe(0);
    expect(out.join("")).toStartWith("Usage: tropos rollback");
  });

  test("not a native install: exit 73 (R1.4)", async () => {
    f = await makeEngineFixture();
    const { c, err } = ctx({ execPath: "/usr/local/bin/bun" });
    for (const cmd of [{ kind: "update", background: false, alias: "update" }, { kind: "rollback" }, { kind: "install", force: false }] as const) {
      expect(await runInstallCommand(cmd, c)).toBe(73);
    }
    expect(err.join("")).toContain("not a native install; install with install.sh");
  });

  test("install-self runs from a temporary folder", async () => {
    f = await makeEngineFixture();
    const r = await f.release("1.0.0");
    const exe = join(f.root, "tropos-download");
    await writeFile(exe, r.binary);
    await chmod(exe, 0o700);
    await writeFile(join(f.root, "m.json"), r.verified.bytes);
    await writeFile(join(f.root, "m.sig"), r.verified.signature);
    const { c, out } = ctx({ execPath: exe });
    expect(await runInstallCommand({ kind: "install-self", manifest: join(f.root, "m.json"), signature: join(f.root, "m.sig") }, c)).toBe(0);
    expect(out.join("")).toContain("Installed Tropos Code 1.0.0.");
  });

  test("install, update, rollback messages and exit codes", async () => {
    f = await makeEngineFixture();
    await f.release("1.0.0");
    await f.release("1.1.0");
    await f.direct("1.0.0");
    const { c, out, err } = ctx();
    expect(await runInstallCommand({ kind: "install", target: "1.0.0", force: false }, c)).toBe(0);
    f.srv.put("channels", "latest", "1.1.0\n");
    expect(await runInstallCommand({ kind: "update", background: false, alias: "update" }, c)).toBe(0);
    expect(out.join("")).toContain("Updated Tropos Code from 1.0.0 to 1.1.0.");
    expect(await runInstallCommand({ kind: "update", background: false, alias: "update" }, c)).toBe(0);
    expect(out.join("")).toContain("Tropos Code 1.1.0 is up to date (latest: 1.1.0).");
    expect(await runInstallCommand({ kind: "rollback" }, c)).toBe(0);
    expect(out.join("")).toContain("Rolled back from 1.1.0 to 1.0.0. Background updates will skip 1.1.0.");
    expect(await runInstallCommand({ kind: "update", background: false, alias: "update" }, c)).toBe(0);
    expect(out.join("")).toContain("Tropos Code 1.1.0 is available but skipped because you rolled back from it; install it with tropos install 1.1.0.");
    f.srv.put("channels", "latest", "<html>");
    f.srv.put("channels", "latest.bak", "<html>");
    expect(await runInstallCommand({ kind: "install", target: "latest", force: false }, c)).toBe(69);
    expect(err.join("")).toContain("cannot resolve the latest channel");
  });
});
```

```ts
// src/cli/main.install.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeEngineFixture, type EngineFixture } from "../../test/install/helpers/engine";
import { versionPath } from "../install/layout";
import { main } from "./main";

let f: EngineFixture;
afterEach(() => f?.close());

async function run(argv: string[], execPath: string) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(argv, {
    out: (s) => void out.push(s),
    err: (s) => void err.push(s),
    env: { HOME: f.home, TROPOS_HOME: join(f.home, ".tropos"), SHELL: "/bin/bash" },
    cwd: f.root,
    execPath,
    engine: (log) => ({ ...f.deps, log }),
    readStdin: async () => null,
  });
  return { code, out: out.join(""), err: err.join("") };
}

describe("main dispatches install subcommands (spec §12)", () => {
  test("a dev run refuses with 73", async () => {
    f = await makeEngineFixture();
    const r = await run(["update"], "/usr/local/bin/bun");
    expect(r.code).toBe(73);
  });

  test("-- update is a prompt, not a subcommand", async () => {
    f = await makeEngineFixture();
    const r = await run(["--", "update"], "/usr/local/bin/bun");
    expect(r.err).toContain("interactive mode needs a terminal");
  });

  test("install stable never changes settings and prints the notice (R9.1)", async () => {
    f = await makeEngineFixture();
    await f.release("1.0.0");
    await f.direct("1.0.0");
    f.srv.put("channels", "stable", "1.0.0\n");
    const settingsPath = join(f.home, ".tropos", "settings.json");
    await mkdir(join(f.home, ".tropos"), { recursive: true });
    const settingsText = '{\n  "autoUpdatesChannel": "latest"\n}\n';
    await writeFile(settingsPath, settingsText);
    const r = await run(["install", "stable"], versionPath(f.layout, "1.0.0"));
    expect(r.code).toBe(0);
    expect(r.out).toContain("To stay on 'stable', set \"autoUpdatesChannel\": \"stable\"");
    expect(await readFile(settingsPath, "utf8")).toBe(settingsText);
  });

  test("install --help", async () => {
    f = await makeEngineFixture();
    const r = await run(["install", "--help"], "/usr/local/bin/bun");
    expect(r.code).toBe(0);
    expect(r.out).toStartWith("Usage: tropos install");
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `bun test src/install/commands.test.ts src/cli/main.install.test.ts`
Expected: FAIL — `./commands` not found; `MainDeps` has no `execPath`.

- [ ] **Step 3: Implement `commands.ts`**

```ts
// src/install/commands.ts
import type { InstallCommand } from "../cli/args";
import { INSTALL_HELP, ROLLBACK_HELP, UPDATE_HELP } from "../cli/usage";
import { runBackgroundUpdate } from "./autoupdate";
import type { Channel } from "./channels";
import type { EngineDeps } from "./engine";
import { InstallError, exitCodeFor } from "./errors";
import { installSelf, installTarget, updateChannel } from "./installer";
import { nativeVersionOf, resolveLayout } from "./layout";
import type { LockInfo } from "./locks";
import { detectPlatform } from "./platform";
import type { RecoveryReport } from "./recovery";
import { rollback } from "./rollback";
import { TRUSTED_KEYS } from "./trust";
import { RELEASE_URLS } from "./urls";
import { defaultHealthCheck } from "./verify";

export interface CommandContext {
  out: (s: string) => void;
  err: (s: string) => void;
  env: NodeJS.ProcessEnv;
  execPath: string;
  version: string;
  settings: { autoUpdates: boolean; autoUpdatesChannel: Channel };
  /** Tests inject engine dependencies; production uses productionEngineDeps. */
  engine?: (log: (line: string) => void) => EngineDeps;
}

export function productionEngineDeps(env: NodeJS.ProcessEnv, version: string, log: (line: string) => void): EngineDeps {
  return {
    layout: resolveLayout(env),
    platform: detectPlatform(),
    trusted: TRUSTED_KEYS,
    urls: RELEASE_URLS,
    health: (bin, v) => defaultHealthCheck(bin, v, env),
    selfVersion: version,
    log,
  };
}

/** Spec §11 "One-time installs". */
export function oneTimeInstallNotice(target: string, settings: CommandContext["settings"]): string | null {
  if (!settings.autoUpdates || target === settings.autoUpdatesChannel) return null;
  const lead = `Background updates follow the '${settings.autoUpdatesChannel}' channel and may move you to a newer version.`;
  if (target === "latest" || target === "stable") return `${lead} To stay on '${target}', set "autoUpdatesChannel": "${target}" in ~/.tropos/settings.json.`;
  return `${lead} To stay on ${target}, set "autoUpdates": false in ~/.tropos/settings.json.`;
}

const HELP = { install: INSTALL_HELP, update: UPDATE_HELP, upgrade: UPDATE_HELP, rollback: ROLLBACK_HELP } as const;
const SKIP_TEXT = { "rolled-back": "you rolled back from it", "health-check": "it failed its health check on this machine" } as const;

export async function runInstallCommand(cmd: InstallCommand, ctx: CommandContext): Promise<number> {
  if (cmd.kind === "help") {
    ctx.out(HELP[cmd.command]);
    return 0;
  }
  const background = cmd.kind === "update" && cmd.background;
  const log = (line: string) => {
    if (background) ctx.out(`${new Date().toISOString()} ${line}\n`);
  };
  const deps = (ctx.engine ?? ((l) => productionEngineDeps(ctx.env, ctx.version, l)))(log);
  const report = (r: RecoveryReport) => {
    for (const a of r.actions) ctx.err(`tropos: ${a}\n`);
  };
  const onWait = (holder: LockInfo | null) =>
    ctx.err(`tropos: waiting for another Tropos install to finish${holder ? ` (pid ${holder.pid})` : ""}…\n`);

  try {
    if (cmd.kind === "install-self") {
      const run = await installSelf(deps, { kind: "self", execPath: ctx.execPath, manifestPath: cmd.manifest, signaturePath: cmd.signature, compiledVersion: ctx.version });
      report(run.recovery);
      ctx.out(`Installed Tropos Code ${run.value.version}.\n`);
      return 0;
    }
    if (nativeVersionOf(deps.layout, ctx.execPath) === null) {
      throw new InstallError("local", "not a native install; install with install.sh");
    }
    if (background) {
      await runBackgroundUpdate(deps, ctx.settings.autoUpdatesChannel);
      return 0;
    }
    if (cmd.kind === "install") {
      const target = cmd.target ?? "latest";
      const run = await installTarget(deps, target, cmd.force, onWait);
      report(run.recovery);
      ctx.out(run.value.changed ? `Installed Tropos Code ${run.value.version}.\n` : `Tropos Code ${run.value.version} is already installed.\n`);
      const notice = oneTimeInstallNotice(target, ctx.settings);
      if (notice) ctx.out(`${notice}\n`);
      return 0;
    }
    if (cmd.kind === "update") {
      const run = (await updateChannel(deps, ctx.settings.autoUpdatesChannel, { wait: true, onWait }))!;
      report(run.recovery);
      const r = run.value;
      if (r.kind === "updated") ctx.out(`Updated Tropos Code from ${r.outcome.previous ?? "an unmanaged build"} to ${r.outcome.version}.\n`);
      else if (r.kind === "up-to-date") ctx.out(`Tropos Code ${r.current} is up to date (${ctx.settings.autoUpdatesChannel}: ${r.available}).\n`);
      else ctx.out(`Tropos Code ${r.version} is available but skipped because ${SKIP_TEXT[r.reason]}; install it with tropos install ${r.version}.\n`);
      return 0;
    }
    const run = await rollback(deps);
    report(run.recovery);
    ctx.out(`Rolled back from ${run.value.previous} to ${run.value.version}. Background updates will skip ${run.value.previous}.\n`);
    return 0;
  } catch (e) {
    if (background) {
      log(`failed: ${(e as Error).message}`);
      return 0;
    }
    ctx.err(`tropos: ${(e as Error).message}\n`);
    return exitCodeFor(e);
  }
}
```

- [ ] **Step 4: Wire `main.tsx`**

1. Imports: add `parseInvocation` to the `./args` import; add `import { runInstallCommand, type CommandContext } from "../install/commands";`.
2. `MainDeps` gains:

```ts
  /** The running executable; tests point it inside a fixture's versions/ to act as a native install. */
  execPath?: string;
  engine?: CommandContext["engine"];
```

3. In `run`, replace the `let opts: CliOptions; try { opts = parseCli(argv); } catch …` block with:

```ts
  let opts: CliOptions;
  try {
    const invocation = parseInvocation(argv);
    if (invocation.kind === "subcommand") {
      const env = deps.env ?? process.env;
      const cwd = resolveToolPath(".", deps.cwd ?? process.cwd());
      let settings: Settings;
      try {
        settings = (await loadSettings(settingsPaths(cwd, troposHome(env)))).settings;
      } catch (e) {
        if (e instanceof SettingsError) {
          err(`tropos: ${e.message}\n`);
          return 1;
        }
        throw e;
      }
      return await runInstallCommand(invocation.command, {
        out,
        err,
        env,
        execPath: deps.execPath ?? process.execPath,
        version: VERSION,
        settings: { autoUpdates: settings.autoUpdates, autoUpdatesChannel: settings.autoUpdatesChannel },
        engine: deps.engine,
      });
    }
    opts = invocation.options;
  } catch (e) {
    if (e instanceof CliError) {
      err(`tropos: ${e.message}\nRun tropos --help for usage.\n`);
      return EXIT_USAGE;
    }
    throw e;
  }
```

4. Remove `parseCli` from the `./args` import if it is now unused in `main.tsx`.

- [ ] **Step 5: Run to see them pass, plus the whole CLI suite**

Run: `bun test src/install/commands.test.ts src/cli && bun run typecheck`
Expected: PASS, including the unchanged `src/cli/main.test.ts` and the snapshot.

- [ ] **Step 6: Commit**

```bash
git add src/install/commands.ts src/install/commands.test.ts src/cli/main.tsx src/cli/main.install.test.ts
git commit -m "feat(cli): run install, update, upgrade and rollback from the tropos command

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 21: Native session hooks, build-time test flag and compiled-binary e2e

Spec: §10.1 in-use lock and re-exec, §11 spawn and announcement, amendment A3, §13 layers 3 and 10 (spawn on the compiled binary).

**Files:**
- Create: `src/install/build-flags.ts`, `src/install/build-flags.test.ts`
- Modify: `src/install/trust.ts` (test-build signers), `src/install/urls.ts` (test-build base URL)
- Modify: `src/install/commands.ts` (`productionEngineDeps` sets `allowLoopbackHttp: IS_TEST_BUILD`)
- Create: `src/install/session.ts`, `src/install/session.test.ts`
- Modify: `src/cli/main.tsx` (call `startNativeSession` for sessions)
- Modify: `build.ts` (`--test-build`, `--test-signers`; always define `TROPOS_TEST_BUILD`)
- Create: `test/install/binary.e2e.test.ts`
- Modify: `scripts/check-coverage.ts` (exempt `src/install/build-flags.ts` branches only reachable in test builds — see Step 9)

**Interfaces:**
- Consumes: Tasks 10–20
- Produces: `IS_TEST_BUILD: boolean`, `testBuildOverrides(env): { signers: string; base: string } | null`
- Produces: `interface NativeSessionDeps { env: NodeJS.ProcessEnv; execPath: string; print: boolean; stdinTTY: boolean; stdoutTTY: boolean; autoUpdates: boolean; version: string; now?: () => Date; spawn?: typeof Bun.spawn }`, `type NativeSessionStart = { kind: "not-native" } | { kind: "reexec"; via: string } | { kind: "native"; version: string; holdsLock: boolean; announcement: string | null; updateSpawned: boolean }`, `startNativeSession(d): Promise<NativeSessionStart>`
- Produces: `bun build.ts --test-build --test-signers <file> --outfile <path>`

- [ ] **Step 1: Write the failing tests**

```ts
// src/install/build-flags.test.ts
import { describe, expect, test } from "bun:test";
import { IS_TEST_BUILD, testBuildOverrides } from "./build-flags";

describe("build flags (amendment A3)", () => {
  test("dev and bun test runs are never test builds", () => {
    expect(IS_TEST_BUILD).toBe(false);
    expect(testBuildOverrides({ TROPOS_TEST_RELEASES_BASE: "http://127.0.0.1:1" })).toBeNull();
  });
});
```

```ts
// src/install/session.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { makeEngineFixture, type EngineFixture } from "../../test/install/helpers/engine";
import { versionPath } from "./layout";
import { tryLockVersionExclusive } from "./locks";
import { startNativeSession, type NativeSessionDeps } from "./session";
import { emptyState, readState, writeState } from "./state";

let f: EngineFixture;
afterEach(() => f?.close());

const deps = (extra: Partial<NativeSessionDeps> = {}): NativeSessionDeps => ({
  env: { HOME: f.home },
  execPath: versionPath(f.layout, "1.0.0"),
  print: false,
  stdinTTY: true,
  stdoutTTY: true,
  autoUpdates: true,
  version: "1.0.0",
  spawn: (() => ({ unref() {} })) as unknown as typeof Bun.spawn,
  ...extra,
});

describe("startNativeSession", () => {
  test("not native for dev runs", async () => {
    f = await makeEngineFixture();
    expect(await startNativeSession(deps({ execPath: "/usr/local/bin/bun" }))).toEqual({ kind: "not-native" });
  });

  test("holds the in-use lock so cleanup cannot remove the running version", async () => {
    f = await makeEngineFixture();
    await f.setup({ versions: ["1.0.0"], current: "1.0.0", link: "1.0.0" });
    const r = await startNativeSession(deps());
    expect(r).toMatchObject({ kind: "native", version: "1.0.0", holdsLock: true });
    expect(tryLockVersionExclusive(f.layout, "1.0.0")).toBeNull();
  });

  test("re-executes through ~/.local/bin/tropos when its binary was removed before it locked", async () => {
    f = await makeEngineFixture();
    await f.setup({ versions: ["1.0.0", "1.1.0"], current: "1.1.0", link: "1.1.0" });
    await rm(versionPath(f.layout, "1.0.0"));
    expect(await startNativeSession(deps())).toEqual({ kind: "reexec", via: f.layout.binLink });
  });

  test("never re-executes twice", async () => {
    f = await makeEngineFixture();
    await f.setup({ versions: ["1.1.0"], current: "1.1.0", link: "1.1.0" });
    const r = await startNativeSession(deps({ env: { HOME: f.home, TROPOS_REEXEC: "1" } }));
    expect(r.kind).toBe("native");
  });

  test("announces an update once, then spawns a check when due", async () => {
    f = await makeEngineFixture();
    await f.setup({ versions: ["1.0.0"], current: "1.0.0", link: "1.0.0" });
    await writeState(f.layout, { ...emptyState(), current: "1.0.0", autoUpdate: { ...emptyState().autoUpdate, lastUpdated: "1.0.0", announced: false } });
    const spawned: string[][] = [];
    const spawn = ((cmd: string[]) => (spawned.push(cmd), { unref() {} })) as unknown as typeof Bun.spawn;
    const first = await startNativeSession(deps({ spawn }));
    expect(first).toMatchObject({ announcement: "Updated to 1.0.0", updateSpawned: true });
    expect(spawned).toEqual([[versionPath(f.layout, "1.0.0"), "update", "--background"]]);
    const read = await readState(f.layout);
    expect(read.kind === "ok" && read.state.autoUpdate.announced).toBe(true);
    expect((await startNativeSession(deps({ spawn }))).announcement).toBeNull();
  });

  test("print mode takes the lock but never spawns or announces", async () => {
    f = await makeEngineFixture();
    await f.setup({ versions: ["1.0.0"], current: "1.0.0", link: "1.0.0" });
    const r = await startNativeSession(deps({ print: true }));
    expect(r).toMatchObject({ kind: "native", holdsLock: true, announcement: null, updateSpawned: false });
  });
});
```

```ts
// test/install/binary.e2e.test.ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTmpDir, removeDir } from "../helpers/tmp";
import { publishFixture, makeFixtureRelease } from "./helpers/fixture-release";
import { allowedSignersText, makeTestKey, type TestKey } from "./helpers/keys";
import { startReleaseServer, type ReleaseServer } from "./helpers/release-server";
import pkg from "../../package.json";

let dir: string;
let key: TestKey;
let srv: ReleaseServer;
let prodBin: string;
let testBin: string;
const home = () => join(dir, "home");

beforeAll(async () => {
  dir = await makeTmpDir();
  key = await makeTestKey(dir, "e2e");
  await writeFile(join(dir, "signers"), allowedSignersText(key));
  prodBin = process.env.TROPOS_TEST_BINARY ?? join(dir, "tropos-prod");
  testBin = join(dir, "tropos-test");
  if (!process.env.TROPOS_TEST_BINARY) await Bun.$`bun build.ts --outfile ${prodBin}`.quiet();
  await Bun.$`bun build.ts --test-build --test-signers ${join(dir, "signers")} --outfile ${testBin}`.quiet();
  srv = startReleaseServer();
}, 300_000);
afterAll(async () => {
  srv.stop();
  await removeDir(dir);
});

async function exec(bin: string, args: string[], extraEnv: Record<string, string> = {}) {
  const proc = Bun.spawn([bin, ...args], {
    env: { PATH: process.env.PATH!, HOME: home(), TROPOS_HOME: join(home(), ".tropos"), TROPOS_TEST_RELEASES_BASE: srv.base, ...extraEnv },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, code };
}

describe("production binary", () => {
  test("contains no test-build hooks (amendment A3)", async () => {
    const bytes = Buffer.from(await Bun.file(prodBin).arrayBuffer());
    expect(bytes.includes("TROPOS_TEST_RELEASES_BASE")).toBe(false);
  });

  test("subcommands outside a native install exit 73", async () => {
    expect((await exec(prodBin, ["update"])).code).toBe(73);
  });

  test("with no pinned key, install --self fails closed (A5)", async () => {
    const r = await makeFixtureRelease({ version: pkg.version, key, dir, binary: new Uint8Array(await Bun.file(prodBin).arrayBuffer()) });
    await writeFile(join(dir, "pm.json"), r.verified.bytes);
    await writeFile(join(dir, "pm.sig"), r.verified.signature);
    const out = await exec(prodBin, ["install", "--self", "--manifest", join(dir, "pm.json"), "--signature", join(dir, "pm.sig")]);
    expect(out.code).toBe(65);
    expect(out.stderr).toContain("untrusted key");
  });
});

describe("test-build binary: install --self → update → rollback", () => {
  test("full flow", async () => {
    const self = await makeFixtureRelease({ version: pkg.version, key, dir, binary: new Uint8Array(await Bun.file(testBin).arrayBuffer()) });
    publishFixture(srv, self);
    await writeFile(join(dir, "m.json"), self.verified.bytes);
    await writeFile(join(dir, "m.sig"), self.verified.signature);

    const installed = await exec(testBin, ["install", "--self", "--manifest", join(dir, "m.json"), "--signature", join(dir, "m.sig")]);
    expect(installed.stderr).toBe("");
    expect(installed.code).toBe(0);
    const link = join(home(), ".local/bin/tropos");
    expect((await exec(link, ["--version"])).stdout).toBe(`${pkg.version} (Tropos Code)\n`);

    const next = "99.0.0";
    publishFixture(srv, await makeFixtureRelease({ version: next, key, dir }));
    srv.put("channels", "latest", `${next}\n`);
    const updated = await exec(link, ["update"]);
    expect(updated.code).toBe(0);
    expect(updated.stdout).toContain(`Updated Tropos Code from ${pkg.version} to ${next}.`);
    expect(await readlink(link)).toEndWith(`/versions/${next}`);

    const rolled = await exec(join(home(), ".local/share/tropos/versions", pkg.version), ["rollback"]);
    expect(rolled.code).toBe(0);
    expect((await exec(link, ["--version"])).stdout).toBe(`${pkg.version} (Tropos Code)\n`);
  }, 120_000);
});
```

- [ ] **Step 2: Run to see them fail**

Run: `bun test src/install/build-flags.test.ts src/install/session.test.ts test/install/binary.e2e.test.ts`
Expected: FAIL — modules not found; `build.ts` rejects `--test-build`.

- [ ] **Step 3: Implement `build-flags.ts` and wire trust/urls/commands**

```ts
// src/install/build-flags.ts
declare const TROPOS_TEST_BUILD: boolean | undefined;
declare const TROPOS_TEST_SIGNERS: string | undefined;

/**
 * True only in binaries built with `bun build.ts --test-build` for the compiled e2e tests. Production builds
 * define TROPOS_TEST_BUILD as false, so every branch below is removed from them (amendment A3).
 */
export const IS_TEST_BUILD: boolean = typeof TROPOS_TEST_BUILD !== "undefined" && TROPOS_TEST_BUILD === true;

export function testBuildOverrides(env: NodeJS.ProcessEnv): { signers: string; base: string } | null {
  if (!IS_TEST_BUILD) return null;
  return { signers: typeof TROPOS_TEST_SIGNERS === "string" ? TROPOS_TEST_SIGNERS : "", base: env.TROPOS_TEST_RELEASES_BASE ?? "" };
}
```

In `src/install/trust.ts` replace the `TRUSTED_KEYS` line with:

```ts
import { testBuildOverrides } from "./build-flags";
// …
export const TRUSTED_KEYS: readonly TrustedKey[] = Object.freeze(parseAllowedSigners(testBuildOverrides(process.env)?.signers ?? ALLOWED_SIGNERS_TEXT));
```

In `src/install/urls.ts` replace the `RELEASE_URLS` line with:

```ts
import { testBuildOverrides } from "./build-flags";
// …
const testBuild = testBuildOverrides(process.env);
export const RELEASE_URLS: ReleaseUrls = testBuild ? githubReleaseUrls({ base: testBuild.base, repo: "t/r", channelsRepo: "t/r" }) : githubReleaseUrls();
```

In `productionEngineDeps` (`commands.ts`) add `allowLoopbackHttp: IS_TEST_BUILD,` (import `IS_TEST_BUILD` from `./build-flags`).

- [ ] **Step 4: Extend `build.ts`**

Add the two options to `parseArgs` (`"test-build": { type: "boolean", default: false }`, `"test-signers": { type: "string" }`), give `build()` a `define` parameter, and compute it once:

```ts
const define: Record<string, string> = {
  "process.env.NODE_ENV": '"production"',
  // Production builds compile the test hooks out (src/install/build-flags.ts, amendment A3).
  TROPOS_TEST_BUILD: values["test-build"] ? "true" : "false",
};
if (values["test-build"]) {
  if (!values["test-signers"]) throw new Error("--test-build needs --test-signers <allowed_signers file>");
  if (values.all) throw new Error("--test-build cannot be combined with --all");
  define.TROPOS_TEST_SIGNERS = JSON.stringify(await Bun.file(values["test-signers"]).text());
}
```

and pass `define` to `Bun.build` instead of the inline object.

- [ ] **Step 5: Implement `session.ts`**

```ts
// src/install/session.ts
import { existsSync } from "node:fs";
import { announcement, markAnnounced, shouldCheck, spawnBackgroundUpdate } from "./autoupdate";
import { nativeVersionOf, resolveLayout } from "./layout";
import { lockVersionShared } from "./locks";
import { readState } from "./state";

export interface NativeSessionDeps {
  env: NodeJS.ProcessEnv;
  execPath: string;
  print: boolean;
  stdinTTY: boolean;
  stdoutTTY: boolean;
  autoUpdates: boolean;
  version: string;
  now?: () => Date;
  spawn?: typeof Bun.spawn;
}

export type NativeSessionStart =
  | { kind: "not-native" }
  | { kind: "reexec"; via: string }
  | { kind: "native"; version: string; holdsLock: boolean; announcement: string | null; updateSpawned: boolean };

/**
 * Spec §10.1 and §11: hold a shared lock on our own version for the whole session; if our binary vanished
 * before we locked it, run again through ~/.local/bin/tropos; announce a finished update; maybe start one.
 */
export async function startNativeSession(d: NativeSessionDeps): Promise<NativeSessionStart> {
  const layout = resolveLayout(d.env);
  const version = nativeVersionOf(layout, d.execPath);
  if (version === null) return { kind: "not-native" };
  const lock = await lockVersionShared(layout, version).catch(() => null);
  if (!existsSync(d.execPath) && !d.env.TROPOS_REEXEC) {
    lock?.release();
    return { kind: "reexec", via: layout.binLink };
  }
  const read = await readState(layout).catch(() => ({ kind: "missing" as const }));
  const state = read.kind === "ok" ? read.state : null;
  const interactive = !d.print && d.stdinTTY && d.stdoutTTY;
  const message = interactive && state ? announcement(state) : null;
  if (message) await markAnnounced({ layout, selfVersion: d.version }).catch(() => {});
  const decision = shouldCheck({ env: d.env, native: true, print: d.print, stdinTTY: d.stdinTTY, stdoutTTY: d.stdoutTTY, autoUpdates: d.autoUpdates, state, now: d.now?.() ?? new Date() });
  const updateSpawned = decision.check ? spawnBackgroundUpdate(d.execPath, layout, d.env, d.spawn) : false;
  return { kind: "native", version, holdsLock: lock !== null, announcement: message, updateSpawned };
}
```

`nativeVersionOf` resolves the symlink, so a removed binary reached through `~/.local/bin/tropos` is detected by `existsSync(d.execPath)` on the original path; `execPath` for compiled Bun binaries is the resolved path, so the check is on the versioned file itself.

- [ ] **Step 6: Wire `main.tsx`**

Import `startNativeSession` from `../install/session`. In `run`, directly after `Object.assign(env, settings.env);` add:

```ts
  const native = await startNativeSession({
    env,
    execPath: deps.execPath ?? process.execPath,
    print: opts.print,
    stdinTTY: Boolean(process.stdin.isTTY) && !deps.readStdin,
    stdoutTTY: Boolean(process.stdout.isTTY),
    autoUpdates: settings.autoUpdates,
    version: VERSION,
  });
  if (native.kind === "reexec") {
    const proc = Bun.spawn([native.via, ...argv], { stdio: ["inherit", "inherit", "inherit"], env: { ...env, TROPOS_REEXEC: "1" } });
    return await proc.exited;
  }
  if (native.kind === "native" && native.announcement) err(`${native.announcement}\n`);
```

- [ ] **Step 7: Run to see them pass**

Run: `bun test src/install/build-flags.test.ts src/install/session.test.ts test/install/binary.e2e.test.ts src/cli && bun run typecheck`
Expected: PASS. If the production-binary test finds `TROPOS_TEST_RELEASES_BASE`, the minifier kept the branch: confirm `TROPOS_TEST_BUILD: "false"` reaches `Bun.build` in every non-test build.

- [ ] **Step 8: Run the full suite**

Run: `bun test && bun run test:coverage`
Expected: PASS.

- [ ] **Step 9: Coverage exemption for test-build-only branches**

If `test:coverage` reports `src/install/build-flags.ts` below 80 % (its test-build branch never runs under `bun test`), add to `EXEMPT` in `scripts/check-coverage.ts`:

```ts
  "src/install/build-flags.ts": "test-build branches run only in compiled e2e binaries (amendment A3)",
```

and adjust `evaluate` so exempt files are also skipped by the per-file threshold — add `.filter((f) => !(f.path.replace(/\\/g, "/").replace(/^\.\//, "") in exempt))` before the threshold check — with a test in `scripts/check-coverage.test.ts` ("exempt files are not held to the per-file threshold").

- [ ] **Step 10: Commit**

```bash
git add src/install/build-flags.ts src/install/build-flags.test.ts src/install/trust.ts src/install/urls.ts src/install/commands.ts src/install/session.ts src/install/session.test.ts src/cli/main.tsx build.ts test/install/binary.e2e.test.ts scripts/check-coverage.ts scripts/check-coverage.test.ts
git commit -m "feat(install): in-use lock and re-exec for native sessions; compiled e2e via test builds

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## M5 — Installer

### Task 22: `install.sh` (POSIX, fail-closed) and its test harness

Spec: §8 (all), §4.2–4.3, decisions D3/D4/D6, amendment A5, Review Focus 2. The old local-build script moves to `scripts/install-local.sh`.

**Files:**
- Move: `install.sh` → `scripts/install-local.sh` (adjust paths), `package.json` (`"install:local": "sh scripts/install-local.sh"`), `README.md` (dev install line)
- Create: `install.sh`
- Create: `test/install/helpers/sh-runner.ts`
- Create: `test/install/install-sh.test.ts`

**Interfaces:**
- Consumes: `release/allowed_signers` (Task 5), `scripts/release/manifest.awk` (Task 7), fixtures (Tasks 9, 13)
- Produces: `install.sh [stable|latest|<version>]`; env `TROPOS_INSTALL_ALLOW_SUDO`, `TROPOS_INSTALL_FROM`; exit codes 0/1/64/65/69 and the binary's own code; hand-off `"$bin" install --self --manifest <m> --signature <s>`; marker blocks `pinned-key`, `release-urls`, `manifest-awk`
- Produces (tests): `interface Sandbox { dir; home; bin; run(args?, opts?): Promise<ShResult> }`, `makeSandbox(opts: { signers: string; base: string; shell?: string[]; hide?: string[]; shims?: Record<string, string>; home?: string }): Promise<Sandbox>`, `SHELLS: string[][]` (available POSIX shells), `handoffBinary(): string`

- [ ] **Step 1: Move the local-build installer**

```bash
git mv install.sh scripts/install-local.sh
```

In `scripts/install-local.sh` change the `here=` line to point at the repository root and keep the rest:

```sh
here="$(cd "$(dirname "$0")/.." && pwd)"
```

Add `"install:local": "sh scripts/install-local.sh",` to `package.json` `scripts`, and in `README.md` replace `./install.sh         # → ~/.local/bin/tropos` with `bun run install:local  # → ~/.local/bin/tropos (local build)`.

Run: `bun run build && bun run install:local` (with `HOME` pointed at a temp dir: `HOME=$(mktemp -d) bun run install:local`)
Expected: `Installed Tropos Code 0.1.0 at …/.local/bin/tropos`.

- [ ] **Step 2: Write the sandbox harness**

```ts
// test/install/helpers/sh-runner.ts
// Runs a test copy of install.sh in a sandbox: PATH holds only links to the tools we allow (or shims),
// and the pinned-key and release-url blocks are replaced. The production script itself has no overrides.
import { chmod, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTmpDir } from "../../helpers/tmp";

export const INSTALL_SH = join(import.meta.dir, "../../../install.sh");

const TOOLS = ["sh", "awk", "curl", "wget", "cp", "chmod", "rm", "mktemp", "uname", "od", "tail", "wc", "tr", "cat", "grep", "sleep", "id", "basename", "sha256sum", "shasum", "ssh-keygen", "zstd", "ldd", "sysctl", "stty", "env", "printf", "ls", "perl"];

export const SHELLS: string[][] = [["sh"], ["dash"], ["bash", "--posix"], ["busybox", "ash"]].filter((s) => {
  if (!Bun.which(s[0]!)) return false;
  return s[0] !== "busybox" || Bun.spawnSync(["busybox", "ash", "-c", "true"]).exitCode === 0;
});

export function replaceBlock(text: string, name: string, body: string): string {
  const start = `# >>> ${name}`;
  const end = `# <<< ${name}`;
  const i = text.indexOf(start);
  const j = text.indexOf(end);
  if (i < 0 || j < i) throw new Error(`install.sh has no ${name} block`);
  const lineEnd = text.indexOf("\n", i);
  return `${text.slice(0, lineEnd + 1)}${body}\n  ${text.slice(j)}`;
}

export function blockOf(text: string, name: string): string {
  const i = text.indexOf(`# >>> ${name}`);
  const j = text.indexOf(`# <<< ${name}`);
  return text.slice(text.indexOf("\n", i) + 1, j).replace(/\n\s*$/, "");
}

/** The fake tropos the installer hands off to: records its arguments and exits with $FAKE_EXIT. */
export function handoffBinary(version = "1.0.0"): string {
  // The final comment line lets the zstd corpus flip a byte without breaking the script.
  return `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "${version} (Tropos Code)"; exit 0; fi\necho "$*" > "$HOME/handoff"\n[ -n "$FAKE_SIGNAL" ] && kill -9 $$\nexit \${FAKE_EXIT:-0}\n# zzzz\n`;
}

export interface ShResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface Sandbox {
  dir: string;
  home: string;
  bin: string;
  script: string;
  run(args?: string[], opts?: { env?: Record<string, string>; shell?: string[] }): Promise<ShResult>;
}

export async function makeSandbox(opts: { signers: string; base: string; shell?: string[]; hide?: string[]; shims?: Record<string, string>; home?: string }): Promise<Sandbox> {
  const dir = await makeTmpDir("tropos-sh-");
  const bin = join(dir, "bin");
  const home = opts.home ? join(dir, opts.home) : join(dir, "home");
  await mkdir(bin);
  await mkdir(home, { recursive: true });
  for (const tool of TOOLS) {
    if (opts.hide?.includes(tool)) continue;
    const real = Bun.which(tool);
    if (real) await symlink(real, join(bin, tool));
  }
  for (const [name, body] of Object.entries(opts.shims ?? {})) {
    await Bun.$`rm -f ${join(bin, name)}`;
    await writeFile(join(bin, name), body);
    await chmod(join(bin, name), 0o755);
  }
  let text = await readFile(INSTALL_SH, "utf8");
  text = replaceBlock(text, "pinned-key", `  TROPOS_ALLOWED_SIGNERS='${opts.signers}'`);
  text = replaceBlock(
    text,
    "release-urls",
    `  TROPOS_RELEASES='${opts.base}/t/r/releases'\n  TROPOS_CHANNELS='${opts.base}/t/r/releases/download/channels'\n  TROPOS_PROTO='=http,https'`,
  );
  const script = join(dir, "install.sh");
  await writeFile(script, text);
  return {
    dir,
    home,
    bin,
    script,
    async run(args = [], runOpts = {}) {
      const shell = runOpts.shell ?? opts.shell ?? ["sh"];
      const shellPath = Bun.which(shell[0]!)!;
      const proc = Bun.spawn([shellPath, ...shell.slice(1), script, ...args], {
        cwd: dir,
        env: { PATH: bin, HOME: home, SHELL: "/bin/zsh", ...runOpts.env },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      return { code, stdout, stderr };
    },
  };
}
```

- [ ] **Step 3: Write the failing happy-path tests**

```ts
// test/install/install-sh.test.ts
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { detectPlatform } from "../../src/install/platform";
import { makeTmpDir, removeDir } from "../helpers/tmp";
import { makeFixtureRelease, publishFixture } from "./helpers/fixture-release";
import { allowedSignersText, makeTestKey, type TestKey } from "./helpers/keys";
import { startReleaseServer, type ReleaseServer } from "./helpers/release-server";
import { SHELLS, handoffBinary, makeSandbox } from "./helpers/sh-runner";

let root: string;
let key: TestKey;
let srv: ReleaseServer;
const platform = detectPlatform();

beforeAll(async () => {
  root = await makeTmpDir();
  key = await makeTestKey(root, "k");
});
afterAll(() => removeDir(root));
beforeEach(async () => {
  srv?.stop();
  srv = startReleaseServer();
  for (const v of ["1.0.0", "1.1.0"]) publishFixture(srv, await makeFixtureRelease({ version: v, key, dir: root, binary: handoffBinary(v) }));
});

const sandbox = (extra: Parameters<typeof makeSandbox>[0] extends infer O ? Partial<O> : never = {}) =>
  makeSandbox({ signers: allowedSignersText(key), base: srv.base, ...extra });

describe.each(SHELLS.map((s) => [s.join(" "), s]))("install.sh under %s", (_name, shell) => {
  test("latest via the primary pointer hands off to install --self", async () => {
    srv.put("channels", "latest", "1.1.0\n");
    const sb = await sandbox({ shell: shell as string[] });
    const r = await sb.run();
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`Verified Tropos Code 1.1.0 for ${platform}.`);
    const handoff = (await readFile(join(sb.home, "handoff"), "utf8")).trim();
    expect(handoff).toMatch(/^install --self --manifest .+\/manifest\.json --signature .+\/manifest\.json\.sig$/);
    expect(srv.requests).toContain(`/t/r/releases/download/v1.1.0/tropos-${platform}.zst`);
  });
});

describe("install.sh targets and sources", () => {
  test("an explicit version needs no pointer", async () => {
    const r = await (await sandbox()).run(["1.0.0"]);
    expect(r.code).toBe(0);
    expect(srv.requests.some((p) => p.includes("/channels/"))).toBe(false);
  });

  test("stable through the .bak slot when the primary is missing (R3.1)", async () => {
    srv.put("channels", "stable.bak", "1.0.0\n");
    const r = await (await sandbox()).run(["stable"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Verified Tropos Code 1.0.0");
  });

  test("latest falls back to GitHub's latest release when both slots fail", async () => {
    srv.setLatest("v1.1.0");
    const r = await (await sandbox()).run();
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Verified Tropos Code 1.1.0");
  });

  test("without zstd it downloads the raw binary", async () => {
    srv.put("channels", "latest", "1.1.0\n");
    const r = await (await sandbox({ hide: ["zstd"] })).run();
    expect(r.code).toBe(0);
    expect(srv.requests).toContain(`/t/r/releases/download/v1.1.0/tropos-${platform}`);
    expect(srv.requests.some((p) => p.endsWith(".zst"))).toBe(false);
  });

  test("installs into a HOME containing spaces (Review Focus 2)", async () => {
    const sb = await sandbox({ home: "Jane Doe/home" });
    const r = await sb.run(["1.0.0"]);
    expect(r.code).toBe(0);
    expect(await Bun.file(join(sb.home, "handoff")).exists()).toBe(true);
  });

  test("TROPOS_INSTALL_FROM reads a local folder and still verifies", async () => {
    const folder = join(root, "draft");
    const r1 = await makeFixtureRelease({ version: "2.0.0", key, dir: root, binary: handoffBinary("2.0.0") });
    await Bun.$`mkdir -p ${folder}`;
    await Bun.write(join(folder, "manifest.json"), r1.verified.bytes);
    await Bun.write(join(folder, "manifest.json.sig"), r1.verified.signature);
    await Bun.write(join(folder, `tropos-${platform}`), r1.binary);
    await Bun.write(join(folder, `tropos-${platform}.zst`), r1.zst);
    const sb = await sandbox();
    expect((await sb.run(["2.0.0"], { env: { TROPOS_INSTALL_FROM: folder } })).code).toBe(0);
    expect((await sb.run(["latest"], { env: { TROPOS_INSTALL_FROM: folder } })).code).toBe(64);
    await Bun.write(join(folder, "manifest.json.sig"), "-----BEGIN SSH SIGNATURE-----\nAAAA\n-----END SSH SIGNATURE-----\n");
    expect((await sb.run(["2.0.0"], { env: { TROPOS_INSTALL_FROM: folder } })).code).toBe(65);
  });

  test("prints the PATH line when ~/.local/bin is not on PATH, and never edits startup files", async () => {
    const sb = await sandbox();
    const r = await sb.run(["1.0.0"]);
    expect(r.stdout).toContain(`Add ${sb.home}/.local/bin to your PATH`);
    expect(r.stdout).toContain(`export PATH="${sb.home}/.local/bin:$PATH"`);
    expect(await Bun.file(join(sb.home, ".zshrc")).exists()).toBe(false);
  });
});
```

- [ ] **Step 4: Run to see them fail**

Run: `bun test test/install/install-sh.test.ts`
Expected: FAIL — `install.sh has no pinned-key block`.

- [ ] **Step 5: Write `install.sh`**

Write the script below, then run Step 5b to embed `scripts/release/manifest.awk` (Task 7) between the `manifest-awk` markers; `release/allowed_signers` is already copied verbatim into the `pinned-key` block. Task 24's parity test enforces both.

```sh
#!/bin/sh
# Tropos Code installer — https://github.com/Tropos-AI/tropos-code
#
#   curl -fsSL https://github.com/Tropos-AI/tropos-code/releases/latest/download/install.sh | sh
#   curl -fsSL …/install.sh | sh -s -- stable        (or an exact version, e.g. 0.3.0)
#
# Verifies the release manifest's ed25519 signature with ssh-keygen against the key pinned below,
# then the binary's size and SHA-256, and only then runs it. Every check fails closed.
# The whole script is inside main(), called on the last line: a truncated download runs nothing.

main() {
  set -eu

  # >>> pinned-key (identical to release/allowed_signers; checked by test/install/parity.test.ts)
  TROPOS_ALLOWED_SIGNERS='# release/allowed_signers — trusted Tropos Code release signing keys (spec §4.2, §6).
# One line per key: tropos-release ssh-ed25519 <base64-key> <comment>
# Intentionally empty until the key ceremony (plan Task 29): with no key, every signature check fails closed.
'
  # <<< pinned-key
  # >>> release-urls
  TROPOS_RELEASES='https://github.com/Tropos-AI/tropos-code/releases'
  TROPOS_CHANNELS='https://github.com/Tropos-AI/tropos-code/releases/download/channels'
  TROPOS_PROTO='=https'
  # <<< release-urls
  # >>> manifest-awk (identical to scripts/release/manifest.awk; checked by test/install/parity.test.ts)
  MANIFEST_AWK='EMBEDDED-BY-STEP-5B'
  # <<< manifest-awk

  say() { printf '%s\n' "$*"; }
  fail() {
    fail_code=$1
    shift
    printf 'tropos install: %s\n' "$*" >&2
    exit "$fail_code"
  }
  need() { fail 1 "$1 is required. Install it with: apt install $2 | apk add $3 | dnf install $4 | brew install $5"; }
  is_version() {
    case $1 in '' | *[!0-9.]*) return 1 ;; esac
    [ ${#1} -le 32 ] && printf '%s\n' "$1" | grep -Eq '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
  }

  [ $# -le 1 ] || fail 64 "usage: install.sh [stable|latest|<version>]"
  target=${1:-latest}
  case $target in
    stable | latest) ;;
    *) is_version "$target" || fail 64 "usage: install.sh [stable|latest|<version>] (got \"$target\")" ;;
  esac
  [ -n "${HOME:-}" ] || fail 1 "HOME is not set"

  if [ "$(id -u)" -eq 0 ] && [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != root ] && [ -z "${TROPOS_INSTALL_ALLOW_SUDO:-}" ]; then
    fail 1 "do not run this installer with sudo: Tropos Code installs into your home directory. Re-run it without sudo, or set TROPOS_INSTALL_ALLOW_SUDO=1 to install for root."
  fi

  if command -v curl >/dev/null 2>&1; then dl=curl
  elif command -v wget >/dev/null 2>&1; then dl=wget
  else need "curl or wget" curl curl curl curl
  fi
  if command -v sha256sum >/dev/null 2>&1; then hasher=sha256sum
  elif command -v shasum >/dev/null 2>&1; then hasher=shasum
  else need "sha256sum or shasum" coreutils coreutils coreutils coreutils
  fi
  command -v ssh-keygen >/dev/null 2>&1 || need "ssh-keygen (OpenSSH 8.1 or newer)" openssh-client openssh-keygen openssh-clients openssh
  for tool in awk uname mktemp od tail wc tr cat grep; do
    command -v "$tool" >/dev/null 2>&1 || fail 1 "$tool is required"
  done
  has_zstd=no
  if command -v zstd >/dev/null 2>&1; then has_zstd=yes; fi
  wget_https=
  if [ "$dl" = wget ] && [ "$TROPOS_PROTO" = '=https' ] && wget --help 2>&1 | grep -q https-only; then wget_https=--https-only; fi

  os=$(uname -s)
  machine=$(uname -m)
  case $os in
    Darwin) os=darwin ;;
    Linux) os=linux ;;
    *) fail 1 "unsupported operating system: $os (Tropos Code supports macOS and Linux)" ;;
  esac
  case $machine in
    x86_64 | amd64) arch=x64 ;;
    arm64 | aarch64) arch=arm64 ;;
    *) fail 1 "unsupported CPU architecture: $machine" ;;
  esac
  if [ "$os" = darwin ] && [ "$arch" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then arch=arm64; fi
  platform="$os-$arch"
  if [ "$os" = linux ]; then
    musl=no
    for loader in /lib/ld-musl-*.so.1; do
      if [ -e "$loader" ]; then musl=yes; fi
    done
    if [ "$musl" = no ] && ldd /bin/sh 2>&1 | grep -qi musl; then musl=yes; fi
    if [ "$musl" = yes ]; then platform="$platform-musl"; fi
  fi

  tmp=$(mktemp -d 2>/dev/null || mktemp -d -t tropos) || fail 1 "cannot create a temporary directory"
  chmod 700 "$tmp"
  trap 'rm -rf "$tmp"' EXIT
  trap 'rm -rf "$tmp"; exit 129' HUP
  trap 'rm -rf "$tmp"; exit 130' INT
  trap 'rm -rf "$tmp"; exit 143' TERM

  # fetch URL FILE MAX_BYTES MAX_SECONDS — under a file-size limit, no pipelines (spec §8.2 step 7).
  fetch() {
    fetch_blocks=$(($3 / 512 + 2))
    rm -f "$2"
    if [ "$dl" = curl ]; then
      (ulimit -f "$fetch_blocks" && exec curl -fsSL --proto "$TROPOS_PROTO" --proto-redir "$TROPOS_PROTO" --connect-timeout 10 --max-time "$4" -o "$2" "$1") 2>/dev/null
    else
      (ulimit -f "$fetch_blocks" && exec wget -q $wget_https -T 30 -O "$2" "$1") 2>/dev/null
    fi
  }
  # retry CMD… — 3 attempts, 1 s then 2 s apart.
  retry() {
    retry_n=1
    while :; do
      if "$@"; then return 0; fi
      if [ "$retry_n" -ge 3 ]; then return 1; fi
      sleep "$retry_n"
      retry_n=$((retry_n + 1))
    done
  }
  sha256_of() {
    if [ "$hasher" = sha256sum ]; then sum=$(sha256sum "$1"); else sum=$(shasum -a 256 "$1"); fi
    printf '%s\n' "${sum%% *}"
  }
  size_of() {
    size_out=$(wc -c <"$1")
    printf '%s\n' $size_out
  }
  matches() { [ -f "$1" ] && [ "$(size_of "$1")" = "$2" ] && [ "$(sha256_of "$1")" = "$3" ]; }
  read_pointer() {
    fetch "$TROPOS_CHANNELS/$1" "$tmp/pointer" 64 30 || return 1
    resolved=$(cat "$tmp/pointer")
    pointer_size=$(size_of "$tmp/pointer")
    if [ "$pointer_size" != "${#resolved}" ] && [ "$pointer_size" != "$((${#resolved} + 1))" ]; then return 1; fi
    is_version "$resolved"
  }

  version=
  from_latest_release=no
  case $target in
    stable | latest)
      if [ -n "${TROPOS_INSTALL_FROM:-}" ]; then fail 64 "TROPOS_INSTALL_FROM needs an explicit version"; fi
      if retry read_pointer "$target"; then version=$resolved
      elif sleep 4 && retry read_pointer "$target.bak"; then version=$resolved
      elif [ "$target" = latest ]; then from_latest_release=yes
      else fail 69 "cannot resolve the stable channel (no release may have been published yet); try again, or install an explicit version"
      fi
      ;;
    *) version=$target ;;
  esac
  if [ "$from_latest_release" = yes ]; then base_url="$TROPOS_RELEASES/latest/download"; else base_url="$TROPOS_RELEASES/download/v$version"; fi

  # get_asset NAME FILE MAX_BYTES MAX_SECONDS
  get_asset() {
    if [ -n "${TROPOS_INSTALL_FROM:-}" ]; then
      [ -f "$TROPOS_INSTALL_FROM/$1" ] || return 1
      cp "$TROPOS_INSTALL_FROM/$1" "$2"
    else
      retry fetch "$base_url/$1" "$2" "$3" "$4"
    fi
  }

  get_asset manifest.json "$tmp/manifest.json" 65536 30 || fail 69 "could not download the release manifest"
  get_asset manifest.json.sig "$tmp/manifest.json.sig" 4096 30 || fail 69 "could not download the manifest signature"
  printf '%s' "$TROPOS_ALLOWED_SIGNERS" >"$tmp/allowed_signers"
  if ! ssh-keygen -Y verify -f "$tmp/allowed_signers" -I tropos-release -n tropos-manifest -s "$tmp/manifest.json.sig" <"$tmp/manifest.json" >/dev/null 2>&1; then
    # The probe only picks the message; installation stops either way (spec §8.2 step 6, decision D3).
    case $(ssh-keygen -Y verify 2>&1 || true) in
      *"option -- Y"* | *"option -- 'Y'"* | *"unknown option"*) fail 65 "your ssh-keygen cannot verify signatures; install OpenSSH 8.1 or newer and run the installer again" ;;
    esac
    fail 65 "the release manifest's signature is not valid; nothing was installed"
  fi
  [ "$(tail -c 1 "$tmp/manifest.json" | od -An -c | tr -d ' ')" = '\n' ] || fail 65 "the release manifest is malformed"
  fields=$(awk -v want="$platform" "$MANIFEST_AWK" "$tmp/manifest.json") || fail 65 "the release manifest is malformed"
  m_version= m_sha= m_size= m_zsha= m_zsize=
  for field in $fields; do
    case $field in
      version=*) m_version=${field#version=} ;;
      sha256=*) m_sha=${field#sha256=} ;;
      size=*) m_size=${field#size=} ;;
      zst_sha256=*) m_zsha=${field#zst_sha256=} ;;
      zst_size=*) m_zsize=${field#zst_size=} ;;
    esac
  done
  if [ "$from_latest_release" = yes ]; then
    version=$m_version
    base_url="$TROPOS_RELEASES/download/v$version"
  fi
  [ "$m_version" = "$version" ] || fail 65 "the manifest is for version $m_version, not $version"

  bin="$tmp/tropos"
  asset="tropos-$platform"
  got=no
  if [ "$has_zstd" = yes ]; then
    if get_asset "$asset.zst" "$tmp/tropos.zst" "$m_zsize" 900 && matches "$tmp/tropos.zst" "$m_zsize" "$m_zsha"; then
      zst_blocks=$((m_size / 512 + 2))
      if (ulimit -f "$zst_blocks" && exec zstd -d -q -c -- "$tmp/tropos.zst" >"$bin") 2>/dev/null && matches "$bin" "$m_size" "$m_sha"; then got=yes; fi
    fi
    if [ "$got" = no ]; then
      rm -f "$bin" "$tmp/tropos.zst"
      say "The compressed download did not verify; downloading the uncompressed binary."
    fi
  fi
  if [ "$got" = no ]; then
    get_asset "$asset" "$bin" "$m_size" 900 || fail 69 "could not download $asset"
    matches "$bin" "$m_size" "$m_sha" || fail 65 "checksum mismatch: the downloaded binary does not match the signed manifest; nothing was installed"
  fi

  chmod 700 "$bin"
  say "Verified Tropos Code $version for $platform."
  set +e
  "$bin" install --self --manifest "$tmp/manifest.json" --signature "$tmp/manifest.json.sig"
  status=$?
  set -e
  if [ "$status" -ne 0 ]; then
    if [ "$status" -ge 128 ]; then
      if [ -t 0 ]; then stty sane 2>/dev/null || true; fi
      printf 'tropos install: the installer was stopped by a signal (exit %s)\n' "$status" >&2
    fi
    exit "$status"
  fi

  bindir="$HOME/.local/bin"
  case ":${PATH}:" in
    *":$bindir:"*) say "Run: tropos" ;;
    *)
      shell_name=$(basename "${SHELL:-sh}")
      case $shell_name in
        zsh) rc='~/.zshrc' ;;
        bash) rc='~/.bashrc' ;;
        fish) rc='~/.config/fish/config.fish' ;;
        *) rc='~/.profile' ;;
      esac
      say "Add $bindir to your PATH, for example with this line in $rc:"
      if [ "$shell_name" = fish ]; then say "  fish_add_path $bindir"; else say "  export PATH=\"$bindir:\$PATH\""; fi
      ;;
  esac
}

main "$@"
```

- [ ] **Step 5b: Embed the awk program**

```bash
bun -e 'const awk = await Bun.file("scripts/release/manifest.awk").text(); if (awk.includes("\x27")) throw new Error("manifest.awk must not contain single quotes"); const s = await Bun.file("install.sh").text(); const out = s.replace("  MANIFEST_AWK=\x27EMBEDDED-BY-STEP-5B\x27", () => `  MANIFEST_AWK=\x27${awk}\x27`); if (out === s) throw new Error("marker not found"); await Bun.write("install.sh", out);'
```

Expected: `grep -c EMBEDDED-BY-STEP-5B install.sh` prints `0`.

- [ ] **Step 6: Run to see them pass**

Run: `chmod +x install.sh && bun test test/install/install-sh.test.ts`
Expected: PASS under every shell listed in `SHELLS` on this machine.

- [ ] **Step 7: Commit**

```bash
git add install.sh scripts/install-local.sh package.json README.md test/install/helpers/sh-runner.ts test/install/install-sh.test.ts
git commit -m "feat(install): fail-closed POSIX install.sh with pinned-key signature verification

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 23: `install.sh` negative security suite

Spec: §13 layer 5 (every listed case), R3.1, R7.3, R8.2, Review Focus 2.

**Files:**
- Create: `test/install/install-sh-negative.test.ts`
- Modify: `.github/workflows/ci.yml` (shellcheck step, see Step 4)

**Interfaces:**
- Consumes: `makeSandbox`, `handoffBinary` (Task 22); fixtures (Tasks 9, 13); `makeTestKey`, `sshSign` (Task 5); `serializeManifest` (Task 6)

- [ ] **Step 1: Write the suite**

```ts
// test/install/install-sh-negative.test.ts
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { detectPlatform } from "../../src/install/platform";
import { makeTmpDir, removeDir } from "../helpers/tmp";
import { makeFixtureRelease, publishFixture } from "./helpers/fixture-release";
import { allowedSignersText, makeTestKey, sshSign, type TestKey } from "./helpers/keys";
import { startReleaseServer, type ReleaseServer } from "./helpers/release-server";
import { INSTALL_SH, handoffBinary, makeSandbox } from "./helpers/sh-runner";

let root: string;
let key: TestKey;
let other: TestKey;
let srv: ReleaseServer;
const platform = detectPlatform();
const asset = `tropos-${platform}`;

beforeAll(async () => {
  root = await makeTmpDir();
  [key, other] = await Promise.all([makeTestKey(root, "k"), makeTestKey(root, "other")]);
});
afterAll(() => removeDir(root));
beforeEach(async () => {
  srv?.stop();
  srv = startReleaseServer();
  publishFixture(srv, await makeFixtureRelease({ version: "1.0.0", key, dir: root, binary: handoffBinary() }));
});

const sandbox = (extra: Partial<Parameters<typeof makeSandbox>[0]> = {}) => makeSandbox({ signers: allowedSignersText(key), base: srv.base, ...extra });
const nothingInstalled = async (home: string) => expect(await Bun.file(join(home, "handoff")).exists()).toBe(false);

describe("signature and manifest (fail closed)", () => {
  test("tampered manifest", async () => {
    const r1 = await makeFixtureRelease({ version: "1.0.0", key, dir: root, binary: handoffBinary() });
    srv.put("v1.0.0", "manifest.json", new TextDecoder().decode(r1.verified.bytes).replace('"size": ', '"size":  '));
    const sb = await sandbox();
    const r = await sb.run(["1.0.0"]);
    expect(r.code).toBe(65);
    expect(r.stderr).toContain("signature is not valid");
    await nothingInstalled(sb.home);
  });

  test.each([
    ["an untrusted signer", async (bytes: Uint8Array) => sshSign(other, bytes, "tropos-manifest", root)],
    ["the installer namespace", async (bytes: Uint8Array) => sshSign(key, bytes, "tropos-installer", root)],
    ["garbage", async () => "-----BEGIN SSH SIGNATURE-----\nAAAA\n-----END SSH SIGNATURE-----\n"],
  ])("signature from %s", async (_n, sign) => {
    const r1 = await makeFixtureRelease({ version: "1.0.0", key, dir: root, binary: handoffBinary() });
    srv.put("v1.0.0", "manifest.json.sig", await sign(r1.verified.bytes));
    const sb = await sandbox();
    expect((await sb.run(["1.0.0"])).code).toBe(65);
    await nothingInstalled(sb.home);
  });

  test("an empty pinned key set rejects a valid signature (A5)", async () => {
    const sb = await makeSandbox({ signers: "# no keys yet\n", base: srv.base });
    expect((await sb.run(["1.0.0"])).code).toBe(65);
  });

  test("a validly signed manifest for another version", async () => {
    const r2 = await makeFixtureRelease({ version: "2.0.0", key, dir: root, binary: handoffBinary() });
    srv.put("v1.0.0", "manifest.json", r2.verified.bytes);
    srv.put("v1.0.0", "manifest.json.sig", r2.verified.signature);
    const r = await (await sandbox()).run(["1.0.0"]);
    expect(r.code).toBe(65);
    expect(r.stderr).toContain("the manifest is for version 2.0.0, not 1.0.0");
  });

  test("a validly signed but non-canonical manifest", async () => {
    const r1 = await makeFixtureRelease({ version: "1.0.0", key, dir: root, binary: handoffBinary() });
    const text = new TextDecoder().decode(r1.verified.bytes).replace('  "version": "1.0.0",\n', '  "version": "1.0.0",\n  "version": "1.0.0",\n');
    srv.put("v1.0.0", "manifest.json", text);
    srv.put("v1.0.0", "manifest.json.sig", await sshSign(key, text, "tropos-manifest", root));
    expect((await (await sandbox()).run(["1.0.0"])).stderr).toContain("the release manifest is malformed");
  });
});

describe("binary integrity", () => {
  test.each([
    ["short", (b: Uint8Array) => b.subarray(0, b.length - 1)],
    ["extra bytes", (b: Uint8Array) => Buffer.concat([b, Buffer.from("x")])],
  ])("raw binary %s → checksum mismatch", async (_n, mangle) => {
    const r1 = await makeFixtureRelease({ version: "1.0.0", key, dir: root, binary: handoffBinary() });
    srv.put("v1.0.0", asset, mangle(r1.binary));
    srv.put("v1.0.0", `${asset}.zst`, "junk");
    const sb = await sandbox();
    const r = await sb.run(["1.0.0"]);
    expect(r.code).toBe(65);
    expect(r.stderr).toContain("checksum mismatch");
    await nothingInstalled(sb.home);
  });

  test("corrupt .zst falls back to the raw binary", async () => {
    srv.put("v1.0.0", `${asset}.zst`, "junk");
    const r = await (await sandbox()).run(["1.0.0"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("downloading the uncompressed binary");
  });

  test("an asset larger than the manifest says is cut off by the file-size limit (R8.2)", async () => {
    const r1 = await makeFixtureRelease({ version: "1.0.0", key, dir: root, binary: handoffBinary() });
    srv.put("v1.0.0", asset, Buffer.concat([r1.binary, new Uint8Array(8 * 1024 * 1024)]));
    srv.put("v1.0.0", `${asset}.zst`, "junk");
    const r = await (await sandbox()).run(["1.0.0"]);
    expect(r.code).not.toBe(0);
  });
});

describe("network and channels", () => {
  test("an HTML pointer counts as missing; the .bak slot is used", async () => {
    srv.put("channels", "latest", "<html>Not Found</html>");
    srv.put("channels", "latest.bak", "1.0.0\n");
    expect((await (await sandbox()).run()).code).toBe(0);
  });

  test("500 then success", async () => {
    srv.put("channels", "latest", "1.0.0\n");
    srv.failNext("channels", "latest", 500, 2);
    expect((await (await sandbox()).run()).code).toBe(0);
  });

  test("server down → 69", async () => {
    srv.stop();
    expect((await (await sandbox()).run(["1.0.0"])).code).toBe(69);
  });

  test("stable with both slots missing fails clearly (R7.3)", async () => {
    srv.setLatest("v1.0.0");
    const r = await (await sandbox()).run(["stable"]);
    expect(r.code).toBe(69);
    expect(r.stderr).toContain("no release may have been published yet");
  });
});

describe("dependencies and platform", () => {
  test("no ssh-keygen → fail before downloading anything", async () => {
    const r = await (await sandbox({ hide: ["ssh-keygen"] })).run(["1.0.0"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("ssh-keygen (OpenSSH 8.1 or newer) is required");
    expect(srv.requests).toEqual([]);
  });

  test("an ssh-keygen without -Y → 65 with the upgrade message", async () => {
    const r = await (await sandbox({ shims: { "ssh-keygen": "#!/bin/sh\necho 'ssh-keygen: unknown option -- Y' >&2\nexit 1\n" } })).run(["1.0.0"]);
    expect(r.code).toBe(65);
    expect(r.stderr).toContain("install OpenSSH 8.1 or newer");
  });

  test("no curl and no wget", async () => {
    expect((await (await sandbox({ hide: ["curl", "wget"] })).run(["1.0.0"])).stderr).toContain("curl or wget is required");
  });

  test("no hash tool", async () => {
    expect((await (await sandbox({ hide: ["sha256sum", "shasum", "perl"] })).run(["1.0.0"])).stderr).toContain("sha256sum or shasum is required");
  });

  test.each([
    ["FreeBSD", "amd64", "unsupported operating system: FreeBSD"],
    ["MINGW64_NT-10.0", "x86_64", "unsupported operating system: MINGW64_NT-10.0"],
    ["Linux", "i686", "unsupported CPU architecture: i686"],
  ])("uname %s %s", async (os, machine, message) => {
    const uname = `#!/bin/sh\ncase "$1" in -s) echo ${os} ;; -m) echo ${machine} ;; esac\n`;
    const r = await (await sandbox({ shims: { uname } })).run(["1.0.0"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(message);
  });

  test("refuses sudo from a user shell unless allowed", async () => {
    const sb = await sandbox({ shims: { id: "#!/bin/sh\necho 0\n" } });
    const refused = await sb.run(["1.0.0"], { env: { SUDO_USER: "alice" } });
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("do not run this installer with sudo");
    expect((await sb.run(["1.0.0"], { env: { SUDO_USER: "alice", TROPOS_INSTALL_ALLOW_SUDO: "1" } })).code).toBe(0);
  });

  test.each([[["1.2"]], [["1.0.0", "extra"]], [["../1.0.0"]], [["nightly"]]])("usage error for %j", async (args) => {
    expect((await (await sandbox()).run(args)).code).toBe(64);
  });

  test("the binary's exit code is passed through; a signal death is explained", async () => {
    const sb = await sandbox();
    expect((await sb.run(["1.0.0"], { env: { FAKE_EXIT: "73" } })).code).toBe(73);
    const killed = await sb.run(["1.0.0"], { env: { FAKE_SIGNAL: "1" } });
    expect(killed.code).toBe(137);
    expect(killed.stderr).toContain("stopped by a signal (exit 137)");
  });

  test("the temporary folder is removed on every exit", async () => {
    const sb = await sandbox();
    await Bun.$`mkdir -p ${join(sb.dir, "t")}`;
    await sb.run(["1.0.0"], { env: { TMPDIR: join(sb.dir, "t") } });
    await sb.run(["9.9.9"], { env: { TMPDIR: join(sb.dir, "t") } });
    expect(await readdir(join(sb.dir, "t"))).toEqual([]);
  });
});

describe("truncated downloads of install.sh itself", () => {
  test("every 64-byte prefix runs nothing and creates nothing", async () => {
    const full = await readFile(INSTALL_SH);
    const dir = await makeTmpDir();
    try {
      // Stop before the final `main "$@"` line: only a complete download may run anything.
      const last = full.lastIndexOf('main "$@"');
      expect(last).toBeGreaterThan(0);
      for (let n = 64; n < last; n += 64) {
        const home = join(dir, `h${n}`);
        await Bun.$`mkdir -p ${home}`;
        const proc = Bun.spawn(["sh"], { stdin: new Blob([full.subarray(0, n)]), env: { PATH: "/usr/bin:/bin", HOME: home }, stdout: "pipe", stderr: "pipe", cwd: home });
        await proc.exited;
        expect(await readdir(home)).toEqual([]);
      }
    } finally {
      await removeDir(dir);
    }
  }, 120_000);
});

describe("shellcheck", () => {
  test.skipIf(!Bun.which("shellcheck"))("install.sh is clean under shellcheck -s sh", async () => {
    const r = await Bun.$`shellcheck -s sh ${INSTALL_SH}`.quiet().nothrow();
    expect(r.stdout.toString() + r.stderr.toString()).toBe("");
    expect(r.exitCode).toBe(0);
  });
});
```

- [ ] **Step 2: Run the suite**

Run: `bun test test/install/install-sh-negative.test.ts`
Expected: PASS. Fix `install.sh` (not the tests) for any failure. The truncation test catches any statement placed outside `main()`.

- [ ] **Step 3: Fix shellcheck findings**

Run: `shellcheck -s sh install.sh` (install with `brew install shellcheck` / `apt install shellcheck`).
Expected: no findings. Where a finding is intentional — `$wget_https` is unquoted on purpose so an empty value adds no argument; the `rc='~/.zshrc'` strings are display text — add a `# shellcheck disable=SC2086` or `SC2088` comment on that line with the reason, nothing broader.

- [ ] **Step 4: Make shellcheck mandatory in CI**

In `.github/workflows/ci.yml` job `test`, add after the ripgrep step:

```yaml
      - name: Install shellcheck
        run: |
          if [ "$RUNNER_OS" = "macOS" ]; then brew install shellcheck; else sudo apt-get install -y shellcheck; fi
      - run: shellcheck -s sh install.sh scripts/release/make-manifest.sh
```

- [ ] **Step 5: Commit**

```bash
git add test/install/install-sh-negative.test.ts install.sh .github/workflows/ci.yml
git commit -m "test(install): install.sh negative suite — signatures, integrity, network, shells, truncation

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 24: TypeScript ↔ shell parity and key rotation

Spec: §13 layers 7 and 9, R8.1 (shared zstd corpus through `install.sh`), the three-place key rule (§4.2), key rotation (§6.1).

**Files:**
- Create: `test/install/parity.test.ts`
- Create: `test/install/key-rotation.test.ts`

**Interfaces:**
- Consumes: `blockOf`, `makeSandbox`, `handoffBinary` (Task 22); `zstdCorpus` (Task 8); `platformFromProbe` (Task 4); `ALLOWED_SIGNERS_TEXT` (Task 5); fixtures

- [ ] **Step 1: Write the parity tests**

```ts
// test/install/parity.test.ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { platformFromProbe } from "../../src/install/platform";
import { ALLOWED_SIGNERS_TEXT } from "../../src/install/trust";
import { makeTmpDir, removeDir } from "../helpers/tmp";
import { makeFixtureRelease, publishFixture } from "./helpers/fixture-release";
import { allowedSignersText, makeTestKey, type TestKey } from "./helpers/keys";
import { startReleaseServer, type ReleaseServer } from "./helpers/release-server";
import { INSTALL_SH, blockOf, handoffBinary, makeSandbox } from "./helpers/sh-runner";
import { zstdCorpus } from "./helpers/zstd-corpus";

let root: string;
let key: TestKey;
let srv: ReleaseServer;
beforeAll(async () => {
  root = await makeTmpDir();
  key = await makeTestKey(root, "k");
  srv = startReleaseServer();
});
afterAll(async () => {
  srv.stop();
  await removeDir(root);
});

describe("one pinned key, one grammar (spec §4.2, §13 layer 7)", () => {
  test("install.sh embeds release/allowed_signers verbatim, which trust.ts compiles in", async () => {
    const script = await readFile(INSTALL_SH, "utf8");
    const file = await readFile(join(import.meta.dir, "../../release/allowed_signers"), "utf8");
    expect(blockOf(script, "pinned-key").trim()).toBe(`TROPOS_ALLOWED_SIGNERS='${file}'`);
    expect(ALLOWED_SIGNERS_TEXT).toBe(file);
    expect(file.includes("'")).toBe(false);
  });

  test("install.sh embeds scripts/release/manifest.awk verbatim", async () => {
    const script = await readFile(INSTALL_SH, "utf8");
    const awk = await readFile(join(import.meta.dir, "../../scripts/release/manifest.awk"), "utf8");
    expect(blockOf(script, "manifest-awk").trim()).toBe(`MANIFEST_AWK='${awk}'`);
    expect(awk.includes("'")).toBe(false);
  });

  test("production URLs and protocol", async () => {
    const block = blockOf(await readFile(INSTALL_SH, "utf8"), "release-urls");
    expect(block).toContain("TROPOS_RELEASES='https://github.com/Tropos-AI/tropos-code/releases'");
    expect(block).toContain("TROPOS_PROTO='=https'");
  });
});

const muslHost = existsSync("/lib") && readdirSync("/lib").some((f) => /^ld-musl-.+\.so\.1$/.test(f));

describe("platform detection agrees with platform.ts", () => {
  const cases: Array<{ os: string; machine: string; rosetta?: boolean; musl?: boolean }> = [
    { os: "Darwin", machine: "arm64" },
    { os: "Darwin", machine: "x86_64" },
    { os: "Darwin", machine: "x86_64", rosetta: true },
    { os: "Linux", machine: "x86_64" },
    { os: "Linux", machine: "aarch64" },
    { os: "Linux", machine: "x86_64", musl: true },
    { os: "Linux", machine: "aarch64", musl: true },
  ];
  for (const c of cases) {
    const expected = platformFromProbe({ rosetta: false, musl: false, ...c });
    test.skipIf(!c.musl && c.os === "Linux" && muslHost)(`${JSON.stringify(c)} → ${expected}`, async () => {
      publishFixture(srv, await makeFixtureRelease({ version: "1.0.0", key, dir: root, binary: handoffBinary() }));
      const shims = {
        uname: `#!/bin/sh\ncase "$1" in -s) echo ${c.os} ;; -m) echo ${c.machine} ;; esac\n`,
        sysctl: `#!/bin/sh\necho ${c.rosetta ? 1 : 0}\n`,
        ldd: `#!/bin/sh\necho "${c.musl ? "musl libc" : "GNU C Library"}"\n`,
      };
      const sb = await makeSandbox({ signers: allowedSignersText(key), base: srv.base, shims, hide: ["zstd"] });
      const before = srv.requests.length;
      await sb.run(["1.0.0"]);
      expect(srv.requests.slice(before)).toContain(`/t/r/releases/download/v1.0.0/tropos-${expected}`);
    });
  }
});

describe("zstd corpus through install.sh (R8.1)", () => {
  // The manifest promises `c.promised` for the raw binary and the corpus file's own hash for the .zst,
  // so every .zst downloads cleanly and only decompression can reject it; the raw asset (= c.promised)
  // is always an honest fallback, so every case must install — the valid one without falling back.
  const raw = new TextEncoder().encode(handoffBinary("3.0.0"));
  for (const c of zstdCorpus(raw)) {
    test.skipIf(!Bun.which("zstd"))(`${c.valid ? "accepts" : "rejects"} ${c.name}`, async () => {
      publishFixture(srv, await makeFixtureRelease({ version: "3.0.0", key, dir: root, binary: c.promised, zst: c.zst }));
      const sb = await makeSandbox({ signers: allowedSignersText(key), base: srv.base });
      const out = await sb.run(["3.0.0"]);
      expect(out.code).toBe(0);
      expect(out.stdout.includes("downloading the uncompressed binary")).toBe(!c.valid);
      expect(await Bun.file(join(sb.home, "handoff")).exists()).toBe(true);
    });
  }
});
```

- [ ] **Step 2: Run the parity tests**

Run: `bun test test/install/parity.test.ts`
Expected: PASS.

- [ ] **Step 2b: Write and run the key-rotation suite (layer 9)**

```ts
// test/install/key-rotation.test.ts
// Spec §6.1: phase 1 trusts {K1, K2} while signing with K1; phase 2 signs with K2; clients that trust only K1
// must refuse K2 releases with the reinstall hint; a third key is never accepted. The old-installer gate
// (release.yml smoke-public b) is exactly "an install.sh that trusts only K1 fails on a K2 release".
import { afterEach, describe, expect, test } from "bun:test";
import { InstallError } from "../../src/install/errors";
import { installTarget } from "../../src/install/installer";
import { makeEngineFixture, type EngineFixture } from "./helpers/engine";
import { makeFixtureRelease, publishFixture } from "./helpers/fixture-release";
import { allowedSignersText, makeTestKey } from "./helpers/keys";
import { handoffBinary, makeSandbox } from "./helpers/sh-runner";

let f: EngineFixture;
afterEach(() => f?.close());

describe("key rotation K1 → K2 (spec §6.1, layer 9)", () => {
  test("tropos: K1-only clients refuse K2 releases with the reinstall hint; phase-1 clients accept both; K3 never", async () => {
    f = await makeEngineFixture(); // f.key is K1
    const k2 = await makeTestKey(f.root, "k2");
    const k3 = await makeTestKey(f.root, "k3");
    await f.release("1.0.0");
    await installTarget(f.deps, "1.0.0", false);
    publishFixture(f.srv, await makeFixtureRelease({ version: "2.0.0", key: k2, dir: f.root }));
    const refused = (await installTarget(f.deps, "2.0.0", false).catch((e) => e)) as InstallError;
    expect(refused.kind).toBe("integrity");
    expect(refused.message).toContain("reinstall with install.sh");
    const phase1 = { ...f.deps, trusted: [...f.key.trusted, ...k2.trusted] };
    expect((await installTarget(phase1, "2.0.0", false)).value.version).toBe("2.0.0");
    expect((await installTarget(phase1, "1.0.0", false)).value.version).toBe("1.0.0"); // K1 releases still verify
    publishFixture(f.srv, await makeFixtureRelease({ version: "3.0.0", key: k3, dir: f.root }));
    expect(((await installTarget(phase1, "3.0.0", false).catch((e) => e)) as InstallError).kind).toBe("integrity");
  });

  test("install.sh: the published-installer gate fails a K2 release when the installer trusts only K1", async () => {
    f = await makeEngineFixture();
    const k2 = await makeTestKey(f.root, "k2");
    const k3 = await makeTestKey(f.root, "k3");
    publishFixture(f.srv, await makeFixtureRelease({ version: "2.0.0", key: k2, dir: f.root, binary: handoffBinary("2.0.0") }));
    const k1Only = await makeSandbox({ signers: allowedSignersText(f.key), base: f.srv.base });
    expect((await k1Only.run(["2.0.0"])).code).toBe(65);
    const phase1 = await makeSandbox({ signers: allowedSignersText(f.key, k2), base: f.srv.base });
    expect((await phase1.run(["2.0.0"])).code).toBe(0);
    publishFixture(f.srv, await makeFixtureRelease({ version: "3.0.0", key: k3, dir: f.root, binary: handoffBinary("3.0.0") }));
    expect((await phase1.run(["3.0.0"])).code).toBe(65);
  });
});
```

Run: `bun test test/install/key-rotation.test.ts`
Expected: PASS.

- [ ] **Step 3: Milestone gate**

Run: `bun run typecheck && bun test && bun run test:coverage`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add test/install/parity.test.ts test/install/key-rotation.test.ts
git commit -m "test(install): TS/sh parity (key, grammar, platform, zstd) and K1→K2 key rotation

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## M6 — Release pipeline

### Task 25: Musl build targets and release-input collection

Spec: §5.1, §7.2 steps 2 and 4, amendment A4 (`SHA256SUMS`).

**Files:**
- Create: `scripts/release/targets.ts`, `scripts/release/targets.test.ts`
- Modify: `build.ts` (use `RELEASE_TARGETS`)
- Create: `scripts/release/collect-assets.sh`, `test/install/collect-assets.test.ts`

**Interfaces:**
- Consumes: `PLATFORMS`, `Platform` (Task 4)
- Produces: `RELEASE_TARGETS: Record<Platform, Bun.Build.CompileTarget>`; `collect-assets.sh <dist-dir> <version> <out-dir>` → `<out>/tropos-<platform>` ×6, `<out>/install.sh`, `<out>/SHA256SUMS` (`sha256sum` format, sorted by name)

- [ ] **Step 1: Write the failing tests**

```ts
// scripts/release/targets.test.ts
import { describe, expect, test } from "bun:test";
import { PLATFORMS } from "../../src/install/platform";
import { RELEASE_TARGETS } from "./targets";

describe("release targets", () => {
  test("one Bun target per release platform, including both musl targets", () => {
    expect(Object.keys(RELEASE_TARGETS)).toEqual([...PLATFORMS]);
    expect(RELEASE_TARGETS["linux-x64-musl"]).toBe("bun-linux-x64-musl");
    expect(RELEASE_TARGETS["linux-arm64-musl"]).toBe("bun-linux-arm64-musl");
  });
});
```

```ts
// test/install/collect-assets.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PLATFORMS } from "../../src/install/platform";
import { makeTmpDir, removeDir } from "../helpers/tmp";

const SCRIPT = join(import.meta.dir, "../../scripts/release/collect-assets.sh");
let dir: string;
beforeEach(async () => {
  dir = await makeTmpDir();
  await mkdir(join(dir, "dist"));
  for (const p of PLATFORMS) await writeFile(join(dir, "dist", `tropos-1.2.3-${p}`), `bin ${p}`);
  await writeFile(join(dir, "install.sh"), "#!/bin/sh\n");
});
afterEach(() => removeDir(dir));

describe("collect-assets.sh", () => {
  test("renames to release asset names and writes SHA256SUMS", async () => {
    await Bun.$`sh ${SCRIPT} ${join(dir, "dist")} 1.2.3 ${join(dir, "out")}`.cwd(dir).quiet();
    const names = (await readdir(join(dir, "out"))).sort();
    expect(names).toEqual(["SHA256SUMS", "install.sh", ...PLATFORMS.map((p) => `tropos-${p}`)].sort());
    const sums = await readFile(join(dir, "out", "SHA256SUMS"), "utf8");
    expect(sums.trim().split("\n").length).toBe(7);
    await Bun.$`sha256sum -c SHA256SUMS || shasum -a 256 -c SHA256SUMS`.cwd(join(dir, "out")).quiet();
  });

  test("fails when a platform binary is missing", async () => {
    await Bun.$`rm ${join(dir, "dist", "tropos-1.2.3-linux-arm64-musl")}`;
    const r = await Bun.$`sh ${SCRIPT} ${join(dir, "dist")} 1.2.3 ${join(dir, "out")}`.cwd(dir).quiet().nothrow();
    expect(r.exitCode).toBe(1);
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `bun test scripts/release/targets.test.ts test/install/collect-assets.test.ts`
Expected: FAIL — files missing.

- [ ] **Step 3: Implement**

```ts
// scripts/release/targets.ts
import type { Platform } from "../../src/install/platform";

/** Release platform → Bun compile target (spec §5.1). Order matches PLATFORMS. */
export const RELEASE_TARGETS: Record<Platform, Bun.Build.CompileTarget> = {
  "darwin-arm64": "bun-darwin-arm64",
  "darwin-x64": "bun-darwin-x64",
  "linux-x64": "bun-linux-x64",
  "linux-arm64": "bun-linux-arm64",
  "linux-x64-musl": "bun-linux-x64-musl",
  "linux-arm64-musl": "bun-linux-arm64-musl",
};
```

In `build.ts` replace `const TARGETS: Bun.Build.CompileTarget[] = [ … ];` with:

```ts
import { RELEASE_TARGETS } from "./scripts/release/targets";

const TARGETS: Bun.Build.CompileTarget[] = Object.values(RELEASE_TARGETS);
```

(`--all` output names stay `dist/tropos-<version>-<target without "bun-">`, now including `linux-x64-musl` and `linux-arm64-musl`.)

```sh
#!/bin/sh
# scripts/release/collect-assets.sh <dist-dir> <version> <out-dir>
# Gathers the six release binaries under their asset names plus install.sh, and writes SHA256SUMS
# (checked by the privileged workflow before anything is signed — amendment A4).
set -eu
[ $# -eq 3 ] || { echo "usage: collect-assets.sh <dist-dir> <version> <out-dir>" >&2; exit 64; }
dist=$1 version=$2 out=$3
mkdir -p "$out"
for p in darwin-arm64 darwin-x64 linux-x64 linux-arm64 linux-x64-musl linux-arm64-musl; do
  src="$dist/tropos-$version-$p"
  [ -f "$src" ] || { echo "collect-assets: missing $src" >&2; exit 1; }
  cp "$src" "$out/tropos-$p"
done
cp install.sh "$out/install.sh"
cd "$out"
if command -v sha256sum >/dev/null 2>&1; then
  sha256sum install.sh tropos-* | sort -k 2 >SHA256SUMS
else
  shasum -a 256 install.sh tropos-* | sort -k 2 >SHA256SUMS
fi
```

- [ ] **Step 4: Run to see them pass, and build every target once**

Run: `bun test scripts/release/targets.test.ts test/install/collect-assets.test.ts && bun run build:all && ls dist`
Expected: PASS; `dist/` lists six `tropos-0.1.0-*` binaries including both `-musl` ones.

- [ ] **Step 5: Commit**

```bash
git add scripts/release/targets.ts scripts/release/targets.test.ts build.ts scripts/release/collect-assets.sh test/install/collect-assets.test.ts
git commit -m "build: add both musl targets and collect release inputs with SHA256SUMS

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 26: Convergent promotion (`promote.ts`)

Spec: §7.4–7.6, R2.x, R3.x, R7.1–R7.2, decision D1 (channels repository and verification records), D6 (read-back budget).

**Files:**
- Create: `scripts/release/github.ts` (the `gh`-backed client)
- Create: `scripts/release/promote.ts`
- Create: `scripts/release/promote.test.ts` (with an in-memory GitHub)

**Interfaces:**
- Consumes: `compareVersions`, `isVersion` (Task 3)
- Produces: `interface ReleaseInfo { tag: string; draft: boolean; prerelease: boolean; assets: string[] }`, `interface GitHubClient { getRelease(tag): Promise<ReleaseInfo | null>; createChannelsRelease(): Promise<void>; readAsset(tag, name): Promise<Uint8Array | null>; uploadAsset(tag, name, data): Promise<void>; latestReleaseTag(): Promise<string | null>; markLatest(tag): Promise<void> }`, `ghClient(repo): GitHubClient`
- Produces: `interface VerifiedRecord { version: string; commit: string; runId: string; verifiedAt: string }`, `interface VerificationRecords { read(version): Promise<VerifiedRecord | null>; write(version, record): Promise<void> }`, `recordsOnVersionRelease(main)` (D1-A: `verified.json` on `v<x>`), `recordsOnChannelsRelease(channels)` (D1-B: `verified-<x>.json` on `channels`), `interface PromoteDeps { main; channels; records; verifyManifest(bytes, signature): Promise<{ version: string; commit: string } | null>; sleep; now; runId; log }`, `promoteLatest(deps, x)`, `promoteStable(deps, x)`, `checkChannels(deps, repair): Promise<{ ok: boolean; problems: string[]; repaired: string[] }>`, `previousRelease(deps): Promise<{ installerTag: string | null; stable: string | null }>`

- [ ] **Step 1: Write the failing tests**

```ts
// scripts/release/promote.test.ts
import { beforeEach, describe, expect, test } from "bun:test";
import { checkChannels, previousRelease, promoteLatest, promoteStable, recordsOnVersionRelease, type GitHubClient, type PromoteDeps, type ReleaseInfo } from "./promote";

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array | null) => (b ? new TextDecoder().decode(b) : null);

/** In-memory GitHub with --clobber semantics (delete, then upload) and fault injection. */
class FakeGitHub implements GitHubClient {
  releases = new Map<string, { draft: boolean; prerelease: boolean; assets: Map<string, Uint8Array> }>();
  latest: string | null = null;
  failUpload: (tag: string, name: string) => boolean = () => false;
  failMarkLatest = false;
  observe: () => void = () => {};
  /** Awaited at the start of every call; R7.2 makes it random to vary the interleaving. */
  delay: () => Promise<void> = async () => {};
  async getRelease(tag: string): Promise<ReleaseInfo | null> {
    await this.delay();
    const r = this.releases.get(tag);
    return r ? { tag, draft: r.draft, prerelease: r.prerelease, assets: [...r.assets.keys()] } : null;
  }
  async createChannelsRelease() {
    this.releases.set("channels", { draft: false, prerelease: true, assets: new Map() });
  }
  async readAsset(tag: string, name: string) {
    await this.delay();
    return this.releases.get(tag)?.assets.get(name) ?? null;
  }
  async uploadAsset(tag: string, name: string, data: Uint8Array) {
    await this.delay();
    const r = this.releases.get(tag)!;
    r.assets.delete(name);
    this.observe();
    if (this.failUpload(tag, name)) throw new Error(`upload of ${name} failed`);
    r.assets.set(name, data);
    this.observe();
  }
  async latestReleaseTag() {
    await this.delay();
    return this.latest;
  }
  async markLatest(tag: string) {
    await this.delay();
    if (this.failMarkLatest) throw new Error("mark latest failed");
    this.latest = tag;
    this.observe();
  }
  publish(version: string, opts: { goodSignature?: boolean } = {}) {
    const assets = new Map<string, Uint8Array>([
      ["manifest.json", enc(JSON.stringify({ version, commit: "c".repeat(40) }))],
      ["manifest.json.sig", enc(opts.goodSignature === false ? "bad" : `sig:${version}`)],
    ]);
    this.releases.set(`v${version}`, { draft: false, prerelease: false, assets });
  }
  slot(name: string) {
    return dec(this.releases.get("channels")?.assets.get(name) ?? null)?.trim() ?? null;
  }
}

let gh: FakeGitHub;
let deps: PromoteDeps;
beforeEach(() => {
  gh = new FakeGitHub();
  deps = {
    main: gh,
    channels: gh,
    records: recordsOnVersionRelease(gh),
    verifyManifest: async (bytes, sig) => {
      const m = JSON.parse(new TextDecoder().decode(bytes)) as { version: string; commit: string };
      return sig === `sig:${m.version}` ? m : null;
    },
    sleep: async () => {},
    now: () => new Date("2026-10-13T12:00:00Z"),
    runId: "42",
    log: () => {},
  };
});

const endState = () => ({ latest: gh.slot("latest"), latestBak: gh.slot("latest.bak"), stable: gh.slot("stable"), stableBak: gh.slot("stable.bak"), gh: gh.latest });

describe("first release (R7.1)", () => {
  test("creates the channels release and every slot, then marks GitHub latest", async () => {
    gh.publish("1.0.0");
    await promoteLatest(deps, "1.0.0");
    expect(gh.releases.get("channels")).toMatchObject({ draft: false, prerelease: true });
    expect(endState()).toEqual({ latest: "1.0.0", latestBak: "1.0.0", stable: "1.0.0", stableBak: "1.0.0", gh: "v1.0.0" });
    expect(JSON.parse(dec(await gh.readAsset("v1.0.0", "verified.json"))!)).toEqual({ version: "1.0.0", commit: "c".repeat(40), runId: "42", verifiedAt: "2026-10-13T12:00:00.000Z" });
    expect(await previousRelease(deps)).toEqual({ installerTag: "v1.0.0", stable: "1.0.0" });
  });

  test("before any promotion there is no previous release (smoke b/c are skipped)", async () => {
    expect(await previousRelease(deps)).toEqual({ installerTag: null, stable: null });
  });
});

describe("resuming an interrupted promotion (R2.1)", () => {
  const faults: Array<[string, () => void, () => void]> = [
    ["upload of latest.bak", () => (gh.failUpload = (_t, n) => n === "latest.bak"), () => (gh.failUpload = () => false)],
    ["upload of latest", () => (gh.failUpload = (_t, n) => n === "latest"), () => (gh.failUpload = () => false)],
    ["upload of stable (first release)", () => (gh.failUpload = (_t, n) => n === "stable"), () => (gh.failUpload = () => false)],
    ["mark latest (latest == x, GitHub latest unset)", () => (gh.failMarkLatest = true), () => (gh.failMarkLatest = false)],
  ];
  for (const [name, inject, clear] of faults) {
    test(name, async () => {
      gh.publish("1.0.0");
      inject();
      await expect(promoteLatest(deps, "1.0.0")).rejects.toThrow();
      clear();
      await promoteLatest(deps, "1.0.0");
      expect(endState()).toEqual({ latest: "1.0.0", latestBak: "1.0.0", stable: "1.0.0", stableBak: "1.0.0", gh: "v1.0.0" });
    });
  }

  test("a second run after success changes nothing", async () => {
    gh.publish("1.0.0");
    await promoteLatest(deps, "1.0.0");
    let uploads = 0;
    gh.observe = () => void uploads++;
    await promoteLatest(deps, "1.0.0");
    expect(uploads).toBe(0);
  });
});

describe("safety rules", () => {
  test("latest never moves backwards", async () => {
    gh.publish("1.0.0");
    gh.publish("2.0.0");
    await promoteLatest(deps, "2.0.0");
    await expect(promoteLatest(deps, "1.0.0")).rejects.toThrow("would move latest backwards");
  });

  test("a slot changed by someone else is never overwritten (R2.2)", async () => {
    gh.publish("1.0.0");
    gh.publish("1.1.0");
    await promoteLatest(deps, "1.0.0");
    let reads = 0;
    deps.channels = {
      getRelease: (tag) => gh.getRelease(tag),
      createChannelsRelease: () => gh.createChannelsRelease(),
      uploadAsset: (tag, name, data) => gh.uploadAsset(tag, name, data),
      latestReleaseTag: () => gh.latestReleaseTag(),
      markLatest: (tag) => gh.markLatest(tag),
      // Someone else rewrites latest.bak between our first read and our write.
      readAsset: async (tag, name) => {
        if (name === "latest.bak" && ++reads === 2) gh.releases.get("channels")!.assets.set("latest.bak", enc("9.9.9\n"));
        return gh.readAsset(tag, name);
      },
    };
    await expect(promoteLatest(deps, "1.1.0")).rejects.toThrow("changed from 1.0.0 to 9.9.9 while promoting");
  });

  test("a release with a bad signature is refused", async () => {
    gh.publish("1.0.0", { goodSignature: false });
    await expect(promoteLatest(deps, "1.0.0")).rejects.toThrow("manifest signature");
  });

  test("a draft is refused", async () => {
    gh.publish("1.0.0");
    gh.releases.get("v1.0.0")!.draft = true;
    await expect(promoteLatest(deps, "1.0.0")).rejects.toThrow("is not published");
  });
});

describe("stable (spec §7.4, R3.1–R3.2)", () => {
  beforeEach(async () => {
    gh.publish("1.0.0");
    gh.publish("1.1.0");
    gh.publish("1.2.0");
    await promoteLatest(deps, "1.0.0");
    await promoteLatest(deps, "1.2.0");
  });

  test("moves to a verified version not ahead of latest", async () => {
    await promoteLatest(deps, "1.2.0");
    await expect(promoteStable(deps, "1.1.0")).rejects.toThrow("has no verification record");
    await promoteStable(deps, "1.2.0");
    expect([gh.slot("stable"), gh.slot("stable.bak")]).toEqual(["1.2.0", "1.2.0"]);
  });

  test("never ahead of latest, never backwards", async () => {
    gh.publish("3.0.0");
    await recordsOnVersionRelease(gh).write("3.0.0", { version: "3.0.0", commit: "c".repeat(40), runId: "1", verifiedAt: "x" });
    await expect(promoteStable(deps, "3.0.0")).rejects.toThrow("cannot run ahead of latest");
    await promoteStable(deps, "1.2.0");
    await expect(promoteStable(deps, "1.0.0")).rejects.toThrow("would move stable backwards");
  });

  test("a failed upload of stable leaves stable.bak verified; repair restores stable (R3.1)", async () => {
    gh.failUpload = (_t, n) => n === "stable";
    await expect(promoteStable(deps, "1.2.0")).rejects.toThrow();
    gh.failUpload = () => false;
    expect([gh.slot("stable"), gh.slot("stable.bak")]).toEqual([null, "1.2.0"]);
    const report = await checkChannels(deps, true);
    expect(report.repaired).toContain("stable := 1.2.0");
    expect([gh.slot("stable"), gh.slot("stable.bak")]).toEqual(["1.2.0", "1.2.0"]);
  });

  test("a failed upload of stable.bak leaves stable untouched and verified (R3.2)", async () => {
    gh.failUpload = (_t, n) => n === "stable.bak";
    await expect(promoteStable(deps, "1.2.0")).rejects.toThrow();
    gh.failUpload = () => false;
    expect(gh.slot("stable")).toBe("1.0.0");
    await promoteStable(deps, "1.2.0");
    expect([gh.slot("stable"), gh.slot("stable.bak")]).toEqual(["1.2.0", "1.2.0"]);
  });
});

describe("checkChannels (R3.3)", () => {
  test("healthy", async () => {
    gh.publish("1.0.0");
    await promoteLatest(deps, "1.0.0");
    expect(await checkChannels(deps, false)).toEqual({ ok: true, problems: [], repaired: [] });
  });

  test("an invalid slot and an unverified target are repaired to the higher verified value", async () => {
    gh.publish("1.0.0");
    gh.publish("1.1.0");
    await promoteLatest(deps, "1.0.0");
    gh.releases.get("channels")!.assets.set("latest", enc("<html>"));
    gh.releases.get("channels")!.assets.set("stable.bak", enc("1.1.0\n")); // 1.1.0 has no verification record
    const report = await checkChannels(deps, true);
    expect(report.ok).toBe(false);
    expect(endState()).toMatchObject({ latest: "1.0.0", latestBak: "1.0.0", stable: "1.0.0", stableBak: "1.0.0" });
  });

  test("both slots invalid: nothing is changed and the check fails", async () => {
    gh.publish("1.0.0");
    await promoteLatest(deps, "1.0.0");
    gh.releases.get("channels")!.assets.set("stable", enc("x"));
    gh.releases.get("channels")!.assets.delete("stable.bak");
    const report = await checkChannels(deps, true);
    expect(report.problems).toContain("stable: neither slot names a verified release; not repaired");
    expect(gh.slot("stable")).toBe("x");
  });
});

describe("interleaved promotions (R7.2)", () => {
  for (let seed = 1; seed <= 25; seed++) {
    test(`seed ${seed}`, async () => {
      for (const v of ["1.0.0", "1.1.0", "2.0.0"]) gh.publish(v);
      await promoteLatest(deps, "1.0.0");
      await promoteLatest(deps, "1.1.0");
      let s = seed;
      const rand = () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
      gh.delay = () => new Promise((r) => setTimeout(r, Math.floor(rand() * 3)));
      const verified = new Set(["1.0.0", "1.1.0", "2.0.0"]);
      let lastLatest = "1.1.0";
      gh.observe = () => {
        for (const slot of ["latest", "latest.bak", "stable", "stable.bak"]) {
          const v = gh.slot(slot);
          if (v !== null) expect(verified.has(v)).toBe(true);
        }
        const l = gh.slot("latest");
        if (l) {
          expect(Bun.semver.order(l, lastLatest)).toBeGreaterThanOrEqual(0);
          lastLatest = l;
        }
      };
      await Promise.allSettled([promoteLatest(deps, "2.0.0"), promoteStable(deps, "1.1.0")]);
      const latest = gh.slot("latest") ?? gh.slot("latest.bak");
      const stable = gh.slot("stable") ?? gh.slot("stable.bak");
      expect(Bun.semver.order(stable!, latest!)).toBeLessThanOrEqual(0);
    });
  }
});
```

- [ ] **Step 2: Run to see it fail**

Run: `bun test scripts/release/promote.test.ts`
Expected: FAIL — `./promote` not found.

- [ ] **Step 3: Implement `promote.ts`**

```ts
// scripts/release/promote.ts
// Convergent promotion of channel pointers and GitHub's latest release (spec §7.4–7.6).
// Runs only from a checkout of main in a job that executes no code from the release tag (spec §6.2).
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
  latestReleaseTag(): Promise<string | null>;
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

/** Decision D1-A: `verified.json` on the version release itself. */
export function recordsOnVersionRelease(main: GitHubClient): VerificationRecords {
  return {
    read: async (v) => parseRecord(await main.readAsset(`v${v}`, "verified.json")),
    write: (v, r) => main.uploadAsset(`v${v}`, "verified.json", enc(`${JSON.stringify(r)}\n`)),
  };
}

/** Decision D1-B: `verified-<x>.json` on the mutable channels release. */
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
const READ_BACK_ATTEMPTS = 10;
const READ_BACK_DELAY_MS = 3000; // decision D6: at least twice the observed --clobber gap

async function readSlot(d: PromoteDeps, slot: Slot): Promise<string | null> {
  const bytes = await d.channels.readAsset("channels", slot);
  if (!bytes) return null;
  const text = dec(bytes);
  const v = text.endsWith("\n") ? text.slice(0, -1) : text;
  return isVersion(v) ? v : null;
}

const higher = (a: string | null, b: string | null) => (a === null ? b : b === null ? a : compareVersions(a, b) >= 0 ? a : b);

async function writeSlot(d: PromoteDeps, slot: Slot, x: string, expected: string | null): Promise<void> {
  const current = await readSlot(d, slot);
  if (current === x) return;
  if (current !== expected) throw new Error(`channels/${slot} changed from ${expected} to ${current} while promoting; refusing to overwrite`);
  await d.channels.uploadAsset("channels", slot, enc(`${x}\n`));
  for (let i = 0; i < READ_BACK_ATTEMPTS; i++) {
    if ((await readSlot(d, slot)) === x) {
      d.log(`channels/${slot} = ${x}`);
      return;
    }
    await d.sleep(READ_BACK_DELAY_MS);
  }
  throw new Error(`channels/${slot} does not read back as ${x}`);
}

async function validateRelease(d: PromoteDeps, x: string): Promise<{ commit: string }> {
  if (!isVersion(x)) throw new Error(`not a version: ${x}`);
  const rel = await d.main.getRelease(`v${x}`);
  if (!rel || rel.draft) throw new Error(`v${x} is not published`);
  const [bytes, sig] = await Promise.all([d.main.readAsset(`v${x}`, "manifest.json"), d.main.readAsset(`v${x}`, "manifest.json.sig")]);
  const info = bytes && sig ? await d.verifyManifest(bytes, dec(sig)) : null;
  if (!info || info.version !== x) throw new Error(`v${x}: the manifest signature does not verify against release/allowed_signers`);
  return { commit: info.commit };
}

async function isVerifiedRelease(d: PromoteDeps, x: string | null): Promise<boolean> {
  if (x === null) return false;
  try {
    const { commit } = await validateRelease(d, x);
    const record = await d.records.read(x);
    return record !== null && record.version === x && record.commit === commit;
  } catch {
    return false;
  }
}

/** `promote.ts latest <x>` — every step checks its own effect first, so re-running resumes (spec §7.4). */
export async function promoteLatest(d: PromoteDeps, x: string): Promise<void> {
  const { commit } = await validateRelease(d, x);
  if (!(await d.channels.getRelease("channels"))) {
    await d.channels.createChannelsRelease();
    d.log("created the channels release (prerelease, never latest)");
  }
  const latest = { primary: await readSlot(d, "latest"), backup: await readSlot(d, "latest.bak") };
  const current = higher(latest.primary, latest.backup);
  if (current !== null && compareVersions(current, x) > 0) throw new Error(`promoting ${x} would move latest backwards from ${current}`);
  const record = await d.records.read(x);
  if (!record) await d.records.write(x, { version: x, commit, runId: d.runId, verifiedAt: d.now().toISOString() });
  else if (record.version !== x || record.commit !== commit) throw new Error(`v${x} already has a different verification record`);
  await writeSlot(d, "latest.bak", x, latest.backup);
  await writeSlot(d, "latest", x, latest.primary);
  const stable = { primary: await readSlot(d, "stable"), backup: await readSlot(d, "stable.bak") };
  if (stable.primary === null && stable.backup === null) {
    await writeSlot(d, "stable.bak", x, null);
    await writeSlot(d, "stable", x, null);
  }
  if ((await d.main.latestReleaseTag()) !== `v${x}`) {
    await d.main.markLatest(`v${x}`);
    for (let i = 0; (await d.main.latestReleaseTag()) !== `v${x}`; i++) {
      if (i >= READ_BACK_ATTEMPTS) throw new Error(`GitHub does not report v${x} as the latest release`);
      await d.sleep(READ_BACK_DELAY_MS);
    }
  }
}

/** `promote.ts stable <x>` (spec §7.4). */
export async function promoteStable(d: PromoteDeps, x: string): Promise<void> {
  const { commit } = await validateRelease(d, x);
  const record = await d.records.read(x);
  if (!record || record.version !== x || record.commit !== commit) throw new Error(`v${x} has no verification record; only fully verified releases can become stable`);
  const latest = higher(await readSlot(d, "latest"), await readSlot(d, "latest.bak"));
  if (latest === null || compareVersions(x, latest) > 0) throw new Error(`stable cannot run ahead of latest (${latest})`);
  const stable = { primary: await readSlot(d, "stable"), backup: await readSlot(d, "stable.bak") };
  const current = higher(stable.primary, stable.backup);
  if (current !== null && compareVersions(x, current) < 0) throw new Error(`promoting ${x} would move stable backwards from ${current}`);
  await writeSlot(d, "stable.bak", x, stable.backup);
  await writeSlot(d, "stable", x, stable.primary);
}

/** `promote.ts check [--repair]` (spec §7.4): never points a slot at an unverified release, never lowers a verified slot. */
export async function checkChannels(d: PromoteDeps, repair: boolean): Promise<{ ok: boolean; problems: string[]; repaired: string[] }> {
  const problems: string[] = [];
  const repaired: string[] = [];
  for (const ch of ["latest", "stable"] as const) {
    const bak = `${ch}.bak` as Slot;
    const p = await readSlot(d, ch);
    const b = await readSlot(d, bak);
    const pv = await isVerifiedRelease(d, p);
    const bv = await isVerifiedRelease(d, b);
    if (!pv) problems.push(`${ch}: ${p === null ? "missing or invalid" : `${p} is not a verified release`}`);
    if (!bv) problems.push(`${bak}: ${b === null ? "missing or invalid" : `${b} is not a verified release`}`);
    if (pv && bv && p !== b) problems.push(`${ch}: slots differ (${p} vs ${b})`);
    if (!repair) continue;
    const target = higher(pv ? p : null, bv ? b : null);
    if (target === null) {
      problems.push(`${ch}: neither slot names a verified release; not repaired`);
      continue;
    }
    for (const [slot, value] of [[bak, b], [ch, p]] as const) {
      if (value !== target) {
        await d.channels.uploadAsset("channels", slot, enc(`${target}\n`));
        repaired.push(`${slot} := ${target}`);
      }
    }
  }
  const latest = await readSlot(d, "latest");
  const stable = await readSlot(d, "stable");
  if (latest && stable && compareVersions(stable, latest) > 0) problems.push(`stable ${stable} is ahead of latest ${latest}`);
  const ghLatest = await d.main.latestReleaseTag();
  if (latest && ghLatest !== `v${latest}`) {
    problems.push(`GitHub latest is ${ghLatest}, channels/latest is ${latest}`);
    if (repair && (await isVerifiedRelease(d, latest))) {
      await d.main.markLatest(`v${latest}`);
      repaired.push(`GitHub latest := v${latest}`);
    }
  }
  return { ok: problems.length === 0, problems, repaired };
}

/** For smoke-public b/c (spec §7.3 step 6): skipped when nothing was ever promoted. */
export async function previousRelease(d: PromoteDeps): Promise<{ installerTag: string | null; stable: string | null }> {
  const hasChannels = (await d.channels.getRelease("channels")) !== null;
  const installerTag = await d.main.latestReleaseTag();
  const stable = hasChannels ? higher(await readSlot(d, "stable"), await readSlot(d, "stable.bak")) : null;
  return { installerTag, stable };
}

if (import.meta.main) {
  const { ghClient, sshVerifyManifest } = await import("./github");
  const repo = process.env.GITHUB_REPOSITORY!;
  const channelsRepo = process.env.CHANNELS_REPOSITORY || repo;
  const main = ghClient(repo);
  const channels = channelsRepo === repo ? main : ghClient(channelsRepo, process.env.CHANNELS_WRITE_TOKEN);
  const deps: PromoteDeps = {
    main,
    channels,
    records: channelsRepo === repo ? recordsOnVersionRelease(main) : recordsOnChannelsRelease(channels),
    verifyManifest: sshVerifyManifest("release/allowed_signers"),
    sleep: (ms) => Bun.sleep(ms),
    now: () => new Date(),
    runId: process.env.GITHUB_RUN_ID ?? "local",
    log: (line) => console.log(line),
  };
  const [command, arg] = process.argv.slice(2);
  if (command === "latest") await promoteLatest(deps, arg!);
  else if (command === "stable") await promoteStable(deps, arg!);
  else if (command === "check") {
    const report = await checkChannels(deps, arg === "--repair");
    for (const line of [...report.problems, ...report.repaired]) console.log(line);
    process.exit(report.ok ? 0 : 1);
  } else if (command === "previous") {
    const prev = await previousRelease(deps);
    console.log(`installer_tag=${prev.installerTag ?? ""}`);
    console.log(`stable=${prev.stable ?? ""}`);
  } else {
    console.error("usage: promote.ts latest <version> | stable <version> | check [--repair] | previous");
    process.exit(64);
  }
}
```

- [ ] **Step 4: Implement `github.ts`**

```ts
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
      const r = await gh(["release", "create", "channels", "--repo", repo, "--prerelease", "--latest=false", "--title", "Channel pointers", "--notes", "Holds the latest and stable channel pointers for the Tropos Code installer. Not a release; do not download."]);
      if (r.exitCode !== 0) throw new Error(`creating the channels release failed: ${r.stderr}`);
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
```

- [ ] **Step 5: Run to see them pass**

Run: `bun test scripts/release/promote.test.ts && bun run typecheck`
Expected: PASS (first-release, 4 resume faults, safety, stable, check, 25 interleaving seeds).

- [ ] **Step 6: Commit**

```bash
git add scripts/release/promote.ts scripts/release/github.ts scripts/release/promote.test.ts
git commit -m "feat(release): convergent promotion with two-slot channels, records and repair

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 27: `workflow_run` provenance and artifact integrity

Spec: §7.3 step 1 with amendment A4, R4.2, decision P1 (field names confirmed by the spike).

**Files:**
- Create: `scripts/release/check-provenance.ts`, `scripts/release/check-provenance.test.ts`

**Interfaces:**
- Consumes: `isVersion` (Task 3), `PLATFORMS` (Task 4)
- Produces: `interface WorkflowRun { id: number; repository: { full_name: string }; head_repository: { full_name: string } | null; head_branch: string; head_sha: string; path: string; event: string; conclusion: string | null }`, `interface ProvenanceApi { tagCommit(tag): Promise<string | null>; isOnMain(sha): Promise<boolean>; runArtifacts(runId): Promise<Array<{ id: number; name: string; expired: boolean; digest: string | null }>>; downloadArtifactZip(id): Promise<Uint8Array>; latestSuccessfulBuildRun(tag, sha): Promise<WorkflowRun | null> }`, `interface Provenance { tag: string; version: string; sha: string; runId: number; zip: Uint8Array }`, `checkProvenance(run, repo, api): Promise<Provenance>`, `runForDispatch(tag, api): Promise<WorkflowRun>`, `verifyReleaseInputs(dir): Promise<void>`, `RELEASE_BUILD_PATH = ".github/workflows/release-build.yml"`

- [ ] **Step 1: Write the failing tests**

```ts
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
```

- [ ] **Step 2: Run to see it fail**

Run: `bun test scripts/release/check-provenance.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// scripts/release/check-provenance.ts
// Before anything is signed: was this artifact built by release-build.yml, from a version tag of this repository,
// at the exact tagged commit, which is on main — and is it byte-for-byte what GitHub recorded? (spec §7.3, A4)
import { readdir, readFile } from "node:fs/promises";
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
  const sha = await api.tagCommit(tag);
  if (!sha) throw new Error(`tag ${tag} does not exist`);
  const run = await api.latestSuccessfulBuildRun(tag, sha);
  if (!run) throw new Error(`no successful release-build run for ${tag} at ${sha}`);
  return run;
}

/** The unzipped inputs must be exactly install.sh + six binaries + SHA256SUMS, each matching its sum. */
export async function verifyReleaseInputs(dir: string): Promise<void> {
  const expected = ["install.sh", ...PLATFORMS.map((p) => `tropos-${p}`)].sort();
  const present = (await readdir(dir)).filter((n) => n !== "SHA256SUMS").sort();
  for (const n of present) if (!expected.includes(n)) throw new Error(`unexpected file ${n} in release-inputs`);
  for (const n of expected) if (!present.includes(n)) throw new Error(`missing ${n} in release-inputs`);
  const sums = new Map<string, string>();
  for (const line of (await readFile(join(dir, "SHA256SUMS"), "utf8")).trim().split("\n")) {
    const m = /^([0-9a-f]{64}) [ *]?(\S+)$/.exec(line.trim());
    if (!m) throw new Error(`bad SHA256SUMS line: ${line}`);
    sums.set(m[2]!, m[1]!);
  }
  if ([...sums.keys()].sort().join() !== expected.join()) throw new Error("SHA256SUMS does not list exactly the release inputs");
  for (const n of expected) {
    const actual = new Bun.CryptoHasher("sha256").update(await readFile(join(dir, n))).digest("hex");
    if (actual !== sums.get(n)) throw new Error(`${n} does not match SHA256SUMS`);
  }
}

function ghApi(repo: string): ProvenanceApi {
  const json = async <T>(path: string): Promise<T | null> => {
    const r = await Bun.$`gh api ${path}`.quiet().nothrow();
    return r.exitCode === 0 ? (JSON.parse(r.stdout.toString()) as T) : null;
  };
  return {
    async tagCommit(tag) {
      const ref = await json<{ object: { type: string; sha: string } }>(`repos/${repo}/git/ref/tags/${tag}`);
      if (!ref) return null;
      if (ref.object.type !== "tag") return ref.object.sha;
      return (await json<{ object: { sha: string } }>(`repos/${repo}/git/tags/${ref.object.sha}`))?.object.sha ?? null;
    },
    async isOnMain(sha) {
      const cmp = await json<{ status: string }>(`repos/${repo}/compare/${sha}...main`);
      return cmp?.status === "ahead" || cmp?.status === "identical";
    },
    async runArtifacts(runId) {
      return (await json<{ artifacts: Array<{ id: number; name: string; expired: boolean; digest: string | null }> }>(`repos/${repo}/actions/runs/${runId}/artifacts`))?.artifacts ?? [];
    },
    async downloadArtifactZip(id) {
      return new Uint8Array(await Bun.$`gh api repos/${repo}/actions/artifacts/${id}/zip`.quiet().arrayBuffer());
    },
    async latestSuccessfulBuildRun(_tag, sha) {
      const runs = await json<{ workflow_runs: WorkflowRun[] }>(`repos/${repo}/actions/workflows/release-build.yml/runs?event=push&status=success&head_sha=${sha}&per_page=1`);
      return runs?.workflow_runs[0] ?? null;
    },
  };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args[0] === "--verify-inputs") {
    await verifyReleaseInputs(args[1]!);
    process.exit(0);
  }
  const repo = process.env.GITHUB_REPOSITORY!;
  const api = ghApi(repo);
  const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH!, "utf8")) as { workflow_run?: WorkflowRun };
  const run = event.workflow_run ?? (await runForDispatch(process.env.TAG_INPUT!, api));
  const out = args[args.indexOf("--out") + 1]!;
  const p = await checkProvenance(run, repo, api);
  await Bun.write(out, p.zip);
  console.log(`tag=${p.tag}`);
  console.log(`version=${p.version}`);
  console.log(`sha=${p.sha}`);
}
```

- [ ] **Step 4: Run to see it pass**

Run: `bun test scripts/release/check-provenance.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/release/check-provenance.ts scripts/release/check-provenance.test.ts
git commit -m "feat(release): verify workflow_run provenance and artifact digests before signing

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 28: Workflows, action pinning, policy test and the six-platform CI job

Spec: §6, §6.2, §7.1–7.5, R4.1, §13 CI runners, amendment A12 (draft assets reach read-only smoke jobs through a `fetch-draft` job that executes nothing).

**Files:**
- Create: `.github/workflows/release-build.yml`, `.github/workflows/release.yml`, `.github/workflows/promote.yml`, `.github/workflows/channels-health.yml`
- Modify: `.github/workflows/ci.yml` (six-platform installer job)
- Create: `scripts/release/pin-actions.ts`, `scripts/release/pin-actions.test.ts`
- Create: `test/install/workflow-policy.test.ts`

**Interfaces:**
- Consumes: `check-provenance.ts` (Task 27), `promote.ts` (Task 26), `collect-assets.sh` (Task 25), `make-manifest.sh`, `manifest.awk` (Task 7), decision D2 (Bun in Alpine)
- Produces: the four workflows; `pinActions(text, resolve): Promise<string>`

- [ ] **Step 1: Write the failing policy and pinning tests**

```ts
// test/install/workflow-policy.test.ts
// R4.1: no code from the release tag runs where the signing key or a write token is available (spec §6.2).
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

type Step = { uses?: string; run?: string; with?: Record<string, unknown> };
type Job = { permissions?: Record<string, string> | string; environment?: string; steps: Step[]; container?: unknown };
type Workflow = { on: Record<string, unknown>; permissions?: unknown; jobs: Record<string, Job> };

const load = async (name: string) => Bun.YAML.parse(await readFile(join(import.meta.dir, "../../.github/workflows", name), "utf8")) as Workflow;
const PRIVILEGED = ["release.yml", "promote.yml", "channels-health.yml"];
const ALL = ["release-build.yml", ...PRIVILEGED, "ci.yml"];
const writes = (j: Job) => typeof j.permissions === "object" && Object.values(j.permissions).includes("write");

describe("workflow policy (R4.1)", () => {
  test.each(ALL)("%s pins every action by full commit SHA", async (name) => {
    const wf = await load(name);
    for (const job of Object.values(wf.jobs)) for (const step of job.steps) if (step.uses) expect(step.uses).toMatch(/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/);
  });

  test.each(PRIVILEGED)("%s only runs from main and never on push or pull_request", async (name) => {
    const wf = await load(name);
    expect(Object.keys(wf.on).sort().every((t) => ["workflow_run", "workflow_dispatch", "schedule"].includes(t))).toBe(true);
    expect(wf.permissions).toEqual({});
  });

  test("only the sign job sees release-signing; it checks out main's release tooling only and runs no bun", async () => {
    const wf = await load("release.yml");
    const withEnv = Object.entries(wf.jobs).filter(([, j]) => j.environment === "release-signing").map(([n]) => n);
    expect(withEnv).toEqual(["sign"]);
    const sign = wf.jobs.sign!;
    expect(writes(sign)).toBe(false);
    for (const step of sign.steps) {
      expect(step.run ?? "").not.toMatch(/\bbun\b|\bnpm\b|\bnode\b|\btropos-[a-z0-9-]+\b|\bsh\s+\S*install\.sh/);
      if (step.uses?.startsWith("actions/checkout@")) {
        expect(step.with?.ref).toBeUndefined();
        expect(String(step.with?.["sparse-checkout"])).toMatch(/scripts\/release/);
      }
    }
  });

  test.each(PRIVILEGED)("in %s, jobs with a write token never execute release artifacts or tag code", async (name) => {
    const wf = await load(name);
    for (const [jobName, job] of Object.entries(wf.jobs)) {
      if (!writes(job)) continue;
      for (const step of job.steps) {
        const run = step.run ?? "";
        const executes = /\.local\/bin\/tropos|\btropos-[a-z0-9-]+\s|\bsh\s+\S*install\.sh|\|\s*sh\b|\bbun\s+(test|install)\b|\bbun\s+build/.test(run);
        if (executes) throw new Error(`${name}: job ${jobName} holds a write token but runs: ${run}`);
        if (step.uses?.startsWith("actions/checkout@")) expect(step.with?.ref).toBeUndefined();
      }
    }
  });

  test("smoke jobs are read-only and get draft assets from fetch-draft (A12)", async () => {
    const wf = await load("release.yml");
    for (const [n, j] of Object.entries(wf.jobs)) if (n.startsWith("smoke-")) expect(writes(j)).toBe(false);
    expect(writes(wf.jobs["fetch-draft"]!)).toBe(true);
  });

  test("release-build has no write permission and no secrets", async () => {
    const text = await readFile(join(import.meta.dir, "../../.github/workflows/release-build.yml"), "utf8");
    expect(text).not.toContain("secrets.");
    expect(text).not.toMatch(/:\s*write/);
  });

  test("release.yml, promote.yml and channels-health.yml share the channels concurrency group without cancelling", async () => {
    for (const name of PRIVILEGED) {
      const wf = (await load(name)) as Workflow & { concurrency?: { group: string; "cancel-in-progress": boolean } };
      expect(wf.concurrency).toEqual({ group: "channels", "cancel-in-progress": false });
    }
  });
});
```

```ts
// scripts/release/pin-actions.test.ts
import { describe, expect, test } from "bun:test";
import { pinActions } from "./pin-actions";

describe("pinActions", () => {
  test("pins tags to SHAs and keeps the tag as a comment; idempotent", async () => {
    const resolve = async (repo: string, ref: string) => `${repo === "actions/checkout" ? "1" : "2"}`.repeat(40).slice(0, 40) + (ref ? "" : "");
    const input = "      - uses: actions/checkout@v5\n      - uses: oven-sh/setup-bun@v2\n        with:\n";
    const once = await pinActions(input, resolve);
    expect(once).toBe(`      - uses: actions/checkout@${"1".repeat(40)} # v5\n      - uses: oven-sh/setup-bun@${"2".repeat(40)} # v2\n        with:\n`);
    expect(await pinActions(once, resolve)).toBe(once);
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `bun test test/install/workflow-policy.test.ts scripts/release/pin-actions.test.ts`
Expected: FAIL — workflows and `pin-actions.ts` do not exist.

- [ ] **Step 3: Implement `pin-actions.ts`**

```ts
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
  const resolve = async (repo: string, ref: string) => (await Bun.$`gh api repos/${repo}/commits/${ref} --jq .sha`.text()).trim();
  for (const file of process.argv.slice(2)) await writeFile(file, await pinActions(await readFile(file, "utf8"), resolve));
}
```

- [ ] **Step 4: Write `release-build.yml`**

```yaml
# .github/workflows/release-build.yml — unprivileged: runs at the tag, no secrets, read-only token (spec §7.2).
name: release-build
on:
  push:
    tags: ["v*"]
permissions:
  contents: read
jobs:
  verify-tag:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v5
        with:
          fetch-depth: 0
      - name: Tag matches package.json and is on main
        run: |
          version=$(jq -r .version package.json)
          [ "$GITHUB_REF_NAME" = "v$version" ] || { echo "tag $GITHUB_REF_NAME does not match package.json $version"; exit 1; }
          git merge-base --is-ancestor "$GITHUB_SHA" origin/main || { echo "the tagged commit is not on main"; exit 1; }

  build:
    needs: verify-tag
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v5
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: 1.4.0
      - run: bun install --frozen-lockfile
      - run: bun run build:all
      - run: sh scripts/release/collect-assets.sh dist "${GITHUB_REF_NAME#v}" release-inputs
      - uses: actions/upload-artifact@v4
        with:
          name: release-inputs
          path: release-inputs/
          if-no-files-found: error

  test-native:
    needs: build
    strategy:
      fail-fast: true
      matrix:
        include:
          - { runner: macos-15, platform: darwin-arm64 }
          - { runner: macos-15-intel, platform: darwin-x64 }
          - { runner: ubuntu-24.04, platform: linux-x64 }
          - { runner: ubuntu-24.04-arm, platform: linux-arm64 }
    runs-on: ${{ matrix.runner }}
    steps:
      - uses: actions/checkout@v5
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: 1.4.0
      - name: Tools
        run: |
          if [ "$RUNNER_OS" = "macOS" ]; then brew install zstd shellcheck; else sudo apt-get install -y zstd shellcheck dash busybox; fi
      - uses: actions/download-artifact@v4
        with:
          name: release-inputs
          path: release-inputs
      - run: bun install --frozen-lockfile
      - run: chmod +x release-inputs/tropos-*
      - run: TROPOS_TEST_BINARY="$PWD/release-inputs/tropos-${{ matrix.platform }}" bun test test/install

  test-musl:
    needs: build
    strategy:
      fail-fast: true
      matrix:
        include:
          - { runner: ubuntu-24.04, platform: linux-x64-musl, bunzip: bun-linux-x64-musl }
          - { runner: ubuntu-24.04-arm, platform: linux-arm64-musl, bunzip: bun-linux-aarch64-musl }
    runs-on: ${{ matrix.runner }}
    container: alpine:3.22
    steps:
      - run: apk add --no-cache git curl unzip zstd openssh-keygen shellcheck libstdc++ libgcc
      - uses: actions/checkout@v5
      - name: Bun (decision D2)
        run: |
          curl -fsSLo bun.zip "https://github.com/oven-sh/bun/releases/download/bun-v1.4.0/${{ matrix.bunzip }}.zip"
          unzip -q bun.zip && install -m 0755 ${{ matrix.bunzip }}/bun /usr/local/bin/bun
      - uses: actions/download-artifact@v4
        with:
          name: release-inputs
          path: release-inputs
      - run: bun install --frozen-lockfile
      - run: chmod +x release-inputs/tropos-*
      - run: TROPOS_TEST_BINARY="$PWD/release-inputs/tropos-${{ matrix.platform }}" bun test test/install
```

If decision D2 recorded that `oven-sh/setup-bun` works inside Alpine, use it in `test-musl` instead of the zip download.

- [ ] **Step 5: Write `release.yml`**

```yaml
# .github/workflows/release.yml — privileged, defined on main (spec §6.2, §7.3). Treats everything from the tag as data.
name: release
on:
  workflow_run:
    workflows: [release-build]
    types: [completed]
  workflow_dispatch:
    inputs:
      tag:
        description: "Release tag to resume (vX.Y.Z)"
        required: true
permissions: {}
concurrency:
  group: channels
  cancel-in-progress: false
jobs:
  prepare:
    if: github.event_name == 'workflow_dispatch' || github.event.workflow_run.conclusion == 'success'
    runs-on: ubuntu-24.04
    permissions:
      contents: read
      actions: read
    outputs:
      tag: ${{ steps.prov.outputs.tag }}
      version: ${{ steps.prov.outputs.version }}
      sha: ${{ steps.prov.outputs.sha }}
    steps:
      - name: Only from main
        run: '[ "$GITHUB_REF" = "refs/heads/main" ] || { echo "release.yml runs only from main"; exit 1; }'
      - uses: actions/checkout@v5
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: 1.4.0
      - run: bun install --frozen-lockfile
      - run: sudo apt-get install -y zstd unzip
      - name: Provenance (A4)
        id: prov
        env:
          GH_TOKEN: ${{ github.token }}
          TAG_INPUT: ${{ inputs.tag }}
        run: bun scripts/release/check-provenance.ts --out release-inputs.zip >> "$GITHUB_OUTPUT"
      - name: Unpack and check SHA256SUMS
        run: |
          mkdir inputs && unzip -q release-inputs.zip -d inputs
          bun scripts/release/check-provenance.ts --verify-inputs inputs
      - name: Compress, round-trip and write the manifest
        env:
          VERSION: ${{ steps.prov.outputs.version }}
          SHA: ${{ steps.prov.outputs.sha }}
        run: |
          mkdir assets
          for p in darwin-arm64 darwin-x64 linux-x64 linux-arm64 linux-x64-musl linux-arm64-musl; do
            cp "inputs/tropos-$p" "assets/tropos-$p"
            zstd -19 --check -q -o "assets/tropos-$p.zst" "assets/tropos-$p"
            zstd -d -q -c "assets/tropos-$p.zst" | cmp - "assets/tropos-$p"
          done
          cp inputs/install.sh assets/install.sh
          sh scripts/release/make-manifest.sh "$VERSION" "$SHA" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" assets > assets/manifest.json
          awk -v want=linux-x64 -f scripts/release/manifest.awk assets/manifest.json
          bun -e 'import { parseManifest } from "./src/install/manifest"; parseManifest(new Uint8Array(await Bun.file("assets/manifest.json").arrayBuffer()))'
      - uses: actions/upload-artifact@v4
        with:
          name: to-sign
          path: |
            assets/manifest.json
            assets/install.sh
      - uses: actions/upload-artifact@v4
        with:
          name: release-assets
          path: assets/

  sign:
    needs: prepare
    runs-on: ubuntu-24.04
    environment: release-signing
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@v5
        with:
          sparse-checkout: |
            scripts/release
            release
          sparse-checkout-cone-mode: false
      - uses: actions/download-artifact@v4
        with:
          name: to-sign
          path: to-sign
      - name: Refuse to sign without a pinned key (A5)
        run: grep -Eq '^tropos-release ssh-ed25519 ' release/allowed_signers || { echo "release/allowed_signers has no key"; exit 1; }
      - name: Sign and verify
        env:
          KEY: ${{ secrets.TROPOS_RELEASE_SIGNING_KEY }}
        run: |
          awk -v want=linux-x64 -f scripts/release/manifest.awk to-sign/manifest.json > /dev/null
          umask 077
          printf '%s\n' "$KEY" > "$RUNNER_TEMP/signing-key"
          ssh-keygen -Y sign -f "$RUNNER_TEMP/signing-key" -n tropos-manifest to-sign/manifest.json
          ssh-keygen -Y sign -f "$RUNNER_TEMP/signing-key" -n tropos-installer to-sign/install.sh
          rm -f "$RUNNER_TEMP/signing-key"
          ssh-keygen -Y verify -f release/allowed_signers -I tropos-release -n tropos-manifest -s to-sign/manifest.json.sig < to-sign/manifest.json
          ssh-keygen -Y verify -f release/allowed_signers -I tropos-release -n tropos-installer -s to-sign/install.sh.sig < to-sign/install.sh
      - name: Remove the key file
        if: always()
        run: rm -f "$RUNNER_TEMP/signing-key"
      - uses: actions/upload-artifact@v4
        with:
          name: signatures
          path: |
            to-sign/manifest.json.sig
            to-sign/install.sh.sig

  draft:
    needs: [prepare, sign]
    runs-on: ubuntu-24.04
    permissions:
      contents: write
    env:
      GH_TOKEN: ${{ github.token }}
      TAG: ${{ needs.prepare.outputs.tag }}
    steps:
      - uses: actions/download-artifact@v4
        with:
          name: release-assets
          path: assets
      - uses: actions/download-artifact@v4
        with:
          name: signatures
          path: assets
      - name: Create or complete the draft
        run: |
          state=$(gh release view "$TAG" --repo "$GITHUB_REPOSITORY" --json isDraft --jq .isDraft 2>/dev/null || echo missing)
          if [ "$state" = missing ]; then
            gh release create "$TAG" --repo "$GITHUB_REPOSITORY" --draft --latest=false --title "$TAG" --notes "Verify with the key fingerprint in the README; see docs/install.md." assets/*
          elif [ "$state" = true ]; then
            gh release upload "$TAG" --repo "$GITHUB_REPOSITORY" --clobber assets/*
          else
            echo "$TAG is already published; resuming after the draft stage"
          fi

  fetch-draft:
    needs: [prepare, draft]
    runs-on: ubuntu-24.04
    permissions:
      contents: write
    env:
      GH_TOKEN: ${{ github.token }}
      TAG: ${{ needs.prepare.outputs.tag }}
    steps:
      - name: Authenticated download of the draft's assets (executes nothing — A12)
        run: gh release download "$TAG" --repo "$GITHUB_REPOSITORY" --dir draft
      - uses: actions/upload-artifact@v4
        with:
          name: draft-assets
          path: draft/

  smoke-draft-native:
    needs: [prepare, fetch-draft]
    strategy:
      matrix:
        runner: [macos-15, macos-15-intel, ubuntu-24.04, ubuntu-24.04-arm]
    runs-on: ${{ matrix.runner }}
    permissions:
      contents: read
    steps:
      - uses: actions/download-artifact@v4
        with:
          name: draft-assets
          path: draft
      - name: Install from the draft
        env:
          VERSION: ${{ needs.prepare.outputs.version }}
        run: |
          TROPOS_INSTALL_FROM="$PWD/draft" sh draft/install.sh "$VERSION"
          [ "$("$HOME/.local/bin/tropos" --version)" = "$VERSION (Tropos Code)" ]

  smoke-draft-musl:
    needs: [prepare, fetch-draft]
    strategy:
      matrix:
        runner: [ubuntu-24.04, ubuntu-24.04-arm]
    runs-on: ${{ matrix.runner }}
    container: alpine:3.22
    permissions:
      contents: read
    steps:
      - run: apk add --no-cache openssh-keygen zstd curl
      - uses: actions/download-artifact@v4
        with:
          name: draft-assets
          path: draft
      - name: Install from the draft
        env:
          VERSION: ${{ needs.prepare.outputs.version }}
        run: |
          TROPOS_INSTALL_FROM="$PWD/draft" sh draft/install.sh "$VERSION"
          [ "$("$HOME/.local/bin/tropos" --version)" = "$VERSION (Tropos Code)" ]

  publish:
    needs: [prepare, smoke-draft-native, smoke-draft-musl]
    runs-on: ubuntu-24.04
    permissions:
      contents: write
    steps:
      - env:
          GH_TOKEN: ${{ github.token }}
          TAG: ${{ needs.prepare.outputs.tag }}
        run: gh release edit "$TAG" --repo "$GITHUB_REPOSITORY" --draft=false --latest=false

  previous:
    needs: [prepare, publish]
    runs-on: ubuntu-24.04
    permissions:
      contents: read
    outputs:
      installer_tag: ${{ steps.prev.outputs.installer_tag }}
      stable: ${{ steps.prev.outputs.stable }}
    steps:
      - uses: actions/checkout@v5
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: 1.4.0
      - id: prev
        env:
          GH_TOKEN: ${{ github.token }}
        run: bun scripts/release/promote.ts previous >> "$GITHUB_OUTPUT"

  smoke-public-native:
    needs: [prepare, previous]
    strategy:
      matrix:
        runner: [macos-15, macos-15-intel, ubuntu-24.04, ubuntu-24.04-arm]
    runs-on: ${{ matrix.runner }}
    permissions:
      contents: read
    env:
      R: ${{ github.repository }}
      TAG: ${{ needs.prepare.outputs.tag }}
      VERSION: ${{ needs.prepare.outputs.version }}
      OLD_TAG: ${{ needs.previous.outputs.installer_tag }}
      STABLE: ${{ needs.previous.outputs.stable }}
    steps:
      - name: a) this release's installer, public URLs
        run: |
          export HOME="$(mktemp -d)"
          curl -fsSL "https://github.com/$R/releases/download/$TAG/install.sh" | sh -s -- "$VERSION"
          [ "$("$HOME/.local/bin/tropos" --version)" = "$VERSION (Tropos Code)" ]
          "$HOME/.local/bin/tropos" install "$VERSION"
      - name: b) the published installer verifies the new release
        if: needs.previous.outputs.installer_tag != ''
        run: |
          export HOME="$(mktemp -d)"
          curl -fsSL "https://github.com/$R/releases/download/$OLD_TAG/install.sh" | sh -s -- "$VERSION"
          [ "$("$HOME/.local/bin/tropos" --version)" = "$VERSION (Tropos Code)" ]
      - name: c) the stable binary installs the new release
        if: needs.previous.outputs.stable != ''
        run: |
          export HOME="$(mktemp -d)"
          curl -fsSL "https://github.com/$R/releases/download/v$STABLE/install.sh" | sh -s -- "$STABLE"
          "$HOME/.local/bin/tropos" install "$VERSION"
          [ "$("$HOME/.local/bin/tropos" --version)" = "$VERSION (Tropos Code)" ]

  smoke-public-musl:
    needs: [prepare, previous]
    strategy:
      matrix:
        runner: [ubuntu-24.04, ubuntu-24.04-arm]
    runs-on: ${{ matrix.runner }}
    container: alpine:3.22
    permissions:
      contents: read
    env:
      R: ${{ github.repository }}
      TAG: ${{ needs.prepare.outputs.tag }}
      VERSION: ${{ needs.prepare.outputs.version }}
      OLD_TAG: ${{ needs.previous.outputs.installer_tag }}
      STABLE: ${{ needs.previous.outputs.stable }}
    steps:
      - run: apk add --no-cache openssh-keygen zstd curl
      - name: a) this release's installer, public URLs
        run: |
          export HOME="$(mktemp -d)"
          curl -fsSL "https://github.com/$R/releases/download/$TAG/install.sh" | sh -s -- "$VERSION"
          [ "$("$HOME/.local/bin/tropos" --version)" = "$VERSION (Tropos Code)" ]
          "$HOME/.local/bin/tropos" install "$VERSION"
      - name: b) the published installer verifies the new release
        if: needs.previous.outputs.installer_tag != ''
        run: |
          export HOME="$(mktemp -d)"
          curl -fsSL "https://github.com/$R/releases/download/$OLD_TAG/install.sh" | sh -s -- "$VERSION"
      - name: c) the stable binary installs the new release
        if: needs.previous.outputs.stable != ''
        run: |
          export HOME="$(mktemp -d)"
          curl -fsSL "https://github.com/$R/releases/download/v$STABLE/install.sh" | sh -s -- "$STABLE"
          "$HOME/.local/bin/tropos" install "$VERSION"

  promote-latest:
    needs: [prepare, smoke-public-native, smoke-public-musl]
    runs-on: ubuntu-24.04
    permissions:
      contents: write
    steps:
      - uses: actions/checkout@v5
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: 1.4.0
      - name: Promote (convergent; safe to re-run)
        env:
          GH_TOKEN: ${{ github.token }}
          VERSION: ${{ needs.prepare.outputs.version }}
        run: bun scripts/release/promote.ts latest "$VERSION"
```

With decision D1-B, `promote-latest` additionally sets `environment: channels-write` and `env: CHANNELS_REPOSITORY: Tropos-AI/tropos-code-channels, CHANNELS_WRITE_TOKEN: ${{ secrets.CHANNELS_WRITE_TOKEN }}`; `promote.ts` already switches to `recordsOnChannelsRelease` when `CHANNELS_REPOSITORY` differs.

`promote.ts` imports only `src/install/version.ts`, which has no dependencies, so `promote-latest` needs no `bun install` — keep it that way.

- [ ] **Step 6: Write `promote.yml` and `channels-health.yml`**

```yaml
# .github/workflows/promote.yml — manual: move the stable channel to a verified version (spec §7.4).
name: promote
on:
  workflow_dispatch:
    inputs:
      version:
        description: "Version to promote to stable (X.Y.Z)"
        required: true
permissions: {}
concurrency:
  group: channels
  cancel-in-progress: false
jobs:
  promote-stable:
    runs-on: ubuntu-24.04
    permissions:
      contents: write
    steps:
      - name: Only from main
        run: '[ "$GITHUB_REF" = "refs/heads/main" ] || { echo "promote.yml runs only from main"; exit 1; }'
      - uses: actions/checkout@v5
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: 1.4.0
      - env:
          GH_TOKEN: ${{ github.token }}
          VERSION: ${{ inputs.version }}
        run: bun scripts/release/promote.ts stable "$VERSION"
```

```yaml
# .github/workflows/channels-health.yml — every 6 hours: check the channel pointers; repair on request (spec §7.4).
name: channels-health
on:
  schedule:
    - cron: "17 */6 * * *"
  workflow_dispatch:
    inputs:
      repair:
        description: "Repair problems found"
        type: boolean
        default: false
permissions: {}
concurrency:
  group: channels
  cancel-in-progress: false
jobs:
  check:
    if: github.event_name == 'schedule' || !inputs.repair
    runs-on: ubuntu-24.04
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@v5
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: 1.4.0
      - env:
          GH_TOKEN: ${{ github.token }}
        run: bun scripts/release/promote.ts check
  repair:
    if: github.event_name == 'workflow_dispatch' && inputs.repair
    runs-on: ubuntu-24.04
    permissions:
      contents: write
    steps:
      - name: Only from main
        run: '[ "$GITHUB_REF" = "refs/heads/main" ] || exit 1'
      - uses: actions/checkout@v5
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: 1.4.0
      - env:
          GH_TOKEN: ${{ github.token }}
        run: bun scripts/release/promote.ts check --repair
```

- [ ] **Step 7: Add the six-platform installer job to `ci.yml`**

Append to `jobs:` in `.github/workflows/ci.yml` (keep the existing jobs):

```yaml
  installer-native:
    name: installer (${{ matrix.runner }})
    strategy:
      fail-fast: false
      matrix:
        runner: [macos-15, macos-15-intel, ubuntu-24.04, ubuntu-24.04-arm]
    runs-on: ${{ matrix.runner }}
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v5
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: 1.4.0
      - name: Tools
        run: |
          if [ "$RUNNER_OS" = "macOS" ]; then brew install zstd shellcheck; else sudo apt-get install -y zstd shellcheck dash busybox; fi
      - run: bun install --frozen-lockfile
      - run: bun test test/install

  installer-musl:
    name: installer (alpine ${{ matrix.runner }})
    strategy:
      fail-fast: false
      matrix:
        include:
          - { runner: ubuntu-24.04, bunzip: bun-linux-x64-musl }
          - { runner: ubuntu-24.04-arm, bunzip: bun-linux-aarch64-musl }
    runs-on: ${{ matrix.runner }}
    container: alpine:3.22
    timeout-minutes: 30
    steps:
      - run: apk add --no-cache git curl unzip zstd openssh-keygen shellcheck libstdc++ libgcc
      - uses: actions/checkout@v5
      - name: Bun (decision D2)
        run: |
          curl -fsSLo bun.zip "https://github.com/oven-sh/bun/releases/download/bun-v1.4.0/${{ matrix.bunzip }}.zip"
          unzip -q bun.zip && install -m 0755 ${{ matrix.bunzip }}/bun /usr/local/bin/bun
      - run: bun install --frozen-lockfile
      - run: bun test test/install
```

- [ ] **Step 8: Pin every action and run the policy test**

Run: `bun scripts/release/pin-actions.ts .github/workflows/*.yml && bun test test/install/workflow-policy.test.ts scripts/release/pin-actions.test.ts`
Expected: every `uses:` line now ends in `@<40-hex> # vN`; PASS.

- [ ] **Step 9: Lint the workflows**

Run: `bunx --bun actionlint .github/workflows/*.yml` if `actionlint` is installed locally (`brew install actionlint`), otherwise `actionlint` via Docker: `docker run --rm -v "$PWD:/repo" -w /repo rhysd/actionlint:latest`.
Expected: no findings. (actionlint is a developer tool, not a project dependency.)

- [ ] **Step 10: Commit and push the branch to run CI**

```bash
git add .github/workflows scripts/release/pin-actions.ts scripts/release/pin-actions.test.ts test/install/workflow-policy.test.ts
git commit -m "ci(release): privileged release on main, signing isolation, six-platform installer CI

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Owner checkpoint: push `feat/install-update` and confirm the `ci` workflow's six installer jobs pass. Fix failures on the branch before continuing.

---

## M7 — Key ceremony, documentation and end-to-end proof

### Task 29: Documentation and the signing-key ceremony

Spec: §4.2, §6 (setup), §6.1 (rotation), §8.1 (verify-first route), §4.5 (key compromise), amendment A5.

**Owner checkpoint:** Steps 1–4 handle the real signing key and repository settings. Only the owner performs them; the implementer prepares the documentation and the commit.

**Files:**
- Create: `docs/install.md`
- Modify: `README.md` (install section, key fingerprint)
- Modify: `release/allowed_signers`, `install.sh` (pinned-key block)
- Create: `test/install/docs.test.ts`
- Modify: `test/install/binary.e2e.test.ts` (test title only, see Step 7)

**Interfaces:**
- Consumes: `parseAllowedSigners`, `fingerprint` (Task 5); `blockOf` (Task 22)

- [ ] **Step 1 (owner): Generate the key on a trusted machine**

```bash
ssh-keygen -t ed25519 -N "" -C tropos-release -f tropos-release
ssh-keygen -lf tropos-release.pub      # note the SHA256:… fingerprint
```

Keep an offline backup of `tropos-release` (for example in a password manager's secure notes or on encrypted removable media). Never commit it.

- [ ] **Step 2 (owner): Create the protected environment and secret**

In `Tropos-AI/tropos-code` → Settings → Environments → New environment `release-signing`:
- Required reviewers: the maintainers allowed to approve releases; "Prevent self-review" on.
- Deployment branches and tags: "Selected branches and tags" → add `main` only.
- Environment secret `TROPOS_RELEASE_SIGNING_KEY` = the full contents of the private key file `tropos-release`.

Then delete the local private key file once the backup is confirmed.

- [ ] **Step 3 (owner): Protect tags and main**

Settings → Rules → Rulesets → New tag ruleset "release tags": target `v*`; restrict creations to the maintainers (bypass list); block updates and deletions. Confirm `main` requires pull-request review before merging (the privileged workflows and `scripts/release/` run from `main`).

- [ ] **Step 4 (owner): Pin the public key**

Replace the comment line "Intentionally empty until the key ceremony…" in `release/allowed_signers` with the key line, so the file reads:

```text
# release/allowed_signers — trusted Tropos Code release signing keys (spec §4.2, §6).
# One line per key: tropos-release ssh-ed25519 <base64-key> <comment>
tropos-release ssh-ed25519 <the base64 key from tropos-release.pub> tropos-release
```

Copy the file's exact contents into the `TROPOS_ALLOWED_SIGNERS='…'` block of `install.sh`.

- [ ] **Step 5: Write the docs consistency test**

```ts
// test/install/docs.test.ts
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseAllowedSigners } from "../../src/install/sshsig";

const root = join(import.meta.dir, "../..");

describe("published key fingerprint (spec §8.1)", () => {
  test("README and docs/install.md list the fingerprint of every pinned key", async () => {
    const keys = parseAllowedSigners(await readFile(join(root, "release/allowed_signers"), "utf8"));
    const readme = await readFile(join(root, "README.md"), "utf8");
    const docs = await readFile(join(root, "docs/install.md"), "utf8");
    for (const k of keys) {
      expect(readme).toContain(k.fingerprint);
      expect(docs).toContain(k.fingerprint);
    }
  });

  test("docs describe the trust bootstrap and the verify-first route", async () => {
    const docs = await readFile(join(root, "docs/install.md"), "utf8");
    expect(docs).toContain("trusts GitHub's HTTPS");
    expect(docs).toContain("ssh-keygen -Y verify -f allowed_signers -I tropos-release -n tropos-installer -s install.sh.sig < install.sh");
  });
});
```

- [ ] **Step 6: Write `docs/install.md` and update the README**

`docs/install.md` — write these sections with the exact commands shown (fill `<fingerprint>` with the value from Step 1):

````markdown
# Installing and updating Tropos Code

## Install

```sh
curl -fsSL https://github.com/Tropos-AI/tropos-code/releases/latest/download/install.sh | sh
curl -fsSL https://github.com/Tropos-AI/tropos-code/releases/latest/download/install.sh | sh -s -- stable
curl -fsSL https://github.com/Tropos-AI/tropos-code/releases/latest/download/install.sh | sh -s -- 0.3.0
```

Needs `curl` or `wget`, `sha256sum` or `shasum`, and `ssh-keygen` from OpenSSH 8.1 or newer
(Debian/Ubuntu: `openssh-client`; Alpine: `apk add openssh-keygen`; Fedora: `openssh-clients`).
`zstd` is optional and makes the download about three times smaller.

### What you are trusting

The one-line install trusts GitHub's HTTPS to deliver `install.sh` itself. From then on, every
release is checked against the Tropos release key pinned inside `install.sh` and inside `tropos`:
the manifest's ed25519 signature first, then the binary's size and SHA-256. Nothing is run or
installed if any check fails.

### Verify the installer before running it

```sh
v=0.3.0
curl -fsSLO "https://github.com/Tropos-AI/tropos-code/releases/download/v$v/install.sh"
curl -fsSLO "https://github.com/Tropos-AI/tropos-code/releases/download/v$v/install.sh.sig"
printf 'tropos-release %s\n' "<the ssh-ed25519 key line from release/allowed_signers>" > allowed_signers
ssh-keygen -lf allowed_signers          # must print <fingerprint>
ssh-keygen -Y verify -f allowed_signers -I tropos-release -n tropos-installer -s install.sh.sig < install.sh
sh install.sh "$v"
```

Release key fingerprint: `<fingerprint>` (also in the README and on every release page).

## Commands

| Command | What it does |
|---|---|
| `tropos install [stable\|latest\|<version>] [--force]` | One-time install of a release; does not change your update channel |
| `tropos update` / `tropos upgrade` | Newest release of your channel; never older |
| `tropos rollback` | Back to the previous version; updates then skip the one you left |
| `tropos -- update` | Everything after `--` is a prompt |

## Background updates

Settings in `~/.tropos/settings.json` (repository settings cannot change these):

```json
{ "autoUpdates": true, "autoUpdatesChannel": "latest" }
```

Interactive sessions check at most every 6 hours (longer after failures) and install newer releases
in the background; the next session prints "Updated to <version>". Set `"autoUpdates": false` or
`TROPOS_DISABLE_AUTOUPDATER=1` to turn this off. Print mode (`-p`) and CI never update.

## Files

`~/.local/share/tropos/versions/<version>` (binaries), `~/.local/share/tropos/manifests/` (signed
manifests), `~/.local/state/tropos/` (state, locks, `update.log`), `~/.local/bin/tropos` (symlink).
`XDG_DATA_HOME` and `XDG_STATE_HOME` are honoured when absolute.

Uninstall: `rm -rf ~/.local/share/tropos ~/.local/state/tropos ~/.local/bin/tropos` (and `~/.tropos` for settings and sessions).

## Exit codes

0 ok · 64 usage · 65 verification failed · 69 network · 73 local problem (permissions, disk, not a native install) · 75 another install is running.

## For maintainers

- Releasing: bump `version` in `package.json` on `main`, push tag `v<version>`, approve the `release-signing` deployment. The pipeline smoke-tests the draft and the public release on six platforms and only then moves `latest`.
- Stable: run the `promote` workflow with the version (it must be verified and not ahead of latest).
- Pointer health: `channels-health` runs every 6 hours; dispatch it with `repair: true` to fix a missing or mismatched slot.
- Key rotation (K1 → K2): (1) add K2 to `release/allowed_signers` and `install.sh`, release; (2) when GitHub's latest installer and the stable binary both trust K2, put K2 in the secret — the old-client gate refuses earlier; (3) remove K1 in a later release. After step 3, versions signed only with K1 are no longer Verified on users' machines, so they cannot be rolled back to and cleanup may remove them.
- Key compromise: rotate as above immediately, publish a release signed with the new key, and tell users to reinstall with `install.sh`; binaries that only trust the old key cannot update.
````

In `README.md`, replace the install instructions with the first `curl … | sh` line, a link to `docs/install.md`, and the line `Release key fingerprint: <fingerprint>`.

- [ ] **Step 7: Retitle the production-binary test**

In `test/install/binary.e2e.test.ts` rename `"with no pinned key, install --self fails closed (A5)"` to `"rejects a manifest not signed by the pinned key"` — the assertions (exit 65, "untrusted key") hold both before and after the ceremony.

- [ ] **Step 8: Run everything**

Run: `bun test && bun run test:coverage && shellcheck -s sh install.sh`
Expected: PASS; `test/install/parity.test.ts` confirms `install.sh`, `release/allowed_signers` and `trust.ts` agree.

- [ ] **Step 9: Commit**

```bash
git add docs/install.md README.md release/allowed_signers install.sh test/install/docs.test.ts test/install/binary.e2e.test.ts
git commit -m "docs(install): install, verify-first and maintainer docs; pin the release key

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 30: End-to-end proof and a release dry run

Spec: success criteria §1 (all six), §13 layer 8, R12 in practice.

**Files:**
- Create: `test/install/install-sh.e2e.test.ts`
- Modify: `docs/superpowers/specs/2026-10-13-install-update-design.md` (Appendix B: "Revision 4 — implemented", with links to the dry-run evidence)

**Interfaces:**
- Consumes: everything

- [ ] **Step 1: Write the install.sh → real binary e2e**

```ts
// test/install/install-sh.e2e.test.ts
// install.sh hands off to a real (test-build) tropos, which then updates and rolls back — success criteria 1–4.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import pkg from "../../package.json";
import { makeTmpDir, removeDir } from "../helpers/tmp";
import { makeFixtureRelease, publishFixture } from "./helpers/fixture-release";
import { allowedSignersText, makeTestKey, type TestKey } from "./helpers/keys";
import { startReleaseServer, type ReleaseServer } from "./helpers/release-server";
import { makeSandbox } from "./helpers/sh-runner";

let dir: string;
let key: TestKey;
let srv: ReleaseServer;
let testBin: string;

beforeAll(async () => {
  dir = await makeTmpDir();
  key = await makeTestKey(dir, "e2e");
  await writeFile(join(dir, "signers"), allowedSignersText(key));
  testBin = join(dir, "tropos-test");
  await Bun.$`bun build.ts --test-build --test-signers ${join(dir, "signers")} --outfile ${testBin}`.quiet();
  srv = startReleaseServer();
  publishFixture(srv, await makeFixtureRelease({ version: pkg.version, key, dir, binary: new Uint8Array(await Bun.file(testBin).arrayBuffer()) }));
  srv.put("channels", "latest", `${pkg.version}\n`);
}, 300_000);
afterAll(async () => {
  srv.stop();
  await removeDir(dir);
});

describe("install.sh → tropos install --self → update → rollback", () => {
  test("the whole path with real binaries", async () => {
    const sb = await makeSandbox({ signers: allowedSignersText(key), base: srv.base });
    const env = { TROPOS_TEST_RELEASES_BASE: srv.base };
    const installed = await sb.run([], { env });
    expect(installed.stderr).toBe("");
    expect(installed.code).toBe(0);
    const link = join(sb.home, ".local/bin/tropos");
    expect(await readlink(link)).toEndWith(`/versions/${pkg.version}`);

    publishFixture(srv, await makeFixtureRelease({ version: "99.0.0", key, dir }));
    srv.put("channels", "latest", "99.0.0\n");
    const run = (bin: string, args: string[]) =>
      Bun.spawn([bin, ...args], { env: { PATH: "/usr/bin:/bin", HOME: sb.home, ...env }, stdout: "pipe", stderr: "pipe" });
    const update = run(link, ["update"]);
    expect(await update.exited).toBe(0);
    expect(await readlink(link)).toEndWith("/versions/99.0.0");

    const rollback = run(join(sb.home, ".local/share/tropos/versions", pkg.version), ["rollback"]);
    expect(await rollback.exited).toBe(0);
    expect(await readlink(link)).toEndWith(`/versions/${pkg.version}`);
  }, 180_000);
});
```

- [ ] **Step 2: Run it**

Run: `bun test test/install/install-sh.e2e.test.ts`
Expected: PASS.

- [ ] **Step 3: Full gate on the branch**

Run: `bun run typecheck && bun test && bun run test:coverage && shellcheck -s sh install.sh scripts/release/make-manifest.sh scripts/release/collect-assets.sh`
Expected: PASS. Push and confirm all `ci` jobs pass on the six platforms.

- [ ] **Step 4 (owner checkpoint): Release dry run in a scratch repository**

Use a scratch repository (e.g. `Tropos-AI/tropos-release-dryrun`) with its **own throwaway key** — never the real key:
1. Push this branch's tree to the scratch repo's `main`, with `GITHUB_REPOSITORY`-dependent strings left as they are (workflows read the repository from the context). In the scratch copy only, change `RELEASE_REPO`/`CHANNELS_REPO` in `src/install/urls.ts` and the URLs in `install.sh`'s `release-urls` block to the scratch repo, and put the throwaway key into `release/allowed_signers` and `install.sh`.
2. Create the `release-signing` environment (main only, reviewer required) with the throwaway private key; set `package.json` version to `0.0.1`.
3. Push tag `v0.0.1`. Expected: `release-build` passes on six platforms → `release` waits for approval → approve → draft → smoke-draft (6) → publish → smoke-public (a only; b and c skipped as the first release) → promote-latest creates `channels`, all four slots `0.0.1`, GitHub latest `v0.0.1`.
4. On a clean macOS machine and a clean Linux container: `curl -fsSL https://github.com/<scratch>/releases/latest/download/install.sh | sh` installs `0.0.1`; `tropos --version` prints `0.0.1 (Tropos Code)`.
5. Bump to `0.0.2`, tag. Expected: smoke-public b and c run (old installer and stable binary verify the new release) and pass; `latest` moves to `0.0.2`; `tropos update` on the machines from step 4 moves to `0.0.2`.
6. Run `promote` with `0.0.2`. Expected: `stable` and `stable.bak` become `0.0.2`. Run `channels-health`. Expected: green.
7. Failure drill: in a commit, make `--version` print something else, bump to `0.0.3`, tag. Expected: smoke-draft fails; the release stays a draft; `channels/latest` still `0.0.2`; GitHub latest still `v0.0.2`; machines stay on `0.0.2`.
8. Interruption drill: re-run `promote-latest` for `0.0.2` from the Actions UI. Expected: green with no changes (convergent).
9. Delete the scratch repository and the throwaway key.

Record each expected/actual outcome (with run links) in Appendix B of the spec as "Revision 4 — implemented".

- [ ] **Step 5: Commit**

```bash
git add test/install/install-sh.e2e.test.ts docs/superpowers/specs/2026-10-13-install-update-design.md
git commit -m "test(install): install.sh-to-binary e2e; record the release dry run

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Spec coverage map

| Spec | Tasks |
|---|---|
| §1 success criteria | 21, 22, 29, 30 |
| §2 decisions | 2 (spike), throughout |
| §4.2 trust roots, pinned key in three places | 5, 21, 22, 24, 29 |
| §4.3 verification rules | 5, 6, 22 |
| §4.4 threats | 8 (bombs), 10 (permissions), 13 (symlinks), 16 (immutability), 19 (env), 28 (signing isolation) |
| §5.1–5.3 platforms, assets, manifest | 4, 6, 7, 25 |
| §5.4 channels and slots | 9, 22, 26 |
| §6, §6.1, §6.2 signing, rotation, trust boundary | 2, 26, 28, 29 |
| §7.1–7.6 pipeline, promotion, bootstrap, invariants | 26, 27, 28, 30 |
| §8 install.sh | 22, 23, 24 |
| §9 layout and state | 10, 12 |
| §10.1 locks | 11, 21 |
| §10.2 predicates, activation, immutability | 13, 14, 16 |
| §10.3 install, `--self`, `--force` | 16 |
| §10.4 channel resolution, downloads | 8, 9 |
| §10.5 cleanup | 15 |
| §10.6 recovery | 14, 17 |
| §10.7 rollback | 16 |
| §10.8 errors and exit codes | 3, 20 |
| §11 background updates | 19, 21 |
| §12 CLI | 1, 18, 20 |
| §13 layers 1–12, R1–R9 | 3–30 (each test names its layer or R-id); layer 9 key rotation: 24 |
| §14 compatibility and migration | 1, 18, 22 |
| §16 infrastructure checks | 2 |
