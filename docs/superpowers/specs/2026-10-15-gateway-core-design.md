# Tropos Code — Gateway core (`tcode gateway`) — Design Spec

**Date:** 2026-10-15 · **Status:** Design agreed in conversation (sections 1–3 approved). Phase 1 of the persistent-agent roadmap.

## 1. Goal

Tropos Code today is a tool you open. This phase makes it something that **stays running** and that you can reach
from your phone, without giving untrusted input the run of your machine.

`tcode gateway` is a long-lived process (a launchd agent on macOS) that owns agent sessions and serves clients.
The first client is a Telegram bot, so you can send a coding task from your phone and approve its tool calls from
there. The same process serves the existing web UI for a local session.

Reference points, studied for this design: OpenClaw's Gateway and DM pairing, Hermes Agent's messaging gateway, and
what went wrong for OpenClaw (open channels + third-party skills + persistent memory + host exec + opt-in
sandboxing). Where they differ from this design, it is on purpose: **sandbox first, deny by default.**

### Roadmap (this spec is Phase 1)

| Phase | Delivers | Needs |
|---|---|---|
| **1 — Gateway core** (this spec) | Daemon, session pool, sandbox backend, pairing, Telegram | – |
| 2 — Scheduler | Cron jobs in natural language, delivery to the channel, run history | Phase 1 channels |
| 3 — Reach | Web search, browser, cross-project memory and identity | Phase 1 sandbox |

### Non-goals of Phase 1

- Making the TUI a client of the daemon (it keeps running standalone, as today). The protocol is ready for it.
- More than one channel, a skill registry, nodes/devices, an ssh backend, an OS-level sandbox for the local tier.
- Staging learned notes from channel sessions for approval. Phase 1 simply **turns the learning loop off** there.

## 2. What exists and what changes

`WebHost` (`src/web/host.ts`) is already "one session served to many clients": it runs turns, broadcasts the agent's
events, routes permission prompts to whoever answers first, and refuses overlapping work with `busy`. A gateway
session **is** a `WebHost`; it is not renamed. What is new is a pool of them, a way to build each one, and the pieces
around untrusted input.

```
src/gateway/
  types.ts          the contracts below (no runtime imports)
  config.ts         ~/.tropos/gateway.json: channel, sandbox, workspace (0600)
  pairing.ts        deny-by-default sender allowlist: codes, expiry, lockout
  policy.ts         what a channel-origin session may do (derives its AppContext)
  pool.ts           SessionPool: chat key → session (WebHost), created on demand, closed when idle
  daemon.ts         starts the pool, the channel adapters and the local web server; shutdown
  launchd.ts        plist generation and install/uninstall/status helpers
  telegram/
    api.ts          Bot API client (getUpdates long poll, sendMessage, edit, callbacks)
    adapter.ts      chat ⇄ session: pairing, prompt, event rendering, approvals as buttons
    render.ts       AgentEvent → Telegram text (batched, split at 4096 chars)
src/exec/
  backend.ts        ExecBackend interface
  local.ts          the current Bash spawn, unchanged in behaviour
  docker.ts         per-session container, `docker exec`
src/cli/            `tcode gateway …` and `tcode pairing …`
```

### 2.1 The daemon

- `tcode gateway` runs in the foreground (used by launchd). `tcode gateway install|uninstall|status` manage the
  launchd agent (`~/Library/LaunchAgents/com.troposlabs.gateway.plist`, `RunAtLoad`, `KeepAlive`).
- It builds the same `AppContext` as any session (settings, extensions, MCP) once, for its **workspace** directory,
  then forks a lighter per-session context for each chat (§2.3).
- Local clients: the existing web UI over loopback, with a token that is **persisted** (`~/.tropos/gateway/token`,
  0600) so the link survives restarts. The daemon never listens on a non-loopback address.

### 2.2 Sessions

- A chat maps to one session by key `telegram:<chatId>`. The session reuses `SessionStore`, so history is the
  existing append-only JSONL and a restart resumes where the chat left off (dangling tool calls are repaired as today).
- Messages sent while a turn runs are queued in the adapter, in order, and sent when the turn ends.
- Idle sessions are closed after a timeout (their container is removed); the next message reopens them.

### 2.3 Trust tiers

Every session has an `origin`: `local` (TUI, web on loopback — today's behaviour, unchanged) or `channel`.
A `channel` session is built by `policy.ts` and differs as follows:

| Concern | `local` | `channel` |
|---|---|---|
| Bash | host shell | **must** run in the sandbox backend; if it cannot start, the session is refused (fail closed) |
| Modes | as configured, `bypass` possible | `default` or `plan` only; `bypass` never |
| Allowed dirs | cwd + additional dirs | the workspace only |
| WebFetch, MCP tools | per rules | **always ask**, even with an allow rule (an `ask` rule is added; ask outranks allow) |
| "Always allow" answers | saved to local settings | refused: Approve / Deny only |
| Learning loop, identity bootstrap | on | **off** |
| Skills / plugin install | per today | not offered |

### 2.4 Sandbox (`ExecBackend`)

`bash.ts` stops calling `spawn` directly and uses `ctx.exec` (default: the local backend, behaviour identical to
today). The Docker backend:

- One container per session, started lazily on the first command: `--network none` (configurable), `--read-only`,
  `--tmpfs /tmp`, `--cap-drop ALL`, `--security-opt no-new-privileges`, `--pids-limit`, `--memory`, `--cpus`, run as
  the invoking uid:gid, the workspace bind-mounted **at the same path** as on the host (so paths in output and the
  tracked cwd mean the same thing), plus one small writable run dir for cwd tracking.
- Nothing else of the host is visible: no home, no `~/.ssh`, no `~/.tropos`. The environment starts **empty**.
- Commands run with `docker exec`; the container is removed at session end and by a startup sweep of leftovers.
- Timeouts and interrupts kill the `docker exec` client and the command's process inside the container.

What this does **not** do, and the README must say so: the file tools (Read, Write, Edit, Glob, Grep) still run on
the host, limited to the workspace by the permission engine; a container is not a perfect boundary.

### 2.5 Pairing

Deny by default. An unknown sender gets a one-time 8-character code (no ambiguous characters), valid for one hour.
The owner approves it on the machine: `tcode pairing approve telegram <code>`. A sender can be issued at most 5
codes an hour; after that they are ignored without a reply. Five failed approvals on a channel within an hour lock
approving on that channel for the rest of the hour (a guessing guard for a compromised local shell).
`tcode pairing list|revoke` manage approved senders. State lives in `~/.tropos/gateway/pairing.json` (0600).
Codes are stored hashed; a code is shown to the sender once, so after a daemon restart a still-valid code cannot
be shown again and the sender's next message is given a fresh one.

### 2.6 Telegram

Long polling with `fetch` (no new dependency). Text becomes a `prompt`; the agent's events are rendered as short,
batched messages (tool calls as one-line summaries, the answer as text, split at 4096 characters). A permission
request becomes a message with **Approve / Deny** inline buttons; an unanswered request denies after 5 minutes. The
bot token comes from `TROPOS_TELEGRAM_BOT_TOKEN` or `gateway.json`. Commands: `/stop` (interrupt), `/new` (fresh
session), `/status`.

### 2.7 How the pieces differ from the first sketch

- `WebHost` was not renamed; a pool of them is enough. Chat sessions are built by `createRuntime` with
  `interactive: false` (no learning, no identity bootstrap, no ↑-history) and `ownsExtensions: false` (closing a chat
  doesn't close the MCP servers and search index the other sessions share).
- The permission engine gained `confine` (paths outside the workspace are denied, not asked about) and the app
  context gained `origin` and `exec`. Subagents inherit `exec`; without that they would get the host shell back.
- The daemon is the first process to hold several sessions. The undo tracker and snapshots in `ctx.ext` are shared
  between them, so `/undo` is a single-session feature for now.

## 3. Errors

- A crashed daemon is restarted by launchd; sessions resume from their JSONL.
- A lost Telegram connection retries with capped exponential backoff; other clients are unaffected.
- A prompt that was waiting for approval when its client vanished is denied (the existing abort path).
- Docker missing or stopped: channel sessions answer "the sandbox isn't available" and run nothing.

## 4. Testing

- `WebHost` tests stay green untouched: they prove a session behaves as before.
- Unit: pairing (expiry, lockout, hashing), policy (a channel context cannot reach `bypass`, ask-rules outrank
  allow-rules), render (splitting, escaping), the launchd plist.
- Integration: `ExecBackend` docker against a real container, with negative tests (home, credentials and host env
  invisible; network closed; cwd tracked; timeout kills the command). Skipped when Docker is unavailable.
- Telegram adapter against an in-process fake Bot API.
- The existing `eval/` tasks are the regression check that session quality did not change.

## 5. Known limits

- File tools run on the host, confined to the workspace by the permission engine, not by the container.
- Hooks configured in `~/.tropos/settings.json` also fire for chat sessions and run on the host: they are the
  owner's own configuration, but they see chat-originated tool calls.
- If the container dies mid-session (OOM, `docker stop`) later commands fail until the session is reopened.
- A command that is signalled in the first milliseconds, before it has written its pid file, can outlive the kill.
- The local web session is a full-trust `local` session on loopback, protected by the persisted token.

## 6. Rollout

1. `ExecBackend` and the Docker backend, behind `ctx.exec` (no behaviour change for existing users).
2. Pairing, config, policy.
3. Pool and daemon with the local web client.
4. Telegram adapter. Nothing untrusted can reach a session before steps 1–2 exist.
5. `tcode gateway` is opt-in; without it nothing changes.
