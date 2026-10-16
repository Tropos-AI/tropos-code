# Guided Setup (P4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After the install, `tcode onboard` and the web Setup page take the owner through ten explained, skippable,
resumable steps (model, name, projects, autonomy, Telegram with owner capture, phone access, background service, a
done screen that opens the dashboard logged in). Skipped steps come back once as a reminder.

**Architecture:** `src/onboard/engine.ts` stays the single source of truth. It reads every step's state from the
machine and exposes one function per action. Small modules beside it hold the repo scan, Telegram owner capture,
autonomy/phone helpers, the summary, reminders and the shared copy. The terminal wizard (`src/cli/lifecycle/onboard*.ts`)
and the web Setup page (`SetupPage.tsx`, through admin methods in `src/web/admin/onboard.ts`) only render and call
these functions. When the gateway already reads the bot, it records first contacts in `gateway/owner-claim.json`
instead of handing out pairing codes. That way the wizard never competes with it for `getUpdates`.

**Tech Stack:** TypeScript on Bun, zod, `bun:test`, React + Testing Library (web). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-16-setup-autonomy-access-design.md` Part A (§4.1–4.3), with
`docs/superpowers/plans/2026-10-16-contracts.md` (C1, C3, C4, C5). §10 item 3 of
`2026-10-16-growing-agent-design.md` (P1: `reload` rebuilds the channel adapters) is assumed.

## Global Constraints

- TypeScript on Bun, zod, colocated `*.test.ts`, TDD, short comments that say why, match nearby code; no new runtime dependency.
- The onboarding engine is the single source of truth for the terminal wizard and the web Setup page; neither re-implements a step.
- Step ids (C5): `"welcome" | "provider" | "model" | "identity" | "projects" | "autonomy" | "telegram" | "phone" | "service" | "done"`, in that order; `REQUIRED_STEPS` stays `["provider", "model"]`.
- Every step: one sentence on why it exists, then the detected answer. Enter accepts, `s` skips, `b` goes back.
- State is read from the machine each time, so quitting and re-running resumes. Errors say what to do next in plain words.
- The Docker sandbox step is removed from the wizard. `--advanced` asks every option; `--non-interactive` and every existing flag keep working. Keys and tokens are never accepted as arguments or echoed.
- Repo scan roots: `~/Desktop`, `~/Documents`, `~/Developer`, `~/code`, `~/Projects`, `~/src`, `~/dev`. Shallow and bounded, skips `node_modules` and hidden dirs. Only repos touched in the last 30 days are pre-ticked. The built-in default workspace is always there.
- Telegram: opens `https://t.me/BotFather` with three numbered instructions, verifies the token, catches the owner's first message, asks "is this you?", approves that sender and sets them as owner (C1). No pairing code.
- Autonomy default Balanced. Without OS confinement, `balanced`/`autonomous` need an explicit "run unconfined" confirmation. Raising the level is only done from the terminal or a logged-in dashboard, never from a chat.
- Dashboard at `http://localhost:4317` (`DEFAULT_PORT`; `webPort` overrides). Tailscale `serve` only, never Funnel.
- A skipped optional step is remembered, mentioned once by the agent, never more than once per step, and listed in `tcode status`.
- Web: screenshots at 320, 375, 768, 1024, 1440 under both system color schemes (the app is light-only, as P3 decided: under a dark scheme it must stay light and legible), plus keyboard and reduced-motion checks.
- Per the owner's rule, nothing is committed; each task ends by staging its files.

## Review Focus

1. **Anthropic chosen with no key.** The registry marks Anthropic `keyRequired: false` (for `ant auth login`). The provider step must still open its key page and ask for a key, not "validate" an empty key and fail. Pinned in Task 8.
2. **Strangers and old messages reaching the bot during the Telegram step** (someone else messages it, or the bot has a backlog). Nobody becomes approved or owner without an explicit "yes, that's me". A "no" keeps waiting for someone else, and no candidate's text ever reaches a session. Pinned in Tasks 2, 3, 10, 12.
3. **The gateway already reading the bot when the wizard runs** (re-run with the service up, or the web Setup page, which runs inside the gateway). Two `getUpdates` pollers fight (409). The wizard must use the claim file, and a 409 in direct mode is a plain message. Pinned in Tasks 2 and 10.
4. **A huge or looping home folder during the project scan** (symlink loops, deep monorepos, slow disks). The scan ends within its time and depth limits, follows no symlinks, and says it stopped early. Pinned in Task 4.
5. **Re-running the wizard on an existing install** (Docker backend, `ask` level, owner already set). Nothing changes until the user says yes, and declining keeps Docker and `ask`. Pinned in Tasks 7 and 9.

## Cross-plan dependencies

Relied on as implemented (contracts file): C1 `FilePairing.owner()/setOwner()/isOwner()`, `SessionRole`,
`AppContext.role`; C3 `Autonomy`, `confinementAvailable()`, `gateway.json chat: { autonomy, backend }`; C4
`tailscaleStatus(runner)`, `enableServe(runner, port)`, `renderQr(text)`, `LoginCodes.issueOneTime()/issueCode()`,
`gateway.json remoteAccess`, `DEFAULT_PORT`; P1's real `reload`.

**Beyond the contracts file** (all listed in contracts C9). Each is used under this name below:
- **P3 Task 3:** `src/web/login-codes.ts` exports `loginCodesFor(home: string): LoginCodes`, the file-backed store the running service redeems against, so a CLI process (the wizard, `tcode dashboard`) can issue a one-time key or a code. **P3 Task 7:** `dashboardLoginLink(home, port, logins?)` and `dashboardPort(config)` in `src/web/links.ts`; **P3 Task 11:** `remoteUrl(remote)`.
- **P3 Task 1 / Task 15:** `src/ui/qr.ts` exports `qrMatrix(text: string): boolean[][]` (`renderQr` is drawn from it), and `QrCode({ text, label })` (`web/src/components/pages/settings/qr-code.tsx`) draws it as SVG; the web Setup page reuses that component.
- **P2 Task 1 / Task 10:** consent to run unconfined is `gateway.json chat.allowUnconfined?: boolean`, written only by P2's `setAutonomy` / `setChatBackend` (with `acceptUnconfined`); P4 calls those setters and never writes `chat` itself. `AutonomyLevel` is P2's type in `src/web/admin/api.ts`. P2's `ensureChatSettings(home)` is called when setup starts (Task 7), so step order never decides whether an install counts as existing.
- **Defined here** (Task 1): `FilePairing.approveSender(channel, senderId)`.
- **For P7:** its `setup:*` suggestion signals read `openSkippedSteps` and record with `markReminded` (Task 11), so a step is never mentioned twice.

## File structure

| File | Responsibility |
|---|---|
| `src/onboard/engine.ts` | Steps, state, keys/models, Telegram token, service (modified) |
| `src/onboard/flags.ts` | `onboarding.json`: started, dismissed, skipped, reminded (modified) |
| `src/onboard/copy.ts` | Browser-safe copy shared by terminal and web: step reasons, suggestions, autonomy levels, BotFather steps, reminders |
| `src/onboard/projects-scan.ts` | Bounded git-repo scan and registering the picks |
| `src/gateway/owner-claim.ts` | The "setup is listening" window and its candidates (shared by the gateway and the wizard) |
| `src/onboard/telegram-owner.ts` | Catching the owner's first message (direct or through the gateway) and confirming them |
| `src/onboard/autonomy.ts`, `src/onboard/phone.ts` | Chat autonomy/backend read+write; Tailscale status and enabling |
| `src/onboard/summary.ts`, `src/onboard/reminders.ts` | Done-screen summary; skipped-step reminders |
| `src/cli/lifecycle/onboard.ts` | Flags, notice, non-interactive path (modified) |
| `src/cli/lifecycle/onboard-wizard.ts` | Step runner, `ask`, provider and model steps |
| `src/cli/lifecycle/onboard-steps.ts` | Identity, projects, autonomy steps |
| `src/cli/lifecycle/onboard-remote-steps.ts` | Telegram, phone, service, done steps |
| `src/web/admin/onboard.ts` + `api.ts` | Admin methods and their types (modified) |
| `web/src/components/setup/guided-steps.tsx` | Welcome, Identity, Projects, Autonomy panels |
| `web/src/components/setup/remote-steps.tsx` | Telegram live step, Phone (QR through P3's `QrCode`), Done |

---

### Task 1: Telegram sender names and direct approval

**Files:**
- Modify: `src/gateway/telegram/api.ts:5` (`UserSchema`)
- Modify: `test/helpers/telegram-fake-server.ts` (`pushMessage` sender names; `getMe`)
- Modify: `src/gateway/pairing.ts` (`approveSender`)
- Test: `src/gateway/telegram/api.test.ts`, `src/gateway/pairing.test.ts`

**Interfaces:**
- Produces: `UserSchema` gains `last_name?: string`, `username?: string` (so `TgMessage["from"]` carries them).
- Produces: `FilePairing.approveSender(channel: string, senderId: string): Promise<void>`. Approves without a code, is idempotent and drops that sender's pending code. It is not added to the `Pairing` interface, because only setup calls it.
- Produces: `FakeTelegramServer.pushMessage(chatId, fromId, text, opts?: { chatType?: string; from?: { first_name?: string; last_name?: string; username?: string } })`; the fake answers `getMe` with `{ id: 1, is_bot: true, first_name: "Tropos", username: "tropos_bot" }`.

- [ ] **Step 1: Write the failing tests**

```ts
// api.test.ts
test("getUpdates keeps the sender's names and username", async () => {
  const { server, api } = setup();
  server.pushMessage(42, 7, "hi", { from: { first_name: "Panagiotis", last_name: "K", username: "pk" } });
  const [u] = await api.getUpdates(0, 0);
  expect(u!.message!.from).toMatchObject({ id: 7, first_name: "Panagiotis", last_name: "K", username: "pk" });
  expect((await api.getMe()).username).toBe("tropos_bot");
});
// pairing.test.ts
test("approveSender lets a sender in without a code, once, and drops their pending code", async () => {
  const p = make();
  await codeOf(p, "u1");
  await p.approveSender("telegram", "u1");
  await p.approveSender("telegram", "u1");
  expect((await p.list()).filter((a) => a.senderId === "u1")).toHaveLength(1);
  expect(await p.pending()).toEqual([]);
  expect(await p.isApproved("telegram", "u1")).toBe(true);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test src/gateway/telegram/api.test.ts src/gateway/pairing.test.ts`
Expected: FAIL (`username` missing from `from`; `approveSender is not a function`).

- [ ] **Step 3: Implement the schema fields, the fake's `from`/`getMe`, and `approveSender` (same `run()` queue as `approve`; `approvedAt: now`)**

- [ ] **Step 4: Run the tests and typecheck**

Run: `bun test src/gateway/telegram src/gateway/pairing.test.ts && bun run typecheck`
Expected: PASS

- [ ] **Step 5: Stage**

```bash
git add src/gateway/telegram/api.ts src/gateway/telegram/api.test.ts test/helpers/telegram-fake-server.ts src/gateway/pairing.ts src/gateway/pairing.test.ts
```

---

### Task 2: The owner claim and catching the owner's first message

**Files:**
- Create: `src/gateway/owner-claim.ts`, `src/gateway/owner-claim.test.ts`
- Create: `src/onboard/telegram-owner.ts`, `src/onboard/telegram-owner.test.ts`
- Modify: `src/onboard/engine.ts` (`OnboardDeps`, `OnboardError`), `src/onboard/testing.ts` (defaults), `src/web/admin/api.ts` (onboarding section)

**Interfaces:**
- Consumes: `FilePairing.approveSender` (Task 1); C1 `FilePairing.setOwner`.
- Produces (`api.ts`): `interface OwnerCandidateView { senderId: string; chatId: number; name: string; username?: string; at: number }`.
- Produces (`src/gateway/owner-claim.ts`):
  - `OWNER_CLAIM_MINUTES = 10`; `ownerClaimPath(home) = <home>/gateway/owner-claim.json`
  - `candidateFrom(msg: TgMessage, now: number): OwnerCandidateView | null`. Returns null for bots, non-private chats and messages without a sender. `name` is first and last name joined.
  - `class OwnerClaimStore` with `constructor(home: string, now?: () => number)`, `open(): Promise<void>` (start or extend the window to now + 10 min, keep candidates; file 0600), `isOpen(): Promise<boolean>`, `add(c): Promise<void>` (only while open; one entry per sender, latest wins; at most 5, newest kept), `candidates(): Promise<OwnerCandidateView[]>` (newest first; `[]` when closed, expired, missing or corrupt), `close(): Promise<void>` (deletes the file).
- Produces (`src/onboard/engine.ts`):
  - `class OnboardError extends Error`: a message to show the user as is.
  - `OnboardDeps` gains `alive(pid: number): boolean` (default `pidAlive`) and `telegramBaseUrl?: string` (tests). `testDeps` sets `alive: () => false`.
- Produces (`src/onboard/telegram-owner.ts`):
  - `type ListenMode = "direct" | "gateway"`
  - `describeCandidate(c): string`: `"Panagiotis K (@pk)"`, `"Panagiotis K"`, or `"Telegram user 7"`.
  - `telegramListenMode(deps): Promise<ListenMode>`: `"gateway"` when `gateway/state.json` names a live pid with `telegram: true`.
  - `class BotBusyError extends OnboardError`
  - `nextOwnerCandidate(deps, token, opts: { mode: ListenMode; signal: AbortSignal; exclude?: ReadonlySet<string>; pollMs?: number }): Promise<OwnerCandidateView | null>` (null when the signal fires first)
  - `confirmOwner(deps, token, c: OwnerCandidateView): Promise<void>` calls `approveSender`, then `setOwner`, then closes the claim, then sends `OWNER_GREETING` to `c.chatId`.
  - `OWNER_GREETING = "You're connected. This chat now talks to Tropos on your computer; send me anything."`

Direct mode, which the signature does not fix: loop `getUpdates(offset, 10 s, signal)`, advance `offset` past each update, and return the first `candidateFrom` not in `exclude`. Acknowledge it first with one `getUpdates(offset, 0)`, so the gateway never replays it. A `TelegramError` with status 409 becomes `BotBusyError("Another program is reading this bot's messages right now. Stop it, or do this step from the dashboard, and try again.")`. Gateway mode: `open()` the claim, then every `pollMs` (default 1000) return the newest candidate not excluded.

- [ ] **Step 1: Write the failing tests**

```ts
// owner-claim.test.ts
test("open → add → candidates, one per sender, at most five, closed after 10 minutes, file 0600", async () => {
  let t = 0; const store = new OwnerClaimStore(home, () => t);
  await store.add(cand("0")); expect(await store.candidates()).toEqual([]); // closed: ignored
  await store.open();
  for (const id of ["1", "2", "3", "4", "5", "6", "2"]) await store.add(cand(id));
  expect((await store.candidates()).map((c) => c.senderId)).toEqual(["2", "6", "5", "4", "3"]);
  expect(((await stat(ownerClaimPath(home))).mode & 0o777).toString(8)).toBe("600");
  t += 10 * 60_000 + 1; expect(await store.isOpen()).toBe(false);
  await writeFile(ownerClaimPath(home), "{oops"); expect(await store.candidates()).toEqual([]);
});
test("candidateFrom skips bots and groups", () => { /* is_bot → null; chat.type "group" → null; names joined */ });

// telegram-owner.test.ts (FakeTelegramServer; deps = testDeps(home, { telegramBaseUrl: server.baseUrl }))
test("direct: the first private human sender, with names; excluded ids skipped; acknowledged", async () => {
  server.pushMessage(-100, 5, "group", { chatType: "group" });
  server.pushMessage(42, 9, "me first");
  server.pushMessage(42, 7, "hi", { from: { first_name: "Panagiotis", username: "pk" } });
  const c = await nextOwnerCandidate(deps, server.token, { mode: "direct", signal: AbortSignal.timeout(5_000), exclude: new Set(["9"]) });
  expect(c).toMatchObject({ senderId: "7", chatId: 42, name: "Panagiotis", username: "pk" });
  expect(server.getUpdatesOffsets.at(-1)).toBeGreaterThan(server.getUpdatesOffsets[0]!);
});
test("direct: a 409 is a BotBusyError with a plain message", async () => {
  const fetch = (async () => Response.json({ ok: false, error_code: 409, description: "Conflict: terminated by other getUpdates request" }, { status: 409 })) as unknown as typeof globalThis.fetch;
  await expect(nextOwnerCandidate(testDeps(home, { fetch }), "1:x", { mode: "direct", signal: AbortSignal.timeout(2_000) })).rejects.toThrow("Another program is reading this bot's messages");
});
test("gateway: opens the claim and returns what the gateway recorded; null on timeout", async () => {
  const pending = nextOwnerCandidate(deps, "1:x", { mode: "gateway", signal: AbortSignal.timeout(2_000), pollMs: 5 });
  await Bun.sleep(20); await new OwnerClaimStore(home).add(cand("7"));
  expect((await pending)?.senderId).toBe("7");
  expect(await nextOwnerCandidate(deps, "1:x", { mode: "gateway", signal: AbortSignal.timeout(30), pollMs: 5, exclude: new Set(["7"]) })).toBeNull();
});
test("confirmOwner approves, sets the owner, closes the claim and greets", async () => {
  await new OwnerClaimStore(home).open();
  await confirmOwner(deps, server.token, cand("7", 42));
  const pairing = new FilePairing({ path: join(home, "gateway", "pairing.json") });
  expect(await pairing.isApproved("telegram", "7")).toBe(true);
  expect(await pairing.owner()).toEqual({ channel: "telegram", senderId: "7" });
  expect(await new OwnerClaimStore(home).isOpen()).toBe(false);
  expect(server.textsTo(42)).toEqual([OWNER_GREETING]);
});
test("telegramListenMode is gateway only for a live gateway that reads Telegram", async () => { /* state.json {pid, telegram:true}: alive→true ⇒ "gateway"; alive→false or telegram:false ⇒ "direct" */ });
test("describeCandidate", () => { /* the three forms above */ });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test src/gateway/owner-claim.test.ts src/onboard/telegram-owner.test.ts`
Expected: FAIL (modules not found).

- [ ] **Step 3: Implement `owner-claim.ts` (atomic write like `flags.ts`), the `OnboardDeps` fields, and `telegram-owner.ts`. `TelegramApi` gets `baseUrl: deps.telegramBaseUrl`**

- [ ] **Step 4: Run the tests and typecheck**

Run: `bun test src/gateway/owner-claim.test.ts src/onboard && bun run typecheck`
Expected: PASS

- [ ] **Step 5: Stage**

```bash
git add src/gateway/owner-claim.ts src/gateway/owner-claim.test.ts src/onboard/telegram-owner.ts src/onboard/telegram-owner.test.ts src/onboard/engine.ts src/onboard/testing.ts src/web/admin/api.ts
```

---

### Task 3: The gateway records first contact while setup listens

**Files:**
- Modify: `src/gateway/telegram/adapter.ts:29` (options), `:235-271` (`handleMessage`)
- Modify: `src/gateway/daemon.ts:278` (wire the store)
- Test: `src/gateway/telegram/adapter.test.ts`

**Interfaces:**
- Consumes: `OwnerClaimStore`, `candidateFrom` (Task 2).
- Produces: `TelegramAdapterOptions.ownerClaim?: Pick<OwnerClaimStore, "isOpen" | "add">`, and `export const CLAIM_REPLY = "Got it. Go back to the setup on your computer and confirm it's you."`

Behaviour: when a message comes from an unapproved sender and `ownerClaim.isOpen()`, the gateway records `candidateFrom(msg)` and replies `CLAIM_REPLY` once per sender per process. No pairing code is issued and nothing reaches a session. When the claim is closed, the existing pairing path runs unchanged. The daemon passes `ownerClaim: new OwnerClaimStore(run.home)`.

- [ ] **Step 1: Write the failing tests** (`setup()` gains an `ownerClaim` option; `fakeClaim(open)` returns `{ isOpen, add, added: [] }`)

```ts
test("while setup listens, a stranger is recorded with their names and told to confirm, never given a code", async () => {
  const claim = fakeClaim(true);
  const { server, sessions, pairing } = await setup({ approved: false, ownerClaim: claim });
  server.pushMessage(CHAT, CHAT, "hello", { from: { first_name: "Pan", username: "pk" } });
  await server.waitFor(() => server.sent.length >= 1);
  expect(server.sent[0]!.text).toBe(CLAIM_REPLY);
  expect(claim.added[0]).toMatchObject({ senderId: String(CHAT), name: "Pan", username: "pk" });
  expect(pairing.challenges).toEqual([]);
  expect(sessions.sessions.size).toBe(0);
});
test("with the claim closed, strangers get today's pairing code", async () => { /* fakeClaim(false): text contains pairing.code */ });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test src/gateway/telegram/adapter.test.ts`
Expected: FAIL (the code message is sent; `added` is empty).

- [ ] **Step 3: Implement the option, the branch before `handleStranger`, and the daemon wiring**

- [ ] **Step 4: Run the tests and typecheck**

Run: `bun test src/gateway && bun run typecheck`
Expected: PASS

- [ ] **Step 5: Stage**

```bash
git add src/gateway/telegram/adapter.ts src/gateway/telegram/adapter.test.ts src/gateway/daemon.ts
```

---

### Task 4: Finding the user's repositories

**Files:**
- Create: `src/onboard/projects-scan.ts`, `src/onboard/projects-scan.test.ts`
- Modify: `src/web/admin/api.ts` (`RepoCandidateView`)

**Interfaces:**
- Consumes: `listProjects`, `addProject`, `ProjectError` (`src/gateway/projects.ts`); `workspaceProblem` (`src/gateway/policy.ts`).
- Produces:
  - `interface RepoCandidateView { path: string; name: string; touchedAt: number; recent: boolean; registered: boolean }` (`api.ts`)
  - `SCAN_ROOTS = ["Desktop", "Documents", "Developer", "code", "Projects", "src", "dev"] as const`
  - `SCAN_LIMITS = { maxDepth: 3, timeMs: 3_000, maxRepos: 50, recentDays: 30 } as const`
  - `scanForRepos(opts: { home: string; userHome: string; now(): number; roots?: readonly string[]; limits?: Partial<typeof SCAN_LIMITS> }): Promise<{ repos: RepoCandidateView[]; truncated: boolean }>`
  - `addScannedProjects(home: string, paths: string[], userHome: string): Promise<{ added: string[]; failed: { path: string; error: string }[] }>`

The scan works like this:
- Breadth-first under each existing `<userHome>/<root>`, using `readdir(withFileTypes)`. Only real directories are followed; symlinks never are.
- Names starting with `.` and `node_modules` are skipped.
- A directory with a `.git` entry (directory or file) is a repo and is not descended into. Children of a root are depth 1.
- Results are deduplicated by realpath. Anything `workspaceProblem` refuses is dropped.
- `touchedAt` is the newest mtime of `.git/index`, `.git/HEAD`, `.git/logs/HEAD` and `.git/FETCH_HEAD` (or of the `.git` file itself). `recent` means `now − touchedAt ≤ 30 days`. `registered` means the realpath is already a project path.
- Results are ordered recent first, then by `touchedAt` descending.
- `opts.now()` is checked before each directory read. `truncated` is set when the time or count limit stops the scan.
- `addScannedProjects` calls `addProject(home, { path }, { userHome, reuse: true })` for each path, and a `ProjectError` message goes to `failed`.

- [ ] **Step 1: Write the failing tests** (temp `userHome`; `repo(path, ageDays)` makes `<path>/.git/index` and sets its mtime with `utimes`)

```ts
test("finds repos under the common folders; skips hidden, node_modules, repo insides and anything past depth 3", async () => {
  await repo("code/app", 1); await repo("code/app/vendor/inner", 1); await repo("Projects/org/tool", 2);
  await repo("Developer/a/b/deep3", 3); await repo("Developer/a/b/c/too-deep", 3);
  await repo("code/.hidden/x", 1); await repo("code/node_modules/y", 1); await repo("Music/z", 1);
  const { repos, truncated } = await scanForRepos({ home, userHome, now: () => NOW });
  expect(repos.map((r) => r.name).sort()).toEqual(["app", "deep3", "tool"]);
  expect(truncated).toBe(false);
});
test("only repos touched in the last 30 days are recent, and they come first", async () => {
  await repo("code/old", 40); await repo("code/new", 10);
  expect((await scanForRepos({ home, userHome, now: () => NOW })).repos.map((r) => [r.name, r.recent])).toEqual([["new", true], ["old", false]]);
});
test("a symlink loop is not followed and a slow tree stops at the time limit", async () => {
  await symlink(join(userHome, "code"), join(userHome, "code", "loop"));
  let t = 0;
  const r = await scanForRepos({ home, userHome, now: () => (t += 1_000), limits: { timeMs: 2_500 } });
  expect(r.truncated).toBe(true);
});
test("registered repos are marked; addScannedProjects adds once and reports a refused path plainly", async () => {
  /* register code/app first → registered: true; add [app, tool, userHome] → added [tool], failed[0].error mentions "home directory" */
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test src/onboard/projects-scan.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `scanForRepos` and `addScannedProjects`**

- [ ] **Step 4: Run the tests and typecheck**

Run: `bun test src/onboard/projects-scan.test.ts && bun run typecheck`
Expected: PASS

- [ ] **Step 5: Stage**

```bash
git add src/onboard/projects-scan.ts src/onboard/projects-scan.test.ts src/web/admin/api.ts
```

---

### Task 5: Saving the identity from setup

**Files:**
- Modify: `src/context/identity.ts:292-314` (move validation and write out of the tool's `set`)
- Create: `src/onboard/copy.ts`, `src/onboard/copy.test.ts`
- Test: `src/context/identity.test.ts`

**Interfaces:**
- Produces (`identity.ts`): `type IdentityFields = Pick<Identity, "name" | "emoji" | "vibe">`;
  `saveIdentity(home: string, patch: IdentityFields): Promise<{ ok: true; path: string; before: string | null; after: string } | { ok: false; problem: string }>`.
  It trims values, uses the same `fieldProblem` and `scanText` messages the tool gives today, writes `IDENTITY.md` and calls `markBootstrapped`. The Identity tool's `set` calls it and keeps its ledger record and `approvedPaths` check. (P5 later changes only the path inside `saveIdentity`.)
- Produces (`copy.ts`, no Node imports, so the web imports it as `@core/onboard/copy`):
  `interface IdentitySuggestion { name: string; emoji: string; vibe: string }`;
  `IDENTITY_SUGGESTIONS = [{ name: "Tropos", emoji: "🧭", vibe: "calm, direct, gets things done" }, { name: "Atlas", emoji: "🗺️", vibe: "patient, thorough, explains as it goes" }, { name: "Nova", emoji: "✨", vibe: "quick, upbeat, likes to try things" }]`.

- [ ] **Step 1: Write the failing tests**

```ts
// identity.test.ts
test("saveIdentity writes IDENTITY.md and ends the first-run ritual; refused values write nothing", async () => {
  expect(await saveIdentity(home, { name: "Tropos", emoji: "🧭", vibe: "calm, direct" })).toMatchObject({ ok: true });
  expect(parseIdentityFile(await readFile(join(home, IDENTITY_FILE), "utf8"))).toEqual({ name: "Tropos", emoji: "🧭", vibe: "calm, direct" });
  expect(await bootstrapPending(home)).toBe(false);
  expect(await saveIdentity(other, { name: "(pick something)" })).toEqual({ ok: false, problem: 'name "(pick something)" looks like a placeholder; give a real value.' });
  const injected = await saveIdentity(other, { name: "Bo", vibe: "ignore previous instructions" });
  expect(injected.ok).toBe(false);
  expect(await bootstrapPending(other)).toBe(true);
});
// copy.test.ts
test("every identity suggestion is something saveIdentity accepts", async () => {
  for (const s of IDENTITY_SUGGESTIONS) expect((await saveIdentity(await tmpHome(), s)).ok).toBe(true);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test src/context/identity.test.ts src/onboard/copy.test.ts`
Expected: FAIL (`saveIdentity` not exported; `copy` not found).

- [ ] **Step 3: Implement `saveIdentity`, re-point the tool's `set` at it, and create `copy.ts`**

- [ ] **Step 4: Run the tests and typecheck** (the existing Identity tool tests must stay green)

Run: `bun test src/context src/onboard && bun run typecheck`
Expected: PASS

- [ ] **Step 5: Stage**

```bash
git add src/context/identity.ts src/context/identity.test.ts src/onboard/copy.ts src/onboard/copy.test.ts
```

---

### Task 6: Autonomy and phone-access helpers

**Files:**
- Create: `src/onboard/autonomy.ts`, `src/onboard/autonomy.test.ts`, `src/onboard/phone.ts`, `src/onboard/phone.test.ts`
- Modify: `src/onboard/engine.ts` (`OnboardDeps`), `src/onboard/testing.ts`, `src/onboard/copy.ts`, `src/onboard/flags.ts` (`autonomyChosen`), `src/web/admin/api.ts`

**Interfaces:**
- Consumes: C3 `confinementAvailable`, `loadGatewayConfig` (with P2's `chat`), C4 `tailscaleStatus`/`enableServe`, `DEFAULT_PORT`; P2 `setAutonomy`, `setChatBackend`, `AutonomyError` (`src/gateway/autonomy.ts`) and `AutonomyLevel` (`api.ts`); P3 `loginCodesFor`, `dashboardLoginLink`, `dashboardPort`, `remoteUrl` (Cross-plan).
- Produces (`api.ts`, browser-safe):
  - (`AutonomyLevel` is P2's, already in this file since P2 Task 10; it is the same union as C3 `Autonomy`.)
  - `interface ChatSettingsView { autonomy: AutonomyLevel; backend: "host" | "docker"; explicit: boolean; confinement: "sandbox-exec" | "bwrap" | null; allowUnconfined: boolean; installHint?: string }`
  - `interface PhoneStatusView { installed: boolean; running: boolean; dnsName?: string; enabled: boolean; url?: string }`
- Produces (`copy.ts`): `AUTONOMY_CHOICES: readonly { level: AutonomyLevel; label: string; risk: string }[]`:
  - `ask` / "Ask": "Asks before every edit and command. Safest, and the slowest from your phone."
  - `balanced` / "Balanced": "Edits files and runs read-only commands and your tests without asking; asks before anything else."
  - `autonomous` / "Autonomous": "Runs any command in the project without asking, still inside the sandbox; only MCP tools ask."

  Also `TAILSCALE_DOWNLOAD_URL = "https://tailscale.com/download"`.
- Produces (`OnboardDeps`, with defaults in `makeOnboardDeps` and fakes in `testDeps`):
  - `confinement(): Promise<"sandbox-exec" | "bwrap" | null>`. Default `confinementAvailable`; the test default is `"sandbox-exec"`.
  - `which(cmd: string): string | null`. Default `Bun.which`; the test default is `() => null`.
  - `tailscale: { status(): Promise<{ installed: boolean; running: boolean; dnsName?: string }>; enableServe(port: number): Promise<{ url: string; httpsPort: number }> }`. The default calls C4 with `deps.runner`; the test default is `fakeTailscale()`, which is not installed.
  - `login: { oneTimeUrl(): Promise<string>; code(): Promise<string> }`. The default `oneTimeUrl` is P3's `dashboardLoginLink(home, dashboardPort(config))` (`http://localhost:<port>/#login=<key>`) and `code` is `loginCodesFor(home).issueCode()`. The test default is `"http://localhost:4317/#login=ONE-TIME-KEY"` and `"123456"`.
- Produces (`autonomy.ts`):
  - `readChatSettings(deps): Promise<ChatSettingsView>`. `explicit` means the owner chose the level in setup or in Settings: `onboarding.json` has `autonomyChosen: true` (this task also makes P2's `autonomy.set` admin handler set that flag, with a test) (`OnboardingFlags` gains `autonomyChosen?: boolean`, parsed by `readOnboardingFlags`). The raw `chat` key can't tell, because P2's `ensureChatSettings` writes it when the gateway or setup starts. `allowUnconfined` is the raw `chat.allowUnconfined === true`. `installHint` is set only when confinement is null.
  - `class UnconfinedNotConfirmedError extends OnboardError`. Its message: "Without a sandbox, commands from chats would run with your full access. Confirm “run unconfined”, or keep “Ask”."
  - `saveChatSettings(deps, input: { autonomy: AutonomyLevel; backend?: "host" | "docker"; acceptUnconfined?: boolean }): Promise<ChatSettingsView>`. It throws `UnconfinedNotConfirmedError` when the level is not `ask`, the backend is `host`, confinement is null, and neither `acceptUnconfined` nor a stored `chat.allowUnconfined` is set. It never writes `chat` itself: with `confinement = await deps.confinement()` it calls P2's `setChatBackend(home, { backend, acceptUnconfined, confinement })` when the backend changes, then `setAutonomy(home, { level: autonomy, acceptUnconfined, confinement })` (P2 records the consent as `chat.allowUnconfined: true`); a P2 `AutonomyError` becomes an `OnboardError` with the same message. It then sets `autonomyChosen: true` in `onboarding.json`. A comment notes that only terminal and logged-in-dashboard callers reach it.
  - `bwrapInstallCommand(which): string | null` returns the first match, in order: `apt-get` → `sudo apt-get install bubblewrap`, `dnf` → `sudo dnf install bubblewrap`, `pacman` → `sudo pacman -S bubblewrap`, `zypper` → `sudo zypper install bubblewrap`, `apk` → `sudo apk add bubblewrap`.
- Produces (`phone.ts`):
  - The port is P3's `dashboardPort(await loadGatewayConfig(home))` (`webPort ?? DEFAULT_PORT`); this file defines no port helper of its own.
  - `phoneStatus(deps): Promise<PhoneStatusView>` (`url` from P3's `remoteUrl(config.remoteAccess)`)
  - `enablePhoneAccess(deps): Promise<{ url: string; httpsPort: number; code: string }>`. If Tailscale is not running, it throws `OnboardError("Tailscale isn't signed in on this computer yet. Open Tailscale, sign in, then try again.")` and changes nothing. Otherwise it calls P3's `enableRemoteAccess(home, runner)` (the same code path as the `remote.enable` admin method, so the "HTTPS port already served" fallback and its note apply), and returns `login.code()` plus that note. When the gateway is already running (setup re-run), it restarts the service afterwards so the new allowed host takes effect.

- [ ] **Step 1: Write the failing tests**

```ts
// autonomy.test.ts
test("an existing Docker install reads as it is: docker, ask, not yet chosen in setup", async () => {
  await writeFile(join(home, "gateway.json"), JSON.stringify({ chat: { autonomy: "ask", backend: "docker" } }));
  expect(await readChatSettings(testDeps(home))).toMatchObject({ autonomy: "ask", backend: "docker", explicit: false, confinement: "sandbox-exec" });
});
test("saving Balanced on a confined machine writes chat.autonomy and backend host through P2's setters, and marks it chosen", async () => {
  await saveChatSettings(testDeps(home), { autonomy: "balanced", backend: "host" });
  expect(JSON.parse(await readFile(join(home, "gateway.json"), "utf8")).chat).toEqual({ autonomy: "balanced", backend: "host" });
  expect((await readChatSettings(testDeps(home))).explicit).toBe(true);
});
test("without confinement, Balanced needs the unconfined confirmation; Ask never does", async () => {
  const deps = testDeps(home, { confinement: async () => null, which: (c) => (c === "dnf" ? "/usr/bin/dnf" : null) });
  expect((await readChatSettings(deps)).installHint).toBe("sudo dnf install bubblewrap");
  await expect(saveChatSettings(deps, { autonomy: "balanced", backend: "host" })).rejects.toBeInstanceOf(UnconfinedNotConfirmedError);
  await saveChatSettings(deps, { autonomy: "ask", backend: "host" });
  expect((await saveChatSettings(deps, { autonomy: "balanced", backend: "host", acceptUnconfined: true })).allowUnconfined).toBe(true);
  expect(JSON.parse(await readFile(join(home, "gateway.json"), "utf8")).chat.allowUnconfined).toBe(true);
});
test("AutonomyLevel and C3 Autonomy are the same union", () => {
  const a: Autonomy = "balanced" as AutonomyLevel; const b: AutonomyLevel = a; expect(b).toBe("balanced");
});
// phone.test.ts
test("phoneStatus combines Tailscale and remoteAccess", async () => { /* fakeTailscale({running:true,dnsName:"mac.tail1.ts.net"}) + remoteAccess.tailscale true ⇒ enabled, url "https://mac.tail1.ts.net/" */ });
test("enablePhoneAccess serves the dashboard port, saves remoteAccess, returns a code", async () => {
  const ts = fakeTailscale({ installed: true, running: true, dnsName: "mac.tail1.ts.net" });
  const r = await enablePhoneAccess(testDeps(home, { tailscale: ts }));
  expect(ts.served).toEqual([4317]);
  expect(r).toEqual({ url: "https://mac.tail1.ts.net/", httpsPort: 443, code: "123456" });
  expect(JSON.parse(await readFile(join(home, "gateway.json"), "utf8")).remoteAccess).toEqual({ tailscale: true, httpsPort: 443, hostname: "mac.tail1.ts.net" });
});
test("enablePhoneAccess refuses plainly when Tailscale isn't signed in, and writes nothing", async () => { /* running:false → OnboardError message above; no gateway.json */ });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test src/onboard/autonomy.test.ts src/onboard/phone.test.ts`
Expected: FAIL (modules not found).

- [ ] **Step 3: Implement the deps, `autonomy.ts`, `phone.ts`, the copy, and `fakeTailscale` in `testing.ts` (it records `served` ports)**

- [ ] **Step 4: Run the tests and typecheck**

Run: `bun test src/onboard && bun run typecheck`
Expected: PASS

- [ ] **Step 5: Stage**

```bash
git add src/onboard/autonomy.ts src/onboard/autonomy.test.ts src/onboard/phone.ts src/onboard/phone.test.ts src/onboard/engine.ts src/onboard/testing.ts src/onboard/copy.ts src/onboard/flags.ts src/web/admin/api.ts
```

---

### Task 7: The ten steps (C5)

**Files:**
- Modify: `src/web/admin/api.ts:326` (`OnboardStepId`), `src/onboard/engine.ts:184-270, 408-422`, `src/onboard/flags.ts`, `src/onboard/copy.ts`
- Modify: `src/web/admin/onboard.ts` (`STEP_IDS`), `src/cli/lifecycle/onboard.ts` (interim: drop sandbox and pairing), `web/src/app/pages/SetupPage.tsx` (interim mapping)
- Test: `src/onboard/engine.test.ts`, `src/web/admin/onboard.test.ts`, `src/cli/lifecycle/onboard.test.ts`, `web/src/app/pages/SetupPage.test.tsx`

**Interfaces:**
- Consumes: `bootstrapPending`, `loadIdentity`, `saveIdentity` (Task 5); `readChatSettings` (Task 6); C1 `FilePairing.owner()`.
- Produces:
  - `OnboardStepId` exactly as C5.
  - `STEP_ORDER: readonly OnboardStepId[]` (C5 order).
  - `computeOnboardState(deps, opts?: { health?: boolean }): Promise<OnboardState>`. With `health: false` the doctor does not run, and `done` reads `todo`.
  - `skipStep(deps, id): Promise<OnboardState>` records the skip at once. It throws `OnboardError("This step is needed: Tropos can't answer without it.")` for a required id.
  - `markStarted(deps): Promise<void>`: sets `startedAt` and calls P2's `ensureChatSettings(home)`, so a fresh install's `chat` is fixed at balanced/host before the Telegram step approves anyone.
  - Readers reused by Task 11:
    - `telegramState(deps): Promise<{ token: boolean; owner: { channel: string; senderId: string } | null }>`
    - `phoneEnabled(home): Promise<boolean>`
    - `registeredProjectCount(home): Promise<number>`
  - `flags.ts`:
    - `OnboardingFlags` gains `startedAt?: string` and `reminded?: string[]`.
    - `updateOnboardingFlags(home, patch): Promise<OnboardingFlags>` merges into what is there.
    - `finish` now merges, keeping `startedAt` and `reminded`.
    - `reopen` keeps only `reminded`.
  - `copy.ts`: `STEP_WHY: Record<OnboardStepId, string>` (exact copy below).

Titles: `welcome` "Welcome", `provider` "Connect a model", `model` "Choose a model", `identity` "Name and personality",
`projects` "Projects", `autonomy` "Autonomy", `telegram` "Telegram", `phone` "Phone access", `service` "Run in the background", `done` "All set".

`STEP_WHY` (one sentence each):

| Step | `STEP_WHY` |
|---|---|
| welcome | "This takes about 3 minutes; every step after the model can be skipped and done later." |
| provider | "Tropos needs an AI provider to think with." |
| model | "This is the model that answers; the provider's best one is picked for you." |
| identity | "Give your agent a name and a personality, so it feels like yours." |
| projects | "Projects are the folders Tropos may work in when you message it." |
| autonomy | "Choose how much chats may do without asking you first." |
| telegram | "Talk to Tropos from your phone through your own Telegram bot." |
| phone | "Open this dashboard from your phone, privately, through Tailscale." |
| service | "Keep Tropos running in the background, so chats and schedules work when this terminal is closed." |
| done | "A quick health check, then a summary of what is ready." |

Status rules for the new steps:

| Step | Done when | Otherwise |
|---|---|---|
| welcome | `flags.startedAt` set | todo |
| identity | `!bootstrapPending(home)` (detail `🧭 Tropos`, or "You chose not to name it") | todo |
| projects | at least one registered project (detail "N projects") | todo |
| autonomy | `explicit` and backend `host` (detail = the choice's label, plus " on this computer, unconfined" when `allowUnconfined` and confinement is null) | todo. Detail for backend `docker`: "Chats use Docker today. Running them on this computer is faster and keeps the sandbox." Detail when not set: "Default: Balanced." |
| telegram | token and owner (detail "Bot connected; you are the owner") | todo. Detail with a token but no owner: "Bot connected. Message it so I can recognise you." |
| phone | `remoteAccess.tailscale` | todo |
| done | health ok (only with `health: true`) | warn or error from the doctor, as today; todo when `health: false` |

`provider`, `model` and `service` keep today's rules. The `pairing`, `sandbox` and `health` steps are removed; `checkSandbox` stays exported for Settings → Advanced.

Interim, to stay green until Tasks 8–14 replace them:
- The CLI `Wizard` drops its sandbox step and the `checkSandbox` pull in `runFlags`. `--skip-sandbox` is still accepted and does nothing.
- `SetupPage.tsx` uses `STEP_WHY` instead of `SUMMARY`, and `StepBody` maps `provider`, `model`, `telegram` (`TelegramStep`), `service` and `done` (`HealthStep`). The other steps render `{STEP_WHY[id]} For now, set this up in the terminal with <code>tcode onboard</code>.`

- [ ] **Step 1: Write the failing tests** (in `engine.test.ts`, replacing the pairing, sandbox and health state tests)

```ts
test("a bare machine lists the ten steps in order; only provider and model are required", async () => {
  const s = await computeOnboardState(testDeps(home), { health: false });
  expect(s.steps.map((x) => x.id)).toEqual(["welcome", "provider", "model", "identity", "projects", "autonomy", "telegram", "phone", "service", "done"]);
  expect(s.steps.filter((x) => !x.optional).map((x) => x.id)).toEqual(["provider", "model"]);
  expect(["welcome", "identity", "projects", "autonomy", "telegram", "phone", "done"].map((id) => stepOf(s, id).status)).toEqual(Array(7).fill("todo"));
});
test("identity, projects, autonomy, telegram and phone are read from the machine", async () => {
  await saveIdentity(home, { name: "Ada", emoji: "🦊" });
  await writeFile(join(home, "gateway.json"), JSON.stringify({ projects: [{ id: "app", name: "app", path: appDir }], chat: { autonomy: "balanced", backend: "host" }, telegram: { botToken: "1:x" }, remoteAccess: { tailscale: true } }));
  const pairing = new FilePairing({ path: join(home, "gateway", "pairing.json") });
  await pairing.approveSender("telegram", "7"); await pairing.setOwner("telegram", "7");
  await updateOnboardingFlags(home, { autonomyChosen: true });
  const s = await computeOnboardState(testDeps(home), { health: false });
  for (const id of ["identity", "projects", "autonomy", "telegram", "phone"]) expect(stepOf(s, id).status).toBe("done");
});
test("a bot without an owner, and a Docker chat backend, stay todo with what to do next", async () => {
  await writeFile(join(home, "gateway.json"), JSON.stringify({ telegram: { botToken: "1:x" }, chat: { autonomy: "ask", backend: "docker" } }));
  const s = await computeOnboardState(testDeps(home), { health: false });
  expect(stepOf(s, "telegram").detail).toBe("Bot connected. Message it so I can recognise you.");
  expect(stepOf(s, "autonomy").status).toBe("todo");
});
test("skipStep records at once and refuses required steps; finish keeps startedAt and reminded; reopen keeps reminded", async () => {
  const deps = testDeps(home);
  await markStarted(deps); await updateOnboardingFlags(home, { reminded: ["phone"] });
  expect(stepOf(await skipStep(deps, "telegram"), "telegram").status).toBe("skipped");
  await expect(skipStep(deps, "model")).rejects.toThrow("This step is needed");
  await finish(deps);
  expect(await readOnboardingFlags(home)).toMatchObject({ startedAt: "2026-10-15T12:00:00.000Z", skipped: ["telegram"], reminded: ["phone"] });
  await reopen(deps);
  expect(await readOnboardingFlags(home)).toEqual({ reminded: ["phone"] });
});
test("the done step carries the doctor's verdict only when health is asked for", async () => { /* doctor fake with a warn → done "warn"; health:false → "todo" */ });
```

Update the other suites in the same step:
- `admin/onboard.test.ts`: `finish` with `skipped: ["sandbox"]` is refused ("Unknown step").
- `cli onboard.test.ts`: `skipped` becomes `["service", "telegram"]`; the sandbox-pull assertions and the "sandbox: offers to pull" test are removed.
- `SetupPage.test.tsx`: the fixture uses C5 ids, and "0 of 2 required steps done"; the pairing and sandbox tests are removed; Dismiss sends the optional undone ids.

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test src/onboard src/web/admin/onboard.test.ts src/cli/lifecycle/onboard.test.ts web/src/app/pages/SetupPage.test.tsx`
Expected: FAIL (old step ids; `skipStep`/`markStarted` missing).

- [ ] **Step 3: Implement the C5 union, `STEP_ORDER`, the state rules, flags merge, `STEP_WHY`, the admin `STEP_IDS = z.enum(STEP_ORDER)`, and the interim CLI and web mapping**

- [ ] **Step 4: Run the tests and typecheck**

Run: `bun test && bun run typecheck`
Expected: PASS

- [ ] **Step 5: Stage**

```bash
git add src/web/admin/api.ts src/onboard/engine.ts src/onboard/engine.test.ts src/onboard/flags.ts src/onboard/copy.ts src/web/admin/onboard.ts src/web/admin/onboard.test.ts src/cli/lifecycle/onboard.ts src/cli/lifecycle/onboard.test.ts web/src/app/pages/SetupPage.tsx web/src/app/pages/SetupPage.test.tsx
```

---

### Task 8: Terminal wizard: the step runner, welcome, provider and model

**Files:**
- Create: `src/cli/lifecycle/onboard-wizard.ts`, `src/cli/lifecycle/onboard-wizard.test.ts`
- Create: `src/cli/lifecycle/onboard-test-kit.ts` (test-only `wizardIO`, shared by Tasks 8–10)
- Modify: `src/cli/lifecycle/onboard.ts` (HELP, `WELCOME_LINES` + notice, `--advanced`, interactive path → `runWizard`; the `Wizard` class's telegram, service, health and dashboard methods move unchanged into handlers in `onboard-wizard.ts` until Task 10)
- Modify: `src/onboard/engine.ts` (`ValidateResult.reason`, `explainKeyError`, `shortModelList`), `src/onboard/copy.ts` (`WELCOME_LINES`)
- Test: `src/cli/lifecycle/onboard.test.ts`, `src/providers/router.test.ts` (registry key pages)

**Interfaces:**
- Consumes: `STEP_ORDER`, `STEP_WHY`, `computeOnboardState`, `skipStep`, `markStarted`, `finish` (Task 7).
- Produces (`onboard-wizard.ts`):
  - `interface WizardOptions { quick: boolean; advanced: boolean; noOpen: boolean; reset: boolean }`
  - `interface WizardIO { ctx: LifecycleContext; deps: OnboardDeps; cli: OnboardCliDeps; opt: WizardOptions }`
  - `type Answer = { kind: "value"; value: string } | { kind: "skip" } | { kind: "back" }`
  - `ask(io, question, opts?: { default?: string; secret?: boolean; required?: boolean }): Promise<Answer>`:
    - `--quick` returns the default without asking.
    - `""` returns the default.
    - `s`/`skip` returns skip. On a required step it says "This step is needed: Tropos can't answer without a model." and asks again.
    - `b`/`back` returns back.
    - Anything else is the trimmed value.
  - `askYesNo(io, question, defaultYes): Promise<boolean | "skip" | "back">` is `ask` with a `Y/n` / `y/N` default.
  - `type StepOutcome = "next" | "skip" | "back" | "abort"`; `type StepHandler = (io: WizardIO) => Promise<StepOutcome>`
  - `stepsToVisit(state: OnboardState, reset: boolean): OnboardStepId[]`: every step in `STEP_ORDER` except `welcome` whose status is todo, warn or error (all of them with `reset`), with `done` always last.
  - `runSteps(io, handlers: Partial<Record<OnboardStepId, StepHandler>>, visit): Promise<{ aborted: boolean }>`:
    - Prints `\n[k/n] <title>\n<STEP_WHY>\n`.
    - `skip` calls `skipStep` at once for optional steps.
    - `back` moves to the previous visited step, never below the first.
    - A step without a handler counts as `next`.
  - `TERMINAL_STEPS: Partial<Record<OnboardStepId, StepHandler>>` (Tasks 9 and 10 add to it); `providerStep`, `modelStep: StepHandler`.
  - `runWizard(io): Promise<number>` runs `computeOnboardState(deps, { health: false })`, then `runSteps`, then `finish`. It returns 0 when the required steps are done and 1 when aborted or incomplete.
- Produces (`onboard.ts`): `OnboardCliDeps` gains `telegramWaitMs?: number` (used in Task 10). `RISK_NOTICE[2]` becomes "Chats from Telegram run commands on this computer inside its own sandbox, only in the project you picked; the autonomy level you choose decides what they may do without asking."
- Produces (`engine.ts`):
  - `ValidateResult.reason?: "rejected" | "unreachable" | "invalid"`. Input problems are `invalid`. An error matching `/\b40[13]\b|unauthori[sz]ed|invalid.*(key|token)|incorrect api key|authentication/i` is `rejected`. Anything else is `unreachable`.
  - `explainKeyError(providerName, r): string`:
    - rejected: "That key was rejected by {name}. Check you copied all of it."
    - unreachable: "Couldn't reach {name} ({error}). Check your internet connection and try again."
    - invalid: the error as is.
  - `shortModelList(provider, models, n = 5): string[]`: `pickDefaultModel` first, then the other chat-like ids in listing order.
- Produces (`copy.ts`): `WELCOME_LINES = ["Welcome to Tropos. I'll set everything up with you, one short step at a time.", STEP_WHY.welcome, "Enter accepts what I suggest, s skips a step, b goes back. You can stop any time and run `tcode onboard` again to continue."]`.

Provider step:
- Lists the detected connections first ("found: $ANTHROPIC_API_KEY", "found: local server"), then the rest in registry order, so Anthropic comes first.
- The default is the first detected connection, or `1`.
- A detected connection is validated with its own key (`listModels`).
- A provider with a `keyURL`, Anthropic included even though `keyRequired` is false, offers to open that URL (`askYesNo`, default yes, through `cli.openBrowser`). It then asks for the key as a secret, up to 3 tries, printing `explainKeyError` after each failure. An empty answer goes back to the list, and 3 rejections return `abort` (nothing is saved).
- A keyless local provider that is not answering prints "{name} isn't answering on {baseURL}. Start it, then press Enter to check again (b picks another provider)."

Model step: shows `shortModelList` (all models, up to 15, with `--advanced`), with the best model as the default, and saves it with `modelIdFor`.

- [ ] **Step 1: Write the failing tests** (`onboard-test-kit.ts` exports `wizardIO(answers: string[], engine?: OnboardCliDeps["engine"], opt?: Partial<WizardOptions>)`. It builds a `WizardIO` over `makeFixture` and the engine fakes, and exposes `questions`, `opened`, `out()`, `err()` and `home`.)

```ts
test("ask: Enter takes the default, s skips, b goes back; a required question refuses s", async () => {
  const io = wizardIO(["", "s", "b", "s", "x"]);
  expect(await ask(io, "Q", { default: "d" })).toEqual({ kind: "value", value: "d" });
  expect(await ask(io, "Q")).toEqual({ kind: "skip" });
  expect(await ask(io, "Q")).toEqual({ kind: "back" });
  expect(await ask(io, "Q", { required: true })).toEqual({ kind: "value", value: "x" });
  expect(io.out()).toContain("This step is needed");
});
test("stepsToVisit: open steps in order, done last; --reset visits all but welcome", () => { /* fixture states */ });
test("runSteps: s records the skip at once, b returns to the previous step", async () => {
  const visited: string[] = []; const script = ["next", "next", "skip", "back", "next", "next"];
  const h = (id: OnboardStepId): StepHandler => async () => (visited.push(id), script.shift() as StepOutcome);
  await runSteps(io, { provider: h("provider"), model: h("model"), identity: h("identity"), projects: h("projects") }, ["provider", "model", "identity", "projects"]);
  expect(visited).toEqual(["provider", "model", "identity", "projects", "identity", "projects"]);
  expect((await readOnboardingFlags(home)).skipped).toEqual(["identity"]);
});
test("provider: Anthropic without a key opens its key page, explains a rejected key without echoing it, saves a good one", async () => {
  const io = wizardIO(["1", "", "sk-ant-bad-0000", "sk-ant-good"], { anthropicModels: async (k) => { if (k !== "sk-ant-good") throw new Error("401 invalid x-api-key"); return ["claude-opus-5-5"]; } });
  expect(await providerStep(io)).toBe("next");
  expect(io.opened).toEqual(["https://platform.claude.com/settings/keys"]);
  expect(io.err()).toContain("That key was rejected by Anthropic. Check you copied all of it.");
  expect(io.out() + io.err()).not.toContain("sk-ant-bad-0000");
  expect(JSON.parse(await read("credentials.json")).anthropic.apiKey).toBe("sk-ant-good");
});
test("provider: a key in the environment is offered first, validated and not copied", async () => { /* DEEPSEEK_API_KEY=GOOD_KEY; [""] → next; no credentials.json */ });
test("provider: a silent local server says how to start it; b returns to the list", async () => { /* choose ollama, then "b", then deepseek + GOOD_KEY → next */ });
test("provider: three rejected keys abort and save nothing", async () => { /* → "abort"; no credentials.json */ });
test("model: the short list puts the best model first and Enter saves it; --advanced lists them all", async () => { /* 7 models: 5 shown; advanced: 7 shown */ });
test("explainKeyError and the reason of validateKey", () => { /* rejected / unreachable / invalid wording */ });
// router.test.ts
test("every provider that needs a key, and Anthropic, has an https key page; Anthropic is first", () => {
  expect(PROVIDERS[0]!.id).toBe("anthropic");
  for (const p of PROVIDERS.filter((x) => x.keyRequired || x.id === "anthropic")) expect(p.keyURL).toStartWith("https://");
});
```

Rewrite the interactive section of `onboard.test.ts`. A fresh machine walks the steps with scripted answers, the welcome lines and notice show before the confirm, and `--advanced` with `--quick` or `--non-interactive` is a usage error (64). The ported telegram, service and done tests keep their current assertions apart from the step header lines.

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test src/cli/lifecycle/onboard-wizard.test.ts src/cli/lifecycle/onboard.test.ts src/providers/router.test.ts`
Expected: FAIL (module not found; Anthropic tries an empty key).

- [ ] **Step 3: Implement the runner, `ask`/`askYesNo`, provider and model steps, the engine additions, and the `onboard.ts` rewiring. The old `Wizard` class is removed and its telegram, service and done bodies become handlers in `TERMINAL_STEPS`.**

- [ ] **Step 4: Run the tests and typecheck**

Run: `bun test src/cli src/onboard src/providers && bun run typecheck`
Expected: PASS

- [ ] **Step 5: Stage**

```bash
git add src/cli/lifecycle/onboard-wizard.ts src/cli/lifecycle/onboard-wizard.test.ts src/cli/lifecycle/onboard-test-kit.ts src/cli/lifecycle/onboard.ts src/cli/lifecycle/onboard.test.ts src/onboard/engine.ts src/onboard/engine.test.ts src/onboard/copy.ts src/providers/router.test.ts
```

---

### Task 9: Terminal steps: name, projects, autonomy

**Files:**
- Create: `src/cli/lifecycle/onboard-steps.ts`, `src/cli/lifecycle/onboard-steps.test.ts`
- Modify: `src/cli/lifecycle/onboard-wizard.ts` (register in `TERMINAL_STEPS`)

**Interfaces:**
- Consumes: `ask`, `askYesNo`, `WizardIO`, `StepHandler` (Task 8); `saveIdentity`, `IDENTITY_SUGGESTIONS` (Task 5); `scanForRepos`, `addScannedProjects` (Task 4); `readChatSettings`, `saveChatSettings`, `UnconfinedNotConfirmedError`, `AUTONOMY_CHOICES` (Task 6).
- Produces: `identityStep`, `projectsStep`, `autonomyStep: StepHandler`.

Identity:
- Lists the suggestions as `1. 🧭 Tropos: calm, direct, gets things done`. The question is "Pick a number or type a name", with default `1`.
- A typed name then asks "Emoji" and "Vibe", defaulting to the first suggestion's values.
- A problem from `saveIdentity` is printed and the question is asked again.
- `s` prints "Skipped. I'll ask for a name in our first chat." The ritual stays pending.
- `--quick` skips this step, because naming is personal.

Projects:
- Prints "Looking in ~/Desktop, ~/Documents, … (a few seconds)".
- Lists up to 30 repos as `[x] 1. app  ~/code/app  (3 days ago)`. Recent ones are ticked, and registered ones show "(added)".
- "Enter adds the ticked ones; type numbers to tick or untick (e.g. 2 5)" loops until Enter.
- If the scan was truncated, it adds "I stopped looking after a few seconds; add others later with `tcode projects add <path>`."
- If nothing is found: "No git repositories found. Your default workspace is ready; add projects later with `tcode projects add <path>`." and the step returns `next`.
- Add failures are listed in plain words. `--quick` adds the recent ones.

Autonomy:
- With backend `docker`, or always with `--advanced`, it asks "Run chat commands on this computer, inside its own sandbox, instead of Docker?" (default yes). `--advanced` instead asks for the backend as a choice of "1. This computer 2. Docker".
- Then the three choices, each with its risk sentence; the default is the current level, or Balanced when not set.
- If the level is not `ask`, the backend is `host` and confinement is null:
  - It prints why. With an `installHint` it says "Install bubblewrap with: <cmd>, then press Enter to check again (s to continue without it)", and Enter re-checks.
  - Otherwise it asks "Run chat commands without a sandbox anyway? They would have your full access." (default no).
  - Yes saves with `acceptUnconfined`. No saves `ask` and says "Chats will ask before every edit and command until a sandbox is available."

- [ ] **Step 1: Write the failing tests**

```ts
test("identity: Enter takes the first suggestion", async () => { /* [""] → IDENTITY.md has Tropos 🧭 */ });
test("identity: a typed name keeps the suggested emoji and vibe; a refused value is asked again", async () => { /* ["(tbd)", "Ada", "", ""] → problem printed once, Ada 🧭 */ });
test("identity: s leaves the first-chat ritual pending", async () => { expect(await identityStep(wizardIO(["s"]))).toBe("skip"); expect(await bootstrapPending(home)).toBe(true); });
test("projects: recent repos are ticked; numbers toggle; Enter adds the ticked ones", async () => {
  await repo("code/new", 2); await repo("code/old", 60);
  expect(await projectsStep(wizardIO(["2", ""]))).toBe("next");     // ticks "old" as well
  expect((await listProjects(home)).map((p) => p.name).sort()).toEqual(["Default workspace", "new", "old"]);
});
test("projects: nothing found says so and moves on", async () => { /* → next; out contains "No git repositories found" */ });
test("autonomy: Enter keeps Balanced on a confined machine and saves host", async () => { /* chat {autonomy:"balanced",backend:"host"} */ });
test("autonomy: an existing Docker install is asked first; n keeps docker and ask", async () => {
  await writeFile(join(home, "gateway.json"), JSON.stringify({ chat: { autonomy: "ask", backend: "docker" } }));
  expect(await autonomyStep(wizardIO(["n", "1"]))).toBe("next");
  expect(JSON.parse(await read("gateway.json")).chat).toEqual({ autonomy: "ask", backend: "docker" });
});
test("autonomy: without a sandbox it shows the bubblewrap command, then needs an explicit yes; no saves Ask", async () => {
  const eng = { confinement: async () => null, which: (c: string) => (c === "apt-get" ? "/usr/bin/apt-get" : null) };
  await autonomyStep(wizardIO(["", "s", "n"], eng));
  expect(io.out()).toContain("sudo apt-get install bubblewrap");
  expect(JSON.parse(await read("gateway.json")).chat.autonomy).toBe("ask");
});
test("--quick: identity skipped, recent repos added, Balanced saved, nothing asked", async () => { /* questions === [] */ });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test src/cli/lifecycle/onboard-steps.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement the three handlers and register them**

- [ ] **Step 4: Run the tests and typecheck**

Run: `bun test src/cli && bun run typecheck`
Expected: PASS

- [ ] **Step 5: Stage**

```bash
git add src/cli/lifecycle/onboard-steps.ts src/cli/lifecycle/onboard-steps.test.ts src/cli/lifecycle/onboard-wizard.ts
```

---

### Task 10: Terminal steps: Telegram, phone, service, done

**Files:**
- Create: `src/cli/lifecycle/onboard-remote-steps.ts`, `src/cli/lifecycle/onboard-remote-steps.test.ts`
- Create: `src/onboard/summary.ts`, `src/onboard/summary.test.ts`
- Modify: `src/cli/lifecycle/onboard-wizard.ts` (replace the ported handlers), `src/onboard/copy.ts`, `src/web/admin/api.ts`
- Test: `src/cli/lifecycle/onboard.test.ts` (end-to-end walk)

**Interfaces:**
- Consumes: `verifyTelegram`, `saveTelegram`, `telegramState`, `installService`, `healthReport`, `computeOnboardState` (engine); `telegramListenMode`, `nextOwnerCandidate`, `confirmOwner`, `describeCandidate`, `BotBusyError` (Task 2); `phoneStatus`, `enablePhoneAccess` (Task 6); P3 `dashboardPort`; C4 `renderQr`; `OnboardDeps.login`.
- Produces (`api.ts`): `interface SetupSummaryView { steps: { id: OnboardStepId; title: string; status: OnboardStep["status"]; detail?: string }[]; dashboardUrl: string; botUrl?: string; examples: string[]; health: { ok: number; warn: number; error: number; problems: string[] } }`.
- Produces (`summary.ts`): `botUsername(deps): Promise<string | null>` (`getMe` with the saved token; null on any failure) and `setupSummary(deps): Promise<SetupSummaryView>`:
  - every step except welcome and done
  - `dashboardUrl` is `http://localhost:${port}`
  - `botUrl` is `https://t.me/<bot>`
  - `examples` comes from `exampleAsks(first registered project name)`
  - `problems` holds up to 5 warn/error messages
- Produces (`copy.ts`):
  - `BOTFATHER_URL = "https://t.me/BotFather"`
  - `BOTFATHER_STEPS`:
    1. "In Telegram, open @BotFather and send /newbot."
    2. "Pick a name, then a username that ends in “bot”."
    3. "BotFather answers with a token like 123456:ABC-DEF…; copy it and paste it here."
  - `exampleAsks(project?: string): string[]` returns exactly 3, the first naming the project when given:
    1. "What changed in {project} this week?"
    2. "Every weekday at 9, summarise my open pull requests."
    3. "Remember that I deploy on Fridays."
- Produces: `telegramStep`, `phoneStep`, `serviceStep`, `doneStep: StepHandler`.

Telegram:
- First asks "Chat with Tropos from Telegram?" (default yes; `--quick` skips).
- Without a token:
  - It prints the three numbered `BOTFATHER_STEPS` and offers to open `BOTFATHER_URL`.
  - It asks for the token as a secret, up to 3 tries. A failure prints "Telegram didn't accept that token. Copy the whole line BotFather sent; it looks like 123456:ABC-DEF…"
  - Once verified, it saves the token.
- With a token but no owner, it goes straight to listening:
  - Prints "Now send any message to @<bot> in Telegram (https://t.me/<bot>). I'm waiting for it…"
  - The mode comes from `telegramListenMode` and the wait is `cli.telegramWaitMs` (default 120 000).
  - A candidate is asked "{describeCandidate}: is this you?" (default yes). Yes runs `confirmOwner` and prints "You're the owner of @<bot>." No adds the sender to `exclude` and keeps waiting.
  - A timeout asks "No message yet. Enter keeps waiting, s skips."
  - A `BotBusyError` prints its message and returns `skip`.

Phone:
- When Telegram is not done, it first asks "Do you want to open the dashboard from your phone too?" (default no; `--quick` skips).
- Not installed: "Install Tailscale on this computer and on your phone ({TAILSCALE_DOWNLOAD_URL}) and sign in with the same account on both." It offers to open the download page, then "Press Enter when that's done (s skips)" re-checks.
- Installed but not running: "Open Tailscale and sign in, then press Enter."
- Running: `enablePhoneAccess`, then prints `renderQr(url)`, the URL, and "On the phone, open the link (or scan the code) and log in with {code}. The code works for 10 minutes. The page answers once Tropos runs in the background (next step)."

Service: today's body. A system without a service manager gets "Not available here; start Tropos with `tcode gateway` when you need it." and the step returns `next`.

Done:
- Runs `computeOnboardState(deps)` with health, then `setupSummary`.
- Prints `✓`/`–`/`!` lines per step (skipped ones add "(later: `tcode onboard`)"), any health problems with "Run `tcode doctor --fix`.", the dashboard and bot links, and "Try asking:" with the three examples.
- Then it waits up to 10 × 300 ms (`cli.sleep`) for `deps.service.status().running`.
- If the service runs and `--no-open` is not set, it asks "Open the dashboard now (you'll be logged in)?" (default yes) and opens `deps.login.oneTimeUrl()`. Otherwise it prints "Open the dashboard any time with `tcode dashboard`."

- [ ] **Step 1: Write the failing tests** (`FakeTelegramServer`; engine deps `{ telegramBaseUrl: server.baseUrl, fetch }`; `cli.telegramWaitMs: 200`)

```ts
test("telegram: BotFather, token, first message, 'is this you?' → owner; the token is never printed", async () => {
  const io = wizardIO(["", "", server.token, ""]);
  setTimeout(() => server.pushMessage(42, 7, "hi", { from: { first_name: "Panagiotis", username: "pk" } }), 20);
  expect(await telegramStep(io)).toBe("next");
  expect(io.opened).toEqual(["https://t.me/BotFather"]);
  expect(io.questions).toContain("Panagiotis (@pk): is this you?");
  expect(await pairingAt(home).owner()).toEqual({ channel: "telegram", senderId: "7" });
  expect(io.out() + io.err()).not.toContain(server.token);
});
test("telegram: 'n' waits for someone else; silence offers to keep waiting or skip", async () => { /* stranger 9 → "n"; owner 7 → yes; then a second run with no messages and ["s"] → "skip" */ });
test("telegram: with the gateway reading the bot it uses the claim, never getUpdates", async () => {
  /* state.json {pid:4242, telegram:true}, engine alive: () => true, token saved; candidate added to OwnerClaimStore */
  expect(server.getUpdatesOffsets).toEqual([]);
});
test("phone: after Telegram; not installed → download page; signed in → QR, link and the 6-digit code", async () => {
  const ts = fakeTailscale({ installed: true, running: true, dnsName: "mac.tail1.ts.net" });
  await phoneStep(wizardIO([""], { tailscale: ts }));
  expect(io.out()).toContain(renderQr("https://mac.tail1.ts.net/"));
  expect(io.out()).toContain("123456");
});
test("phone: without Telegram it asks first and Enter means no", async () => { /* → "skip"; nothing served */ });
test("service: installs; without a service manager moves on", async () => { /* fakeService(); manager "none" */ });
test("done: summary, health problems, bot link, three examples, then opens the dashboard logged in", async () => {
  expect(io.opened).toEqual(["http://localhost:4317/#login=ONE-TIME-KEY"]);
  expect(io.out()).toContain("Try asking:");
});
test("done: --no-open points to `tcode dashboard`", async () => { /* opened [] */ });
// summary.test.ts
test("setupSummary: steps without welcome/done, dashboard on 4317 or webPort, bot link, three examples naming the first project", async () => { /* … */ });
```

Update the end-to-end test in `onboard.test.ts`: on a fresh machine, scripted answers walk all ten steps, and `onboarding.json` ends with `startedAt`, `dismissedAt` and the `skipped` ids of the steps answered with `s`.

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test src/cli/lifecycle/onboard-remote-steps.test.ts src/onboard/summary.test.ts`
Expected: FAIL (modules not found).

- [ ] **Step 3: Implement `summary.ts`, the copy, and the four handlers; replace the ported ones in `TERMINAL_STEPS`**

- [ ] **Step 4: Run the tests and typecheck**

Run: `bun test src/cli src/onboard && bun run typecheck`
Expected: PASS

- [ ] **Step 5: Stage**

```bash
git add src/cli/lifecycle/onboard-remote-steps.ts src/cli/lifecycle/onboard-remote-steps.test.ts src/onboard/summary.ts src/onboard/summary.test.ts src/cli/lifecycle/onboard-wizard.ts src/cli/lifecycle/onboard.test.ts src/onboard/copy.ts src/web/admin/api.ts
```

---

### Task 11: Skipped-step reminders and `tcode status`

**Files:**
- Create: `src/onboard/reminders.ts`, `src/onboard/reminders.test.ts`
- Modify: `src/onboard/copy.ts` (`REMINDER_TOPICS`), `src/cli/extensions.ts:214-232` (`contextExtras`), `src/cli/runtime.ts:146-150`, `src/cli/lifecycle/status.ts`
- Test: `src/cli/extensions.test.ts`, `src/cli/lifecycle/status.test.ts`

**Interfaces:**
- Consumes: `readOnboardingFlags`, `updateOnboardingFlags` (Task 7); `telegramState`, `phoneEnabled`, `registeredProjectCount`; `bootstrapPending`; `readChatSettings`; C1 `SessionRole`, `AppContext.role`.
- Produces:
  - `REMINDABLE = ["telegram", "phone", "service", "projects"] as const`
  - `openSkippedSteps(deps, known?: { serviceInstalled?: boolean }): Promise<OnboardStepId[]>`: the skipped ids that cheap reads (no doctor, no network) show are still undone, in `STEP_ORDER`.
  - `markReminded(home: string, id: OnboardStepId): Promise<void>`
  - `takeSetupReminder(deps, who: { role: SessionRole; interactive: boolean }): Promise<string>`. It returns `""` unless the session is the owner's and interactive. Otherwise it takes the first `REMINDABLE` step that is still open and not yet reminded, marks it reminded before returning, and returns `setupReminderContext(id)`.
  - `REMINDER_TOPICS` (`copy.ts`):

    | Step | Topic |
    |---|---|
    | telegram | "Telegram, so they can talk to you from their phone" |
    | phone | "phone access, so they can open the dashboard from their phone" |
    | service | "running in the background, so chats and schedules work when the terminal is closed" |
    | projects | "adding their projects, so you can work in them from a chat" |

  - `setupReminderContext(id)` returns exactly:

    ```
    <setup-reminder>
    During setup the user skipped {REMINDER_TOPICS[id]}.
    Mention it once, at a natural pause or at the end of a reply, in one short sentence (for example: "You can reach me from your phone too; want to set up Telegram?"). Never instead of answering. If they want it, tell them to run `tcode onboard` or open Setup in the dashboard. Don't bring it up again.
    </setup-reminder>
    ```

  - `contextExtras` opts gain `reminder?: string`, appended last and only when non-empty. `runtime.ts` resolves it once per agent: a memoised `takeSetupReminder(makeOnboardDeps({ home: ctx.home, env: ctx.env }), { role: ctx.role, interactive: Boolean(opts.interactive) })`, where a failure gives `""`.
  - `Status` gains `setup: { skipped: OnboardStepId[] }`. When it is non-empty, `renderStatus` adds the row `setup  skipped: Telegram, Phone access (finish with \`tcode onboard\`)`, using the step titles.

- [ ] **Step 1: Write the failing tests**

```ts
// reminders.test.ts
const owner = { role: "owner" as const, interactive: true };
test("a skipped step that is still open is reminded once, then never again", async () => {
  await finish(deps, { skipped: ["telegram", "phone"] });
  expect(await takeSetupReminder(deps, owner)).toContain("Telegram, so they can talk to you from their phone");
  expect(await takeSetupReminder(deps, owner)).toContain("phone access");
  expect(await takeSetupReminder(deps, owner)).toBe("");
  expect((await readOnboardingFlags(home)).reminded).toEqual(["telegram", "phone"]);
});
test("guests, scheduled runs and print mode get nothing; a step done since is not reminded", async () => {
  await finish(deps, { skipped: ["projects"] });
  for (const who of [{ role: "guest", interactive: true }, { role: "scheduled", interactive: false }, { role: "owner", interactive: false }] as const) expect(await takeSetupReminder(deps, who)).toBe("");
  await addProject(home, { path: appDir }, { userHome });
  expect(await takeSetupReminder(deps, owner)).toBe("");
});
test("openSkippedSteps lists only skipped steps still undone", async () => { /* skipped identity+projects; identity saved since → ["projects"] */ });
// extensions.test.ts
test("the setup reminder is appended last, only when there is one", async () => {
  const extras = await contextExtras(ext, () => "", { home, scope: "main", reminder: "<setup-reminder>x</setup-reminder>" });
  expect(extras.at(-1)).toBe("<setup-reminder>x</setup-reminder>");
  expect(await contextExtras(ext, () => "", { home, scope: "main" })).toHaveLength(5);
});
// status.test.ts
test("status lists skipped setup steps and how to finish them", async () => {
  /* onboarding.json skipped ["telegram","phone"] */
  expect(fx.stdout()).toContain("skipped: Telegram, Phone access (finish with `tcode onboard`)");
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test src/onboard/reminders.test.ts src/cli/extensions.test.ts src/cli/lifecycle/status.test.ts`
Expected: FAIL (module not found; `reminder` ignored; no setup row).

- [ ] **Step 3: Implement `reminders.ts`, the copy, the `contextExtras` option, the runtime memo, and the status field and row** (`gatherStatus` passes `serviceInstalled` from the service status it already has)

- [ ] **Step 4: Run the tests and typecheck**

Run: `bun test src/onboard src/cli && bun run typecheck`
Expected: PASS

- [ ] **Step 5: Stage**

```bash
git add src/onboard/reminders.ts src/onboard/reminders.test.ts src/onboard/copy.ts src/cli/extensions.ts src/cli/extensions.test.ts src/cli/runtime.ts src/cli/lifecycle/status.ts src/cli/lifecycle/status.test.ts
```

---

### Task 12: Admin methods for the new steps

**Files:**
- Modify: `src/web/admin/api.ts:344-351, 426-431` (`OnboardAdmin`, `ADMIN_METHODS`), `src/web/admin/onboard.ts`
- Test: `src/web/admin/onboard.test.ts`

**Interfaces:**
- Consumes: everything engine-side from Tasks 2–10.
- Produces (`OnboardAdmin` additions):
  ```ts
  "onboard.start": { params: undefined; result: OnboardState };
  "onboard.skip": { params: { id: OnboardStepId }; result: OnboardState };
  "onboard.identity.save": { params: { name: string; emoji?: string; vibe?: string }; result: OnboardState };
  "onboard.projects.scan": { params: undefined; result: { repos: RepoCandidateView[]; truncated: boolean } };
  "onboard.projects.add": { params: { paths: string[] }; result: { added: string[]; failed: { path: string; error: string }[] } };
  "onboard.autonomy.get": { params: undefined; result: ChatSettingsView };
  "onboard.autonomy.set": { params: { autonomy: AutonomyLevel; backend?: "host" | "docker"; acceptUnconfined?: boolean }; result: ChatSettingsView };
  "onboard.telegram.listen": { params: undefined; result: { bot: string; candidates: OwnerCandidateView[] } };
  "onboard.telegram.confirm": { params: { senderId: string }; result: OnboardState };
  "onboard.phone.status": { params: undefined; result: PhoneStatusView };
  "onboard.phone.enable": { params: undefined; result: { url: string; code: string } };
  "onboard.summary": { params: undefined; result: SetupSummaryView };
  ```

Rules:
- zod params: `paths` has at most 50 strings of at most 4096 chars; the identity fields are capped at 40, 8 and 160 chars; `senderId` matches `/^\d{1,20}$/`.
- `OnboardError`, `UnconfinedNotConfirmedError`, `ProjectError` and an identity `problem` become `AdminError` with the same text.
- `telegram.listen` needs `ctx.gateway`; otherwise: "Start Tropos in the background first (the “Run in the background” step), then come back to this step." It also needs a saved token; otherwise: "Add the bot token first." It runs in gateway mode only: it opens or extends the claim and returns `{ bot: botUsername ?? "your bot", candidates }`.
- `telegram.confirm` only accepts a sender that is among the current candidates; otherwise: "That person isn't waiting any more. Ask them to send the bot a message again."
- After `autonomy.set`, `phone.enable` and `telegram.confirm`, the handler calls `ctx.gateway?.reload()`.

- [ ] **Step 1: Write the failing tests** (through `createAdmin(ctx, handlers).handle`, as the existing test does; `ctx.gateway = { reload, runCronNow, devicesChanged }` (P3 Task 6 added `devicesChanged`) with a reload counter)

```ts
test("start, skip and identity.save change the state; required steps can't be skipped", async () => { /* welcome done; telegram skipped; model → "This step is needed" */ });
test("projects.scan finds repos under the user home and projects.add registers them", async () => { /* … */ });
test("autonomy.set refuses unconfined Balanced without confirmation, saves with it, and reloads the gateway", async () => { /* … reloads === 1 */ });
test("telegram.listen needs the gateway and a token; confirm accepts only a waiting sender and makes them the owner", async () => {
  await expect(noGateway.handle("onboard.telegram.listen", undefined)).rejects.toThrow("Start Tropos in the background first");
  await new OwnerClaimStore(home).open(); await new OwnerClaimStore(home).add(cand("7"));
  expect((await admin.handle("onboard.telegram.listen", undefined)).candidates.map((c) => c.senderId)).toEqual(["7"]);
  await expect(admin.handle("onboard.telegram.confirm", { senderId: "9" })).rejects.toThrow("isn't waiting any more");
  await admin.handle("onboard.telegram.confirm", { senderId: "7" });
  expect(await pairingAt(home).owner()).toEqual({ channel: "telegram", senderId: "7" });
});
test("phone.enable returns url and code; summary answers", async () => { /* … */ });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test src/web/admin/onboard.test.ts`
Expected: FAIL (unknown methods).

- [ ] **Step 3: Implement the types, the method list, and the handlers**

- [ ] **Step 4: Run the tests and typecheck**

Run: `bun test src/web && bun run typecheck`
Expected: PASS

- [ ] **Step 5: Stage**

```bash
git add src/web/admin/api.ts src/web/admin/onboard.ts src/web/admin/onboard.test.ts
```

---

### Task 13: Web Setup page: welcome, name, projects, autonomy

**Files:**
- Create: `web/src/components/setup/guided-steps.tsx`
- Modify: `web/src/app/pages/SetupPage.tsx` (`StepBody`, `firstOpenStep`, Skip through `onboard.skip`)
- Test: `web/src/app/pages/SetupPage.test.tsx`

**Interfaces:**
- Consumes: the Task 12 admin methods; `STEP_WHY`, `IDENTITY_SUGGESTIONS`, `AUTONOMY_CHOICES` from `@core/onboard/copy`; existing `useAction`, `Notice`, `LiveRegion`, `Button`, `useRpcResource`.
- Produces: `WelcomeStep({ onChanged })`, `IdentityStep({ onChanged, onSkip })`, `ProjectsStep({ onChanged, onSkip })`, `AutonomyStep({ onChanged })`. `firstOpenStep` opens `welcome` first while it is todo. A step's Skip button calls `onboard.skip` and refreshes, replacing the page's local `skipped` set.

Panels:
- **Welcome:** `STEP_WHY.welcome`, a short ordered list of the step titles, and a "Start" button (`onboard.start`).
- **Identity:** a radio group of the three suggestions (emoji, name, vibe), then name/emoji/vibe fields prefilled from the choice, then "Save" (`onboard.identity.save`) and "Skip: I'll name it in our first chat". A server problem shows in a `Notice`.
- **Projects:** scans when opened. A checklist with recent repos pre-ticked; registered ones checked, disabled, and labelled "already added". The truncation note when it applies. "Add N projects" (`onboard.projects.add`), with failures listed.
- **Autonomy:** a radio group from `AUTONOMY_CHOICES`, each with its risk sentence, and the current level preselected. With backend `docker`, a checkbox "Run chat commands on this computer instead of Docker" (default ticked). Without confinement and a level other than Ask, a warning, the `installHint` in `<code>`, and a required checkbox "Run without a sandbox; I understand commands get my full access". Then "Save".

Each panel keeps the page's tokens, focus-visible styles and reduced-motion handling, and works at 320 px.

- [ ] **Step 1: Write the failing tests** (the `server()` fixture gains handlers for the Task 12 methods)

```ts
test("a fresh setup opens on Welcome; Start calls onboard.start and the provider step opens", async () => { /* aria-expanded on "Welcome"; after Start → "Connect a model" expanded */ });
test("identity: picking Atlas and saving sends its fields", async () => {
  fireEvent.click(await screen.findByRole("radio", { name: /Atlas/ }));
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(socket.adminOf("onboard.identity.save")[0]?.params).toEqual({ name: "Atlas", emoji: "🗺️", vibe: "patient, thorough, explains as it goes" }));
});
test("projects: recent repos are ticked, registered ones locked; Add sends the ticked paths", async () => { /* … */ });
test("autonomy: Balanced is preselected; without a sandbox Save needs the unconfined checkbox", async () => { /* Save disabled until checked; params include acceptUnconfined: true */ });
test("Skip calls onboard.skip and the step reads skipped", async () => { /* … */ });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test web/src/app/pages/SetupPage.test.tsx`
Expected: FAIL (interim placeholder text instead of the panels).

- [ ] **Step 3: Implement the four panels and the `SetupPage` changes**

- [ ] **Step 4: Run the tests and typecheck**

Run: `bun test web && bun run typecheck`
Expected: PASS

- [ ] **Step 5: Stage**

```bash
git add web/src/components/setup/guided-steps.tsx web/src/app/pages/SetupPage.tsx web/src/app/pages/SetupPage.test.tsx
```

---

### Task 14: Web Setup page: Telegram live step, phone QR, done, opening by itself

**Files:**
- Create: `web/src/components/setup/remote-steps.tsx`
- Modify: `web/src/components/setup/host-steps.tsx` (extract `TelegramTokenForm` from `TelegramStep`; `PairingStep` and `SandboxStep` stay exported for Settings, but Setup no longer uses them), `web/src/app/pages/SetupPage.tsx`, `web/src/components/setup/FirstRunRedirect.tsx`
- Test: `web/src/app/pages/SetupPage.test.tsx`, `web/src/components/setup/FirstRunRedirect.test.tsx`

**Interfaces:**
- Consumes: Task 12 methods; `BOTFATHER_URL`, `BOTFATHER_STEPS`, `TAILSCALE_DOWNLOAD_URL` (copy); `HealthStep`; `channels.telegram.set`; P3 Task 15's `QrCode({ text, label })` (`web/src/components/pages/settings/qr-code.tsx`), reused rather than redefined.
- Produces:
  - `TelegramOwnerStep({ onChanged, onSkip })`, `PhoneStep({ onChanged, onSkip })`, `DoneStep({ onChanged })`
  - `TELEGRAM_POLL_MS = 2000`

Telegram:
- Without a token: `BOTFATHER_STEPS` as an ordered list, an "Open BotFather" link (`target="_blank" rel="noopener noreferrer"`), and `TelegramTokenForm`.
- With a token: "Send any message to @bot now", with a link to `https://t.me/<bot>`. It calls `onboard.telegram.listen` on mount and then every `TELEGRAM_POLL_MS`, clearing the interval on unmount.
- Each candidate gets a card "Panagiotis (@pk): is this you?" with [Yes, that's me] (`onboard.telegram.confirm`) and [Not me] (hides that id for this view). An `aria-live` region announces a new sender.

Phone:
- Not installed: the instructions, a download link and "Check again".
- Installed but not signed in: "Open Tailscale and sign in", plus "Check again".
- Signed in: "Turn on phone access" (`onboard.phone.enable`), then P3's `QrCode` with `text` = the URL and `label` "QR code for the dashboard on your phone", the URL, and the 6-digit code large in tabular-nums, with "works for 10 minutes".

Done: the summary lines, the bot link, "Try asking" with the examples, then `HealthStep`.

FirstRunRedirect: while `needsOnboarding`, the first connection of a browser session navigates to `#/setup` once (`sessionStorage` key `tropos.firstRun.opened`; storage errors are ignored). The dismissible card stays for later navigation.

- [ ] **Step 1: Write the failing tests**

```ts
test("telegram: BotFather steps and token form, then 'send a message now' with the waiting sender; Yes confirms them", async () => {
  /* not configured → three listitems + link https://t.me/BotFather; after set: listen returns cand "7" → "Panagiotis (@pk): is this you?" → Yes → confirm {senderId:"7"} */
});
test("telegram: Not me hides that sender", async () => { /* … */ });
test("phone: not installed shows the download link; signed in → Turn on shows the QR, link and code", async () => {
  expect(screen.getByRole("img", { name: /QR code/ })).toBeTruthy();
  expect(screen.getByText("123456")).toBeTruthy();
});
test("done: summary, bot link, examples and the health check", async () => { /* … */ });
// FirstRunRedirect.test.tsx
test("opens #/setup once per browser session while setup is needed", async () => { /* location.hash "#/setup"; second mount does not navigate */ });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test web/src/app/pages/SetupPage.test.tsx web/src/components/setup`
Expected: FAIL

- [ ] **Step 3: Implement the components, the `TelegramTokenForm` extraction, the `SetupPage` mapping (removing the interim placeholder), and the redirect**

- [ ] **Step 4: Run the tests and typecheck**

Run: `bun test web && bun run typecheck`
Expected: PASS

- [ ] **Step 5: Stage**

```bash
git add web/src/components/setup/remote-steps.tsx web/src/components/setup/host-steps.tsx web/src/app/pages/SetupPage.tsx web/src/app/pages/SetupPage.test.tsx web/src/components/setup/FirstRunRedirect.tsx web/src/components/setup/FirstRunRedirect.test.tsx
```

---

### Task 15: README, installer line, and visual checks

**Files:**
- Modify: `README.md:27-34` (the onboarding paragraph), `install.sh:745`

**Interfaces:**
- Consumes: the finished feature.

- [ ] **Step 1: Update the README paragraph** It covers the ten steps in one sentence each; Enter/s/b; that quitting and re-running resumes; Telegram without a pairing code ("send your bot a message and confirm it's you"); and phone access through Tailscale with a code. It covers `--advanced` (also asks where chat commands run and shows every model), `--quick`, and that `--non-interactive` with its flags works as before. It ends with one honest line: "Setup may set chats to Balanced: they edit files and run read-only commands and your tests without asking, inside the OS sandbox; see Autonomy." It links P2's section and does not repeat it. Change the `tcode onboard` comment on line 27 to `# guided setup: model, name, projects, autonomy, Telegram, phone, run-at-login`.

- [ ] **Step 2: Change `install.sh:745` to** `say "  tcode onboard           finish the guided setup"`

- [ ] **Step 3: Run the full gate**

Run: `bun run typecheck && bun test && bun run test:coverage`
Expected: all green, coverage not lower than before.

- [ ] **Step 4: Visual and accessibility checks**

Run `TROPOS_HOME=$(mktemp -d) bun src/index.ts gateway` and open `http://localhost:4317/#/setup`. Take screenshots of the Setup page at 320, 375, 768, 1024 and 1440 px under the light and the dark system color scheme (the app is light-only, as P3 decided): Welcome, Autonomy with the unconfined warning, Telegram waiting with a candidate, Phone with the QR, Done. Expected:
- no horizontal scroll at 320 px;
- the app, and the QR (P3's `QrCode`, dark modules on the light surface), stay light and legible under the dark scheme;
- every step header and button is reachable with Tab and works with Enter/Space;
- with reduced motion emulated, panels appear without animation.

Also run `tcode onboard` in a real terminal on this Mac with a temp `TROPOS_HOME` and walk every step once, including `s` and `b`.

- [ ] **Step 5: Stage**

```bash
git add README.md install.sh
```

---

## Self-review notes

- **Spec coverage:**
  - §4.1, steps 0–9: Tasks 7–10, with the engine pieces in Tasks 2, 4, 5, 6.
  - Per-step rules: Task 8 (`ask`, runner, plain errors) and Task 7 (state from the machine, skips recorded at once).
  - Docker removed: Task 7. `--advanced` and flags: Tasks 8 and 9.
  - Key pages in the registry: they are already `ProviderInfo.keyURL`; Task 8 pins them with a test and makes Anthropic use its page.
  - §4.2: Tasks 12–14 (same engine; Telegram live step; QR; opens by itself).
  - §4.3: Task 11.
- **Type names used across tasks:** `OwnerCandidateView`, `RepoCandidateView`, `ChatSettingsView`, `PhoneStatusView`, `SetupSummaryView` (all `api.ts`), `OnboardError`, `STEP_ORDER`, `StepHandler`, `TERMINAL_STEPS`. Each is defined once, in the task that introduces it. `AutonomyLevel` (P2), `dashboardPort`, `loginCodesFor`, `dashboardLoginLink` and `QrCode` (P3) are reused, never redefined.
- **Proportion:** bodies are left to the implementer except the direct-listen loop, the scan rules and fixed copy, which tests and signatures do not determine.
