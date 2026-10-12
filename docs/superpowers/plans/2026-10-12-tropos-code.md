# Tropos Code Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Tropos Code, a branded agentic coding CLI (`tropos`) that streams Claude, runs file/shell/search tools behind a permission system, persists sessions, and ships as a single Bun binary.

**Architecture:** A UI-free agent loop (`src/agent/`) drives a `Model` interface (real impl: `@anthropic-ai/sdk` beta streaming) and a fixed registry of zod-typed tools gated by a permission engine. Two front ends consume its events: an Ink TUI (`src/ui/`) and a print mode (`src/cli/print.ts`). History is append-only JSONL; server-side compaction handles long sessions.

**Tech Stack:** Bun 1.4 (runtime, test runner, `--compile`), TypeScript 5.9, `@anthropic-ai/sdk` 0.133.0, Ink 8 + React 19.3, zod 4.6, `diff` 9, `marked` 15 + `marked-terminal` 7.3, `ink-testing-library` 4.

**Spec:** `docs/superpowers/specs/2026-10-12-tropos-code-design.md`

## Global Constraints

- Runtime Bun ≥ 1.4.0; tests with `bun test`; coverage threshold 0.8 (bunfig).
- Model default `claude-opus-5-5`; effort default `high` (always sent explicitly); `max_tokens: 64000`; always streamed via `client.beta.messages.stream`.
- `thinking: { type: "adaptive", display: "summarized" }`; `tool_choice` never set (auto); never send `budget_tokens` or `{type:"disabled"}`.
- Betas: `compact-2026-01-12` always; `server-side-fallback-2026-07-01` + `fallbacks: "default"` unless setting `refusalFallback: false`.
- Every tool definition sets `eager_input_streaming: true`; every tool input is validated with its zod schema before running.
- History is append-only: never edit or delete an element of `messages` after it was sent; the tool list is identical on every request in a session.
- All `tool_result` blocks for one assistant turn go back in a single user message.
- Config/home dir: `TROPOS_HOME` env var, else `~/.tropos`. Project config: `<cwd>/.tropos/settings.json`, `<cwd>/.tropos/settings.local.json` (restricted keys only — see the spec's trust split); user-owned per-project config: `~/.tropos/projects/<cwd-flattened>/settings.json` ("don't ask again" writes here).
- Brand: accent `#4568FF` (light) / `#93B0FF` (dark); muted `#78716C` (light) / `#A8A29E` (dark). Product name "Tropos Code", command `tropos`.
- No code or prompt text copied from Claude Code. Write all prompts and tool descriptions fresh.
- File names kebab-case for modules, PascalCase for React components. Each task commits with a message ending in the line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **`$` patterns in Edit replacements** — `new_string` containing `$&`, `$1` or `$$` must be inserted literally (a naive `String.prototype.replace` corrupts it). Test: Task 6, "inserts dollar patterns literally".
2. **Compound / redirected / substituted shell commands** — with `Bash(git status:*)` allowed, `git status && rm -rf build`, `git status > ~/.zshrc` and `git status $(curl x)` must not auto-approve. Tests: Task 3 (`splitBashCommand`), Task 4 ("compound command needs every part allowed").
3. **Symlink escape** — a path inside the project that is a symlink to a directory outside it (e.g. `./link -> /etc`) is treated as outside, including for files that don't exist yet. Test: Task 5 (`resolveToolPath`), Task 4 ("symlinked dir counts as outside").
4. **Interrupt mid-tool keeps history valid** — after Esc during a tool run, every `tool_use` has a matching `tool_result`, and a resumed session's history passes the same check; a half-written final JSONL line from a crash is skipped on load. Tests: Task 13 ("abort during tool run"), Task 11 ("skips a truncated trailing line").
5. **CRLF files** — editing a CRLF file with an LF `old_string` succeeds and keeps CRLF line endings. Test: Task 6 ("edits CRLF files").

## File Structure

```
package.json, tsconfig.json, bunfig.toml, .gitignore, build.ts, install.sh, README.md
docs/assets/tropos-logo.png
src/
  index.ts                     entry: process.exit(await main(argv))
  version.ts                   VERSION from package.json
  paths.ts                     troposHome, expandHome, isInside
  types/marked-terminal.d.ts   module declaration
  config/constants.ts          DEFAULT_MODEL, EFFORTS, MODES, OUTPUT_FORMATS, ToolKind
  config/settings.ts           Settings, defaults, load/merge, addLocalAllowRule
  cli/args.ts                  parseCli(argv) → CliOptions
  cli/usage.ts                 USAGE text
  cli/print.ts                 PrintRenderer, runPrint, EXIT_CODES, PRINT_DENY
  cli/runtime.ts               AppContext, makeAgent, createToolContext, createRuntime
  cli/main.tsx                 bootstrap → print mode or Ink App; EXIT_USAGE
  permissions/rules.ts         parseRule, formatRule, splitBashCommand, matchers
  permissions/engine.ts        decide(), suggestRule(), compileRules()
  tools/types.ts               Tool, ToolContext, ToolOutput, ToolDisplay, Todo
  tools/paths.ts               resolveToolPath (canonical, symlink-aware)
  tools/read-state.ts          ReadState
  tools/schema.ts              toInputSchema (zod → JSON schema)
  tools/diff.ts                makeDiff
  tools/file-guard.ts          checkFreshness (read-before-write)
  tools/walk.ts                walkFiles (skips node_modules/.git)
  tools/read|write|edit|bash|glob|grep|todo/…   one folder per tool
  tools/bash/output-buffer.ts  head+tail output truncation
  tools/registry.ts            createTools()
  context/memory.ts            loadMemory, gitRoot
  context/environment.ts       gitSummary, environmentBlock
  context/system-prompt.ts     SYSTEM_PROMPT, buildContextText, modeReminder
  session/store.ts             SessionStore, listSessions, readSessionFile, projectDir
  api/model.ts                 Model, buildParams, AnthropicModel, toolToApi, createClient
  api/errors.ts                describeError
  api/pricing.ts               costUsd, contextTokens, contextWindow
  agent/events.ts              AgentEvent, TurnEndReason, PermissionPrompt/Answer
  agent/agent.ts               Agent (the loop)
  ui/theme.ts, theme-context.tsx, markdown.ts
  ui/transcript.ts             transcript reducer (pure)
  ui/input-state.ts            prompt editing reducer (pure)
  ui/complete.ts               @-path and /command completion
  ui/commands.ts               slash command parser (pure)
  ui/runtime.ts                Runtime + AgentUi contracts
  ui/BrandHeader, Spinner, StatusBar, DiffView, TodoList, ToolRow, TranscriptRow,
     PermissionDialog, PromptInput, SessionPicker, App (.tsx)
test/
  helpers/tmp.ts, tool-context.ts, fake-model.ts, fake-runtime.ts, mock-api.ts
  e2e/print.e2e.test.ts        compiled binary vs mock API
(unit tests sit next to sources as *.test.ts / *.test.tsx)
```

## Tasks

| # | Task | Part file |
|---|---|---|
| 1 | Scaffold, version, paths, CLI args | [part-1-foundation](2026-10-12-tropos-code/part-1-foundation.md) |
| 2 | Settings load/merge | part-1 |
| 3 | Permission rules & shell splitting | part-1 |
| 4 | Permission engine | part-1 |
| 5 | Tool framework + Read | [part-2-tools](2026-10-12-tropos-code/part-2-tools.md) |
| 6 | Write + Edit | part-2 |
| 7 | Bash | part-2 |
| 8 | Glob + Grep | part-2 |
| 9 | TodoWrite + registry | part-2 |
| 10 | Context: memory, environment, system prompt | [part-3-core](2026-10-12-tropos-code/part-3-core.md) |
| 11 | Session store | part-3 |
| 12 | API layer (model, errors, pricing) | part-3 |
| 13 | Agent loop | part-3 |
| 14 | Print mode | part-3 |
| 15 | UI foundations: theme, markdown, transcript, commands | [part-4-ui](2026-10-12-tropos-code/part-4-ui.md) |
| 16 | UI components | part-4 |
| 17 | App + interactive wiring | part-4 |
| 18 | CLI main, build, e2e, install, README | [part-5-ship](2026-10-12-tropos-code/part-5-ship.md) |

Tasks are sequential; each task's **Interfaces** block lists the exact names it consumes and produces.
