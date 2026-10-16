# Tropos Code — Control plane (install, onboarding, doctor, lifecycle, web admin, scheduler) — Design Spec

**Date:** 2026-10-15 · **Status:** Scope set by the owner ("take everything from OpenClaw's and Hermes' install and setup,
make all of it work from the web, no workspace flags"). Phase 2/3 of the persistent-agent roadmap plus the operating
surface around the gateway of `2026-10-15-gateway-core-design.md`.

## 1. Goal

Today Tropos is installed with one verified command but then leaves you alone: no first-run setup, no doctor, no
uninstall, a `--workspace` flag to learn, and everything about the gateway lives in JSON files and CLI commands. OpenClaw
and Hermes treat install → onboard → operate → update → uninstall as one product. This spec brings Tropos to that bar and
past it, keeping its structure (the verified installer, the UI-free agent loop, the sandboxed gateway, the single binary
that embeds its web app).

The feature inventory this spec answers (read from the real install scripts and docs, see the research notes in the
conversation) is, per area:

| Area | OpenClaw / Hermes | Tropos before | This spec |
|---|---|---|---|
| Installer | flags, dry-run, verbose log, rc-file PATH edit, upgrade detection, hand-off to onboarding, opens dashboard | verified download, prints a PATH hint | all of these, keeping signature verification |
| Onboarding | guided wizard, key validation, daemon install, health check, dashboard | none | engine + `tcode onboard` + web wizard |
| Doctor | checks + `--fix`, `--lint` for CI, config migration | none | `tcode doctor` and a web System page |
| Status / logs | `status --deep/--json`, `logs -f` | none | `tcode status`, `tcode logs`, web pages |
| Config | `config get/set/validate`, form editor with schema, backups of the file | read-only except one rule | write-back store + CLI + schema-driven web form |
| Backup / reset / uninstall | `backup`, `reset --scope`, `uninstall` with scopes and `--dry-run` | manual `rm -rf` | all three, scoped, with `--dry-run` and `--yes` |
| Service | launchd + systemd + schtasks, start/stop/restart/logs | macOS launchd install only | launchd + systemd, full lifecycle |
| Projects | agents/workspaces, profiles | one `--workspace` | a managed default project, a project list in the web UI, `/project` in chats |
| Scheduler | cron with delivery to channels, run history | none | cron engine, CLI, agent tool, web page |
| Web UI | status, config form, keys, sessions, logs, usage, cron, skills/MCP, pairing, channels, update, doctor | chat + read-only panels + keys + model | all of these |
| Security | `security audit` | none | `tcode security audit` + doctor checks |
| Migration | `claw migrate` | none | `tcode migrate openclaw|hermes` |

Out of scope here (named so they are not mistaken for omissions): more channels than Telegram, device nodes/canvas/voice,
a browser tool, a skill registry, Windows. They are the next phases.

## 2. Contracts shared by the parts

### 2.1 Data layout

```
~/.tropos/                 (TROPOS_HOME)
  settings.json            user settings (existing; now writable through src/config/store.ts)
  gateway.json             gateway settings (extended, §2.4)
  credentials.json         provider keys (existing)
  workspace/               the managed DEFAULT project, created on first use, `git init`ed
  gateway/                 pairing.json, sessions.json, chats.json, state.json, token, gateway.log, cron/
  backups/                 archives made by `tcode backup` and before risky operations
~/.local/share/tropos/     versions/, manifests/   (installer; XDG-aware, existing)
~/.local/state/tropos/     locks, update.log, install.log (installer)
~/.local/bin/tcode         symlink (and `tropos` alias)
```

### 2.2 PATH block

The installer edits shell rc files with one marked block so that uninstall can remove exactly what it added:

```
# >>> tropos installer >>>
export PATH="$HOME/.local/bin:$PATH"
# <<< tropos installer <<<
```

(fish: `fish_add_path "$HOME/.local/bin"` between the same marker lines.) `src/install/markers.ts` holds the strings and
`stripPathBlock`; `install.sh` writes the same bytes.

### 2.3 Lifecycle commands

`tcode <name> [args]` for `uninstall reset doctor status backup logs config security cron onboard dashboard migrate`
is dispatched by `src/cli/lifecycle/index.ts` to `src/cli/lifecycle/<name>.ts`, whose default export is
`run(argv, ctx: LifecycleContext): Promise<number>`. A prompt that is one of these words is written `tcode -- status`.
Every command: `--help`, exit 0 ok / 1 failure / 64 usage; destructive ones take `--dry-run` and `--yes` and refuse to
act without a terminal or `--yes`.

### 2.4 Gateway config, projects, no workspace flag

`gateway.json` gains `projects: {id, name, path}[]` and `defaultProject: string`. The built-in project `default` is
`~/.tropos/workspace` (always present, created and `git init`ed on demand). The old `workspace` key migrates into a
project named after its directory. A project path must pass `workspaceProblem`. Each chat has an active project
(`gateway/chats.json`), chosen with `/project` in Telegram or in the web UI; sessions are keyed `<chat>@<projectId>`.
`tcode gateway` needs no arguments; `--workspace` stays as a one-off override.

### 2.5 Services

`src/service/` abstracts launchd (macOS) and systemd user units (Linux): `install`, `uninstall`, `start`, `stop`,
`restart`, `status`, `logPath`. Interface in `src/service/types.ts`.

### 2.6 Doctor

`src/doctor/` holds a list of checks `{id, area, title, run, fix?}`. `runDoctor({fix, only, deep})` returns findings
`{id, level: ok|info|warn|error, message, fixable, fixed?}`. The CLI, `tcode status` and the web System page all call
it; none re-implements a check.

### 2.7 Admin API (web)

The web app talks to the process over its WebSocket. Session RPCs (`rpc`) stay as they are. New host-level calls use a
second message kind, `{t:"admin", id, method, params}` answered by `{t:"admin_result", id, ok, result|error}`, routed to
`src/web/admin/<area>.ts` modules registered in `src/web/admin/index.ts`. They work in `tcode web` and in the gateway,
need no session, and are authenticated by the same cookie. Secrets are never returned (only whether they are set).

### 2.8 Scheduler

Jobs `{id, name, schedule, prompt, project, deliver, enabled}` persisted in `gateway/cron/jobs.json` (0600);
`schedule` is `{kind:"cron", expr, tz?} | {kind:"every", ms} | {kind:"at", at}`. A run is a fresh channel-tier session in
the job's project (sandboxed, confined, asks are denied since nobody is there unless the job lists allowed commands),
its final text is delivered to `deliver` (a chat key or `none`), and a run record (start, end, status, summary) is
appended to `runs.jsonl`. The agent can create jobs with a `Cron` tool that asks first.

## 3. Security stance (unchanged, extended)

- Everything the web admin API can change is something the owner can already change by editing files; it is reachable
  only with the cookie obtained through the launch token and from loopback, with Host/Origin checks.
- Secrets (API keys, bot token) are write-only through the API.
- Uninstall and reset never touch anything outside Tropos's own directories and the marked PATH block.
- Scheduled runs use the channel tier: no host Bash, confined paths, no allow rules.

## 4. Testing

Each module is unit-tested with temp directories and fakes; destructive commands are tested against a throwaway
`TROPOS_HOME`/XDG layout, never the real one. Installer behaviour is tested with the existing `TROPOS_INSTALL_FROM` seam.
The web admin API is tested through `startWebServer`; web pages with Testing Library like the existing ones.

## 5. Known limits

Found by review or while building, and not closed in this phase:

- **The web session cookie is host-scoped, not port-scoped.** A browser sends `tropos_session` to any server on
  `127.0.0.1:*` the owner visits, so a hostile local dev server reached by that exact hostname could read it from the
  request and drive the web API with a forged Origin from server-side code. This design is older than the control plane
  (`tcode web`). The fix is to keep the key out of cookies: hand it over in the URL fragment, keep it in
  `sessionStorage`, and send it in the first WebSocket message. Until then: do not browse untrusted servers on
  `127.0.0.1`, and use `localhost` links elsewhere.
- **Usage reports only cover sessions recorded since this version.** Earlier session files carry no token counts.
- **`update.latest` is known only after a check in the running process;** `status` shows an update as available only
  when a newer version is already on disk.
- **The release-channel pointer is unsigned** (the manifest it points at is signed), so a compromised pointer could pin
  users to an older signed release. A signed minimum version or manifest expiry would close it.
- **Live MCP state in `mcp.list`** needs a manager wired into the admin context; until then servers show `unknown`.
- **Scheduled runs use the owner's project settings for permission context only through `allowCommands`;** project deny
  rules are not merged into that check (the sandbox and confinement still apply).
- **Imported and restored content is trusted once you confirm it.** `tcode migrate` and `tcode backup restore` show what
  they will replace and scan skills, but a persuasive instruction file is still an instruction file.
