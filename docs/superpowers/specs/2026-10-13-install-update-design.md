# Tropos Code — Install and Update System — Design Spec

**Date:** 2026-10-13 · **Owner:** Tropos Labs · **Status:** Sections 1–4 approved in conversation, pending written-spec review

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
4. An interrupted install, update, rollback or cleanup — at any point — leaves `tropos` runnable
   and the next run repairs any inconsistency.
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
scripts/release/
  make-manifest.sh            canonical manifest writer (POSIX sh; runs in the signing job)
  promote.ts                  pointer and "latest" promotion logic (injected GitHub client)
.github/workflows/
  release.yml                 tag → build → sign → draft → smoke → publish → smoke → promote
  promote.yml                 manual: move channels/stable to a verified version
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
| Decompression bomb | Decompressed output is capped at the manifest's raw `size`; the `.zst` download is capped at the manifest's `zst.size` |
| Path traversal via manifest or state | Versions match a strict semver regex and asset names match exactly before use in any path |
| Malicious or accidental symlinks in the install tree | `lstat` checks: version files must be regular files; directories must not be symlinks; `bin/tropos` is only replaced if it is a symlink into our `versions/` (or with `--force`) |
| Group/world-writable install directories | Refuse to install into, or switch through, a directory writable by others or owned by another user |
| Signing key exposure via build dependencies | The signing job runs no `bun install` and no `node_modules`; only `make-manifest.sh` and `ssh-keygen` from the tagged commit |
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
verified.json                 uploaded only after all gates pass (§7.3)
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

Tag `channels`, created once with `--prerelease --latest=false`; it is never marked latest.
Assets: `latest` and `stable`, each containing one version string and a newline. Every version
release is published with `--latest=false` and only later marked latest by the promotion step
(§7.3), so GitHub's "latest release" always names a fully verified version release.

URLs (all plain downloads):

```
https://github.com/Tropos-AI/tropos-code/releases/download/channels/{latest,stable}
https://github.com/Tropos-AI/tropos-code/releases/download/v<version>/<asset>
https://github.com/Tropos-AI/tropos-code/releases/latest/download/<asset>     (fallback, §10.3)
```

## 6. Signing and key management

- **Key:** OpenSSH ed25519, no passphrase, comment `tropos-release`. Private key in the secret
  `TROPOS_RELEASE_SIGNING_KEY` of the GitHub Actions Environment `release-signing`.
- **Environment protection:** deployment restricted to `v*` tags; required reviewer approval;
  the secret exists nowhere else.
- **Signing job:** checks out the tag; downloads the build artifacts; never runs `bun install`
  or touches `node_modules`; compresses with `zstd -19`; runs `make-manifest.sh`; writes the key
  to a `umask 077` temporary file; signs `manifest.json` (namespace `tropos-manifest`) and
  `install.sh` (namespace `tropos-installer`); verifies both signatures against
  `release/allowed_signers`; deletes the key file in an `always()` step.
- **Setup (one-time, by the owner):** `ssh-keygen -t ed25519 -N "" -C tropos-release -f tropos-release`;
  store the private key in the environment secret; commit the public key to
  `release/allowed_signers`, `install.sh` and `src/install/trust.ts`; publish the fingerprint
  (`ssh-keygen -lf tropos-release.pub`) in the README. `docs/install.md` carries these steps.

### 6.1 Key rotation (K1 → K2)

`allowed_signers` holds one line per trusted key, all with principal `tropos-release`; clients
accept a signature from any listed key.

1. **Phase 1.** Add K2 to the trusted set in all three places. Release N is still signed with K1.
2. **Phase 2.** Once the installer on GitHub's latest release and the binary in `channels/stable`
   both trust K2 (both ≥ N), switch the environment secret to K2. The old-client compatibility
   gate (§7.2 step 8) enforces this: a K2-signed release that the published installer or the
   stable binary cannot verify fails the gate and is never promoted.
3. **Phase 3.** A later release removes K1 from the trusted set.

Binaries older than N cannot verify K2 signatures; their `update` fails with an `integrity`
error whose message says to reinstall with `install.sh`.

## 7. Release pipeline

### 7.1 Triggers and concurrency

- `release.yml` runs on push of a `v*` tag. Concurrency group `release`, never cancelled in
  progress, so two releases cannot interleave pointer updates.
- `promote.yml` runs on `workflow_dispatch` with a `version` input.
- Default token permissions are `contents: read`; only the draft, publish and promote jobs get
  `contents: write`. Only the sign job uses the `release-signing` environment.

### 7.2 `release.yml` jobs

1. **verify-tag** — tag equals `v` + `package.json` version; tagged commit is on `main`.
2. **build** — `bun run build:all` (six targets) on `ubuntu-24.04`; upload the binaries.
3. **test-artifacts** (6 platforms) — run the installer/engine e2e suites (§13 layers 3–5, 9–11)
   against the exact artifacts from step 2.
4. **sign** (`release-signing` environment) — §6.
5. **draft** — `gh release create v<x> --draft --latest=false` with all §5.2 assets except
   `verified.json`.
6. **smoke-draft** (6 platforms) — `gh release download` with the workflow token into a folder;
   `TROPOS_INSTALL_FROM=<folder> sh install.sh <x>`; `tropos --version` must print
   `<x> (Tropos Code)`. (Draft assets are not publicly downloadable, so commands that fetch
   from the network are exercised in step 8.)
7. **publish** — `gh release edit v<x> --draft=false --latest=false`.
8. **smoke-public** (6 platforms) —
   a. `curl -fsSL …/releases/download/v<x>/install.sh | sh -s <x>` on a clean `HOME`, then
      `tropos install <x>` must succeed as a no-op;
   b. **old installer**: download `install.sh` from GitHub's current latest release (the previous
      version) and run `sh install.sh <x>` on a clean `HOME`;
   c. **old binary**: on a clean `HOME`, install the version in `channels/stable` with its own
      installer, then run that binary's `tropos install <x>`.
   All three must end with `tropos --version` printing `<x> (Tropos Code)`.
   (On the very first release, b and c are skipped because no previous release exists.)
9. **promote-latest** — `scripts/release/promote.ts latest <x>`:
   a. refuse unless `<x>` is greater than the current `channels/latest`;
   b. upload `verified.json` (`{version, commit, runId, verifiedAt}`) to `v<x>`;
   c. overwrite `channels/latest` with `<x>` (`gh release upload --clobber`);
   d. read the public pointer back until it returns `<x>` (bounded retries);
   e. `gh release edit v<x> --latest`.

### 7.3 Promotion invariants

- `channels/latest`, `channels/stable` and GitHub's latest release only ever name a release that
  has `verified.json`.
- `promote.ts` is idempotent: re-running after an interruption at any step completes the
  promotion without changing an already-correct pointer.
- If any gate fails, the release stays as it is (draft, or published with `--latest=false`) and
  no pointer moves; users keep getting the previous verified release.
- `--clobber` briefly removes the pointer asset. Clients cover this with retries; for `latest`
  they fall back to GitHub's latest release, which still names the previous verified version.

### 7.4 `promote.yml`

`scripts/release/promote.ts stable <x>`: refuse unless `v<x>` has `verified.json`, its manifest
signature verifies against `release/allowed_signers`, and `<x>` ≥ the current `channels/stable`;
then overwrite `channels/stable` and read it back.

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
   version regex. If `latest` cannot be resolved, fetch `releases/latest/download/manifest.json`
   instead and take its version after verification. `stable` has no fallback.
6. **Manifest:** download `manifest.json` and `manifest.json.sig` (same retry policy); verify the
   signature (§4.3); validate with the `awk` grammar; check the version. If verification fails,
   installation stops; a probe of `ssh-keygen -Y` support only chooses the error message
   ("your ssh-keygen is too old; install OpenSSH ≥ 8.1" vs "signature verification failed").
7. **Binary:** if `zstd` is present, download `tropos-<platform>.zst` capped at `zst.size`, check
   its size and SHA-256, decompress with `zstd -d -c | head -c <size>`, then check the result's
   size and SHA-256; on any failure fall back to the raw asset. Raw: download capped at `size`,
   check size and SHA-256. Failure of the raw path: exit 1 with "checksum mismatch".
8. **Hand-off:** `chmod 700` the binary; run
   `"$bin" install --self --manifest <m> --signature <s>`. The binary re-verifies everything
   (§10.2) and places itself.
9. **Exit:** on a signal death of the binary (exit ≥ 128) run `stty sane` if stdin is a terminal;
   if `~/.local/bin` is not on `PATH`, print the exact line to add for the user's shell (never
   edit startup files).

`TROPOS_INSTALL_FROM=<dir>` reads assets from a local folder instead of the network; it requires
an explicit version and changes nothing about verification. It exists for the draft smoke tests.

`head -c` and `mktemp` are not strictly POSIX but are present on every supported platform
(macOS, GNU coreutils, busybox); the test matrix covers each.

## 9. On-disk layout and state

| Path | Contents | Mode |
|---|---|---|
| `$DATA = ${XDG_DATA_HOME:-~/.local/share}/tropos` | | 0700 |
| `$DATA/versions/<v>` | verified binary | 0755 |
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

`pending` is `{ "op": "switch", "from": "<v>", "to": "<v>" }` while a switch is in progress.
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
- **In-use lock** (`<v>.lock`, `LOCK_SH`): every invocation of a native binary except
  `--version` and `--help` takes it at startup (a process's own `LOCK_SH` also makes its own
  cleanup keep its version, because `flock` locks on separate open files conflict), then checks that `process.execPath` still exists; if not, it re-executes
  itself through `~/.local/bin/tropos` with the same arguments. Held for the life of the process.

### 10.2 Install a version (`installVersion`)

1. Take the install lock; run recovery (§10.5).
2. Obtain the verified manifest: fetch (§10.3) or, for `--self`, read the given files. Verify the
   signature with the compiled-in key set, parse strictly, check the version.
3. **Reuse or download.** If `versions/<v>` exists: `lstat` must show a regular file owned by the
   user; its size and SHA-256 must match. On mismatch move it to `versions/.corrupt-<v>-<ts>` and
   download. For `--self`, hash `process.execPath` instead and require
   `manifest.version === VERSION`; copy the running binary into staging and skip step 4.
   With `--force`, an existing `versions/<v>` is re-downloaded even if it verifies.
4. **Download** into `staging/<v>.<random>` (zst preferred, raw fallback), bounded by the
   manifest sizes, hashing while streaming; decompress with `zlib.createZstdDecompress`, aborting
   past `size`. Hash mismatch → re-download up to 2 more times, then `integrity` error.
5. `chmod 0755`, `fsync`, `rename` into `versions/<v>`, `fsync` the directory. Store the manifest
   and signature under `manifests/<v>/`.
6. **Health check:** run `versions/<v> --version` with a 10 s timeout and the §11 environment
   allow-list; stdout must be exactly `<v> (Tropos Code)\n`. Failure → add `skip[<v>] =
   "health-check"`, keep the current symlink, `integrity` error "release <v> does not run on
   this machine".
7. **Switch:** write `pending`; create `bin/.tropos.<random>` → `versions/<v>`; `rename` over
   `bin/tropos`; `fsync` `bin/`.
8. **Post-switch check:** `realpath(bin/tropos)` must equal `versions/<v>` and running it with
   `--version` must pass as in step 6; otherwise switch back to `from` the same way and record
   the skip.
9. Write state: `previous = from`, `current = <v>`, `pending = null`.
10. Cleanup (§10.4); release the lock.

Explicit `tropos install <v>` clears `skip[<v>]` before starting.

**Pre-switch safety checks:** `bin/` and `$DATA` must be directories (not symlinks), owned by
the user and not group/world-writable. `bin/tropos` must be absent or a symlink into
`$DATA/versions/`; otherwise refuse unless `--force`.

**`--force`** therefore means: re-download and re-verify even when `<v>` is already installed
(and switch to it even if it is already current), and replace a `bin/tropos` that is not ours.
It never skips a signature, hash or health check.

### 10.3 Channel resolution and downloads

- `channels.ts`: fetch the pointer with a 10 s timeout, 3 attempts, exponential backoff
  (1 s, 2 s, 4 s) with ±20 % jitter. 404/HTML/invalid content counts as a failed attempt.
  `latest` falls back to `releases/latest/download/manifest.json`. All attempts failing →
  `network` error (foreground) or a quiet skip (background).
- `fetch.ts`: HTTPS only, including after redirects (at most 5); aborts when the body exceeds
  the expected size; honours `HTTPS_PROXY`. Integrity comes from signatures and hashes, not from
  the host name.

### 10.4 Cleanup

Under the install lock, consider each verified version in `versions/` (unmanaged and
`.corrupt-*` entries are never touched, except `.corrupt-*` older than 7 days). Keep a version if
any is true: it is `current`; it is `previous`; it appears in `pending`; it is among the 3 newest
verified versions; a non-blocking `LOCK_EX` on its `<v>.lock` fails (a session holds it).
Otherwise, while holding that `LOCK_EX`, delete `versions/<v>` and `manifests/<v>/`, then release.
Staging entries older than 1 hour are deleted.

### 10.5 Recovery

Runs under the install lock at the start of `install`, `update`, `rollback` and the background
updater.

| Found | Action |
|---|---|
| `install.json` missing or unparsable | Rebuild from `realpath(bin/tropos)` and stored manifests (`previous` = newest other verified version) |
| `pending` set | If `realpath(bin/tropos)` is `to` and `to` verifies: finish (write state). Else point `bin/tropos` at `from` and clear `pending` |
| No `pending`, symlink ≠ `current` | If the symlink target is a verified version: adopt it as `current`. Else point the symlink back at `current` |
| Symlink missing or dangling | Point it at `current` if it verifies, else the newest verified version |
| Staging leftovers | Removed by cleanup |

### 10.6 Rollback

`tropos rollback`: take the lock, run recovery, re-verify `previous` (stored signed manifest +
binary hash), switch to it (steps 7–9 of §10.2), and add `skip[<old current>] = "rolled-back"`
so the background updater does not reinstall it. No `previous` → exit 1 with a message.

### 10.7 Errors and exit codes

| Kind | Examples | Exit | Behaviour |
|---|---|---|---|
| `usage` | bad target, bad flags | 64 | — |
| `integrity` | bad signature, malformed manifest, repeated hash mismatch, failed health check | 65 | No retry in this run; only a failed health check adds a `skip` entry |
| `network` | DNS, timeout, 5xx, 429, reset | 69 | Retried as in §10.3 |
| `local` | `EACCES`, `ENOSPC`, `EROFS`, unsafe permissions, flock unavailable, not a native install | 73 | Clear message, no retry |
| `busy` | install lock held > 60 s | 75 | — |
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
- **Decision:** resolve the channel; install only if the resolved version is **greater** than
  `current` and not in `skip`. Never moves to a lower version.
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
"not a native install; install with install.sh".

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
| 4 | Crash and recovery | child process `SIGKILL`ed at injected points (after download, after rename into `versions/`, after `pending` write, after symlink swap, after state write, mid-cleanup); torn `install.json`. After each, recovery must leave `bin/tropos` → a verified version passing its health check, consistent state, no staging leftovers. Crash points injectable only through the TypeScript API | every PR, 6P |
| 5 | `install.sh` | under `dash`, busybox `ash`, macOS `/bin/sh` and bash 3.2, against a `Bun.serve` fixture server and a test copy with substituted key and base URL. Negative cases: tampered manifest; invalid signature; wrong namespace; untrusted signer; version mismatch; binary short or with extra bytes; corrupt `.zst` → raw fallback; both corrupt → fail; HTML pointer; 500 then success; server down; `latest` pointer down → GitHub-latest fallback; `stable` pointer down → fail; no `ssh-keygen`, or one without `-Y` (shim) → fail; no `curl`/`wget`; no hash tool; FreeBSD/i686/MINGW → fail; sudo refusal. Truncation: the script cut every 64 bytes and piped to `sh` runs nothing and creates no files. `shellcheck -s sh` | every PR, 6P |
| 6 | CLI compatibility | **first plan task** snapshots `parseCli` output for a table of existing invocations (prompts, every flag, `-r <uuid>`, `-p` with piped stdin, edge cases); the new parser must reproduce it exactly. Tables for subcommand shapes, `--`, usage errors | every PR |
| 7 | Parity | the invalid-manifest corpus is rejected identically by `manifest.ts` and the `awk` grammar; `make-manifest.sh` output is accepted by both; TS and `install.sh` platform detection agree under the same `uname` shims; the pinned key is identical in its three locations | every PR |
| 8 | Release gates | smoke-draft, smoke-public, old-installer and old-binary checks (§7.2) | release workflow, 6P |
| 9 | Key rotation | fixture keys K1, K2, K3. Installer/binary trusting {K1} accept K1 releases; phase-1 clients {K1,K2} accept K1 and K2 releases; {K1}-only clients reject K2 releases with the "reinstall" message; K3 signatures always rejected; the compatibility gate fails a K2 release when the published installer trusts only K1 | every PR (gate logic) |
| 10 | Auto-update | injected clock: 6 h throttle and failure backoff (12 h, 24 h, 48 h cap, reset); each disabling condition (non-TTY, `-p`, `CI`, env var, user setting, dev run) prevents spawning; repo-layer `autoUpdates` ignored; spawned environment contains only allow-listed variables (a fake binary dumps its env; seeded `ANTHROPIC_API_KEY` etc. must be absent); network failure → no state change except backoff; pointer naming a lower version or a `skip`ped version → no install; "Updated to" shown once | every PR, 6P for the spawn test |
| 11 | Filesystem security | `versions/<v>` as a symlink → refused; `bin/tropos` pointing outside `versions/` or a regular file → refused without `--force`; `$DATA` or `bin/` group/world-writable or a symlink → refused; manifest/state versions like `../x` or `1.0.0/../../` rejected before any path use; `.zst` expanding beyond `size` → aborted at the cap, nothing installed; binary modified after install → detected on reuse and rollback; `install.json` edited to name an unverified version → not switched to | every PR |
| 12 | Promotion failures | `promote.ts` against a fake GitHub client: failed smoke → no pointer change, release stays `--latest=false`; interruption after each step (verified.json, pointer upload, read-back, latest mark) → rerun converges; pointer never moves backwards; `stable` promotion refused without `verified.json` or with a bad signature; during the `--clobber` window a client resolving `latest` gets the previous verified version via fallback | every PR |

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
startup files; package-manager distribution (Homebrew, npm).

## 16. Verified in the first plan task (platform spike)

Before the engine is built, a CI spike on all six runners confirms: the `flock` FFI library
name on each libc; `setup-bun` (or a musl Bun build) inside Alpine containers; `ssh-keygen -Y`
availability per runner image and how to detect an `ssh-keygen` without `-Y` for the error
message; `zstd` availability; and `head -c` behaviour under busybox.
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
