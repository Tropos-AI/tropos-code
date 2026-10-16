# P5 — OpenClaw-style home layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the chief's identity, memory, journal and skills into `~/.tropos/workspace/` (OpenClaw's model), migrate existing homes automatically with a backup first, and keep every reader, writer, backup and import working on the new paths.

**Architecture:** `src/paths.ts` gets the C6 path functions; `src/home/layout.ts` holds the legacy→current table and the one-release fallback resolver every store uses; `src/home/migrate.ts` is the single migration engine, run at session/gateway start, by `doctor --fix`, after a restore and before `tcode migrate`. The journal becomes one file per day for all projects, with a project heading per entry, filtered per project on load and in the search index. Files of the chief that now sit inside the default project are guarded from generic file tools.

**Tech Stack:** TypeScript on Bun, zod, `bun:sqlite` FTS5, colocated `*.test.ts` (`bun test`), `bun run typecheck`.

**Spec:** `docs/superpowers/specs/2026-10-16-growing-agent-design.md` (Part E, §3); shared names in `docs/superpowers/plans/2026-10-16-contracts.md` (C2, C6); current memory design in `docs/superpowers/specs/2026-10-14-learning-identity-design.md`.

## Global Constraints

- C6 names exactly: `workspaceDir`, `workspaceFile(home, "AGENTS.md" | "SOUL.md" | "IDENTITY.md" | "USER.md" | "MEMORY.md" | "BOOTSTRAP.md")`, `journalDir` (= `workspace/memory`), `userSkillsDir` (= `workspace/skills`), `learnedSkillsDir` (= `workspace/skills-learned`), `agentsDir` (= `agents`). C2's `troposStorePaths(home)` is extended, never renamed, and never contains `workspaceDir(home)` itself (it is a project).
- A new user gets nothing pre-made except `workspace/AGENTS.md` (headings only, template in Task 5), `workspace/BOOTSTRAP.md` (only when no identity exists yet) and an empty `agents/`. No SOUL.md, USER.md, MEMORY.md, journal or skills are seeded.
- "`BOOTSTRAP.md` is only created when no identity exists yet, so existing installs never see the ritual again": decided once, in the run that first writes `layout.json`; created only when no IDENTITY.md (old or new) has a name and `identity.json` lacks `"bootstrapped": true`. New installs never write `identity.json`.
- Migration: backup first (`backups/tropos-layout-<stamp>.tar.gz`); if the backup fails, nothing moves. `projects/<key>/*.jsonl` and `projects/<key>/settings.json` are never touched; only `projects/<key>/notes/` is removed, after its day files are imported.
- Fallback to the old paths for one release: every fallback site carries the comment `// LEGACY_LAYOUT` so the next release deletes them with one grep.
- Caps unchanged: MEMORY.md 2,200 chars, USER.md 1,375, daily entry 2,000, daily context 2,800, SOUL.md 4,000. Directories 0700, files 0600.
- `~/.tropos/TROPOS.md`, `commands/`, `plugins/`, `projects/<key>/` sessions, repo-provided `TROPOS.md`/`AGENTS.md`/`CLAUDE.md` and project skills/commands/agents behave exactly as today. `agents/*.md` is read as before.
- No new runtime dependency. Each task ends green on its tests plus `bun run typecheck`. Tasks end with "Stage" (`git add`), never a commit.

## Review Focus

1. **The default workspace already holds files with the new names** (a chat wrote `MEMORY.md`, `AGENTS.md` or a `skills/` folder there before the upgrade): on the first migration they are renamed to `<name>.before-tropos-layout`, never overwritten, never adopted as the chief's trusted files. Test in Task 10.
2. **Two processes start at once** (the gateway service and a terminal session): exactly one migrates (lock); the other skips, reads through the fallback and does not fail. Test in Task 10.
3. **A guest or confined chat in the default workspace reaches the owner's private files** with Read/Edit/Grep/Bash: denied; the owner's terminal is asked, never auto-allowed by `Edit(**)` or accept-edits. Test in Task 8.
4. **Two projects write the journal on the same day, from two processes:** no entry is lost (`O_APPEND`), each session's context and `SessionSearch` show only that project's entries unless `all_projects`. Tests in Tasks 6 and 7.
5. **Restoring a backup made before the layout change:** files land at the new paths and notes in the journal, so nothing old shadows or is shadowed. Test in Task 11.

---

## File map

| File | Responsibility |
|---|---|
| `src/paths.ts` | C6 path functions (pure) |
| `src/home/layout.ts` (new) | legacy↔current table, fallback resolver, the chief's own paths, `layout.json` state |
| `src/home/migrate.ts` (new) | the migration engine, legacy notes import, report and notice |
| `src/memory/agents-file.ts` (new) | `workspace/AGENTS.md` template and its `## Lessons` / `## Heartbeat` sections |
| `src/memory/daily.ts` | the journal format, append, per-project read and context |
| `src/memory/notes.ts`, `src/context/identity.ts`, `src/memory/skill-manage.ts`, `src/learning/*`, `src/extensions/sources.ts`, `agent-manage.ts` | stores moved onto C6 paths |
| `src/memory/search-index.ts`, `session-search.ts` | journal indexing |
| `src/permissions/engine.ts`, `src/exec/confined.ts`, `src/exec/docker.ts` | guard of the chief's own files |
| `src/backup/*`, `src/uninstall/safety.ts`, `src/cli/lifecycle/{reset,migrate}.ts`, `src/migrate/plan.ts`, `src/doctor/checks/home-layout.ts` (new), `src/cli/main.tsx` | everything that walks or writes the home |

---

### Task 1: C6 paths and the legacy resolver

**Files:**
- Modify: `src/paths.ts`, `src/paths.test.ts`
- Create: `src/home/layout.ts`, `src/home/layout.test.ts`
- Modify: `src/gateway/projects.ts:27` (`defaultProjectPath = workspaceDir`)
- Modify: `src/learning/stores.ts` and its test (P1)

**Interfaces:**
- Consumes: `troposStorePaths(home: string): string[]` (C2, P1).
- Produces (`src/paths.ts`): `workspaceDir(home: string): string`; `type WorkspaceFileName = "AGENTS.md" | "SOUL.md" | "IDENTITY.md" | "USER.md" | "MEMORY.md" | "BOOTSTRAP.md"`; `workspaceFile(home: string, name: WorkspaceFileName): string`; `journalDir(home)`, `userSkillsDir(home)`, `learnedSkillsDir(home)`, `agentsDir(home)`: `string`.
- Produces (`src/home/layout.ts`):
  - `type LegacyItem = "SOUL.md" | "IDENTITY.md" | "USER.md" | "MEMORY.md" | "skills" | "skills-learned"`
  - `legacyPath(home: string, item: LegacyItem): string` (`SOUL.md`, `IDENTITY.md` at the home root; `USER.md`, `MEMORY.md` in `memories/`; `skills`, `skills-learned` at the root)
  - `currentPath(home: string, item: LegacyItem): string` (the C6 path)
  - `resolveLayoutPath(home: string, item: LegacyItem): string` — the current path unless only the legacy one exists (`lstatSync`, no following). `// LEGACY_LAYOUT`
  - `legacyToCurrent(rel: string): string | undefined` — a home-relative path in the old layout mapped to the new one: `SOUL.md`, `IDENTITY.md`, `SOUL.imported.md` → `workspace/<same>`; `memories/<f>` → `workspace/<f>`; `skills/<rest>` → `workspace/skills/<rest>`; `skills-learned/<rest>` → `workspace/skills-learned/<rest>`; anything else `undefined`.
  - `workspaceOwnPaths(home: string): string[]` — the six `workspaceFile`s, `journalDir`, `userSkillsDir`, `learnedSkillsDir`.
  - `LAYOUT_VERSION = 2`; `interface LayoutState { version: number; migratedAt: string; backup?: string }`; `readLayoutState(home): Promise<LayoutState | null>` (`<home>/layout.json`; missing or corrupt → `null`); `writeLayoutState(home, state): Promise<void>` (atomic, 0600).

- [ ] **Step 1: Write the failing tests**

```ts
// src/paths.test.ts
test("C6 paths", () => {
  expect(workspaceDir("/h")).toBe("/h/workspace");
  expect(workspaceFile("/h", "USER.md")).toBe("/h/workspace/USER.md");
  expect(journalDir("/h")).toBe("/h/workspace/memory");
  expect(userSkillsDir("/h")).toBe("/h/workspace/skills");
  expect(learnedSkillsDir("/h")).toBe("/h/workspace/skills-learned");
  expect(agentsDir("/h")).toBe("/h/agents");
});

// src/home/layout.test.ts
test("resolveLayoutPath falls back only when the legacy path alone exists", async () => {
  expect(resolveLayoutPath(home, "USER.md")).toBe(join(home, "workspace", "USER.md"));
  await put(join(home, "memories", "USER.md"), "x");
  expect(resolveLayoutPath(home, "USER.md")).toBe(join(home, "memories", "USER.md"));
  await put(join(home, "workspace", "USER.md"), "y");
  expect(resolveLayoutPath(home, "USER.md")).toBe(join(home, "workspace", "USER.md"));
});
test("legacyToCurrent", () => {
  expect(legacyToCurrent("memories/USER.md")).toBe("workspace/USER.md");
  expect(legacyToCurrent("memories/imported-hermes.md")).toBe("workspace/imported-hermes.md");
  expect(legacyToCurrent("SOUL.md")).toBe("workspace/SOUL.md");
  expect(legacyToCurrent("skills/a/SKILL.md")).toBe("workspace/skills/a/SKILL.md");
  expect(legacyToCurrent("skills-learned/.archive/b-2026-01-01/SKILL.md")).toBe("workspace/skills-learned/.archive/b-2026-01-01/SKILL.md");
  expect(legacyToCurrent("TROPOS.md")).toBeUndefined();
  expect(legacyToCurrent("projects/k/notes/2026-10-15.md")).toBeUndefined();
});
test("workspaceOwnPaths never includes the workspace itself", () => {
  expect(workspaceOwnPaths("/h")).not.toContain("/h/workspace");
  expect(workspaceOwnPaths("/h")).toHaveLength(9);
});
test("layout state round-trips; a corrupt file reads as null", async () => { /* write, read, then garbage → null */ });

// src/learning/stores.test.ts
test("store paths cover the workspace layout and keep the legacy ones", () => {
  const paths = troposStorePaths("/h");
  for (const p of [...workspaceOwnPaths("/h"), "/h/agents"]) expect(paths).toContain(p);
  expect(paths).not.toContain("/h/workspace");
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test src/paths.test.ts src/home/layout.test.ts src/learning/stores.test.ts`
Expected: FAIL (`workspaceDir` is not exported; `src/home/layout.ts` missing).

- [ ] **Step 3: Implement the C6 functions in `src/paths.ts` and `src/home/layout.ts` as specified; point `defaultProjectPath` at `workspaceDir`; add `workspaceOwnPaths(home)` and `agentsDir(home)` to `troposStorePaths` (keep its legacy entries, marked `// LEGACY_LAYOUT`).**

- [ ] **Step 4: Run them to verify they pass**

Run: `bun test src/paths.test.ts src/home/layout.test.ts src/learning/stores.test.ts src/gateway && bun run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 5: Stage**

```bash
git add src/paths.ts src/paths.test.ts src/home/layout.ts src/home/layout.test.ts src/gateway/projects.ts src/learning/stores.ts src/learning/stores.test.ts
```

---

### Task 2: Notes and identity files live in the workspace

**Files:**
- Modify: `src/memory/notes.ts`, `src/memory/notes.test.ts`, `src/memory/memory-tool.test.ts`
- Modify: `src/context/identity.ts`, `src/context/identity.test.ts`
- Modify: `src/context/memory.ts` (cap parameter), `src/context/memory.test.ts`
- Modify: `src/learning/ledger.ts`, `src/learning/ledger.test.ts`

**Interfaces:**
- Consumes: `resolveLayoutPath`, `legacyToCurrent`, `workspaceDir` (Task 1).
- Produces:
  - `NotesStore.path(target)` = `resolveLayoutPath(home, "MEMORY.md" | "USER.md")`; `NotesStore.dir` = `workspaceDir(home)`; writes `mkdir(dirname(path))`.
  - `truncateMemoryText(path, start, end, size, cap: number = MAX_FILE_CHARS): string` — head/tail/digest shares (45/15/35 %) computed from `cap`.
  - `notesContext` renders a store whose entries exceed its `MEMORY_LIMITS` (a hand edit) through `truncateMemoryText(path, text, null, size, limit)`.
  - `loadIdentity(home)` and the Identity tool read and write `resolveLayoutPath(home, "IDENTITY.md" | "SOUL.md")`; `homeFile` takes that absolute path and keeps its inside-the-home check.
  - `isLearnedPath(home, kind, path)`: `memory`/`user` accept `workspace/MEMORY.md`, `workspace/USER.md`; `identity` accepts `workspace/IDENTITY.md`, `workspace/SOUL.md`; the old paths stay accepted (`// LEGACY_LAYOUT`).
  - `Ledger.undo(id)`: when the entry's path no longer exists and `legacyToCurrent(relative(home, path))` names a file, the undo checks and writes that file instead.

- [ ] **Step 1: Write the failing tests**

```ts
// notes.test.ts (replaces the memories/ assertions of "add writes entries…")
test("add writes workspace/MEMORY.md, owner-only", async () => {
  await store.add("memory", "uses bun");
  expect(await readFile(join(home, "workspace", "MEMORY.md"), "utf8")).toBe("uses bun\n");
  expect((await stat(join(home, "workspace", "MEMORY.md"))).mode & 0o777).toBe(0o600);
});
test("a legacy memories/USER.md is read and written in place until migration moves it", async () => {
  await put(join(home, "memories", "USER.md"), "prefers tabs\n");
  await store.add("user", "lives in Athens");
  expect(await readFile(join(home, "memories", "USER.md"), "utf8")).toBe("prefers tabs\n§\nlives in Athens\n");
  expect(existsSync(join(home, "workspace", "USER.md"))).toBe(false);
});
test("a hand-edited USER.md over its cap loads head, tail and its policy lines", async () => {
  const middle = Array.from({ length: 80 }, (_, i) => `filler line ${i} about nothing much`).join("\n");
  await put(join(home, "workspace", "USER.md"), `starts here\n${middle}\nnever deploy on Fridays\n${middle}\nends here\n`);
  const ctx = await notesContext(store);
  expect(ctx).toContain("starts here");
  expect(ctx).toContain("ends here");
  expect(ctx).toContain("never deploy on Fridays");
  expect(ctx.length).toBeLessThan(MEMORY_LIMITS.user + 400);
});

// identity.test.ts
test("identity is read from the workspace, and from the old place until it moves", async () => { /* workspace wins; legacy alone is read */ });
test("set writes workspace/IDENTITY.md", async () => { /* run the tool, expect file at join(home,"workspace","IDENTITY.md") */ });

// ledger.test.ts
test("workspace memory and identity files are learned paths", () => {
  expect(isLearnedPath(home, "user", join(home, "workspace", "USER.md"))).toBe(true);
  expect(isLearnedPath(home, "identity", join(home, "workspace", "SOUL.md"))).toBe(true);
  expect(isLearnedPath(home, "memory", join(home, "workspace", "README.md"))).toBe(false);
  expect(isLearnedPath(home, "user", join(home, "memories", "USER.md"))).toBe(true);
});
test("undo of a change recorded before the move restores the moved file", async () => {
  // record at memories/USER.md (before "a", after "a\n§\nb"), move the file to workspace/USER.md, undo → workspace/USER.md === "a"
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test src/memory/notes.test.ts src/context/identity.test.ts src/context/memory.test.ts src/learning/ledger.test.ts`
Expected: FAIL (files are still written under `memories/` and the home root).

- [ ] **Step 3: Implement the Produces list above.** Update the existing tests in these files that assert `memories/` or root-level `IDENTITY.md`/`SOUL.md` to the workspace paths (that is the intended change).

- [ ] **Step 4: Run them to verify they pass**

Run: `bun test src/memory src/context src/learning && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Stage**

```bash
git add src/memory/notes.ts src/memory/notes.test.ts src/memory/memory-tool.test.ts src/context/identity.ts src/context/identity.test.ts src/context/memory.ts src/context/memory.test.ts src/learning/ledger.ts src/learning/ledger.test.ts
```

---

### Task 3: Skills folders live in the workspace; agents through `agentsDir`

**Files:**
- Modify: `src/extensions/sources.ts`, `src/extensions/sources.test.ts`
- Modify: `src/memory/skill-manage.ts`, `src/memory/skill-manage.test.ts`
- Modify: `src/learning/skill-usage.ts`, `src/learning/skill-usage.test.ts`, `src/learning/curator.ts`, `src/learning/curator.test.ts`, `src/learning/ledger.ts` (skill roots), `src/learning/ledger.test.ts`
- Modify: `src/extensions/agent-manage.ts`, `src/cli/runtime.ts:181,658-661`, `src/gateway/curator-service.ts` and its test (P1 Task 13)

**Interfaces:**
- Consumes: `resolveLayoutPath`, `agentsDir` (Task 1).
- Produces:
  - `extensionDirs(kind, opts)`: skills → `{ dir: resolveLayoutPath(home, "skills"), source: "user" }`, `{ dir: resolveLayoutPath(home, "skills-learned"), source: "learned" }`; agents → `{ dir: agentsDir(home), source: "user" }`; commands unchanged.
  - `SkillManageOptions.dir?: string` replaces `folder?: string` (absolute; default `resolveLayoutPath(home, "skills")`). `runtime.ts:181` passes `dir: resolveLayoutPath(ctx.home, "skills-learned")`.
  - `usagePath(home)` = `<resolveLayoutPath(home, "skills")>/.usage.json`.
  - `runCurator(home, opts)` default `skillsDir` = `resolveLayoutPath(home, "skills-learned")`; the runtime call passes nothing and its notice names `<learned dir>/.archive`. P1's `createCuratorService` (`src/gateway/curator-service.ts`) stops passing `skillsDir: join(deps.home, LEARNED_SKILLS_DIR)` and passes nothing either, so the gateway curates the workspace folder.
  - Ledger `skill` kind accepts `workspace/skills/<name>/<file>` and `workspace/skills-learned/<name>/<file>` (dot-folders excluded), legacy roots still accepted (`// LEGACY_LAYOUT`).
  - `LEARNED_SKILLS_DIR` stays exported with its doc comment changed to "the folder's name, inside the workspace (and at the home root before the layout change)".
  - AgentManage's root = `agentsDir(home)`.

- [ ] **Step 1: Write the failing tests**

```ts
// sources.test.ts
test("user and learned skills come from the workspace", () => {
  const [user, learned] = extensionDirs("skills", { cwd, home });
  expect(user).toEqual({ dir: join(home, "workspace", "skills"), source: "user" });
  expect(learned).toEqual({ dir: join(home, "workspace", "skills-learned"), source: "learned" });
});
test("an un-migrated home keeps loading ~/.tropos/skills", async () => {
  await mkdir(join(home, "skills"), { recursive: true });
  expect(extensionDirs("skills", { cwd, home })[0]!.dir).toBe(join(home, "skills"));
});
// skill-manage.test.ts
test("create writes workspace/skills/<name>/SKILL.md; dir points the review at skills-learned", async () => { /* … */ });
// skill-usage.test.ts
test("usage lives in workspace/skills/.usage.json", () => expect(usagePath(home)).toBe(join(home, "workspace", "skills", ".usage.json")));
// curator.test.ts
test("archives into workspace/skills-learned/.archive", async () => { /* stale learned skill → .archive/<name>-<date>/SKILL.md */ });
// ledger.test.ts
test("workspace skill files are learned paths; .archive is not", () => {
  expect(isLearnedPath(home, "skill", join(home, "workspace", "skills-learned", "x", "SKILL.md"))).toBe(true);
  expect(isLearnedPath(home, "skill", join(home, "workspace", "skills-learned", ".archive", "x", "SKILL.md"))).toBe(false);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test src/extensions src/memory/skill-manage.test.ts src/learning`
Expected: FAIL (dirs still `<home>/skills`).

- [ ] **Step 3: Implement the Produces list; update the existing assertions in these test files and in `src/cli/runtime.test.ts` / `src/cli/extensions.test.ts` that name `<home>/skills` or `<home>/skills-learned`.**

- [ ] **Step 4: Run them to verify they pass**

Run: `bun test src/extensions src/memory src/learning src/cli && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Stage**

```bash
git add src/extensions/sources.ts src/extensions/sources.test.ts src/memory/skill-manage.ts src/memory/skill-manage.test.ts src/learning/skill-usage.ts src/learning/skill-usage.test.ts src/learning/curator.ts src/learning/curator.test.ts src/learning/ledger.ts src/learning/ledger.test.ts src/extensions/agent-manage.ts src/cli/runtime.ts src/cli/runtime.test.ts src/cli/extensions.test.ts src/gateway/curator-service.ts src/gateway/curator-service.test.ts
```

---

### Task 4: BOOTSTRAP.md replaces the `bootstrapped` flag

**Files:**
- Modify: `src/context/identity.ts`, `src/context/identity.test.ts`
- Modify: `src/cli/extensions.ts:224`, `src/cli/extensions.test.ts`

**Interfaces:**
- Consumes: `workspaceFile` (Task 1), the Identity changes of Task 2.
- Produces:
  - `BOOTSTRAP_TEXT: string` — the file's initial content (copy below).
  - `loadBootstrap(home): Promise<string | null>` — `workspace/BOOTSTRAP.md` read (≤ 4,000 chars), threat-scanned (a failing file becomes `blockedPlaceholder`), `null` when absent.
  - `bootstrapPending(home): Promise<boolean>` — `true` only when BOOTSTRAP.md exists and the identity has no name. `identity.json` is no longer read here.
  - `markBootstrapped(home): Promise<void>` — deletes `workspace/BOOTSTRAP.md` (no error when absent); no longer writes `identity.json` (P4's identity step keeps calling it unchanged).
  - `bootstrapContext(text: string = BOOTSTRAP_TEXT): string` — `<bootstrap>\n${neutralised text}\n</bootstrap>`; `contextExtras` passes the loaded file text.
  - Identity tool targets: `set` → `[IDENTITY.md, BOOTSTRAP.md]`, `skip` → `[BOOTSTRAP.md]`; both delete BOOTSTRAP.md after saving.
  - `IDENTITY_STATE_FILE` stays exported (the migration reads it, Task 10).

`BOOTSTRAP_TEXT` (exact):

```
# BOOTSTRAP.md

This is your first session with this user, and you don't have a name yet.
- Handle the user's request first. The ritual below comes after it or alongside it, never instead of it.
- At a natural moment (a pause, or the end of your first reply), ask what they'd like to call you. Propose a one-line vibe and one emoji to go with it; if they veto one, offer another once.
- Save the result with the Identity tool, action "set" (name, emoji, vibe). If they don't care to choose, call Identity with action "skip".
- Don't invent a name without asking. Mention this once, not every turn.
- Saving or skipping deletes this file, and the ritual doesn't come back.
```

- [ ] **Step 1: Write the failing tests**

```ts
test("without BOOTSTRAP.md nothing is pending, even with no name and no identity.json", async () => {
  expect(await bootstrapPending(home)).toBe(false);
});
test("BOOTSTRAP.md and no name: pending, and the context carries the file", async () => {
  await put(join(home, "workspace", "BOOTSTRAP.md"), BOOTSTRAP_TEXT);
  expect(await bootstrapPending(home)).toBe(true);
  expect(bootstrapContext((await loadBootstrap(home))!)).toContain("ask what they'd like to call you");
});
test("a name ends the ritual even if the file is still there", async () => { /* IDENTITY.md with Name → false */ });
test("set and skip delete BOOTSTRAP.md and never write identity.json", async () => {
  // run Identity set → !exists(BOOTSTRAP.md) && !exists(identity.json); same for skip
});
test("a BOOTSTRAP.md that fails the threat scan is shown blocked", async () => { /* expect "[blocked:" */ });
// extensions.test.ts
test("the interactive main session gets <bootstrap> only while BOOTSTRAP.md exists", async () => { /* … */ });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test src/context/identity.test.ts src/cli/extensions.test.ts`
Expected: FAIL (`BOOTSTRAP_TEXT`/`loadBootstrap` not exported; pending still follows `identity.json`).

- [ ] **Step 3: Implement the Produces list; drop `BOOTSTRAP_NOTE`; update existing identity tests that relied on `identity.json`.** P4's tests that expect a bare home to be pending (`saveIdentity` in `src/context/identity.test.ts`, the identity rows of `src/onboard/engine.test.ts`, `identityStep` in `src/cli/lifecycle/onboard-steps.test.ts`) first write `workspace/BOOTSTRAP.md` (`BOOTSTRAP_TEXT`), as a migrated fresh install has it; P4's rule "identity is done when `!bootstrapPending(home)`" stays as it is.

- [ ] **Step 4: Run them to verify they pass**

Run: `bun test src/context src/cli/extensions.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Stage**

```bash
git add src/context/identity.ts src/context/identity.test.ts src/cli/extensions.ts src/cli/extensions.test.ts src/onboard/engine.test.ts src/cli/lifecycle/onboard-steps.test.ts
```

---

### Task 5: `workspace/AGENTS.md` and its Lessons

**Files:**
- Create: `src/memory/agents-file.ts`, `src/memory/agents-file.test.ts`
- Modify: `src/context/memory.ts`, `src/context/memory.test.ts`
- Modify: `src/memory/notes.ts`, `src/memory/notes.test.ts`, `src/memory/memory-tool.ts`, `src/memory/memory-tool.test.ts`
- Modify: `src/learning/ledger.ts` (memory kind accepts `workspace/AGENTS.md`), `src/learning/review-prompts.ts`
- Modify: `src/cli/runtime.ts` (`/memory` panel gets a Lessons section)

**Interfaces:**
- Consumes: `workspaceFile` (Task 1).
- Produces (`src/memory/agents-file.ts`):
  - `AGENTS_TEMPLATE: string` (copy below); `type AgentsSection = "Lessons" | "Heartbeat"`.
  - `sectionEntries(text: string, section: AgentsSection): string[]` — the `- ` items under `## <section>` up to the next `## ` heading; indented lines continue an item.
  - `withSectionEntries(text: string | null, section: AgentsSection, entries: string[]): string` — rewrites only that section's items (its non-item lines stay first, in order); a missing section is appended at the end; `null` text starts from `AGENTS_TEMPLATE`. Every other byte is kept.
  - `stripAgentSections(text: string): string` — the file without both sections.
  - P7 Task 12 reads `sectionEntries(text, "Heartbeat")` (its `heartbeatSection`) and adds its own Memory target `"heartbeat"` the same way `lessons` is added here.
- Produces (stores):
  - `NotesTarget = "memory" | "user" | "lessons"`; `MEMORY_LIMITS.lessons = 2_200`; `NotesStore.path("lessons")` = `workspaceFile(home, "AGENTS.md")`; entries via `sectionEntries`/`withSectionEntries` under the same lock, scan and ledger (kind `"memory"`).
  - `notesContext` default targets `["memory", "user", "lessons"]`; lessons render as `<notes source="lessons">`. Subagents keep `["memory"]`.
  - Memory tool `target` enum adds `"lessons"`, described: `"lessons" for how to work with this user that you learned the hard way (a correction, an approach that failed and the one that worked), one line each; kept in your workspace AGENTS.md.`
  - `loadMemory(cwd, home)`: right after `~/.tropos/TROPOS.md`, `workspace/AGENTS.md` with `stripAgentSections` applied, `source: "user"`, same symlink scope as TROPOS.md. In the default workspace it appears once (the existing canonical-path dedupe keeps the first).
  - Review memory prompt gains one sentence: `Lessons about how to work (corrections, what failed and what worked) go to Memory target "lessons".`

`AGENTS_TEMPLATE` (exact):

```
# AGENTS.md

How I work with you. You can edit this file; I keep the two sections below up to date myself.

## Lessons

## Heartbeat
```

- [ ] **Step 1: Write the failing tests**

```ts
// agents-file.test.ts
test("the template has two empty sections", () => {
  expect(sectionEntries(AGENTS_TEMPLATE, "Lessons")).toEqual([]);
  expect(sectionEntries(AGENTS_TEMPLATE, "Heartbeat")).toEqual([]);
});
test("withSectionEntries rewrites one section and keeps every other byte", () => {
  const text = "# AGENTS.md\n\nRules.\n\n## Lessons\n\nintro line\n- old\n\n## Heartbeat\n- check CI\n\n## Mine\nkeep me\n";
  const out = withSectionEntries(text, "Lessons", ["new one", "two\nlines"]);
  expect(sectionEntries(out, "Lessons")).toEqual(["new one", "two\nlines"]);
  expect(out).toContain("intro line");
  expect(out).toContain("## Heartbeat\n- check CI\n\n## Mine\nkeep me\n");
});
test("a missing section is appended; null starts from the template", () => { /* … */ });
test("stripAgentSections removes only Lessons and Heartbeat", () => { /* … */ });
// memory.test.ts
test("workspace/AGENTS.md loads as the user's file, without its agent sections", async () => {
  // TROPOS.md + workspace/AGENTS.md with "rule A" and "## Lessons\n- lesson B"
  // → files[1] = { path: …/workspace/AGENTS.md, source: "user" }, content has "rule A", not "lesson B"
});
test("in the default workspace AGENTS.md is loaded once", async () => { /* cwd = join(home,"workspace") */ });
// notes.test.ts
test("lessons are items in AGENTS.md, budgeted at 2,200 chars", async () => {
  await store.add("lessons", "run bun test before saying done");
  expect(sectionEntries(await readFile(join(home, "workspace", "AGENTS.md"), "utf8"), "Lessons")).toEqual(["run bun test before saying done"]);
  expect(await store.add("lessons", "x".repeat(2_300))).toMatchObject({ ok: false });
  expect(await notesContext(store)).toContain('<notes source="lessons">');
});
// memory-tool.test.ts
test("target lessons asks about workspace/AGENTS.md", () => { /* subject paths */ });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test src/memory src/context/memory.test.ts`
Expected: FAIL (module missing; `lessons` not a target).

- [ ] **Step 3: Implement the Produces lists.**

- [ ] **Step 4: Run them to verify they pass**

Run: `bun test src/memory src/context src/learning src/cli && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Stage**

```bash
git add src/memory/agents-file.ts src/memory/agents-file.test.ts src/context/memory.ts src/context/memory.test.ts src/memory/notes.ts src/memory/notes.test.ts src/memory/memory-tool.ts src/memory/memory-tool.test.ts src/learning/ledger.ts src/learning/review-prompts.ts src/cli/runtime.ts
```

---

### Task 6: The journal (`workspace/memory/<date>.md`)

**Files:**
- Modify: `src/memory/daily.ts`, `src/memory/daily.test.ts`
- Modify: `src/learning/ledger.ts` (daily kind), `src/learning/ledger.test.ts`
- Modify: `src/migrate/plan.ts` (import rename only)
- Modify: `src/cli/runtime.ts` (P1 Task 3's `permissionContext`), `src/cli/runtime.test.ts`

**Interfaces:**
- Consumes: `journalDir` (Task 1), `projectDir` (`src/session/store.ts`), P1's `permissionContext(ctx, mode)`.
- Produces:
  - `interface JournalEntry { time?: string; name: string; path: string; body: string }`.
  - `formatJournalEntry(e: JournalEntry): string` — `## HH:MM · <name> (<path>)` (or `## <name> (<path>)` without a time), then the body as today's list item (`- first line`, continuation lines indented two spaces), then a blank line. `<path>` shows the user's home as `~`.
  - `parseJournal(text: string): JournalEntry[]` — headings as above (path = text inside the last ` (`…`)`, `~` expanded); the `# <date>` title and anything before the first heading are ignored.
  - `appendJournalText(file: string, text: string): Promise<void>` — `open(O_WRONLY|O_APPEND|O_CREAT|O_NOFOLLOW, 0o600)`, one write; the directory is created 0700. Concurrent appends from separate processes never overwrite each other.
  - `DailyNotes(home, cwd, opts)` (same constructor): `path(date)` = `<journalDir>/<date>.md`; `append` writes `# <date>\n\n` first when the file is new, then one entry block for this cwd (`name` = `basename(cwd)`), dedupes only against this project's entries of the day, records the ledger change `{ before, after: before + block }`; `read(date)` returns this project's entries in today's list format (`- HH:MM text`), preceded by the legacy `projects/<key>/notes/<date>.md` text when that file still exists (`// LEGACY_LAYOUT`); `recent(days)` keeps its meaning per project.
  - `dailyNotesContext` unchanged in shape and budget (2,800), fed by the per-project `read`.
  - `legacyNotesDir(home, cwd): string` replaces `dailyNotesDir` (same value, `// LEGACY_LAYOUT`); `src/migrate/plan.ts` imports the new name (its behaviour changes in Task 12).
  - P1's `permissionContext` in `src/cli/runtime.ts` builds `stores.paths` as `[...troposStorePaths(ctx.home), legacyNotesDir(ctx.home, ctx.cwd)]` (was `dailyNotesDir(…)`), with the legacy entry marked `// LEGACY_LAYOUT`. The journal itself is covered by `journalDir(home)`, which `troposStorePaths` holds since Task 1.
  - DailyNote tool description: `Append a durable note (a decision, a finding, the state of the work) to today's journal under this project's name.` (rest unchanged); its subject is the journal file.
  - Ledger `daily` kind accepts `workspace/memory/YYYY-MM-DD.md`; legacy `projects/<key>/notes/<date>.md` still accepted.

- [ ] **Step 1: Write the failing tests**

```ts
const at = () => new Date(2026, 9, 16, 9, 12);
test("append writes a dated journal with a project heading per entry, owner-only", async () => {
  const notes = new DailyNotes(home, "/work/app", { now: at });
  await notes.append("decided to use FTS5");
  const file = join(home, "workspace", "memory", "2026-10-16.md");
  expect(await readFile(file, "utf8")).toBe("# 2026-10-16\n\n## 09:12 · app (/work/app)\n- decided to use FTS5\n\n");
  expect((await stat(file)).mode & 0o777).toBe(0o600);
});
test("each project reads and loads only its own entries", async () => {
  const a = new DailyNotes(home, "/work/app", { now: at });
  const b = new DailyNotes(home, "/work/site", { now: at });
  await a.append("A note");
  await b.append("B note");
  expect(await a.read("2026-10-16")).toBe("- 09:12 A note");
  expect(await dailyNotesContext(b)).not.toContain("A note");
});
test("the same text in another project is not a duplicate", async () => { /* b.append("A note") → ok */ });
test("twenty parallel appends from two writers all land", async () => {
  const a = new DailyNotes(home, "/work/app", { now: at });
  const b = new DailyNotes(home, "/work/site", { now: at });
  await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? a : b).append(`entry ${i}`)));
  expect(parseJournal(await readFile(a.path("2026-10-16"), "utf8"))).toHaveLength(20);
});
test("a symlink planted at the day file is not followed", async () => { /* symlink → outside file; append fails; outside file unchanged */ });
test("legacy notes of this project are still read", async () => { /* projects/<key>/notes/2026-10-16.md "- 08:00 old" → read() contains it */ });
test("parseJournal round-trips formatJournalEntry, multi-line bodies and ~ paths", () => { /* … */ });
// runtime.test.ts
test("the owner's DailyNote save to the journal is a store save without a prompt", async () => { /* permissionContext(ctx, "default").stores.paths contains journalDir(home) and legacyNotesDir(home, cwd) */ });
// ledger.test.ts
test("journal days are learned paths", () => {
  expect(isLearnedPath(home, "daily", join(home, "workspace", "memory", "2026-10-16.md"))).toBe(true);
  expect(isLearnedPath(home, "daily", join(home, "workspace", "memory", "notes.md"))).toBe(false);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test src/memory/daily.test.ts src/learning/ledger.test.ts src/cli/runtime.test.ts`
Expected: FAIL (`parseJournal` missing; notes still under `projects/<key>/notes`).

- [ ] **Step 3: Implement the Produces list; adapt the existing daily tests (budget, dedupe, scan) to the journal file.**

- [ ] **Step 4: Run them to verify they pass**

Run: `bun test src/memory src/learning src/migrate src/cli && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Stage**

```bash
git add src/memory/daily.ts src/memory/daily.test.ts src/learning/ledger.ts src/learning/ledger.test.ts src/migrate/plan.ts src/cli/runtime.ts src/cli/runtime.test.ts
```

---

### Task 7: SessionSearch indexes the journal

**Files:**
- Modify: `src/memory/search-index.ts`, `src/memory/search-index.test.ts`
- Modify: `src/memory/session-search.ts`, `src/memory/session-search.test.ts`

**Interfaces:**
- Consumes: `journalDir` (Task 1), `parseJournal`, `DAY_FILE` (Task 6), `projectDir`.
- Produces:
  - `SCHEMA_VERSION = 2` (an older index is rebuilt).
  - `SearchIndex.refresh` always also refreshes the journal: for each `<journalDir>/<date>.md`, one `note` doc per project found in it, with `path = "<file>#<projectDir(home, entry.path)>"`, `project = projectDir(home, entry.path)`, `doc_id = date`, `title = "Notes <date>"`, the day file's `mtime`/`size`, one chunk per entry body. A day file whose mtime or size changed has all its `<file>#…` docs replaced; a removed day file's docs are dropped. `forgetProject` leaves journal docs alone.
  - Legacy `projects/<key>/notes/` keeps being indexed as today (`// LEGACY_LAYOUT`).
  - Fallback scan (`index: null`): journal entries of the searched project dirs count as `note` candidates. Read mode with a date shows this project's journal entries (all searched projects with `all_projects`), plus legacy notes.

- [ ] **Step 1: Write the failing tests**

```ts
test("journal entries are found for their own project only", async () => {
  // journal 2026-10-16 with entries for /work/app ("deploy uses fly") and /work/site ("deploy uses netlify")
  const hits = index.search("deploy", { source: "notes", projectDirs: [projectDir(home, "/work/app")], limit: 10 });
  expect(hits.map((h) => [h.id, h.snippets.length])).toEqual([["2026-10-16", 1]]);
  expect(hits[0]!.snippets[0]!.text).toContain("fly");
});
test("all projects find both, each under its project", async () => { /* two results, projects differ */ });
test("an edited journal is re-indexed; a deleted day is forgotten", async () => { /* … */ });
test("a schema-1 index is rebuilt", async () => { /* PRAGMA user_version = 1 → open → 2 */ });
// session-search.test.ts
test("without the index, the scan finds this project's journal entries", async () => { /* index: null */ });
test("read mode with a date shows this project's journal entries", async () => { /* session_id "2026-10-16" */ });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test src/memory/search-index.test.ts src/memory/session-search.test.ts`
Expected: FAIL (journal files are not indexed).

- [ ] **Step 3: Implement the Produces list.**

- [ ] **Step 4: Run them to verify they pass**

Run: `bun test src/memory && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Stage**

```bash
git add src/memory/search-index.ts src/memory/search-index.test.ts src/memory/session-search.ts src/memory/session-search.test.ts
```

---

### Task 8: Guard the chief's own files inside the default project

The default project is `workspace/`, so USER.md, SOUL.md and the journal now sit where project tools reach them. Only the store tools may change them; non-owner sessions may not read them.

**Files:**
- Modify: `src/permissions/engine.ts`, `src/permissions/engine.test.ts`
- Modify: `src/cli/runtime.ts:142,272` (permission contexts)
- Modify: `src/exec/confinement-paths.ts`, `src/exec/sandbox-profile.ts`, `src/exec/bwrap-args.ts` and their tests (P2 Task 5)
- Modify: `src/exec/docker.ts`, `src/exec/docker.test.ts`, `src/gateway/chat-exec.ts` (P2 Task 7's `chatBackend`, which now builds the `DockerBackend`)

**Interfaces:**
- Consumes: `workspaceOwnPaths` (Task 1); P1's `role` on `PermissionContext` and P1's `STORE_TOOLS` (`src/learning/stores.ts`, Task 3); P2's confinement builders (`confinementPaths`, `sandboxProfile`, `bwrapArgs`, Task 5).
- Produces:
  - `PermissionContext.ownFiles?: string[]`; runtime sets it to `workspaceOwnPaths(ctx.home)`.
  - In `decide`, after deny rules: a request by a tool **not** in the store-tool set with a path inside `ownFiles` → `deny` with reason `"<path> is Tropos's own memory; only its memory tools may use it in this session."` when `confine` is set or `role !== "owner"`; otherwise (owner, unconfined, not bypass) → `ask` with reason `"Tropos's own file: <path>"`, never allowed by a bare or broad allow rule nor by accept-edits. Search tools then skip these files through the existing `isDenied`.
  - `ConfinementPaths` (P2) gains `ownFiles: string[]` = `workspaceOwnPaths(home)`. `sandboxProfile` adds a last `(deny file-read* file-write* …)` for them, after the `~/.tropos/workspace` carve-out (the last match wins); `bwrapArgs` masks each existing one after the carve-out bind (`--tmpfs` for a folder, `--ro-bind /dev/null` for a file). They stay denied for read and write despite the carve-out.
  - `DockerBackendOptions.hide?: string[]` — each existing path inside `workspace` is masked: a file with `-v /dev/null:<path>:ro`, a directory with `--tmpfs <path>:ro`. P2's `chatBackend` passes `hide: workspaceOwnPaths(home)`.

- [ ] **Step 1: Write the failing tests**

```ts
const own = [join(home, "workspace", "USER.md"), join(home, "workspace", "memory")];
const base = { mode: "default", rules: compileRules({ allow: ["Edit(**)"], ask: [], deny: [] }).rules, cwd: ws, home: userHome, allowedDirs: [ws], ownFiles: own } as const;
test("a confined session can't read or edit the chief's files", () => {
  const d = decide({ toolName: "Read", kind: "read", paths: [join(ws, "USER.md")] }, { ...base, confine: true, role: "owner" });
  expect(d).toMatchObject({ behavior: "deny" });
  expect(decide({ toolName: "Grep", kind: "read", paths: [join(ws, "memory", "2026-10-16.md")] }, { ...base, confine: true, role: "owner" }).behavior).toBe("deny");
});
test("a guest is denied even unconfined", () => { /* role "guest" → deny */ });
test("the owner's terminal is asked, never auto-allowed by Edit(**) or accept-edits", () => {
  expect(decide({ toolName: "Edit", kind: "edit", paths: [join(ws, "USER.md")] }, { ...base, role: "owner" }).behavior).toBe("ask");
  expect(decide({ toolName: "Edit", kind: "edit", paths: [join(ws, "USER.md")] }, { ...base, mode: "acceptEdits", role: "owner" }).behavior).toBe("ask");
});
test("store tools are not affected by the guard", () => { /* Memory on workspace/USER.md, owner → C2 decides (allow) */ });
test("other workspace files are untouched by the guard", () => { /* Edit ws/app.ts with Edit(**) → allow */ });
// sandbox-profile.test.ts / bwrap-args.test.ts
test("the profile denies reading and writing workspace/USER.md though the workspace is writable", () => { /* the own-files deny comes after the carve-out */ });
// docker.test.ts
test("hidden paths are masked inside the container", () => {
  // existing ws/USER.md and ws/memory → args contain "-v", `/dev/null:${ws}/USER.md:ro` and "--tmpfs", `${ws}/memory:ro`; a missing path adds nothing
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test src/permissions src/exec`
Expected: FAIL (`ownFiles` unknown; reads allowed inside the project).

- [ ] **Step 3: Implement the Produces list.**

- [ ] **Step 4: Run them to verify they pass**

Run: `bun test src/permissions src/exec src/cli src/gateway && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Stage**

```bash
git add src/permissions/engine.ts src/permissions/engine.test.ts src/cli/runtime.ts src/exec/confinement-paths.ts src/exec/confinement-paths.test.ts src/exec/sandbox-profile.ts src/exec/sandbox-profile.test.ts src/exec/bwrap-args.ts src/exec/bwrap-args.test.ts src/exec/docker.ts src/exec/docker.test.ts src/gateway/chat-exec.ts
```

---

### Task 9: Backups, reset and uninstall know the new layout

**Files:**
- Modify: `src/backup/plan.ts`, `src/backup/manifest.ts`, `src/backup/risky.ts`, `src/backup/backup.test.ts`
- Modify: `src/uninstall/safety.ts`, `src/cli/lifecycle/uninstall.test.ts`
- Modify: `src/cli/lifecycle/reset.test.ts`

**Interfaces:**
- Consumes: `workspaceOwnPaths`, `agentsDir` (Task 1).
- Produces:
  - `planBackup` always includes the chief's files (`workspaceOwnPaths` relative to the home), `agents/`, and — while they exist — the legacy roots `memories/`, `skills/`, `skills-learned/`, `SOUL.imported.md` and every `projects/*/notes/` (`// LEGACY_LAYOUT`), whatever `sessions` says; the rest of `workspace/` only with `workspace: true` (no file twice). `describeSelection` lists `"workspace/ (Tropos's own files: AGENTS.md, SOUL.md, IDENTITY.md, USER.md, MEMORY.md, BOOTSTRAP.md, memory/, skills/, skills-learned/)"` and `"agents/"` in `includes`; without `workspace` the excludes say `"workspace/ (your other files there)"`.
  - `PARTS` gains `"agents"`. `partOf`: `workspace/{SOUL,IDENTITY,AGENTS,BOOTSTRAP}.md` → `identity`; `workspace/{USER,MEMORY}.md`, `workspace/memory/**`, `workspace/imported-*.md` → `memory`; `workspace/skills/**`, `workspace/skills-learned/**`, `skills-learned/**` → `skills`; `agents/**` → `agents`; `projects/*/notes/**` → `memory`; legacy mappings unchanged; other `workspace/**` → `workspace`.
  - `classifyRisky` also flags `workspace/SOUL.md`, `workspace/IDENTITY.md`, `workspace/AGENTS.md` ("instructions the agent follows in every session"), `workspace/skills/**` and `workspace/skills-learned/**` ("a skill: …"), `agents/**` ("a subagent: instructions the agent can start").
  - `KNOWN_TROPOS_ENTRIES` gains `"agents"`, `"skills-learned"`, `"layout.json"`.
  - `tcode reset`: `config+creds+sessions` keeps `workspace/` (the journal and notes are memory, not sessions); `full` removes everything as today. No code change expected; the tests pin it.

- [ ] **Step 1: Write the failing tests**

```ts
test("a default backup holds the chief's files but not the user's other workspace files", async () => {
  // seed workspace/{USER.md,AGENTS.md,app.ts}, workspace/memory/2026-10-16.md, workspace/skills/a/SKILL.md,
  // workspace/skills-learned/b/SKILL.md, agents/r.md, skills-learned/c/SKILL.md, projects/k/notes/2026-10-15.md
  const rels = (await planBackup(home, { quick: true, sessions: false, secrets: false, workspace: false })).entries.map((e) => e.rel);
  for (const r of ["workspace/USER.md", "workspace/AGENTS.md", "workspace/memory/2026-10-16.md", "workspace/skills/a/SKILL.md", "workspace/skills-learned/b/SKILL.md", "agents/r.md", "skills-learned/c/SKILL.md", "projects/k/notes/2026-10-15.md"]) expect(rels).toContain(r);
  expect(rels).not.toContain("workspace/app.ts");
});
test("with workspace on, nothing is listed twice", async () => { /* new Set(rels).size === rels.length */ });
test("partOf knows the new layout", () => {
  expect(partOf("workspace/SOUL.md")).toBe("identity");
  expect(partOf("workspace/memory/2026-10-16.md")).toBe("memory");
  expect(partOf("workspace/skills-learned/b/SKILL.md")).toBe("skills");
  expect(partOf("agents/r.md")).toBe("agents");
  expect(partOf("workspace/app.ts")).toBe("workspace");
  expect(partOf("memories/USER.md")).toBe("memory");
});
test("restoring the chief's files is flagged as risky", () => { /* classifyRisky on workspace/AGENTS.md, agents/r.md */ });
// reset.test.ts
test("the default reset scope keeps the journal and notes", async () => { /* resetTargets excludes workspace/** */ });
// uninstall.test.ts
test("a TROPOS_HOME holding only agents/ counts as Tropos data", async () => { /* dataDirProblem → undefined */ });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test src/backup src/cli/lifecycle/reset.test.ts src/cli/lifecycle/uninstall.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the Produces list.**

- [ ] **Step 4: Run them to verify they pass**

Run: `bun test src/backup src/cli/lifecycle src/uninstall src/web/admin/backup.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Stage**

```bash
git add src/backup/plan.ts src/backup/manifest.ts src/backup/risky.ts src/backup/backup.test.ts src/uninstall/safety.ts src/cli/lifecycle/uninstall.test.ts src/cli/lifecycle/reset.test.ts
```

---

### Task 10: The layout migration

**Files:**
- Create: `src/home/migrate.ts`, `src/home/migrate.test.ts`

**Interfaces:**
- Consumes: Task 1 (`legacyPath`, `currentPath`, `readLayoutState`, `writeLayoutState`, `workspaceOwnPaths`, `LAYOUT_VERSION`), `AGENTS_TEMPLATE` (Task 5), `BOOTSTRAP_TEXT`, `IDENTITY_STATE_FILE`, `parseIdentityFile` (Task 4), `formatJournalEntry`, `appendJournalText`, `parseJournal`, `legacyNotesDir` (Task 6), `createBackup`, `stamp`, `BackupError` (`src/backup`), `projectKey`, `listProjects`.
- Produces:
  - `interface LayoutMigration { ran: boolean; moved: string[]; setAside: string[]; notesImported: number; notesLeft: string[]; conflicts: string[]; backup?: string; bootstrapCreated: boolean; error?: string }`
  - `interface LayoutOptions { now: () => number; version: string; backup?: boolean; tarBin?: string }` (`backup` default `true`; `tarBin` is the test seam `createBackup` already has).
  - `migrateHomeLayout(home: string, opts: LayoutOptions): Promise<LayoutMigration>`
  - `ensureHomeLayout(home: string, opts: LayoutOptions): Promise<LayoutMigration>` — `{ ran: false, … }` without touching anything when `layout.json` has `version >= LAYOUT_VERSION`; otherwise `migrateHomeLayout`.
  - `importLegacyNotes(home: string): Promise<{ imported: number; left: string[] }>`
  - `legacyLayoutReport(home: string): Promise<{ movable: string[]; conflicts: string[]; notesLeft: string[] }>` (home-relative paths; for the doctor)
  - `layoutNotice(r: LayoutMigration): string | null` (copy below)

`migrateHomeLayout`, in order (the order is the decision; the signature doesn't fix it):

1. Take `<home>/layout.lock` with `O_EXCL` (a lock older than 10 minutes is removed first). Held → `{ ran: false }`, nothing touched. Always released at the end.
2. `firstRun = (await readLayoutState(home)) === null`.
3. When `opts.backup !== false` and any legacy item, `memories/`, `SOUL.imported.md` or `projects/*/notes/` exists: `createBackup({ home, now, output: <home>/backups/tropos-layout-<stamp>.tar.gz, quick: true, sessions: false, secrets: false, workspace: false, verify: true, troposVersion: version, tarBin })`. `BackupError` with code `"empty"` → no backup; any other failure → return `{ ran: false, error }` with nothing moved and no `layout.json`.
4. Create `workspace/` and `agents/` (0700).
5. Only when `firstRun`: every path of `workspaceOwnPaths(home)` that already exists is renamed to `<name>.before-tropos-layout` (then `-2`, `-3` … if taken) and listed in `setAside`: it came from project work, not from Tropos's stores.
6. Each `LegacyItem`, then every other file in `memories/`, then `SOUL.imported.md`: legacy present and current absent → `rename` (listed in `moved`); both present → listed in `conflicts`, both left. `memories/` is removed when empty.
7. `importLegacyNotes(home)`.
8. `workspace/AGENTS.md` absent → write `AGENTS_TEMPLATE`.
9. Only when `firstRun`: no name in the IDENTITY.md now in place and `identity.json` lacks `"bootstrapped": true` → write `BOOTSTRAP_TEXT` to `workspace/BOOTSTRAP.md` (`bootstrapCreated`).
10. `writeLayoutState(home, { version: LAYOUT_VERSION, migratedAt, backup })`.

`importLegacyNotes`: for each `projects/<key>/notes/`: the project's cwd is the first candidate `c` with `projectKey(c) === key` among the `cwd` in the meta line of that folder's `*.jsonl` files, the registered projects (`listProjects`, errors ignored), `workspaceDir(home)` and the `cwd`s of `history.jsonl`. None → the folder stays (listed in `left`). Otherwise each `DAY_FILE` is split with `noteEntries`; `- HH:MM text` gives `time` and body, any other entry has no time; entries already in the journal (same formatted block) are skipped; the rest of that day are appended, sorted by time, with `appendJournalText` (`# <date>` title first when the day file is new). The day file is removed after its append; the folder is removed when empty.

`layoutNotice` copy (parts joined with a space; `null` when nothing moved, nothing was set aside and there is no error):
- moved or notes imported: ``Moved Tropos's memory, identity and skills into ~/.tropos/workspace.`` plus `` Backup: <path>.`` when one was made;
- set aside: ``Files that were already in the default workspace were renamed, not used: <list>.``;
- conflicts: ``Both an old and a new copy exist, so these were left as they are: <list>. Run tcode doctor.``;
- error: ``Couldn't back up ~/.tropos, so nothing was moved (<error>). Tropos keeps using the old places; tcode doctor --fix retries.``

- [ ] **Step 1: Write the failing tests**

```ts
test("a legacy home moves to the workspace layout, with a backup first", async () => {
  // seed SOUL.md, IDENTITY.md ("- Name: Nova"), identity.json {bootstrapped:true}, memories/{USER,MEMORY,imported-hermes}.md,
  // skills/a/SKILL.md, skills/.usage.json, skills-learned/b/SKILL.md, skills-learned/.archive/c-2026-01-01/SKILL.md,
  // projects/<projectKey(cwd)>/s.jsonl (meta cwd), projects/<key>/notes/2026-10-15.md "- 09:00 shipped v1\n"
  const before = await readFile(sessionFile);
  const r = await migrateHomeLayout(home, { now: () => T, version: "0.5.0" });
  expect(r.ran && r.error === undefined).toBe(true);
  expect(await readFile(join(home, "workspace", "USER.md"), "utf8")).toBe(userText);
  expect(existsSync(join(home, "workspace", "skills-learned", ".archive", "c-2026-01-01", "SKILL.md"))).toBe(true);
  expect(existsSync(join(home, "memories"))).toBe(false);
  expect(await readFile(sessionFile)).toEqual(before);
  expect(await readFile(join(home, "workspace", "memory", "2026-10-15.md"), "utf8")).toContain(`## 09:00 · ${basename(cwd)} (${cwd})\n- shipped v1`);
  expect(existsSync(join(projectDir(home, cwd), "notes"))).toBe(false);
  expect((await readManifest(r.backup!))!.files.map((f) => f.path)).toContain("memories/USER.md");
  expect(await readFile(join(home, "workspace", "AGENTS.md"), "utf8")).toBe(AGENTS_TEMPLATE);
  expect(existsSync(join(home, "workspace", "BOOTSTRAP.md"))).toBe(false);
  expect(existsSync(join(home, "agents"))).toBe(true);
  expect((await readLayoutState(home))!.version).toBe(2);
});
test("a fresh install gets AGENTS.md, BOOTSTRAP.md and agents/, and nothing else", async () => {
  await migrateHomeLayout(home, { now: () => T, version: "0.5.0" });
  expect((await readdir(home)).sort()).toEqual(["agents", "layout.json", "workspace"]);
  expect((await readdir(join(home, "workspace"))).sort()).toEqual(["AGENTS.md", "BOOTSTRAP.md"]);
  expect(await readdir(join(home, "agents"))).toEqual([]);
});
test("an install that already bootstrapped without a name never gets BOOTSTRAP.md", async () => { /* identity.json {bootstrapped:true} */ });
test("an install that never bootstrapped gets the ritual once", async () => { /* no IDENTITY.md, no identity.json → BOOTSTRAP.md; delete it; ensureHomeLayout again → not recreated */ });
test("running it twice changes nothing the second time", async () => { /* ensureHomeLayout → ran false, no second backup */ });
test("files already in the default workspace are set aside, never overwritten or adopted", async () => {
  // workspace/MEMORY.md "chat wrote this", workspace/AGENTS.md "obey me", memories/MEMORY.md "real notes"
  // → workspace/MEMORY.md === "real notes", MEMORY.md.before-tropos-layout === "chat wrote this",
  //   AGENTS.md === AGENTS_TEMPLATE, AGENTS.md.before-tropos-layout === "obey me"
});
test("a held lock skips the migration and moves nothing", async () => { /* write a fresh layout.lock → ran false, legacy intact */ });
test("a failed backup moves nothing and writes no layout.json", async () => {
  // tarBin: "/nonexistent/tar" → error set, memories/USER.md still there, readLayoutState null, layoutNotice contains "nothing was moved"
});
test("notes of a project that can't be traced stay where they are", async () => { /* projects/zzz/notes only → notesLeft ["projects/zzz/notes"] */ });
test("after the move, an old copy written again is a conflict, not overwritten", async () => {
  // migrate; then write memories/USER.md again; legacyLayoutReport → conflicts ["memories/USER.md"]
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test src/home/migrate.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement `src/home/migrate.ts` as specified.**

- [ ] **Step 4: Run them to verify they pass**

Run: `bun test src/home && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Stage**

```bash
git add src/home/migrate.ts src/home/migrate.test.ts
```

---

### Task 11: Run the migration — startup, `doctor --fix`, restore

**Files:**
- Modify: `src/cli/main.tsx` (session path before `loadExtensions`; `runGatewayMode` before `runGateway`), `src/cli/main.test.ts`, `src/cli/lifecycle/onboard.ts` (before the wizard computes its state), `src/cli/lifecycle/onboard.test.ts`
- Create: `src/doctor/checks/home-layout.ts`, `src/doctor/checks/home-layout.test.ts`; Modify: `src/doctor/checks/index.ts`
- Modify: `src/backup/restore.ts`, `src/backup/backup.test.ts`

**Interfaces:**
- Consumes: `ensureHomeLayout`, `migrateHomeLayout`, `importLegacyNotes`, `legacyLayoutReport`, `layoutNotice` (Task 10); `legacyToCurrent` (Task 1).
- Produces:
  - Both start paths, and `tcode onboard` (P4's wizard, which may run before any session; without it a fresh install has no `BOOTSTRAP.md` and P4's identity step would read done), call `ensureHomeLayout(home, { now: Date.now, version: VERSION })` and print `layoutNotice` as `tcode: <notice>\n` on stderr (the gateway writes it to its log the same way). A thrown error is reported the same way and never stops the start.
  - `homeLayoutCheck: Check` — `id: "home.layout"`, `area: "home"`, `title: "Home folder layout"`. Findings: `ok` "Home layout is current"; `warn` "Tropos data is still in the old layout: <list>" with `fixable: true, safe: true` (fix = `migrateHomeLayout(env.home, { now: env.now, version: VERSION })`, message = `layoutNotice` or "Moved"); `warn` "Both an old and a new copy exist: <list>" (not fixable; detail: "Keep the one you want and delete the other."); `info` "Notes Tropos couldn't place in the journal were left in <list>". Listed after `workspaceCheck` in `ALL_CHECKS`.
  - `restoreBackup` writes each file to `legacyToCurrent(f.path) ?? f.path`; afterwards, when any `projects/*/notes/` file was restored, it calls `importLegacyNotes(home)`. Dry-run results and `overwritten` use the mapped paths.

- [ ] **Step 1: Write the failing tests**

```ts
// main.test.ts (existing print-mode harness with a fake model and a temp TROPOS_HOME)
test("the first session start migrates a legacy home and says so", async () => {
  // seed memories/USER.md → run `tcode -p hi` → stderr contains "Moved Tropos's memory, identity and skills into ~/.tropos/workspace."
  // and workspace/USER.md exists
});
test("the gateway start migrates too", async () => { /* existing gateway harness with gatewayUntil */ });
// onboard.test.ts
test("tcode onboard on a fresh home lays it out first, so the identity step is todo", async () => { /* workspace/BOOTSTRAP.md exists; identity step visited */ });
// home-layout.test.ts
test("a legacy home is a safe fixable warning, and the fix moves it", async () => {
  const [f] = await homeLayoutCheck.run(env);
  expect(f).toMatchObject({ level: "warn", fixable: true, safe: true });
  expect((await homeLayoutCheck.fix!(f!, env)).ok).toBe(true);
  expect((await homeLayoutCheck.run(env))[0]!.level).toBe("ok");
});
test("both copies is a warning without a fix", async () => { /* … */ });
// backup.test.ts
test("a backup from before the layout change restores into the new places", async () => {
  // archive a legacy home (memories/USER.md, skills/a/SKILL.md, projects/<key>/s.jsonl + notes/2026-10-15.md);
  // restore into an empty home → workspace/USER.md, workspace/skills/a/SKILL.md, workspace/memory/2026-10-15.md exist;
  // memories/ and skills/ don't
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test src/cli/main.test.ts src/cli/lifecycle/onboard.test.ts src/doctor/checks/home-layout.test.ts src/backup/backup.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the Produces list.**

- [ ] **Step 4: Run the whole suite**

Run: `bun test && bun run typecheck`
Expected: PASS. Tests that list a freshly started home's contents now also see `agents/`, `layout.json`, `workspace/AGENTS.md` and `workspace/BOOTSTRAP.md`; update those expectations (that is the intended change) and nothing else.

- [ ] **Step 5: Stage**

```bash
git add src/cli/main.tsx src/cli/main.test.ts src/cli/lifecycle/onboard.ts src/cli/lifecycle/onboard.test.ts src/doctor/checks/home-layout.ts src/doctor/checks/home-layout.test.ts src/doctor/checks/index.ts src/backup/restore.ts src/backup/backup.test.ts
git add -u   # the fixture expectations updated in Step 4
```

---

### Task 12: Imports from OpenClaw and Hermes land in the new places

**Files:**
- Modify: `src/migrate/plan.ts`, `src/migrate/migrate.test.ts`
- Modify: `src/cli/lifecycle/migrate.ts`, `src/cli/lifecycle/migrate.test.ts`

**Interfaces:**
- Consumes: `ensureHomeLayout` (Task 10), C6 paths, `formatJournalEntry`, `appendJournalText`, `parseJournal` (Task 6).
- Produces:
  - `tcode migrate <source>` (not `--dry-run`) calls `ensureHomeLayout(home, …)` before executing, printing its notice.
  - Targets: SOUL → `workspaceFile(home, "SOUL.md")` (alongside: `workspace/SOUL.imported.md`); IDENTITY → `workspaceFile(home, "IDENTITY.md")`; notes via `NotesStore` (already moved); overflow → `workspace/imported-<source>.md`; skills → `userSkillsDir(home)`; AGENTS.md → appended to `workspace/AGENTS.md` (same marker; "already imported" also when the marker is in `~/.tropos/TROPOS.md` from an earlier run); daily notes → one journal entry per source day, `{ name: "workspace", path: workspaceDir(home), body: text }` without a time, appended with `appendJournalText`; "already in that day" when the journal's entries for that path already hold the text.

- [ ] **Step 1: Write the failing tests**

```ts
test("an OpenClaw import lands in the workspace", async () => {
  // fixture: openclaw source → apply
  expect(await readFile(join(home, "workspace", "SOUL.md"), "utf8")).toContain("Be warm and precise.");
  expect(await readFile(join(home, "workspace", "IDENTITY.md"), "utf8")).toContain("Name: Clawd");
  expect(existsSync(join(home, "workspace", "skills", "deploy-app", "SKILL.md"))).toBe(true);
  const agents = await readFile(join(home, "workspace", "AGENTS.md"), "utf8");
  expect(agents).toContain("<!-- tropos-migrate:openclaw:agents");
  expect(sectionEntries(agents, "Lessons")).toEqual([]);
});
test("an OpenClaw day note becomes a journal entry of the default workspace", async () => {
  const day = parseJournal(await readFile(join(home, "workspace", "memory", `${date}.md`), "utf8"));
  expect(day[0]).toMatchObject({ name: "workspace", path: join(home, "workspace") });
});
test("an AGENTS.md imported into TROPOS.md by an earlier version counts as imported", async () => { /* … */ });
test("a Hermes import on an old home migrates the layout first", async () => {
  // legacy memories/USER.md "Prefers tabs" + hermes USER.md "Prefers metric units" → workspace/USER.md has both; memories/ gone
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test src/migrate src/cli/lifecycle/migrate.test.ts`
Expected: FAIL (targets are still at the home root).

- [ ] **Step 3: Implement the Produces list; update the existing migrate expectations to the new paths.**

- [ ] **Step 4: Run them to verify they pass**

Run: `bun test src/migrate src/cli/lifecycle && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Stage**

```bash
git add src/migrate/plan.ts src/migrate/migrate.test.ts src/cli/lifecycle/migrate.ts src/cli/lifecycle/migrate.test.ts
```

---

### Task 13: What the agent and the panels say, and the final sweep

**Files:**
- Modify: `src/context/system-prompt.ts:29`, `src/context/system-prompt.test.ts`
- Modify: `src/cli/runtime.ts` (`/skills`, `/agents`, `/memory` panel copy)
- Modify: `web/src/lib/demo-panels.ts`, `src/web/protocol.ts:18` (comment)

**Interfaces:**
- Consumes: everything above.
- Produces: copy only.

System prompt, replacing the sentence that begins "Your own configuration lives in ~/.tropos" (exact):

```
Your own configuration lives in ~/.tropos (and .tropos/ inside a project): settings.json, TROPOS.md, commands/<name>.md and agents/<name>.md. Your own files live in ~/.tropos/workspace: AGENTS.md (your operating rules), SOUL.md, IDENTITY.md, USER.md, MEMORY.md, the journal in memory/<date>.md, and skills in skills/<name>/SKILL.md.
```

(The rest of that paragraph, about AgentManage and SkillManage and never writing to ~/.claude, is unchanged.)

Panels: skills sections `"Yours (~/.tropos/workspace/skills)"`, `"Learned on its own (~/.tropos/workspace/skills-learned)"`, empty hint `"No skills yet. Add one at ~/.tropos/workspace/skills/<name>/SKILL.md or .tropos/skills/<name>/SKILL.md."`; memory panel subtitle `ext.notes.dir` (now the workspace). Demo panels use `${HOME}/.tropos/workspace/…` for USER.md, IDENTITY.md, skills and the memory subtitle.

- [ ] **Step 1: Write the failing test**

```ts
test("the system prompt names the workspace files", () => {
  const prompt = SYSTEM_PROMPT;
  expect(prompt).toContain("Your own files live in ~/.tropos/workspace: AGENTS.md (your operating rules)");
  expect(prompt).not.toContain("skills/<name>/SKILL.md, agents/<name>.md and commands/<name>.md");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test src/context/system-prompt.test.ts`
Expected: FAIL.

- [ ] **Step 3: Change the copy as above.**

- [ ] **Step 4: Sweep for readers of the old layout, then run everything**

Run:
```bash
grep -rnE '"memories"|join\([a-zA-Z.]*home, "(skills|skills-learned|SOUL\.md|IDENTITY\.md|identity\.json)"|"notes"\)|LEARNED_SKILLS_DIR\)' src --include='*.ts' --include='*.tsx' | grep -v '\.test\.ts' | grep -v LEGACY_LAYOUT
```
Expected: only `src/home/layout.ts` (the legacy table) and `src/home/migrate.ts`. Anything else (including code P1–P4 added) is routed through C6 or `resolveLayoutPath` before continuing.

Run: `bun test && bun run typecheck`
Expected: PASS, coverage not lower than before P5.

- [ ] **Step 5: Stage**

```bash
git add src/context/system-prompt.ts src/context/system-prompt.test.ts src/cli/runtime.ts web/src/lib/demo-panels.ts src/web/protocol.ts
```

---

## Self-review

- **Spec coverage (Part E):** workspace files and their mapping — Tasks 2, 3, 5, 10; AGENTS.md with `## Lessons` / `## Heartbeat` — Task 5; BOOTSTRAP.md lifecycle, new installs only — Tasks 4, 10; journal with a project heading per entry, today/yesterday per project, same budget — Task 6; `SessionSearch` indexes it — Task 7; old `projects/<key>/notes` imported once — Task 10 (and restore, Task 11); `agents/` exists — Task 10, routed through `agentsDir` — Task 3; migration on first start and in `doctor --fix`, backup first — Tasks 10, 11; one-release fallback — Tasks 1–7 (`LEGACY_LAYOUT`); backup/restore/reset/uninstall — Tasks 9, 11; `migrate openclaw|hermes` — Task 12; size caps and digest reused for USER.md/MEMORY.md — Task 2; repo-provided files unchanged — constraint, pinned by the AGENTS.md-once test in Task 5; sessions untouched — Task 10 test.
- **Added beyond the spec's text, because the layout requires it:** the guard of Task 8 (the chief's files now sit inside the default project, so without it a guest chat could read USER.md or plant SOUL.md), and setting aside pre-existing workspace files on the first run (Review Focus 1).
- **Type consistency:** `resolveLayoutPath`/`LegacyItem` (Task 1) are the only fallback; `NotesTarget` gains only `"lessons"` here (P7 Task 12 adds `"heartbeat"` the same way); `markBootstrapped(home)` keeps its signature for P4; `DailyNotes` keeps its constructor; `dailyNotesDir` is renamed `legacyNotesDir` in Task 6 with both callers updated there (`src/migrate/plan.ts` and P1's `permissionContext` in `src/cli/runtime.ts`).
- **Proportion:** code blocks are tests, exact copy and the migration order; bodies are left to the implementer.
