# Backups

A backup is one archive of everything that makes your Tropos yours: settings, the gateway's configuration, saved
provider keys, memory, skills, plugins, identity, specialists and sessions. Make one before a big change, move it to
another computer, or restore it after a mistake. Tropos also makes one by itself before anything destructive.

## Create a backup

```bash
tcode backup create
```

This writes `~/.tropos/backups/tropos-backup-<time>.tar.gz` (mode 0600, readable only by you) and prints its path.
Or in the dashboard: Settings → Backups.

| Option | Does |
|---|---|
| `--output <dir\|file.tar.gz>` | Write it somewhere else |
| `--quick` | Leave out sessions, plugins and learning data |
| `--no-sessions` | Leave out sessions |
| `--no-secrets` | Leave out `credentials.json` and secret values in `settings.json` and `gateway.json` |
| `--include-workspace` | Also include your own files in the managed workspace, `~/.tropos/workspace` (the agent's own files there, such as `AGENTS.md`, `MEMORY.md`, the journal and skills, are always included) |
| `--verify` | Check the archive right after writing it |
| `--dry-run` | Show what would be archived, write nothing |

A backup that includes secrets holds your provider keys and bot token: keep it as private as `~/.tropos` itself, or
use `--no-secrets`.

## List and verify

```bash
tcode backup list                 # archives in ~/.tropos/backups
tcode backup verify <archive>     # check every file against the archive's manifest
```

## Restore

```bash
tcode backup restore <archive> --dry-run      # see what would change
tcode backup restore <archive>                # verify, back up the current state, then write the files back
tcode backup restore <archive> --only memory,skills
```

Parts for `--only`: `config`, `credentials`, `identity`, `sessions`, `memory`, `skills`, `plugins`, `learning`,
`gateway`, `workspace`, `agents`.

Restoring always verifies the archive first and backs up what you have now, so a restore can itself be undone.

**Restoring things that run code or let people in needs a second yes.** Hooks, MCP servers, skills, plugins, the
pairing list, scheduled jobs, `SOUL.md` and similar files decide what runs on your computer and who can talk to your
agent. When a backup would replace any of them, they are listed first and need a separate confirmation; without a
terminal, `--trust-code` is needed as well as `--yes`. Only restore archives you made yourself or fully trust.

Login state is never restored: `gateway/token`, `devices.json` and `login-codes.json` are skipped, so browsers log in
again after a restore.

## Backups Tropos makes for you

- `tcode reset` and `tcode uninstall --data` back up `~/.tropos` first (unless `--no-backup`), and print the path.
- `tcode migrate` backs up `~/.tropos` before writing (unless `--no-backup`).
- `tcode backup restore` backs up the current state before writing.
- `tcode config set`, `unset` and the dashboard's config editor keep the last five versions of the file next to it
  (`settings.json.bak`, `.bak.1` … `.bak.4`).

## Moving to another computer

1. On the old computer: `tcode backup create --output ~/tropos.tar.gz`.
2. Install Tropos on the new one (`curl -fsSL https://troposlabs.com/install.sh | sh -s -- --no-onboard`).
3. Copy the archive over and run `tcode backup restore ~/tropos.tar.gz`.
4. Run `tcode doctor --fix`, then `tcode gateway install` to start the service, and `tcode dashboard` to log in
   again. Projects point at folders by path, so check them on the Projects page.

## Troubleshooting

- **Verification fails.** The archive was changed or is incomplete; don't restore it. `tcode backup verify` names the
  files that don't match.
- **"needs --trust-code".** The archive replaces files that can run code; check what it lists, then add
  `--trust-code --yes` if you trust it.
- **After restoring, the dashboard asks for a code.** Expected: logins aren't restored. Run `tcode dashboard`.
