# Tropos Code — Design Spec

**Date:** 2026-10-12 · **Owner:** Tropos Labs · **Status:** Approved in conversation, pending written-spec review

## 1. Purpose

Tropos Code is an agentic coding CLI from Tropos Labs: a terminal assistant that reads,
edits and runs code in the user's project through a model-driven tool loop. It follows the
architecture of Anthropic's Claude Code (evidence in Appendix A) as a **clean-room build**:
no Claude Code source, prompts or assets are copied; only the publicly observable
architecture is reproduced.

**Success criteria (v1):**

1. `tropos` opens an interactive, branded terminal session in which the model can read,
   search, edit and run code, asking permission before risky actions.
2. `tropos -p "…"` runs the same agent non-interactively for scripts and CI.
3. Sessions persist and can be resumed; long sessions keep working via compaction.
4. Ships as a single self-contained binary per platform.
5. `bun test` passes with ≥80% coverage, including an end-to-end run of the compiled binary
   against a mock API.

## 2. Decisions

| Decision | Choice | Why |
|---|---|---|
| Model backend | Anthropic Messages API via `@anthropic-ai/sdk` | User choice; same backend as Claude Code |
| Runtime / packaging | TypeScript on Bun, `bun build --compile` single binary | User choice; mirrors Claude Code (Bun SEA, see Appendix A) |
| UI | Ink (React for terminals) | Same as Claude Code; component model fits streaming UI |
| Agent loop | Manual streaming loop (not the SDK Tool Runner) | Needs permission gating mid-turn, parallel tool runs, abort, custom rendering |
| Context management | Server-side compaction (`compact-2026-01-12`) | On `claude-opus-5-5`, thinking blocks are tied to the conversation; history must stay append-only, which rules out client-side rewriting |
| Name / command | Tropos Code, `tropos` | Brand |
| Config dir | `~/.tropos/` (user), `.tropos/` (project) | Mirrors `~/.claude/` layout |

## 3. Architecture

```
src/
├── cli/          arg parsing; dispatches to interactive (Ink) or print mode
├── agent/        the loop; emits typed events; no UI imports
├── api/          SDK client + request builder + error mapping
├── tools/        one folder per tool (schema, description, run, render, test)
├── permissions/  modes, rule parser/matcher, decision engine
├── context/      system prompt, TROPOS.md discovery, environment block
├── config/       settings loading and merge
├── session/      append-only JSONL store, resume
└── ui/           Ink components (transcript, tool rows, dialogs, input, status bar, brand)
```

Each unit has one purpose and a typed interface; `agent/` depends on `api/`, `tools/`,
`permissions/`, `session/` through interfaces so it can be tested with fakes. `ui/` and
print mode are two consumers of the same `agent/` event stream.

### 3.1 Turn data flow

1. User message → appended to the session file, then to `messages`.
2. `agent/` streams a request. Text and summarized-thinking deltas are emitted as events.
3. On `stop_reason: "tool_use"`, each `tool_use` input is validated with the tool's zod
   schema, then passed to the permission engine → `allow` | `deny` | `ask` (UI dialog).
4. Permitted tools run **in parallel**; all `tool_result` blocks return in **one** user
   message. Failures are `is_error: true` results, never thrown out of the loop.
5. Repeat until `end_turn` (or `refusal` / max turns / abort).
6. **Abort:** Esc triggers an `AbortController`. The stream is cancelled; running tools are
   signalled; any `tool_use` without a result gets a synthetic `"Interrupted by user"`
   error result so history stays valid.

### 3.2 Request defaults

| Field | Value |
|---|---|
| `model` | `claude-opus-5-5` (setting `model`, `/model`, `--model`) |
| `thinking` | `{ type: "adaptive", display: "summarized" }` |
| `output_config.effort` | `high` (set explicitly; Opus 5.5 defaults to `medium`). `/effort` changes it |
| `max_tokens` | `64000`, always streamed |
| `tool_choice` | `auto` (forced choice returns 400 on Opus 5.5) |
| Tools | Each with `eager_input_streaming: true`; inputs validated client-side before running |
| Caching | Top-level `cache_control: {type: "ephemeral"}`; system prompt and tool list byte-stable within a session |
| Compaction | `betas: ["compact-2026-01-12"]`, `context_management.edits: [{type: "compact_20260112"}]`; full `response.content` appended every turn |
| Refusal fallback | `betas: ["server-side-fallback-2026-07-01"]`, `fallbacks: "default"`; setting `refusalFallback: false` disables |

Requests use `client.beta.messages.stream(...)` because compaction and fallbacks are beta.

## 4. Tools (v1)

| Tool | Behavior | Permission |
|---|---|---|
| `Read` | Line-numbered output, `offset`/`limit`; images and PDFs returned as content blocks. Records mtime in read-state | none |
| `Write` | Create/overwrite. Existing file must have been Read this session and unchanged since (mtime) | ask |
| `Edit` | Exact `old_string` → `new_string`; fails if not unique unless `replace_all`. Same read-first/staleness rules. Result includes a unified diff | ask |
| `Bash` | User's shell; cwd persisted across calls; timeout default 120 s, max 600 s; output truncated to ~30k chars (head + tail); abort sends SIGTERM then SIGKILL after 5 s | ask (per command prefix) |
| `Glob` | `Bun.Glob`; results sorted by mtime, newest first; capped at 100 with a truncation note | none |
| `Grep` | `rg` if on PATH, otherwise a TypeScript fallback; modes `content` / `files_with_matches` / `count`; glob and type filters | none |
| `TodoWrite` | Replaces the session todo list; rendered live | none |

**Path safety:** every path is resolved and canonicalized (`realpath`). Paths outside the
working directory and added directories (`--add-dir`, setting `additionalDirectories`)
always require `ask`, even in `acceptEdits`.

## 5. Permissions

**Modes** (Shift+Tab cycles the first three):

- `default` — read-only tools run; Write, Edit, Bash ask.
- `acceptEdits` — Write/Edit inside allowed directories auto-approve; Bash asks.
- `plan` — the model researches and proposes. The tool list stays the same for the whole
  session (changing it would break the cached prefix and conversation-bound thinking
  blocks); instead, Write/Edit/Bash are denied with a "plan mode is on" message, and the
  next user message carries a reminder that plan mode is active.
- `bypass` — everything auto-approves. Only via `--dangerously-skip-permissions`; red badge.

**Rules** in settings `permissions.allow | ask | deny`, e.g. `Bash(npm test:*)`,
`Edit(src/**)`, `Read(.env)`. Precedence: deny > ask > allow > mode default.
Bash input is split on `&&`, `||`, `;`, `|` and newlines; **every** subcommand must be
allowed for the whole command to auto-approve. Command substitution (`$(…)`, backticks)
always asks.

**Prompt options:** `Yes` · `Yes, and don't ask again for <rule>` (written to
`.tropos/settings.local.json`) · `No, tell Tropos what to do instead` (feedback text
becomes the tool result).

**Print mode:** `ask` resolves to `deny` unless allowed by rule or `--allowed-tools`.

## 6. Context and configuration

**Memory files**, concatenated in order:

1. `~/.tropos/TROPOS.md`
2. `TROPOS.md` in each directory from the git root (or filesystem root if not in git) down to cwd; where a directory has no `TROPOS.md` but has `AGENTS.md`, that is read instead
3. `TROPOS.local.md` in cwd

Memory and the environment block (cwd, platform, shell, git status summary, date) go into
the **first user message** as a context block, keeping the system prompt identical across
projects for caching. `/init` writes a starter `TROPOS.md` from a model pass over the repo.

**Settings** (JSON), merged in order, later wins:
`~/.tropos/settings.json` → `.tropos/settings.json` → `.tropos/settings.local.json` → CLI flags.
Keys: `model`, `effort`, `theme` (`auto|dark|light`), `permissions`, `additionalDirectories`,
`refusalFallback`, `env`.

**Auth:** SDK default resolution (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ant auth`
profiles). `ANTHROPIC_BASE_URL` is honoured (used by the e2e mock).

## 7. Sessions

- File: `~/.tropos/projects/<cwd with / → ->/<uuid>.jsonl`, append-only.
- Line types: `meta` (model, cwd, version, title), `user`, `assistant` (full content incl.
  thinking and compaction blocks), `tool_result` (as the user message), `event` (mode
  changes, cost).
- `tropos -c` continues the newest session for cwd; `tropos -r [id]` / `/resume` opens a
  picker (title, age, message count). Resumed history is byte-identical to what was sent.
- Title: first user prompt, truncated to 60 chars.
- `/clear` starts a new session file (history is never rewritten in place). `/model` and
  `/effort` mid-session are recorded as `event` lines; the next request uses the new value
  (this resets the prompt cache, and a model switch drops prior thinking blocks server-side).

## 8. UI and brand

- **Header:** Tropos angular T mark in Unicode block glyphs, product name, version, model,
  effort, cwd.
- **Palette:** accent periwinkle `#4568FF` (light terminals) / `#93B0FF` (dark); stone
  neutrals for secondary text (`#78716C` light / `#A8A29E` dark); semantic red/green for
  diffs and the bypass badge. Theme from `theme` setting, `auto` uses `COLORFGBG`.
- **Transcript:** completed items in Ink `<Static>`; only the live turn re-renders.
  Markdown rendered for the terminal. Tool rows: `● Tool target` + compact result summary;
  Edit shows a coloured diff.
- **Spinner:** verbs on *tropos* ("turn"): Turning, Pivoting, Orbiting, Revolving; shows
  elapsed time and "esc to interrupt".
- **Input:** multiline (`\`+Enter), ↑/↓ history (persisted to `~/.tropos/history.jsonl`),
  `@` file-path completion, `/` command menu.
- **Slash commands:** `/help`, `/clear`, `/model`, `/effort`, `/cost`, `/resume`, `/init`,
  `/exit`.
- **Status bar:** mode · context % · session cost · `shift+tab` hint.

## 9. Print mode

`tropos -p "<prompt>"`, stdin appended when piped. Flags: `--output-format
text|json|stream-json`, `--max-turns N`, `--allowed-tools "Read,Bash(git *)"`, `--model`.
`json` prints `{result, session_id, usage, cost_usd, num_turns, is_error}`; `stream-json`
prints one agent event per line. Exit codes: 0 success, 1 API/tool-loop error, 2 refusal,
3 max turns reached, 130 interrupted, 64 usage error (bad flags, missing prompt, no terminal).

## 10. Error handling

| Condition | Handling |
|---|---|
| `AuthenticationError` (401) | Message with `ANTHROPIC_API_KEY` / `ant auth login` hint |
| `RateLimitError`, 5xx, overloaded, connection | SDK retries (`maxRetries: 2`), then a visible notice; the user can retry the turn |
| `BadRequestError` (400) | Show API message; turn ends |
| `stop_reason: "refusal"` | Notice with `stop_details.category`; no tools from that turn run |
| `stop_reason: "max_tokens"` with a `tool_use` | Tool not run; error result asking the model to split the work |
| Unparseable tool input | `INVALID_JSON` error result; at most 2 consecutive re-issues |
| Tool throws | `is_error: true` result with the message |
| Crash | Session lines written before each request, so resume recovers the conversation |

Errors are matched by SDK error class, not message text. Two cases have no dedicated class
in `@anthropic-ai/sdk` 0.133: an unparseable streamed tool input is a bare `AnthropicError`
(matched as "AnthropicError that is not an APIError"), and missing credentials is a plain
`Error` whose message starts "Could not resolve authentication method" (the one text match).

## 11. Testing

`bun test`, coverage ≥80%.

- **Unit:** each tool; rule parser/matcher incl. compound Bash and substitution; settings
  merge; memory discovery; session write/resume round-trip; path safety.
- **Agent loop:** a fake client replays scripted stream events — verifies parallel results
  in one message, abort with synthetic results, refusal, permission deny/feedback,
  `INVALID_JSON` retry cap, `max_tokens` guard.
- **UI:** `ink-testing-library` snapshots of permission dialog, tool rows, status bar.
- **E2E:** the compiled binary runs `tropos -p` against a local mock HTTP server via
  `ANTHROPIC_BASE_URL`, deterministic and free. Live smoke test only when
  `TROPOS_LIVE_TEST=1`.

## 12. Build and distribution

- `bun build --compile` targets: `bun-darwin-arm64`, `bun-darwin-x64`, `bun-linux-x64`,
  `bun-linux-arm64`. Version injected at build time.
- `install.sh`: places the binary at `~/.local/share/tropos/versions/<v>` and symlinks
  `~/.local/bin/tropos` to it.

## 13. Out of scope (phase 2)

Hooks, MCP client, subagents, skills, custom slash-command files, web search/fetch,
auto-update, IDE integration, Windows support.

---

## Appendix A — Evidence: how Claude Code is built (v2.1.296, this machine)

Gathered 2026-10-12 from `~/.local/share/claude/versions/2.1.296`.

**Install layout.** `~/.local/bin/claude` is a symlink to
`~/.local/share/claude/versions/2.1.296`; 2.1.294 and 2.1.295 remain alongside, so the
native installer updates by switching the symlink.

**Binary.** `file`: Mach-O 64-bit arm64. `codesign`: `Identifier=com.anthropic.claude-code`,
`TeamIdentifier=Q6L2SF6YDW`. Links only system libraries (libicucore, libresolv, libc++,
libSystem). Contains `bun-v1.4.3/bun-darwin-aarch64.zip` and a `__BUN` segment
(fileoff 68206592, filesize 171769856): a **Bun single-file executable**. The extracted
segment holds 2,617 JS chunks under the virtual path `/$bunfs/root/` plus embedded
compressed docs/skills (`*.md.zst`), fonts and native addons; `VERSION:"2.1.296"`.

**Findings** (string counts from the extracted segment):

| Area | Evidence |
|---|---|
| Terminal UI | Ink: `ink-root`, `ink-box`, `ink-text`; `useInput` (34); Yoga layout (35) |
| API | `/v1/messages?beta=true`, `/v1/messages/count_tokens`, `https://api.anthropic.com`; beta headers incl. `context-management-2025-06-27`, `interleaved-thinking-2025-05-14`, `effort-2025-11-24`, `fast-mode-2026-02-01` |
| Agent loop | `content_block_delta` (26), `input_json_delta` (14), `"tool_use"` (198), `"tool_result"` (304), `stop_reason` (82), `"end_turn"` (18), `is_error` (133) |
| Runtime corroboration | This session's transcript `~/.claude/projects/-Users-Apple-Desktop-TCode/<id>.jsonl`: 11 assistant `tool_use` blocks matched by 11 user `tool_result` blocks |
| Tools | String constants `Bash`, `Read`, `Write`, `Edit`, `MultiEdit`, `Glob`, `Grep`, `NotebookEdit`, `WebFetch`, `WebSearch`, `TodoWrite`, `Agent`/`Task`, `Skill`, `ToolSearch`, `AskUserQuestion`, `ExitPlanMode`, `LSP`, `Workflow`; Grep is "built on ripgrep" |
| Edit semantics | "`old_string` is not unique in the file… use `replace_all`"; "File has not been read yet. Read it first before writing to it." |
| Permissions | Modes `acceptEdits`, `bypassPermissions`, `plan`, `dontAsk`, `auto`; flag `dangerously-skip-permissions`; rules like `WebFetch(domain:github.com)` |
| Hooks | `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `UserPromptSubmit`, `SessionStart`, `SessionEnd`, `Stop`, `SubagentStop`, `PreCompact`, `Notification`, `PermissionRequest` |
| Context files | `CLAUDE.md` (239), `CLAUDE.local.md`, `settings.json`, `settings.local.json`, `.mcp.json`, `.claude/agents`, `.claude/skills`, `.claude/commands`, `SKILL.md` |
| MCP | `tools/list`, `tools/call`, `notifications/initialized`, `stdio`, `streamable-http` |
| Compaction | `autoCompact` (70), `compact_boundary` (43), `microcompact`; summary prompt "Your task is to create a detailed summary of the conversation so far…" |
| Sessions | Transcript classifier: path contains `/projects/` and ends with `.jsonl` |
| System prompt | "You are Claude Code, Anthropic's official CLI for Claude." (+ Agent SDK variant) |

Claude Code is proprietary; Tropos Code reuses none of its code or prompt text.
