# Tropos Code — Web app (`tcode web`) — Design Spec

**Date:** 2026-10-14 · **Status:** Scope agreed in conversation (local web app, Interior design, Cojeev animated icons from 21st)

## 1. Goal

`tcode web` opens a browser UI for the same agent the terminal runs. It works the way OpenClaw's Control UI and
Hermes Agent's dashboard do. The UI shares the agent, sessions, permissions, settings and extensions with the terminal.
It is local only: the server binds 127.0.0.1 and the UI ships inside the `tcode` binary.

**Design:** the Tropos Labs website (`~/Desktop/Tropos`) and its source, the Interior library by ddoemonn on 21st.dev.

- **Palette:** warm stone neutrals. `--paper #fafaf9`, `--surface #fff`, `--ink #1c1917`, `--ink-2 #57534e`,
  `--ink-3 #78716c`, `--rule #e7e5e4`, `--rule-strong #d6d3d1`.
- **Accent:** a single periwinkle, `#4568FF` and `#93B0FF`.
- **Surfaces:**
  - White cards with a hairline border and `--shadow-card`.
  - Inset wells (`--shadow-well`) for chips, the composer and navigation.
  - `--shadow-float` for popovers and dialogs.
  - Radii from 6 to 18 px.
- **Type:** Tektur, a variable font, self-hosted with `@fontsource-variable/tektur` so it works offline. Code and tool
  output use the system monospace.
- **Motion:** Interior's springs, from the site's `springs.ts`: `CELL` 520/34/0.45, `CROSSFADE` 260/34/0.8,
  `DISCLOSE` 150/27/1, and `EASE` `[0.23,1,0.32,1]`. `prefers-reduced-motion` is honoured.
- **Components:** the Interior components from 21st (`@ddoemonn`), fetched with the 21st MCP. The site's copies in
  `~/Desktop/Tropos/src/components/interior/` are reused as they are.
- **Icons:** Cojeev "Animated Icon" from 21st, id 37504: 158 icons with hover and press micro-motion. No other icon
  library is used.
- **Theme:** light only for now, like the site. Tokens are organised so that dark mode can be added later.

## 2. Architecture

```
web/                      Vite + React 19 + Tailwind v4 + motion (the browser app)
  index.html, vite.config.ts, src/…
src/web/
  protocol.ts             message types shared by server and client (no Node imports)
  server.ts               Bun.serve: static assets, auth, the WebSocket
  host.ts                 one Runtime for the server (from cli/runtime createRuntime) bridged to WS clients
  assets.ts               the embedded asset map (generated at build; dev serves web/dist from disk)
src/cli/…                 `tcode web` subcommand
```

**Shared logic:** the client imports these UI-agnostic modules from `src/` through the `@core` alias:
- `ui/transcript.ts`, the event reducer
- `ui/tool-view.ts`, per-tool titles and results
- `ui/commands.ts`, slash parsing
- `ui/suggest.ts`, command ranking
- `ui/model-list.ts`, model picker rows
- `config/constants.ts`

Vite aliases `node:path` to `pathe`.

**Build:**
1. `bun run build` runs `vite build web`, which outputs to `web/dist`.
2. It generates `src/web/assets.generated.ts`, which imports every file in `web/dist` with `with { type: "file" }`
   so `bun build --compile` embeds them.
3. It compiles as before.

`bun run dev:web` runs Vite with a proxy to a `tcode web --dev` server.

## 3. Server and security (`src/web/server.ts`)

**Starting it:** `tcode web [--port <n>] [--no-open]`.
- The server binds `127.0.0.1`. The default port is 4317, falling back to a free port when it is taken.
- A random 32-byte token is created per launch.
- It prints and opens `http://127.0.0.1:<port>/?token=<t>`.
- On the first request with a valid token, the server sets the cookie `tcode_session=<t>; HttpOnly; SameSite=Strict;
  Path=/` and redirects to `/`, so the token leaves the address bar.

**Every request:**
- The `Host` header must be `127.0.0.1:<port>` or `localhost:<port>`. This blocks DNS rebinding. Anything else gets 421.
- The session cookie must match. Without it, `/` shows a "Open this from the link tcode printed" page, and everything
  else gets 401.

**WebSocket upgrades** (`/ws`):
- The `Origin` must be exactly `http://127.0.0.1:<port>` or `http://localhost:<port>`. This blocks cross-site WebSocket
  hijacking.
- The cookie must match.

**Headers on every response:**
- `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`
- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: no-referrer`
- `Cross-Origin-Opener-Policy: same-origin`

**Static assets:**
- Served from the embedded map.
- Unknown paths get `index.html`, for client-side routing.
- Hashed assets are cached immutably; `index.html` is served `no-store`.

**Rendering untrusted text:** model output and tool output are untrusted. The client renders Markdown with `marked`
plus DOMPurify (with `USE_PROFILES: {html: true}`; forms and styles are forbidden, and links get `rel="noopener
noreferrer" target="_blank"`). All other text is React text nodes. There is never a raw `dangerouslySetInnerHTML`
without DOMPurify.

## 4. Protocol (`src/web/protocol.ts`), JSON over one WebSocket

**Client → server**

```ts
{ t: "rpc"; id: number; method: RpcMethod; params?: unknown }
{ t: "permission"; id: number; answer: PermissionAnswer }   // answers a server "ask"
```

**Server → client**

```ts
{ t: "hello"; server: HelloInfo }                 // on connect and after clear/resume
{ t: "event"; event: AgentEvent }                 // the agent's stream (text, thinking, tool_start/progress/end, notice, usage, turn_end, assistant)
{ t: "state"; state: SessionState }               // whenever model/effort/mode/busy/session change
{ t: "ask"; id: number; prompt: PermissionPrompt } // a permission prompt; the first answering client wins
{ t: "ask_closed"; id: number }                   // answered elsewhere or cancelled
{ t: "rpc_result"; id: number; ok: true; result: unknown } | { t: "rpc_result"; id: number; ok: false; error: string }
```

**Shapes**

```ts
HelloInfo = { version; cwd; sessionId; modes: Mode[]; commands: ExtraCommand[]; history: MessageParam[] }
SessionState = { model; effort; mode; busy: boolean; contextTokens; contextWindow?: number; totalCostUsd?: number; turns }
```

**RPC methods** (each maps onto the existing `Runtime` or `Agent`):

| Method | Params | Result |
|---|---|---|
| `prompt` | `{ text: string; display?: string; model?: string }` | Runs one turn. Resolves at `turn_end` with the `TurnEndReason`. Rejects with "busy" while a turn runs, because the client queues |
| `expand` | `{ name; args }` | A `CommandExpansion`. A `` !`cmd` `` may raise an `ask` |
| `interrupt` | — | Aborts the running turn or expansion |
| `setMode` | `Mode` | |
| `setModel` | `string` | |
| `setEffort` | `Effort` | |
| `panel` | `ListTopic` | `PanelData` |
| `sessions` | — | `SessionSummary[]` |
| `resume` | `id` | `HelloInfo` (also broadcast) |
| `clear` | — | `HelloInfo` (also broadcast) |
| `undo` / `redo` | — | `UndoResult` |
| `providers.status` | — | `ProviderStatus[]` |
| `providers.connect` | `{ id; key }` | Saves to `~/.tropos/credentials.json` as `/providers` does |
| `providers.disconnect` | `id` | |
| `providers.models` | `id` | `string[]` |
| `modelPrefs.get` | — | |
| `modelPrefs.recordUse` | `string` | |
| `modelPrefs.toggleFavorite` | `string` | |
| `completeFile` | `{ token }` | `string[]`, `@path` completions inside the project |

**Server state and clients**
- One host per server, so one live session. Every connected tab sees the same transcript.
- `state` and `event` are broadcast to all tabs.
- A tab that connects mid-turn gets `hello`, then the live events from that point on. The client rebuilds the
  transcript from `hello.history` with `historyToTranscript` and folds new events in with `reduce`.

**Session hooks:** SessionStart and SessionEnd fire as in the TUI. Start fires when the server starts and on clear and
resume; End fires on clear and shutdown.

## 5. UI (web/src)

### Layout (desktop ≥ 1024 px)

**Left sidebar, 272 px, a stone well**
- The Tropos mark (`tropos-logo.png`) and "Tropos Code".
- A **New session** button (`plus` icon).
- Session search (`search`).
- The session list: title, age and message count. The current session is marked with a periwinkle bar.
- At the bottom, navigation:

  | Page | Icon |
  |---|---|
  | Chat | `message-square` |
  | Skills | `layers` |
  | Agents | `bot` |
  | MCP | `network` |
  | Hooks | `workflow` |
  | Plugins | `package` |
  | Memory | `brain` |
  | Settings | `settings` |

**Top bar, on a white surface with a hairline below it**
- The page title.
- The session title.
- The model chip (`sparkles` plus the model, `◑ high`), which opens the model picker.
- A context meter (Interior progress bar, "ctx 12%").
- The cost, using Value Flash.
- An undo/redo cluster (`refresh-cw`).

**Main area**
- The transcript in a 760 px reading column.
- The composer pinned at the bottom.

### Narrow screens (< 1024 px)

The sidebar becomes an Interior Drawer (`panel-left` toggle). The top bar condenses with Sticky Header.

### Transcript

- **User message:** right-aligned, on a stone-100 well, radius 14. The slash command shows as typed.
- **Assistant message:**
  - The Tropos mark avatar, then sanitized Markdown.
  - Code blocks on stone-900 with a copy button (Interior Copy Button).
  - While a reply streams, a caret at the end of the text (Interior Streaming Text caret).
- **Thinking:** a collapsible "Thinking…" row using Interior Show More, with the text in ink-3 italic.
- **Tool call card:** a white card with a hairline border.
  - **Header:** a tool icon, then `Name(args)` from `tool-view.ts`, then a status dot.

    | Tool | Icon |
    |---|---|
    | Bash | `terminal` |
    | Read | `file-text` |
    | Edit / Update | `pencil` |
    | Write | `file-code` |
    | Search | `search` |
    | Fetch | `external-link` |
    | Agent | `bot` |
    | Skill | `layers` |
    | Todos | `square-check` |
    | Memory | `brain` |
    | MCP | `network` |

    The status dot is a periwinkle pulse while running, success green when done, a red error, or amber when denied.
  - **Body:** the result lines from `tool-view.ts`.
    - Diffs are rendered with line numbers and green/red line backgrounds.
    - Bash output is monospace, the first 3 lines with a "+N lines" expander.
    - Todos use Interior Task Steps.
    - An Agent shows its progress line and its tool-use count.
- **Notices:** a slim inline row with an icon: `info`, `triangle-alert` or `circle-alert`.
- **Turn footer:** `✻ Worked for 12s` in ink-3.
- **While busy:** Interior Typing Indicator under the last item.
- **Scrolling:** Interior New Items Pill appears when new content arrives while the reader has scrolled up.

### Composer (well, radius 18)

- An auto-growing textarea. Enter sends; shift+enter adds a newline.
- **Slash suggestions** in an Interior Popover above the composer, ranked with `suggest.ts`.
  - Each kind has its own colour: built-in ink, custom periwinkle, skill violet.
  - ↑/↓, tab and enter work as they do in the TUI.
- **`@` file suggestions** use `completeFile`.
- **Send button:** `send` icon; it becomes `pause` (interrupt) while busy.
- **Queue:** while a turn runs, sending queues the message. Queued messages show as chips above the composer, with ×
  to remove one and a click to edit it.
- **Mode:** Interior Segmented Control under the composer: Default · Accept edits · Plan. Bypass appears only when
  the server allows it.
- **Hint row:** `/ commands · @ files · ⇧⏎ newline`.

### Model picker

An Interior Modal ("Select model") using `model-list.ts`.
- A search field.
- Favorites, Recent and per-provider sections. The provider is shown as an aside.
- A star toggles a favourite.
- Effort is set with Interior Slider Detents, low…max. Enter picks.

### Permission prompt

An Interior Modal that cannot be dismissed by clicking outside.
- **Title** by tool: Bash command, Edit file, Write file, Fetch, Use X.
- **Preview:**
  - A command in a monospace block.
  - An Edit as a coloured diff.
  - Bidi and zero-width characters are made visible, as in the TUI.
- **"Why:"** line, if the prompt gives a reason.
- **Buttons:**
  - **Yes** (primary periwinkle, Press Depth).
  - **Yes, and don't ask again for `<rule>`**, when there is a suggestion.
  - **No** (ghost), which reveals a feedback textarea.
- **Keyboard:** 1, 2 and 3 pick an answer; Esc means No.

### Pages

- **Skills, Agents, Hooks, Plugins, Memory** (from `panel`):
  - Sections become cards.
  - Rows show name, hint and a status badge; clicking a row expands its details (Show More).
  - Skills also show their folder in an Interior Tree View, from the `detail` paths.
- **MCP:** an Interior Sortable Table with Name, Type, State badge, Tools and Error columns.
- **Settings:**
  - **Providers:** a list with connected state. **Connect** opens a key field (Floating Label) with Inline
    Validation; **Disconnect** removes a saved key. The key is never echoed back.
  - **Permissions:** the current mode, plus a note that rules live in `~/.tropos/settings.json`.
  - **About:** version, cwd and the session id with a copy button.

## 6. Out of scope (later)

- Dark theme.
- Multiple concurrent sessions per server.
- Remote access or tunnels.
- Mobile-first layout polish below 375 px.
- Editing settings files from the UI. Only provider keys can be changed in the UI.
