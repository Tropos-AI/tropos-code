# Tropos Code — TUI v2 Design Spec

**Date:** 2026-10-14 · **Status:** Requested by the user before 0.2.0

## 1. Goal

The terminal UI should feel like Claude Code's, with Tropos's own brand. The user asked for these five things:

1. A `/model` picker like OpenCode's.
2. The prompt input stays on screen while Tropos works.
3. TUI panels instead of transcript messages for command output.
4. Colored slash commands with live suggestions as you type.
5. Claude Code-style rendering of messages and tool calls (Bash, Read, Update and so on).

This is a clean-room build. Claude Code's and OpenCode's look and behaviour were studied, and none of their code or assets are copied. The brand stays Tropos: periwinkle accent, stone neutrals, and the "Turning/Pivoting/Orbiting/Revolving" spinner verbs.

## 2. Shared pieces (done)

**Theme** (`ui/theme.ts`)
- Existing tokens: `accent`, `muted`, `text`, `success`, `danger`, `warning`, `diffAdd`, `diffRemove`.
- New tokens:

  | Token | Used for |
  |---|---|
  | `shimmer` | Spinner shimmer band |
  | `subtle` | Quieter than muted: user-prompt glyphs, rejected tool results |
  | `diffAddBg`, `diffRemoveBg` | Full-line diff backgrounds |
  | `userBg` | Background behind the user's own messages |
  | `promptBorder` | Rules above and below the prompt input |
  | `acceptEdits`, `planMode` | Permission-mode indicators |
  | `command`, `customCommand`, `skill` | Slash suggestions by kind |
  | `agentColors` | Subagent badge backgrounds |

- `agentColor(theme, name)` gives each subagent type a stable color.

**Design primitives** (`ui/design/`)
- `Pane`: an accent rule, a bold title, the body indented two columns, then dim italic key hints.
- `SelectList`: a `❯` cursor, optional numbering, status marks, section headers, and `↑ N more` / `↓ N more` markers. The owner keeps `selected` and handles the keys.
- `Tabs`: a tab bar.
- `Toast`: a one-line result shown above the prompt.

**Runtime** (`ui/runtime.ts`)
- `panel(what)` returns `PanelData` (title, subtitle, sections of `PanelItem`s with hint, aside, status and detail lines, and an empty-state text) for `/skills`, `/agents`, `/hooks`, `/mcp`, `/plugins` and `/memory`.
- `modelPrefs` holds recent and favorite models in `~/.tropos/models.json`.
- `providers` (existing) lists providers and their models.

## 3. Transcript (`TranscriptRow`, `ToolRow`, `DiffView`, `TodoList`, `ui/tool-view.ts`)

**Glyphs:** `⏺` is the message and tool dot (`●` off macOS). `  ⎿  ` is the result gutter, dim. `❯` is the prompt and user pointer. `✻` marks a finished turn. `∴` marks thinking.

**Messages**
- User message: `❯ text` on a `userBg` background, with the glyph in `subtle`. A command shows as typed (`❯ /review main`).
- Assistant text: `⏺ ` in `text` color, then Markdown indented 2.
- Thinking (done): one dim italic line `∴ Thinking (ctrl+o to expand)`. While live, the last 3 lines show dim. In verbose mode (ctrl+o) the full text shows.
- Notices:
  - info: dim `⏺ text`
  - warn: `⏺` and text in `warning`
  - error: `⏺` and text in `danger`
- Turn footer: a dim `✻ Worked for 12s` (or `Turned`, `Pivoted`, `Orbited`, `Revolved` for `Worked`) after each turn longer than 5 s.

**Tool row header:** `⏺ Name(args)`, with the name bold and the args plain inside the parentheses. Dot by state:

| State | Dot |
|---|---|
| running | dim, blinking every 600 ms |
| done | `success` |
| error | `danger` |
| denied | `warning` |

**Display names and args**

| Tool | Header |
|---|---|
| Bash | `Bash(cmd)`, cut to 2 lines and 160 chars |
| Read | `Read(rel/path)` |
| Edit | `Update(rel/path)` |
| Write | `Write(rel/path)` |
| Glob | `Search(pattern: "x"[, path: "y"])` |
| Grep | `Search(pattern: "x"[, path: "y"])` |
| WebFetch | `Fetch(url)` |
| Agent | `Agent(description)`. The subagent type is a colored badge (`agentColor`) before it |
| Skill | `Skill(name)` |
| TodoWrite | `Update Todos` |
| Memory | `Memory(add user)` |
| SessionSearch | `Search sessions("query")` |
| SkillManage | `SkillManage(create name)` |
| BashOutput, KillShell | `BashOutput(id)`, `KillShell(id)` |
| MCP `mcp__srv__tool` | `srv - tool (MCP)(k: v, …)`, values cut at 40 |

Paths are shown relative to the cwd when inside it.

**Result lines** (under `  ⎿  `)

| Tool | Result |
|---|---|
| Bash | First 3 output lines, then dim `… +N lines (ctrl+o to expand)`. Empty output is `(No output)`. Errors in `danger` |
| Read | `Read N lines`, with the number bold (or the existing image/PDF summary) |
| Edit | `Added N lines, removed M lines`, then the diff |
| Write | New file: `Wrote N lines to path`, then the first 10 lines. Overwrite: the diff |
| Glob, Grep | `Found N files` / `Found N results` |
| WebFetch | `Received 12.3 KB (200)` |
| Agent | While running, the latest progress (`↳ Read src/x.ts`) plus `N tool uses`. Done: `Done (N tool uses)` |
| TodoWrite | The list: `✔` done (dim, strikethrough), `◼` in progress (accent, bold), `◻` pending |
| Denied | `Declined` in `warning`, or the user's feedback |
| Interrupted | dim `Interrupted` |
| Others | The tool's summary |

In verbose mode (ctrl+o) the full output shows.

**Diff:** line numbers (old for removed lines, new for added and context) padded to the width of the largest, then a space, then `+`/`-`/space and the text. Added and removed lines get a `diffAddBg` / `diffRemoveBg` background padded to the full width. A dim `...` separates hunks. Lines are capped at 40 (unless verbose), then `… +N lines`.

## 4. Prompt area (`PromptInput`, `Suggestions`, `Footer`, `Spinner`, `QueuedMessages`, `ShortcutsHelp`)

**Input box**
- Only top and bottom rules, in `promptBorder`. The `❯ ` glyph is accent, and dim while busy.
- The placeholder is `Ask Tropos… (/ for commands, @ for files)` before the first submit, and `Queue a message…` while busy.
- When the input starts with a known command (`/name`), the name is drawn in its kind color.

**While a turn runs**
- The input stays visible and editable.
- Enter queues the text. Queued items show above the input as dim `❯ text` rows on `userBg`.
- ↑ on an empty input moves all queued items back into the input.
- Queued items run in order when the turn ends; each becomes its own turn.

**Spinner** (above queued items and input)
- Frames `· ✢ ✳ ✶ ✻ ✽`, played back and forth every 120 ms.
- The verb with `…` is in accent, with a 3-character shimmer band in `shimmer` sweeping every 120 ms.
- Then dim ` (12s · ↓ 1.2k tokens)`. Tokens are output tokens so far (from usage events); the token part is omitted while 0.

**Footer** (one row under the input, `paddingX 2`)
- Left side:
  - idle and empty: dim `? for shortcuts`
  - busy: dim `esc to interrupt`
  - mode `acceptEdits`: `⏵⏵ accept edits on (shift+tab to cycle)` in `acceptEdits`
  - mode `plan`: `⏸ plan mode on (shift+tab to cycle)` in `planMode`
  - mode `bypass`: `⏵⏵ bypass permissions on` in `danger`
- Right side: dim `ctx 12% · $0.42`.
- Typing `?` into an empty input shows the shortcuts grid instead of the footer, without inserting `?`.

**Suggestions** (they replace the footer while open)
- They open when the input is `/word` with no space yet, or when the token at the cursor starts with `@`.
- Up to 6 rows, windowed around the selection. Each row is `/name` padded to the longest name + 3, then the description cut to the width.
- Colors: the selected row is accent and bold; other names use their kind color (`command`, `customCommand`, `skill`) with dim descriptions. Kind tags are dim `[skill]`, `[project]`, `[plugin]`.
- Ranking: exact name, then prefix, then substring of the name, then a description match. Shorter names come first among ties.
- Keys:

  | Key | Action |
  |---|---|
  | ↑ / ↓ | Move |
  | tab | Accept: replace the token with `/name ` |
  | enter | Accept, and submit if the command needs no argument |
  | esc | Close (until the token changes) |

- `@` files: the existing `completeFile`, shown as `+ path` rows. Tab or enter inserts the path.

## 5. Panels instead of messages (`App` + panel components)

These commands open a panel in place of the input, and esc closes it. Nothing they show goes into the transcript.

| Command | Panel |
|---|---|
| `/help` | Tabs: General (what Tropos is, how to use it), Commands (built-ins), Custom (custom commands and skills), Shortcuts. ←/→ or tab switch tabs |
| `/skills`, `/agents`, `/hooks`, `/mcp`, `/plugins`, `/memory` | A `ListPanel` from `runtime.panel()`: sections, status marks (`✔` ok, `△` warn, `✘` error, `◯` off), and the selected item's detail lines under the list |
| `/model` (no argument) | `ModelPicker` (§6). `/model <id>` still sets directly |
| `/effort` (no argument) | `EffortPicker`: low, medium, high, xhigh, max, with glyphs `○ ◔ ◑ ◕ ●` and the current one marked |
| `/cost` | A `CostPanel`: session cost, context tokens and %, model, turns |
| `/resume`, `/providers` | Existing pickers, restyled with `Pane` |

Outcomes such as "Model set to X", "Reverted 3 files" or "Effort: high" are shown as a `Toast` above the input for 4 s, not in the transcript. Errors from the agent stay in the transcript.

**Permission prompt:** a `Pane`-styled dialog.
- Title by tool: `Bash command`, `Edit file`, `Create file`, `Fetch`, `Use <tool>`.
- Then the preview (command, or diff with backgrounds) and `Do you want to proceed?`.
- Options: `❯ 1. Yes`, `2. Yes, and don't ask again for <rule>`, `3. No, and tell Tropos what to do differently`.
- Footer: `Esc to cancel · Tab to amend`.

## 6. Model picker (`ModelPicker`)

**Layout:** a `Pane` titled `Select model`, with the current model as the subtitle. Then:
- A search line `⌕ ` followed by the typed text.
- The list:
  - **Favorites** section first.
  - **Recent** section next, without favorites. The provider name is a dim aside.
  - Then one section per connected (ready) provider, with models fetched in parallel. Each section shows `Loading…`, or `Could not list models` if fetching failed.
  - The current model is marked `●` in success.
- An effort line: `◑ high effort  ← → to adjust`.

**Search:** typing filters every model by fuzzy subsequence match on `provider/model` and the provider name. The result is one flat list, with favorites first.

**Keys**

| Key | Action |
|---|---|
| ↑ / ↓ (ctrl+p / ctrl+n) | Move |
| pageup / pagedown | Move 10 rows |
| enter | Pick (records it as recent) |
| ctrl+f | Toggle favorite |
| ← / → | Change effort |
| ctrl+a | Open `/providers` to connect another provider |
| esc | Clear the search if any, otherwise close |

The result is `onPick(model, effort)`.

## 7. Queueing semantics (`App`)

**While busy:**
- Prompts and custom commands are queued.
- Panels (`/help`, `/skills`, `/model` with or without an id, `/cost` and so on) open immediately.
- `/clear`, `/resume`, `/undo`, `/redo` and `/exit` are refused with a toast, "wait for the turn to finish (esc to interrupt)".

**Esc:**
- Esc interrupts the turn. Queued items stay.
- A second esc with an empty input clears the queue.

**Startup:** the input is visible during SessionStart hooks, and anything typed then is queued.
