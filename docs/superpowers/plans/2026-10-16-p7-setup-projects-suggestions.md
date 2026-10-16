# P7: Self-setup, projects without setup, and suggestions: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The agent changes Tropos's own setup when the owner asks (`TroposSetup`). Git repos register themselves, and chats create and switch projects and work in git worktrees. The agent suggests things at most once per conversation and at most once a day on its own. The Memory and Skills pages gain edit, delete and restore.

**Architecture:** `TroposSetup` is one typed tool. A pure action × role matrix decides who may call it, and each action goes through the existing admin handlers (`src/web/admin/*`), so the dashboard and the agent share one validated path. Every change lands in the learning ledger as a value-level entry, and a value is only copied there when it holds no secret. Secrets pasted into a chat are sealed into a per-session vault before the model or the transcript sees them. Projects gain tombstones, auto-registration, create/rename and fuzzy matching. When a chat works in a registered repo, it gets a git worktree, and Tropos itself commits, merges or pushes with repo hooks disabled. Suggestions come from a small signal store and a `<suggestions>` context block. The heartbeat is a gateway service that runs a read-only scheduled session in the default workspace.

**Tech Stack:** TypeScript on Bun, zod, `bun test` with colocated `*.test.ts`, React + Testing Library (web), host `git` and optional `gh` binaries (no new runtime dependency).

**Spec:** `docs/superpowers/specs/2026-10-16-growing-agent-design.md` (Parts H, I, J; §10 item 13 for the Memory and Skills pages), with `docs/superpowers/specs/2026-10-16-setup-autonomy-access-design.md` for the owner role and autonomy rules. Binding names: `docs/superpowers/plans/2026-10-16-contracts.md` (this plan implements C8 and relies on C1–C7 as implemented).

## Global Constraints

- TypeScript on Bun, zod, colocated `*.test.ts`, TDD (write the failing test first), and short comments that say why. Match the nearby code.
- No new runtime dependency. `git` and `gh` are host binaries, called only when present.
- Each task ends green: `bun test <the task's test files>` and `bun run typecheck`. Per the owner's rule, tasks end with `git add` of the task's files; nothing is committed.
- Names from the contracts file stay exactly as written: `SessionRole`, `role`, `isOwner`/`owner()`, `Autonomy`, `effectiveAutonomy`, `canRaise`, `chat.autonomy`, `projects[].autonomy`, `projects[].testCommands`, `workspaceDir`/`workspaceFile`/`journalDir`/`userSkillsDir`/`learnedSkillsDir`/`agentsDir`, `loadSpecialists`, `MAX_ACTIVE_SPECIALISTS`, `DEFAULT_PORT = 4317`, the tool name `TroposSetup` in `src/tools/setup/setup-tool.ts`, and the `proactive`/`newProjectsDir` keys of C8.
- C8 defaults, verbatim: `proactive: { activeHours: { start: "09:00", end: "21:00" }, everyHours: 4, maxPerDay: 1 }`. When `enabled` is unset it means "on once Telegram is connected". `newProjectsDir` defaults to `~/Projects`.
- Worktrees live at `~/.tropos/worktrees/<project>/<task>` on branch `tropos/<task>`.
- The tool never raises autonomy and never changes remote access, pairing approvals, permission rules, hooks or sandbox/confinement. Those stay "UI and CLI only".
- Secrets are never echoed, logged, put in an error, or copied into the ledger. In Telegram, a message that carries one is deleted with `deleteMessage`.
- User-facing copy offers "ask me to …" plus the dashboard link (`http://localhost:4317/#/…`, or the configured `webPort`) wherever the setup tool can do the job. It never says "edit `gateway.json`/`settings.json`".
- The anti-goal is pestering. Nothing unprompted is sent in quiet hours, at most `maxPerDay` messages go out per local calendar day (default 1), and only to the owner.
- Suggestions and the heartbeat run for the owner only. Guests, scheduled runs and specialists never get `TroposSetup`, `Suggestion`, suggestions or the heartbeat.
- Web: Testing Library tests per page and component. Before a web task is done, take screenshots at 320, 375, 768, 1024 and 1440 px under both system color schemes (the app is light-only, as P3 decided: under a dark scheme it must stay light and legible), and check keyboard use and reduced motion.

## Review Focus

- A secret pasted in a chat together with other text, two secrets in one message, or a secret pasted by a guest: no raw value may reach the model, the session file, a broadcast to other tabs, or a tool's permission prompt, and the Telegram message must be deleted. Task 3 pins this with a session-file and host-broadcast test.
- `/learned undo` (or the Memory page's Undo) on an "autonomy lowered" entry would *raise* autonomy from a chat. The entry must be recorded `noUndo`, and undo must refuse with the dashboard pointer. Task 6 pins this.
- The agent edits files in a chat worktree, and Tropos then commits, merges or pushes on the host, unconfined. A repo hook or `core.hooksPath` must never run there. Task 9 pins this with a `pre-commit` hook that would write a marker.
- A guest (an approved sender who is not the owner) presses Merge or Open PR and would change the owner's checkout or remote. They must be refused, and Discard always asks for a second tap. Task 10 pins this.
- Active hours that cross midnight (`22:00`–`06:00`), and a message sent at 23:30 followed by a run at 09:00 the next day. Quiet hours mean no run at all, and the daily cap counts per local calendar day. Task 12 pins this.

---

### Task 1: Gateway config for proactive messages and new projects; the dashboard link

**Files:**
- Modify: `src/gateway/config.ts`
- Create: `src/gateway/dashboard-link.ts`
- Test: `src/gateway/config.test.ts`, `src/gateway/dashboard-link.test.ts`

**Interfaces:**
- Consumes: `DEFAULT_PORT` from `src/web/protocol.ts` (C4) and P3's `localDashboardUrl(port)` (`src/web/links.ts`); `GatewayConfig` as P2/P3 left it (`chat`, `remoteAccess`).
- Produces:
  - Schema keys: `proactive: { enabled?: boolean; activeHours: { start: string; end: string }; everyHours: number /* int 1–24 */; maxPerDay: number /* int 0–3 */ }`, `newProjectsDir?: string`, and `removedProjectPaths: string[]` (default `[]`, real paths of projects the owner removed).
  - `export const PROACTIVE_DEFAULTS = { activeHours: { start: "09:00", end: "21:00" }, everyHours: 4, maxPerDay: 1 } as const`
  - `export type ProactiveConfig = GatewayConfig["proactive"]`
  - `export function proactiveEnabled(config: GatewayConfig, telegramConnected: boolean): boolean`
  - `export function newProjectsDirOf(config: GatewayConfig, userHome: string): string` (resolves `~/`; the default is `join(userHome, "Projects")`)
  - `export function dashboardLink(config: Pick<GatewayConfig, "webPort">, route?: string): string`: P3's `localDashboardUrl(config.webPort ?? DEFAULT_PORT)` plus `#/<route>` when a route is given (so every printed link stays `http://localhost`)

- [ ] **Step 1: Write the failing tests**

```ts
// src/gateway/config.test.ts (add)
test("proactive defaults are C8's; enabled unset follows Telegram", async () => {
  const c = await loadGatewayConfig(home); // no file
  expect(c.proactive).toEqual({ activeHours: { start: "09:00", end: "21:00" }, everyHours: 4, maxPerDay: 1 });
  expect(proactiveEnabled(c, false)).toBe(false);
  expect(proactiveEnabled(c, true)).toBe(true);
  expect(proactiveEnabled({ ...c, proactive: { ...c.proactive, enabled: false } }, true)).toBe(false);
  expect(c.removedProjectPaths).toEqual([]);
});
test("bad proactive values are refused naming the key", async () => {
  await writeFile(gatewayConfigPath(home), JSON.stringify({ proactive: { activeHours: { start: "25:00", end: "21:00" } } }));
  await expect(loadGatewayConfig(home)).rejects.toThrow("proactive.activeHours.start");
});
test("newProjectsDir defaults to ~/Projects and expands ~", () => {
  const base = gatewayConfigSchema.parse({});
  expect(newProjectsDirOf(base, "/u")).toBe("/u/Projects");
  expect(newProjectsDirOf({ ...base, newProjectsDir: "~/Code" }, "/u")).toBe("/u/Code");
});
// src/gateway/dashboard-link.test.ts
test("links to the fixed port or the configured one", () => {
  expect(dashboardLink({})).toBe("http://localhost:4317/");
  expect(dashboardLink({ webPort: 5000 }, "settings/autonomy")).toBe("http://localhost:5000/#/settings/autonomy");
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `bun test src/gateway/config.test.ts src/gateway/dashboard-link.test.ts`
Expected: FAIL (`proactiveEnabled` is not exported, and `dashboard-link` does not exist).

- [ ] **Step 3: Implement the schema keys and the three helpers**

Times use the regex `/^([01]\d|2[0-3]):[0-5]\d$/` with the message "a time like 09:00". `proactive` gets `.default({...PROACTIVE_DEFAULTS})`.

- [ ] **Step 4: Run the tests and confirm they pass, then typecheck**

Run: `bun test src/gateway/config.test.ts src/gateway/dashboard-link.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Stage**

```bash
git add src/gateway/config.ts src/gateway/config.test.ts src/gateway/dashboard-link.ts src/gateway/dashboard-link.test.ts
```

---

### Task 2: Projects register themselves; create, rename and fuzzy match

**Files:**
- Modify: `src/gateway/projects.ts`, `src/cli/main.tsx` (interactive branch only), `src/cli/runtime.ts` (`createRuntime` init)
- Create: `src/gateway/project-match.ts`
- Test: `src/gateway/projects.test.ts`, `src/gateway/project-match.test.ts`, `src/cli/runtime.test.ts`

**Interfaces:**
- Consumes: Task 1 (`removedProjectPaths`, `newProjectsDirOf`); the existing `addProject`, `removeProject`, `workspaceProblem` and `hostGitInit`.
- Produces:
  - `removeProject` also appends the project's real path to `removedProjectPaths`. `addProject` (explicit) removes the path from that list.
  - `export async function renameProject(home: string, id: string, name: string): Promise<Project>` (id unchanged; name 1–80 chars after trim).
  - `export async function createProject(home: string, name: string, deps?: ProjectDeps & { git?: (dir: string) => Promise<void> }): Promise<Project>`
  - `export async function findRepoRoot(dir: string, stopAt: string): Promise<string | undefined>` (walks up to find a `.git` file or folder and never returns `stopAt` or anything above it)
  - `export async function autoRegisterProject(home: string, cwd: string, deps?: { userHome?: string }): Promise<Project | undefined>` (returns the project only when it was just added)
  - `export function matchProjects(query: string, projects: Project[]): { match?: Project; candidates: Project[] }`
  - `createRuntime` init gains `startNotices?: string[]`, which `start(notice)` shows as `info`.

- [ ] **Step 1: Write the failing tests**

```ts
// src/gateway/projects.test.ts (add); repos made with makeRepo() from src/snapshots/test-repo.ts
test("tcode in a repo subfolder registers the repo root once, named after its folder", async () => {
  const repo = await makeRepo(); await mkdir(join(repo, "src"));
  const added = await autoRegisterProject(home, join(repo, "src"), { userHome });
  expect(added).toMatchObject({ path: repo, name: basename(repo) });
  expect(await autoRegisterProject(home, repo, { userHome })).toBeUndefined();
});
test("a removed project is not re-added, even through a symlink; adding it by hand clears that", async () => {
  const repo = await makeRepo();
  const p = (await autoRegisterProject(home, repo, { userHome }))!;
  await removeProject(home, p.id);
  const link = join(await makeTmpDir(), "link"); await symlink(repo, link);
  expect(await autoRegisterProject(home, link, { userHome })).toBeUndefined();
  await addProject(home, { path: repo });
  expect((await loadGatewayConfig(home)).removedProjectPaths).toEqual([]);
});
test("not a repo, the default workspace and the home folder are never registered", async () => {
  expect(await autoRegisterProject(home, await makeTmpDir(), { userHome })).toBeUndefined();
  expect(await autoRegisterProject(home, defaultProjectPath(home), { userHome })).toBeUndefined();
});
test("createProject makes <newProjectsDir>/<name>, runs git init and registers it", async () => {
  const inits: string[] = [];
  const p = await createProject(home, "Space Game", { userHome, git: async (d) => void inits.push(d) });
  expect(p).toMatchObject({ id: "space-game", name: "Space Game", path: join(userHome, "Projects", "Space Game") });
  expect(inits).toEqual([p.path]);
  await mkdir(join(userHome, "Projects", "Busy"), { recursive: true });
  await writeFile(join(userHome, "Projects", "Busy", "x"), "");
  await expect(createProject(home, "Busy", { userHome })).rejects.toThrow("already exists");
});
test("renameProject keeps the id", async () => {
  const p = await addProject(home, { path: await makeRepo(), name: "old" });
  expect(await renameProject(home, p.id, "  New name ")).toMatchObject({ id: p.id, name: "New name" });
});
// src/gateway/project-match.test.ts
const P = (id: string, name = id) => ({ id, name, path: `/w/${id}` });
test("exact id or name wins, then a single substring, then a close typo", () => {
  const all = [P("default", "Default workspace"), P("tropos"), P("web-app", "Web App"), P("web-api")];
  expect(matchProjects("Web App", all).match?.id).toBe("web-app");
  expect(matchProjects("trop", all).match?.id).toBe("tropos");
  expect(matchProjects("tropso", all).match?.id).toBe("tropos");
  expect(matchProjects("web", all)).toEqual({ candidates: [all[2], all[3]] });
  expect(matchProjects("zzz", all)).toEqual({ candidates: [] });
});
// src/cli/runtime.test.ts (add)
test("start shows the start notices as info", async () => {
  const seen: string[] = [];
  const rt = await createRuntime(ctx, { ...init, startNotices: ["Added this repo"] });
  await rt.start((level, text) => seen.push(`${level}:${text}`));
  expect(seen).toContain("info:Added this repo");
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `bun test src/gateway/projects.test.ts src/gateway/project-match.test.ts src/cli/runtime.test.ts`
Expected: FAIL (the new functions and `startNotices` are missing).

- [ ] **Step 3: Implement the registry functions in `src/gateway/projects.ts` and `matchProjects`**

- `autoRegisterProject` works like this. It finds the root with `findRepoRoot(cwd, userHome)` and takes its `realpath`. It skips the root when `workspaceProblem` objects, when the root is inside `home` (this covers the default workspace and `worktreesDir`), when the root is already registered, or when it is in `removedProjectPaths`. Otherwise it calls `addProject(home, { path: root }, { reuse: true })`. Errors are swallowed and return `undefined`, so `tcode` never fails to start because of this.
- `createProject` builds the folder name from `name.trim()` when it matches `/^[\w][\w .-]{0,79}$/`, and uses `slugify(name)` otherwise. An existing non-empty folder throws `ProjectError(\`${dir} already exists. Want me to add it as a project instead?\`)`. Then `mkdir -p`, `(deps.git ?? hostGitInit)(dir)`, `addProject`.
- `matchProjects` checks four things in order. (1) An exact id, or an exact name compared case-insensitively. (2) Normalized substrings (lowercase, alphanumerics only); one hit is the match and several hits are candidates. (3) Levenshtein distance ≤ 2 against the normalized id and name; again, one hit is the match. (4) Otherwise no candidates.

- [ ] **Step 4: Wire the terminal**

In `main.tsx`'s interactive TUI branch (not `-p` or gateway; P3 Task 4 removed the `--web` branch), before `createRuntime`, call `autoRegisterProject(home, cwd)`. When it returns a project, pass `startNotices: [\`Added this repo to your projects as "${p.id}", so chats can work on it too. Don't want it there? Ask me to remove it.\`]`.

- [ ] **Step 5: Run the tests and confirm they pass, then typecheck**

Run: `bun test src/gateway/projects.test.ts src/gateway/project-match.test.ts src/cli/runtime.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 6: Stage**

```bash
git add src/gateway/projects.ts src/gateway/projects.test.ts src/gateway/project-match.ts src/gateway/project-match.test.ts src/cli/main.tsx src/cli/runtime.ts src/cli/runtime.test.ts
```

---

### Task 3: Secrets never reach the model or the chat history

**Files:**
- Create: `src/tools/setup/secrets.ts`
- Modify: `src/cli/runtime.ts` (`AppContext.secrets`, `Runtime.sealSecrets`), `src/ui/runtime.ts` (`Runtime.sealSecrets`), `src/cli/context.ts` (`newSessionContext` gives each session a vault), `src/cli/main.tsx` (the terminal session's vault), `src/web/host.ts` (`prompt`), `src/ui/App.tsx` (TUI submit), `src/gateway/telegram/api.ts`, `src/gateway/telegram/adapter.ts`, `test/helpers/telegram-fake-server.ts`, `test/helpers/fake-runtime.ts`
- Test: `src/tools/setup/secrets.test.ts`, `src/web/host.test.ts`, `src/gateway/telegram/api.test.ts`, `src/gateway/telegram/adapter.test.ts`

**Interfaces:**
- Produces:
  - `export type SecretKind = "telegram-token" | "api-key"`
  - `export function findSecrets(text: string): { start: number; end: number; kind: SecretKind }[]`. The Telegram pattern is `/\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/`. The API-key pattern covers `sk-` (including `sk-ant-` and `sk-proj-`), `sk_`, `gsk_`, `xai-` and `AIza`, each with at least 20 more key characters.
  - `export class SecretVault { constructor(opts?: { now?: () => number }); seal(text: string): { text: string; sealed: number }; take(ref: string): { value: string; kind: SecretKind } | undefined; peek(ref: string): { kind: SecretKind } | undefined }`. Constants: `SECRET_TTL_MS = 30 * 60_000`, `MAX_SECRETS = 10`. Refs are `secret:<n>`. The placeholder text is exactly `[secret:<n>: a Telegram bot token, held by Tropos]` or `[secret:<n>: an API key, held by Tropos]`.
  - `AppContext.secrets?: SecretVault`. `Runtime.sealSecrets(text: string): string` returns the text unchanged when there is no vault.
  - `TelegramApi.deleteMessage(chatId: number | string, messageId: number): Promise<void>`
  - Adapter copy, exactly: `SECRET_REMOVED_NOTE = "I removed that message so the key doesn't stay in this chat. I'm holding it for this conversation only."`

- [ ] **Step 1: Write the failing tests**

```ts
// src/tools/setup/secrets.test.ts
const TOKEN = "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw1";
const KEY = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345";
test("seals every secret in a message and hands each out once", () => {
  const v = new SecretVault();
  const { text, sealed } = v.seal(`here: ${TOKEN} and ${KEY} thanks`);
  expect(sealed).toBe(2);
  expect(text).not.toContain(TOKEN); expect(text).not.toContain(KEY);
  expect(text).toContain("[secret:1: a Telegram bot token, held by Tropos]");
  expect(v.take("secret:1")).toEqual({ value: TOKEN, kind: "telegram-token" });
  expect(v.take("secret:1")).toBeUndefined();
});
test("held secrets expire after 30 minutes", () => {
  let t = 0; const v = new SecretVault({ now: () => t });
  v.seal(KEY); t = 30 * 60_000 + 1;
  expect(v.take("secret:1")).toBeUndefined();
});
// src/web/host.test.ts (add)
test("a prompt's secrets are sealed before the agent, the transcript and other tabs see them", async () => {
  const { host, runtime, otherTab } = await hostWithTwoTabs(); // existing helpers + FakeRuntime with a vault
  await host.call("prompt", { text: `token ${TOKEN}` });
  expect(runtime.lastAgentInput).not.toContain(TOKEN);
  expect(JSON.stringify(otherTab.received)).not.toContain(TOKEN);
});
// src/gateway/telegram/api.test.ts (add)
test("deleteMessage posts chat and message ids", async () => {
  await api.deleteMessage(42, 7);
  expect(server.deleted).toEqual([{ chatId: 42, messageId: 7 }]);
});
// src/gateway/telegram/adapter.test.ts (add)
test("an approved sender's message holding a key is deleted from the chat and still reaches the session", async () => {
  const { server, session } = await setup();
  server.pushMessage(CHAT, CHAT, `use ${TOKEN}`);
  await server.waitFor(() => server.deleted.length === 1);
  expect(server.textsTo(CHAT)).toContain(SECRET_REMOVED_NOTE);
  await server.waitFor(() => session()?.prompts.length === 1);
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `bun test src/tools/setup/secrets.test.ts src/web/host.test.ts src/gateway/telegram/api.test.ts src/gateway/telegram/adapter.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the vault, `sealSecrets`, `deleteMessage` and the adapter branch**

- `WebHost` `prompt` seals `text` (and `display`) with `r.sealSecrets` before broadcasting, recording input, P6's `directCall`/`runDirect` (an `@name` message), and calling `agent.run`.
- The TUI submit seals the text the same way.
- The fake server handles `deleteMessage` and records `deleted: { chatId: number; messageId: number }[]`.
- In `handleMessage`, after the approval check, call `findSecrets(text)`. When it finds anything, run `deleteMessage(chatId, msg.message_id)`, log any failure without the text, send the note, and continue as usual. Sealing happens in the host.

- [ ] **Step 4: Run the tests and confirm they pass, then typecheck**

Run: the Step 2 command, then `bun run typecheck`.
Expected: PASS.

- [ ] **Step 5: Stage**

```bash
git add src/tools/setup/secrets.ts src/tools/setup/secrets.test.ts src/cli/runtime.ts src/ui/runtime.ts src/cli/context.ts src/cli/main.tsx src/web/host.ts src/web/host.test.ts src/ui/App.tsx src/gateway/telegram/api.ts src/gateway/telegram/api.test.ts src/gateway/telegram/adapter.ts src/gateway/telegram/adapter.test.ts test/helpers/telegram-fake-server.ts test/helpers/fake-runtime.ts
```

---

### Task 4: Setup changes in the ledger, and asking the gateway to reload

**Files:**
- Modify: `src/learning/ledger.ts`, `src/cli/runtime.ts` (`undoLearned`, the `learned` panel), `src/ui/runtime.ts` (`PanelItem.undoable`), `web/src/app/pages/MemoryPage.tsx` (`LearnedRow`)
- Create: `src/gateway/reload-signal.ts`
- Test: `src/learning/ledger.test.ts`, `src/gateway/reload-signal.test.ts`, `src/cli/runtime.test.ts`, `web/src/app/pages/MemoryPage.test.tsx`

**Interfaces:**
- Consumes: `readConfigRaw`, `updateConfigFile`, `configFile`, `getAt`, `setAt`, `sameJson` and `stripSecrets` from `src/config/store.ts`; `readGatewayState` from `src/gateway/daemon.ts`.
- Produces:
  - `LedgerKind` gains `"setup"`. `LedgerEntry` and `LedgerRecord` gain `configPath?: string` (a dotted path in the file) and `noUndo?: string` (the reason shown when undo refuses).
  - `isLearnedPath(home, "setup", p)` is true exactly for `<home>/settings.json` and `<home>/gateway.json`.
  - `export async function recordSetupChange(ledger: Ledger, r: { actor: Actor; path: string; configPath?: string; action: string; summary: string; before?: unknown; after?: unknown; noUndo?: string }): Promise<LedgerEntry>`. It stores `JSON.stringify(stripSecrets(v) ?? null)` as each blob. It sets `noUndo = "It held a secret, which Tropos never copies into the ledger."` when `stripSecrets(before)` differs from `before`.
  - `Ledger.undo` on a `setup` entry works like this. With `noUndo`, it returns `{ ok: false, reason: noUndo }`. Otherwise it reads the file. When `stripSecrets(getAt(current, configPath))` is not the same JSON as the `after` blob, it refuses with "It changed since; nothing was undone." When they match, it writes `before` (`null` removes the key) through `updateConfigFile`.
  - `export const RELOAD_SIGNAL = "SIGUSR2"`
  - `export async function requestGatewayReload(home: string, kill?: (pid: number, signal: string) => void): Promise<boolean>`
  - `export function onReloadSignal(handler: () => void): () => void`
  - `PanelItem.undoable?: boolean`. The `learned` panel sets it to `false` for `noUndo` entries and puts the reason in `detail`.

- [ ] **Step 1: Write the failing tests**

```ts
// src/learning/ledger.test.ts (add)
test("a setup change undoes at value level and refuses once the value moved on", async () => {
  await writeFile(join(home, "gateway.json"), JSON.stringify({ proactive: { enabled: false } }));
  const e = await recordSetupChange(ledger, { actor: "agent", path: join(home, "gateway.json"), configPath: "proactive.enabled", action: "proactive.set", summary: "proactive off", before: true, after: false });
  expect((await ledger.undo(e.id)).ok).toBe(true);
  expect(JSON.parse(await readFile(join(home, "gateway.json"), "utf8")).proactive.enabled).toBe(true);
  const e2 = await recordSetupChange(ledger, { actor: "agent", path: join(home, "gateway.json"), configPath: "proactive.enabled", action: "x", summary: "x", before: true, after: false });
  expect(await ledger.undo(e2.id)).toEqual({ ok: false, reason: "It changed since; nothing was undone." });
});
test("secrets never reach the blobs, and such a change cannot be undone", async () => {
  const e = await recordSetupChange(ledger, { actor: "agent", path: join(home, "gateway.json"), configPath: "telegram", action: "telegram.connect", summary: "Telegram connected", before: {}, after: { botToken: TOKEN } });
  for (const f of await readdir(join(home, "learning", "blobs"))) expect(await readFile(join(home, "learning", "blobs", f), "utf8")).not.toContain(TOKEN);
  const removed = await recordSetupChange(ledger, { actor: "agent", path: join(home, "settings.json"), configPath: "mcpServers.gh", action: "mcp.remove", summary: "x", before: { command: "x", env: { T: "v" } }, after: null });
  expect(removed.noUndo).toContain("secret");
});
test("an entry recorded noUndo refuses with its reason", async () => {
  const e = await recordSetupChange(ledger, { actor: "agent", path: join(home, "gateway.json"), action: "autonomy.lower", summary: "autonomy ask", noUndo: "Raise autonomy in Settings → Autonomy." });
  expect(await ledger.undo(e.id)).toEqual({ ok: false, reason: "Raise autonomy in Settings → Autonomy." });
});
// src/gateway/reload-signal.test.ts
test("signals the running gateway's pid", async () => {
  await writeGatewayStateForTest(home, { pid: 4242 });
  const sent: unknown[] = [];
  expect(await requestGatewayReload(home, (p, s) => sent.push([p, s]))).toBe(true);
  expect(sent).toEqual([[4242, "SIGUSR2"]]);
  expect(await requestGatewayReload(join(home, "none"), () => {})).toBe(false);
  expect(await requestGatewayReload(home, () => { throw Object.assign(new Error(), { code: "ESRCH" }); })).toBe(false);
});
// src/cli/runtime.test.ts (add)
test("undoing a setup change asks the gateway to reload; noUndo entries show as not undoable", async () => {
  /* state.json pid = process.pid; onReloadSignal(() => hits++); undoLearned(id) → hits === 1;
     panel("learned").sections[0].items.find(noUndo entry).undoable === false */
});
// web/src/app/pages/MemoryPage.test.tsx (add)
test("a learned row that can't be undone shows its reason and no Undo button", async () => { /* item { undoable: false, detail: [..., "Raise autonomy in Settings → Autonomy."] } */ });
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `bun test src/learning/ledger.test.ts src/gateway/reload-signal.test.ts src/cli/runtime.test.ts web/src/app/pages/MemoryPage.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

- `requestGatewayReload` reads `readGatewayState(home)?.pid` and sends `RELOAD_SIGNAL`. `ESRCH` or no state returns `false`.
- `runtime.undoLearned` calls `requestGatewayReload(ctx.home)` after an `ok` undo of a `setup` entry.
- `LearnedRow` hides Undo when `item.undoable === false` and renders the last detail line as the reason.

- [ ] **Step 4: Run the tests and confirm they pass, then typecheck**

Run: the Step 2 command, then `bun run typecheck`.
Expected: PASS.

- [ ] **Step 5: Stage**

```bash
git add src/learning/ledger.ts src/learning/ledger.test.ts src/gateway/reload-signal.ts src/gateway/reload-signal.test.ts src/cli/runtime.ts src/cli/runtime.test.ts src/ui/runtime.ts web/src/app/pages/MemoryPage.tsx web/src/app/pages/MemoryPage.test.tsx
```

---

### Task 5: Admin methods the setup tool and Settings need

**Files:**
- Modify: `src/web/admin/api.ts`, `src/web/admin/projects.ts`, `src/web/admin/extensions.ts`, `src/web/admin/index.ts`
- Create: `src/web/admin/proactive.ts`
- Test: `src/web/admin/projects.test.ts`, `src/web/admin/extensions.test.ts`, `src/web/admin/proactive.test.ts`

**Interfaces:**
- Consumes: Task 1 (`proactiveEnabled`, `newProjectsDirOf`, `PROACTIVE_DEFAULTS`); Task 2 (`renameProject`); `updateConfigFile(gatewayFile(home), …)`.
- Produces (in `api.ts` and `ADMIN_METHODS`):
  - `"projects.rename": { params: { id: string; name: string }; result: ProjectView }`
  - `"mcp.setEnabled": { params: { name: string; enabled: boolean }; result: McpServerView[] }`. This sets or unsets `mcpServers.<name>.disabled`.
  - `export interface ProactiveView { enabled: boolean; explicit: boolean; telegram: boolean; activeHours: { start: string; end: string }; everyHours: number; maxPerDay: number; newProjectsDir: string }`. Here `newProjectsDir` is resolved.
  - `export type ProactivePatch = { enabled?: boolean | null; activeHours?: { start: string; end: string }; everyHours?: number; maxPerDay?: number; newProjectsDir?: string | null }`. A `null` value goes back to the default.
  - `ProactiveAdmin`: `"proactive.get": { params: undefined; result: ProactiveView }` and `"proactive.set": { params: ProactivePatch; result: ProactiveView }`. Every change calls `ctx.gateway?.reload()`.

- [ ] **Step 1: Write the failing tests**

```ts
// src/web/admin/proactive.test.ts
test("off without Telegram, on by default once a token exists, explicit off wins", async () => {
  const admin = createAdmin(ctxFor(home));
  expect(await admin.handle("proactive.get", undefined)).toMatchObject({ enabled: false, explicit: false, telegram: false, everyHours: 4, maxPerDay: 1, activeHours: { start: "09:00", end: "21:00" }, newProjectsDir: join(userHome, "Projects") });
  await writeFile(join(home, "gateway.json"), JSON.stringify({ telegram: { botToken: TOKEN } }));
  expect(await admin.handle("proactive.get", undefined)).toMatchObject({ enabled: true, explicit: false });
  expect(await admin.handle("proactive.set", { enabled: false })).toMatchObject({ enabled: false, explicit: true });
  expect(await admin.handle("proactive.set", { enabled: null })).toMatchObject({ enabled: true, explicit: false });
});
test("refuses bad hours and keeps the file as it was", async () => {
  await expect(admin.handle("proactive.set", { activeHours: { start: "9", end: "21:00" } })).rejects.toThrow("proactive.activeHours.start");
});
// src/web/admin/projects.test.ts (add): rename returns the view with the new name.
// src/web/admin/extensions.test.ts (add): setEnabled false writes disabled: true, true removes it, unknown name → AdminError.
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `bun test src/web/admin/proactive.test.ts src/web/admin/projects.test.ts src/web/admin/extensions.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the handlers and register `proactiveHandlers(ctx)` in `createAdmin`**

`telegram` is `Boolean(telegramToken(config, ctx.env))`. `ConfigStoreError` becomes `AdminError` with its message.

- [ ] **Step 4: Run the tests and confirm they pass, then typecheck**

Run: the Step 2 command, then `bun run typecheck`.
Expected: PASS.

- [ ] **Step 5: Stage**

```bash
git add src/web/admin/api.ts src/web/admin/projects.ts src/web/admin/projects.test.ts src/web/admin/extensions.ts src/web/admin/extensions.test.ts src/web/admin/proactive.ts src/web/admin/proactive.test.ts src/web/admin/index.ts
```

---

### Task 6: `TroposSetup`: the matrix, the preview and the configuration actions

**Files:**
- Create: `src/tools/setup/matrix.ts`, `src/tools/setup/describe.ts`, `src/tools/setup/autonomy.ts`, `src/tools/setup/setup-tool.ts`, `src/tools/setup/session-admin.ts`
- Modify: `src/agent/subagent.ts` (`filterTools`), `src/gateway/policy.ts` (`ALWAYS_ASK`)
- Test: `src/tools/setup/matrix.test.ts`, `src/tools/setup/describe.test.ts`, `src/tools/setup/autonomy.test.ts`, `src/tools/setup/setup-tool.test.ts`, `src/agent/subagent.test.ts`, `src/gateway/policy.test.ts`

**Interfaces:**
- Consumes: C1 `SessionRole`; C3 `Autonomy`, `effectiveAutonomy`, `canRaise`; P2's `lowerAutonomy(home, projectId, to)` and `AutonomyError` (`src/gateway/autonomy.ts`); P6's `HUB_ONLY_TOOLS` (`src/agent/subagent.ts`); Task 2 (`createProject`); Task 3 (`SecretVault`); Task 4 (`recordSetupChange`, `requestGatewayReload`); Task 5 (admin methods); `createAdmin`/`Admin` from `src/web/admin/index.ts`; `dashboardLink`.
- Produces:
  - `export const SETUP_ACTIONS = ["telegram.connect", "telegram.disconnect", "project.add", "project.create", "project.rename", "project.remove", "project.default", "model.set", "provider.connect", "mcp.add", "mcp.enable", "mcp.disable", "proactive.set", "autonomy.lower", "doctor.run", "doctor.fix", "service.restart", "tropos.update"] as const; export type SetupAction = (typeof SETUP_ACTIONS)[number]`
  - `export interface SetupWho { role: SessionRole; origin: "local" | "channel" }`
  - `export function setupDecision(action: SetupAction, who: SetupWho): { ok: true } | { ok: false; reason: string }`
  - `export type SetupState = { settings: Record<string, unknown>; gateway: Record<string, unknown> }` and `export function readSetupState(home: string): SetupState` (a sync read; an unreadable file is `{}`)
  - `export function describeSetupChange(input: SetupInput, state: SetupState): PermissionPreview`
  - `export async function lowerSetupAutonomy(home: string, to: Autonomy, projectId?: string): Promise<{ before: Autonomy; after: Autonomy }>`, built on P2's `lowerAutonomy(home, projectId, to)` (a different function; P2's name and signature stay). With a `projectId`, it calls P2's `lowerAutonomy(home, projectId, to)` for that project only. Without one, it calls `lowerAutonomy(home, DEFAULT_PROJECT_ID, to)` (which lowers `chat.autonomy`) and then `lowerAutonomy(home, id, to)` for every project whose own `autonomy` is higher than `to`. P2's `AutonomyError` (a raise) becomes `SetupRefused` with the dashboard pointer.
  - `export class SetupRefused extends Error {}`
  - `export interface SetupToolDeps { home: string; userHome: string; who: SetupWho; admin: Admin; ledger: Ledger; reload: () => Promise<unknown>; secrets?: SecretVault; providers?: ProviderControl; chatKey?: string; selectProject?: (id: string) => Promise<void>; inGateway?: boolean; restartDelayMs?: number; setTimer?: (fn: () => void, ms: number) => unknown }`
  - `export function createSetupTool(deps: SetupToolDeps): AnyTool`. The name is `"TroposSetup"` and the kind is `"exec"`. The subject is `{ paths: [], target: \`setup:${action}\` }`.
  - `export function sessionAdmin(home: string, env: NodeJS.ProcessEnv, userHome: string): Admin`. This is `createAdmin` with `gateway.reload = () => requestGatewayReload(home)` and P3 Task 6's `gateway.devicesChanged` set the same way, for sessions outside the gateway process.
  - Input schema (flat, like Cron): `action`, `project?`, `name?`, `path?`, `model?`, `effort?`, `provider?`, `secret?`, `server?: { type?: "stdio" | "http" | "sse"; command?: string; args?: string[]; url?: string; env?: Record<string, string> }`, `enabled?`, `activeHours?`, `everyHours?`, `maxPerDay?`, `level?: Autonomy`, `finding?`.
  - P6's `HUB_ONLY_TOOLS` (`src/agent/subagent.ts`) gains `"TroposSetup"`, so `filterTools` never passes it to any subagent or specialist. Tasks 8 and 11 add `"SwitchProject"` and `"Suggestion"`.
  - `ALWAYS_ASK` in `policy.ts` gains `"TroposSetup"`, so a chat asks for it at every autonomy level.

- [ ] **Step 1: Write the failing tests**

```ts
// src/tools/setup/matrix.test.ts
const LOCAL = { role: "owner", origin: "local" } as const, CHAT = { role: "owner", origin: "channel" } as const;
test("the owner may do every action locally; in a chat the doctor is read-only", () => {
  for (const a of SETUP_ACTIONS) expect(setupDecision(a, LOCAL).ok).toBe(true);
  for (const a of SETUP_ACTIONS) expect(setupDecision(a, CHAT).ok).toBe(a !== "doctor.fix");
});
test("guests and scheduled runs may do nothing", () => {
  for (const role of ["guest", "scheduled"] as const) for (const a of SETUP_ACTIONS) for (const origin of ["local", "channel"] as const)
    expect(setupDecision(a, { role, origin })).toEqual({ ok: false, reason: "Only the owner can change Tropos's setup." });
});
// src/tools/setup/describe.test.ts
test("the preview shows before → after and an MCP server's full command", () => {
  const s = { settings: { model: "anthropic/claude-opus-5-5" }, gateway: {} };
  expect(describeSetupChange({ action: "model.set", model: "openai/gpt-5" }, s).text).toContain("model: anthropic/claude-opus-5-5 → openai/gpt-5");
  const mcp = describeSetupChange({ action: "mcp.add", name: "gh", server: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], env: { GITHUB_TOKEN: "secret:2" } } }, s).text;
  expect(mcp).toContain("command: npx -y @modelcontextprotocol/server-github");
  expect(mcp).toContain("env: GITHUB_TOKEN=(secret:2)");
  expect(describeSetupChange({ action: "proactive.set", enabled: false }, { settings: {}, gateway: { telegram: { botToken: "x" } } }).text).toContain("proactive messages: on → off");
});
// src/tools/setup/autonomy.test.ts
test("lowering globally clamps project overrides; raising is refused with the dashboard pointer", async () => {
  await writeGateway(home, { chat: { autonomy: "balanced", backend: "host" }, projects: [{ id: "app", name: "app", path: "/w/app", autonomy: "autonomous" }] });
  expect(await lowerSetupAutonomy(home, "ask")).toEqual({ before: "balanced", after: "ask" });
  expect((await loadGatewayConfig(home)).projects[0]!.autonomy).toBe("ask");
  await expect(lowerSetupAutonomy(home, "autonomous")).rejects.toThrow("Settings → Autonomy");
});
// src/tools/setup/setup-tool.test.ts — fake Admin records calls: { handle: async (m, p) => (calls.push([m, p]), answers[m]?.(p)), methods: () => [] }
test("is an exec tool named TroposSetup that targets setup:<action>", () => {
  const t = createSetupTool(deps());
  expect([t.name, toolKind(t)]).toEqual(["TroposSetup", "exec"]);
  expect(t.subject({ action: "model.set" }, "/x")).toEqual({ paths: [], target: "setup:model.set" });
});
test("a guest's call is refused before anything runs", async () => {
  const out = await createSetupTool(deps({ who: { role: "guest", origin: "channel" } })).run({ action: "model.set", model: "m" }, makeToolContext());
  expect(out.isError).toBe(true); expect(calls).toEqual([]);
});
test("model.set writes through config.set and records an undoable ledger entry", async () => {
  await tool.run({ action: "model.set", model: "openai/gpt-5" }, makeToolContext());
  expect(calls).toContainEqual(["config.set", { file: "settings", path: "model", value: "openai/gpt-5" }]);
  const [entry] = await ledger.list(1);
  expect(entry).toMatchObject({ kind: "setup", configPath: "model", actor: "agent" });
  expect(entry!.noUndo).toBeUndefined();
});
test("autonomy.lower is recorded but can never be undone (undo would raise it)", async () => {
  await tool.run({ action: "autonomy.lower", level: "ask" }, makeToolContext());
  const [entry] = await ledger.list(1);
  expect((await ledger.undo(entry!.id)).ok).toBe(false);
});
test("project.create in a chat registers the folder and switches the chat to it", async () => {
  const selected: string[] = [];
  await createSetupTool(deps({ who: CHAT, chatKey: "telegram:1", selectProject: async (id) => void selected.push(id) })).run({ action: "project.create", name: "Space Game" }, makeToolContext());
  expect(selected).toEqual(["space-game"]);
});
// src/agent/subagent.test.ts (add)
test("no subagent or specialist ever gets TroposSetup", () => {
  expect(filterTools([tool("Read"), tool("TroposSetup")], { tools: ["*"] }).map((t) => t.name)).toEqual(["Read"]);
});
// src/gateway/policy.test.ts (add)
test("a chat always asks before TroposSetup", () => {
  expect(decide({ toolName: "TroposSetup", kind: "exec", paths: [], target: "setup:model.set" }, permsOf(channelContext(base, backend, { role: "owner" }))).behavior).toBe("ask");
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `bun test src/tools/setup src/agent/subagent.test.ts src/gateway/policy.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the matrix, the preview, `lowerSetupAutonomy`, `sessionAdmin` and the tool's configuration actions**

- **Flow of `run`.** `setupDecision` comes first, and a refusal returns `isError`. The tool snapshots `readConfigRaw` of the touched file(s) and runs the action. It then records one `recordSetupChange` per changed dotted path, with `actor: ctx.actor ?? "agent"`. Results never contain a secret, and `scrub` from `src/web/admin/util.ts` is applied to every error.
- **Actions and the paths they touch.**
  - `project.add` → `projects.add`; `project.rename` → `projects.rename`; `project.remove` → `projects.remove` (all touch `projects`).
  - `project.default` → `projects.setDefault` (`defaultProject`).
  - `project.create` → `createProject` + `reload`, then `selectProject` when a `chatKey` is set (`projects`).
  - `model.set` → `config.set` for `model` and/or `effort`, each recorded separately.
  - `mcp.add` → `mcp.add` (`mcpServers.<name>`). Env values written `secret:<n>` are resolved with `secrets.take`. A ref that is unknown or expired gives "Send that key again; I only hold it for 30 minutes."
  - `mcp.enable`/`mcp.disable` → `mcp.setEnabled` (`mcpServers.<name>.disabled`).
  - `proactive.set` → `proactive.set` (`proactive`).
  - `autonomy.lower` → `lowerSetupAutonomy`, recorded with `noUndo: \`Raise autonomy in Settings → Autonomy: ${dashboardLink(cfg, "settings/autonomy")}\``.
- **Copy for things the tool must not do** (raising autonomy, the ✗ row): `\`I can't do that from here. Open ${dashboardLink(cfg, "settings")} to change it.\``.
- **Model change result:** "Saved: new sessions use X. This conversation keeps its current model until you start a new one (/new)."
- **Tool description.** It lists the actions and says when to use the tool. It also states that secrets are passed as the `secret:<n>` refs from the conversation.

- [ ] **Step 4: Run the tests and confirm they pass, then typecheck**

Run: `bun test src/tools/setup src/agent/subagent.test.ts src/gateway/policy.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Stage**

```bash
git add src/tools/setup src/agent/subagent.ts src/agent/subagent.test.ts src/gateway/policy.ts src/gateway/policy.test.ts
```

---

### Task 7: `TroposSetup`: Telegram, provider keys, doctor, restart and update

**Files:**
- Modify: `src/tools/setup/setup-tool.ts`
- Test: `src/tools/setup/setup-tool.test.ts`

**Interfaces:**
- Consumes: Task 6 (`createSetupTool`, `SetupToolDeps`); Task 3 (`SecretVault.take`); the admin `channels.telegram.set/clear`, `doctor.run`, `doctor.fix`, `service.status`, `service.restart` and `update.run`; `ProviderControl.connect`/`models`/`disconnect`.
- Produces: the remaining actions.
  - `secret` holds a ref (`secret:<n>`) or, as a fallback for a key format the vault did not recognise, the raw value. A raw value is already in the transcript, so it is accepted but never repeated.
  - `telegram.connect` and `provider.connect` are recorded with `noUndo: "Disconnect it instead."`.
  - `doctor.fix`, `service.restart` and `tropos.update` are recorded with `noUndo: "This can't be undone."`.
  - `doctor.run` is not recorded.

- [ ] **Step 1: Write the failing tests**

```ts
test("telegram.connect takes the sealed token, never shows it, and is not undoable", async () => {
  const v = new SecretVault(); v.seal(TOKEN);
  const out = await createSetupTool(deps({ secrets: v })).run({ action: "telegram.connect", secret: "secret:1" }, makeToolContext());
  expect(calls).toContainEqual(["channels.telegram.set", { token: TOKEN }]);
  expect(JSON.stringify(out)).not.toContain(TOKEN);
  expect(v.peek("secret:1")).toBeUndefined();
  expect((await ledger.list(1))[0]!.noUndo).toBe("Disconnect it instead.");
});
test("an expired or unknown ref asks for the token again", async () => {
  const out = await tool.run({ action: "telegram.connect", secret: "secret:9" }, makeToolContext());
  expect(out).toMatchObject({ isError: true }); expect(String(out.content)).toContain("Send that key again");
});
test("provider.connect checks the key by listing models and removes a rejected one", async () => {
  providers.models = async () => { throw new Error("401"); };
  const out = await tool.run({ action: "provider.connect", provider: "anthropic", secret: "secret:1" }, makeToolContext());
  expect(out.isError).toBe(true); expect(providers.disconnected).toEqual(["anthropic"]);
});
test("doctor.run never fixes; doctor.fix runs one finding locally", async () => {
  await tool.run({ action: "doctor.run" }, makeToolContext());
  expect(calls).toContainEqual(["doctor.run", { fix: false }]);
  await tool.run({ action: "doctor.fix", finding: "config.drift" }, makeToolContext());
  expect(calls).toContainEqual(["doctor.fix", { id: "config.drift" }]);
});
test("inside the gateway, restart answers first and restarts after the delay", async () => {
  const timers: [() => void, number][] = [];
  const out = await createSetupTool(deps({ inGateway: true, restartDelayMs: 3000, setTimer: (fn, ms) => timers.push([fn, ms]) })).run({ action: "service.restart" }, makeToolContext());
  expect(String(out.content)).toContain("Restarting");
  expect(calls.some(([m]) => m === "service.restart")).toBe(false);
  timers[0]![0](); await Bun.sleep(0);
  expect(calls.some(([m]) => m === "service.restart")).toBe(true);
});
test("tropos.update runs the update and restarts a running service", async () => {
  answers["update.run"] = () => ({ ok: true, from: "0.4.1", to: "0.5.0", message: "Updated." });
  answers["service.status"] = () => ({ manager: "launchd", installed: true, running: true });
  await tool.run({ action: "tropos.update" }, makeToolContext());
  expect(calls.map(([m]) => m)).toEqual(expect.arrayContaining(["update.run", "service.restart"]));
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `bun test src/tools/setup/setup-tool.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the six actions**

- `telegram.disconnect` → `channels.telegram.clear`. In a chat, its preview adds: "You won't reach me on Telegram until it's connected again."
- A restart when the service isn't installed returns `\`The background service isn't installed. Open ${dashboardLink(cfg, "settings")} to install it.\``.
- `restartDelayMs` defaults to 3000 inside the gateway and to 0 elsewhere.

- [ ] **Step 4: Run the tests and confirm they pass, then typecheck**

Run: `bun test src/tools/setup/setup-tool.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Stage**

```bash
git add src/tools/setup/setup-tool.ts src/tools/setup/setup-tool.test.ts
```

---

### Task 8: Wire the tools into sessions; switch projects by name; "ask me to …" copy

**Files:**
- Create: `src/tools/setup/switch-project-tool.ts`, `src/gateway/session-tools.ts`
- Modify: `src/cli/main.tsx`, `src/gateway/daemon.ts`, `src/gateway/telegram/adapter.ts`, `src/agent/subagent.ts`, `src/context/system-prompt.ts`, `src/gateway/commands.ts`, `src/gateway/projects.ts` (README text), `src/cli/runtime.ts` (empty text of the MCP panel)
- Test: `src/tools/setup/switch-project-tool.test.ts`, `src/gateway/session-tools.test.ts`, `src/gateway/telegram/adapter.test.ts`, `src/gateway/daemon.test.ts`, `src/gateway/commands.test.ts`, `src/context/system-prompt.test.ts`, `src/cli/runtime.test.ts`

**Interfaces:**
- Consumes: Tasks 2, 4, 6 and 7; `ChatProjects`; C1 `role`.
- Produces:
  - `export function createSwitchProjectTool(deps: { chatKey: string; projects: ChatProjects }): AnyTool`. The name is `"SwitchProject"`, the kind is `"meta"`, and the input is `{ project: string }`.
  - `export function chatSessionTools(base: AnyTool[], o: { role: SessionRole; chatKey?: string; cron?: () => AnyTool; setup?: () => AnyTool; projects?: ChatProjects }): AnyTool[]`. The rules are:
    - Cron goes to real chats (not `project:*` keys or `heartbeat:` keys); the `cron` factory builds P1 Task 10's role-specific Cron tool (`seeAll` for the owner).
    - `TroposSetup` goes only when `role === "owner"`.
    - `SwitchProject` goes to every `telegram:` chat.
  - P6's `HUB_ONLY_TOOLS` gains `"SwitchProject"`.
  - The daemon reloads on `RELOAD_SIGNAL`: `onReloadSignal(reload)` uses the in-process reload that P1 made real for `gateway.reload`.
  - The adapter's `Chat` gains `projectId`. After each turn, a chat whose `projects.current(key)` changed is detached, so the next message opens the new project's session.

- [ ] **Step 1: Write the failing tests**

```ts
// src/tools/setup/switch-project-tool.test.ts
test("switches on a clear match, lists candidates when ambiguous, and never switches on a miss", async () => {
  const { projects, chosen } = fakeChatProjects([P("default"), P("web-app"), P("web-api"), P("tropos")]);
  const t = createSwitchProjectTool({ chatKey: "telegram:1", projects });
  expect(String((await t.run({ project: "trop" }, makeToolContext())).content)).toContain("Switched to tropos");
  expect(chosen.get("telegram:1")).toBe("tropos");
  const amb = await t.run({ project: "web" }, makeToolContext());
  expect(String(amb.content)).toContain("web-app"); expect(String(amb.content)).toContain("web-api");
  expect(chosen.get("telegram:1")).toBe("tropos");
});
// src/gateway/session-tools.test.ts
test("owner chats get TroposSetup and SwitchProject; guests only SwitchProject; scheduled runs neither", () => {
  const names = (o: Parameters<typeof chatSessionTools>[1]) => chatSessionTools([], o).map((t) => t.name);
  const tools = { cron: () => tool("Cron"), setup: () => tool("TroposSetup"), projects: fakeProjects };
  expect(names({ role: "owner", chatKey: "telegram:1", ...tools })).toEqual(["Cron", "TroposSetup", "SwitchProject"]);
  expect(names({ role: "guest", chatKey: "telegram:2", ...tools })).toEqual(["Cron", "SwitchProject"]);
  expect(names({ role: "scheduled", chatKey: "project:app", ...tools })).toEqual([]);
});
// src/gateway/telegram/adapter.test.ts (add)
test("a project switched during a turn takes effect on the next message", async () => {
  const { projects, chosen } = fakeProjects();
  const { server, sessions } = await setup({ projects });
  sessions.onPrompt = async (_t, s) => { chosen.set(`telegram:${CHAT}`, "app"); s.emit({ type: "turn_end", reason: "end_turn" }); return "end_turn"; };
  server.pushMessage(CHAT, CHAT, "work on app"); await server.waitFor(() => sessions.opens === 1);
  server.pushMessage(CHAT, CHAT, "next"); await server.waitFor(() => sessions.opens === 2);
});
// src/gateway/commands.test.ts (add)
test("gateway install without a bot says to ask me, not to edit gateway.json", async () => {
  const out = await runInstall(); expect(out).toContain("ask me to connect Telegram"); expect(out).not.toContain("gateway.json");
});
// src/gateway/daemon.test.ts (add)
test("startup without a channel offers to connect Telegram with the dashboard link", async () => { /* output contains "ask me to connect Telegram" and "http://localhost:" */ });
test("SIGUSR2 reloads the gateway: a token written after start brings Telegram up", async () => { /* write telegram.botToken, process.kill(process.pid, "SIGUSR2"), fake API sees getUpdates */ });
// src/context/system-prompt.test.ts (add)
test("the prompt routes setup through TroposSetup and never to the config files", () => {
  expect(SYSTEM_PROMPT).toContain("TroposSetup");
  expect(SYSTEM_PROMPT).toContain("never edit settings.json or gateway.json yourself");
});
// src/cli/runtime.test.ts (add): the empty MCP panel says "Ask me to add one" and has no "settings.json".
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `bun test src/tools/setup/switch-project-tool.test.ts src/gateway/session-tools.test.ts src/gateway/telegram/adapter.test.ts src/gateway/daemon.test.ts src/gateway/commands.test.ts src/context/system-prompt.test.ts src/cli/runtime.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the wiring**

- **Terminal (`main.tsx`).** For an interactive or print session with `ctx.role === "owner"`, push `createSetupTool({ who: { role: ctx.role, origin: "local" }, admin: sessionAdmin(home, env, homedir()), ledger: ext.ledger, reload: () => requestGatewayReload(home), secrets: ctx.secrets, providers: router, home, userHome: homedir() })`.
- **Daemon.**
  - Hoist `createAdmin(...)` out of the web block, so one `admin` serves the dashboard and the tool (`inGateway: true`).
  - In `pool.create`, replace the inline Cron addition with `chatSessionTools(...)`. Use `selectProject: (id) => router.select(chatKey, id).then(() => {})` and `projects: chatProjects`.
  - Give the dashboard's own session the setup tool with `{ role: "owner", origin: "local" }`.
  - Call `onReloadSignal(reload)`, and remove the listener in the `finally`.
- **System prompt.** Add one paragraph to "About Tropos Code" with the substance below:

  > To change Tropos's own setup (Telegram, projects, model and effort, provider keys, MCP servers, suggestions and quiet hours, lowering autonomy, the doctor, restarting, updating) use TroposSetup; never edit settings.json or gateway.json yourself and never tell the user to. Things you can't do from here (raising autonomy, phone access, approving people, permission rules, hooks, the sandbox) are done in the dashboard: give the link. A key the user pasted appears as `[secret:<n>: …]`; pass `secret:<n>` and never repeat a key. If the owner asks you to stop messaging them, turn proactive messages off with TroposSetup. In a chat, "work on <name>" means SwitchProject.

- **Copy changes (only where the tool can now do the job).**
  - The daemon's "channels: none" line becomes `channels: none (ask me to connect Telegram, or open ${dashboardLink(config, "settings")})`.
  - In `gateway install`: the "No Telegram bot token yet …" line becomes `No Telegram bot yet: ask me to connect Telegram (paste the token from @BotFather), or open ${link}.` The "Add more with: tcode projects add <path>" text becomes `Running tcode in a git repo adds it; or ask me to add one.`
  - The default workspace README line becomes "Run tcode in any git repo and it's added as a project; or ask me to add one."
  - The empty text of the MCP panel keeps P1 Task 12's `No MCP servers. Ask me to add one, or add it in the dashboard (tcode dashboard → Extensions).`, which already passes the test below.
  - Pairing, hooks and autoUpdates texts stay as they are: the tool can't do those.
  - P1 Task 12 reworded the "channels: none" line and the `gateway install` no-token line; neither says "ask me to connect Telegram" with a link, so this task replaces both as above.

- [ ] **Step 4: Run the tests and confirm they pass, then typecheck**

Run: the Step 2 command, then `bun run typecheck`.
Expected: PASS.

- [ ] **Step 5: Stage**

```bash
git add src/tools/setup/switch-project-tool.ts src/tools/setup/switch-project-tool.test.ts src/gateway/session-tools.ts src/gateway/session-tools.test.ts src/cli/main.tsx src/gateway/daemon.ts src/gateway/daemon.test.ts src/gateway/telegram/adapter.ts src/gateway/telegram/adapter.test.ts src/agent/subagent.ts src/context/system-prompt.ts src/context/system-prompt.test.ts src/gateway/commands.ts src/gateway/commands.test.ts src/gateway/projects.ts src/cli/runtime.ts src/cli/runtime.test.ts
```

---

### Task 9: Git worktrees for chat work

**Files:**
- Create: `src/gateway/worktrees.ts`
- Modify: `src/paths.ts`
- Test: `src/gateway/worktrees.test.ts` (real git through `makeRepo`/`git` from `src/snapshots/test-repo.ts`; skipped when `Bun.which("git")` is null)

**Interfaces:**
- Produces:
  - `export function worktreesDir(home: string): string` in `src/paths.ts` (`join(home, "worktrees")`).
  - `export type GitRun = (args: string[], cwd: string) => Promise<{ code: number; stdout: string; stderr: string }>`
  - `export const hostGit: GitRun`. It runs `git -c core.hooksPath=/dev/null -c commit.gpgsign=false …` with `GIT_*` variables removed from the environment and a 60 s timeout.
  - `export interface Worktree { key: string; projectId: string; repo: string; task: string; branch: string; path: string; base: string; createdAt: number }`
  - `export type WorktreeAction = "merge" | "pr" | "keep" | "discard"` (re-exported from `src/gateway/types.ts` in Task 10).
  - `export class WorktreeStore { constructor(home: string); get(key: string): Promise<Worktree | undefined>; put(w: Worktree): Promise<void>; remove(key: string): Promise<void> }`, over `gateway/worktrees.json` with mode 0600.
  - `export function taskName(now: Date, rand?: () => string): string`. The form is `YYYYMMDD-HHMM-<4 hex>`.
  - `export async function createWorktree(o: { home: string; key: string; projectId: string; repo: string; git?: GitRun; now?: () => Date }): Promise<Worktree | undefined>`. It returns `undefined` when the repo has no commit.
  - `export async function worktreeChanges(w: Worktree, git?: GitRun): Promise<{ changedFiles: number; commitsAhead: number }>`
  - `export async function ghReady(repo: string, gh?: GitRun, git?: GitRun): Promise<boolean>`. This means `gh auth status` exits 0 and `git remote get-url origin` succeeds.
  - `export async function finishWorktree(w: Worktree, action: WorktreeAction, o: { title: string; git?: GitRun; gh?: GitRun }): Promise<{ ok: boolean; message: string }>`

- [ ] **Step 1: Write the failing tests**

```ts
test("a worktree lives under ~/.tropos/worktrees/<project>/<task> on tropos/<task>, and the checkout is untouched", async () => {
  const repo = await makeRepo();
  const w = (await createWorktree({ home, key: "telegram:1@app", projectId: "app", repo, now: () => new Date(2026, 9, 16, 9, 5) }))!;
  expect(w.path).toBe(join(home, "worktrees", "app", w.task));
  expect(w.branch).toBe(`tropos/${w.task}`); expect(w.task).toMatch(/^20261016-0905-[0-9a-f]{4}$/);
  expect(git(repo, "status", "--porcelain")).toBe(""); expect(git(repo, "branch", "--show-current").trim()).not.toBe(w.branch);
});
test("a repo without commits gets no worktree", async () => {
  const bare = await makeTmpDir(); git(bare, "init", "-q");
  expect(await createWorktree({ home, key: "k", projectId: "x", repo: bare })).toBeUndefined();
});
test("keep commits the work on the branch and removes the worktree folder", async () => {
  writeFileSync(join(w.path, "b.txt"), "two\n");
  expect(await worktreeChanges(w)).toEqual({ changedFiles: 1, commitsAhead: 0 });
  expect((await finishWorktree(w, "keep", { title: "add b" })).ok).toBe(true);
  expect(existsSync(w.path)).toBe(false); expect(git(repo, "show", `${w.branch}:b.txt`)).toBe("two\n");
});
test("merge brings the work into the current branch and deletes tropos/<task>", async () => { /* b.txt in repo; branch gone */ });
test("a conflicting merge is aborted and the branch kept", async () => {
  /* edit a.txt in both; result.ok false; message contains w.branch; no .git/MERGE_HEAD */
});
test("discard removes the folder and the branch", async () => { /* both gone */ });
test("repo hooks never run on Tropos's commit or merge", async () => {
  const hook = join(repo, ".git", "hooks", "pre-commit");
  writeFileSync(hook, `#!/bin/sh\ntouch ${join(repo, "HOOK_RAN")}\n`, { mode: 0o755 });
  writeFileSync(join(w.path, "c.txt"), "x");
  await finishWorktree(w, "merge", { title: "c" });
  expect(existsSync(join(repo, "HOOK_RAN"))).toBe(false);
});
test("pr pushes the branch and opens a PR with gh; without gh logged in it is refused", async () => {
  /* origin = bare repo; fake gh records ["pr","create","--head",w.branch,...]; ghReady false → ok false, nothing pushed */
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `bun test src/gateway/worktrees.test.ts`
Expected: FAIL (the module is missing).

- [ ] **Step 3: Implement**

- **Create.** `git rev-parse --verify HEAD` must succeed. Then run `git worktree add -b <branch> <path> HEAD` and store `base` (the HEAD sha) in `WorktreeStore`.
- **Commit (merge, pr, keep), when there are changes.** Run `add -A`, then `commit -m <title> -m "Made by Tropos from a chat."`. Add `-c user.name=Tropos -c user.email=tropos@localhost` when `git config user.email` is empty in the repo.
- **Merge.** Run `git -C repo merge --no-ff --no-edit <branch>`. On a non-zero exit, run `merge --abort` if `MERGE_HEAD` exists and return `ok: false` with "Couldn't merge cleanly, so I kept the branch <branch> for you to merge by hand."
- **PR.** Run `git push -u origin <branch>`, then `gh pr create --head <branch> --title <title> --body "Made by Tropos from a chat."` in `repo`.
- **Cleanup.** Every action finishes with `git worktree remove --force <path>` (for keep, only after the commit). Merge and discard also delete the branch (`-d` after merge, `-D` for discard).

- [ ] **Step 4: Run the tests and confirm they pass, then typecheck**

Run: `bun test src/gateway/worktrees.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Stage**

```bash
git add src/gateway/worktrees.ts src/gateway/worktrees.test.ts src/paths.ts
```

---

### Task 10: Chats work in worktrees and finish with buttons

**Files:**
- Create: `src/gateway/chat-worktrees.ts`
- Modify: `src/gateway/types.ts`, `src/gateway/daemon.ts` (`pool.create`), `src/gateway/policy.ts` (`workspaceProblem`), `src/exec/confinement-paths.ts`, `src/exec/sandbox-profile.ts`, `src/exec/bwrap-args.ts` (P2 Task 5's read-deny carve-out), `src/gateway/telegram/render.ts`, `src/gateway/telegram/adapter.ts`, `src/cli/runtime.ts` (`AppContext.contextBlocks`, used by `makeAgent`)
- Test: `src/gateway/chat-worktrees.test.ts`, `src/gateway/policy.test.ts`, `src/exec/confinement-paths.test.ts`, `src/exec/confined.test.ts`, `src/gateway/telegram/render.test.ts`, `src/gateway/telegram/adapter.test.ts`, `src/cli/runtime.test.ts`

**Interfaces:**
- Consumes: Task 9; C1 `isOwner` (on the `Pairing` the daemon holds); C3 `confinedBackend`.
- Produces:
  - `AppContext.contextBlocks?: () => Promise<string[]>`. `makeAgent`'s main-scope context appends these blocks before the nonce block. Task 11 reuses it.
  - In `types.ts`:
    - `export type { WorktreeAction } from "./worktrees"`
    - `export interface WorktreeSummary { branch: string; changedFiles: number; commitsAhead: number; canPr: boolean }`
    - `export interface ChatWorktrees { status(chatKey: string): Promise<WorktreeSummary | undefined>; finish(chatKey: string, senderId: string, action: WorktreeAction, title: string): Promise<string> }`
  - `export async function workdirForSession(o: { key: string; project: Project; store: WorktreeStore; create: typeof createWorktree; home: string }): Promise<Worktree | undefined>`. It returns `undefined` for the builtin project and for chat keys other than `telegram:` ones. It returns the stored worktree while its folder exists, and otherwise a new one.
  - `export function worktreeContext(base: AppContext, w: Worktree): AppContext`. This sets `cwd` and `allowedDirs` to `w.path` and adds this block to `contextBlocks`:

    > `<worktree>You are working in a git worktree of <project> at <path>, on branch <branch>. The owner's own checkout is untouched. Don't commit, push or switch branches; when you're done, summarise what changed. The owner then chooses: merge, open a PR, keep the branch, or discard.</worktree>`

  - `export function createChatWorktrees(d: { store: WorktreeStore; current(chatKey: string): Promise<Project>; isOwner(senderId: string): Promise<boolean>; closeSession(key: string): Promise<void>; git?: GitRun; gh?: GitRun }): ChatWorktrees`. Merge and PR from a non-owner return "Only the owner can merge or open a PR. You can keep the branch or discard it." Every finish closes the pool session and removes the store entry, so the next message starts a new task.
  - `render.ts` exports:
    - `worktreeText(s: WorktreeSummary): string`, e.g. `"Changes on tropos/<task>: 3 files changed."`
    - `worktreeKeyboard(s: WorktreeSummary): InlineKeyboard`, with buttons "Merge", "Open PR" (only when `canPr`), "Keep branch" and "Discard".
    - `discardConfirmKeyboard(): InlineKeyboard`, with "Yes, discard" and "Cancel".
    - `parseWorktreeCallback(data?: string): "merge" | "pr" | "keep" | "discard" | "discard!" | "cancel" | undefined`, over the data `wt:<x>`.
  - `TelegramAdapterOptions.worktrees?: ChatWorktrees`. After a turn ends with `end_turn` and changes exist, the adapter edits away the previous worktree message's keyboard and sends a new one. The title passed to `finish` is the first message of the task, cut with `oneLine(…, 72)`.
  - `workspaceProblem` accepts paths inside `worktreesDir(home)`. The confinement's `~/.tropos` read-deny carves out `worktreesDir(home)` the same way P2 carved out the default workspace: P2's `ConfinementPaths.readCarveOut: string` becomes `readCarveOuts: string[]` (`<home>/workspace`, `worktreesDir(home)`; params `C0`, `C1` in `sandboxProfile`, one `--ro-bind` each in `bwrapArgs`), and P5's own-files deny still comes after them.

- [ ] **Step 1: Write the failing tests**

```ts
// src/gateway/chat-worktrees.test.ts (real git)
test("a chat in a registered repo gets a worktree; the default workspace and scheduled runs don't", async () => {
  const app = { id: "app", name: "app", path: repo };
  const w = await workdirForSession({ key: "telegram:1@app", project: app, store, create: createWorktree, home });
  expect(w?.path.startsWith(join(home, "worktrees", "app"))).toBe(true);
  expect(await workdirForSession({ key: "telegram:1@app", project: app, store, create: createWorktree, home })).toEqual(w);
  expect(await workdirForSession({ key: "telegram:1@default", project: builtinProject(home), store, create: createWorktree, home })).toBeUndefined();
  expect(await workdirForSession({ key: "project:app@app", project: app, store, create: createWorktree, home })).toBeUndefined();
});
test("guests can keep or discard but not merge or open a PR", async () => {
  const cw = createChatWorktrees({ store, current: async () => app, isOwner: async (s) => s === "1", closeSession: async (k) => void closed.push(k) });
  expect(await cw.finish("telegram:2", "2", "merge", "t")).toBe("Only the owner can merge or open a PR. You can keep the branch or discard it.");
  expect(await cw.finish("telegram:1", "1", "keep", "t")).toContain("tropos/");
  expect(closed).toEqual(["telegram:1@app"]);
});
// src/cli/runtime.test.ts (add)
test("context blocks ride in the first message's context", async () => { /* ctx.contextBlocks = async () => ["<worktree>x</worktree>"]; contextText contains it */ });
// src/gateway/policy.test.ts (add)
test("a worktree folder is a fit workspace though it is under ~/.tropos", () => {
  expect(workspaceProblem(join(home, "worktrees", "app", "t1"), home, userHome)).toBeUndefined();
});
// src/exec/confined.test.ts (add, in P2's sandbox-exec block, skipped where unavailable)
test("a command in a worktree under ~/.tropos can write there but still can't read ~/.tropos/credentials.json", async () => { /* … */ });
// src/gateway/telegram/adapter.test.ts (add)
test("after a turn with changes the chat gets the four buttons; Discard asks twice", async () => {
  const wt = fakeWorktrees({ branch: "tropos/t1", changedFiles: 2, commitsAhead: 0, canPr: true });
  const { server } = await setup({ worktrees: wt });
  server.pushMessage(CHAT, CHAT, "fix the bug");
  const msg = await server.waitForSent((m) => m.text === "Changes on tropos/t1: 2 files changed.");
  expect(buttonTexts(msg)).toEqual(["Merge", "Open PR", "Keep branch", "Discard"]);
  server.pushCallback(CHAT, CHAT, msg.messageId, "wt:discard");
  await server.waitFor(() => buttonTexts(lastEdit(msg)).includes("Yes, discard"));
  expect(wt.finished).toEqual([]);
  server.pushCallback(CHAT, CHAT, msg.messageId, "wt:discard!");
  await server.waitFor(() => wt.finished.length === 1);
  expect(wt.finished[0]).toEqual({ chatKey: `telegram:${CHAT}`, senderId: String(CHAT), action: "discard", title: "fix the bug" });
});
test("no changes, no buttons; a press from someone else is ignored", async () => { /* … */ });
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `bun test src/gateway/chat-worktrees.test.ts src/gateway/policy.test.ts src/exec/confined.test.ts src/gateway/telegram/render.test.ts src/gateway/telegram/adapter.test.ts src/cli/runtime.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `pool.create`, after the project is resolved, call `const w = await workdirForSession(...)`. When `w` is set, use `w.path` everywhere the session used the project directory: the exec backend (`confinedBackend({ project: w.path, … })` or Docker's workspace), `SessionStore.create/open`, and `worktreeContext(sessionCtx, w)`. The daemon passes `createChatWorktrees({ store, current: (k) => router.current(k), isOwner: (s) => run.pairing.isOwner("telegram", s), closeSession: (k) => pool.close(k) })` to the `TelegramAdapter`. A press while the chat's turn is running is answered with "Wait for the current turn to finish." through `answerCallbackQuery`.

- [ ] **Step 4: Run the tests and confirm they pass, then typecheck**

Run: the Step 2 command, then `bun run typecheck`.
Expected: PASS.

- [ ] **Step 5: Stage**

```bash
git add src/gateway/chat-worktrees.ts src/gateway/chat-worktrees.test.ts src/gateway/types.ts src/gateway/daemon.ts src/gateway/policy.ts src/gateway/policy.test.ts src/exec/confinement-paths.ts src/exec/confinement-paths.test.ts src/exec/sandbox-profile.ts src/exec/bwrap-args.ts src/exec/confined.test.ts src/gateway/telegram/render.ts src/gateway/telegram/render.test.ts src/gateway/telegram/adapter.ts src/gateway/telegram/adapter.test.ts src/cli/runtime.ts src/cli/runtime.test.ts
```

---

### Task 11: Suggestions during a conversation

**Files:**
- Create: `src/suggest/store.ts`, `src/suggest/signals.ts`, `src/suggest/tool.ts`, `src/suggest/test-watch.ts`
- Modify: `src/cli/runtime.ts` (`AppContext.testWatch`, `makeAgent` emit; stops passing P4's `reminder`), `src/gateway/session-tools.ts`, `src/gateway/daemon.ts`, `src/cli/main.tsx`, `src/agent/subagent.ts`, `src/context/system-prompt.ts`
- Test: `src/suggest/store.test.ts`, `src/suggest/signals.test.ts`, `src/suggest/tool.test.ts`, `src/suggest/test-watch.test.ts`, `src/gateway/session-tools.test.ts`, `src/context/system-prompt.test.ts`

**Interfaces:**
- Consumes: Task 10 (`contextBlocks`); `CronStore`; `journalDir` (C6); `projects[].testCommands` (C3); P4 Task 11's `openSkippedSteps(deps, { serviceInstalled })`, `markReminded(home, id)` and `REMINDER_TOPICS`, and `readOnboardingFlags` (`reminded`); `ServiceManager.status`. Setup signals are built from P4's reminders, never from a second detection of their own.
- Produces:
  - `export interface SuggestionState { declined: Record<string, number>; mentioned: Record<string, number>; tests: Record<string, { ok: boolean; at: number; command: string }> }`
  - `export class SuggestionStore { constructor(home: string); read(): Promise<SuggestionState>; mark(id: string, outcome: "mentioned" | "declined" | "accepted", now?: number): Promise<void>; recordTest(projectId: string, command: string, ok: boolean, now?: number): Promise<void> }`, over `learning/suggestions.json` with mode 0600. An `accepted` outcome counts as declined for listing (it is done). `mark` on a `setup:<step>` id, whatever the outcome, also calls P4's `markReminded(home, step)`, so P4's `reminded` list stays the one record and a step is never mentioned twice.
  - `export interface SignalFacts { setupOpen: OnboardStepId[]; failingJobs: { id: string; name: string; error: string }[]; journalDays: number; cronJobs: number }`. `setupOpen` is P4's `openSkippedSteps(deps, { serviceInstalled })` minus the ids already in `onboarding.json` `reminded`, limited to P4's `REMINDABLE` steps.
  - `export interface Signal { id: string; text: string }`. Ids are `setup:<step>` for each step in `setupOpen` (`setup:telegram`, `setup:phone`, `setup:service`, `setup:projects`; the text comes from P4's `REMINDER_TOPICS`), `cron-failing:<jobId>`, `tests-failing:<projectId>` and `routine`.
  - `export function computeSignals(facts: SignalFacts, state: SuggestionState, now: number): Signal[]`. Rules: declined or accepted never lists. A `setup:*` signal lists only while its step is in `setupOpen` and it was never mentioned; any other signal lists unless it was mentioned in the last 7 days. `routine` needs `journalDays >= 5` in the last 14 days and `cronJobs === 0`. At most 3 signals.
  - `export async function gatherFacts(i: { home: string; env: NodeJS.ProcessEnv; serviceInstalled: () => Promise<boolean | undefined> }): Promise<SignalFacts>`
  - `export function suggestionsBlock(signals: Signal[]): string`. This returns `""` when the list is empty, and otherwise `<suggestions>` with one `- [<id>] <text>` line per signal.
  - `export function suggestionContext(i: { home: string; env: NodeJS.ProcessEnv; serviceInstalled: () => Promise<boolean | undefined>; now?: () => number }): () => Promise<string[]>`. The service status is cached for 10 minutes per process.
  - `export function createSuggestionTool(store: SuggestionStore): AnyTool`. The name is `"Suggestion"`, the kind is `"meta"`, and the input is `{ id: string; outcome: "mentioned" | "declined" | "accepted" }`.
  - `export function createTestWatcher(store: SuggestionStore, projectId: string, commands: string[]): { observe(e: AgentEvent): void }`. It maps a Bash `tool_start` id to its summary. On `tool_end`, when the summary equals a pinned command, it calls `recordTest(..., status !== "error")`.
  - `AppContext.testWatch?: { observe(e: AgentEvent): void }`, fed by `makeAgent`'s emit.
  - `chatSessionTools` gains `suggestion?: () => AnyTool` (owner only). P6's `HUB_ONLY_TOOLS` gains `"Suggestion"`.
  - Owner sessions (terminal, dashboard, owner chats) get `contextBlocks` from `suggestionContext` and a `testWatch` for their project. Guests, scheduled runs and the heartbeat get neither.
  - P4's `<setup-reminder>` context is replaced by the `setup:*` signals: `makeAgent` no longer calls `takeSetupReminder` or passes `contextExtras`' `reminder`, so there is one mechanism and one mention per step. P4's `openSkippedSteps`, `markReminded`, `REMINDER_TOPICS` and the `tcode status` row stay and feed this task.

- [ ] **Step 1: Write the failing tests**

```ts
// src/suggest/signals.test.ts
const FACTS: SignalFacts = { setupOpen: ["telegram"], failingJobs: [], journalDays: 0, cronJobs: 1 };
const EMPTY = { declined: {}, mentioned: {}, tests: {} };
test("a skipped setup step is suggested once, ever", () => {
  expect(computeSignals(FACTS, EMPTY, NOW).map((s) => s.id)).toEqual(["setup:telegram"]);
  expect(computeSignals(FACTS, { ...EMPTY, mentioned: { "setup:telegram": NOW - 90 * DAY } }, NOW)).toEqual([]);
  expect(computeSignals({ ...FACTS, setupOpen: [] }, EMPTY, NOW)).toEqual([]); // reminded (P4's list) or done since
});
test("declined signals never come back; others come back after a week", () => {
  const facts = { ...FACTS, setupOpen: [], failingJobs: [{ id: "j1", name: "digest", error: "timed out" }] };
  expect(computeSignals(facts, { ...EMPTY, declined: { "cron-failing:j1": 1 } }, NOW)).toEqual([]);
  expect(computeSignals(facts, { ...EMPTY, mentioned: { "cron-failing:j1": NOW - 8 * DAY } }, NOW).map((s) => s.id)).toEqual(["cron-failing:j1"]);
});
test("failing tests, a routine without jobs, and at most three", () => {
  const s = computeSignals({ ...FACTS, setupOpen: ["telegram", "phone", "service"], journalDays: 6, cronJobs: 0 }, { ...EMPTY, tests: { app: { ok: false, at: NOW, command: "bun test" } } }, NOW);
  expect(s).toHaveLength(3);
});
test("the block is empty without signals", () => expect(suggestionsBlock([])).toBe(""));
// src/suggest/test-watch.test.ts
test("a pinned test command that fails is recorded for its project", async () => {
  const w = createTestWatcher(store, "app", ["bun test"]);
  w.observe({ type: "tool_start", id: "1", name: "Bash", summary: "bun test", input: {} });
  w.observe({ type: "tool_end", id: "1", name: "Bash", status: "error", output: { content: "" } });
  await Bun.sleep(0);
  expect((await store.read()).tests.app).toMatchObject({ ok: false, command: "bun test" });
});
// src/suggest/tool.test.ts: kind meta; mark declined persists.
// src/suggest/store.test.ts (add)
test("marking a setup signal records it in P4's reminded list", async () => {
  await store.mark("setup:telegram", "mentioned");
  expect((await readOnboardingFlags(home)).reminded).toContain("telegram");
});
// src/gateway/session-tools.test.ts (extend): owner chats also get "Suggestion"; guests don't.
// src/context/system-prompt.test.ts (add)
test("the prompt carries the suggestion rules", () => {
  expect(SYSTEM_PROMPT).toContain("<suggestions>");
  expect(SYSTEM_PROMPT).toContain("at most one suggestion per conversation");
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `bun test src/suggest src/gateway/session-tools.test.ts src/context/system-prompt.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the store, signals, tool and watcher, and wire them**

The system prompt gains a paragraph with this substance (exact wording is left to the builder, §11):

> A `<suggestions>` block lists things worth suggesting. Make at most one suggestion per conversation, only at a natural pause, after answering, never instead of the answer; call Suggestion with outcome mentioned when you do, declined when the owner says no (it won't come back), accepted when they take it. If a kind of work keeps coming back and no specialist fits, that is worth suggesting too.

- [ ] **Step 4: Run the tests and confirm they pass, then typecheck**

Run: `bun test src/suggest src/gateway/session-tools.test.ts src/context/system-prompt.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Stage**

```bash
git add src/suggest src/cli/runtime.ts src/gateway/session-tools.ts src/gateway/session-tools.test.ts src/gateway/daemon.ts src/cli/main.tsx src/agent/subagent.ts src/context/system-prompt.ts src/context/system-prompt.test.ts
```

---

### Task 12: The heartbeat

**Files:**
- Create: `src/gateway/heartbeat.ts`
- Modify: `src/gateway/policy.ts` (`heartbeatContext`; `chatRole` for `heartbeat:` keys), `src/gateway/daemon.ts` (starts the service; `pool.create` builds the heartbeat session), `src/memory/notes.ts`, `src/memory/memory-tool.ts` (the `heartbeat` target P5 Task 5 left to this plan)
- Test: `src/gateway/heartbeat.test.ts`, `src/gateway/policy.test.ts`, `src/memory/notes.test.ts`

**Interfaces:**
- Consumes: Task 1 (`ProactiveConfig`, `proactiveEnabled`); C1 `FilePairing.owner()`; C6 `workspaceFile(home, "AGENTS.md")`; `CronStore.list`/`runs`; `GatewayService`; `toolKind`.
- Produces:
  - `export const HEARTBEAT_CHAT_KEY = "heartbeat:owner"`. The session key is `sessionKey(HEARTBEAT_CHAT_KEY, DEFAULT_PROJECT_ID)`.
  - `export function inActiveHours(now: Date, hours: { start: string; end: string }): boolean`. Local time; the start is inclusive and the end exclusive. When start > end, the window crosses midnight. Start equal to end means all day.
  - `export interface HeartbeatState { lastRunAt?: number; sent: number[] }`, over `gateway/heartbeat.json`, keeping the last 7 days of sends. Helpers: `readHeartbeatState(home: string): Promise<HeartbeatState>` and `writeHeartbeatState(home: string, s: HeartbeatState): Promise<void>`.
  - `export type HeartbeatVerdict = "run" | "off" | "quiet" | "not-yet" | "daily-cap"`
  - `export function heartbeatDue(i: { now: Date; config: ProactiveConfig; enabled: boolean; state: HeartbeatState }): HeartbeatVerdict`. Checks run in that order. `daily-cap` counts sends on the same local calendar day.
  - `export function parseHeartbeatAnswer(text: string): string | null`. It returns `null` for NOTHING (ignoring case, surrounding whitespace, markdown emphasis and a trailing period) and for an empty answer.
  - `export function heartbeatSection(agentsMd: string): string`: P5's `sectionEntries(agentsMd, "Heartbeat")`, one `- <item>` line each (`""` when there are none).
  - The Memory target P5 Task 5 expects from this plan, built exactly like its `lessons`: `NotesTarget` gains `"heartbeat"`, `NotesStore.path("heartbeat")` = `workspaceFile(home, "AGENTS.md")`, entries through P5's `sectionEntries`/`withSectionEntries` on `## Heartbeat` under the same lock, scan and ledger (kind `"memory"`), the same 2,200-character budget as lessons (`MEMORY_LIMITS.heartbeat`), rendered as `<notes source="heartbeat">`. The Memory tool's `target` enum adds `"heartbeat"`, described: `"heartbeat" for what the owner wants checked in the background (a job, a deploy, a deadline), one line each; kept in your workspace AGENTS.md.`
  - `export function heartbeatPrompt(i: { section: string; runs: { job: string; status: string; at: number; summary: string; error?: string }[]; now: Date }): string`
  - `export function createHeartbeatService(d: { openSession: () => Promise<ChatSession>; owner: () => Promise<{ channel: string; senderId: string } | null>; telegramConnected: () => boolean; now?: () => Date; tickMs?: number; runTimeoutMs?: number; setTimer?: (fn: () => void, ms: number) => unknown; clearTimer?: (h: unknown) => void }): GatewayService`. The name is `"heartbeat"`. Defaults are a 10-minute tick and a 5-minute run limit.
  - `export function heartbeatContext(base: AppContext): AppContext` (in `policy.ts`). It keeps only tools whose `toolKind` is `"read"`, uses `role: "scheduled"`, turns learning off, and has no `contextBlocks` and no `testWatch`.

- [ ] **Step 1: Write the failing tests**

```ts
const at = (h: number, m = 0, d = 16) => new Date(2026, 9, d, h, m);
const DAY_CFG = { activeHours: { start: "09:00", end: "21:00" }, everyHours: 4, maxPerDay: 1 };
test("active hours, including a window across midnight", () => {
  expect([at(8, 59), at(9), at(20, 59), at(21)].map((d) => inActiveHours(d, DAY_CFG.activeHours))).toEqual([false, true, true, false]);
  expect([at(23), at(5, 59), at(12)].map((d) => inActiveHours(d, { start: "22:00", end: "06:00" }))).toEqual([true, true, false]);
});
test("off, quiet, not yet, capped per local day, then run", () => {
  const due = (now: Date, state: HeartbeatState, enabled = true) => heartbeatDue({ now, config: DAY_CFG, enabled, state });
  expect(due(at(10), { sent: [] }, false)).toBe("off");
  expect(due(at(22), { sent: [] })).toBe("quiet");
  expect(due(at(13), { lastRunAt: at(9, 1).getTime(), sent: [] })).toBe("not-yet");
  expect(due(at(15), { lastRunAt: at(9).getTime(), sent: [at(9).getTime()] })).toBe("daily-cap");
  expect(due(at(9, 0, 17), { lastRunAt: at(23, 30).getTime(), sent: [at(23, 30).getTime()] })).toBe("run");
});
test("NOTHING in any dress means silence", () => {
  for (const t of ["NOTHING", " nothing. ", "**NOTHING**", ""]) expect(parseHeartbeatAnswer(t)).toBeNull();
  expect(parseHeartbeatAnswer("Your nightly backup job failed twice.")).toBe("Your nightly backup job failed twice.");
});
test("reads the Heartbeat section of AGENTS.md", () => {
  expect(heartbeatSection("# Rules\n## Heartbeat\n- Check the deploy job.\n## Lessons\n- x")).toBe("- Check the deploy job.");
});
test("Memory target heartbeat adds an item under ## Heartbeat in workspace/AGENTS.md", async () => {
  await store.add("heartbeat", "check the nightly deploy");
  expect(sectionEntries(await readFile(workspaceFile(home, "AGENTS.md"), "utf8"), "Heartbeat")).toEqual(["check the nightly deploy"]);
});
test("a due run with something to say messages the owner once and records it; asks are denied", async () => {
  const session = new FakeSession("heartbeat:owner@default");
  session.onPrompt = async (_t, s) => { s.ask(1, { toolName: "Bash", kind: "exec", summary: "rm x", input: {} }); s.emit(assistantEvent("The digest job failed.")); s.emit({ type: "turn_end", reason: "end_turn" }); return "end_turn"; };
  const delivered: [string, string][] = [];
  const svc = createHeartbeatService({ openSession: async () => session, owner: async () => ({ channel: "telegram", senderId: "42" }), telegramConnected: () => true, now: () => at(10), setTimer: (fn) => (timers.push(fn), 0), clearTimer: () => {} });
  await svc.start({ home, deliver: async (t, x) => void delivered.push([t, x]) } as GatewayServiceDeps);
  await timers[0]!(); await Bun.sleep(0);
  expect(delivered).toEqual([["telegram:42", "The digest job failed."]]);
  expect(session.answers[0]!.answer.kind).toBe("deny");
  expect((await readHeartbeatState(home)).sent).toHaveLength(1);
});
test("NOTHING sends nothing but still counts as a run; no owner, no run", async () => { /* … */ });
// src/gateway/policy.test.ts (add)
test("the heartbeat session has read tools only and is a scheduled session", () => {
  const ctx = heartbeatContext({ ...base, tools: [tool("Read", "read"), tool("Bash", "exec"), tool("Edit", "edit"), tool("TroposSetup", "exec")] });
  expect(ctx.tools.map((t) => t.name)).toEqual(["Read"]); expect(ctx.role).toBe("scheduled");
});
test("the heartbeat key is a scheduled role", async () => expect(await chatRole(HEARTBEAT_CHAT_KEY, { isOwner: async () => true })).toBe("scheduled"));
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `bun test src/gateway/heartbeat.test.ts src/gateway/policy.test.ts src/memory/notes.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

- **Each tick.** Read `loadGatewayConfig(home)` fresh, so Settings changes apply without a restart. Get `heartbeatDue` with `enabled = proactiveEnabled(config, telegramConnected())`. Do nothing unless the verdict is `run` and `owner()` is a Telegram owner. Then run the session the same way the cron runner does (`clear()` first, deny every ask). Prompt it with `heartbeatPrompt` built from the AGENTS.md section and the cron runs of the last 24 h. Deliver to `${owner.channel}:${owner.senderId}` unless `parseHeartbeatAnswer` returns `null`. Persist `lastRunAt` (and `sent` when something was sent). Failures are logged and never thrown.
- **The prompt** states:
  - this is a background check that no one asked for;
  - answer exactly NOTHING unless something deserves the owner's attention today;
  - at most a few sentences;
  - the journal and the scheduled-run results are the sources;
  - read-only tools only.
- **Daemon.**
  - P1's `chatRole` maps `heartbeat:` keys to `"scheduled"` (today anything that isn't `project:` or the owner's `telegram:` key is `"guest"`).
  - When `pool.create` gets the key `HEARTBEAT_CHAT_KEY`, it builds `heartbeatContext(channelContext(base, backend, { role: "scheduled" }))` in the default project, with no worktree and no session tools.
  - `run.services` gains `createHeartbeatService({ openSession: () => pool.open(sessionKey(HEARTBEAT_CHAT_KEY, DEFAULT_PROJECT_ID)), owner: () => run.pairing.owner(), telegramConnected: () => adapters.some((a) => a.name === "telegram"), log })`.

- [ ] **Step 4: Run the tests and confirm they pass, then typecheck**

Run: `bun test src/gateway/heartbeat.test.ts src/gateway/policy.test.ts src/gateway/daemon.test.ts src/memory && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Stage**

```bash
git add src/gateway/heartbeat.ts src/gateway/heartbeat.test.ts src/gateway/policy.ts src/gateway/policy.test.ts src/gateway/daemon.ts src/memory/notes.ts src/memory/notes.test.ts src/memory/memory-tool.ts
```

---

### Task 13: Dashboard: the Suggestions settings

**Files:**
- Create: `web/src/components/pages/settings/suggestions-panel.tsx`
- Modify: `web/src/app/pages/SettingsPage.tsx` (add one tab, `{ value: "suggestions", label: "Suggestions" }`, to the tab list P3 left), `web/src/app/routes.ts` (`"suggestions"` appended to P3's exported `SETTINGS_TABS`, after `"phone"`, so `#/settings/suggestions` is a valid tab)
- Test: `web/src/components/pages/settings/suggestions-panel.test.tsx`

**Interfaces:**
- Consumes: Task 5 (`proactive.get`, `proactive.set`, `ProactiveView`, `ProactivePatch`); `Switch`, `TextField`, `SelectField`, `Notice` and `useAction` from `@/components/setup/admin-ui`; `mountAdminPage`.
- Produces: `export function SuggestionsPanel(): JSX.Element`.
  - A "Message me on Telegram when something needs me" switch, with the hint "On by default once Telegram is connected. At most once a day, never outside active hours." and, without Telegram, "Connect Telegram first."
  - Active hours as two `type="time"` fields.
  - "Check every" with the options 1, 2, 3, 4, 6, 8, 12 hours.
  - "At most per day" with the options 0–3.
  - "New projects folder".
  - A Save button that sends only the changed fields.
  - "Use the default" resets `enabled` (sends `null`).

- [ ] **Step 1: Write the failing test**

```tsx
const VIEW: ProactiveView = { enabled: true, explicit: false, telegram: true, activeHours: { start: "09:00", end: "21:00" }, everyHours: 4, maxPerDay: 1, newProjectsDir: "/home/me/Projects" };
test("shows the settings and saves only what changed", async () => {
  const { socket } = await mountAdminPage(SuggestionsPanel, { "proactive.get": () => VIEW, "proactive.set": (p) => ({ ...VIEW, ...p, enabled: p.enabled ?? VIEW.enabled, explicit: true }) });
  const toggle = await screen.findByRole("switch", { name: "Message me on Telegram when something needs me" });
  expect(screen.getByText(/On by default once Telegram is connected/)).toBeTruthy();
  fireEvent.click(toggle); fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(socket.adminCalls.at(-1)).toEqual({ method: "proactive.set", params: { enabled: false } }));
});
test("an invalid value shows the server's message", async () => { /* proactive.set rejects "proactive.activeHours.start: a time like 09:00" → Notice shows it */ });
test("without Telegram the switch is disabled and says why", async () => { /* telegram: false → "Connect Telegram first." */ });
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `bun test web/src/components/pages/settings/suggestions-panel.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement the panel and mount it in the Settings tabs**

- [ ] **Step 4: Run the tests and typecheck, then check it visually**

Run: `bun test web/src/components/pages/settings/suggestions-panel.test.tsx web/src/app/pages/SettingsPage.test.tsx && bun run typecheck`
Expected: PASS. Then take screenshots with `bun run dev:web` at 320, 375, 768, 1024 and 1440 under both system color schemes (the app is light-only, as P3 decided: under a dark scheme it must stay light and legible), operate it by keyboard only, and check with reduced motion on.

- [ ] **Step 5: Stage**

```bash
git add web/src/components/pages/settings/suggestions-panel.tsx web/src/components/pages/settings/suggestions-panel.test.tsx web/src/app/pages/SettingsPage.tsx web/src/app/routes.ts
```

---

### Task 14: Memory page: edit and delete notes

**Files:**
- Modify: `src/memory/notes.ts`, `src/web/admin/api.ts`, `src/web/admin/index.ts`, `web/src/app/pages/MemoryPage.tsx`
- Create: `src/web/admin/memory.ts`
- Test: `src/memory/notes.test.ts`, `src/web/admin/memory.test.ts`, `web/src/app/pages/MemoryPage.test.tsx`

**Interfaces:**
- Consumes: `NotesStore` and `Ledger` as P5 left them (same API, new paths).
- Produces:
  - `NotesStore.editAt(target: NotesTarget, index: number, expected: string, content: string | null, actor: Actor): Promise<NotesResult>`. A `null` content removes the entry. It runs the same checks as `replace` (`checkEntry`, duplicates, the size limit) and is recorded in the ledger. When `entries[index] !== expected`, it returns `{ ok: false, error: "This note changed since the page loaded. Reload and try again." }`.
  - `"memory.edit": { params: { target: "memory" | "user"; index: number; expected: string; content: string }; result: { ok: true } }` and `"memory.delete": { params: { target: "memory" | "user"; index: number; expected: string }; result: { ok: true } }`. Both act as `"user"`, and a refusal becomes `AdminError(error)`.
  - In `MemoryPage`, each `NoteRow` gets "Edit" and "Delete" buttons with accessible names `Edit note` and `Delete note`. Edit opens a `TextArea` with Save and Cancel. Delete opens `ConfirmDialog` ("Delete this note?"). After either, the memory panel and the Learned card refresh. The target and index come from the item key `"<target>:<index>"`, and `expected` is `detail.join("\n")`.

- [ ] **Step 1: Write the failing tests**

```ts
// src/memory/notes.test.ts (add)
test("editAt changes one entry, refuses a stale one, and null deletes", async () => {
  await store.add("memory", "Use bun"); await store.add("memory", "Use bun test");
  expect((await store.editAt("memory", 0, "Use bun", "Use bun, never npm", "user")).entries).toEqual(["Use bun, never npm", "Use bun test"]);
  expect(await store.editAt("memory", 0, "Use bun", "x", "user")).toMatchObject({ ok: false, error: "This note changed since the page loaded. Reload and try again." });
  expect((await store.editAt("memory", 1, "Use bun test", null, "user")).entries).toEqual(["Use bun, never npm"]);
  expect((await ledger.list(1))[0]).toMatchObject({ actor: "user", kind: "memory" });
});
// web/src/app/pages/MemoryPage.test.tsx (add)
test("edit a note, then delete one after confirming", async () => {
  const { socket } = await mountAdminPage(MemoryPage, { "memory.edit": () => ({ ok: true }), "memory.delete": () => ({ ok: true }) }, { panel: panels(MEMORY) });
  fireEvent.click((await screen.findAllByRole("button", { name: "Edit note" }))[0]!);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "Use bun, always" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(socket.adminCalls).toContainEqual({ method: "memory.edit", params: { target: "memory", index: 0, expected: "Use bun, never npm.", content: "Use bun, always" } }));
  fireEvent.click(screen.getAllByRole("button", { name: "Delete note" })[1]!);
  fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
  await waitFor(() => expect(socket.adminCalls.at(-1)!.method).toBe("memory.delete"));
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `bun test src/memory/notes.test.ts src/web/admin/memory.test.ts web/src/app/pages/MemoryPage.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement `editAt`, the admin handlers and the page actions**

- [ ] **Step 4: Run the tests and typecheck, then check it visually**

Run: the Step 2 command, then `bun run typecheck`.
Expected: PASS. Screenshots of the page with the editor open at 320, 375, 768, 1024 and 1440 under both system color schemes (the app is light-only, as P3 decided: under a dark scheme it must stay light and legible), plus keyboard and reduced-motion checks.

- [ ] **Step 5: Stage**

```bash
git add src/memory/notes.ts src/memory/notes.test.ts src/web/admin/memory.ts src/web/admin/memory.test.ts src/web/admin/api.ts src/web/admin/index.ts web/src/app/pages/MemoryPage.tsx web/src/app/pages/MemoryPage.test.tsx
```

---

### Task 15: Skills page: edit, delete and restore archived skills

**Files:**
- Modify: `src/memory/skill-manage.ts`, `src/learning/curator.ts`, `src/cli/runtime.ts` (skills panel item keys), `src/web/admin/api.ts`, `src/web/admin/index.ts`, `web/src/app/pages/SkillsPage.tsx`
- Create: `src/web/admin/skills.ts`
- Test: `src/memory/skill-manage.test.ts`, `src/learning/curator.test.ts`, `src/web/admin/skills.test.ts`, `web/src/app/pages/SkillsPage.test.tsx`

**Interfaces:**
- Consumes: C6 `userSkillsDir`, `learnedSkillsDir`; `Ledger`; `SkillManageOptions` as P5 left it.
- Produces:
  - `export type SkillManageInput = z.infer<typeof schema>` and `export async function manageSkill(opts: SkillManageOptions, input: SkillManageInput, actor: Actor): Promise<ToolOutput>`. This is the body of the tool's `run`, which now calls it.
  - `export interface ArchivedSkill { id: string; name: string; archivedOn: string; description?: string }`. The `id` is the folder name under `.archive`, and `name` is the id without its `-YYYY-MM-DD(-n)` suffix.
  - `export async function listArchived(skillsDir: string): Promise<ArchivedSkill[]>`
  - `export async function restoreArchived(home: string, id: string, opts: { ledger: Ledger; skillsDir: string }): Promise<{ name: string }>`. The id must name a plain folder directly under `.archive`. An existing skill with the same name throws "A skill named <name> already exists." The restore is recorded as `action: "restore"`, `actor: "user"`.
  - The skills panel item `key` becomes `` `${source}:${name}` ``.
  - Admin methods:
    - `"skills.read": { params: { source: "user" | "learned"; name: string }; result: { content: string; path: string } }`
    - `"skills.write": { params: { source: "user" | "learned"; name: string; content: string }; result: { ok: true } }`
    - `"skills.delete": { params: { source: "user" | "learned"; name: string }; result: { ok: true } }`
    - `"skills.archived": { params: undefined; result: ArchivedSkill[] }`
    - `"skills.restore": { params: { id: string }; result: { name: string } }`
    Write and delete go through `manageSkill` as `"user"`. An `isError` result becomes an `AdminError` with its content.
  - In `SkillsPage`, rows whose key starts with `user:` or `learned:` get "Edit <name>" and "Delete <name>" buttons; project and plugin rows get none. Edit loads `skills.read` into a `TextArea` and saves with `skills.write`. Delete confirms first. An "Archived" card lists `skills.archived` with a "Restore <name>" button each, and its empty text reads "Skills the agent stops using are archived here after 30 days, never deleted."

- [ ] **Step 1: Write the failing tests**

```ts
// src/learning/curator.test.ts (add)
test("lists archived skills and restores one under its name, refusing a clash", async () => {
  await mkdir(join(learned, ".archive", "deploy-2026-09-01"), { recursive: true });
  await writeFile(join(learned, ".archive", "deploy-2026-09-01", "SKILL.md"), "---\ndescription: Deploys\n---\nsteps");
  expect(await listArchived(learned)).toEqual([{ id: "deploy-2026-09-01", name: "deploy", archivedOn: "2026-09-01", description: "Deploys" }]);
  expect(await restoreArchived(home, "deploy-2026-09-01", { ledger, skillsDir: learned })).toEqual({ name: "deploy" });
  expect(existsSync(join(learned, "deploy", "SKILL.md"))).toBe(true);
  await expect(restoreArchived(home, "../x", { ledger, skillsDir: learned })).rejects.toThrow();
});
// src/memory/skill-manage.test.ts (add)
test("manageSkill acts for the user and records it", async () => {
  await manageSkill(opts, { action: "create", name: "a", content: "---\ndescription: A\n---\nx" }, "user");
  expect((await ledger.list(1))[0]).toMatchObject({ actor: "user", kind: "skill" });
});
// src/web/admin/skills.test.ts: read/write/delete round trip on "user" and "learned"; bad name → AdminError; a threat-scan refusal surfaces as AdminError.
// web/src/app/pages/SkillsPage.test.tsx (add)
test("your and learned skills can be edited and deleted; project skills can't; archived ones restore", async () => {
  const { socket } = await mountAdminPage(SkillsPage, { "skills.read": () => ({ content: "---\ndescription: d\n---\nbody", path: "/p" }), "skills.write": () => ({ ok: true }), "skills.archived": () => [{ id: "deploy-2026-09-01", name: "deploy", archivedOn: "2026-09-01" }], "skills.restore": () => ({ name: "deploy" }) }, { panel: () => SKILLS_WITH_SOURCES });
  expect(await screen.findByRole("button", { name: "Edit bun-testing" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Edit repo-skill" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Restore deploy" }));
  await waitFor(() => expect(socket.adminCalls).toContainEqual({ method: "skills.restore", params: { id: "deploy-2026-09-01" } }));
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `bun test src/memory/skill-manage.test.ts src/learning/curator.test.ts src/web/admin/skills.test.ts web/src/app/pages/SkillsPage.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement `manageSkill`, `listArchived`/`restoreArchived`, the admin handlers, the panel keys and the page actions**

- [ ] **Step 4: Run the tests and typecheck, then check it visually**

Run: the Step 2 command, then `bun run typecheck`, then `bun test` (the whole suite) and `bun run test:coverage`.
Expected: all PASS, and coverage no worse than before P7. Take screenshots of Skills with the editor and the Archived card at 320, 375, 768, 1024 and 1440 under both system color schemes (the app is light-only, as P3 decided: under a dark scheme it must stay light and legible), plus keyboard and reduced-motion checks.

- [ ] **Step 5: Stage**

```bash
git add src/memory/skill-manage.ts src/memory/skill-manage.test.ts src/learning/curator.ts src/learning/curator.test.ts src/cli/runtime.ts src/web/admin/skills.ts src/web/admin/skills.test.ts src/web/admin/api.ts src/web/admin/index.ts web/src/app/pages/SkillsPage.tsx web/src/app/pages/SkillsPage.test.tsx
```

---

## Self-review

- **Spec coverage.**
  - Part H: the tool and its action × role matrix (T6, T7); prompts that show what changes (T6 `describeSetupChange`, which Telegram already renders through `permissionView`); ledger and undo (T4, T6, T7); secrets and `deleteMessage` (T3, T7); the copy changes (T8). Specialists are excluded through `filterTools` (T6).
  - Part I: auto-registration, the once-notice and tombstones (T2); "new project X" (T2, T6) and "work on Y" (T2, T8); worktrees and the four buttons (T9, T10).
  - Part J: the signals block, the prompt rules and remembered declines (T11); the heartbeat (T12); the settings and "stop messaging me" (T5, T8, T13).
  - §10 item 13: Memory (T14) and Skills (T15).
  - C8 (T1, T6).
- **Placeholders.** The heartbeat and suggestion prompt texts are given as their required substance, because §11 leaves exact prompts to the builder. Test bodies marked `/* … */` name their assertions in the comment.
- **Type consistency.** These names are the same everywhere they appear: `SetupWho`, `SETUP_ACTIONS`, `createSetupTool`, `SecretVault`, `recordSetupChange`, `requestGatewayReload`/`onReloadSignal`, `WorktreeAction`/`WorktreeSummary`/`ChatWorktrees`, `contextBlocks`, `chatSessionTools`, `HEARTBEAT_CHAT_KEY`, `ProactiveView`/`ProactivePatch`.
- **Proportion.** Code blocks are tests plus signatures. Bodies appear only where the algorithm or the copy is fixed.
