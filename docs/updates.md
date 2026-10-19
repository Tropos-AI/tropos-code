# Updates and rollback

Tropos keeps itself up to date. Interactive sessions check for a newer release now and then and install it in the
background; you can also update on demand from the terminal, the dashboard, or by asking the agent. Every release is
verified against the Tropos release key before it is installed, an update never installs an older version, and
`tcode rollback` takes you back to the previous one.

## Channels

| Channel | What you get |
|---|---|
| `latest` (default) | Every release, once it has passed the release pipeline's smoke tests on all platforms |
| `stable` | Releases that maintainers promoted after they proved themselves on `latest` |

Pick the channel in the dashboard (Settings → Service & updates), or:

```bash
tcode config set autoUpdatesChannel stable
```

Changing the channel doesn't move you to an older version; you stay where you are until the channel catches up.

## Background updates

In `~/.tropos/settings.json`:

```json
{ "autoUpdates": true, "autoUpdatesChannel": "latest" }
```

- Interactive terminal sessions check at most every 6 hours (less often after failures, up to every 48 hours) and
  install a newer release of your channel in the background. The next session prints "Updated to <version>".
- Print mode (`-p`), CI, and runs without a terminal never update.
- Turn it off with `"autoUpdates": false`, the dashboard's "Install updates automatically" switch, or the environment
  variable `TROPOS_DISABLE_AUTOUPDATER=1`.
- Repository settings files can't change these keys.

The background updater's output goes to `update.log`: `tcode logs update`.

## Updating now

```bash
tcode update                    # the newest release of your channel (tcode upgrade is the same)
tcode update --version 0.5.2    # a specific release
tcode install 0.5.2             # the same; also: tcode install stable | latest
```

In the dashboard, Settings → Service & updates shows the installed and latest versions with **Check now** and
**Update now**. Or ask the agent: "update Tropos".

Re-running the installer (`curl -fsSL https://troposlabs.com/install.sh | sh`) also upgrades in place: it runs
`tcode doctor --fix --yes` and restarts the gateway service with the new version.

### The background service after an update

The gateway keeps running the version it started with. After `tcode update` or **Update now**, restart it so it runs
the new version:

```bash
tcode gateway restart
```

(or Settings → Service & updates → Restart). When you ask the agent to update, it restarts the service itself if it
is running, and says so. The installer restarts it too.

## Rolling back

```bash
tcode rollback
```

Returns to the previous installed version after verifying it. Background updates then skip the version you rolled
back from until a newer release appears. `tcode status` shows the installed version and the update state.

## Where versions live

Installed versions are kept in `~/.local/share/tropos/versions/<version>`, signed manifests in
`~/.local/share/tropos/manifests/`, and state, locks and logs in `~/.local/state/tropos/`. `~/.local/bin/tcode` is a
link to the active version. See [Install and verify](install.md#files).

## Troubleshooting

- **"Updated to …" never appears.** Check `tcode status` (update state), that `autoUpdates` is on, that
  `TROPOS_DISABLE_AUTOUPDATER` isn't set, and `tcode logs update`.
- **The dashboard still shows the old version.** Restart the gateway: `tcode gateway restart`.
- **An update failed verification.** Nothing was installed; the old version keeps running. Try again later, and see
  `tcode logs update`.
- **"another install is running".** Wait for the other install or update to finish, then try again.
- **Something broke after an update.** `tcode rollback`, then `tcode doctor`.
