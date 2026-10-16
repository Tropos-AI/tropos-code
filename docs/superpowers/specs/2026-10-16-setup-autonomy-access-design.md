# Tropos Code — Guided setup, chat autonomy without Docker, one dashboard, phone access — Design Spec

**Date:** 2026-10-16 · **Status:** Draft for the owner's approval. First of two documents; the second covers the
OpenClaw-style home layout, an agent that configures itself, and automatic projects.

## 1. Intent

The point of Tropos is that the agent does everything and the user does nothing. Today the pieces exist (installer,
`tcode onboard`, gateway, Telegram, web UI) but using them still takes work the user shouldn't have to do:

- The wizard asks seven questions with little explanation, then leaves Telegram pairing, projects and the dashboard to
  separate commands.
- Chats can't do anything without Docker, and with Docker the sandbox is `alpine:3.22` with no network, git, node or
  python, so a task sent from the phone rarely gets done. Every edit and command from a chat also needs an approval tap.
- There are two web UIs (`tcode web` and the gateway's) and overlapping commands and pages: `status` / `gateway status` /
  `doctor`, Config / Settings / System / Status.
- The port changes when 4317 is taken, `tcode web` makes a new key on every start, and the session cookie dies with the
  browser, so the user keeps pasting long links.
- The dashboard can't be opened from the phone.

The owner wants: a step-by-step guided setup right after the download, commands from chats running on the Mac without
Docker, a user-chosen autonomy level, the duplication removed, a fixed port, logging in to the dashboard once per
browser, and opening it from the phone through Tailscale.

## 2. Goals, non-goals, anti-goals

**Goals**

1. After `curl … | sh`, a wizard walks the user through the **full** setup, one explained step at a time, with
   everything it can detect already filled in. Enter accepts the suggestion. No file is ever edited by hand.
2. Chats and scheduled jobs run commands on the Mac itself; Docker is optional extra isolation.
3. The user picks how autonomous chats are (three levels), globally and per project.
4. One web UI, one way to open it, fewer commands and pages.
5. The dashboard is always at `http://localhost:4317`. A browser logs in once and stays logged in.
6. The dashboard opens on the phone over Tailscale, set up by the wizard.

**Non-goals (this document)**

- Home-directory layout (`workspace/` with AGENTS.md, SOUL.md …), the self-configuring agent, automatic project
  registration from the terminal: document 2.
- Signing in with a ChatGPT or Claude subscription (needs a check of each provider's terms first).
- More channels than Telegram, Windows, the TUI as a client of the daemon, WebFetch in chats.
- Authenticating with Tailscale identity headers (a device code is enough for now).

**Anti-goals: it fails even if it technically works when**

- any step still requires editing a JSON file;
- the dashboard moves to a random port, or the user has to paste a long key;
- a chat message, a repo file or the agent itself can raise its own autonomy;
- the dashboard is reachable from the LAN or the internet (only loopback, and the tailnet through `tailscale serve`);
- an existing install silently loses protection it had.

## 3. Constraints

- Match the repo: TypeScript on Bun, zod, colocated `*.test.ts`, TDD, short comments that say why, no new runtime
  dependencies unless clearly justified in the plan.
- The onboarding engine (`src/onboard/engine.ts`) stays the single source of truth for both the terminal wizard and the
  web Setup page; neither re-implements a step.
- Everything security-relevant stays described in the README's honest style: what it protects and what it doesn't.
- macOS is the primary target, Linux must keep working. Web testing per the owner's rules: screenshots at 320, 375,
  768, 1024, 1440; keyboard and reduced-motion checks; both themes.

## 4. Part A — Guided setup

### 4.1 Flow

The installer already hands over to `tcode onboard` on a fresh install with a terminal. The wizard becomes:

| # | Step | What it does | Default / detection |
|---|---|---|---|
| 0 | Welcome | Says what will happen and that it takes about 3 minutes; each later step can be skipped and done later. | — |
| 1 | Connect a model | Lists what it found: env keys, saved keys, Ollama / LM Studio answering. If nothing: picks a provider (Anthropic first), opens that provider's key page in the browser, waits for the paste, validates it with a real request. | The first detected connection |
| 2 | Model | The provider's best model, with a short list to change it. | Best model of the provider |
| 3 | Name and personality | The identity ritual that today runs on the first interactive session (name, vibe, emoji) moves here; skipped → it still runs later as today. | Suggested name/vibe/emoji |
| 4 | Projects | Finds git repositories under common folders (`~/Desktop`, `~/Documents`, `~/Developer`, `~/code`, `~/Projects`, `~/src`, `~/dev`; shallow, bounded, skips `node_modules` and hidden dirs) and offers a checklist. The built-in default workspace is always there. | Nothing pre-ticked except repos touched in the last 30 days |
| 5 | Autonomy | The three levels of §5.2, each with one sentence about its risk. | Balanced |
| 6 | Telegram | Step by step: opens `https://t.me/BotFather` with three numbered instructions, takes the token, verifies it, then says "send any message to @your_bot now". The wizard polls the bot itself, shows who wrote ("Panagiotis (@handle) — is this you? [Y/n]") and approves that sender directly. No pairing code. | Skippable |
| 7 | Phone access | Part D: checks Tailscale, guides install/login, enables `tailscale serve`, prints a QR code of the dashboard URL and a one-time login code. | Offered only if Telegram or the user says they want phone access; skippable |
| 8 | Run in the background | Installs and starts the login service. | Yes |
| 9 | Done | Health check (doctor, read-only), then a summary: what is set up, the dashboard link, the bot link, three example things to ask. Opens the dashboard, already logged in (§7.2). | — |

Rules for every step:

- One sentence on why the step exists, then the detected answer. Enter accepts, `s` skips, `b` goes back.
- The state is read from the machine each time (as the engine does today), so quitting and re-running resumes.
- Errors say what to do next in plain words (e.g. "That key was rejected by Anthropic. Check you copied all of it").
- The Docker sandbox step is removed from the wizard; Docker moves to Settings → Advanced (§6.2).
- `--advanced` asks every option the current wizard asks; `--non-interactive` and the existing flags keep working.

### 4.2 Web

The web Setup page shows the same steps from the same engine, including the Telegram "send a message now" step and the
Tailscale step with the QR code. It opens automatically while the required steps (1, 2) are not done.

### 4.3 Later reminders

A skipped optional step is remembered. The agent mentions it once, at a natural moment in a later session ("You can
reach me from your phone too; want to set up Telegram?"), and `tcode status` lists it. Never more than once per step.

## 5. Part B — Chats without Docker, with an autonomy level

### 5.1 Where commands run

- New execution backend setting for chats and scheduled runs: `host` (default for new installs) or `docker`.
- `host` runs commands with the local backend in the project directory, wrapped in the operating system's own
  confinement when it is available:
  - macOS: `sandbox-exec` with a generated profile.
  - Linux: `bwrap` when installed.
  - Neither available: the wizard offers to install `bwrap` and explains why. Without it, `ask` works as usual;
    choosing `balanced` or `autonomous` needs an explicit "run unconfined" confirmation, and doctor/status keep
    warning about it.
- The confinement profile (same at every autonomy level, and what makes "autonomous" tolerable):
  - **Writes** allowed only to the project directory, the system temp directory and package-manager caches (npm, bun,
    pnpm, yarn, pip, cargo, go, Homebrew's cache …).
  - **Writes always denied** to `.git/hooks`, `.git/config`, `.husky` (and submodule equivalents), replacing what the
    Docker read-only mounts did.
  - **Reads denied** for secrets: `~/.ssh`, `~/.tropos`, `~/.aws`, `~/.gnupg`, `~/.config/gh`, `~/.docker/config.json`,
    `~/.netrc`, keychains, browser profiles; the exact list lives in one place and is tested. The built-in default
    project `~/.tropos/workspace` is carved out of the `~/.tropos` denial.
  - **Network** allowed.
- The command environment for chats is an allowlist (`PATH`, `HOME`, `USER`, `SHELL`, `LANG`, `LC_*`, `TERM`, `TMPDIR`)
  rather than today's scrub-the-secrets list.
- **Existing installs** (all of which use Docker today, since chats can't run without it) keep `docker` and the `ask`
  level. The wizard and doctor offer the switch to `host` and a higher level, and nothing changes until the user
  accepts (no silent weakening). New installs get `host` and `balanced`.

### 5.2 Autonomy levels

`autonomy: "ask" | "balanced" | "autonomous"` in the user config, overridable per project entry.

| | File edits in the project | Read-only commands and the project's tests | Other commands | MCP tools |
|---|---|---|---|---|
| **ask** | ask | ask | ask | ask |
| **balanced** (default) | allowed | allowed | ask | ask |
| **autonomous** | allowed | allowed | allowed | ask |

At every level, unchanged from today: file tools confined to the project, deny rules win, `.git`/`.husky` writes ask,
no bypass mode, no SessionSearch or WebFetch, no background learning from chat text.

- "Read-only command" needs a classifier (none exists yet): a conservative allowlist of commands and subcommands that
  can't write (`ls`, `cat`, `rg`, `git status|diff|log|show`, …), with the existing parser's rule that anything it can't
  model (substitution, redirection, heredocs …) is not read-only.
- "The project's tests" means test commands detected from the project (`package.json` `scripts.test`, `bun test`,
  `cargo test`, `go test ./...`, `pytest` …), shown to the user in the Autonomy settings and pinned once confirmed
  there. Under `balanced`, edits to the files that define those commands (`package.json`, `Makefile`, `justfile`,
  `pyproject.toml`, `Cargo.toml`, `build.rs`, test runner configs …) ask first. Test files themselves are code the
  agent may edit and then run, so the README says plainly that `balanced` lets the agent run code it wrote, inside the
  confinement; what it still asks for is installs, pushes, deletions outside tests, network tools and everything else.
- **Scheduled runs** use the project's level instead of only `allowCommands`: `ask` → anything that would ask is denied
  (as today); `balanced` → read-only and tests run, the rest is denied; `autonomous` → everything in the project runs.
  `allowCommands` keeps working on top.
- **Who can change it:** raising the level is only possible from the terminal (`tcode config`, the wizard) or the
  web UI of a logged-in device. A chat can only lower it (`/autonomy ask` or `/autonomy balanced`), and no tool in a
  chat or scheduled session can write this setting (the confinement already blocks `~/.tropos`, and `channelContext`
  denies it). Terminal and dashboard sessions follow the normal permission prompts, as for any other settings file;
  document 2 revisits this for the self-configuring agent. A chat sees its current level with `/autonomy`.
- When the level allows something, the chat still gets a short line saying what was done, and the end-of-task message
  lists the files changed and commands run.

### 5.3 Chat in the dashboard

A logged-in dashboard device is the owner, so its Chat is an owner session like the terminal, not a channel session:
the owner's own allow rules and modes (no bypass, as today), commands on the host without the chat confinement, and
the full tool set. It gains a project picker over the registered projects (replacing `tcode web`'s "the directory I
was started in"); new chats start in the default project. Its approval prompts work on the phone (§7.3).

## 6. Part C — Removing duplication

### 6.1 Commands

| Today | After |
|---|---|
| `tcode web`, `tcode dashboard`, `tcode gateway` (foreground, also serves a web UI) | **`tcode dashboard`** is the only way to open the web UI. It opens the background service's UI; if the service is installed but stopped it starts it; if it isn't installed it offers to install it (default yes). `tcode web` becomes a hidden alias with a one-line notice. `tcode gateway` (foreground) stays for debugging but leaves the main help. |
| `tcode status`, `tcode gateway status`, `tcode doctor` | `tcode status` shows everything (service, channels, phone access, autonomy, health summary). `tcode doctor [--fix]` stays for repair. `gateway status` becomes a hidden alias. |
| `tcode logs`, `tcode gateway logs` | `tcode logs`; `gateway logs` hidden alias. |
| `update`, `upgrade`, `install <version>`, `rollback` | `tcode update [--version <v>]` and `tcode rollback`. `upgrade` and `install` stay as hidden aliases (the installer uses `install`). |
| `tcode pairing approve <code>` | Rarely needed (the wizard approves the owner); kept, moved to the advanced part of help. |

`tcode --help` is regrouped into: Start · Everyday · Setup and care · Advanced. The `tropos` alias stays, mentioned
once.

### 6.2 Web pages

From 17 sidebar entries to 9:

- **Work:** Chat · Projects · Schedule
- **Agent:** Skills · Agents · Memory · Extensions (tabs: MCP, Hooks, Plugins)
- **Control:** Status (tabs: Health, Logs, Usage) · Settings (tabs: Models & keys, Autonomy, Channels & devices, Phone
  access, Service & updates, Backups, Advanced)

Advanced holds the raw config editor (today's Config page) and the optional Docker sandbox. Setup isn't in the sidebar
once done; Settings has "Run setup again". Old hashes (`#/config`, `#/system`, `#/channels`, `#/mcp` …) redirect to
their new tab.

### 6.3 Anything else found

While building, any further duplicate or confusing surface is listed in the plan and decided with the owner, not
removed silently.

## 7. Part D — Fixed port, log in once, phone access

### 7.1 Port

- The dashboard is always on `127.0.0.1:4317` (`webPort` in config still overrides).
- No fallback to a random port. If 4317 is taken, the service says which process holds it, and doctor reports it.
- With `tcode web` gone there is only one server, so Tropos no longer clashes with itself.

### 7.2 Logging in

The launch-token cookie is replaced by **per-device logins**:

- Each logged-in browser has its own random device key, stored hashed in `gateway/devices.json` (0600) with a name
  derived from the browser, creation time and last use. A key expires one year after its last use.
- The browser keeps the key in `localStorage`, which is scoped to the exact origin including the port, and sends it as
  the first message on the WebSocket. This also closes the known limit in the control-plane spec (§5: the cookie was
  sent to every server on `127.0.0.1:*`). The app shell and static assets carry no data and are served without login;
  everything else goes through the authenticated WebSocket. The strict CSP stays, since the key is now script-readable.
- Ways to log a browser in:
  1. **`tcode dashboard`** (and the wizard's last step) opens `http://localhost:4317/#login=<one-time key>`. The fragment
     never reaches the server log; the key is single-use and valid for 2 minutes.
  2. **A 6-digit code** typed on the login screen. Codes come from `tcode dashboard --code`, the wizard's phone step, or
     `/login` sent to the bot by the **owner**. Single-use, valid 10 minutes, invalid after 5 wrong tries, with a
     global rate limit.
- Pairing gains an owner role: the sender the wizard approves in step 6 is the owner. Other approved senders can chat
  but can't use `/login` or `/autonomy`. On existing installs, a single approved sender becomes the owner; with several,
  the owner is picked in Settings → Channels & devices, and `/login` is off until then.
- Settings → Channels & devices lists logged-in devices with "Log out" each and "Log out everywhere".
- Migration: the old `gateway/token` file stops being accepted once the new login ships; doctor removes it.

### 7.3 Phone access through Tailscale

- `remoteAccess.tailscale: boolean` in config, set by the wizard or Settings → Phone access; never by a chat or a tool.
- Enabling:
  1. Check `tailscale` is installed and logged in (`tailscale status --json`); otherwise guide the user through
     installing and logging in, on the Mac and in the phone's app.
  2. Run `tailscale serve` in the background to proxy HTTPS on the Mac's tailnet name to `http://127.0.0.1:4317`. If
     the HTTPS port is already served for something else, don't overwrite it: use another port, and say so.
  3. Never use Funnel.
- The server accepts the exact `<machine>.<tailnet>.ts.net` Host and `https://` Origin only while this setting is on,
  besides `127.0.0.1:4317` and `localhost:4317`.
- The terminal shows a QR code of the URL, plus a 6-digit code to log the phone in. The Telegram "done" message carries
  the link too.
- Disabling turns `tailscale serve` off for that port and logs out devices that only ever connected through it.
- Mobile use: Chat (including approve/deny), Status and Settings must work at 320–430px wide.

## 8. Testing

- Engine and policy logic unit-tested with temp homes and fakes, as today. The confinement profile is tested against
  real `sandbox-exec` on macOS (writes outside the project, reads of a fake `~/.ssh`, `.git/hooks` writes all fail;
  project writes, temp writes and network succeed), skipped where unavailable.
- The read-only classifier gets a table of allowed and refused commands, including tricky ones.
- Login: one-time key reuse, expiry, code brute-force limits, revoked device, Host/Origin with and without remote
  access.
- Tailscale calls go through the runner fake; one manual check on this Mac with the real `tailscale`.
- Web: Testing Library for the new tabs and redirects; Playwright screenshots of Setup, Chat with an approval, Status
  and Settings at 320, 375, 768, 1024, 1440 in both themes.
- Gate before done: `bun run typecheck`, `bun test` green, coverage not worse.

## 9. Left to the builder

- The exact `sandbox-exec` profile and `bwrap` arguments, and the cache directories list.
- The read-only command allowlist and test-command detection.
- How the QR code is drawn in the terminal (a small built-in encoder is preferred over a dependency).
- The wizard's terminal rendering, within the rules of §4.1.
- How the repo scan is bounded (depth, time limit, number shown).
- Order of work, as long as each part ships with its tests and README section.
