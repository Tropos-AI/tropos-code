# Tropos Code — Phase 2: Extensibility — Design Spec

**Date:** 2026-10-14 · **Owner:** Tropos Labs · **Status:** Scope approved in conversation (all four groups; repo-shipped
code never runs)

## 1. Purpose

Phase 1 (`2026-10-12-tropos-code-design.md` §13) deferred hooks, MCP, subagents, skills, custom slash-command files and
web fetch. This phase adds them, plus the most useful ideas from two MIT-licensed agents, OpenCode (snapshots and undo,
formatters, LSP diagnostics) and Hermes Agent (a memory tool with a budget, session search, agent-written skills).

It stays a **clean-room build**. Claude Code's file formats are public and widely used, so Tropos reads the same shapes
(`SKILL.md`, `.claude/commands`, hook JSON on stdin), but no Claude Code source, prompts or assets are copied.

## 2. Principles

1. **Repo files are data, never code.** Commands, skills and agents found in the repo are markdown that becomes prompt
   text. Their `allowed-tools`, `model` and similar keys grant nothing: every tool call still goes through the user's
   permission settings. Anything that **runs a program** (hooks, MCP servers, plugins, formatters, language servers)
   is configured only under `~/.tropos/` (settings §6 trust split). Repo layers that set those keys are ignored with
   a startup warning. Hardening, from the security review:
   - User extensions take precedence over project ones (`~/.tropos/<kind>` is searched first), a project agent can't
     replace a built-in, and a project file whose real path leaves the project is skipped.
   - Slash-command arguments are never scanned for `` !` `` or `@`. Inside a `` !` `` command they become shell-quoted
     words, and those commands also go through PreToolUse hooks.
   - Untrusted text never forms a harness tag: memory files, skills, commands, inlined files and notes pass through
     one escaper (`context/tags.ts`). Genuine `<hook-context>` and `<reminder>` blocks carry a per-session nonce,
     also shown in the `<context>` block as `<harness-nonce>`.
   - Memory writes ask (they are edits outside the project), SessionSearch asks before searching all projects, an
     MCP server's `readOnlyHint` never skips a prompt, stdio MCP servers start in the home directory (never the repo,
     whose `.npmrc`/`node_modules` would steer `npx`), and a host containing `*` is refused (no wildcard rule
     suggestions).
   - Formatter and language-server programs are found through absolute PATH entries only, never inside the project.
     Once the agent writes anything but a plain source or doc file (an extension allowlist; JS
     `*.config.*`, `.prettierrc*`, `.pnp.*` and `build.rs` excluded, as is anything under `node_modules`, `.yarn`,
     `.cargo` or a virtualenv; checked case-insensitively on the given and resolved path), both stay off for the
     session, so an approved edit can't become code execution. This fails closed by design: a list of config names
     would always miss one. Slash-command shell lines honour PreToolUse `ask` and `updatedInput`
     like model calls. Patterned deny/ask rules still cover pathless tools, MCP server names can't start or end with
     `_`, and no "don't ask again" rule is offered for a folder whose name contains glob characters.
   - Formatters and language servers are the exception: once the user turns them on they run the project's own code
     (prettier's JS config, the workspace TypeScript), so the README recommends enabling them per project.
2. **The prompt cache is sacred.** The system prompt and tool list are fixed for a session. Skill and agent listings,
   memory notes and hook context travel in user messages (the first message's `<context>` block, or later
   `<hook-context>` / `<reminder>` text blocks), never in the system prompt.
3. **History is append-only.** `/undo` reverts files, not messages; the model learns about it from a reminder on the
   next prompt.
4. **Failures are results.** A broken skill file, a hook that times out, or an MCP server that won't start is a
   notice or an error result. It never crashes the session.

## 3. Layout

```
src/
├── extensions/   frontmatter, discovery (sources), commands, skills, agents, plugins
├── hooks/        hook runner (matching, spawning, output parsing)
├── mcp/          MCP client manager and tool adapter
├── snapshots/    shadow-git store for /undo and /redo
├── format/       formatters run after Write/Edit
├── lsp/          minimal LSP client; diagnostics after Write/Edit
├── memory/       Memory, SessionSearch and SkillManage tools
└── tools/        + skill/, agent/, webfetch/
```

## 4. Discovery (`extensions/sources.ts`, done)

`extensionDirs(kind, {cwd, home, plugins})` lists the folders to search, highest precedence first. Loaders keep the
first definition of each name.

| Precedence | Folders | Source |
|---|---|---|
| 1 | `~/.tropos/<kind>` | `user` |
| 2 | From cwd up to the git root (only cwd outside git), nearest first: `.tropos/<kind>`, `.claude/<kind>`, and also `.agents/skills` for skills | `project` |
| 3 | `<plugin>/<kind>` for each enabled plugin; names become `plugin:name` | `plugin` |

`kind` is one of `commands | skills | agents`. `frontmatter.ts` parses YAML frontmatter (via `Bun.YAML`, with a
`key: value` line fallback) and provides `fmString`, `fmList` and `fmBool`.

## 5. Custom commands (`extensions/commands.ts`)

**Files:** `<dir>/**/*.md`. A subfolder becomes a `:` segment, so `commands/git/pr.md` is `/git:pr`. Plugin commands
are `/plugin:name`. A command never shadows a built-in. Built-ins win, and the loader skips a clash with a warning.

**Frontmatter:**

| Key | Meaning |
|---|---|
| `description` | Default: the first non-empty body line, at most 100 chars |
| `argument-hint` | Shown in `/help` and the command menu |
| `model` | Model for this one turn. Ignored for project commands on other providers (same rule as repo settings) |
| `agent` | Runs the expanded prompt as that subagent instead of in the main conversation |

**Expansion**, in order:

1. `$ARGUMENTS` becomes the raw argument string.
2. `$1`…`$9` become the shell-style split arguments; a missing one becomes "".
3. If the body has no placeholder and there are arguments, `\n\nArguments: <args>` is appended.
4. `` !`cmd` `` (at line start or after whitespace) runs through the **Bash tool's permission check**. That is normal
   Bash: it asks unless allowed, and in print mode an ask is a deny. The output (≤10k chars) replaces it. A declined
   command aborts the expansion with a notice.
5. `@path` (a token starting with `@`, resolved against cwd) is inlined as `<file path="…">content</file>` when it is
   a readable file inside the allowed dirs and no Read deny rule covers it. Otherwise it's left as is.

**API:**

```ts
interface CustomCommand { name: string; description: string; argumentHint?: string; body: string; path: string;
  source: ExtensionSource; model?: string; agent?: string }
loadCommands(dirs: ExtensionDir[], reserved: Set<string>): Promise<{ commands: CustomCommand[]; warnings: string[] }>
expandCommand(cmd, args: string, io: { runShell(command: string): Promise<{ ok: true; output: string } | { ok: false; reason: string }>;
  readFile(token: string): Promise<{ path: string; content: string } | null> }): Promise<{ ok: true; prompt: string } | { ok: false; reason: string }>
```

The UI shows the user's typed `/name args`. The model receives `<command name="/name">expanded</command>`.

## 6. Skills (`extensions/skills.ts`, `tools/skill/skill.ts`)

**Files:** `<dir>/<name>/SKILL.md` (agentskills.io layout). The folder name is the skill's name, and a frontmatter
`name` that differs is ignored. Plugin skills are `plugin:name`.

**Frontmatter:**
- `description` — required; a skill without one is skipped with a warning.
- `when_to_use` (optional)
- `disable-model-invocation` — keeps the skill out of the listing and refuses `Skill` calls; `/name` still works.
- `user-invocable` — default true; makes the skill a `/name` command.

**Listing:** the first message's `<context>` block gains `<skills>` with one line per skill,
`- name: description[ — when_to_use]`. Each line is capped at 250 chars and the whole block at 8,000 chars; past the
cap, lines drop to names only, then a "N more skills" note.

**The `Skill` tool:**
- Input: `{ skill: string, args?: string }`. Kind `meta`. Permission target is the skill name, so `Skill(deploy)` deny
  rules work.
- Result:
  ```
  <skill name="…" dir="/abs/dir">body</skill>
  ```
  - `${TROPOS_SKILL_DIR}` and `${CLAUDE_SKILL_DIR}` in the body are replaced with the skill's folder.
  - It is followed by a list of the other files in the folder (≤50, relative paths) so the model can Read them.
  - `args` is appended as `Arguments: …`.

**Slash use:** `/name args` sends `<skill …>…</skill>` plus the arguments as the user turn.

**API:**

```ts
interface Skill { name: string; description: string; whenToUse?: string; dir: string; path: string; body: string;
  source: ExtensionSource; modelInvocable: boolean; userInvocable: boolean }
loadSkills(dirs: ExtensionDir[]): Promise<{ skills: Skill[]; warnings: string[] }>
skillListing(skills: Skill[], budget?: number): string            // "" when none is model-invocable
renderSkill(skill: Skill, args?: string): Promise<string>         // the <skill> text
createSkillTool(skills: Skill[]): AnyTool
```

## 7. Subagents (`extensions/agents.ts`, `tools/agent/agent-tool.ts`)

**Files:** `<dir>/*.md` (also `<dir>/**/*.md`). The frontmatter `name` is required; a file without one is skipped
silently so docs can live alongside. Plugin agents are `plugin:name`.

**Frontmatter keys:**
- `description` — required
- `tools` — list or comma-separated; missing or `*` means every tool except `Agent`
- `disallowedTools`
- `model` — `inherit` by default. A project agent may only pick an Anthropic model.
- `maxTurns` — default 50
- The body is the agent's instructions.

**Built-in agents:**
- `general-purpose` — all tools
- `explore` — Read, Glob, Grep, plus Bash for read-only commands and WebFetch; its prompt says to report findings,
  not change files
- `plan` — the same tools as explore; returns a step-by-step plan

User and project agents with the same name override these.

**The `Agent` tool:**
- Input: `{ description: string (3–6 words), prompt: string, subagent_type?: string }`. The default type is
  `general-purpose`.
- Kind `meta`, so several run in parallel.
- Its description lists the available agents (`- name: description (Tools: …)`). The list is fixed when the session
  starts.

**How a subagent runs:**
- The child is a fresh `Agent` that shares the parent's model, permission context (mode and rules) and tool context.
  Its read-state is shared too, so its reads count.
- It gets its own todo store.
- Its tool list is the definition's filter applied to the parent's tools. `Agent` is always removed, so there is no
  nesting.
- Its system prompt is the Tropos system prompt plus `# Agent: <name>\n<instructions>`.
- The first message carries the same `<context>` block and the prompt.
- Permission asks go to the parent UI through the shared ask queue. Child tool starts appear as progress on the Agent
  row: `↳ Read src/x.ts`.
- The child's messages are kept in memory, not in the session file.

**Result:**
- The child's final assistant text, plus a footer `(<n> tool uses · <turns> turns)`.
- An aborted or failed child is an error result.
- Hooks fire `SubagentStop` when the child ends.

## 8. Hooks (`hooks/runner.ts`)

**Config:**
- In settings `hooks` (user layers only), and in each enabled plugin's `hooks/hooks.json` (`{"hooks": {...}}`, same
  shape).
- Plugin hooks get `TROPOS_PLUGIN_ROOT` and `CLAUDE_PLUGIN_ROOT`, and `${TROPOS_PLUGIN_ROOT}`/`${CLAUDE_PLUGIN_ROOT}`
  in the command are replaced.

**Events and matching:**

| Event | Matched against | Extra stdin fields |
|---|---|---|
| `PreToolUse` | tool name | `tool_name`, `tool_input`, `tool_use_id` |
| `PostToolUse` | tool name | + `tool_response` (the result text) |
| `PostToolUseFailure` | tool name | + `error` |
| `UserPromptSubmit` | — | `prompt` |
| `Stop` | — | `stop_hook_active`, `last_assistant_message` |
| `SubagentStop` | agent type | `agent_type`, `last_assistant_message` |
| `SessionStart` | `startup`, `resume` or `clear` | `source` |
| `SessionEnd` | `exit` or `clear` | `reason` |

Matcher rules:
- An empty matcher or `*` matches everything.
- `[A-Za-z0-9_|]+` is an exact name or a `|` list.
- Anything else is a regex, anchored as `^(?:…)$`. An invalid regex never matches.

**stdin:** the event fields above plus `{ session_id, transcript_path, cwd, permission_mode, hook_event_name }`.

**Spawning:**
- Command hooks run with `$SHELL -c` (falling back to bash) in the project dir.
- Environment: the user's environment plus `TROPOS_PROJECT_DIR` and `CLAUDE_PROJECT_DIR`.
- Timeout is the `timeout` setting (default 60 s). A timed-out hook is killed and counts as a non-blocking error.
- All matching hooks for an event run in parallel. Identical commands run once.

**Results** (Claude Code-compatible, so existing hook scripts work):

| Exit | Effect |
|---|---|
| 0 | Success. If trimmed stdout starts with `{`, it's parsed as JSON. Otherwise, for `UserPromptSubmit` and `SessionStart`, stdout becomes additional context |
| 2 | Blocking. stderr is the reason: `PreToolUse` → tool denied with the reason; `PostToolUse`/`PostToolUseFailure` → reason appended to the result; `UserPromptSubmit` → prompt not sent, reason shown to the user; `Stop`/`SubagentStop` → the agent continues with the reason as a user message |
| other | Non-blocking error: a warning notice with stderr's first line |

JSON fields:
- Common: `continue: false` (with `stopReason`) ends the turn, and `systemMessage` is shown to the user.
- Legacy: `decision: "block"` with `reason` behaves like exit 2.
- `hookSpecificOutput.permissionDecision` (`allow|deny|ask`), `permissionDecisionReason`, `updatedInput` —
  PreToolUse.
- `hookSpecificOutput.additionalContext` — all events.

Precedence across hooks:
- Decisions: deny > ask > allow.
- `updatedInput`: the last hook wins.
- Additional contexts are joined.

A hook's `allow` skips the permission prompt but never overrides a deny rule. `updatedInput` is re-validated against
the tool's schema.

**API:**

```ts
interface HookOutcome { blocked?: string; permission?: "allow" | "deny" | "ask"; permissionReason?: string;
  updatedInput?: unknown; additionalContext: string[]; stop?: string; messages: string[]; errors: string[] }
class HookRunner { constructor(config: { hooks: HooksSetting; plugins?: Array<{ name: string; root: string; hooks: HooksSetting }> },
  base: { sessionId(): string; transcriptPath(): string; cwd: string; mode(): string; env?: NodeJS.ProcessEnv; shell?: string })
  has(event: HookEvent): boolean
  run(event: HookEvent, input: Record<string, unknown>, match?: string, signal?: AbortSignal): Promise<HookOutcome> }
```

## 9. Plugins (`extensions/plugins.ts`)

**Location:** `~/.tropos/plugins/<name>/`. Repo plugins are never loaded. A plugin's manifest is optional: it's
`.tropos-plugin/plugin.json`, `.claude-plugin/plugin.json` or `plugin.json`, with `{ name, version?, description? }`.
A missing name falls back to the folder name. Names are kebab-case.

**Contents** (all optional):
- `commands/`, `skills/`, `agents/`
- `hooks/hooks.json`
- `.mcp.json` (`{ "mcpServers": {...} }`, the same shape as settings). Servers are named `<plugin>-<server>`.

**Enabling:** every plugin is enabled unless listed in the `disabledPlugins` setting.

**Commands:**
- `/plugins` lists plugins and what each one contributes.
- `tropos plugin install <git-url|path>` is out of scope; users clone into `~/.tropos/plugins`.

```ts
interface LoadedPlugin { name: string; root: string; version?: string; description?: string; hooks: HooksSetting;
  mcpServers: Record<string, McpServerSetting>; enabled: boolean }
loadPlugins(home: string, disabled: string[]): Promise<{ plugins: LoadedPlugin[]; warnings: string[] }>
```

## 10. MCP client (`mcp/`)

**Servers:** settings `mcpServers` (user layers) plus enabled plugins' servers. Server types:
- stdio (`command`, `args`, `env`, `cwd`)
- `http` (streamable HTTP, `url` and `headers`)
- `sse`

`${VAR}` and `${VAR:-default}` are expanded from the environment in `args`, `env`, `url` and `headers`.

**Startup:**
- All servers connect in parallel before the first request, each with a 15 s timeout (`TROPOS_MCP_TIMEOUT` ms).
- A failed server becomes a startup notice and its tools are absent.
- The tool list is then fixed for the session (principle 2).

**Tools:**
- Named `mcp__<server>__<tool>`. Characters outside `[A-Za-z0-9_-]` become `_`, and names are capped at 64 chars
  (the server part is truncated first).
- The description is the server's text, capped at 2,000 chars.
- `inputSchema` is the server's JSON Schema, sent raw. Validation is `z.record(z.string(), z.unknown())`; the server
  validates the rest.
- Kind is `net` when `annotations.readOnlyHint` is true (it may run in parallel and in plan mode), otherwise `exec`.
  Either way calls ask unless a rule like `mcp__github` or `mcp__github__get_*` allows them: annotations are the
  server's own claim.

**Results:**
- Text content is joined. Images become image blocks, and resources become their text or uri.
- `isError` is passed through.
- Output is capped at 50,000 chars.
- Each call times out after 120 s (`TROPOS_MCP_TOOL_TIMEOUT` ms) and is cancelled on abort.

**Commands:** `/mcp` lists servers, their status, tool counts and errors. Servers are closed on exit.

```ts
class McpManager { constructor(servers: Record<string, McpServerSetting>, env: NodeJS.ProcessEnv)
  start(): Promise<void>; tools(): AnyTool[]; status(): McpServerStatus[]; close(): Promise<void> }
```

## 11. WebFetch (`tools/webfetch/`)

- Input: `{ url: string, max_chars?: number (default 50,000, ≤ 200,000) }`.
- Kind `net`, a new kind:
  - It asks unless a rule allows it.
  - It is allowed in plan mode.
  - It runs in parallel with reads.
- Permission target is `domain:<host>`, and "don't ask again" offers `WebFetch(domain:<host>)`.

**Fetching:**
- Only http and https.
- `http://` is upgraded to `https://`, except for localhost.
- At most 5 redirects. A redirect to a different host stops and reports the new URL instead of following it, since
  the user approved one domain.
- 30 s timeout. A body over 10 MB is refused.

**Content handling:**

| Content type | Handling |
|---|---|
| `text/html` | Converted to markdown with `node-html-markdown` |
| `text/*`, JSON, XML | Returned as is |
| Anything else | Refused with its content type |

The result is `URL: …\nStatus: …\n\n<content>`, truncated with a note.

**Security:** the tool description and the system prompt already say fetched pages are data, not instructions.

## 12. Snapshots and /undo (`snapshots/`)

**Store:**
- A shadow git repo at `~/.tropos/snapshots/<projectKey>/`, with the work tree at the git root.
- Only inside git repos: outside one, snapshots are off with a one-time notice when `/undo` is used.
- Every git call passes:
  - `--git-dir=<store> --work-tree=<root>`
  - `-c core.hooksPath=/dev/null`
  - `-c core.autocrlf=false` and `-c core.fsmonitor=false`
  - `-c gc.auto=0`
- The repo's own `.git` is never touched.
- `info/exclude` holds `.git`. The work tree's `.gitignore` files apply.

**Recording:** `track()`:
- Runs `add -A` and `write-tree`, and returns the tree hash.
- Is called before each user turn, and only when that turn later runs an `edit` or `exec` tool. It's recorded
  lazily, at the first such tool call of the turn.
- Is skipped silently when it fails, or when it takes more than 10 s for a huge tree; that marks the turn
  un-undoable.

**`/undo`:**
- Restores the work tree to the tree recorded before the last turn that changed something, using
  `read-tree` + `checkout-index -a -f`.
- Files created since then are deleted (paths in the current tree but not in the snapshot, from `diff --name-only`).
- It first records the current state so `/redo` can return to it.
- It reports the files changed.
- The next prompt carries `<reminder>The user undid your file changes from the last turn(s): <files>. Re-read
  before editing.</reminder>`.

**Other commands and limits:**
- `/redo` re-applies the last undo.
- `/undo` again walks further back.
- The undo stack is per session and in memory.
- Pruning: `git gc --prune=7.days` runs at most once a day on startup, in the background.

```ts
class SnapshotStore { static open(home: string, cwd: string): Promise<SnapshotStore | null>
  track(): Promise<string | null>; changedSince(tree: string): Promise<string[]>; restore(tree: string): Promise<string[]> }
```

## 13. Formatters and LSP diagnostics (`format/`, `lsp/`)

Both are off by default. They run programs, so the user turns them on in `~/.tropos/settings.json`. Both run after a
successful Write or Edit, inside the tool call, before the result returns.

**Formatters:**
- `formatter: true` enables these built-ins when their executable is found:

  | Formatter | Where it's found | Extensions |
  |---|---|---|
  | prettier | PATH | `.js .jsx .ts .tsx .json .css .scss .md .yaml .yml .html` |
  | biome | when `biome.json` exists; preferred over prettier | — |
  | gofmt | — | `.go` |
  | rustfmt | — | `.rs` |
  | ruff format, else black | — | `.py` |

  Built-ins come from PATH only, never from the repo's `node_modules/.bin`: that folder can be committed, so running
  it would let a cloned repo run code. To use the project's pinned copy, add a custom entry such as
  `["npx", "prettier", "--write", "$FILE"]`.
- A record form defines custom formatters, with `$FILE` substituted in `command`.
- The first match by extension runs, with a 15 s timeout.
- If the file changed, read-state is refreshed (so the next Edit isn't "stale") and the result gets
  `(formatted with <name>)`.
- A failing formatter adds `(formatter <name> failed: <first line>)`.

**LSP:**
- `lsp: true` enables these built-ins when found on PATH:

  | Server | Extensions |
  |---|---|
  | `typescript-language-server --stdio` | `.ts .tsx .js .jsx .mjs .cjs` |
  | `pyright-langserver --stdio` | `.py` |
  | `gopls` | `.go` |
  | `rust-analyzer` | `.rs` |

- A record form defines custom servers.
- Language servers can load code from the project they analyse (the workspace TypeScript, a configured Python
  interpreter), so `lsp` is a statement of trust. Where a server can be told not to run project code it is:
  rust-analyzer gets `cargo.buildScripts.enable: false`, `procMacro.enable: false` and `checkOnSave: false`, and gopls runs
  with `GOTOOLCHAIN=local`. Per-project opt-in goes in `~/.tropos/projects/<project>/settings.json`.
- A server is started lazily per root (the git root) and reused for the session.
- After a write:
  - The client sends `didOpen`/`didChange` with the new content.
  - It waits up to 3 s for `publishDiagnostics` for that URI. Debounced: the last publish within 300 ms of quiet
    wins.
  - It appends up to 20 **errors** as `\n\n<diagnostics file="rel">\nL12:5 message\n</diagnostics>`.
- Servers are shut down on exit.

```ts
class Formatters { constructor(setting: Settings["formatter"], cwd: string, which?: (bin: string) => string | null)
  format(path: string, signal: AbortSignal): Promise<{ name: string; changed: boolean } | { name: string; error: string } | null> }
class LspManager { constructor(setting: Settings["lsp"], cwd: string, which?: (bin: string) => string | null)
  diagnostics(path: string, content: string, signal: AbortSignal): Promise<string | null>; close(): Promise<void> }
```

## 14. Memory, session search and agent-written skills (`memory/`)

### Memory tool

- Input: `{ target: "memory" | "user", action: "add" | "replace" | "remove", content?, old_text? }`.
- Storage:
  - `~/.tropos/memories/MEMORY.md` holds the agent's notes, up to 2,200 chars.
  - `~/.tropos/memories/USER.md` holds the user profile, up to 1,375 chars.
  - Entries are separated by `\n§\n`.
- Actions:
  - `replace` and `remove` find the entry by a unique substring `old_text`.
  - A write that would exceed the budget fails and returns the current entries, so the model consolidates.
  - Exact duplicates are rejected.
- Kind `meta`, so no prompt. The transcript shows what was saved.
- Writes take effect on disk immediately. The `<context>` block of the **next** session carries
  `<notes source="agent">` and `<notes source="user-profile">` with a usage header (`[67% — 1,474/2,200 chars]`).
- Setting `memory: false` removes the tool and the notes.

### SessionSearch tool

- Input: `{ query: string, all_projects?: boolean, limit?: number (≤ 20) }`.
- It scans session JSONL files (this project's, or all of them) for user and assistant text containing every query
  word, case-insensitive.
- Results are newest first: session id, date, title, and a ±200-char snippet per hit, at most 3 per session.
- Kind `read`.

### SkillManage tool

- Input: `{ action: "create" | "patch" | "write_file" | "delete", name, content?, old_string?, new_string?, file_path?, file_content? }`.
- It works on `~/.tropos/skills/<name>/`. Names are kebab-case.
- `create` writes a `SKILL.md` that must have frontmatter with a `description`.
- `file_path` is relative and must stay inside the skill folder.
- Kind `edit`. Its subject paths are the files touched, which are outside the project, so it **always asks**.
- New skills join the listing in the next session.

### Commands

- `/memory` shows both stores.
- `/learn [topic]` is a prompt template asking the model to distil the reusable procedure from this session (or the
  topic) into a skill with `SkillManage`.

## 15. Integration

**Startup** (`cli/main.tsx`), in order:
1. Settings
2. Plugins
3. Commands, skills and agents
4. Hooks
5. MCP (awaited)
6. Tools

The tool order is fixed:
- Base tools, then `WebFetch`
- Then `Skill` (only if any model-invocable skill exists) and `Agent`
- Then `Memory` (only if enabled), `SessionSearch` and `SkillManage`
- Then MCP tools, sorted

**Agent loop hooks** (`agent/agent.ts`):

| Point | What runs |
|---|---|
| When a turn starts | `UserPromptSubmit` |
| Between schema validation and the permission decision | `PreToolUse` |
| After the tool runs | `PostToolUse` / `PostToolUseFailure` |
| On `end_turn` | `Stop`, which can continue the turn at most 3 times per user turn |

Also on `end_turn`:
- `onTurnStart` lets snapshots record lazily.
- A `postWrite(paths, signal)` callback appends formatter and LSP text to Write/Edit results.

**Session events:** `SessionStart` fires on start, resume and `/clear`, and its additional context is prepended to the
first prompt. `SessionEnd` fires on exit and `/clear`.

**New slash commands:**
- `/skills`, `/agents`, `/hooks`, `/mcp`, `/plugins`
- `/undo`, `/redo`
- `/memory`, `/learn`
- Custom commands and user-invocable skills appear in `/help` and the `/` menu.

**Print mode:** everything works the same. Asks are denies, as before, including `` !`cmd` `` in commands.

## 16. Testing

- Coverage stays at ≥80% per file. Every module ships unit tests next to it.
- Hooks are tested with real shell scripts in temporary directories.
- MCP is tested against an in-repo stdio test server, written with the SDK's `McpServer`.
- Snapshots are tested against real temporary git repos.
- LSP is tested against a fake stdio server script that speaks the protocol.
- WebFetch is tested against a local `Bun.serve`.
- Subagents are tested with the fake model.

## 17. Out of scope

- WebSearch. It needs provider-specific server tools.
- Background subagents and SendMessage.
- Plugin marketplaces and the install CLI.
- MCP OAuth, resources and prompts.
- Hook types other than `command`.
- A trust prompt for repo hooks and MCP servers.
- Skill hub and curator.
- LSP navigation tools.
