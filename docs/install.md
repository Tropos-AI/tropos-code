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
printf 'tropos-release %s\n' "<the `ssh-ed25519 <base64>` part of the key line in release/allowed_signers>" > allowed_signers
ssh-keygen -lf allowed_signers          # must print SHA256:QY3xHG6gCBN84NfeYw1Vy1r5G0NpGTf0jDR02/QVLr8
ssh-keygen -Y verify -f allowed_signers -I tropos-release -n tropos-installer -s install.sh.sig < install.sh
sh install.sh "$v"
```

Release key fingerprint: `SHA256:QY3xHG6gCBN84NfeYw1Vy1r5G0NpGTf0jDR02/QVLr8` (also in the README).

## Commands

| Command | What it does |
|---|---|
| `tropos install [stable\|latest\|<version>] [--force]` | One-time install of a release (no target means `latest`); does not change your update channel. `--force` re-verifies and re-activates a version that is already installed, and replaces a `~/.local/bin/tropos` that Tropos did not create |
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

Uninstall: `rm -rf ~/.local/share/tropos ~/.local/state/tropos ~/.local/bin/tropos` (use the `tropos` directories under `$XDG_DATA_HOME` and `$XDG_STATE_HOME` instead when those are set). `~/.tropos` holds your settings, saved provider keys, memory and sessions; remove it too only if you want those gone.

## Exit codes

0 ok · 1 other error · 64 usage · 65 verification failed · 69 network · 73 local problem (permissions, disk, not a native install) · 75 another install is running.

Before the first release is promoted, `install.sh` and `install.sh stable` exit 69 with "no release
has been published yet, or the release server could not be reached"; the first release's promotion
sets both `latest` and `stable`. Installing an explicit version works.

## For maintainers

### One-time repository setup

All of this is mandatory before the first release; none of it is optional hardening.

- Environment `release-signing` (Tropos-AI/tropos-code → Settings → Environments): required reviewers
  with "Prevent self-review" on; deployment branches and tags = "Selected branches and tags" → `main` only;
  secret `TROPOS_RELEASE_SIGNING_KEY` = the full private key file.
- Environment `channels-write`: required reviewers; deployment branches = `main` only; secret
  `CHANNELS_WRITE_TOKEN` = a fine-grained token with Contents: read and write on
  `Tropos-AI/tropos-code-channels` only.
- Repository `Tropos-AI/tropos-code-channels`: **public** (installers and `promote.ts` read pointers
  unauthenticated; a private repository would make the public smoke test's stable check silently skip),
  with one initial commit so releases can be created.
- On `Tropos-AI/tropos-code`: enable release immutability (Settings → General → Releases); add a tag
  ruleset for `v*` (creation restricted to maintainers, block updates and deletions); require pull-request
  review on `main`.

Why the environments are the real guard: `workflow_dispatch` runs the workflow file from the dispatched
ref, so the "only from main" checks inside the workflows are defence in depth. The main-only deployment
policy and the required reviewers are what protect the signing key and the channels token.

### Releasing and channels

- Releasing: bump `version` in `package.json` on `main`, push tag `v<version>`, approve the `release-signing` deployment. The pipeline smoke-tests the draft and the public release on six platforms and only then moves `latest`. Moving `latest` (`promote-latest`) runs in the `channels-write` environment, so a release needs a second approval there. The `promote` workflow and the `channels-health` repair also need `channels-write` approval.
- Stable: run the `promote` workflow with the version (it must be verified and not ahead of latest; it never moves stable backwards).
- Pointer health: `channels-health` runs every 6 hours; dispatch it with `repair: true` to fix a missing or mismatched slot.
- Where pointers live: the channel pointers (`latest`, `latest.bak`, `stable`, `stable.bak`) and the `verified-<version>.json` records are assets of the `channels` release in `Tropos-AI/tropos-code-channels`. Version releases in `Tropos-AI/tropos-code` are immutable once published.
- Cancelled pending runs: `release`, `promote` and `channels-health` share the `channels` concurrency group, and GitHub keeps only one pending run per group. Re-dispatch a cancelled pending release from `main` with `tag: vX.Y.Z` (convergent, safe); re-dispatch promote or repair with the same inputs.

### Keys

- Key rotation (K1 → K2): (1) add K2 to `release/allowed_signers` and `install.sh`, release; (2) when GitHub's latest installer and the stable binary both trust K2, put K2 in the secret — the old-client gate refuses earlier; (3) remove K1 in a later release. After step 3, versions signed only with K1 are no longer Verified on users' machines, so they cannot be rolled back to and cleanup may remove them.
- Key compromise: rotate as above immediately, publish a release signed with the new key, and tell users to reinstall with `install.sh`; binaries that only trust the old key cannot update.
