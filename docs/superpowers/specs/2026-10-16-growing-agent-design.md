# Tropos Code — A growing agent: home layout, learning everywhere, specialists, self-setup, projects, suggestions — Design Spec

**Date:** 2026-10-16 · **Status:** Scope set by the owner ("implement everything we discussed"). Second of two
documents; the first is `2026-10-16-setup-autonomy-access-design.md` (guided setup, autonomy, one dashboard, phone
access), which this one builds on (owner role, autonomy levels, confinement).

## 1. Intent

A person who downloads Tropos for the first time gets **one** agent and nothing else: no preset team, no example
skills, no seeded memories. As they talk to it, from the terminal, the dashboard or Telegram, it grows by itself:
it remembers them, keeps a journal, writes skills for procedures it will need again, creates specialist agents for
kinds of work that keep coming back and hands that work to them, sets itself up, and suggests things when they would
help. Everything it creates is saved without asking, shown as one line, and can be undone. The user never edits a
file.

The owner's words: "everything from scratch for someone downloading it the first time, and as they talk, skills,
memories and anything else get created and saved; the agent can suggest things to the user when needed."

## 2. Goals, non-goals, anti-goals

**Goals**

1. Learning works in every place the owner talks: terminal, dashboard and the owner's Telegram chat.
2. Memories, journal entries, skills and specialists are saved automatically, with a notice and undo.
3. The main agent (the **chief**) creates specialists itself, delegates to the right one, verifies the result and
   reports. Specialists have their own role, memory, skills, model and journal.
4. The agent can change Tropos's own setup when asked (connect Telegram, add a project, change model, add an MCP
   server, restart, update), within the limits of document 1.
5. Projects register themselves; chats can create and switch projects by name.
6. The agent suggests things during a conversation and, at most once a day, on its own in Telegram.
7. The home directory follows OpenClaw's workspace model, migrated automatically.

**Non-goals**

- Merging `settings.json` and `gateway.json` into one file: nobody edits them by hand any more, so a risky migration
  buys nothing.
- A durable task board (Hermes Kanban), agent-to-agent messaging between specialists, Mixture-of-Agents, multiple
  personas bound to different chats (OpenClaw bindings). Possible later.
- Shared/multi-user memory, other channels, Windows.

**Anti-goals: it fails even if it technically works when**

- a new user finds anything pre-made they didn't ask for;
- the agent saves silently (no notice) or a save can't be undone;
- learning from untrusted text (other people's chats, repo files, web pages) can write instructions that later act
  as the owner's (every save is threat-scanned as today, and non-owner chats never learn);
- a specialist can do something the chief couldn't, create other agents, talk to the user directly, or read the
  owner's private memory;
- the agent pesters: more than one unprompted message a day, or messages in quiet hours.

## 3. Part E — Home layout (OpenClaw's model)

```
~/.tropos/
  settings.json  gateway.json  credentials.json      unchanged
  workspace/                       the chief's home and the default project (a git repo, as today)
    AGENTS.md                      operating rules; the agent appends lessons ("## Lessons")
    SOUL.md                        voice and values (moved from ~/.tropos/SOUL.md)
    IDENTITY.md                    name, emoji, vibe (moved from ~/.tropos/IDENTITY.md)
    USER.md                        what it knows about the owner (from today's "about you" notes)
    MEMORY.md                      what it knows about the work (from today's "about the work" notes)
    BOOTSTRAP.md                   first-run ritual; deleted by the agent when done
    memory/YYYY-MM-DD.md           the journal (today's per-project daily notes, see below)
    skills/                        the owner's skills (moved from ~/.tropos/skills)
    skills-learned/                skills the agent wrote (moved from ~/.tropos/skills-learned, incl. .archive/)
  agents/<id>/                     one folder per specialist (Part G)
    AGENT.md                       frontmatter (name, description, emoji, model, tools, autonomy, createdBy,
                                   createdAt, revision) + the role contract as the body
    MEMORY.md                      its own notes
    memory/YYYY-MM-DD.md           its own journal
    skills/                        skills it wrote
    revisions/<n>.md               earlier versions of AGENT.md
  projects/<key>/                  unchanged: sessions, per-project settings, snapshots index
  gateway/  learning/  backups/  index.db  …   unchanged
```

- **Journal:** entries are written to `workspace/memory/<date>.md` with the project's name as a heading per entry. A
  session loads today's and yesterday's entries for its own project (same budget as today); `SessionSearch` indexes the
  new files. Old `projects/<key>/notes/*.md` are imported once.
- **Size caps** stay as today's memory budgets; `USER.md` and `MEMORY.md` reuse the existing per-file caps and digest.
- **Migration:** on the first start of the new version (and in `doctor --fix`), with a backup first, files move to the
  new places. Readers keep a fallback to the old paths for one release. `BOOTSTRAP.md` is only created when no
  identity exists yet, so existing installs never see the ritual again.
- **Repo-provided files** (`TROPOS.md`, `AGENTS.md`, `CLAUDE.md`, project skills/commands/agents) work exactly as
  today; `workspace/AGENTS.md` is the chief's own file, loaded like `~/.tropos/TROPOS.md` is today.
- `~/.tropos/agents/*.md` (today's AgentManage output and the user's own agent files) is read as before; an agent
  defined as a single `.md` file is a plain subagent, an `agents/<id>/` folder is a specialist.

## 4. Part F — Learning everywhere, saved automatically (fixes)

| Today | After |
|---|---|
| The background review and curator are off for all chat sessions (`src/gateway/policy.ts`) | On for the **owner's** chat sessions (owner role from document 1) and the dashboard; off for other approved senders and for scheduled runs. |
| The main agent asks before writing memory, daily notes, skills, agents and SOUL.md | Saves without asking, with the notice line and undo, as the review already does. `learning.askBeforeSaving: true` restores asking. Deny rules and hooks that ask still count as "no". |
| Notices show in the TUI and web only | Also in Telegram, as one short line after the answer ("💡 Remembered: you deploy on Fridays"), and `/learned` / `/learned undo` work in chat. |

Every other limit of the learning spec stays: threat scan on write and on load, the learned skills directory, the
ledger, the curator never deleting.

Further blocking gaps found by the audit of 2026-10-16 are listed in §10 and fixed as part of this work.

## 5. Part G — The chief and its specialists

### 5.1 What a specialist is

A persistent agent in `~/.tropos/agents/<id>/` (§3):

- **Role contract** (the body of `AGENT.md`, written by the chief when it creates the specialist): purpose, what it
  does not do, what its report must contain, when to stop and escalate.
- **Description:** one line the chief routes on.
- **Model** (default: the chief's model; the chief may pick a cheaper one for simple roles), **tools** (a subset of
  the chief's), **autonomy** (never higher than the chief's in that context).
- **Its own memory, journal and skills.** It doesn't see the owner's `USER.md`, `MEMORY.md`, `SOUL.md` or journal,
  nor other specialists' files.

### 5.2 How specialists come to exist

- **On request:** "make me an agent that reviews my PRs".
- **On its own:** the chief creates one when a kind of work has come up repeatedly and no specialist fits. The
  background review gets a third job next to memory and skills: noticing recurring kinds of delegated or direct work
  (by default, the third time) and creating the specialist. The notice: "🧩 New specialist: 🔍 reviewer — reviews
  pull requests" with undo.
- **Limits:** at most 12 active specialists (the review proposes merging or archiving before creating a 13th); the
  curator archives a specialist unused for 60 days into `agents/.archive/` (never deleted); names are unique and
  kebab-case.
- **Changes** to a specialist (role, model, tools) are made by the chief or the review, saved as a new revision, and
  undoable.

### 5.3 Delegation

- The chief's system prompt lists the active specialists (name, emoji, description) and says: delegate when one fits,
  do it yourself when none does, never delegate what the user asked you personally to decide.
- Delegation uses the existing `Agent` tool with `subagent_type: <id>`. A specialist runs with its own role contract,
  memory, journal and skills loaded, and returns a report. Every handoff carries the objective, inputs, where results
  go, how to verify, and limits (guidance in the tool description, from OpenClaw's coordinator).
- The chief checks the report against evidence (diff, test output) before telling the user; one retry with a clarified
  task, then it tells the user what failed.
- **Hub, not mesh:** specialists can't use the `Agent` tool, `AgentManage`, `Cron`, the setup tool (Part H) or anything
  that messages the user. Depth is 1. At most 4 specialists run at once.
- **Learning inside specialists:** after a delegated run that used tools, a review of the specialist's own transcript
  may update its memory and skills (never the chief's).
- **Talking to one directly:** `@reviewer …` in the terminal, dashboard or Telegram delegates that message verbatim to
  the specialist; the answer is shown with its emoji and name. Follow-ups go to the chief unless they start with `@`.
- **Permissions:** a specialist's tool calls go through the same permission engine and context as the chief's (in a
  chat: the chat's autonomy and confinement).

### 5.4 Dashboard

The Agents page becomes a roster: the chief at the top, specialists below with who created them and when, their
description, model, skills, memory size, last runs (task, result, duration, cost) and revisions, with edit, pause,
archive and undo. A new user sees only the chief and one sentence: "Specialists appear here as Tropos learns what you
need."

## 6. Part H — The agent sets itself up

A new `TroposSetup` tool with typed actions, each validated through the existing config store and lifecycle code:

| Action | Terminal / dashboard | Owner's chat | Others / scheduled / specialists |
|---|---|---|---|
| connect or disconnect Telegram (token pasted by the user) | ✓ | ✓ | ✗ |
| add, rename, remove a project; set the default | ✓ | ✓ | ✗ |
| change model or effort; connect a provider (key pasted by the user) | ✓ | ✓ | ✗ |
| add, enable, disable an MCP server | ✓ | ✓ (the server's command is shown in the approval) | ✗ |
| set quiet hours and proactive messages (Part J) | ✓ | ✓ | ✗ |
| lower autonomy | ✓ | ✓ | ✗ |
| run the doctor; apply its safe fixes | ✓ | read-only | ✗ |
| restart the service; update Tropos | ✓ | ✓ | ✗ |
| raise autonomy, remote access, pairing approvals, permission rules, hooks, sandbox/confinement | ✗ (UI and CLI only) | ✗ | ✗ |

- Every action is a normal permission prompt (an approval button in a chat) unless the level allows it, shows exactly
  what changes, and is written to the ledger so it can be undone where that makes sense.
- Secrets pasted into a chat are stored through the credentials store and deleted from the visible chat where the
  channel allows it (Telegram: `deleteMessage`); they are never echoed back.
- Messages and docs that today say "edit `gateway.json`" or "run `tcode …`" are reworded to "ask me to …" plus the
  dashboard link, wherever the setup tool can do it.

## 7. Part I — Projects without setup

- Running `tcode` in a git repository registers it as a project (id from the folder name, de-duplicated by real path).
  A notice says so once. `tcode projects remove` and the dashboard undo it; a removed project isn't re-added.
- From a chat: "start a new project called X" creates `~/Projects/<X>` (folder configurable in Settings), runs
  `git init`, registers it and switches to it; "work on Y" switches by a fuzzy name match, asking when ambiguous.
- **Worktrees for chat work in your repos:** when a chat (not the terminal or dashboard) works in a registered repo
  other than the default workspace, it works in a git worktree under `~/.tropos/worktrees/<project>/<task>` on a branch
  `tropos/<task>`, so the owner's checkout is never touched. The chief finishes with a summary and buttons: merge into
  the current branch, open a PR (when `gh` is logged in), keep the branch, or discard.

## 8. Part J — Suggestions

- **During a conversation:** the context carries a short "worth suggesting" list built from signals: skipped setup
  steps, a task the owner does by hand on a schedule (from the journal: suggest a cron job), a failing scheduled run, a
  project with failing tests, a specialist that would help. The system prompt says: at most one suggestion per
  conversation, only at a natural pause, never instead of the answer, drop it if the owner declines (declines are
  remembered).
- **On its own, in Telegram (owner only):** a heartbeat runs every 4 hours within active hours (default 09:00–21:00
  local, no messages in quiet hours) as a cheap scheduled session in the default workspace with read-only tools, the
  journal, scheduled-run results and the `## Heartbeat` section of `workspace/AGENTS.md` (which the agent maintains).
  It answers `NOTHING` unless something is worth the owner's attention; at most one message a day.
- Settings (`proactive.enabled`, `activeHours`, `maxPerDay`) are set in Settings, by the setup tool, or by telling the
  agent ("stop messaging me" turns it off). On by default once Telegram is connected.

## 9. Testing

Same conventions as document 1: unit tests with temp homes and fakes for migration, learning gates by origin and
owner, auto-save with undo, specialist creation/limits/curation, delegation context (what a specialist can and can't
see and call), the setup tool's action matrix, project auto-registration and worktree flow, and the heartbeat's rate
limits and quiet hours. Web: Testing Library for the roster and new settings; screenshots at the five breakpoints.
Gate: `bun run typecheck`, `bun test` green, coverage not worse.

## 10. Blocking gaps from the audit

From the code audit of 2026-10-16, most blocking first. Each becomes a task in the plan.

1. **Chats can't save anything.** Chat sessions are confined to the project (`permissions/engine.ts:150`,
   `gateway/policy.ts:49`), so Memory, DailyNote, SkillManage, AgentManage and Identity, which write under
   `~/.tropos`, are always denied, even when approved; scheduled runs too. Fix: for the owner's chats, allow exactly
   those tools on their own stores (the specialist and journal folders included); withhold tools that can never
   succeed in a session.
2. **The gateway never sees new skills, agents or settings** until it restarts (`gateway/daemon.ts:172`,
   `cli/context.ts:70`, `tools/skill/skill.ts:26`; the Skill tool is missing entirely when no skills existed at
   start). Fix: re-read skills and agents for each new session; the Skill and Agent tools resolve names at call time
   and list what exists now.
3. **Dashboard changes silently do nothing:** `reload` is a no-op (`gateway/daemon.ts:324`), so a Telegram token, MCP
   server or setting saved in the dashboard takes effect only after a restart. Fix: `reload` rebuilds the channel
   adapters, drops cached project contexts and reconnects MCP.
4. **Every save asks in the terminal and dashboard, and "always allow" isn't offered** for paths under `~/.tropos`
   (`permissions/engine.ts:132,229`). Fixed by Part F's automatic saving.
5. **The review rarely runs:** it needs 10 turns in one session; counters reset per session; exit and `/clear` cancel
   it (`learning/review.ts:107`, `cli/runtime.ts:566`). Fix: a final review at session end, idle close and `/new`;
   counters carried across sessions of the same project.
6. **Journal entries are almost never written:** the flush needs 70% of a known context window, so models without one
   never flush (`cli/runtime.ts:234`). Fix: also flush at session end/idle; a default window for unknown models.
7. **Memory fills and learning stops:** the review may only add, and stores cap at 2,200/1,375 characters
   (`memory/notes.ts:16`, `learning/review.ts:200`); the prompt asks it to replace entries the gate refuses. Fix: let
   the review replace and consolidate (the ledger keeps undo), and make the prompt match the gate.
8. **No self-created agents or identity refinement:** AgentManage and Identity aren't in the review's allowlist and
   their descriptions say "when the user asks" (`learning/review-prompts.ts:6`). Covered by Part G §5.2.
9. **Telegram knows only `/stop /new /status /start /project`** and drops non-text messages without a reply
   (`gateway/telegram/adapter.ts:585,237`). Fix: unknown `/name` goes through the command/skill expansion (so skills,
   custom commands and `/learned` work); non-text gets "I can only read text for now".
10. **Scheduling only exists in chats** (`gateway/daemon.ts:228`), and web-created jobs deliver nowhere by default
    (`web/admin/cron.ts:126`). Fix: the Cron tool in owner sessions everywhere; delivery defaults to the owner's chat.
11. **Subagents keep nothing:** transcripts aren't saved (`agent/subagent.ts:130`), so search and review never see
    their work. Fix: save them under the parent session; specialists get Part G's memory.
12. **Messages still tell the user to edit JSON** (`gateway/daemon.ts:374,188`, `gateway/commands.ts:92`,
    `install/commands.ts:48`, `cli/runtime.ts:375-454`). Fix: Part H's rewording; doctor `--fix` repairs invalid
    settings; settings errors aren't sent to chat users.
13. **Memory, Skills and Agents pages are read-only** apart from undo. Fix: edit, delete and restore actions over the
    existing stores.
14. **The curator only runs at interactive session start**, i.e. once per gateway process (`cli/runtime.ts:657`).
    Fix: a weekly gateway job.
15. **SessionSearch is withheld from all chats** (`gateway/policy.ts:19`), so the owner's phone can't recall older
    notes. Fix: allow it for the owner's chats (other senders still don't get it).

## 11. Left to the builder

- Exact prompts for the review's specialist job, the chief's delegation guidance and the heartbeat.
- How "the same kind of work" is recognised (the review's judgement from the journal and recent delegations).
- How the suggestion signals are computed and cached.
- The migration's file-by-file mapping, within §3.
