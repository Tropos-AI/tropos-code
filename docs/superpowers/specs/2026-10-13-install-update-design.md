# Tropos Code — Install and Update System — Design Spec

**Date:** 2026-10-13 · **Owner:** Tropos Labs · **Status:** Sections 1–4 approved in conversation; revision 2 addresses the eight written-spec review issues (Appendix B); pending approval

## 1. Purpose

Give Tropos Code a production-grade native install and update system modelled on Claude Code's
(evidence in Appendix A): a one-line `curl | sh` installer, versioned side-by-side installs behind
an atomically switched symlink, signed release manifests, `tropos install | update | upgrade |
rollback`, and quiet background updates.

**Success criteria:**

1. On all six platforms (§5.1), `curl -fsSL https://github.com/Tropos-AI/tropos-code/releases/latest/download/install.sh | sh`
   installs a signature-verified `tropos` on a machine that has never had it.
2. `tropos update` moves to the newest release of the configured channel; `tropos install <target>`
   installs `stable`, `latest` or an exact version; `tropos rollback` returns to the previous version.
3. Every binary that becomes runnable through `~/.local/bin/tropos` was verified against a manifest
   signed by a pinned ed25519 key. Every check fails closed.
4. An interrupted install, update, rollback or cleanup — at any point — leaves `tropos`
   either runnable from a verified version or, when no verified version exists (for example an
   interrupted first install), absent with a clear message. The next run repairs any
   inconsistency, and an unverified binary is never activated.
5. No running session ever loses its binary; a release that fails CI on any platform never
   becomes the target of a channel pointer or GitHub's "latest" release.
6. Every existing `tropos` invocation parses exactly as before, except the bare subcommand shapes
   listed in §12.2.

## 2. Decisions

| Decision | Choice | Why |
|---|---|---|
| Hosting | GitHub Releases on `Tropos-AI/tropos-code` | User choice; free, no infrastructure |
| Release layout | One release per `vX.Y.Z` + a long-lived `channels` release holding `latest` and `stable` pointer files | User choice (option A); mirrors Claude Code's `BASE/latest`, `BASE/<v>/manifest.json`; plain downloads avoid the 60 req/h unauthenticated API limit |
| Channels | `latest` and `stable` | User choice; Claude Code has both (Appendix A) |
| Signature format | SSHSIG (OpenSSH `ssh-keygen -Y`) with ed25519 | macOS LibreSSL 3.3.6 has no ed25519; `ssh-keygen -Y verify` ships on macOS and mainstream Linux and was verified on this machine |
| Signing key | OpenSSH ed25519 private key in a protected GitHub Actions Environment `release-signing` | User choice |
| Release privilege split | Unprivileged `release-build.yml` runs at the tag; privileged `release.yml` is defined on `main` (`workflow_run`) and treats everything from the tag as data | No code from the tag runs where the signing key or a write token is available (§6.2) |
| Pointer redundancy | Each channel has a primary and a `.bak` slot, written one at a time | `gh release upload --clobber` deletes before uploading; one slot always names a verified version (§5.4) |
| `install <channel>` | One-time install; never changes the configured update channel | Settings stay the single source of truth for background updates (§11) |
| Client-side verifier | `install.sh`: `ssh-keygen -Y verify`; `tropos`: SSHSIG parser + `node:crypto` ed25519 (no runtime dependency on `ssh-keygen`) | Dependency-light; parity-tested against `ssh-keygen` output |
| Compression | zstd (`-19`) alongside raw binaries | User choice; raw fallback when `zstd` is absent |
| Platforms | darwin-arm64, darwin-x64, linux-x64, linux-arm64, linux-x64-musl, linux-arm64-musl | Bun 1.4 cross-compiles both musl targets (verified); Windows out of scope (POSIX Bash tool) |
| Locking | Kernel advisory locks (`flock(2)` via `bun:ffi`) | Released by the kernel on process death; no PID or age heuristics. Verified in a compiled binary on darwin-arm64 |
| CLI shape | Native subcommands with exact-shape matching | User choice (option a) |
| Installer shell | POSIX `sh` | Alpine has no bash by default |

## 3. Architecture

```
install.sh                    public bootstrap installer (POSIX sh), uploaded to every release
release/allowed_signers       pinned trusted public keys (principal "tropos-release")
scripts/install-local.sh      the former root install.sh: installs a local build (bun run install:local)
scripts/release/              run only from a checkout of main (§6.2)
  make-manifest.sh            canonical manifest writer (POSIX sh)
  manifest.awk                canonical-form grammar; install.sh embeds an identical copy
  promote.ts                  convergent pointer promotion, bootstrap, check and repair
                              (injected GitHub client; Bun/Node built-ins only, no bun install)
.github/workflows/
  release-build.yml           tag push, unprivileged: verify tag → build → test artifacts
  release.yml                 defined on main, workflow_run after release-build: prepare → sign →
                              draft → smoke → publish → smoke → promote
  promote.yml                 manual, from main: move the stable channel to a verified version
  channels-health.yml         scheduled, from main: check (and repair) pointers
src/install/
  platform.ts                 platform string detection (same rules as install.sh)
  sshsig.ts                   SSHSIG parsing and ed25519 verification
  trust.ts                    pinned keys, principal, namespaces
  manifest.ts                 strict parser + canonical re-serialisation
  channels.ts                 channel → version resolution, retries, fallback
  fetch.ts                    bounded streaming downloads with hashing
  layout.ts                   on-disk paths (XDG-aware) and permission checks
  flock.ts                    flock(2) binding per platform
  locks.ts                    install lock and per-version in-use locks
  state.ts                    install.json read/atomic write/rebuild
  errors.ts                   InstallError kinds and exit codes
  installer.ts                install / switch / health check / rollback / cleanup / recovery
  autoupdate.ts               background update decision and spawn
  commands.ts                 install | update | upgrade | rollback command handlers
src/cli/args.ts               subcommand recognition before the existing parser
```

Each `src/install/` module has one purpose and is tested in isolation; `installer.ts` depends on
the others through interfaces so tests can inject a fake network, clock, spawner, crash points
and trust set. Nothing in `src/install/` imports UI code.

## 4. Security model

### 4.1 What is protected

The integrity and authenticity of every binary that `~/.local/bin/tropos` can resolve to, and
the user's ability to keep running a working `tropos` through failures.

### 4.2 Trust roots

| Moment | Trust root |
|---|---|
| First install via `curl \| sh` | GitHub's HTTPS delivery of `install.sh` (documented, §8.1); thereafter the ed25519 key pinned inside `install.sh` |
| First install, verify-first route | The key fingerprint published in the README and on every release page, checked by the user with `ssh-keygen -Y verify` on `install.sh` + `install.sh.sig` |
| Every later install/update | The key set compiled into the running `tropos` binary (`src/install/trust.ts`) |

The pinned key appears in exactly three places — `install.sh`, `release/allowed_signers`,
`src/install/trust.ts` — and a test fails if they differ. There is **no** runtime override of
the key set (no env var, flag or setting). Tests substitute keys in a temporary copy of
`install.sh` and inject a key set into the TypeScript API.

### 4.3 Verification rules (both clients)

- Signatures are verified with an explicitly pinned principal (`tropos-release`), namespace and
  key set. Namespaces: `tropos-manifest` for `manifest.json`, `tropos-installer` for `install.sh`.
  A signature for one namespace never validates the other.
- `install.sh` runs exactly
  `ssh-keygen -Y verify -f <pinned file> -I tropos-release -n tropos-manifest -s manifest.json.sig < manifest.json`.
  `ssh-keygen -Y check-novalidate` is never used.
- The manifest is parsed only after its signature verifies.
- Binaries are accepted only when size and SHA-256 match the verified manifest.
- If verification is impossible (no `ssh-keygen`, or one without `-Y verify`), installation stops.
  There is no checksum-only mode.

### 4.4 Threats and mitigations

| Threat | Mitigation |
|---|---|
| Tampered binary or manifest on GitHub or in transit | Signature over the manifest; SHA-256 + size per asset |
| Tampered channel pointer forcing a downgrade | Pointers are unsigned by design; the manifest's signed `version` must equal the pointer's; automatic updates never move to a lower version (§11) |
| Truncated `install.sh` download | Whole script inside `main()`, called on the last line |
| Decompression bomb or malformed `.zst` | Only a `.zst` whose size and SHA-256 match the signed manifest is decompressed; output is bounded by a file-size limit, the decoder's exit status/errors are checked, and the output must be exactly `size` bytes with the manifest's SHA-256 (§8.2, §10.3) |
| Path traversal via manifest or state | Versions match a strict semver regex and asset names match exactly before use in any path |
| Malicious or accidental symlinks in the install tree | `lstat` checks: version files must be regular files; directories must not be symlinks; `bin/tropos` is only replaced if it is a symlink into our `versions/` (or with `--force`) |
| Group/world-writable install directories | Refuse to install into, or switch through, a directory writable by others or owned by another user |
| Signing key exposure via code from the tag | Privileged jobs are defined on `main`, run only `main`'s tooling and runner-image tools, and handle tag outputs as data (§6.2) |
| Replacing or deleting a binary a process is running | Verified binaries are immutable; replacement of a damaged one and every deletion require an exclusive per-version lock (§10.2, §10.5) |
| Activating an unverified binary | Every activation (install, rollback, recovery) requires signature + hash verification and a health check (§10.2, §10.6) |
| Credentials leaking into the updater | The background updater runs with an allow-listed environment (§11) |
| A malicious repo pinning the user to an old version | `autoUpdates` and `autoUpdatesChannel` are honoured only from trusted settings layers (§11) |
| Broken release reaching users | Draft smoke tests, public smoke tests and old-client compatibility checks on all six platforms gate every pointer move (§7) |

### 4.5 Out of scope

- An attacker who can already write to the user's home directory as the user (they can edit
  shell startup files). The permission and symlink checks above guard against corruption,
  mistakes and other users, not against the same user.
- Remote revocation of a compromised signing key. Recovery from compromise is: rotate the key,
  publish a release, and ask users to reinstall with `install.sh`. Documented in `docs/install.md`.

## 5. Release artifacts

### 5.1 Platforms

`darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`, `linux-x64-musl`, `linux-arm64-musl`.
`build.ts` gains `bun-linux-x64-musl` and `bun-linux-arm64-musl` in `TARGETS`.

### 5.2 Assets of release `vX.Y.Z`

```
manifest.json                 manifest.json.sig      (SSHSIG, namespace tropos-manifest)
install.sh                    install.sh.sig         (SSHSIG, namespace tropos-installer)
tropos-<platform>             tropos-<platform>.zst  (for each of the six platforms)
verified.json                 uploaded only after all gates pass (§7.4)
```

### 5.3 Manifest format

```json
{
  "schema": 1,
  "version": "0.2.0",
  "commit": "0123456789abcdef0123456789abcdef01234567",
  "buildDate": "2026-10-13T12:00:00Z",
  "platforms": {
    "darwin-arm64": {
      "asset": "tropos-darwin-arm64",
      "sha256": "<64 lowercase hex>",
      "size": 61234567,
      "zst": {
        "asset": "tropos-darwin-arm64.zst",
        "sha256": "<64 lowercase hex>",
        "size": 18234567
      }
    },
    …
  }
}
```

**Canonical form.** The manifest has exactly one valid byte sequence for given values:
two-space indentation, keys in the order shown, platforms in the §5.1 order, all six platforms
present, LF line endings, one trailing newline, no other whitespace. `make-manifest.sh` writes
this form.

**Field rules.**

| Field | Rule |
|---|---|
| `schema` | `1` |
| `version` | `^(0\|[1-9][0-9]*)\.(0\|[1-9][0-9]*)\.(0\|[1-9][0-9]*)$` (no prerelease suffixes in v1) |
| `commit` | `^[0-9a-f]{40}$` |
| `buildDate` | `^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$` |
| `asset` | exactly `tropos-<platform>`; `zst.asset` exactly `tropos-<platform>.zst` |
| `sha256` | `^[0-9a-f]{64}$` |
| `size` | decimal integer, no leading zeros, 1 … 1073741824 (1 GiB) |

**Strict parsing.**
- `install.sh` validates every line of the verified manifest against an `awk` grammar of the
  canonical form. Any unknown, missing, duplicated or reordered line, or any field breaking the
  rules, rejects the manifest.
- `manifest.ts` parses with a strict zod schema, re-serialises canonically and requires the result
  to be byte-identical to the signed bytes. This rejects duplicate keys (which `JSON.parse`
  would silently collapse), reordering and whitespace changes.
- Both clients require `version` to equal the version requested (explicit target) or named by
  the channel pointer.

### 5.4 The `channels` release

Tag `channels`, created with `--prerelease --latest=false` by the first promotion (§7.5); it is
never marked latest. Assets, each containing one version string and a newline:

| Asset | Role |
|---|---|
| `latest`, `latest.bak` | primary and backup slot of the `latest` channel |
| `stable`, `stable.bak` | primary and backup slot of the `stable` channel |

Promotion writes the `.bak` slot first, reads it back, then the primary, and reads that back
(§7.4). Because `gh release upload --clobber` deletes the old asset before uploading, at most one
slot of a channel is ever missing, and both slots only ever name verified releases. Clients try
the primary, then `.bak` (§8.2, §10.4).

Every version release is published with `--latest=false` and only later marked latest by the
promotion step, so GitHub's "latest release" always names a fully verified version release.

URLs (all plain downloads):

```
https://github.com/Tropos-AI/tropos-code/releases/download/channels/{latest,latest.bak,stable,stable.bak}
https://github.com/Tropos-AI/tropos-code/releases/download/v<version>/<asset>
https://github.com/Tropos-AI/tropos-code/releases/latest/download/<asset>     (fallback, §10.3)
```

## 6. Signing and key management

- **Key:** OpenSSH ed25519, no passphrase, comment `tropos-release`. Private key in the secret
  `TROPOS_RELEASE_SIGNING_KEY` of the GitHub Actions Environment `release-signing`.
- **Environment protection:** deployments only from `main` (the privileged workflow runs from
  `main`, §7.1); required reviewer approval for every run; the secret exists nowhere else.
- **`v*` tags** are protected by a repository ruleset: only maintainers may create them, and
  they cannot be moved or deleted.
- **Sign job** (§7.3 step 2): no checkout of the tag; it downloads exactly two files,
  `manifest.json` and `install.sh`, produced by the unprivileged `prepare` job. It sparse-checks
  out `scripts/release/` and `release/allowed_signers` from `main` at the workflow's commit,
  re-validates the manifest with `scripts/release/manifest.awk`, writes the key to a `umask 077` temporary file,
  signs `manifest.json` (namespace `tropos-manifest`) and `install.sh` (namespace
  `tropos-installer`), verifies both signatures against `release/allowed_signers`, uploads the
  two `.sig` files, and deletes the key file in an `always()` step. It uses only shell, the
  runner image's `ssh-keygen`/`awk`, and actions pinned by full commit SHA.
- **Setup (one-time, by the owner):** `ssh-keygen -t ed25519 -N "" -C tropos-release -f tropos-release`;
  store the private key in the environment secret; commit the public key to
  `release/allowed_signers`, `install.sh` and `src/install/trust.ts`; publish the fingerprint
  (`ssh-keygen -lf tropos-release.pub`) in the README; create the `v*` tag ruleset and the
  environment rules. `docs/install.md` carries these steps.

### 6.1 Key rotation (K1 → K2)

`allowed_signers` holds one line per trusted key, all with principal `tropos-release`; clients
accept a signature from any listed key.

1. **Phase 1.** Add K2 to the trusted set in all three places. Release N is still signed with K1.
2. **Phase 2.** Once the installer on GitHub's latest release and the binary in `channels/stable`
   both trust K2 (both ≥ N), switch the environment secret to K2. The old-client compatibility
   gate (§7.3 step 6) enforces this: a K2-signed release that the published installer or the
   stable binary cannot verify fails the gate and is never promoted.
3. **Phase 3.** A later release removes K1 from the trusted set.

Binaries older than N cannot verify K2 signatures; their `update` fails with an `integrity`
error whose message says to reinstall with `install.sh`.

### 6.2 Trust boundary of the release pipeline

| Trusted | Why |
|---|---|
| GitHub (hosting, Actions, hosted runner images including `ssh-keygen`, `zstd`, `gh`) | Platform the project already depends on |
| The `main` branch (protected, reviewed) | Defines `release.yml`, `promote.yml`, `channels-health.yml` and the `scripts/release/` tooling they run |
| Maintainers who can create `v*` tags and approve `release-signing` | Human gate on every signature |
| Third-party actions | Only official actions, pinned by full commit SHA |

**Treated as data by every privileged job:** everything at the tag — source, `build.ts`,
dependencies from `bun.lock`, `install.sh`, and the built binaries. **No job that can read the
signing key or holds a `contents: write` token executes a binary, script or dependency from the
tag.** Smoke tests, which do execute release binaries, run in separate jobs with read-only
tokens and no secrets.

**What a signature attests:** these exact bytes were built by `release-build.yml` from tag
`v<x>`, whose commit is on `main`, and a maintainer approved signing them. **It does not attest
that the build was free of a compromised dependency:** malicious code in a `bun.lock`
dependency would be built into a binary that then gets signed. Mitigations: tag commits must be
on reviewed `main`; `bun install --frozen-lockfile`; reviewer approval. Reproducible builds and
build-provenance attestations are out of scope (§15) and are the natural next step.

## 7. Release pipeline

### 7.1 Workflows, triggers and concurrency

| Workflow | Defined at | Trigger | Privileges |
|---|---|---|---|
| `release-build.yml` | the tag | push of `v*` | `contents: read`, no secrets |
| `release.yml` | `main` | `workflow_run` of `release-build` (completed, success, `head_branch` matches `v*`); `workflow_dispatch` with a `tag` input to resume (refuses refs other than `main`) | per job, below |
| `promote.yml` | `main` | `workflow_dispatch` with `version` (refuses refs other than `main`) | `contents: write` in the promote job |
| `channels-health.yml` | `main` | schedule every 6 h, `workflow_dispatch` | `contents: write` only when `repair` is requested |

`release.yml`, `promote.yml` and `channels-health.yml` share the concurrency group `channels`
with `cancel-in-progress: false`, so no two of them change pointers at the same time. GitHub
keeps at most one pending run per group and cancels older pending ones; a cancelled run changed
nothing and is simply re-run, because `promote.ts` is convergent (§7.4).

### 7.2 `release-build.yml` (unprivileged)

1. **verify-tag** — tag equals `v` + `package.json` version; the tagged commit is an ancestor of
   `main`.
2. **build** — `bun install --frozen-lockfile`; `bun run build:all` (six targets) on
   `ubuntu-24.04`.
3. **test-artifacts** (6 platforms) — the installer/engine e2e suites (§13 layers 3–5, 9–11)
   against the exact artifacts from step 2.
4. **upload** — artifact `release-inputs`: the six binaries and `install.sh`.

### 7.3 `release.yml` (privileged, defined on `main`)

1. **prepare** (`contents: read`) — check out `main`; confirm the tag still points at the
   `workflow_run` head commit (for a dispatched resume: the newest successful `release-build` run
for that tag) and that commit is on `main`; download that run's `release-inputs`; require
   exactly the six expected binary names plus `install.sh`; compress each binary with
   `zstd -19 --check` and confirm the round trip is byte-identical; write `manifest.json` with
   `scripts/release/make-manifest.sh`; validate it with both parsers (§5.3). Upload
   `to-sign` (`manifest.json`, `install.sh`) and `release-assets`.
2. **sign** (`release-signing` environment) — §6.
3. **draft** (`contents: write`) — `gh release create v<x> --draft --latest=false` with all §5.2
   assets except `verified.json`. Re-running finds the existing draft and uploads only missing
   assets.
4. **smoke-draft** (6 platforms, `contents: read`) — `gh release download` with the workflow
   token into a folder; `TROPOS_INSTALL_FROM=<folder> sh install.sh <x>`; `tropos --version`
   must print `<x> (Tropos Code)`. (Draft assets are not publicly downloadable, so commands that
   fetch from the network run in step 6.)
5. **publish** (`contents: write`) — `gh release edit v<x> --draft=false --latest=false`.
6. **smoke-public** (6 platforms, `contents: read`) —
   a. `curl -fsSL …/releases/download/v<x>/install.sh | sh -s <x>` on a clean `HOME`, then
      `tropos install <x>` must succeed as a no-op;
   b. **old installer:** download `install.sh` from GitHub's current latest release (the
      previous version) and run `sh install.sh <x>` on a clean `HOME`;
   c. **old binary:** on a clean `HOME`, install the version in `channels/stable` with its own
      installer, then run that binary's `tropos install <x>`.
   All must end with `tropos --version` printing `<x> (Tropos Code)`. b and c are skipped only
   when no previous release exists (no `channels` release and no GitHub latest release).
7. **promote-latest** (`contents: write`) — `scripts/release/promote.ts latest <x>` from the
   `main` checkout (§7.4).

### 7.4 `promote.ts` — convergent promotion

Every step first checks whether its effect is already in place and skips itself if so, so a run
interrupted at any point is resumed by running the same command again. Before every write it
re-reads the slot; if the slot changed to a value this run did not write, it stops with an
error instead of overwriting.

**`promote.ts latest <x>`:**

1. **Validate:** `v<x>` is published (not a draft); its `manifest.json` verifies against `main`'s
   `release/allowed_signers` (via `ssh-keygen -Y verify`) and names version `<x>`.
2. **Bootstrap** the `channels` release if absent (§7.5).
3. **Order check:** let `L` be the highest valid version among `latest` and `latest.bak`. If
   `L > x`, refuse. Otherwise continue; whether each slot still needs writing is decided per
   slot in step 5 (after an interruption, `latest.bak` may already hold `x` while `latest` does
   not).
4. **Record verification:** if `verified.json` is absent, upload
   `{version, commit, runId, verifiedAt}`; if present with the same `version` and `commit`,
   skip; if present with different values, fail.
5. **Write slots:** `latest.bak := x`, read back until it returns `x` (bounded retries); then
   `latest := x`, read back. Each write is skipped if the slot already holds `x`.
6. **First-release stable:** if neither `stable` nor `stable.bak` exists, write them the same way
   with `x` (§7.5).
7. **GitHub latest:** if GitHub's latest release is not `v<x>`, run `gh release edit v<x> --latest`
   and read it back through the API.

So a promotion interrupted after step 5 (both slots already `x`, GitHub latest still the old
release) resumes with steps 4–6 finding their effects in place and skipping themselves, and
step 7 marking `v<x>` latest. Interrupted between the two slot writes, it resumes by writing
only `latest`.

**`promote.ts stable <x>`:** validate as in step 1 and require `verified.json`; require
`x ≤` the current `latest` (stable never runs ahead of latest) and `x ≥` the current `stable`,
where "current" means the highest valid version among the channel's two slots;
then write `stable.bak` and `stable` as in step 5.

**`promote.ts check [--repair]`:** for each channel, both slots must exist, hold valid versions,
name releases with `verified.json` whose manifests verify, and be equal; GitHub's latest
release must equal `channels/latest`. With `--repair`: a missing or invalid slot is rewritten
from the other slot; if both are valid and verified but differ (an interrupted promotion),
both are set to the higher of the two — normally `.bak`, which is always written first; GitHub
latest is set to `channels/latest`. Repairs never point a slot at an unverified release and
never lower a slot that holds a valid, verified version. If neither slot is valid and verified,
repair changes nothing and the check fails for a maintainer to resolve.

**`promote.yml`** runs `promote.ts stable <version>`. **`channels-health.yml`** runs
`promote.ts check` every 6 hours and `check --repair` when dispatched with `repair: true`; a
failed check fails the workflow, which notifies maintainers.

### 7.5 First-release bootstrap

On the first release, `promote.ts latest <x>` finds no `channels` release. It creates it
(`gh release create channels --prerelease --latest=false`, with notes saying it holds channel
pointers), then writes `latest.bak`, `latest`, `stable.bak` and `stable` (all `x`), then marks
`v<x>` as GitHub latest. Until that run finishes, `install.sh stable` fails with "no release
has been published yet". `install.sh` (latest) fails the same way unless GitHub already reports
`v<x>` as its latest release — GitHub's behaviour for a repository's first release published
with `--latest=false` is confirmed in §16 — and in either case only a signed manifest is
accepted. Explicit versions work from the moment the release is published.

### 7.6 Promotion invariants

- `latest`, `latest.bak`, `stable`, `stable.bak` and GitHub's latest release only ever name a
  release that has `verified.json` and a manifest that verifies.
- For each channel, at least one slot names a verified release at every moment after the
  channel's first promotion.
- `latest` never moves backwards; `stable` never moves backwards and never exceeds `latest`.
- If any gate fails, the release stays as it is (draft, or published with `--latest=false`) and
  no pointer moves.

## 8. `install.sh`

### 8.1 Delivery and trust bootstrap

- One-liner: `curl -fsSL https://github.com/Tropos-AI/tropos-code/releases/latest/download/install.sh | sh`
  (optionally `| sh -s -- stable` or `-s -- 0.3.0`).
- `docs/install.md` states that this route trusts GitHub's HTTPS for the first download, and
  documents the verify-first route: download `install.sh` and `install.sh.sig` from a release,
  write the published key into an allowed-signers file, run
  `ssh-keygen -Y verify -f allowed_signers -I tropos-release -n tropos-installer -s install.sh.sig < install.sh`,
  compare the key's fingerprint with the README, then run `sh install.sh`.
- The current root `install.sh` (local-build installer) moves to `scripts/install-local.sh`,
  run with `bun run install:local`; README updated.

### 8.2 Flow

The script is POSIX `sh`, lives entirely inside `main() { … }` invoked on its last line, and
uses `set -eu`. It creates a private temporary folder (`mktemp -d`, mode 0700) removed by a
`trap` on `EXIT INT TERM HUP`.

1. **Arguments:** zero or one of `stable`, `latest`, or an exact version (§5.3 regex). Default
   `latest`. Anything else: usage error, exit 64.
2. **Root guard:** if `id -u` is 0 and `SUDO_USER` is set to a non-root user, refuse unless
   `TROPOS_INSTALL_ALLOW_SUDO=1`.
3. **Dependencies:** `curl` or `wget`; `shasum -a 256` or `sha256sum`; `ssh-keygen` supporting
   `-Y verify`; `awk`; `uname`; `mktemp`. `zstd` optional. Missing a required tool:
   error naming the package for apt (`openssh-client`), apk (`openssh-keygen`), dnf and brew; exit 1.
4. **Platform:** `uname -s` ∈ {Darwin, Linux}; `uname -m` ∈ {x86_64, amd64, arm64, aarch64};
   on Darwin x64, `sysctl -n sysctl.proc_translated` = 1 → arm64; on Linux, musl if
   `/lib/ld-musl-*.so.1` exists or `ldd /bin/sh` mentions musl. Anything else: clear error.
5. **Resolve version:** explicit version → use it. Channel → fetch `channels/<channel>`
   (connect timeout 10 s, total 30 s, 3 attempts, backoff 1 s/2 s/4 s); content must match the
   version regex. If that fails, fetch `channels/<channel>.bak` the same way. If both fail and
   the channel is `latest`, fetch `releases/latest/download/manifest.json` instead and take its
   version after verification. If both slots of `stable` fail: error ("cannot resolve the
   stable channel; try again, or install an explicit version").
6. **Manifest:** download `manifest.json` and `manifest.json.sig` (same retry policy); verify the
   signature (§4.3); validate with the `awk` grammar; check the version. If verification fails,
   installation stops; a probe of `ssh-keygen -Y` support only chooses the error message
   ("your ssh-keygen is too old; install OpenSSH ≥ 8.1" vs "signature verification failed").
7. **Binary.** Every download and decompression runs in a subshell with a file-size limit,
   `( ulimit -f <blocks>; … )`, where `<blocks>` = ⌊expected size / 512⌋ + 2. Shells that count
   in 1024-byte units allow up to twice that, which is still bounded; exact sizes are checked
   afterwards. No pipelines are used, so every exit status is seen.
   - **zst path** (only when `zstd` is present): download `tropos-<platform>.zst`; require exit 0,
     exactly `zst.size` bytes and the manifest's `zst.sha256`. Then decompress
     `zstd -d -q -c -- <zst> > <out>` under the limit for `size` and require: exit status 0
     (the decoder reports corrupt or truncated frames, content-checksum mismatches and trailing
     garbage as errors; a file-size-limit kill also exits non-zero); output exactly `size`
     bytes (catches excess data within the limit and short output); output SHA-256 equal to the
     manifest's `sha256`. Any failure deletes the outputs and falls back to the raw path.
   - **raw path:** download `tropos-<platform>` under the limit for `size`; require exit 0,
     exactly `size` bytes and the manifest's `sha256`. Failure: exit 1 with "checksum
     mismatch".
8. **Hand-off:** `chmod 700` the binary, which is still in the private temporary folder; run
   `"$bin" install --self --manifest <m> --signature <s>`. The binary re-verifies everything
   (§10.3) and copies itself into place.
9. **Exit:** on a signal death of the binary (exit ≥ 128) run `stty sane` if stdin is a terminal;
   if `~/.local/bin` is not on `PATH`, print the exact line to add for the user's shell (never
   edit startup files).

`TROPOS_INSTALL_FROM=<dir>` reads assets from a local folder instead of the network; it requires
an explicit version and changes nothing about verification. It exists for the draft smoke tests.

`mktemp` and `ulimit -f` behaviour vary slightly between shells; both are present on every
supported platform (macOS, GNU coreutils, busybox), and the test matrix covers each. `head -c`
is not used.

## 9. On-disk layout and state

| Path | Contents | Mode |
|---|---|---|
| `$DATA = ${XDG_DATA_HOME:-~/.local/share}/tropos` | | 0700 |
| `$DATA/versions/<v>` | verified binary | 0755 |
| `$DATA/versions/.corrupt-<v>-<ts>` | quarantined damaged binary (§10.3, §10.5) | as found |
| `$DATA/manifests/<v>/manifest.json`, `manifest.json.sig` | signed manifest of `<v>` | 0600 |
| `$DATA/staging/` | in-progress downloads (same filesystem as `versions/`) | 0700 |
| `$STATE = ${XDG_STATE_HOME:-~/.local/state}/tropos` | | 0700 |
| `$STATE/install.json` | engine state | 0600 |
| `$STATE/locks/install.lock`, `$STATE/locks/<v>.lock` | flock targets (never deleted) | 0600 |
| `$STATE/update.log` | background updater log (rotated at 1 MiB) | 0600 |
| `~/.local/bin/tropos` | symlink → `$DATA/versions/<v>` | — |

`XDG_*` variables are honoured only when set to absolute paths; `install.sh` and `layout.ts`
apply the same rule. The `~/.tropos` user-data directory (`TROPOS_HOME`) is unchanged.

**`install.json`:**

```json
{
  "schema": 1,
  "generation": 42,
  "current": "0.3.0",
  "previous": "0.2.0",
  "pending": null,
  "skip": { "0.3.1": "health-check" },
  "autoUpdate": { "lastCheck": "…", "failures": 0, "nextCheck": "…", "lastUpdated": "0.3.0", "announced": false }
}
```

`current` and `previous` may be `null` (nothing installed yet, or no verified previous
version). `pending` is `{ "op": "switch", "from": "<v>" | null, "to": "<v>" }` while a switch is
in progress; `from` is `null` on a first installation.
`skip` reasons are `health-check` (a verified binary failed its health check here) and
`rolled-back` (the user rolled back from it). State writes go to a temporary file in `$STATE`,
`fsync`, `rename` over `install.json`, then `fsync` the directory; `generation` increases on
every write. State is never trusted for integrity: every switch target is re-verified against its
stored signed manifest.

**Existing installs** from the local-build script (versions without a stored manifest) are
*unmanaged*: never deleted automatically, never a rollback target, and replaced by `update`.

## 10. Update engine

### 10.1 Locks

- `flock.ts` loads `flock(2)` with `bun:ffi` from `libSystem.B.dylib` (darwin), `libc.so.6`
  (glibc) or the musl loader (`/lib/ld-musl-<arch>.so.1`). If loading fails, `install`, `update`
  and `rollback` exit with a `local` error and cleanup is skipped.
- **Acquire pattern:** open (create) the lock file, `flock`, then compare `fstat(fd).ino` with
  `stat(path).ino`; if they differ, close and retry. Lock files are never unlinked.
- **Install lock** (`install.lock`, `LOCK_EX`): held by `install`, `update`, `rollback`, recovery
  and cleanup. Foreground commands wait up to 60 s, printing who holds it (from the file's
  informational `{pid, token, version, acquiredAt}`), then exit 75. The background updater uses
  `LOCK_NB` and exits quietly if busy. The lock is never reclaimed: the kernel releases it when
  the holder exits.
- **In-use lock** (`<v>.lock`, `LOCK_SH`): every invocation of a native binary
  (`process.execPath` inside `$DATA/versions/`) except `--version` and `--help` takes it at
  startup, then checks that `process.execPath` still exists; if not, it re-executes itself
  through `~/.local/bin/tropos` with the same arguments. Held for the life of the process.
  Because `flock` locks on separate open files conflict, a process's own `LOCK_SH` also makes
  its own cleanup keep its version. A process running from elsewhere (the temporary binary of
  `install --self`, a dev run) takes no in-use lock.

### 10.2 Verification predicates and rules

- **Verified(v):** `versions/<v>` is a regular file (by `lstat`) owned by the user;
  `manifests/<v>/manifest.json` and its `.sig` verify with the compiled-in key set; the manifest
  parses strictly and names version `v`; the file's size and SHA-256 equal the manifest entry
  for this machine's platform.
- **Healthy(v):** Verified(v), and `versions/<v> --version` (10 s timeout, §11 environment
  allow-list) exits 0 printing exactly `<v> (Tropos Code)\n`.
- **Activation rule:** `bin/tropos` is only ever pointed at a version that is Healthy at that
  moment — by install, rollback and recovery alike.
- **Immutability rule:** an existing `versions/<v>` is never overwritten in place. It is renamed
  aside (when damaged) or deleted (by cleanup) only while holding a non-blocking `LOCK_EX` on
  `locks/<v>.lock`, which cannot be obtained while any process runs `v`. All writers hold the
  install lock, so checks such as "does `versions/<v>` exist?" are race-free between Tropos
  processes.

### 10.3 Install a version (`installVersion`)

1. Take the install lock; run recovery (§10.6).
2. **Manifest:** fetch it (§10.4) or, for `--self`, read the given files. Verify the signature
   with the compiled-in key set, parse strictly, and require `version` to equal the requested
   version or the channel pointer's (for `--self`: the compiled-in `VERSION`).
3. **Existing `versions/<v>`:**
   - Verified → reuse it; nothing is downloaded or replaced.
   - Present but not Verified (damaged) → try a non-blocking `LOCK_EX` on `locks/<v>.lock`.
     *Acquired:* rename the file to `versions/.corrupt-<v>-<ts>`, then hold the lock through
     steps 4–5. *Busy:* leave the file untouched; if `v` is `current`, switch `bin/tropos` to
     the §10.6 fallback and record it as `current` (or, with no Healthy fallback, leave the
     symlink and report it) so new sessions do not start the damaged file; exit 75 with
     "version <v> is damaged and in use by running sessions; close them and run
     `tropos install <v> --force` again".
4. **Stage the bytes** in `staging/<v>.<random>`:
   - *Download:* zst preferred. The `.zst` is downloaded completely (bounded by `zst.size`) and
     must match `zst.size` and `zst.sha256` before decompression. It is then decompressed with
     `zlib.createZstdDecompress`, counting output: more than `size` bytes aborts immediately;
     any decoder error (corrupt or truncated frame, checksum mismatch, trailing data) fails;
     at the end the count must equal `size` and the SHA-256 must match. Any zst failure falls
     back to the raw asset (bounded by `size`; size and SHA-256 must match). A raw mismatch is
     retried up to 2 more times, then fails with `integrity`.
   - *`--self`:* copy `process.execPath` into staging, then hash **the staged copy** (so a
     change to the source after hashing cannot slip through); its size and SHA-256 must match
     the manifest entry for this platform.
5. `chmod 0755`, `fsync`, `rename` into `versions/<v>` (which does not exist at this point, by
   step 3), `fsync` the directory. Write the manifest and signature to `manifests/<v>/`
   atomically. Release any `<v>.lock` taken in step 3.
6. **Health check:** Healthy(v). Failure → `skip[v] = "health-check"`, `integrity` error
   "release <v> does not run on this machine"; `bin/tropos` untouched.
7. **Switch:** write `pending = {from: current (or null), to: v}`; create
   `bin/.tropos.<random>` → `versions/<v>`; `rename` it over `bin/tropos`; `fsync` `bin/`. This
   also runs when `v` is already current (an atomic no-op re-link).
8. **Post-switch check:** `realpath(bin/tropos)` equals `versions/<v>` and running it through
   `bin/tropos` passes the health check. Otherwise switch back to `from` if it is Healthy, else
   to the §10.6 fallback, else remove `bin/tropos`; record the skip; `integrity` error.
9. **State:** `current = v`; `previous = from` when `from` is a different version (otherwise
   unchanged); `pending = null`.
10. Cleanup (§10.5); release the install lock.

Explicit `tropos install <v>` clears `skip[<v>]` before starting.

**`install --self`** is the internal command `install.sh` runs. It is the one command that may
run from outside `$DATA/versions/` — from `install.sh`'s private temporary folder — and it
cannot bypass any check: the manifest and signature are verified with the compiled-in keys, the
manifest version must equal the compiled-in `VERSION`, the staged copy must match the manifest's
size and SHA-256 for this platform, and the health check, switch and post-switch check run as
for any version. This self-verification guards against a damaged copy; the trust that the
binary is genuine on first install comes from `install.sh`, which verified it before running it
(§4.2).

**`--force`** re-hashes an existing `versions/<v>` in full, re-fetches and re-stores its signed
manifest, re-runs the health check, performs the switch even if `v` is current, and allows
replacing a `bin/tropos` that is not ours. It never replaces a Verified file and replaces a
damaged one only under the immutability rule. So `tropos install <current> --force` run from the
current version itself is safe: a Verified file is kept; a damaged one is in use by this very
process, so the busy path of step 3 applies (and repoints `bin/tropos` to a healthy fallback).
It never skips a signature, hash or health check.

**Pre-switch safety checks:** `bin/` and `$DATA` must be directories (not symlinks), owned by
the user and not group/world-writable. `bin/tropos` must be absent or a symlink into
`$DATA/versions/`; otherwise refuse unless `--force`.

### 10.4 Channel resolution and downloads

- `channels.ts`: for a channel, fetch the primary slot with a 10 s timeout, 3 attempts and
  exponential backoff (1 s, 2 s, 4 s, ±20 % jitter); 404, HTML or content not matching the
  version regex counts as a failed attempt. Then the `.bak` slot the same way. Then, for
  `latest` only, `releases/latest/download/manifest.json` (taking the version after
  verification). All failing → `network` error (foreground) or a quiet skip with backoff
  (background).
- `fetch.ts`: HTTPS only, including after redirects (at most 5); aborts when the body exceeds
  the expected size; honours `HTTPS_PROXY`. Integrity comes from signatures and hashes, not from
  the host name.

### 10.5 Cleanup

Runs under the install lock. Unmanaged versions are never touched.

- A **managed version** is kept if any is true: it is `current`; it is `previous`; it appears in
  `pending`; it is among the 3 newest Verified versions; a non-blocking `LOCK_EX` on its
  `<v>.lock` fails. Otherwise, while holding that `LOCK_EX`, delete `versions/<v>` and
  `manifests/<v>/`, then release.
- A **quarantined** `versions/.corrupt-<v>-<ts>` older than 7 days is deleted only while holding
  a non-blocking `LOCK_EX` on `<v>.lock` (a process may still be running the damaged file).
- **Staging** entries older than 1 hour are deleted.

### 10.6 Recovery

Runs under the install lock at the start of `install`, `update`, `rollback` and the background
updater. It never activates a version that is not Healthy (§10.2).

**Fallback selection** returns the first Healthy version from: `current`, `pending.to`,
`pending.from`, `previous`, then the remaining managed versions newest first, excluding those
with `skip = "health-check"`. Unmanaged and unverified versions are never candidates.

| Found | Action |
|---|---|
| `install.json` missing or unparsable | Rebuild: `current` = the symlink's target if it is a managed Healthy version, else fallback selection; `previous` = the newest other Healthy version, or `null` |
| `pending` with `from: null` (interrupted first install) | If `bin/tropos` → `to` and `to` is Healthy: finish (`current = to`). Otherwise remove `bin/tropos` if it is our symlink, set `current = null`, clear `pending`, and report "installation did not complete; run install.sh again" |
| `pending` with `from: <v>` | If `bin/tropos` → `to` and `to` is Healthy: finish. Otherwise switch to `from` if Healthy, else to the fallback; clear `pending` |
| No `pending`, symlink ≠ `current` | If the symlink's target is a managed Healthy version: adopt it as `current` (old `current` becomes `previous` if Healthy). Otherwise switch to `current` if Healthy, else to the fallback |
| `current`'s file missing or not Verified | Switch to the fallback. A damaged file that is in use is left in place (immutability rule) and replaced later |
| `previous`'s file missing or not Verified | Set `previous = null`. Rollback then reports it instead of silently choosing another version |
| Symlink missing or dangling | Switch to the fallback |
| No Healthy candidate | Remove `bin/tropos` if it is our symlink, set `current = null`, and fail with `integrity`: "no verified Tropos version is installed; reinstall with install.sh" |
| Symlink → an unmanaged file and no state | Leave it alone (a local build the user installed) |
| Staging leftovers | Removed by cleanup |

### 10.7 Rollback

`tropos rollback`: take the lock, run recovery, then require `previous` to be non-null and
Healthy; otherwise exit 65 with "no verified previous version", listing the Healthy versions and
suggesting `tropos install <version>`. Switch to it (steps 7–9 of §10.3, with the old `current`
becoming `previous`) and set `skip[<old current>] = "rolled-back"` so the background updater does
not reinstall it.

### 10.8 Errors and exit codes

| Kind | Examples | Exit | Behaviour |
|---|---|---|---|
| `usage` | bad target, bad flags | 64 | — |
| `integrity` | bad signature, malformed manifest, decoder error, repeated hash mismatch, failed health check, no Healthy version | 65 | No retry in this run; only a failed health check adds a `skip` entry |
| `network` | DNS, timeout, 5xx, 429, reset | 69 | Retried as in §10.4 |
| `local` | `EACCES`, `ENOSPC`, `EROFS`, unsafe permissions, flock unavailable, not a native install | 73 | Clear message, no retry |
| `busy` | install lock held > 60 s; damaged version in use | 75 | — |
| other | unexpected | 1 | — |

Success, including "already up to date", exits 0.

## 11. Background auto-update

- **When:** at the start of an interactive session of a native install (`process.execPath` is
  inside `$DATA/versions/`), only if all hold: stdin and stdout are terminals; not `-p`; `CI`
  unset; `TROPOS_DISABLE_AUTOUPDATER` unset; trusted settings do not set `autoUpdates: false`;
  `now ≥ autoUpdate.nextCheck`.
- **Settings:** `autoUpdates` (boolean, default `true`) and `autoUpdatesChannel`
  (`"latest" | "stable"`, default `"latest"`) are read only from the user and user-project layers
  in `~/.tropos`. The existing repo-layer restriction drops them from `.tropos/settings*.json`
  with the usual warning.
- **How:** spawn `"$execPath" update --background` with `detached: true`, stdio to
  `$STATE/update.log`, `unref()`. The session never waits for it.
- **Environment:** only `HOME`, `PATH`, `TMPDIR`, `LANG`, `LC_*`, `XDG_DATA_HOME`,
  `XDG_STATE_HOME`, `HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY` (and lowercase forms),
  `SSL_CERT_FILE`, `SSL_CERT_DIR`. No API keys or other variables.
- **Decision:** resolve the configured channel; install only if the resolved version is
  **greater** than `current` and not in `skip`. Never moves to a lower version.
- **One-time installs:** `tropos install stable|latest|<version>` installs once. It never
  changes `autoUpdatesChannel`, `autoUpdates` or any other setting. When auto-updates are on
  and the target differs from the configured channel, the command ends with a notice:
  - channel target: "Background updates follow the '<configured>' channel and may move you to
    a newer version. To stay on '<target>', set "autoUpdatesChannel": "<target>" in
    ~/.tropos/settings.json."
  - explicit version: "Background updates follow the '<configured>' channel and may move you
    to a newer version. To stay on <version>, set "autoUpdates": false in
    ~/.tropos/settings.json."
- **Channel above current:** if `current` is higher than the configured channel's version (for
  example after switching the setting from `latest` to `stable`), `tropos update` reports "up to
  date" and stays there until the channel passes `current`.
- **Throttle:** `nextCheck = lastCheck + 6 h` after success; after a failure,
  `6 h × 2^failures`, capped at 48 h; success resets `failures`.
- **Announce:** after an update, the next session prints one line, "Updated to <v>", and sets
  `announced: true`.

## 12. CLI

### 12.1 Commands

```
tropos install [stable|latest|<version>] [--force]   install a version and make it active
tropos update                                        update to the newest version of your channel
tropos upgrade                                       same as update
tropos rollback                                      return to the previous version
```

Each accepts `-h`/`--help`. Internal shapes, hidden from help:
`install --self --manifest <path> --signature <path>` and `update --background`.
In a non-native install (dev run or local build), these commands exit 73 with
"not a native install; install with install.sh" — except `install --self`, which runs from
`install.sh`'s temporary folder by design (§10.3). `install <target>` is a one-time install and
does not change the update channel (§11).

### 12.2 Recognition rules (`args.ts`, before the existing parser)

1. If `argv[0]` is `--`, drop it and parse the rest with the existing parser; positionals form
   the prompt. (`tropos -- install` is a prompt.)
2. If `argv[0]` is `install`, `update`, `upgrade` or `rollback` and the whole of `argv` matches
   that command's shape exactly, it is that subcommand.
3. Otherwise, parse `argv` with the existing parser exactly as today. If that parse fails and
   `argv[0]` is a subcommand word, the usage error adds "for <cmd>, see tropos <cmd> --help".

Shapes: `install` + optional target (§5.3 regex, `stable`, `latest`) + optional `--force`;
`install --self --manifest <p> --signature <p>`; `update` / `upgrade` + optional `--background`;
`rollback`; any of these words + exactly `-h` or `--help`.

**The only invocations whose meaning changes** are those shapes. For example
`tropos update the readme`, `tropos update -p`, `tropos -p install` and `tropos install foo`
all behave exactly as today.

`USAGE` gains a "Commands" block. `--version` output is unchanged (`<v> (Tropos Code)`).

## 13. Testing strategy

All layers run with `bun test` unless noted. "6P" = all six platforms in CI.

| # | Layer | Content | Runs |
|---|---|---|---|
| 1 | Unit | `sshsig` vectors generated by `ssh-keygen` (valid, wrong namespace, untrusted key, non-ed25519 key, truncated armour, flipped bits); `manifest` against shared fixtures `test/fixtures/manifests/{valid,invalid}/`; `platform` table; `channels` with fake fetch/clock/random (retry count, backoff bounds, timeout, 404 vs 5xx, HTML pointer, fallback); error classification; `layout` XDG rules | every PR, macOS + Linux |
| 2 | Filesystem integration (temp `HOME`) | idempotent reinstall; tampered existing binary → quarantine + redownload; health-check failure → rollback + skip; rollback re-verifies; cleanup keep-rules table; unmanaged versions untouched | every PR |
| 3 | Concurrency (real processes) | two `update`s at once → one installs, the other waits/exits 75; session `LOCK_SH` survives cleanup; `kill -9` on the lock holder frees the lock; lock-file replacement detected by the inode check; session started during cleanup re-executes via the symlink | every PR, 6P |
| 4 | Crash and recovery | child process `SIGKILL`ed at injected points (after download, after rename into `versions/`, after `pending` write, after symlink swap, after state write, mid-cleanup); torn `install.json`. After each, recovery must leave `bin/tropos` → a Healthy version (or, for an interrupted first install, no `bin/tropos` and `current = null`), consistent state, no staging leftovers. Crash points injectable only through the TypeScript API | every PR, 6P |
| 5 | `install.sh` | under `dash`, busybox `ash`, macOS `/bin/sh` and bash 3.2, against a `Bun.serve` fixture server and a test copy with substituted key and base URL. Negative cases: tampered manifest; invalid signature; wrong namespace; untrusted signer; version mismatch; binary short or with extra bytes; corrupt `.zst` → raw fallback; both corrupt → fail; HTML pointer; 500 then success; server down; `latest` pointer down → GitHub-latest fallback; `stable` pointer down → fail; no `ssh-keygen`, or one without `-Y` (shim) → fail; no `curl`/`wget`; no hash tool; FreeBSD/i686/MINGW → fail; sudo refusal. Truncation: the script cut every 64 bytes and piped to `sh` runs nothing and creates no files. `shellcheck -s sh` | every PR, 6P |
| 6 | CLI compatibility | **first plan task** snapshots `parseCli` output for a table of existing invocations (prompts, every flag, `-r <uuid>`, `-p` with piped stdin, edge cases); the new parser must reproduce it exactly. Tables for subcommand shapes, `--`, usage errors | every PR |
| 7 | Parity | the invalid-manifest corpus is rejected identically by `manifest.ts`, `scripts/release/manifest.awk` and the copy embedded in `install.sh` (which must be identical to it); `make-manifest.sh` output is accepted by both; TS and `install.sh` platform detection agree under the same `uname` shims; the pinned key is identical in its three locations | every PR |
| 8 | Release gates | smoke-draft, smoke-public, old-installer and old-binary checks (§7.3) | release workflow, 6P |
| 9 | Key rotation | fixture keys K1, K2, K3. Installer/binary trusting {K1} accept K1 releases; phase-1 clients {K1,K2} accept K1 and K2 releases; {K1}-only clients reject K2 releases with the "reinstall" message; K3 signatures always rejected; the compatibility gate fails a K2 release when the published installer trusts only K1 | every PR (gate logic) |
| 10 | Auto-update | injected clock: 6 h throttle and failure backoff (12 h, 24 h, 48 h cap, reset); each disabling condition (non-TTY, `-p`, `CI`, env var, user setting, dev run) prevents spawning; repo-layer `autoUpdates` ignored; spawned environment contains only allow-listed variables (a fake binary dumps its env; seeded `ANTHROPIC_API_KEY` etc. must be absent); network failure → no state change except backoff; pointer naming a lower version or a `skip`ped version → no install; "Updated to" shown once | every PR, 6P for the spawn test |
| 11 | Filesystem security | `versions/<v>` as a symlink → refused; `bin/tropos` pointing outside `versions/` or a regular file → refused without `--force`; `$DATA` or `bin/` group/world-writable or a symlink → refused; manifest/state versions like `../x` or `1.0.0/../../` rejected before any path use; `.zst` expanding beyond `size` → aborted at the cap, nothing installed; binary modified after install → detected on reuse and rollback; `install.json` edited to name an unverified version → not switched to | every PR |
| 12 | Promotion failures | `promote.ts` against a fake GitHub client: failed smoke → no pointer change, release stays `--latest=false`; interruption after each step (verified.json, pointer upload, read-back, latest mark) → rerun converges; pointer never moves backwards; `stable` promotion refused without `verified.json` or with a bad signature; during the `--clobber` window a client resolves through the other slot (`.bak`), or for `latest` through GitHub's latest release; details in R2–R3, R7 | every PR |

### 13.1 Regression tests for the written-spec review

Each issue from the review (Appendix B) has dedicated tests; IDs are used in test names.

| ID | Scenario | Expected | Layer |
|---|---|---|---|
| R1.1 | `install --self` from a verified binary in a temp folder outside `$DATA` | Installs, switches, stores manifest | 2, 5 |
| R1.2 | `--self` with a tampered manifest, a signature from an untrusted key, `version ≠ VERSION`, a missing `--manifest`/`--signature`, or a binary whose bytes differ from the manifest | Rejected (65/64); nothing installed | 2, 11 |
| R1.3 | Source binary modified after it was copied to staging (injected) | Staged copy is what is hashed and installed; a modified staged copy is rejected | 2 |
| R1.4 | Any other subcommand run from a temp folder | Exit 73 "not a native install" | 6 |
| R2.1 | `promote.ts latest x` interrupted after each step (bootstrap, `verified.json`, `latest.bak`, `latest`, read-back, GitHub latest) and re-run | Converges; in particular `latest == x` with GitHub latest unset completes by marking latest | 12 |
| R2.2 | Slot changed by someone else between read and write | Stops without overwriting | 12 |
| R3.1 | `--clobber` upload of `stable` fails after deleting the asset | `stable.bak` still names a verified version; clients resolve through it; `check --repair` restores `stable` | 12, 5, 1 |
| R3.2 | Upload of `stable.bak` fails | `stable` untouched and verified; re-run converges | 12 |
| R3.3 | Slots differ (interrupted promotion); one slot invalid or naming an unverified release; both slots invalid | Clients pick a verified one; repair sets both to the higher verified value and never lowers a verified slot; with both invalid, repair changes nothing and the check fails | 12, 1 |
| R4.1 | Static policy check of workflow files | Jobs with the `release-signing` environment or `contents: write` contain no checkout of the tag, no `bun`, no execution of downloaded artifacts; every `uses:` is pinned by full SHA; privileged workflows trigger only via `workflow_run`/`workflow_dispatch`/`schedule` | 7 |
| R4.2 | `prepare` given an artifact set with an extra, missing or renamed file, or a tag that no longer points at the built commit | Fails before signing | 12 |
| R5.1 | `tropos install <current> --force` run from the current version | The verified file's inode and bytes are unchanged; the switch is an atomic re-link; health check runs | 2, 3 |
| R5.2 | Damaged version in use by a session (`LOCK_SH` held) | File not renamed or deleted; if current, `bin/tropos` moves to a healthy fallback; exit 75 | 3, 11 |
| R5.3 | Damaged version not in use | Quarantined under `LOCK_EX` and replaced | 2 |
| R5.4 | Cleanup of an old version or quarantined file while a process runs it | Kept until the process exits | 3 |
| R6.1 | `SIGKILL` at each step of a **first** install (`from: null`) | Either fully installed and Healthy, or no `bin/tropos`, `current = null` and a clear message; never a symlink to an unverified file | 4 |
| R6.2 | `current`'s file deleted; `current` corrupted | Recovery switches to the first Healthy fallback in the specified order | 4 |
| R6.3 | `previous` corrupted or missing, then `tropos rollback` | `previous = null`; rollback exits 65 listing Healthy versions; nothing switched | 4 |
| R6.4 | Randomised corruption of any subset of versions, manifests, signatures, symlink and state (property test, fixed seeds) | `bin/tropos` is either absent or points at a Healthy version | 4 |
| R7.1 | First release against an empty fake GitHub | `channels` created as prerelease/not-latest; all four slots = x; GitHub latest = `v<x>`; smoke b/c skipped | 12 |
| R7.2 | Interleaved `latest` and `stable` promotions (fake client, all interleavings of two runs) | Pointers never move backwards; `stable ≤ latest`; every slot names a verified release | 12 |
| R7.3 | Before the first promotion completes | `install.sh stable` fails with "no release has been published yet"; explicit version works | 5 |
| R8.1 | Shared corpus `test/fixtures/zstd/`: truncated frame, trailing garbage, extra concatenated frame, output of `size−1` and `size+1`, corrupted content checksum, non-zstd bytes, empty file — each paired with a test manifest whose `zst` hash matches, so decompression itself is exercised | Both `install.sh` and `installer.ts` reject each and fall back to the raw asset; with a bad raw asset too, fail with nothing installed | 5, 7 |
| R8.2 | Output far larger than `size` | Stopped by the file-size limit (`install.sh`) or the byte count (TS) without writing beyond the bound | 5, 11 |
| R9.1 | `tropos install stable` with configured channel `latest` | Settings file unchanged (bytes identical); notice printed; a later background check moves to the newer `latest` | 10 |
| R9.2 | `tropos install stable` with configured channel `stable`; `tropos install <version>` with auto-updates off | No notice | 10 |
| R9.3 | Configured channel `stable` while `current` is above it | `tropos update` reports up to date and does not downgrade | 10 |

**CI runners:** `macos-15` (darwin-arm64), `macos-15-intel` (darwin-x64), `ubuntu-24.04`
(linux-x64), `ubuntu-24.04-arm` (linux-arm64), and Alpine containers on `ubuntu-24.04`
(linux-x64-musl) and `ubuntu-24.04-arm` (linux-arm64-musl). Each 6P job uses the binary built
for its platform. `ci.yml` keeps its current jobs and adds the 6P installer job; the new modules
fall under `scripts/check-coverage.ts`.

## 14. Compatibility and migration

- Existing invocations: §12.2, enforced by layer 6.
- Existing local-build installs keep working; they are *unmanaged* (§9) and replaced by the first
  `update` or `install.sh` run.
- `bun run install:local` replaces `./install.sh` for developers; README and `--help` updated.
- `build.ts` gains the musl targets; `build:all` output names are unchanged for existing targets.
- Settings: `autoUpdates` and `autoUpdatesChannel` are added to the trusted layers' schema.

## 15. Out of scope

Windows; prerelease version strings; delta updates; remote key revocation; editing shell
startup files; package-manager distribution (Homebrew, npm); reproducible builds and
build-provenance attestations (§6.2).

## 16. Verified in the first plan task (platform spike)

Before the engine is built, a CI spike on all six runners confirms: the `flock` FFI library
name on each libc; `setup-bun` (or a musl Bun build) inside Alpine containers; `ssh-keygen -Y`
availability per runner image and how to detect an `ssh-keygen` without `-Y` for the error
message; `zstd` availability and its exit status for each R8.1 corpus file; `ulimit -f` units
and enforcement under `dash`, busybox `ash`, macOS `/bin/sh` and bash 3.2. On a scratch
repository it also confirms that `workflow_run` exposes the tag name and head commit of a
tag-triggered run, that an environment restricted to `main` accepts `workflow_run` jobs, and
that `gh release upload --clobber` deletes before uploading, and what GitHub reports as the
latest release when a repository's first release is published with `--latest=false`.
Any surprise is fed back into this spec before implementation continues.

## Appendix A — Evidence: how Claude Code installs and updates (v2.1.296, this machine, 2026-10-13)

- **Bootstrap script.** `curl -fsSL https://claude.ai/install.sh` returns a 260-line bash
  script that: refuses `sudo` from a user shell (`CLAUDE_INSTALL_ALLOW_SUDO` override); requires
  `curl` or `wget`, optionally uses `jq` and `zstd`; detects `darwin|linux` × `x64|arm64`,
  Rosetta (`sysctl.proc_translated`) and musl; fetches the version from
  `https://downloads.claude.ai/claude-code-releases/latest`, rejecting non-version content;
  downloads `<version>/manifest.json`, extracts the platform's `checksum` and `size`; prefers
  `<platform>/claude.zst` (verified against `manifest.zst.json`, decompressed with
  `zstd -d -q -c | head -c "$size"`) with raw `<platform>/claude` as fallback; verifies SHA-256;
  runs `"$binary_path" install ${TARGET}`; deletes the download; restores the terminal with
  `stty sane` after a signal death and explains exit 137 as OOM on Linux.
- **Channels.** `…/claude-code-releases/latest` → `2.1.296`; `…/stable` → `2.1.287`.
- **Manifest.** `2.1.296/manifest.json` has `version`, `commit`, `buildDate`,
  `manifestSignatureEnforcement: "flag"`, and `platforms` for darwin-{arm64,x64},
  linux-{arm64,x64}{,-musl}, win32-{x64,arm64}, each with `binary`, `checksum` (SHA-256) and
  `size`. `manifest.json.sig` and `manifest.zst.json` exist (HTTP 200).
- **Checksum match.** `shasum -a 256 ~/.local/share/claude/versions/2.1.296` =
  `c9b5341637becbd423ddffc5b254afb645682a3868cb708bbc6cc0e7bb419937` = the manifest's
  darwin-arm64 `checksum`.
- **Layout.** `~/.local/bin/claude` → symlink to `~/.local/share/claude/versions/2.1.296`;
  `versions/` holds 2.1.294, 2.1.295, 2.1.296 (old versions are pruned); staging under
  `~/.cache/claude/staging/`; lock `~/.local/state/claude/locks/2.1.296.lock` containing
  `{pid, version, execPath, acquiredAt}`.
- **Subcommands.** `claude install [options] [target]` ("stable, latest, or specific version",
  `--force`) and `claude update|upgrade`.
- **Config.** `~/.claude.json` records `installMethod: "native"`, `autoUpdates`,
  `autoUpdatesProtectedForNative`.

## Appendix B — Revision 2: written-spec review

| # | Issue | Resolution |
|---|---|---|
| 1 | `install --self` must run from a verified temp executable without bypassing checks | §10.3 "`install --self`", §12.1 exemption, §10.1 (no in-use lock outside `versions/`); tests R1.x |
| 2 | Promotion must resume when `latest` already equals the target but GitHub latest does not | Convergent `promote.ts` (§7.4); tests R2.x |
| 3 | `--clobber` deletes before uploading; stable needs recovery and fallback | Primary + `.bak` slots for both channels (§5.4), client fallback (§8.2, §10.4), `check --repair` and `channels-health.yml` (§7.4); tests R3.x |
| 4 | No untrusted tag code where the signing key is available; document the trust boundary | Workflow split (§7.1–7.3), sign job (§6), trust boundary (§6.2); tests R4.x |
| 5 | Never replace or remove a binary in use; define `--force` on the running version | Immutability rule (§10.2), §10.3 step 3 and "`--force`", cleanup (§10.5); tests R5.x |
| 6 | Recovery for first install, missing/corrupted versions, verified fallback | Healthy predicate and activation rule (§10.2), recovery table and fallback order (§10.6), rollback (§10.7); tests R6.x |
| 7 | First-release bootstrap; no conflicting concurrent promotions | §7.5, shared `channels` concurrency group and slot compare-before-write (§7.1, §7.4), invariants (§7.6); tests R7.x |
| 8 | zstd: full-stream validation, exact size, excess detection, decoder errors | `install.sh` §8.2 step 7 (no `head -c`), TS §10.3 step 4, producer `--check` + round trip (§7.3); tests R8.x |
| — | Does `install stable` change the update channel? | No: one-time install with a notice (§11, §12.1); tests R9.x |
