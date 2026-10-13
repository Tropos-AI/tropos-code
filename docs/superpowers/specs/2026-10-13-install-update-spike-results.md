# Tropos Code — Install and Update System — Infrastructure Spike Results

**Date:** 2026-10-13 · **Spec:** [2026-10-13-install-update-design.md](2026-10-13-install-update-design.md) (§16) · **Plan:** Task 2

This document records what the infrastructure spike observed and the decisions taken from it
(D1–D6, P1, P2). The spike workflow (`.github/workflows/spike.yml`) and probe scripts
(`scripts/spike/`) were removed once these results were recorded.

## Sources

| Source | What it covers |
|---|---|
| CI run `38422254221` of workflow `spike` on `Tropos-AI/tropos-code` (branch `spike/install-infra`, runner 2.337.0) | D2–D5, zstd corpus, tool availability on the six platform runners |
| Commands run by the controller against the scratch repository `Tropos-AI/tropos-release-spike`, adapted from `scripts/spike/github-probe.sh` (not the committed script as is): the D6b poll made 160 requests at roughly one per second, and extra checks were added (public visibility of a draft, upload to a draft after enabling immutability, a `--clobber` on a `channels` release created before enabling). Output saved as `spike-github.txt` | D1b, D6a, D6b |
| `build.yml` / `consume.yml` `workflow_run` probe in the scratch repository (tag `v0.0.3`, `consume` run `38423588936`), values captured by the controller | P1, P2 |
| `gh api` against `Tropos-AI/tropos-code` and the `Tropos-AI` organization | D1a |
| Owner, 2026-10-13 | D1 decision |
| Local run on the development Mac (macOS 26, OpenSSH 10.3p1), before the CI run | D4, D5 cross-check |

Raw output in the fenced blocks below is copied verbatim; for CI output, the job, step and
timestamp columns of the log are removed and lines that do not bear on the question are omitted.
The D1a, P1 and P2 output was not kept as a file; those sections quote the raw values the
controller recorded in the task ledger (`.superpowers/sdd/2026-10-13-install-update/progress.md`,
line "Task 2: P1 raw values").

## CI run overview

| Job | Runner image | Result |
|---|---|---|
| `native (macos-15)` | `macos-15-arm64` 20260907.0337.1 | all steps passed |
| `native (macos-15-intel)` | `macos-15` | all steps passed |
| `native (ubuntu-24.04)` | `ubuntu-24.04` 20261004.327.1 | all steps passed |
| `native (ubuntu-24.04-arm)` | `ubuntu-24.04-arm` 20261004.142.1 | all steps passed |
| `alpine (ubuntu-24.04, bun-linux-x64-musl)` | `alpine:3.22` container on `ubuntu-24.04` | `setup-bun` failed (`continue-on-error`); musl zip fallback and every probe passed |
| `alpine (ubuntu-24.04-arm, bun-linux-aarch64-musl)` | `alpine:3.22` container on `ubuntu-24.04-arm` | **failed** at `actions/checkout@v5`; no probe ran |

## Probe: Bun inside Alpine (D2)

`oven-sh/setup-bun@v2` inside the `alpine:3.22` container on `ubuntu-24.04` downloads the glibc
build and cannot start it:

```
Downloading a new version of Bun: https://github.com/oven-sh/bun/releases/download/bun-v1.4.0/bun-linux-x64.zip
[command]/usr/bin/unzip -o -q /__w/_temp/fd1f9656-79a4-4bbd-bc5d-936afa46f02e.zip
[command]/github/home/.bun/bin/bun --revision
##[error]Error: There was an error when attempting to execute the process '/github/home/.bun/bin/bun'. This may indicate the process failed to start. Error: spawn /github/home/.bun/bin/bun ENOENT
```

The official musl zip works (`curl -fsSLo bun.zip "https://github.com/oven-sh/bun/releases/download/bun-v1.4.0/bun-linux-x64-musl.zip"`, unzip, install):

```
Run bun --version
1.4.0
```

On `ubuntu-24.04-arm`, no JavaScript action can run in an Alpine job container, so the job
failed at its first `uses:` step:

```
Run actions/checkout@v5
[command]/usr/bin/docker exec  35d909749dc290f6aa266e000d883b7d9a3087471d99babc296cc691bf3a2f54 sh -c "cat /etc/*release | grep ^ID"
##[error]JavaScript Actions in Alpine containers are only supported on x64 Linux runners. Detected Linux Arm64
```

**Consequence:** a `container: alpine:…` job cannot use `actions/checkout`,
`actions/download-artifact` or any other JavaScript action on `ubuntu-24.04-arm`. musl jobs
therefore run their actions on the host runner and execute Bun and the tests inside
`docker run alpine:3.22`, with Bun installed from the official musl zip.

## Probe: `ssh-keygen -Y` (D3)

Every runner ships an OpenSSH with `-Y`:

```
# macos-15 and macos-15-intel
== ssh-keygen: /usr/bin/ssh-keygen OpenSSH_9.9p2, LibreSSL 3.3.6
# ubuntu-24.04 and ubuntu-24.04-arm
== ssh-keygen: /usr/bin/ssh-keygen OpenSSH_9.6p1 Ubuntu-3ubuntu13.19, OpenSSL 3.0.13 30 Jan 2024
# alpine x64 (no ssh client installed; the apk step shows the package version)
== ssh-keygen: /usr/bin/ssh-keygen scripts/spike/shell-probe.sh: line 13: ssh: not found
(16/18) Installing openssh-keygen (10.0_p1-r10)
```

`ssh-keygen -Y` without an operation (the wording differs by libc `getopt`):

```
# macos-15 and macos-15-intel
ssh-keygen: option requires an argument -- Y
# ubuntu-24.04 and ubuntu-24.04-arm
option requires an argument -- Y
# alpine x64 (musl)
ssh-keygen: option requires an argument: Y
```

`ssh-keygen -Y verify` without arguments — identical on all five runners that ran, and on the
local Mac (OpenSSH 10.3p1):

```
Too few arguments for verify: missing namespace
```

No runner has an OpenSSH older than 8.1, so the "no `-Y`" message could not be observed; it is
`getopt`'s rejection of an unknown option `-Y`, worded per libc: BSD/macOS
`illegal option -- Y`, glibc `invalid option -- 'Y'`, musl `unrecognized option: Y`.

## Probe: `ulimit -f` unit per shell (D4)

`( ulimit -f 4; dd if=/dev/zero of=f bs=1024 count=8 )`: 2048 bytes written means 512-byte
blocks, 4096 means 1024-byte blocks. Every shell enforced the limit (`rc=153`, SIGXFSZ).

```
# macos-15
== shell sh: ulimit -f 4 → _: line 1:  1176 Filesize limit exceeded: 25   dd if=/dev/zero of=f bs=1024 count=8 2> /dev/null
rc=153 bytes=4096
== shell dash: ulimit -f 4 → Filesize limit exceeded: 25
rc=153 bytes=2048
== shell bash: ulimit -f 4 → _: line 1:  1191 Filesize limit exceeded: 25   dd if=/dev/zero of=f bs=1024 count=8 2> /dev/null
rc=153 bytes=4096
== shell busybox ash: absent
== shell zsh: ulimit -f 4 → rc=153 bytes=2048

# macos-15-intel
== shell sh: ulimit -f 4 → _: line 1:  5519 Filesize limit exceeded: 25   dd if=/dev/zero of=f bs=1024 count=8 2> /dev/null
rc=153 bytes=4096
== shell dash: ulimit -f 4 → Filesize limit exceeded: 25
rc=153 bytes=2048
== shell bash: ulimit -f 4 → _: line 1:  5535 Filesize limit exceeded: 25   dd if=/dev/zero of=f bs=1024 count=8 2> /dev/null
rc=153 bytes=4096
== shell busybox ash: absent
== shell zsh: ulimit -f 4 → rc=153 bytes=2048

# ubuntu-24.04
== shell sh: ulimit -f 4 → File size limit exceeded (core dumped)
rc=153 bytes=2048
== shell dash: ulimit -f 4 → File size limit exceeded (core dumped)
rc=153 bytes=2048
== shell bash: ulimit -f 4 → _: line 1:  2192 File size limit exceeded(core dumped) dd if=/dev/zero of=f bs=1024 count=8 2> /dev/null
rc=153 bytes=4096
== shell busybox ash: ulimit -f 4 → File size limit exceeded (core dumped)
rc=153 bytes=2048
== shell zsh: absent

# ubuntu-24.04-arm
== shell sh: ulimit -f 4 → File size limit exceeded (core dumped)
rc=153 bytes=2048
== shell dash: ulimit -f 4 → File size limit exceeded (core dumped)
rc=153 bytes=2048
== shell bash: ulimit -f 4 → _: line 1:  2421 File size limit exceeded(core dumped) dd if=/dev/zero of=f bs=1024 count=8 2> /dev/null
rc=153 bytes=4096
== shell busybox ash: ulimit -f 4 → File size limit exceeded (core dumped)
rc=153 bytes=2048
== shell zsh: absent

# alpine x64
== shell sh: ulimit -f 4 → File size limit exceeded (core dumped)
rc=153 bytes=2048
== shell dash: absent
== shell bash: absent
== shell busybox ash: ulimit -f 4 → File size limit exceeded (core dumped)
rc=153 bytes=2048
== shell zsh: absent
```

| Shell | Unit |
|---|---|
| `dash` (incl. Ubuntu `/bin/sh`), busybox `ash` (incl. Alpine `/bin/sh`), `zsh` | 512 bytes |
| `bash` (incl. macOS `/bin/sh`, which is bash 3.2 in POSIX mode) | 1024 bytes |

The local Mac agrees (sh and bash 4096 bytes, dash and zsh 2048 bytes).

## Probe: `flock(2)` through `bun:ffi` (D5)

Single lock, contention across processes (holder `LOCK_EX|LOCK_NB` for 4 s; a second process
gets `-1` while it is held and `0` after it exits) and the same probe compiled with
`bun build --compile`:

```
# macos-15
{"ok":true,"lib":"libSystem.B.dylib","tried":{},"exNb":0,"platform":"darwin","arch":"arm64"}
{"role":"hold-ex","rc":0}
{"ok":true,"lib":"libSystem.B.dylib","tried":{},"exNb":-1,"platform":"darwin","arch":"arm64"}
{"ok":true,"lib":"libSystem.B.dylib","tried":{},"exNb":0,"platform":"darwin","arch":"arm64"}
# compiled with bun build --compile
{"ok":true,"lib":"libSystem.B.dylib","tried":{},"exNb":0,"platform":"darwin","arch":"arm64"}

# macos-15-intel
{"ok":true,"lib":"libSystem.B.dylib","tried":{},"exNb":0,"platform":"darwin","arch":"x64"}
{"role":"hold-ex","rc":0}
{"ok":true,"lib":"libSystem.B.dylib","tried":{},"exNb":-1,"platform":"darwin","arch":"x64"}
{"ok":true,"lib":"libSystem.B.dylib","tried":{},"exNb":0,"platform":"darwin","arch":"x64"}
# compiled with bun build --compile
{"ok":true,"lib":"libSystem.B.dylib","tried":{},"exNb":0,"platform":"darwin","arch":"x64"}

# ubuntu-24.04
{"ok":true,"lib":"libc.so.6","tried":{},"exNb":0,"platform":"linux","arch":"x64"}
{"role":"hold-ex","rc":0}
{"ok":true,"lib":"libc.so.6","tried":{},"exNb":-1,"platform":"linux","arch":"x64"}
{"ok":true,"lib":"libc.so.6","tried":{},"exNb":0,"platform":"linux","arch":"x64"}
# compiled with bun build --compile
{"ok":true,"lib":"libc.so.6","tried":{},"exNb":0,"platform":"linux","arch":"x64"}

# ubuntu-24.04-arm
{"ok":true,"lib":"libc.so.6","tried":{},"exNb":0,"platform":"linux","arch":"arm64"}
{"role":"hold-ex","rc":0}
{"ok":true,"lib":"libc.so.6","tried":{},"exNb":-1,"platform":"linux","arch":"arm64"}
{"ok":true,"lib":"libc.so.6","tried":{},"exNb":0,"platform":"linux","arch":"arm64"}
# compiled with bun build --compile
{"ok":true,"lib":"libc.so.6","tried":{},"exNb":0,"platform":"linux","arch":"arm64"}

# alpine x64 (the alpine job has no contention step)
{"ok":true,"lib":"libc.so.6","tried":{},"exNb":0,"platform":"linux","arch":"x64"}
# compiled with bun build --compile
{"ok":true,"lib":"libc.so.6","tried":{},"exNb":0,"platform":"linux","arch":"x64"}
```

On Alpine, `dlopen("libc.so.6")` succeeds because musl's dynamic loader answers requests for
`libc.so.*` with itself; the explicit musl loader path was never needed. linux-arm64-musl was
not observed (the job failed before any probe ran).

## Probe: zstd CLI exit status for the R8.1 corpus

Identical on all five runners that ran (and on the local Mac); every runner has
`*** Zstandard CLI (64-bit) v1.5.7, by Yann Collet ***`:

```
== zstd -d good: rc=0 bytes=65536
== zstd -d trunc: rc=1 bytes=65533
== zstd -d trailing: rc=1 bytes=65536
== zstd -d double: rc=0 bytes=131072
== zstd -d flipped: rc=1 bytes=0
== zstd -d notzstd: rc=1 bytes=0
== zstd -d empty: rc=1 bytes=0
```

A concatenated second frame (`double`) decodes successfully to twice the size, so the exact-size
check of spec §8.2 step 7 is what rejects it; a truncated frame writes partial output before
failing, so outputs are deleted on any failure.

## Probe: other tools `install.sh` relies on

```
# macos-15
== musl loader: none
== curl: curl 8.7.1 (x86_64-apple-darwin24.0) libcurl/8.7.1 (SecureTransport) LibreSSL/3.3.6 zlib/1.2.12 nghttp2/1.64.0
== wget: GNU Wget 1.25.0 built on darwin24.6.0.
== wget --https-only: 1
== sha256sum: /sbin/sha256sum; shasum: /opt/homebrew/bin/shasum

# ubuntu-24.04
== musl loader: none
== ldd /bin/sh: 
== curl: curl 8.5.0 (x86_64-pc-linux-gnu) libcurl/8.5.0 OpenSSL/3.0.13 zlib/1.3 brotli/1.1.0 zstd/1.5.5 libidn2/2.3.7 libpsl/0.21.2 (+libidn2/2.3.7) libssh/0.10.6/openssl/zlib nghttp2/1.59.0 librtmp/2.3 OpenLDAP/2.6.10
== wget: GNU Wget 1.21.4 built on linux-gnu.
== wget --https-only: 1
== sha256sum: /usr/bin/sha256sum; shasum: /usr/bin/shasum

# alpine x64
== musl loader: /lib/ld-musl-x86_64.so.1
== ldd /bin/sh: 
== curl: curl 8.14.1 (x86_64-alpine-linux-musl) libcurl/8.14.1 OpenSSL/3.5.8 zlib/1.3.2 brotli/1.1.0 zstd/1.5.7 c-ares/1.34.8 libidn2/2.3.7 libpsl/0.21.5 nghttp2/1.69.0
== wget: wget: unrecognized option: version
== wget --https-only: 0
== sha256sum: /usr/bin/sha256sum; shasum: none
== tail -c 1 / od: \n
```

ubuntu-24.04-arm matches ubuntu-24.04 (curl 8.5.0 for `aarch64-unknown-linux-gnu`, GNU Wget
1.21.4, both hash tools, no musl loader, empty `ldd /bin/sh` line). macos-15-intel differs from
macos-15:

```
# macos-15-intel
== curl: curl 8.21.0 (x86_64-apple-darwin23.6.0) libcurl/8.21.0 OpenSSL/3.6.3 zlib/1.2.12 brotli/1.2.0 zstd/1.5.7 AppleIDN libpsl/0.23.3 libssh2/1.11.1 nghttp2/1.70.0 ngtcp2/1.25.0 nghttp3/1.18.0 mit-krb5/1.7-prerelease OpenLDAP/2.4.28/Apple
== wget: GNU Wget 1.25.0 built on darwin23.6.0.
== wget --https-only: 1
== sha256sum: /sbin/sha256sum; shasum: /usr/local/bin/shasum
```

(a curl 8.21.0 built with OpenSSL 3.6.3 first on `PATH`, not the system curl 8.7.1 with
LibreSSL seen on macos-15). Musl detection by the loader file works on Alpine. The
`ldd /bin/sh` fallback **ran and printed nothing** on every Linux runner, Alpine included, so
it is **unverified**: it did not detect musl where it should have, and the probe cannot tell
why (Task 22 must test the fallback on its own). Busybox `wget` has no `--https-only`, so on a curl-less Alpine only the
HTTPS-only redirect policy of busybox `wget` itself applies (spec §8.2 step 3 prefers `curl`).
`tail -c 1 | od -An -c` yields the two characters `\n` for a file ending in a newline (on the
other runners, the probe's `echo` turned them into a line break).

## Probe: release immutability (D1a, D1b)

**D1a** — main repository and organization (raw responses as recorded in the ledger):

```
repos/Tropos-AI/tropos-code/immutable-releases → 200 {"enabled":false,"enforced_by_owner":false}
orgs/Tropos-AI/settings/immutable-releases → 200 {"enforced_repositories":"none"}
```

**D1b** — scratch repository with immutability enabled:

```
== D1b immutability ON in scratch repo
HTTP/2.0 204 No Content
{"enabled":true,"enforced_by_owner":false}draft v0.0.2 created
upload to DRAFT after enabling: ALLOWED
published v0.0.2
immutable flag: true
upload NEW asset to published: HTTP 422: Cannot upload assets to an immutable release. (https://uploads.github.com/repos/Tropos-AI/tropos-release-spike/releases/411839768/assets?label=&name=latest)
clobber existing asset: Cannot delete asset from an immutable release
edit notes: ALLOWED
mark latest: ALLOWED; latest now v0.0.2
-- prerelease created after enabling (channels2)
created channels2
channels2 immutable flag: true
upload to channels2: HTTP 422: Cannot upload assets to an immutable release. (https://uploads.github.com/repos/Tropos-AI/tropos-release-spike/releases/411840246/assets?label=&name=latest)
clobber on channels2: HTTP 422: Cannot upload assets to an immutable release. (https://uploads.github.com/repos/Tropos-AI/tropos-release-spike/releases/411840246/assets?label=&name=latest)
-- old channels release (created before enabling)
clobber on old channels: ; now 1.0.1
attestation API: 1
```

With immutability on: drafts stay mutable; once published, a release — including a prerelease —
refuses new assets and `--clobber`; notes and the "latest" flag stay editable; GitHub creates a
release attestation automatically. Whether a release published before immutability was enabled
stays mutable is **inconclusive**: the `--clobber` on the old `channels` release printed no
status, and its asset already held `1.0.1` from the D6b step, so the read-back cannot show a
change (not relied upon).

## Probe: first release and `--clobber` (D6a, D6b)

```
== D6a first release published with --latest=false
draft visible on public download? 404
API releases/latest: v0.0.1
releases/latest/download/a.txt -> 404
== D6b --clobber gap
clobber upload took 3 s; poll status counts:
 160 200
after: 1.0.1
latest marked still: v0.0.1
```

**D6a:** for a repository's only release, published with `--latest=false`, the REST API's
`releases/latest` already returns it, but the public `releases/latest/download/<asset>` route
answers 404. Draft assets are not publicly downloadable (404).
**D6b:** 160 polls, roughly one per second, spanning a `--clobber` replacement whose upload
took 3 s, all returned 200, and the content switched from `1.0.0` to `1.0.1`; no window without
the asset was observed at this resolution (the per-poll sequence line, 160 × `200`, is
omitted). GitHub documents `--clobber` as delete-then-upload, so the gap is not ruled out.

## Probe: `workflow_run` provenance and draft visibility (P1, P2)

Scratch repository: `build.yml` (tag push, uploads artifact `release-inputs`) and
`consume.yml` (`workflow_run` of `build`, job in environment `spike-main-only` restricted to
`main`), tag `v0.0.3`. Raw values of `consume` run `38423588936`, as captured by the
controller and recorded in the ledger:

```
repository=Tropos-AI/tropos-release-spike
head_repository=Tropos-AI/tropos-release-spike
head_branch=v0.0.3
head_sha=6fb6f1f72655ccdc0f66d4800b98443a0e54b4b9
path=.github/workflows/build.yml
event=push
conclusion=success
ref=refs/heads/main
sha=6fb6f1f72655ccdc0f66d4800b98443a0e54b4b9
artifact {id 11827202504, name release-inputs, expired false, digest sha256:054cec0f50b5fed5b69567ef51e28c71b7f160e25ecb71c1c0d5660c61372ec0, size 318}
zip sha256 054cec0f50b5fed5b69567ef51e28c71b7f160e25ecb71c1c0d5660c61372ec0
P2 drafts visible to read-only token: 0
```

- `consume` ran in the `spike-main-only` environment (deployment branches: `main` only) with
  `ref` = `refs/heads/main`: an environment restricted to `main` accepts `workflow_run` jobs.
- `head_branch` is the tag name and `head_sha` the tagged commit.
- `path` has the form `.github/workflows/<file>.yml` (no `owner/repo/` prefix, no `@ref`
  suffix), so `check-provenance.ts` must compare it with exactly
  `.github/workflows/release-build.yml`.
- The artifact `digest` equals `sha256:` + the SHA-256 of the zip downloaded from
  `actions/artifacts/<id>/zip`.
- **P2:** the `contents: read` workflow token listed **0** draft releases while a draft existed.

## Decisions

| ID | Question | Evidence | Decision |
|---|---|---|---|
| D1 | Release immutability on Tropos-AI/tropos-code? Published assets mutable? | D1a: off today, no org enforcement. D1b: published releases (incl. prereleases) refuse uploads and `--clobber`; drafts mutable; latest flag and notes editable; attestation automatic. Owner, 2026-10-13: immutability will be enabled | **D1-B** (below). Immutability is enabled on `tropos-code` and `Tropos-AI/tropos-code-channels` is created, with an initial commit so that the `channels` release's tag can exist, at the key-ceremony checkpoint (plan Task 29) |
| D2 | How Bun runs in Alpine containers | `setup-bun` fails inside Alpine (glibc build, `ENOENT`); the musl zip works; JavaScript actions cannot run in Alpine containers on arm64 runners | **musl zip, outside job containers:** musl jobs run actions (checkout, artifacts) on the host runner and run Bun and the tests inside `docker run alpine:3.22`, with Bun from the official `bun-linux-{x64,aarch64}-musl.zip`. No `container: alpine` jobs |
| D3 | How `install.sh` detects an `ssh-keygen` without `-Y` | Every runner that ran the probe has OpenSSH ≥ 9.6 (linux-arm64-musl ran none); `ssh-keygen -Y verify` (no arguments) prints `Too few arguments for verify: missing namespace`; old versions unobservable | Probe `ssh-keygen -Y verify` with no arguments, message-only (installation stops either way). "Too old" when the output is `getopt`'s rejection of `-Y`: `*"option -- Y"*`, `*"option -- 'Y'"*`, `*"option: Y"*`, `*"unknown option"*`; otherwise "signature not valid" |
| D4 | `ulimit -f` unit per shell | 512 B: dash, busybox ash, zsh, Ubuntu/Alpine `sh`; 1024 B: bash, macOS `sh`; all enforce | Formula stays **⌊size/512⌋ + 2** blocks: at least `size` everywhere, at most about 2 × `size` |
| D5 | `flock` library per libc | darwin: `libSystem.B.dylib`; glibc and Alpine x64 musl: `libc.so.6`; contention correct everywhere observed, also from compiled binaries | darwin `["libSystem.B.dylib"]`; Linux `["libc.so.6", "/lib/ld-musl-<arch>.so.1", "/lib/libc.musl-<arch>.so.1"]`. linux-arm64-musl unobserved: covered by the musl CI job (D2) |
| D6 | First release with `--latest=false`: GitHub latest? `--clobber` gap length | D6a: API `releases/latest` returns the only release, the public `releases/latest/download/…` route 404s. D6b: no gap observed (160 polls at roughly one per second around a 3 s upload) | Before the first promotion `install.sh` (latest) fails with "no release has been published yet", like `stable`. GitHub latest counts as set only when the API **and** the public `releases/latest/download/manifest.json` name `v<x>`; otherwise promotion marks it explicitly. Read-back: up to 10 attempts 3 s apart; the `.bak` slots stay |
| P1 | `workflow_run` payload fields and artifact digest | Run `38423588936`: `repository` = `head_repository` = `Tropos-AI/tropos-release-spike`, `head_branch` = `v0.0.3`, `head_sha` = the tagged commit, `path` = `.github/workflows/build.yml`, `event` = `push`, `conclusion` = `success`, `ref` = `refs/heads/main` in a main-restricted environment; `digest` `sha256:054cec0f…` = SHA-256 of the zip | `check-provenance.ts` requires `repository` = `head_repository` = this repository, `path` = exactly `.github/workflows/release-build.yml` (the observed `.github/workflows/<file>.yml` form), `event` = `push`, `conclusion` = `success`, `head_branch` = `v<x>` with the tag still at `head_sha`, and the downloaded zip's SHA-256 = the artifact's `digest` (A4). Environments restricted to `main` work for `workflow_run` jobs |
| P2 | Can a `contents: read` token see a draft release? | 0 drafts visible | No: confirms the `fetch-draft` job (A12) |

### D1-B — immutable version releases, separate channels repository

- Version releases in `Tropos-AI/tropos-code` are immutable: every asset of spec §5.2 is
  attached to the draft, then the release is published once. GitHub's automatically generated
  release attestation is kept and documented in `docs/install.md` as an extra verification
  route.
- All mutable state lives in `Tropos-AI/tropos-code-channels`, excluded from the organization's
  immutability policy. Its `channels` release holds `latest`, `latest.bak`, `stable`,
  `stable.bak` and one `verified-<x>.json` verification record per verified version (replacing
  the per-version `verified.json`).
- Pointer URLs (`urls.ts`, `install.sh`) use
  `https://github.com/Tropos-AI/tropos-code-channels/releases/download/channels/<name>`; every
  other URL is unchanged.
- `promote.ts` writes slots and verification records through a GitHub client bound to the
  channels repository, using a fine-grained token with `contents: write` on that repository only,
  stored as secret `CHANNELS_WRITE_TOKEN` in a `channels-write` environment restricted to `main`.
  Marking GitHub latest still targets `Tropos-AI/tropos-code` (the flag stays editable on
  immutable releases).
- Promotion invariants read "has a verification record" instead of "has `verified.json`".

## Notes for later tasks

- **Task 11 (`flock.ts`):** the D5 list matches the plan. linux-arm64-musl is first exercised by
  the musl CI job.
- **Task 22 (`install.sh`):** the plan's D3 `case` lacks musl's wording; add `*"option: Y"*`.
  The `ldd /bin/sh` musl fallback is unverified (it printed nothing on every Linux runner);
  test it directly.
- **Task 26 (`promote.ts`):** the plan checks GitHub latest through the API only; per D6a the
  API already reports the first release as latest while the public download route does not, so
  the check must also read `releases/latest/download/manifest.json` (or always mark the first
  release).
- **Tasks 28 and 30 (workflows):** per D2, replace `container: alpine:3.22` in `test-musl`,
  `smoke-draft-musl` and the public musl smoke jobs with host-runner jobs that call
  `docker run alpine:3.22`.
