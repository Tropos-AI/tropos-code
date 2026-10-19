# Updates and rollback

Tropos keeps itself up to date, and automatic updates are on by default. Both the background service and your
terminal sessions check for a newer release now and then and install it in the background; the background service
then restarts into the new version as soon as nothing is running. You can also update on demand from the terminal,
the dashboard, or by asking the agent. Every release is verified against the Tropos release key before it is
installed, an update never installs an older version, and `tcode rollback` takes you back to the previous one.

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

## Automatic updates

In `~/.tropos/settings.json` (on unless you turn it off):

```json
{ "autoUpdates": true, "autoUpdatesChannel": "latest" }
```

How it works:

1. **Checking.** The background service checks every 6 hours (less often after failures, up to every 48 hours), so
   an owner who only uses Telegram or the dashboard gets updates too. Interactive terminal sessions follow the same
   schedule. A newer release of your channel is downloaded, verified and installed in the background.
2. **Moving the service to it.** The background service looks every few minutes at which version `tcode` now points
   to. When a newer one is installed (by a background update or by hand) and nothing is running (no chat turn, no
   approval waiting, no scheduled job), it stops cleanly and the service manager (launchd or systemd) starts it again
   on the new version. Open dashboard tabs show "Updating to <version>… The dashboard reconnects by itself in a few
   seconds." While something is running it waits and looks again; it never cuts a turn off.
3. **Terminal sessions.** The next session after an update prints "Updated to <version>".

A gateway you run yourself in a terminal (`tcode gateway`) doesn't restart itself; it prints "Tropos Code <version>
is installed; this gateway still runs <old>. Restart it to use <version> (ctrl+c, then tcode gateway)."

Turning it off:

- the dashboard's "Install updates automatically" switch (Settings → Service & updates);
- `"autoUpdates": false` in `~/.tropos/settings.json`;
- the environment variable `TROPOS_DISABLE_AUTOUPDATER=1`.

Print mode (`-p`) and CI never update, a local build (`bun run install:local`) never updates, and repository settings
files can't change these keys. The setup's last step (`tcode onboard`, and the dashboard's Setup page) says whether
automatic updates are on and where to turn them off.

The background updater's output goes to `update.log`: `tcode logs update`.

## Updating now

```bash
tcode update                    # the newest release of your channel (tcode upgrade is the same)
tcode update --version X.Y.Z    # a specific release
tcode install X.Y.Z             # the same; also: tcode install stable | latest
```

After moving to a newer version, `tcode update` restarts a running background service so it runs the new version
("Restarted the background service; it runs <version> now."). A stopped service stays stopped and runs the new version
when it starts. If the restart fails, the update itself still stands and the message says so.

In the dashboard, Settings → Service & updates shows the installed and latest versions with **Check now** and
**Update now**. Update now installs the update and then, if the background service runs, restarts it so it runs the
new version; open chats pause for a few seconds and the page reconnects by itself.

Or ask the agent: "update Tropos". It updates, then restarts the service if it is running, and says so.

Re-running the installer (`curl -fsSL https://troposlabs.com/install.sh | sh`) also upgrades in place: it runs
`tcode doctor --fix --yes` and restarts the background service with the new version.

## Rolling back

```bash
tcode rollback
```

Returns to the previous installed version after verifying it. Background updates then skip the version you rolled
back from until a newer release appears. `tcode status` shows the installed version and the update state. If the
background service runs, restart it so it runs the version you went back to: `tcode gateway restart`.

## Where versions live

Installed versions are kept in `~/.local/share/tropos/versions/<version>`, signed manifests in
`~/.local/share/tropos/manifests/`, and state, locks and logs in `~/.local/state/tropos/`. `~/.local/bin/tcode` is a
link to the active version. See [Install and verify](install.md#files).

## Troubleshooting

- **No update arrives.** Check `tcode status` (update state), that "Install updates automatically" is on, that
  `TROPOS_DISABLE_AUTOUPDATER` isn't set, and `tcode logs update`.
- **The dashboard still shows the old version.** The service waits until nothing is running before it restarts;
  `tcode logs gateway` says what it is waiting for. To move now, `tcode gateway restart`.
- **An update failed verification.** Nothing was installed; the old version keeps running. Try again later, and see
  `tcode logs update`.
- **"another install is running".** Wait for the other install or update to finish, then try again.
- **Something broke after an update.** `tcode rollback`, `tcode gateway restart`, then `tcode doctor`.
