# Install and verify

This page covers installing Tropos Code with the one-line installer, the installer's flags, what it changes on your
machine, how to verify a release yourself before running it, and how to uninstall. Tropos Code runs on macOS
(arm64, x64) and Linux (arm64, x64, glibc or musl). After installing, continue with [Onboarding](onboarding.md);
keeping it up to date is in [Updates and rollback](updates.md).

## Install

```sh
curl -fsSL https://troposlabs.com/install.sh | sh
curl -fsSL https://troposlabs.com/install.sh | sh -s -- stable
curl -fsSL https://troposlabs.com/install.sh | sh -s -- X.Y.Z    # a specific release
```

Needs `curl` or `wget`, `sha256sum` or `shasum`, and `ssh-keygen` from OpenSSH 8.1 or newer
(Debian/Ubuntu: `openssh-client`; Alpine: `apk add openssh-keygen`; Fedora: `openssh-clients`).
`zstd` is optional and makes the download about three times smaller.

### Flags and environment variables

Flags go anywhere on the command line (`curl … | sh -s -- --dry-run stable`); a bare `--` is ignored and
an unknown flag exits 64 with the usage text.

| Flag | Environment | Effect |
|---|---|---|
| `--dry-run` | `TROPOS_DRY_RUN` | Resolves the version (it fetches and verifies the channel pointer and the signed manifest) and prints an install plan: version, channel, platform, binary URL, install directory, symlinks, the shell files that would be edited, upgrade or fresh, and whether onboarding would run. Downloads no binary, writes nothing, exits 0 |
| `--no-modify-path` | `TROPOS_NO_MODIFY_PATH` | Leaves shell startup files alone and prints the line to add yourself |
| `--no-onboard` | `TROPOS_NO_ONBOARD` | Does not start `tcode onboard` after a fresh install; prints `Run: tcode onboard` |
| `--onboard` | | Starts onboarding even when `CI` or `TROPOS_NO_ONBOARD` would skip it (a terminal is still required, and only a fresh install is ever onboarded) |
| `--non-interactive`, `--no-prompt` | `TROPOS_NO_PROMPT` | Never prompts and never onboards |
| `--verbose` | `TROPOS_VERBOSE` | Shows the full output of every step |
| `--help` | | Prints the usage |
| | `CI` | Implies `--non-interactive`, `--verbose` and `--no-onboard` |
| | `NO_COLOR` | No colour (colour is also off whenever stdout is not a terminal) |
| | `TROPOS_INSTALL_ALLOW_SUDO` | Allows running under `sudo` (installs for root); otherwise the installer refuses |
| | `TROPOS_INSTALL_FROM` | Installs an explicit version from a local folder of release files (manifest, signature, binary), still fully verified |

A variable counts as set when it is non-empty and not `0`, `false`, `no` or `off`. Flags win over variables.

### What the installer does

1. Resolves the version, downloads the signed manifest and verifies the signature, then the binary's size and SHA-256 (see below).
2. Runs the binary's `install --self`, which puts the version under `~/.local/share/tropos/versions` and links `~/.local/bin/tcode`.
3. **Upgrade detection.** If `tcode` is on `PATH`, `~/.local/bin/tcode` exists, or the versions directory has entries, this is an upgrade (or a re-run): it prints `Upgraded X -> Y` and runs `tcode doctor --fix --yes` (a failure only warns). When a gateway service is installed (a launchd or systemd unit with `tropos` in its name), it stops it with `tcode gateway stop` before that check and starts it again afterwards with `tcode gateway install`, which points the service at the new version (a failure only warns). Re-running the same version repairs but does not restart the gateway. Upgrades and re-runs never start onboarding.
4. **PATH.** Unless `--no-modify-path`, or `~/.local/bin` is already on `PATH` and a block already exists, it appends the block below to the startup files of the shell named by `$SHELL`. It never adds the block twice, never writes to a file that is not writable (it warns instead), and prints which files changed and a `source …` line.
5. **Onboarding.** On a fresh install (no `~/.tropos/settings.json`, `credentials.json` or `gateway.json`, and no earlier install) with a terminal, it connects `/dev/tty` and runs `tcode onboard`. Without a terminal, or with `--no-onboard`, `CI` or `--non-interactive`, it prints `Run: tcode onboard`.
6. Prints a summary: version, location, next steps and a link to this page.

It cleans up its temporary directory on exit, Ctrl-C, `HUP` and `TERM`. It never uses `sudo`.

### The PATH block

```sh
# >>> tropos installer >>>
export PATH="$HOME/.local/bin:$PATH"
# <<< tropos installer <<<
```

fish gets `fish_add_path "$HOME/.local/bin"` between the same two marker lines. When the file is not empty and does not already end with a blank line, one blank line is written first. Uninstall removes exactly this block (`tcode uninstall`).

| `$SHELL` | Files |
|---|---|
| zsh | `~/.zshrc` (created if missing), `~/.zprofile` (if it exists); `$ZDOTDIR` is used instead of `~` when it is set to an absolute path |
| bash | `~/.bashrc` (created if missing), `~/.profile` if it exists, and `~/.bash_profile` or else `~/.bash_login` if it exists |
| fish | `~/.config/fish/config.fish` (created if missing) |
| anything else | `~/.profile` (created if missing) |

### The install log

Everything the installer does, and the full output of each step, is appended to
`$XDG_STATE_HOME/tropos/install.log` (default `~/.local/state/tropos/install.log`; directory mode 0700, file mode 0600),
each run under a timestamped header. The installer prints its progress in the same gutter look as `tcode onboard` (`┌ │ ◆ ◇ └`, with colour on a terminal; plain `+ | * o` when `NO_COLOR` is set or the locale is not UTF-8); `--verbose` or `CI`
shows everything. When a step fails, the installer prints the last 20 lines of the log and its path. A dry run writes no log.

### What you are trusting

The one-line install trusts GitHub's HTTPS to deliver `install.sh` itself. From then on, every
release is checked against the Tropos release key pinned inside `install.sh` and inside `tcode`:
the manifest's ed25519 signature first, then the binary's size and SHA-256. Nothing is run or
installed if any check fails.

### Verify the installer before running it

```sh
v=X.Y.Z   # the release to install: https://github.com/Tropos-AI/tropos-code/releases
curl -fsSLO "https://troposlabs.com/releases/$v/install.sh"
curl -fsSLO "https://troposlabs.com/releases/$v/install.sh.sig"
printf 'tropos-release %s\n' "<the `ssh-ed25519 <base64>` part of the key line in release/allowed_signers>" > allowed_signers
ssh-keygen -lf allowed_signers          # must print SHA256:QY3xHG6gCBN84NfeYw1Vy1r5G0NpGTf0jDR02/QVLr8
ssh-keygen -Y verify -f allowed_signers -I tropos-release -n tropos-installer -s install.sh.sig < install.sh
sh install.sh "$v"
```

Release key fingerprint: `SHA256:QY3xHG6gCBN84NfeYw1Vy1r5G0NpGTf0jDR02/QVLr8` (also in the README).

## Commands

| Command | What it does |
|---|---|
| `tcode install [stable\|latest\|<version>] [--force]` | One-time install of a release (no target means `latest`); does not change your update channel. `--force` re-verifies and re-activates a version that is already installed, and replaces a `~/.local/bin/tcode` that Tropos did not create |
| `tcode update` / `tcode upgrade` | Newest release of your channel; never older |
| `tcode update --version <version>` | Installs that release (the same as `tcode install <version>`) |
| `tcode rollback` | Back to the previous version; updates then skip the one you left |
| `tcode -- update` | Everything after `--` is a prompt |

## Background updates

Settings in `~/.tropos/settings.json` (repository settings cannot change these):

```json
{ "autoUpdates": true, "autoUpdatesChannel": "latest" }
```

Interactive sessions check at most every 6 hours (longer after failures) and install newer releases
in the background; the next session prints "Updated to <version>". Set `"autoUpdates": false` or
`TROPOS_DISABLE_AUTOUPDATER=1` to turn this off. Print mode (`-p`) and CI never update. Channels, the dashboard's
update controls and rolling back: [Updates and rollback](updates.md).

## Files

`~/.local/share/tropos/versions/<version>` (binaries), `~/.local/share/tropos/manifests/` (signed
manifests), `~/.local/state/tropos/` (state, locks, `update.log`, `install.log`), `~/.local/bin/tcode` (symlink) and `~/.local/bin/tropos` (the command's former name, kept as a symlink to `tcode`).
`XDG_DATA_HOME` and `XDG_STATE_HOME` are honoured when absolute.

Uninstall: `tcode uninstall` (see `tcode uninstall --help` for scopes, `--dry-run` and `--yes`). It removes the PATH block the installer added. `~/.tropos` holds your settings, saved provider keys, memory and sessions; it is kept unless you choose to remove it. Without a working `tcode`, by hand: `rm -rf ~/.local/share/tropos ~/.local/state/tropos ~/.local/bin/tcode ~/.local/bin/tropos` (use the `tropos` directories under `$XDG_DATA_HOME` and `$XDG_STATE_HOME` instead when those are set) and delete the block between the `# >>> tropos installer >>>` markers from your shell startup files.

## Exit codes

0 ok · 1 other error · 64 usage · 65 verification failed · 69 network · 73 local problem (permissions, disk, not a native install) · 75 another install is running.

Before the first release is promoted, `install.sh` and `install.sh stable` exit 69 with "no release
has been published yet, or the release server could not be reached"; the first release's promotion
sets both `latest` and `stable`. Installing an explicit version works.

## Troubleshooting

- **`tcode: command not found` after installing.** Open a new terminal, or run the `source …` line the installer
  printed. With `--no-modify-path`, add `export PATH="$HOME/.local/bin:$PATH"` to your shell's startup file.
- **A step failed.** The installer prints the last 20 lines of its log; the whole log is `tcode logs install`
  (or `~/.local/state/tropos/install.log`). Re-running the installer is safe: the same version is repaired in
  place.
- **Exit 65 (verification failed).** Nothing was installed. Try again later; if it persists, report it as described
  in [SECURITY.md](../SECURITY.md).
- **Exit 75.** Another install or update is running; wait for it and run the installer again.
- **"do not run this installer with sudo".** Tropos Code installs into your home directory: run the installer as
  your own user. Set `TROPOS_INSTALL_ALLOW_SUDO=1` only if you really want to install for root.

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
- Where pointers live: the channel pointers (`latest`, `latest.bak`, `stable`, `stable.bak`) and the `verified-<version>.json` records are assets of the `channels` release in `Tropos-AI/tropos-code-channels`. Version releases in `Tropos-AI/tropos-code` are immutable once published. GitHub's download edge caches these files, so for about two minutes after a promotion installers may still see the previous pointer (or none, right after the first release); `promote.ts` reads through the API and is not affected.
- Cancelled pending runs: `release`, `promote` and `channels-health` share the `channels` concurrency group, and GitHub keeps only one pending run per group. Re-dispatch a cancelled pending release from `main` with `tag: vX.Y.Z` (convergent, safe); re-dispatch promote or repair with the same inputs.

### Keys

- Key rotation (K1 → K2): (1) add K2 to `release/allowed_signers` and `install.sh`, release; (2) when GitHub's latest installer and the stable binary both trust K2, put K2 in the secret — the old-client gate refuses earlier; (3) remove K1 in a later release. After step 3, versions signed only with K1 are no longer Verified on users' machines, so they cannot be rolled back to and cleanup may remove them.
- Key compromise: rotate as above immediately, publish a release signed with the new key, and tell users to reinstall with `install.sh`; binaries that only trust the old key cannot update.
