# P1 — Owner Role, Learning Everywhere, Saving Without Asking, and the Blocking Fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every session a role (owner, guest, scheduled). Turn learning on for the owner wherever they talk to Tropos. Save memories, journal entries, skills, agents and identity without asking, each with a notice line and undo. Fix the blocking gaps from the 2026-10-16 audit (doc 2 §10, items 1–7, 9–12, 14 and 15).

**Architecture:** `FilePairing` records the owner. The gateway turns each chat key into a `SessionRole` and passes it through `channelContext` into `AppContext.role`. The permission engine reads `role` together with the store list from `src/learning/stores.ts`. When the owner saves through one of the five store tools, and every target is inside those stores, the engine allows it without asking and lets it past confinement. Deny rules, ask rules and asking hooks still win. Owner chat sessions get the learning loop, which now also runs a final review (journal plus memory and skills) when a session ends. Its counters persist per project. The gateway rebuilds contexts and adapters on `reload`. It refreshes skills, commands and agents for each new session, and runs the curator as a service. Telegram forwards notices, runs unknown `/name` through command expansion, and supports `/learned`.

**Tech Stack:** TypeScript on Bun, zod, `bun test` (colocated `*.test.ts`), Vite + React + Testing Library for `web/`.

**Spec:** `docs/superpowers/specs/2026-10-16-growing-agent-design.md` (doc 2: Part F and §10) and `docs/superpowers/specs/2026-10-16-setup-autonomy-access-design.md` (doc 1: owner role §7.2). The binding names are in `docs/superpowers/plans/2026-10-16-contracts.md` (C1, C2).

## Global Constraints

- The names in contracts C1 and C2 are binding: `SessionRole = "owner" | "guest" | "scheduled"` (exported from `src/gateway/types.ts`), `AppContext.role`, `pairing.json` `owner?: { channel; senderId; since }`, `FilePairing.owner() / setOwner() / isOwner()`, `learning.askBeforeSaving?: boolean` (default `false`), and `troposStorePaths(home: string): string[]` in `src/learning/stores.ts`.
- Roles: terminal, `tcode -p` and dashboard sessions are `"owner"`. A chat is `"owner"` only when its sender is the owner, otherwise `"guest"`. Cron runs (and P7's heartbeat) are `"scheduled"`. `origin` keeps its current meaning.
- Learning is on for the owner's chat sessions and the dashboard. It is off for other approved senders and for scheduled runs.
- Saves run without asking, with a notice line and undo. `learning.askBeforeSaving: true` brings back the prompt. "Deny rules and hooks that ask still count as 'no'."
- Telegram shows a notice as "one short line after the answer ('💡 Remembered: you deploy on Fridays')". `/learned` and `/learned undo` work in chat.
- Non-text Telegram messages get the reply "I can only read text for now".
- Everything else in the learning spec stays: the threat scan on write and on load, the learned-skills directory, the ledger, and a curator that never deletes. The memory caps stay at 2,200 characters (memory) and 1,375 (user).
- SessionSearch stays withheld from guest chats. WebFetch stays withheld from every chat.
- On existing installs, a single approved sender becomes the owner. With several approved senders, nobody becomes owner automatically.
- No new runtime dependency.
- Every task ends green on its own tests plus `bun run typecheck`. Following the owner's rule, nothing is committed: each task ends with `git add` of its files.

## Review Focus

1. **The owner is revoked and one approved sender remains.** That sender must not become owner on the next load: the one-time migration must not run again. Tested in Task 1.
2. **The owner is changed or revoked while their chat session is open.** The open session must lose owner powers (store saves, SessionSearch, learning) within one reaper cycle (5 s). Tested in Task 2.
3. **A store folder is a symlink pointing out of `~/.tropos`, for example into the project or `/etc`.** The automatic allow must compare resolved paths, so the call asks (terminal) or is denied (chat). Tested in Task 3.
4. **A final review that hangs.** `shutdown()` gives up after 30 s and aborts the review. `/new` and `/clear` return at once while the final review runs detached. Gateway stop (`closeAll`) runs no final review. Tested in Task 6.
5. **`reload` while a chat turn is running.** The turn finishes on its old context; MCP servers are not closed under it. The session closes after the turn, and its next message resumes the same transcript on a fresh context. Tested in Task 8.

---

### Task 1: Owner in the pairing store

**Files:**
- Modify: `src/gateway/pairing.ts:16-32` (State), `:59-144` (approve, revoke, new methods), `:186-216` (fresh, load)
- Modify: `src/gateway/types.ts:46-55` (the `Pairing` interface)
- Modify: `test/helpers/telegram-fakes.ts` (`FakePairing`)
- Modify: `src/web/admin/api.ts:113-124` (`PairingView`, `PairingAdmin`, `ADMIN_METHODS` list ~`:388`)
- Modify: `src/web/admin/pairing.ts`
- Test: `src/gateway/pairing.test.ts`, `src/web/admin/pairing.test.ts`

**Interfaces:**
- Produces, binding from C1, on the `Pairing` interface (in `types.ts`) and implemented by `FilePairing`:
  - `owner(): Promise<{ channel: string; senderId: string } | null>`
  - `setOwner(channel: string, senderId: string): Promise<void>`: rejects with `Error("only an approved sender can be the owner")` when the sender isn't approved.
  - `isOwner(channel: string, senderId: string): Promise<boolean>`
- Produces, new and defined here:
  - `ownerChatKey(pairing: Pick<Pairing, "owner">): Promise<string | undefined>` in `pairing.ts`. It returns `"<channel>:<senderId>"`; a Telegram private chat's id is the sender's id.
  - The state file gets `version: 2`. Migration runs only on a `version: 1` file. A fresh state is `version: 2` with no owner.
  - `approve()` makes the approved sender owner when the state has no owner and no other approved sender. This covers first pairings made with a code, without the wizard.
  - `revoke()` of the owner also clears `owner`.
  - Admin: `PairingView.owner?: { channel: string; senderId: string }`. New method `"pairing.setOwner": { params: { channel: string; senderId: string }; result: PairingView }`, used by P3 and P4.

- [ ] **Step 1: Write the failing tests** in `src/gateway/pairing.test.ts` (new `describe("owner")`):

```ts
test("a version-1 file with exactly one approved sender gets that sender as owner, written back once", async () => {
  await writeV1(path, { approved: [{ channel: "telegram", senderId: "7", approvedAt: 1 }] });
  const p = new FilePairing({ path });
  expect(await p.isApproved("telegram", "7")).toBe(true); // a read-only call still migrates
  const file = JSON.parse(await readFile(path, "utf8"));
  expect(file.version).toBe(2);
  expect(file.owner).toMatchObject({ channel: "telegram", senderId: "7" });
  expect(typeof file.owner.since).toBe("number");
});
test("a version-1 file with two approved senders gets no owner", ...)   // owner() === null, version 2
test("revoking the owner clears it and the remaining single sender is not promoted", async () => {
  // v1 file with senders 7 and 8; setOwner("telegram","7"); revoke("telegram","7")
  expect(await new FilePairing({ path }).owner()).toBeNull();
});
test("the first approval on a fresh store becomes the owner; the second doesn't", ...)
test("setOwner refuses a sender that isn't approved and switches between approved ones", ...)
test("isOwner is false for another channel with the same sender id", ...)
test("ownerChatKey is telegram:<id> or undefined", ...)
```

In `src/web/admin/pairing.test.ts`: `"pairing.list shows the owner; pairing.setOwner changes it and refuses strangers"`.

- [ ] **Step 2: Run the tests and check they fail**

Run: `bun test src/gateway/pairing.test.ts src/web/admin/pairing.test.ts`
Expected: FAIL (`owner is not a function`, `version` is 1).

- [ ] **Step 3: Implement.** `load()` returns `{ state, migrated }`. `run()` saves whenever `migrated` is true, even for calls that don't otherwise write (`mutates = false`). `setOwner` and `revoke` go through `run()`. Extend `Pairing` in `types.ts` with the three methods, and `FakePairing` with an `owners: Set<string>` field plus the three methods. In `pairingHandlers`: `pairing.list` adds `owner`, and add the `pairing.setOwner` handler (`AdminError` with the store's message).

- [ ] **Step 4: Run the tests and check they pass**

Run: `bun test src/gateway/pairing.test.ts src/web/admin/pairing.test.ts src/gateway/telegram && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Stage**

```bash
git add src/gateway/pairing.ts src/gateway/pairing.test.ts src/gateway/types.ts test/helpers/telegram-fakes.ts src/web/admin/api.ts src/web/admin/pairing.ts src/web/admin/pairing.test.ts
```

---

### Task 2: A role for every session, and what each role may use

**Files:**
- Modify: `src/gateway/types.ts` (add `SessionRole`)
- Modify: `src/cli/runtime.ts:42-67` (`AppContext.role`)
- Modify: `src/cli/main.tsx:274-289`, `src/cli/context.ts:73-89` (`role: "owner"`)
- Modify: `src/gateway/policy.ts:14-56`
- Modify: `src/gateway/revocation.ts`
- Modify: `src/gateway/daemon.ts:203-230` (resolve the role, pass it on, remember it per key), `:383-391` (reaper)
- Modify: `src/cli/runtime.test.ts:26-42` (fixture `role: "owner"`)
- Test: `src/gateway/policy.test.ts`, `src/gateway/revocation.test.ts`

**Interfaces:**
- Consumes: `Pairing.isOwner` (Task 1).
- Produces:
  - `export type SessionRole = "owner" | "guest" | "scheduled"` in `src/gateway/types.ts` (C1).
  - `AppContext.role: SessionRole` (C1). It is required: `main.tsx` and `loadProjectContext` set `"owner"`.
  - `channelContext(base: AppContext, exec: ExecBackend, opts: { role: SessionRole }): AppContext`. The third parameter is new and required. It is an options object so P2 can add `autonomy?: () => AutonomyPolicy` to it (C9).
  - `chatRole(chatKey: string, pairing: Pick<Pairing, "isOwner">): Promise<SessionRole>` in `policy.ts`. A key starting `project:` gives `"scheduled"`. `telegram:<digits>` gives `"owner"` when that sender is the owner. Anything else, including group ids (negative), gives `"guest"`.
  - `privateTelegramSender` is exported from `revocation.ts`.
  - `ReapOptions` gains `isOwner(channel: string, senderId: string): Promise<boolean>` and `roleOf(key: string): SessionRole | undefined`. A session created as `"owner"` whose sender is no longer the owner is closed.

- [ ] **Step 1: Write the failing tests** in `policy.test.ts`. Existing calls become `channelContext(base(), exec, { role: "guest" })`.

```ts
test("the role is carried on the context", () => {
  expect(channelContext(base(), exec, { role: "owner" }).role).toBe("owner");
});
test("the owner's chat gets SessionSearch, never WebFetch; a guest and a scheduled run get neither", () => {
  expect(names("owner")).toEqual(["Read", "Bash", "SessionSearch", "mcp__gh__list"]);
  expect(names("guest")).toEqual(["Read", "Bash", "mcp__gh__list"]);
  expect(names("scheduled")).toEqual(["Read", "Bash", "mcp__gh__list"]);
});
test("learning: the review stays on for the owner and is off for guests and scheduled runs; the curator is off in every chat", () => {
  expect(channelContext(base(), exec, { role: "owner" }).settings.learning).toMatchObject({ review: true, curator: false });
  for (const r of ["guest", "scheduled"] as const) expect(channelContext(base(), exec, { role: r }).settings.learning).toMatchObject({ review: false, curator: false });
});
describe("chatRole", () => {
  test("project keys are scheduled; the owner's private chat is owner; others and groups are guests", async () => {
    const pairing = { isOwner: async (c: string, s: string) => c === "telegram" && s === "7" };
    expect(await chatRole("project:app", pairing)).toBe("scheduled");
    expect(await chatRole("telegram:7", pairing)).toBe("owner");
    expect(await chatRole("telegram:8", pairing)).toBe("guest");
    expect(await chatRole("telegram:-1007", pairing)).toBe("guest");
  });
});
```

In `revocation.test.ts`: `"a session opened as owner is closed once its sender is no longer the owner; a guest session of the same sender stays"`.

- [ ] **Step 2: Run the tests and check they fail**

Run: `bun test src/gateway/policy.test.ts src/gateway/revocation.test.ts`
Expected: FAIL (`chatRole` not exported; SessionSearch missing for the owner).

- [ ] **Step 3: Implement.** In `policy.ts`, WebFetch is always withheld and SessionSearch is withheld unless `role === "owner"`; delete the old comment that justified hiding SessionSearch from every chat. The learning settings are `{ ...base.settings.learning, curator: false }` for the owner (the gateway runs the curator as a service, Task 13) and `{ review: false, curator: false }` for the other roles. In `daemon.ts`, the pool's `create` calls `chatRole(chatKey, run.pairing)`, passes it to `channelContext` as `{ role }`, and records it in `roles: Map<string, SessionRole>`. The reaper passes `isOwner` and `roleOf: (k) => roles.get(k)`.

- [ ] **Step 4: Run the tests and check they pass**

Run: `bun test src/gateway src/cli/runtime.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Stage**

```bash
git add src/gateway/types.ts src/cli/runtime.ts src/cli/main.tsx src/cli/context.ts src/gateway/policy.ts src/gateway/policy.test.ts src/gateway/revocation.ts src/gateway/revocation.test.ts src/gateway/daemon.ts src/cli/runtime.test.ts
```

---

### Task 3: Saving to Tropos's own stores without asking (C2; §10 items 1 and 4)

**Files:**
- Create: `src/learning/stores.ts`, `src/learning/stores.test.ts`
- Modify: `src/config/settings.ts:47-56, 126, 226-233` (`askBeforeSaving`)
- Modify: `src/permissions/engine.ts:35-43` (context), `:145-173` (`decide`)
- Modify: `src/cli/runtime.ts:142, 272` (one shared permission-context builder)
- Modify: `src/gateway/policy.ts` (withhold store tools from guests and scheduled runs)
- Test: `src/permissions/engine.test.ts`, `src/config/settings.test.ts`, `src/gateway/policy.test.ts`

**Interfaces:**
- Consumes: `SessionRole` and `AppContext.role` (Task 2).
- Produces:
  - `LearningSettings.askBeforeSaving: boolean`, default `false`. It is user-layer only, like the rest of `learning`; repo layers already ignore `learning`.
  - In `src/learning/stores.ts`:
    - `export const STORE_TOOLS = ["Memory", "DailyNote", "SkillManage", "AgentManage", "Identity"] as const`
    - `export function troposStorePaths(home: string): string[]` (C2). It returns canonical paths (through `resolveToolPath(…, "/")`) of `<home>/memories`, `<home>/skills`, `<home>/skills-learned`, `<home>/agents`, `<home>/IDENTITY.md`, `<home>/SOUL.md` and `<home>/identity.json`. P5 and P6 append to this list.
  - `PermissionContext` gains `role?: SessionRole` and `stores?: { paths: string[]; askBeforeSaving: boolean }`.
  - `export function isStoreSave(req: PermissionRequest, ctx: PermissionContext): boolean` in `engine.ts`. It is true when `req.toolName` is in `STORE_TOOLS`, `req.paths` is not empty, and every path, resolved with `resolveToolPath(p, "/")`, is inside one of `ctx.stores.paths`. A path that won't resolve gives `false`.
  - `permissionContext(ctx: AppContext, mode: Mode): PermissionContext` in `runtime.ts`. It sets `stores.paths = [...troposStorePaths(ctx.home), dailyNotesDir(ctx.home, ctx.cwd)]`, because the journal is per project until P5 moves it (P5 Task 6 renames that entry to `legacyNotesDir`; the journal then sits in `troposStorePaths`).
- The order inside `decide`:
  1. Deny rules.
  2. Confinement, unless `role === "owner" && isStoreSave`.
  3. Bypass.
  4. Plan mode (still refuses edits).
  5. Ask rules.
  6. Allow, when `role === "owner" && isStoreSave && !askBeforeSaving`.
  7. Everything else as today.
- Asking hooks already turn an allow into an ask (`src/agent/agent.ts:473`).

- [ ] **Step 1: Write the failing tests.** In `engine.test.ts`, under `describe("decide — saving to Tropos's stores")`, use a temp home made with `makeTmpDir`.

```ts
const owner = (over = {}) => ctx({ role: "owner", stores: { paths: troposStorePaths(home), askBeforeSaving: false }, ...over });
const memory = (p: string): PermissionRequest => ({ toolName: "Memory", kind: "edit", paths: [p] });
test("the owner's Memory save inside the store is allowed without asking", () => {
  expect(decide(memory(join(home, "memories", "MEMORY.md")), owner())).toEqual({ behavior: "allow" });
});
test("askBeforeSaving brings the prompt back", ...)                       // behavior "ask"
test("a guest or scheduled role, or no role, still asks", ...)
test("another tool on the same path still asks (Write to MEMORY.md)", ...)
test("a store tool aimed outside the stores still asks", ...)              // Memory with paths [/etc/x]
test("confinement lets the owner's store save through and denies a guest's", () => {
  expect(decide(memory(m), owner({ confine: true })).behavior).toBe("allow");
  expect(decide(memory(m), owner({ confine: true, role: "guest" })).behavior).toBe("deny");
});
test("a deny rule or an ask rule still wins", () => {
  expect(decide(memory(m), owner({ deny: ["Memory"] })).behavior).toBe("deny");
  expect(decide(memory(m), owner({ ask: ["Memory"] })).behavior).toBe("ask");
});
test("plan mode still refuses a store save", ...)
test("a store folder that is a symlink out of the home is not a store save", async () => {
  await symlink(outside, join(home, "skills"));
  expect(isStoreSave({ toolName: "SkillManage", kind: "edit", paths: [join(home, "skills", "x", "SKILL.md")] }, owner())).toBe(false);
});
```

In `stores.test.ts`, `"lists the five tools' stores as canonical paths under the home"`, with `home` reached through a symlinked tmp dir. In `settings.test.ts`, the existing `learning` default expectations gain `askBeforeSaving: false`. In `policy.test.ts`: `"guests and scheduled runs don't get the store tools, which could never succeed there; the owner keeps them"`.

- [ ] **Step 2: Run the tests and check they fail**

Run: `bun test src/permissions/engine.test.ts src/learning/stores.test.ts src/config/settings.test.ts src/gateway/policy.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** `stores.ts`, the settings field (schema `askBeforeSaving: z.boolean()` inside the existing partial `learning` object), `isStoreSave` with the new `decide` order, and `permissionContext` used at `runtime.ts:142` and `:272`. In `channelContext`, filter `STORE_TOOLS` out for every role except `"owner"`.

- [ ] **Step 4: Run the tests and check they pass**

Run: `bun test src/permissions src/learning src/config src/gateway src/cli && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Stage**

```bash
git add src/learning/stores.ts src/learning/stores.test.ts src/config/settings.ts src/config/settings.test.ts src/permissions/engine.ts src/permissions/engine.test.ts src/cli/runtime.ts src/gateway/policy.ts src/gateway/policy.test.ts
```

---

### Task 4: Learning in the owner's chats, and a notice for every save

**Files:**
- Create: `src/learning/saved-notice.ts`, `src/learning/saved-notice.test.ts`
- Modify: `src/agent/events.ts:21` (the notice event)
- Modify: `src/learning/review.ts:56-63` (the review notice carries `learned`)
- Modify: `src/cli/runtime.ts:118-253` (`makeAgent`), `:470` (panel labels), `:518-537` (`createRuntime` init)
- Modify: `src/gateway/daemon.ts:247-256` (`learn: role === "owner"`)
- Test: `src/cli/runtime.test.ts` (`describe("learning and identity")`)

**Interfaces:**
- Consumes: `permissionContext`, `STORE_TOOLS` (Task 3); `AppContext.role` (Task 2).
- Produces:
  - The `AgentEvent` notice becomes `{ type: "notice"; level: "info" | "warn" | "error"; text: string; learned?: boolean }`. The review's notice and save notices set `learned: true`.
  - `savedNotice(tool: string, input: unknown): string | undefined`. It is clipped to 160 characters. The exact copy:
    - Memory add or replace: `💡 Remembered: <content>`
    - Memory remove: `💡 Forgot: <old_text>`
    - Memory batch: `💡 Updated memory (<n> changes)`
    - DailyNote: `📓 Added to today's journal`
    - SkillManage create: `🛠 Skill saved: <name>`
    - SkillManage patch or write_file: `🛠 Skill updated: <name>`
    - SkillManage delete: `🛠 Skill deleted: <name>`
    - AgentManage: `🧩 Agent <created|updated|deleted>: <name>`
    - Identity set: `🪪 Identity updated`
    - Identity soul: `🪪 SOUL.md updated`
    - Identity skip, or any other tool: `undefined`
  - `makeAgent` options gain `learn?: boolean`: it runs the background review and defaults to `interactive`. `createRuntime` init gains the same `learn?: boolean`, passed through.
  - In `/learned`, the label for actor `agent` changes from "you asked" to `"saved while we talked"`.

- [ ] **Step 1: Write the failing tests**

```ts
// saved-notice.test.ts
test("each store tool's save reads as one short line", () => {
  expect(savedNotice("Memory", { target: "user", action: "add", content: "you deploy on Fridays" })).toBe("💡 Remembered: you deploy on Fridays");
  expect(savedNotice("DailyNote", { text: "x" })).toBe("📓 Added to today's journal");
  expect(savedNotice("SkillManage", { action: "create", name: "release-bun" })).toBe("🛠 Skill saved: release-bun");
  expect(savedNotice("Read", {})).toBeUndefined();
  expect(savedNotice("Memory", { action: "add", content: "x".repeat(400) })!.length).toBeLessThanOrEqual(160);
});
// runtime.test.ts
test("an owner's Memory save runs without a prompt and leaves one learned notice", async () => {
  // FakeModel: Memory add {target:"user", content:"prefers bun"}, then text.
  // ui.askPermission is never called; events include { type:"notice", learned:true, text:"💡 Remembered: prefers bun" }; ledger has 1 entry by "agent"
});
test("with learning.askBeforeSaving the same save asks first", ...)
test("learn: true runs the review in a non-interactive session without the first-run note", ...)
test("a guest session's notices never carry learned", ...)   // role guest, review off: no learned notices
```

- [ ] **Step 2: Run the tests and check they fail**

Run: `bun test src/learning/saved-notice.test.ts src/cli/runtime.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement.** In `makeAgent`'s `emit`: on `tool_start` for a `STORE_TOOLS` name, keep the input by id. On `tool_end` with status `done`, emit `{ type: "notice", level: "info", text, learned: true }` when `savedNotice` returns text. The loop's condition becomes `opts.learn ?? opts.interactive`. In the daemon pool's `createRuntime` call, add `learn: role === "owner"` and keep `interactive: false`.

- [ ] **Step 4: Run the tests and check they pass**

Run: `bun test src/learning src/cli src/gateway && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Stage**

```bash
git add src/learning/saved-notice.ts src/learning/saved-notice.test.ts src/agent/events.ts src/learning/review.ts src/cli/runtime.ts src/cli/runtime.test.ts src/gateway/daemon.ts
```

---

### Task 5: The review may replace and consolidate (§10 item 7)

**Files:**
- Modify: `src/learning/review.ts:199-208, 241-258` (the Memory gate, `reviewAskPermission`)
- Modify: `src/learning/review-prompts.ts:27-31` (`MEMORY_RULES`)
- Test: `src/learning/review.test.ts:295-308, 342-349`

**Interfaces:**
- Produces: `consolidates(input: unknown): boolean`, private to `review.ts`, replacing `onlyAdds`. It accepts:
  - `action` `"add"` or `"replace"`;
  - a batch of 1–50 operations with at least one `add` or `replace` (removes allowed in that batch).
  
  It refuses a lone `remove`, an all-remove batch, an empty batch, and anything that isn't an object. The refusal text is `"The learning review can't only remove notes; replace or merge them instead."` The ledger keeps undo for every change.
- Replacement text for `MEMORY_RULES`, so the prompt matches the gate:

  > `Prefer replacing an outdated entry (action replace) over adding a near-duplicate. When a store is full, consolidate in one Memory call with operations: remove or merge entries and add the merged one. Never only remove.`

- [ ] **Step 1: Rewrite the test at `review.test.ts:295`** as `"Memory may add, replace and consolidate during the review; a lone remove is refused"`:

```ts
for (const ok of [{ action: "add" }, { action: "replace" }, { operations: [{ action: "remove" }, { action: "add" }] }]) expect(await memory.run(ok, ctx)).toEqual({ content: "Memory ok" });
for (const bad of [{ action: "remove" }, { operations: [{ action: "remove" }] }, { operations: [] }, null]) expect(await memory.run(bad, ctx)).toMatchObject({ isError: true });
expect(reviewAskPermission({ toolName: "Memory", kind: "edit", summary: "", input: { action: "replace" } })).toEqual({ kind: "allow" });
expect(reviewAskPermission({ toolName: "Memory", kind: "edit", summary: "", input: { action: "remove" } })).toMatchObject({ kind: "deny" });
```

Add `"the memory rules tell the review to replace and consolidate, never only remove"`: `expect(MEMORY_REVIEW_PROMPT).toContain("Never only remove")`.

- [ ] **Step 2: Run the tests and check they fail**

Run: `bun test src/learning/review.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** `consolidates` in both places, plus the prompt text.

- [ ] **Step 4: Run the tests and check they pass**

Run: `bun test src/learning && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Stage**

```bash
git add src/learning/review.ts src/learning/review-prompts.ts src/learning/review.test.ts
```

---

### Task 6: A final review at session end, counters that carry over, and a flush for every model (§10 items 5 and 6)

**Files:**
- Create: `src/learning/counters.ts`, `src/learning/counters.test.ts`
- Modify: `src/learning/review.ts:21-28` (kinds), `:39-45` (deps), `:65-183` (`LearningLoop`)
- Modify: `src/learning/review-prompts.ts` (`FINAL_PROMPT`)
- Modify: `src/cli/runtime.ts:234` (flush window), `:556-569`, `:596-632` (`newAgent`, `clear`, `resume`), `:667-673` (`shutdown`)
- Modify: `src/ui/runtime.ts:103-105` (the `Runtime` interface)
- Modify: `src/web/host.ts:64-67` (`shutdown(opts)`), `src/gateway/pool.ts:73-86` (`closeAll` runs no final review)
- Modify: `src/cli/main.tsx:393-398` (a line before waiting)
- Test: `src/learning/review.test.ts` (`describe("LearningLoop")`), `src/cli/runtime.test.ts`, `src/gateway/pool.test.ts`

**Interfaces:**
- Produces:
  - `ReviewKind` adds `"final"`. `REVIEW_PROMPTS.final = FINAL_PROMPT`. `FINAL_PROMPT` combines the flush instructions (append the session's durable state to today's journal with DailyNote) with `MEMORY_RULES`, `SKILL_RULES`, `NEVER` and the `NOTHING` footer, under a header that says the session is ending.
  - `export interface LearningCounters { turnsSinceMemory: number; toolsSinceSkill: number }`
  - In `counters.ts`:
    - `loadCounters(home: string, cwd: string): Promise<LearningCounters>` reads `<projectDir(home, cwd)>/learning.json`. A missing or bad file gives zeros.
    - `saveCounters(home: string, cwd: string, c: LearningCounters): Promise<void>` writes atomically with mode 0600.
  - `LearningLoopDeps` gains `initial?: LearningCounters` and `saveCounters?(c: LearningCounters): void`. The loop calls `saveCounters` after every change to a counter.
  - `LearningLoop` gains:
    - `get counters(): LearningCounters`
    - `get finalDue(): boolean`: at least one turn ended in this loop, and either `turnsSinceMemory >= FINAL_MIN_TURNS` (2) or `toolsSinceSkill >= FINAL_MIN_TOOLS` (5).
    - `finish(timeoutMs: number): Promise<void>`. It waits for a running review and then, when `finalDue`, runs a `"final"` review on the last history it saw. On success it resets both counters. After `timeoutMs` it aborts the review (saves made so far are kept and announced) and resolves. It never rejects.
  - `export const FINAL_REVIEW_TIMEOUT_MS = 30_000` and `export const DEFAULT_CONTEXT_WINDOW = 128_000`.
  - `flushWindow(model: string): number` in `review.ts`, equal to `Math.min(contextWindow(model) ?? DEFAULT_CONTEXT_WINDOW, COMPACTION_TRIGGER_TOKENS)`. It replaces the expression at `runtime.ts:234`.
  - `Runtime` changes:
    - `shutdown(opts?: { finalReview?: boolean }): Promise<void>`, where `finalReview` defaults to `true`.
    - New `finalReviewDue(): boolean`.
  - `WebHost.shutdown(opts?: { finalReview?: boolean })` passes `opts` on. `SessionPool.close(key)` keeps the final review. `closeAll()` passes `{ finalReview: false }`, because the gateway is stopping.
  - In `createRuntime`, counters are loaded once at creation and again after `clear` and `resume`. They are handed to each new loop as `initial`.
  - `clear()` and `resume()` detach the old loop with `void old.finish(FINAL_REVIEW_TIMEOUT_MS)` and don't wait for it.
  - `shutdown()` awaits `learning.finish(FINAL_REVIEW_TIMEOUT_MS)` when `finalReview` is set.
  - `main.tsx` prints `Saving what I learned before closing… (ctrl+c to skip)\n` to stderr when `runtime.finalReviewDue()`.

- [ ] **Step 1: Write the failing tests**

```ts
// review.test.ts, describe("LearningLoop")
test("finish runs one final review on the last history when the session has unreviewed work, then resets the counters", async () => {
  const h = harness(); turns(h.loop, 2);
  const done = h.loop.finish(1000); h.done({ changes: [{ tool: "DailyNote", summary: "DailyNote noted" }] }); await done;
  expect(h.calls.map((c) => c.kind)).toEqual(["final"]);
  expect(h.loop.counters).toEqual({ turnsSinceMemory: 0, toolsSinceSkill: 0 });
});
test("finish does nothing below 2 turns and 5 tool calls, or when no turn ended in this loop", ...)
test("finish waits for a running review first and never starts two", ...)
test("finish aborts a review still running after the timeout and resolves", ...)  // calls[0].signal.aborted === true
test("counters start from initial and every change is saved", ...)              // saveCounters spy sees {1,0}, {2,0} ...
test("flushWindow: known models cap at the compaction trigger; unknown ones use 128,000", () => {
  expect(flushWindow("claude-opus-5-5")).toBe(150_000);
  expect(flushWindow("ollama/llama3")).toBe(128_000);
});
// counters.test.ts
test("missing or damaged learning.json reads as zeros; a save round-trips with mode 0600", ...)
// runtime.test.ts
test("shutdown runs the final review and the journal gets an entry", ...)
test("clear returns before the final review ends; the next session starts from the carried counters", ...)
test("shutdown({ finalReview: false }) skips it", ...)
// pool.test.ts
test("closeAll shuts hosts down without a final review; close(key) keeps it", ...)
```

- [ ] **Step 2: Run the tests and check they fail**

Run: `bun test src/learning src/cli/runtime.test.ts src/gateway/pool.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** as described in Interfaces. `finish` uses the loop's own `controller`, so the existing `cancel()` (on a new user turn) never hits a detached final review. That review lives on the old loop, and `newAgent` creates a new loop.

- [ ] **Step 4: Run the tests and check they pass**

Run: `bun test src/learning src/cli src/gateway src/web && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Stage**

```bash
git add src/learning/counters.ts src/learning/counters.test.ts src/learning/review.ts src/learning/review-prompts.ts src/learning/review.test.ts src/cli/runtime.ts src/cli/runtime.test.ts src/ui/runtime.ts src/web/host.ts src/gateway/pool.ts src/gateway/pool.test.ts src/cli/main.tsx
```

---

### Task 7: New sessions see new skills, commands and agents (§10 item 2)

**Files:**
- Modify: `src/cli/extensions.ts:35-66` (`Extensions`), `:83-155` (`loadExtensions`), `:171-205` (`sessionTools`)
- Modify: `src/tools/skill/skill.ts:25-63`
- Modify: `src/cli/context.ts:36-44, 90-99` (`newSessionContext` becomes async)
- Modify: `src/gateway/daemon.ts:223, 291` (await it)
- Test: `src/cli/extensions.test.ts`, `src/tools/skill/skill.test.ts`

**Interfaces:**
- Produces:
  - `Extensions.reload(): Promise<void>` re-reads commands, skills and agents and replaces the contents of `commands`, `skills` and `agents` in place, so every holder of those arrays sees the change. It keeps today's rule: a skill named like a command can't be typed. `reloadAgents` stays.
  - `ProjectContext.newSessionContext(): Promise<SessionContext>` calls `ext.reload()` first. A failure is added to `warnings` and does not break the session.
  - `createSkillTool(skills: Skill[], opts: { home?; tracker?; reviewTracker?; reload?: () => Promise<void> })` builds its name map at call time. For an unknown name it calls `reload` once and looks again.
  - `sessionTools` always includes the Skill tool, even with no skills, with `reload: ext.reload`.

- [ ] **Step 1: Write the failing tests**

```ts
// extensions.test.ts
test("reload picks up a skill, a command and an agent written after loading, in the same arrays", async () => {
  const ext = await loadExtensions({ cwd, home, settings: DEFAULT_SETTINGS, env: {}, connect: false });
  const skills = ext.skills;
  await writeSkill(home, "deploy"); await writeCommand(home, "ship"); await writeAgent(home, "reviewer");
  await ext.reload();
  expect(skills.map((s) => s.name)).toContain("deploy");
  expect(ext.commands.map((c) => c.name)).toContain("ship");
  expect(ext.agents.map((a) => a.name)).toContain("reviewer");
});
test("the Skill tool is in a session's tools even when no skills exist", ...)
// skill.test.ts
test("a skill added after the tool was made loads after one reload", ...)
test("an unknown name after reload still lists what exists now", ...)
```

- [ ] **Step 2: Run the tests and check they fail**

Run: `bun test src/cli/extensions.test.ts src/tools/skill/skill.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** the changes listed in Interfaces.

- [ ] **Step 4: Run the tests and check they pass**

Run: `bun test src/cli src/tools src/gateway && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Stage**

```bash
git add src/cli/extensions.ts src/cli/extensions.test.ts src/tools/skill/skill.ts src/tools/skill/skill.test.ts src/cli/context.ts src/gateway/daemon.ts
```

---

### Task 8: Dashboard changes take effect without a restart (§10 item 3)

**Files:**
- Create: `src/gateway/contexts.ts`, `src/gateway/contexts.test.ts`
- Modify: `src/gateway/daemon.ts:170-194` (use `ProjectContexts`), `:203-269` (acquire and release per session), `:273-280` (adapters from a builder), `:324` (`reload`), `:392` (`until` info), `:401` (`closeAll`)
- Modify: `src/gateway/pool.ts:88-97` (`retire`)
- Modify: `src/web/admin/config.ts:68-104`, `src/web/admin/extensions.ts:188-223` (call `ctx.gateway?.reload()` after saving)
- Modify: `src/cli/main.tsx` (pass the `gatewayUntil` info type through)
- Test: `src/gateway/contexts.test.ts`, `src/gateway/pool.test.ts`, `src/gateway/daemon.projects.test.ts`, `src/web/admin/config.test.ts`, `src/web/admin/extensions.test.ts`

**Interfaces:**
- Consumes: `newSessionContext(): Promise<SessionContext>` (Task 7).
- Produces:
  - `class ProjectContexts` with:
    - `constructor(load: (project: Project) => Promise<ProjectContext>)`
    - `acquire(project: Project): Promise<{ pc: ProjectContext; release(): void }>`: one shared context per `project.path`. A rejected load is not cached.
    - `invalidate(): void`: later acquires load afresh. Each old context is closed (`pc.close()`) once its last holder releases it.
    - `closeAll(): Promise<void>`
  - `SessionPool.retire(): Promise<string[]>` closes every session that isn't busy, whatever its idle time. Busy sessions are marked and closed by the next `sweep()` once they are no longer busy. Closed chats resume their saved session id on the next message.
  - `GatewayRun.until` info becomes `{ webUrl?: string; reload(): Promise<void> }`.
  - The daemon's `reload()` is serialised, and does four things in order:
    1. `config = await loadGatewayConfig(home)`;
    2. stops the current adapters, rebuilds them from `config` and starts them;
    3. calls `contexts.invalidate()`;
    4. calls `pool.retire()`.
  - Each pool session acquires its context in `create` and releases it in `HostHandle.close`. The dashboard's own chat holds its context until the gateway stops. P2 Task 12 replaces it with per-project dashboard hosts (`ProjectHosts`) that acquire their contexts through `ProjectContexts` and hold them until the gateway stops; they don't reload.

- [ ] **Step 1: Write the failing tests**

```ts
// contexts.test.ts
test("one context per project path while current; invalidate makes the next acquire load afresh", ...)
test("an invalidated context closes only after its last holder releases it", async () => {
  const a = await cache.acquire(p); cache.invalidate();
  expect(closed).toEqual([]); a.release(); await settle(); expect(closed).toEqual([p.path]);
});
test("a failed load isn't cached: the next acquire tries again", ...)
// pool.test.ts
test("retire closes idle sessions at once and a busy one when its turn ends; the chat resumes its session id", ...)
// daemon.projects.test.ts
test("a bot token saved after start works after reload, without a restart", async () => {
  // start with no TROPOS_TELEGRAM_BOT_TOKEN; saveGatewayConfig(home, {…telegram:{botToken: server.token}}); await info.reload();
  // server.pushMessage(CHAT, CHAT, "hello?") → the pairing reply arrives
});
test("reload during a running turn lets it finish; the next message continues the same transcript", ...)
// config.test.ts / extensions.test.ts
test("config.set, config.apply, mcp.add, mcp.remove and plugins.setEnabled ask the gateway to reload", ...)
```

- [ ] **Step 2: Run the tests and check they fail**

Run: `bun test src/gateway/contexts.test.ts src/gateway/pool.test.ts src/gateway/daemon.projects.test.ts src/web/admin/config.test.ts src/web/admin/extensions.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement.** The warning and SettingsError handling of today's `contextFor` moves into the `load` function passed to `ProjectContexts`, unchanged.

- [ ] **Step 4: Run the tests and check they pass**

Run: `bun test src/gateway src/web src/cli && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Stage**

```bash
git add src/gateway/contexts.ts src/gateway/contexts.test.ts src/gateway/daemon.ts src/gateway/pool.ts src/gateway/pool.test.ts src/gateway/daemon.projects.test.ts src/web/admin/config.ts src/web/admin/config.test.ts src/web/admin/extensions.ts src/web/admin/extensions.test.ts src/cli/main.tsx
```

---

### Task 9: Telegram: notices, `/learned`, skills and commands, non-text messages (§10 item 9, Part F)

**Files:**
- Modify: `src/gateway/types.ts:17-30` (`ChatSession`)
- Modify: `src/gateway/pool.ts:100-136` (`wrap`)
- Modify: `src/gateway/telegram/adapter.ts:79-92` (`Chat`), `:236-257` (`handleMessage`), `:347-379` (`onEvent`), `:446-487` (queue), `:561-588` (`handleCommand`)
- Modify: `src/gateway/telegram/render.ts:155-169` (help, bot commands, `learnedText`)
- Modify: `test/helpers/telegram-fakes.ts` (`FakeSession`), `test/helpers/telegram-fake-server.ts` (`pushNonText`)
- Test: `src/gateway/telegram/adapter.test.ts`, `src/gateway/telegram/render.test.ts`, `src/gateway/pool.test.ts`, `src/gateway/daemon.projects.test.ts`

**Interfaces:**
- Consumes: `Pairing.isOwner` (Task 1); notices with `learned: true` (Task 4).
- Produces:
  - `ChatSession` gains:
    - `command(name: string, args: string): Promise<TurnEndReason>`: runs `/name args` through `expandCommand`. It rejects with `Error("busy")` like `prompt`, and with `UserFacingError` (the RPC message) when the name is unknown.
    - `learned(): Promise<PanelData>`
    - `undoLearned(): Promise<{ ok: true; summary: string } | { ok: false; reason: string }>`
  - The pool implements them as `host.call("prompt", { command: { name, args } })`, `host.call("panel", "learned")` and `host.call("learned.undo", undefined)`.
  - `learnedText(panel: PanelData, limit = 10): string` in `render.ts`. It writes one line per item, `• <label> (<hint>, <aside>)`, ends with `Send /learned undo to take back the newest.`, and uses `panel.empty` when there are no items.
  - `HELP_TEXT` adds two lines: `/learned  what I saved; /learned undo takes back the newest` and `/<name>  run one of your skills or commands`. `BOT_COMMANDS` adds `{ command: "learned", description: "What I learned, with undo" }`.
  - Adapter behaviour:
    - The queue holds `{ text } | { command, args }`.
    - `/stop`, `/new`, `/status` and `/start` work as today.
    - `/learned [undo]` works for the owner only. Others get `Only the owner can see what I've learned.`
    - Any other `/name` is queued as a command. An unknown one replies `Unknown command.\n` + `HELP_TEXT`.
    - A message without `text` from an approved sender gets `I can only read text for now.`; strangers' non-text messages stay ignored.
    - A `learned` notice that arrives while a turn runs is held and sent as its own message after the turn's answer, at `turn_end`. One that arrives between turns is sent at once.

- [ ] **Step 1: Write the failing tests** in `adapter.test.ts`:

```ts
test("a photo from an approved sender gets one plain reply; a stranger's photo gets nothing", ...)   // "I can only read text for now."
test("an unknown /name goes to the session as a command with its args", async () => {
  server.pushMessage(CHAT, CHAT, "/deploy prod");
  await server.waitFor(() => session.commands.length === 1);
  expect(session.commands[0]).toEqual({ name: "deploy", args: "prod" });
});
test("a command the session doesn't know shows the help", ...)
test("/learned lists the latest saves and /learned undo takes back the newest, for the owner", ...)
test("/learned from an approved guest is refused", ...)
test("a learned notice during a turn is sent after the answer; one between turns at once; other info notices stay silent", ...)
```

In `render.test.ts`: `"learnedText shows up to 10 items and the undo hint, or the panel's empty text"`. In `pool.test.ts`: `"command, learned and undoLearned reach the host; an unknown command rejects with a user-facing error"`. In `daemon.projects.test.ts`: `"the owner's chat saves a memory without asking and gets '💡 Remembered: …' after the answer"` (FakeModel: a Memory add tool_use, then text).

- [ ] **Step 2: Run the tests and check they fail**

Run: `bun test src/gateway/telegram src/gateway/pool.test.ts src/gateway/daemon.projects.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** the changes listed in Interfaces, plus the fake changes:
  - `FakeSession` records `commands: { name: string; args: string }[]` and has scripted `learned` and `undoLearned`.
  - `FakeTelegramServer` gets `pushNonText(chatId: number, fromId: number, field: "photo" | "voice" | "document")`.

- [ ] **Step 4: Run the tests and check they pass**

Run: `bun test src/gateway && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Stage**

```bash
git add src/gateway/types.ts src/gateway/pool.ts src/gateway/pool.test.ts src/gateway/telegram/adapter.ts src/gateway/telegram/adapter.test.ts src/gateway/telegram/render.ts src/gateway/telegram/render.test.ts test/helpers/telegram-fakes.ts test/helpers/telegram-fake-server.ts src/gateway/daemon.projects.test.ts
```

---

### Task 10: Scheduling from every owner session, delivered to the owner's chat (§10 item 10)

**Files:**
- Create: `src/tools/cron/owner-cron.ts`, `src/tools/cron/owner-cron.test.ts`
- Modify: `src/tools/cron/cron-tool.ts:36-43, 58-80` (`seeAll`)
- Modify: `src/gateway/daemon.ts:225-230` (owner chats see every job), `:290-303` (the dashboard session gets the owner Cron tool)
- Modify: `src/cli/main.tsx:274-289` (the terminal session gets the owner Cron tool)
- Modify: `src/web/admin/cron.ts:119-129` (default delivery)
- Modify: `web/src/components/setup/CronJobDialog.tsx:44-48`
- Test: `src/tools/cron/cron-tool.test.ts`, `src/web/admin/cron.test.ts`, `web/src/app/pages/CronPage.test.tsx`

**Interfaces:**
- Consumes: `ownerChatKey`, `PairingView.owner` (Task 1); `SessionRole` (Task 2).
- Produces:
  - `CronToolOptions.seeAll?: boolean`. When true, every job is visible and can be changed, and `defaultDeliver` only supplies the default target. Without it, chats stay scoped to their own jobs as today.
  - `ownerCronTool(home: string, opts?: { runNow?: (id: string) => Promise<RunRecord> }): Promise<AnyTool>` in `owner-cron.ts`. It is `createCronTool({ store: new CronStore(home), seeAll: true, defaultDeliver: () => owner, runNow })`, where `owner` is `await ownerChatKey(new FilePairing({ path: join(gatewayDir(home), "pairing.json") }))`. With no owner, the target falls back to `"none"`.
  - Daemon chats:
    - owner: `createCronTool({ store, seeAll: true, defaultDeliver: () => chatKey, runNow })`;
    - guest: unchanged;
    - scheduled: none, as today.
  - `cron.add` without `deliver` uses `ownerChatKey(...)`, then falls back to `"none"`. `CronJobDialog` preselects `telegram:<owner>` for a new job when `pairing.owner` is set.

- [ ] **Step 1: Write the failing tests**

```ts
// cron-tool.test.ts
test("with seeAll a session lists every job and new jobs go to the default target", ...)
test("without a default target a new job delivers nowhere", ...)
// owner-cron.test.ts
test("the terminal's Cron tool delivers to the owner's chat by default, or nowhere without an owner", ...)
// src/web/admin/cron.test.ts
test("cron.add without deliver sends to the owner's chat when there is an owner, else nowhere", ...)
// web CronPage.test.tsx
test("a new job defaults to the owner's chat", async () => {
  await mountAdminPage(CronPage, base({ "pairing.list": () => ({ ...PAIRING, owner: { channel: "telegram", senderId: "4242" } }) }));
  // open New job, fill name/prompt, save → cron.add params toMatchObject({ deliver: "telegram:4242" })
});
```

- [ ] **Step 2: Run the tests and check they fail**

Run: `bun test src/tools/cron src/web/admin/cron.test.ts web/src/app/pages/CronPage.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement** the changes listed in Interfaces. `main.tsx` appends `await ownerCronTool(home)` to `ctx.tools`. The daemon's dashboard session appends `await ownerCronTool(home, { runNow: (id) => cron.runNow(id) })`.

- [ ] **Step 4: Run the tests and check they pass**

Run: `bun test src/tools src/web src/gateway src/cli web/src && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Stage**

```bash
git add src/tools/cron/owner-cron.ts src/tools/cron/owner-cron.test.ts src/tools/cron/cron-tool.ts src/tools/cron/cron-tool.test.ts src/gateway/daemon.ts src/cli/main.tsx src/web/admin/cron.ts src/web/admin/cron.test.ts web/src/components/setup/CronJobDialog.tsx web/src/app/pages/CronPage.test.tsx
```

---

### Task 11: Subagent transcripts are kept and searchable (§10 item 11)

**Files:**
- Modify: `src/session/store.ts:101-135` (`createSubagent`)
- Modify: `src/agent/subagent.ts:24-42` (deps), `:96-131` (`persist`)
- Modify: `src/cli/runtime.ts:164-178` (wire the deps)
- Modify: `src/memory/search-index.ts:195-213` (`diskFiles`), `src/memory/session-search.ts:72-97, 210-215`
- Test: `src/session/store.test.ts`, `src/agent/subagent.test.ts`, `src/memory/session-search.test.ts`, `src/memory/search-index.test.ts`

**Interfaces:**
- Produces:
  - `SessionStore.createSubagent(home: string, meta: { cwd: string; parentId: string; agent: string; model: string; version: string }): Promise<SessionStore>`. It writes `<projectDir>/subagents/<parentId>/<uuid>.jsonl`, and its first meta line carries `parentId` and `agent`. `listSessions` doesn't list these files.
  - `SubagentDeps.openTranscript?(agent: string): Promise<{ appendMessage(m: MessageParam): Promise<void> }>`. `runSubagent` persists every child message through it. A failure to open it is ignored, so the subagent still runs.
  - The search index and the scan fallback both read `subagents/*/*.jsonl` as kind `"session"`. `readSession(dirs, id)` also looks there.

- [ ] **Step 1: Write the failing tests**

```ts
test("a subagent transcript is saved under its parent session and isn't listed as a session", ...)   // store.test.ts
test("runSubagent writes the child's messages through openTranscript; a failing transcript doesn't stop it", ...) // subagent.test.ts
test("SessionSearch finds text only a subagent wrote, and can open that transcript by id", ...)       // session-search.test.ts
test("the index picks up subagent transcripts", ...)                                                  // search-index.test.ts
```

- [ ] **Step 2: Run the tests and check they fail**

Run: `bun test src/session src/agent/subagent.test.ts src/memory`
Expected: FAIL.

- [ ] **Step 3: Implement.** In `makeAgent`, set `openTranscript: (agent) => SessionStore.createSubagent(ctx.home, { cwd: ctx.cwd, parentId: opts.session().id, agent, model: config().model, version: ctx.version })`.

- [ ] **Step 4: Run the tests and check they pass**

Run: `bun test src/session src/agent src/memory src/cli && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Stage**

```bash
git add src/session/store.ts src/session/store.test.ts src/agent/subagent.ts src/agent/subagent.test.ts src/cli/runtime.ts src/memory/search-index.ts src/memory/search-index.test.ts src/memory/session-search.ts src/memory/session-search.test.ts
```

---

### Task 12: No more "edit the JSON": messages, settings errors in chats, and `doctor --fix` (§10 item 12)

**Files:**
- Modify: `src/gateway/daemon.ts:187` (invalid settings), `:374` (no channels)
- Modify: `src/gateway/commands.ts:91-93`
- Modify: `src/install/commands.ts:44-49`
- Modify: `src/cli/runtime.ts:375, 415, 435, 457` (empty-panel texts)
- Modify: `src/doctor/checks/settings.ts` (add `fix`)
- Test: `src/doctor/checks/settings.test.ts`, `src/install/commands.test.ts:31-40`, `src/gateway/daemon.projects.test.ts:114-134`, `src/gateway/commands.test.ts`, `src/cli/runtime.test.ts` (`"panels"`)

**Interfaces:**
- Produces this exact copy:
  - **Daemon, invalid project settings, sent to the chat:** `I can't start a session in "<name>" because its settings have a problem. The owner can fix it with tcode doctor --fix or in the dashboard.` The detail goes only to `run.err`, as `tcode: <id>: <SettingsError message>`.
  - **Daemon, no channels:** `  channels: none (connect Telegram in the dashboard: tcode dashboard, or ask me in the terminal)`
  - **`gateway install`, no token:** `No Telegram bot yet: connect one in the dashboard (tcode dashboard) or ask me to connect it.`
  - **`oneTimeInstallNotice`:** `<lead> To stay on '<target>', switch the update channel to '<target>' in the dashboard (tcode dashboard).` For a pinned version: `<lead> To stay on <target>, turn background updates off in the dashboard (tcode dashboard).`
  - **Empty skills panel:** `No skills yet. Ask me to make one, or I'll write them as I learn what you need.`
  - **Empty hooks panel:** `No hooks. Add them in the dashboard (tcode dashboard → Extensions).`
  - **Empty MCP panel:** `No MCP servers. Ask me to add one, or add it in the dashboard (tcode dashboard → Extensions).`
  - **Memory off:** `Memory is off. Turn it on in the dashboard's settings (tcode dashboard).`
  - `settingsCheck` findings for the `user` and `userProject` files are `fixable: true, safe: false`, with `data: { path }`. Repo files (`project`, `local`) are reported and not fixable.
  - `fix` copies the file to `<path>.broken-<YYYYMMDDHHmmss>`, then rewrites it:
    - unparsable JSON becomes `{}\n`;
    - when the schema fails, the top-level keys named in the zod issues are dropped.
    
    It then re-validates and returns `{ ok: true, message: "kept the valid settings; the old file is at <backup>" }`.

- [ ] **Step 1: Update the tests** to the copy above (`commands.test.ts:31-40`; the `"Bad"` project test now asserts `t.includes("because its settings have a problem")`, `!t.includes("{not json")`, and the detail in `gw.err`). Add:

```ts
test("--fix moves a broken user settings file aside and keeps its valid keys", async () => {
  fx = await makeFixture();
  const path = await fx.write("settings.json", JSON.stringify({ theme: "dark", effort: "turbo" }));
  const r = await runOne(fx, settingsCheck, { fix: true });
  expect(byId(r, "settings.parse.user")).toMatchObject({ fixed: true });
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ theme: "dark" });
  expect((await readdir(fx.home)).some((n) => n.startsWith("settings.json.broken-"))).toBe(true);
});
test("unparsable user settings become {} with a backup; a broken repo file is not fixable", ...)
```

- [ ] **Step 2: Run the tests and check they fail**

Run: `bun test src/doctor/checks/settings.test.ts src/install/commands.test.ts src/gateway src/cli/runtime.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** the copy and the fix.

- [ ] **Step 4: Run the tests and check they pass**

Run: `bun test src/doctor src/install src/gateway src/cli && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Stage**

```bash
git add src/gateway/daemon.ts src/gateway/commands.ts src/gateway/commands.test.ts src/install/commands.ts src/install/commands.test.ts src/cli/runtime.ts src/cli/runtime.test.ts src/doctor/checks/settings.ts src/doctor/checks/settings.test.ts src/gateway/daemon.projects.test.ts
```

---

### Task 13: The curator runs as a gateway service (§10 item 14)

**Files:**
- Create: `src/gateway/curator-service.ts`, `src/gateway/curator-service.test.ts`
- Modify: `src/gateway/daemon.ts:362` (start it with cron)
- Test: `src/gateway/curator-service.test.ts`

**Interfaces:**
- Consumes: `runCurator(home, { ledger, skillsDir })` (`src/learning/curator.ts:108`). It already runs at most once every 7 days.
- Produces: `createCuratorService(opts?: { everyMs?: number; now?: () => Date; log?: (m: string) => void }): GatewayService`, with `name: "curator"`. It runs once at `start` and then every `everyMs`, by default `6 * 3_600_000`, on an `unref`'d timer. Its options are `{ ledger: new Ledger(deps.home), skillsDir: join(deps.home, LEARNED_SKILLS_DIR) }`. It logs `archived N learned skill(s): a, b`. Errors are logged and never thrown. `stop()` clears the timer.

- [ ] **Step 1: Write the failing tests**

```ts
test("runs at start and on every tick, logs what it archived, and stops cleanly", ...)  // fake timer seam via everyMs: 10
test("a failing run is logged and the next tick tries again", ...)
```

- [ ] **Step 2: Run the tests and check they fail**

Run: `bun test src/gateway/curator-service.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**, and use `[cron, createCuratorService({ log: (m) => run.err(\`gateway: curator: ${m}\n\`) }), ...(run.services ?? [])]` in the daemon.

- [ ] **Step 4: Run the tests and check they pass**

Run: `bun test src/gateway && bun run typecheck && bun test`
Expected: PASS (the whole suite).

- [ ] **Step 5: Stage**

```bash
git add src/gateway/curator-service.ts src/gateway/curator-service.test.ts src/gateway/daemon.ts
```

---

## Self-review

- **Coverage:**
  - C1 is covered by Tasks 1 and 2, and C2 by Task 3.
  - Part F:
    - learning on for owner chats and the dashboard, off for guests and scheduled runs: Tasks 2 and 4;
    - auto-save with a notice and undo: Tasks 3 and 4 (undo through the existing ledger and `/learned undo`);
    - Telegram notices and `/learned`: Task 9.
  - §10, item by item:

    | Item | Task |
    |---|---|
    | 1 | 3 (plus withholding the store tools in Task 3) |
    | 2 | 7 |
    | 3 | 8 |
    | 4 | 3 |
    | 5 | 6 |
    | 6 | 6 |
    | 7 | 5 |
    | 9 | 9 |
    | 10 | 10 |
    | 11 | 11 |
    | 12 | 12 |
    | 14 | 13 |
    | 15 | 2 |

  - Out of scope: items 8 and 13, owner assignment by the wizard, and the wider rewording.
- **Types:** these names are used the same way in every task: `SessionRole`, `channelContext(base, exec, { role })`, `permissionContext`, `isStoreSave`, `STORE_TOOLS`, `troposStorePaths`, `LearningCounters`, `finish(timeoutMs)`, `shutdown({ finalReview })`, `ProjectContexts`, `retire()`, `ChatSession.command/learned/undoLearned`, `ownerChatKey`, `ownerCronTool`.
- **Review Focus:** each of the five lines has its test in Tasks 1, 2, 3, 6 and 8.
