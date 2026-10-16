# P2: Chats Without Docker, Confinement and Autonomy Levels (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Chats and scheduled runs execute commands on the Mac itself, inside OS confinement (sandbox-exec / bwrap), at an autonomy level the owner picks. Docker stays available as an optional backend. The dashboard Chat becomes an owner session with a project picker.

**Architecture:** gateway.json gains `chat: { autonomy, backend, allowUnconfined }` and per-project `autonomy` / `testCommands`. Existing installs are migrated to `ask` / `docker`. A new `confined` exec backend wraps each command in a generated sandbox-exec profile (macOS) or bwrap mount set (Linux), with an environment built from an allowlist. The permission engine gets an optional `autonomy` policy. It auto-allows project edits, read-only commands (a new conservative classifier) and pinned test commands, depending on the level. The daemon gives every chat or scheduled session a live policy that reads the current config, so `/autonomy` lowering applies at once. The dashboard's single `WebHost` becomes a `ProjectHosts` router, with one host per project and one project per tab.

**Tech Stack:** TypeScript on Bun, zod, `bun test` with colocated `*.test.ts`, React + Testing Library in `web/`. No new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-10-16-setup-autonomy-access-design.md` (doc 1, Part B: §5.1, §5.2, §5.3). Binding names: `docs/superpowers/plans/2026-10-16-contracts.md` (C3 is this plan's; it relies on C1 `role` / `isOwner` and C2 from P1).

## Global Constraints

- Autonomy values are exactly `"ask" | "balanced" | "autonomous"`. New installs default to `"balanced"` / `"host"`. Existing installs are migrated to `"ask"` / `"docker"`, and nothing changes until the user accepts (no silent weakening).
- Autonomy table (chats and scheduled runs only; terminal and dashboard sessions never get a policy):

  | | Project edits | Read-only commands and pinned tests | Other commands | MCP tools |
  |---|---|---|---|---|
  | ask | ask | ask | ask | ask |
  | balanced | allowed (test-manifest files ask) | allowed | ask | ask |
  | autonomous | allowed | allowed | allowed | ask |

- These hold at every level, unchanged: file tools confined to the project, deny rules win, `.git` / `.husky` writes ask, no bypass mode, MCP always asks, plan mode still denies.
- Confinement profile (the same at every level). Writes go only to the project, the system temp dir and package-manager caches. Writes are always denied to `.git/hooks`, `.git/config` and `.husky` (submodules too). Reads are denied for the secrets list, with `~/.tropos/workspace` carved out of the `~/.tropos` denial. Network is allowed.
- Chat command environment allowlist: `PATH`, `HOME`, `USER`, `SHELL`, `LANG`, `LC_*`, `TERM`, `TMPDIR`.
- Without confinement, `ask` works as usual. `balanced` and `autonomous` need the explicit "run unconfined" consent (`chat.allowUnconfined: true`). Without that consent a session runs at `ask`, and doctor warns.
- Raising the level only happens from the terminal (`tcode config`, the wizard) or the dashboard admin API. A chat can only lower it, and only the owner can use `/autonomy`. No chat or scheduled tool can write `gateway.json`.
- Plan decision (beyond the spec): chats from approved senders who are **not** the owner (`role: "guest"`) always run at `ask`.
- Plan decision: the built-in default workspace (and the one-off `cwd` project) uses the global `chat.autonomy` and has no pinned tests. `/autonomy` there lowers the global level.
- Per the owner's rule, tasks end with **Stage** (`git add`), never commit. Each task ends green on its own tests plus `bun run typecheck`.

## Review Focus

1. **An existing install whose bot token comes from `TROPOS_TELEGRAM_BOT_TOKEN`, with no `gateway.json` but a `gateway/pairing.json` holding an approved sender.** It must be treated as existing (`ask` / `docker`), not silently moved to host / balanced. The other way round, a fresh install whose `gateway.json` the wizard's projects step wrote (no approved sender, setup never finished) must get `balanced` / `host`. Tests in Task 1.
2. **Lowering mid-session.** `/autonomy ask` must take effect on the chat's already-open session at its next tool call, not after a restart. Test in Task 8 (e2e).
3. **A read-only command that reaches outside the project** (`cat ~/.ssh/id_rsa`, `ls /etc`, `rg x ../other`). Under `balanced` it must ask, which matters most when running unconfined. Test in Task 4.
4. **A level raised by `tcode config set --file gateway chat.autonomy autonomous` on a machine with no confinement and no consent.** Sessions must run at `ask`. Test in Task 7.
5. **`PATH` holding `.`, a relative entry or a project directory.** A "read-only" `ls` would then run a script the agent wrote. `chatEnv` must drop such entries. Test in Task 5.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/gateway/autonomy.ts` (new) | C3 types, `effectiveAutonomy`, `canRaise`, `sessionAutonomy`, setters/lowering that write gateway.json |
| `src/gateway/config.ts` | schema: `chat`, `projects[].autonomy`, `projects[].testCommands`; existing-install migration |
| `src/permissions/readonly.ts` (new) | `isReadOnlyCommand`, `pathsStayInside` |
| `src/gateway/tests-detect.ts` (new) | `detectTestCommands`, `isTestManifest`, `matchesTestCommand` |
| `src/permissions/engine.ts` | `PermissionContext.autonomy`, auto-allow step in `decide` |
| `src/cli/runtime.ts` | `AppContext.autonomy`, passed into both `permissions()` builders |
| `src/exec/env.ts` (new) | `chatEnv` allowlist |
| `src/exec/confinement-paths.ts` (new) | the one list of secrets, caches, temp dirs, protected git paths |
| `src/exec/sandbox-profile.ts` (new) | macOS SBPL profile + `-D` params |
| `src/exec/bwrap-args.ts` (new) | Linux bwrap argument list |
| `src/exec/confined.ts` (new) | `confinedBackend`, `unconfinedBackend`, `confinementAvailable`, `detectConfinement` |
| `src/gateway/chat-exec.ts` (new) | picks the backend for a chat session (host/docker, confined or not) |
| `src/gateway/policy.ts`, `src/gateway/daemon.ts` | wiring: live config, policy per session, backend choice, `/autonomy`, dashboard hosts |
| `src/gateway/telegram/{adapter,render}.ts`, `src/gateway/types.ts` | `/autonomy`, end-of-task summary |
| `src/web/admin/autonomy.ts` (new), `api.ts`, `index.ts`, `context.ts` | `autonomy.*` admin methods for P3's Settings → Autonomy tab |
| `src/doctor/checks/chat-exec.ts` (new), `docker.ts`, `index.ts` | unconfined / migration findings |
| `src/web/project-hosts.ts` (new), `protocol.ts`, `host.ts`, `server.ts` | dashboard chat per project |
| `web/src/components/chat/ProjectPicker.tsx` (new), `TopBar.tsx`, `chat-test-kit.ts` | the picker UI |

---

### Task 1: Autonomy settings in gateway.json, with the existing-install migration

**Files:**
- Create: `src/gateway/autonomy.ts`, `src/gateway/autonomy.test.ts`
- Modify: `src/gateway/config.ts:18-22` (projectSchema), `:41-52` (schema), `:91-113` (`loadGatewayConfig`)
- Modify: `src/exec/backend.ts` (add the `Confinement` type only)
- Test: `src/gateway/config.test.ts:16-22` (update "a missing file is the defaults"), new cases

**Interfaces:**
- Consumes: `SessionRole` from `src/gateway/types.ts` (C1, P1).
- Produces:
  - `src/exec/backend.ts`: `export type Confinement = "sandbox-exec" | "bwrap";`
  - `src/gateway/config.ts`: `projectSchema` gains `autonomy: z.enum(AUTONOMY_LEVELS).optional()` and `testCommands: z.array(z.string().min(1)).max(10).optional()`. `schema` gains `chat: z.object({ autonomy: z.enum(AUTONOMY_LEVELS).default("balanced"), backend: z.enum(["host","docker"]).default("host"), allowUnconfined: z.boolean().optional() }).default({ autonomy: "balanced", backend: "host" })`. `ProjectEntry` and `GatewayConfig` widen accordingly.
  - `src/gateway/config.ts`: `existingInstall(home: string): Promise<boolean>`. True only when `gateway/pairing.json` (read raw, no migration) has a non-empty `approved` array, or `onboarding.json` has `dismissedAt` (setup was finished or dismissed before), or `gateway/cron/jobs.json` holds at least one job (scheduled runs already ran under the old rules), or `gateway.json` has `telegram.botToken`. A `gateway.json` on its own, for example one the wizard's projects step wrote, does not make an install existing.
  - `src/gateway/autonomy.ts`:
    - `export type Autonomy = "ask" | "balanced" | "autonomous"`
    - `export const AUTONOMY_LEVELS = ["ask", "balanced", "autonomous"] as const`
    - `effectiveAutonomy(config: GatewayConfig, projectId: string): Autonomy`: `projects[id].autonomy ?? chat.autonomy`.
    - `canRaise(from: Autonomy, to: Autonomy): boolean`: true when `to` is stricter or equal (rank ask=0 < balanced=1 < autonomous=2).
    - `pinnedTestCommands(config: GatewayConfig, projectId: string): string[]`
    - `sessionAutonomy(input: { config: GatewayConfig; projectId: string; role: SessionRole; confined: boolean }): Autonomy`: `"guest"` gives `"ask"`. When not `confined` and not `config.chat.allowUnconfined`, the result is `"ask"`. Otherwise it is `effectiveAutonomy`.
    - `needsUnconfinedConsent(config: GatewayConfig, confinement: Confinement | null): boolean`: true when backend is `"host"`, `confinement === null`, `!chat.allowUnconfined`, and the global or any project level is above `"ask"`.
    - `class AutonomyError extends UserFacingError` (from `./errors`)
    - `setAutonomy(home: string, input: { projectId?: string; level: Autonomy | null; acceptUnconfined?: boolean; confinement: Confinement | null }): Promise<GatewayConfig>`: with no `projectId` it sets `chat.autonomy`. With a `projectId` it sets or (with `null`) clears `projects[i].autonomy`. `null` without a `projectId`, an unknown project, and `"default"` / `"cwd"` with a non-null level all throw `AutonomyError`. The result is checked with `needsUnconfinedConsent`: it throws `AutonomyError(UNCONFINED_CONSENT)` unless `acceptUnconfined`, which then also writes `chat.allowUnconfined: true`.
    - `setChatBackend(home: string, input: { backend: "host" | "docker"; acceptUnconfined?: boolean; confinement: Confinement | null }): Promise<GatewayConfig>`: same consent rule.
    - `lowerAutonomy(home: string, projectId: string, to: Autonomy): Promise<{ changed: boolean; level: Autonomy }>`: throws `AutonomyError(RAISE_REFUSED)` when `!canRaise(current, to)`. It writes the project's override, or `chat.autonomy` for a built-in or unregistered project.
    - `pinTestCommands(home: string, projectId: string, commands: string[]): Promise<GatewayConfig>`
    - `ensureChatSettings(home: string): Promise<void>`: when the raw file has no `chat` key, it writes `chat` as `loadGatewayConfig` decided. This fixes the decision the first time `chat` is written, before a later approval could change it. The daemon calls it at start (Task 7) and P4's wizard calls it when setup starts (`markStarted`).
    - Copy constants: `UNCONFINED_CONSENT = "Commands can't be confined on this machine (no sandbox-exec or bwrap), so at this level chat commands would run unconfined as you. Confirm \"run unconfined\" to go ahead."` and `RAISE_REFUSED = "A chat can only lower the autonomy level. Raise it on the computer: tcode config or the dashboard."`

- [ ] **Step 1: Write the failing tests**

```ts
// src/gateway/config.test.ts
test("a missing file is the defaults: closed network, small sandbox, host chats at balanced", async () => {
  expect((await loadGatewayConfig(home)).chat).toEqual({ autonomy: "balanced", backend: "host" });
});
const APPROVED = JSON.stringify({ version: 2, approved: [{ channel: "telegram", senderId: "7", approvedAt: 1 }] });
test("a file without chat on an install with an approved sender is an existing install: ask and docker, until the user changes it", async () => {
  await mkdir(join(home, "gateway"), { recursive: true });
  await writeFile(join(home, "gateway", "pairing.json"), APPROVED);
  await writeFile(join(home, "gateway.json"), JSON.stringify({ idleMinutes: 5 }));
  expect((await loadGatewayConfig(home)).chat).toEqual({ autonomy: "ask", backend: "docker" });
});
test("no gateway.json but a pairing file with an approved sender (token from the environment) is an existing install too", async () => {
  await mkdir(join(home, "gateway"), { recursive: true });
  await writeFile(join(home, "gateway", "pairing.json"), APPROVED);
  expect((await loadGatewayConfig(home)).chat).toMatchObject({ autonomy: "ask", backend: "docker" });
});
test("setup finished before (onboarding.json has dismissedAt) is an existing install", async () => {
  await writeFile(join(home, "onboarding.json"), JSON.stringify({ dismissedAt: "2026-10-01T00:00:00.000Z" }));
  await writeFile(join(home, "gateway.json"), JSON.stringify({ idleMinutes: 5 }));
  expect((await loadGatewayConfig(home)).chat).toEqual({ autonomy: "ask", backend: "docker" });
});
test("a fresh install whose gateway.json the projects step wrote, with no pairing and no finished setup, is balanced/host", async () => {
  await writeFile(join(home, "gateway.json"), JSON.stringify({ projects: [{ id: "app", name: "app", path: "/w/app" }] }));
  expect((await loadGatewayConfig(home)).chat).toEqual({ autonomy: "balanced", backend: "host" });
});
test("projects keep autonomy and pinned tests", async () => { /* save + load round trip of { id:"app", autonomy:"autonomous", testCommands:["bun test"] } */ });

// src/gateway/autonomy.test.ts
test("canRaise is true only for an equal or stricter level", () => {
  expect(canRaise("autonomous", "ask")).toBe(true);
  expect(canRaise("balanced", "balanced")).toBe(true);
  expect(canRaise("ask", "balanced")).toBe(false);
});
test("effectiveAutonomy: the project's own level wins over chat.autonomy", ...);
test("sessionAutonomy: guests are at ask; unconfined without consent is ask; scheduled and owner get the project's level", ...);
test("ensureChatSettings fixes a fresh install at balanced/host before an approved sender appears", async () => {
  await ensureChatSettings(home);
  await mkdir(join(home, "gateway"), { recursive: true });
  await writeFile(join(home, "gateway", "pairing.json"), APPROVED);
  expect((await loadGatewayConfig(home)).chat.autonomy).toBe("balanced");
});
test("setAutonomy refuses balanced without confinement unless run-unconfined is accepted, and then records the consent", async () => {
  await expect(setAutonomy(home, { level: "balanced", confinement: null })).rejects.toThrow(/run unconfined/);
  expect((await setAutonomy(home, { level: "balanced", confinement: null, acceptUnconfined: true })).chat).toMatchObject({ autonomy: "balanced", allowUnconfined: true });
  expect((await setAutonomy(home, { level: "autonomous", confinement: "sandbox-exec" })).chat.autonomy).toBe("autonomous");
});
test("lowerAutonomy lowers a project's level, refuses a raise, and the default workspace lowers the global level", ...);
test("pinTestCommands stores the commands on the project; the default workspace has none", ...);
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `bun test src/gateway/config.test.ts src/gateway/autonomy.test.ts`
Expected: FAIL (`chat` is undefined; `./autonomy` not found).

- [ ] **Step 3: Implement**

In `loadGatewayConfig`, after `migrateLegacy`: when the parsed JSON object has no `chat` key, inject `{ autonomy: "ask", backend: "docker" }` only when `await existingInstall(home)`; otherwise the schema defaults (`balanced` / `host`) apply. The `ENOENT` branch does the same (`schema.parse({ chat: … })` when `existingInstall`, else `schema.parse({})`). Keep loading pure: the decision is fixed the first time `chat` is written, by `ensureChatSettings` or any normal save (such as `addProject` from the wizard's projects step, which then writes `balanced` / `host` on a fresh install). All writers in `autonomy.ts` go through `loadGatewayConfig` → modify → `saveGatewayConfig`.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `bun test src/gateway/config.test.ts src/gateway/autonomy.test.ts src/config/store.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Stage**

```bash
git add src/gateway/autonomy.ts src/gateway/autonomy.test.ts src/gateway/config.ts src/gateway/config.test.ts src/exec/backend.ts
```

---

### Task 2: Read-only command classifier

**Files:**
- Create: `src/permissions/readonly.ts`, `src/permissions/readonly.test.ts`

**Interfaces:**
- Consumes: `splitBashCommand`, `hasLeadingPrefix`, `isCodeRunner` from `src/permissions/rules.ts`; `isInside` from `src/paths.ts`.
- Produces:
  - `isReadOnlyCommand(command: string): boolean`: true only when `splitBashCommand` reports `!unsafe` with at least one part, and every part passes the per-part allowlist below.
  - `pathsStayInside(command: string, cwd: string, home: string, allowedDirs: string[]): boolean`: every word that starts with `/` or `~`, or has a `..` segment, after unquoting, `~` expansion against `home` and resolution against `cwd`, is inside one of `allowedDirs`. `/dev/null` is exempt.

Per-part rules (a part is one simple command):
- Refuse when `hasLeadingPrefix(part)` is true (assignments, wrappers), when the command word contains `/`, when `isCodeRunner` matches it, or when any word contains `$` or a backtick. Accepted redirect tokens are only `2>&1`, `>&2`, `>/dev/null`, `2>/dev/null`, `&>/dev/null` and `<file`.
- Plain commands, any arguments: `cd ls pwd echo printf true false cat head tail wc file stat du df basename dirname realpath readlink which type uname whoami id printenv grep egrep fgrep cut tr nl comm cmp diff od hexdump md5 md5sum shasum sha1sum sha256sum column jq`.
- Commands with forbidden options. Unquoted glob characters (`* ? [`) also refuse these, because a file named `--output=x` could expand into an option.
  - `find` refuses `-exec -execdir -ok -okdir -delete -fprint -fprint0 -fprintf -fls`.
  - `fd` refuses `-x --exec -X --exec-batch`.
  - `rg` refuses `--pre --pre-glob`.
  - `sort` refuses `-o --output* --compress-program*`.
  - `uniq` allows at most one non-option argument.
  - `tree` refuses `-o`.
  - `date` refuses `-s --set*`.
- `git`: global options are refused except `--no-pager` / `-P`. Any `--output*`, `--ext-diff` or `--exec*` refuses. Allowed subcommands: `status diff log show rev-parse ls-files ls-tree blame shortlog describe cat-file grep`. Also `branch`, only when every argument is one of `-a -r -v -vv --all --remotes --verbose --list --show-current --no-color --color`. `remote` with no argument or `-v`. `tag` with no argument or `-l` / `--list`. `stash list|show`, `reflog` with no argument or `show`, `worktree list`.
- Everything else is refused.

- [ ] **Step 1: Write the failing table test**

```ts
const READ_ONLY = ["ls", "ls -la src", "cat README.md", "head -n 20 a.ts | wc -l", "rg -n TODO src", "grep -rn foo .",
  "git status", "git status --short", "git diff HEAD~1 -- src", "git log --oneline -20", "git show HEAD:package.json",
  "git --no-pager log -5", "git branch -a", "git rev-parse --abbrev-ref HEAD", "git ls-files", "git blame src/a.ts",
  "pwd", "echo hi", "wc -l src/*.ts", "find src -name '*.ts'", "fd test", "cd src && ls", "tree -L 2", "git diff 2>&1",
  "ls >/dev/null 2>&1", "sort a.txt | uniq -c", "jq .version package.json", "stat package.json", "du -sh src", "which bun", "diff a.txt b.txt"];
const NOT_READ_ONLY = ["", "rm a", "touch a", "echo hi > a.txt", "cat a >> b", "git commit -m x", "git push", "git checkout main",
  "git branch -D old", "git branch new", "git -c core.pager=sh log", "git -C /tmp status", "git diff --output=/tmp/x",
  "git log --ext-diff", "git stash", "git config user.name x", "find . -delete", "find . -exec rm {} ;", "find . -fprint out",
  "fd -x rm", "rg --pre ./x foo", "sort -o out a", "sort --output=out a", "uniq a b", "tree -o out", "sed -i s/a/b/ f",
  "awk '{print}' f", "xargs rm", "env ls", "FOO=1 ls", "ls $(pwd)", "ls `pwd`", "cat <<EOF\nx\nEOF", "echo $HOME", "./ls",
  "/bin/ls", "bash -c ls", "python -c 'print(1)'", "npm test", "bun test", "curl https://example.com", "ls; rm a",
  "cat a | tee b", "date -s 2020-01-01", "git diff *", "less a"];
test.each(READ_ONLY)("read-only: %p", (c) => expect(isReadOnlyCommand(c)).toBe(true));
test.each(NOT_READ_ONLY)("not read-only: %p", (c) => expect(isReadOnlyCommand(c)).toBe(false));
test("pathsStayInside", () => {
  const ok = (c: string) => pathsStayInside(c, "/w/app", "/home/u", ["/w/app"]);
  expect(ok("cat src/a.ts")).toBe(true);
  expect(ok("cat /w/app/a.ts")).toBe(true);
  expect(ok("ls >/dev/null")).toBe(true);
  expect(ok("cat ~/.ssh/id_rsa")).toBe(false);
  expect(ok("ls /etc")).toBe(false);
  expect(ok("rg x ../other")).toBe(false);
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `bun test src/permissions/readonly.test.ts`. Expected: FAIL (module not found).

- [ ] **Step 3: Implement `isReadOnlyCommand` and `pathsStayInside` in `src/permissions/readonly.ts`**

A small word splitter for one part: quotes are kept as-is for the `$` / glob checks, and each word records whether it held an unquoted glob character. Keep the allowlists as `ReadonlySet`s at the top of the file, with a comment saying "conservative on purpose: unknown means not read-only".

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `bun test src/permissions/readonly.test.ts && bun run typecheck`. Expected: PASS.

- [ ] **Step 5: Stage**

```bash
git add src/permissions/readonly.ts src/permissions/readonly.test.ts
```

---

### Task 3: Test-command detection, manifests, and matching

**Files:**
- Create: `src/gateway/tests-detect.ts`, `src/gateway/tests-detect.test.ts`

**Interfaces:**
- Consumes: `splitBashCommand`, `hasLeadingPrefix`, `squashShellSpace` (rules.ts).
- Produces:
  - `detectTestCommands(projectDir: string): Promise<string[]>`: de-duplicated, in this order:
    - `package.json` `scripts.test`, ignoring npm's placeholder `echo "Error: no test specified" && exit 1`, becomes `bun run test` / `pnpm test` / `yarn test` / `npm test`, chosen by lockfile (`bun.lock`|`bun.lockb` / `pnpm-lock.yaml` / `yarn.lock` / none).
    - `bun test` when `bun.lock`, `bun.lockb` or `bunfig.toml` exists.
    - `cargo test` (Cargo.toml) and `go test ./...` (go.mod).
    - `pytest`, when `pytest.ini`, `conftest.py`, `pyproject.toml` containing `[tool.pytest`, `setup.cfg` containing `[tool:pytest]` or `tox.ini` containing `[pytest]` exists.
    - `make test` (a `Makefile`/`makefile`/`GNUmakefile` with `/^test:/m`) and `just test` (a `justfile`/`Justfile`/`.justfile` with `/^test(\s[^:]*)?:/m`).
    - `deno test` (`deno.json`/`deno.jsonc`).
    - Unreadable or invalid files are skipped.
  - `isTestManifest(path: string, platform?: NodeJS.Platform): boolean`: matches the basename at any depth, case-insensitive on darwin/win32. The set is: `package.json Makefile makefile GNUmakefile justfile Justfile .justfile pyproject.toml setup.cfg setup.py tox.ini noxfile.py pytest.ini conftest.py Cargo.toml build.rs bunfig.toml deno.json deno.jsonc`, `/^(vitest|vite|jest|playwright|karma|babel)\.config\.[cm]?[jt]s$/`, `/^\.mocharc(\..+)?$/`, and `.cargo/config` / `.cargo/config.toml`.
  - `matchesTestCommand(part: string, pinned: readonly string[]): boolean`: one simple command. It matches when it equals a pinned command, or is a pinned command followed by a space and more words, and has no leading prefix, no `$`, no backtick, no `<` and no `>`.

- [ ] **Step 1: Write the failing tests**

```ts
test("a bun project: the package script through bun, and bun's own runner", async () => {
  await write("package.json", { scripts: { test: "bun test" } }); await write("bun.lock", "");
  expect(await detectTestCommands(dir)).toEqual(["bun run test", "bun test"]);
});
test("npm's placeholder test script isn't a test command", ...);          // → []
test("cargo, go, pytest (pyproject [tool.pytest]), make test, just test, deno", ...); // exact strings above
test("an empty or unreadable project has none", ...);                     // → []
test("isTestManifest: package.json at any depth, configs, case-insensitive on darwin; source files are not", () => {
  expect(isTestManifest("/w/app/packages/x/package.json")).toBe(true);
  expect(isTestManifest("/w/app/vitest.config.ts")).toBe(true);
  expect(isTestManifest("/w/app/.cargo/config.toml")).toBe(true);
  expect(isTestManifest("/w/app/PACKAGE.JSON", "darwin")).toBe(true);
  expect(isTestManifest("/w/app/src/a.test.ts")).toBe(false);
});
test("matchesTestCommand: the pinned command, with extra plain arguments, nothing else", () => {
  expect(matchesTestCommand("bun test", ["bun test"])).toBe(true);
  expect(matchesTestCommand("bun test src/a.test.ts", ["bun test"])).toBe(true);
  expect(matchesTestCommand("bun testx", ["bun test"])).toBe(false);
  expect(matchesTestCommand("FOO=1 bun test", ["bun test"])).toBe(false);
  expect(matchesTestCommand("bun test $X", ["bun test"])).toBe(false);
  expect(matchesTestCommand("bun test > out", ["bun test"])).toBe(false);
  expect(matchesTestCommand("bun test", [])).toBe(false);
});
```

- [ ] **Step 2: Run the tests and confirm they fail.** Run `bun test src/gateway/tests-detect.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement the three functions in `src/gateway/tests-detect.ts`.**
- [ ] **Step 4: Run the tests and confirm they pass.** Run `bun test src/gateway/tests-detect.test.ts && bun run typecheck`. Expected: PASS.
- [ ] **Step 5: Stage**

```bash
git add src/gateway/tests-detect.ts src/gateway/tests-detect.test.ts
```

---

### Task 4: Autonomy in the permission engine

**Files:**
- Modify: `src/permissions/engine.ts:35-43` (`PermissionContext`), `:145-173` (`decide`: a new step right after the ask-rules check at line 158)
- Modify: `src/cli/runtime.ts:42-67` (`AppContext`), `:142` and `:272` (both `permissions()` builders)
- Test: `src/permissions/engine.test.ts` (new `describe("decide — autonomy")`)

**Interfaces:**
- Consumes: `Autonomy` (Task 1), `isReadOnlyCommand`, `pathsStayInside` (Task 2), `isTestManifest`, `matchesTestCommand` (Task 3).
- Produces:
  - `engine.ts`: `export interface AutonomyPolicy { level: Autonomy; testCommands: readonly string[] }`, and `PermissionContext.autonomy?: AutonomyPolicy`.
  - `runtime.ts`: `AppContext.autonomy?: () => AutonomyPolicy`, read on every decision so a change applies to the open session. Both `permissions()` builders add `autonomy: ctx.autonomy?.()`. P1 also edits these two lines to add the role fields; keep both changes.
- Rule, placed after deny, confine, bypass, plan and ask-rule checks, and before `isAllowed`. It returns `{ behavior: "allow" }` when:
  - **Edits:** `kind === "edit"`, level is not `ask`, there are paths, every path is inside `allowedDirs`, none is `inGitControlDir`, and (level `autonomous`, or no path `isTestManifest`).
  - **Bash, autonomous:** `toolName === "Bash"`, `command` is defined, and level is `autonomous`.
  - **Bash, balanced:** `toolName === "Bash"`, `command` is defined, level is `balanced`, `splitBashCommand` is not `unsafe`, every part is `isReadOnlyCommand(part) || matchesTestCommand(part, testCommands)`, and `pathsStayInside(command, cwd, home, allowedDirs)`.
  - Everything else falls through unchanged. MCP tools and other exec tools such as `Cron` still ask.

- [ ] **Step 1: Write the failing tests**

```ts
const auto = (level: Autonomy, testCommands: string[] = [], over = {}) => ({ ...ctx(over), autonomy: { level, testCommands } });
test("ask changes nothing", () => expect(decide(edit("/work/app/src/a.ts"), auto("ask")).behavior).toBe("ask"));
test("balanced: project edits run, test manifests and git control files ask", () => {
  expect(decide(edit("/work/app/src/a.ts"), auto("balanced"))).toEqual({ behavior: "allow" });
  expect(decide(edit("/work/app/packages/x/package.json"), auto("balanced")).behavior).toBe("ask");
  expect(decide(edit("/work/app/.git/hooks/pre-commit"), auto("autonomous")).behavior).toBe("ask");
  expect(decide(edit("/elsewhere/a.ts"), auto("autonomous")).behavior).toBe("ask");
});
test("autonomous: test manifests run too", () => expect(decide(edit("/work/app/package.json"), auto("autonomous"))).toEqual({ behavior: "allow" }));
test("balanced: read-only commands and pinned tests run; installs, deletions and unknown commands ask", () => {
  expect(decide(bash("git status && rg foo src"), auto("balanced"))).toEqual({ behavior: "allow" });
  expect(decide(bash("bun test src/a.test.ts"), auto("balanced", ["bun test"]))).toEqual({ behavior: "allow" });
  expect(decide(bash("bun test"), auto("balanced")).behavior).toBe("ask");
  expect(decide(bash("npm install left-pad"), auto("balanced")).behavior).toBe("ask");
  expect(decide(bash("rm -rf build"), auto("balanced")).behavior).toBe("ask");
});
test("balanced: a read-only command that reaches outside the project asks", () => {
  expect(decide(bash("cat ~/.ssh/id_rsa"), auto("balanced")).behavior).toBe("ask");
  expect(decide(bash("ls /etc"), auto("balanced")).behavior).toBe("ask");
});
test("autonomous: any Bash runs; MCP and other exec tools still ask", () => {
  expect(decide(bash("npm install left-pad && rm -rf build"), auto("autonomous"))).toEqual({ behavior: "allow" });
  expect(decide({ toolName: "mcp__gh__x", kind: "exec", paths: [] }, auto("autonomous", [], { ask: ["mcp__*"] })).behavior).toBe("ask");
  expect(decide({ toolName: "Cron", kind: "exec", paths: [] }, auto("autonomous")).behavior).toBe("ask");
});
test("deny rules, the user's ask rules and plan mode still win", () => {
  expect(decide(bash("rm x"), auto("autonomous", [], { deny: ["Bash(rm:*)"] })).behavior).toBe("deny");
  expect(decide(bash("git status"), auto("balanced", [], { ask: ["Bash(git:*)"] })).behavior).toBe("ask");
  expect(decide(edit("/work/app/a.ts"), auto("autonomous", [], { mode: "plan" })).behavior).toBe("deny");
});
```

- [ ] **Step 2: Run the tests and confirm they fail.** Run `bun test src/permissions/engine.test.ts`. Expected: FAIL (`autonomy` is ignored).
- [ ] **Step 3: Implement `autonomyAllows(req: PermissionRequest, ctx: PermissionContext): boolean` (module-private) and call it in `decide`; add the `AppContext` field and pass it in `runtime.ts`.**
- [ ] **Step 4: Run the tests and confirm they pass.** Run `bun test src/permissions src/cli && bun run typecheck`. Expected: PASS.
- [ ] **Step 5: Stage**

```bash
git add src/permissions/engine.ts src/permissions/engine.test.ts src/cli/runtime.ts
```

---

### Task 5: Chat environment and the confinement profile (pure builders)

**Files:**
- Create: `src/exec/env.ts`, `src/exec/env.test.ts`
- Create: `src/exec/confinement-paths.ts`, `src/exec/confinement-paths.test.ts`
- Create: `src/exec/sandbox-profile.ts`, `src/exec/sandbox-profile.test.ts`
- Create: `src/exec/bwrap-args.ts`, `src/exec/bwrap-args.test.ts`

**Interfaces:**
- Consumes: `isInside` (`src/paths.ts`); `protectedPaths(workspace)` from `src/exec/docker.ts:45` (bwrap reuses it).
- Produces:
  - `chatEnv(env: NodeJS.ProcessEnv, opts: { project: string }): NodeJS.ProcessEnv`. It keeps only `PATH HOME USER SHELL LANG TERM TMPDIR` and `LC_*`. From `PATH` it drops empty entries, relative entries and entries inside `project`. An emptied PATH becomes `/usr/bin:/bin:/usr/sbin:/sbin`.
  - `export const SECRET_PATHS: readonly string[]`, relative to the user's home. This is the one tested list:
    - `.ssh .aws .gnupg .config/gh .docker/config.json .netrc .git-credentials .config/git/credentials .npmrc .pypirc .kube .config/gcloud .azure .password-store .cargo/credentials .cargo/credentials.toml .claude .local/share/keyrings Library/Keychains`
    - browser profiles: `Library/Application Support/Google/Chrome`, `Library/Application Support/Chromium`, `Library/Application Support/BraveSoftware`, `Library/Application Support/Microsoft Edge`, `Library/Application Support/Arc`, `Library/Application Support/Firefox`, `Library/Safari`, `Library/Cookies`, `.mozilla`, `.config/google-chrome`, `.config/chromium`, `.config/BraveSoftware`, `.config/microsoft-edge`
    - plus the absolute `/Library/Keychains`, and Tropos's own `home`.
  - `export const CACHE_PATHS: readonly string[]` (relative to the user's home):
    - `.npm .bun/install/cache .pnpm-store .local/share/pnpm .yarn/berry/cache .cargo/registry .cargo/git go/pkg/mod .gradle/caches .m2/repository`
    - `.cache/pip .cache/pnpm .cache/yarn .cache/go-build .cache/uv .cache/deno .cache/ms-playwright`
    - `Library/Caches/pip Library/Caches/pnpm Library/pnpm Library/Caches/Yarn Library/Caches/go-build Library/Caches/Homebrew Library/Caches/uv Library/Caches/deno Library/Caches/ms-playwright Library/Caches/node-gyp`
  - `interface ConfinementPaths { project: string; writable: string[]; gitDirs: string[]; husky: string[]; deniedReads: string[]; readCarveOut: string; platform: NodeJS.Platform }`
  - `confinementPaths(opts: { project: string; home: string; userHome: string; env: NodeJS.ProcessEnv; platform?: NodeJS.Platform }): ConfinementPaths`:
    - Every path goes through `realpath` when it exists. Missing ones are joined onto the real `userHome`.
    - `writable` holds the real `env.TMPDIR ?? os.tmpdir()`, `/private/tmp` (darwin) or `/tmp` (linux), the sibling `C` of a darwin `/private/var/folders/*/*/T` temp dir, and the caches.
    - `gitDirs` holds `<project>/.git`, plus its link target when `.git` is a symlink that resolves (lexically or by realpath) inside the project. `husky` does the same for `.husky`.
    - `readCarveOut` is `<home>/workspace`.
  - `sandboxProfile(paths: ConfinementPaths): { profile: string; params: [string, string][] }`. Paths travel as `-D` params (`PROJECT`, `W0…`, `G0…`, `K0…`, `R0…`, `C0`), never inlined, except the git-dir regexes. The profile, in this order (last match wins, verified on macOS 26 with `/usr/bin/sandbox-exec`):

    ```
    (version 1)
    (allow default)
    (deny file-write*)
    (allow file-write* (subpath (param "PROJECT")) (subpath (param "W0")) … (literal "/dev/null") (literal "/dev/zero") (literal "/dev/dtracehelper") (regex #"^/dev/(tty|fd/)"))
    (deny file-write* (literal (param "PROJECT")) (literal (param "G0")) … (literal (param "K0")) (subpath (param "K0")) …
                      (regex #"^<escaped G0>/(.*/)?(hooks(/.*)?|config(\.worktree)?)$") …)
    (deny file-read* (subpath (param "R0")) …)        ; files and directories alike: subpath also matches the path itself
    (allow file-read* (subpath (param "C0")))          ; ~/.tropos/workspace
    ```

    Experiments established the following (scratchpad, 2026-10-16):
    - Denying the literal project dir and the literal `.git` blocks the rename attacks `mv .git g2; write g2/hooks/x; mv g2 .git` and `mv <project> $TMPDIR/p`, while creating and deleting files inside both still works.
    - The `(.*/)?hooks` regex covers submodules, renamed `modules/` dirs and `.GIT/HOOKS`.
    - Profile paths must be real paths (`/tmp/...` fails, `/private/tmp/...` works).
    - Setuid tools such as `ps` don't run inside.

    A project path containing `"` throws `ConfinementError("<path> can't be confined: its path contains a double quote.")`. Regex metacharacters are escaped.
  - `bwrapArgs(paths: ConfinementPaths, cwd: string): string[]`, in this order:
    - `--die-with-parent --ro-bind / / --dev /dev --proc /proc`
    - `--bind <w> <w>` for each existing writable dir
    - per existing secret: `--tmpfs <dir>` or `--ro-bind /dev/null <file>`
    - `--ro-bind <carve-out> <carve-out>` when it exists and isn't the project
    - `--bind <project> <project>`
    - `--bind <project>/.git <project>/.git` when it is a directory. This makes it a mount point, so renaming it fails with EBUSY.
    - `--ro-bind p p` for each `protectedPaths(project)`
    - `--chdir <cwd>`
  - `class ConfinementError extends Error`.

- [ ] **Step 1: Write the failing tests**

```ts
// env.test.ts
test("only the allowlist passes, LC_* included", () => {
  expect(Object.keys(chatEnv({ PATH: "/usr/bin", HOME: "/h", LC_ALL: "C", GITHUB_TOKEN: "x", NODE_OPTIONS: "--require x" }, { project: "/w/app" })).sort()).toEqual(["HOME", "LC_ALL", "PATH"]);
});
test("PATH loses '.', empty, relative and project entries", () => {
  expect(chatEnv({ PATH: ".::bin:/w/app/node_modules/.bin:/usr/bin" }, { project: "/w/app" }).PATH).toBe("/usr/bin");
  expect(chatEnv({ PATH: "." }, { project: "/w/app" }).PATH).toBe("/usr/bin:/bin:/usr/sbin:/sbin");
});
// confinement-paths.test.ts
test("the secrets list holds every path the spec names", () => {
  for (const p of [".ssh", ".aws", ".gnupg", ".config/gh", ".docker/config.json", ".netrc", "Library/Keychains"]) expect(SECRET_PATHS).toContain(p);
});
test("paths are real paths; Tropos's home is denied and its workspace carved out; caches and temp are writable", ...);
test("a .git symlink to a folder inside the project protects that folder too", ...);
// sandbox-profile.test.ts
test("the rules come in the order the sandbox needs: base write deny, allows, protections, read denies, carve-out last", ...); // indexOf ordering on the profile text
test("paths travel as params; only the git regex embeds an escaped path; a double quote is refused", ...);
// bwrap-args.test.ts
test("root read-only, project bound after the secrets are hidden, .git self-bound, protected paths read-only last", ...);
```

- [ ] **Step 2: Run the tests and confirm they fail.** Run `bun test src/exec/env.test.ts src/exec/confinement-paths.test.ts src/exec/sandbox-profile.test.ts src/exec/bwrap-args.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement the four modules as specified above.**
- [ ] **Step 4: Run the tests and confirm they pass.** Run the same command plus `bun run typecheck`. Expected: PASS.
- [ ] **Step 5: Stage**

```bash
git add src/exec/env.ts src/exec/env.test.ts src/exec/confinement-paths.ts src/exec/confinement-paths.test.ts src/exec/sandbox-profile.ts src/exec/sandbox-profile.test.ts src/exec/bwrap-args.ts src/exec/bwrap-args.test.ts
```

---

### Task 6: The confined backend (C3), tested against real sandbox-exec

**Files:**
- Create: `src/exec/confined.ts`, `src/exec/confined.test.ts`
- Modify: `src/exec/backend.ts:25` (`kind: "local" | "docker" | "confined"`)

**Interfaces:**
- Consumes: Task 5 builders.
- Produces (C3 names exact):
  - `confinedBackend(opts: { project: string; home: string; userHome: string; env: NodeJS.ProcessEnv }): ExecBackend` (kind `"confined"`). The profile or args are computed once at construction.
    - `spawn` runs `/usr/bin/sandbox-exec -p <profile> -D k=v… <shell> -c <script>` (darwin) or `bwrap <args> -- <shell> -c <script>` (linux). It uses `cwd`, `env: chatEnv(opts.env, { project })`, `detached: true` and `stdio: ["ignore","pipe","pipe"]`. sandbox-exec execs in place, so the child pid is the shell and process-group signals work as in `LocalBackend`.
    - `cwdMarker` returns a path under the confined temp dir (`env.TMPDIR ?? os.tmpdir()`, real path), the same inside and on the host.
    - `signal`, `alive` and `close` behave as in `LocalBackend`.
    - Other platforms throw `ConfinementError`.
  - `unconfinedBackend(opts: { project: string; env: NodeJS.ProcessEnv }): ExecBackend` (kind `"local"`): a `LocalBackend` whose spawn replaces `env` with `chatEnv(opts.env, { project })`.
  - `detectConfinement(exec: (bin: string, args: string[]) => Promise<{ code: number | null }>, platform?: NodeJS.Platform): Promise<Confinement | null>`:
    - darwin: `/usr/bin/sandbox-exec -p "(version 1)(allow default)" /usr/bin/true` exits 0.
    - linux: `bwrap --ro-bind / / /bin/true` exits 0.
    - Anything else is `null`. A missing binary is `null`.
  - `confinementAvailable(): Promise<Confinement | null>`: `detectConfinement` over `Bun.spawn`, cached for the process.

- [ ] **Step 1: Write the failing tests.** Use a temp fixture with `userHome = <fx>/home` (`.ssh/id`, `.tropos/secret`, `.tropos/workspace/f`), `project = <fx>/proj` (`.git/hooks`, `.git/config`, `.husky`), `env.TMPDIR = <fx>/tmp` and `outside = <fx>/outside`. The real temp root then isn't the writable temp dir, so an "outside" write is meaningful.

```ts
const available = await confinementAvailable();
test("detectConfinement asks the platform's tool and treats a missing one as none", async () => {
  expect(await detectConfinement(async () => ({ code: 0 }), "darwin")).toBe("sandbox-exec");
  expect(await detectConfinement(async () => ({ code: 0 }), "linux")).toBe("bwrap");
  expect(await detectConfinement(async () => ({ code: null }), "linux")).toBeNull();
  expect(await detectConfinement(async () => ({ code: 0 }), "win32")).toBeNull();
});
describe.skipIf(available === null)("with real confinement", () => {
  test("project, temp and cache writes work; writes elsewhere fail", ...);              // exit codes of `echo a > …`
  test(".git/hooks, .git/config, .husky, a submodule's hooks and renaming .git or the project all fail", ...);
  test("reads of the fake ~/.ssh and ~/.tropos fail, ~/.tropos/workspace reads work", ...);
  test("network is allowed (a local Bun.serve on 127.0.0.1 answers curl)", ...);
  test("only the allowlisted environment reaches the command", ...);                   // SECRET=unset, PATH kept
  test("signal() stops the whole group and alive() follows it", ...);                   // as local.test.ts:52
});
test("unconfinedBackend runs on the host with the allowlisted environment", ...);
```

- [ ] **Step 2: Run the tests and confirm they fail.** Run `bun test src/exec/confined.test.ts`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement `src/exec/confined.ts`.**
- [ ] **Step 4: Run the tests and confirm they pass.** Run `bun test src/exec && bun run typecheck`. Expected on this Mac: PASS with the real sandbox-exec block running, not skipped.
- [ ] **Step 5: Stage**

```bash
git add src/exec/confined.ts src/exec/confined.test.ts src/exec/backend.ts
```

---

### Task 7: Chats and scheduled runs on the host, at their level

**Files:**
- Create: `src/gateway/chat-exec.ts`, `src/gateway/chat-exec.test.ts`
- Modify: `src/gateway/policy.ts:31-56` (`channelContext`)
- Modify: `src/gateway/daemon.ts`, at these points:
  - `:69-81` seams
  - `:153-154` (`ensureChatSettings`)
  - `:196-222` backend choice in `pool.create`
  - `:200-201` docker check and sweep only for docker
  - `:224` policy
  - `:324` reload
- Modify: `src/gateway/cron/runner.ts:16-19` (doc comment only)
- Test: `src/gateway/policy.test.ts`, `src/gateway/daemon.projects.test.ts`, `test/e2e/gateway.test.ts` (the real-Docker test writes `chat: { backend: "docker", autonomy: "ask" }` first, and there is one new real-confinement e2e)
- Modify: `README.md:126-170` ("Gateway: work from your phone": where commands run, what confinement protects and what it doesn't)

**Interfaces:**
- Consumes: `role` on the session's `AppContext` (C1). `sessionAutonomy`, `pinnedTestCommands`, `ensureChatSettings` (Task 1). `confinedBackend`, `unconfinedBackend`, `confinementAvailable` (Task 6). `DockerBackend`, `dockerCheck`.
- Produces:
  - `chatBackend(input: { config: GatewayConfig; workspace: string; home: string; userHome: string; env: NodeJS.ProcessEnv; confinement(): Promise<Confinement | null>; dockerCheck(): Promise<string | undefined>; override?: (workspace: string) => ExecBackend }): Promise<{ backend: ExecBackend; confined: boolean }>`
    - `docker`: a docker problem throws `SandboxUnavailableError`. Otherwise it returns `override?.(workspace) ?? new DockerBackend(…config.sandbox)` with `confined: true`.
    - `host`: `override` gives `{ override(workspace), confined: true }`. Otherwise it returns `confinedBackend` (confined), or `unconfinedBackend` when `confinement()` is null (`confined: false`).
  - `channelContext(base: AppContext, exec: ExecBackend, opts: { role: SessionRole; autonomy?: () => AutonomyPolicy }): AppContext` (P1 Task 2 introduced `opts` with `role`; this task adds `autonomy`) sets `autonomy: opts.autonomy`.
  - `GatewayRun.seams` gains `confinement?: () => Promise<Confinement | null>` and `userHome?: string`.
  - In the daemon:
    - `let live: GatewayConfig`, with `refreshConfig(): Promise<GatewayConfig>` (it keeps the old value when the file is invalid), called at start after `ensureChatSettings(home)`, at every `pool.create`, and first thing in `reload`.
    - The session policy is `() => ({ level: sessionAutonomy({ config: live, projectId, role: sessionCtx.role, confined }), testCommands: pinnedTestCommands(live, projectId) })`.
    - The `sandboxCheck` seam keeps meaning "Docker's answer".

- [ ] **Step 1: Write the failing tests**

```ts
// chat-exec.test.ts
test("docker: a docker problem fails closed, as before", ...);            // rejects SandboxUnavailableError
test("host with confinement: the confined backend, confined", ...);       // kind "confined", confined true
test("host without confinement: the host with the allowlisted env, not confined", ...); // kind "local", confined false
// policy.test.ts
test("the autonomy policy reaches the permission context and stays live", () => {
  let level: Autonomy = "balanced";
  const ctx = channelContext(base(), exec, { role: "owner", autonomy: () => ({ level, testCommands: [] }) });
  expect(ctx.autonomy!().level).toBe("balanced"); level = "ask"; expect(ctx.autonomy!().level).toBe("ask");
});
test("no chat tool can write gateway.json, even for the owner at autonomous", () => {
  // confine: true, allowedDirs [cwd], autonomy autonomous, role owner → Write /h/.tropos/gateway.json is "deny"
});
// daemon.projects.test.ts (fake backend seam, real permission engine)
test("a fresh install chats at balanced: a read-only command runs without asking, a write asks", ...);
// FakeModel: Bash "ls" then Bash "touch x"; expect one permission keyboard (for touch), and gateway.json chat = balanced/host
test("an existing install (gateway.json without chat, an approved sender in pairing.json) keeps asking for everything", ...);
test("without confinement or consent, a level raised in gateway.json still asks", ...);   // seams.confinement → null; autonomy autonomous in file; `ls` asks
test("a guest's chat asks even when the project is autonomous", ...);                    // pairing: approved, not owner
test("a scheduled run uses the project's level: at balanced, a read-only command runs and an install is denied", ...);
// via a fake GatewayService: deps.openSession("default"), attach a sink whose ask() answers deny (as the runner does)
// test/e2e/gateway.test.ts
test.skipIf((await confinementAvailable()) === null)("with real confinement: the chat's command runs in the project with only the allowlisted environment", ...);
```

- [ ] **Step 2: Run the tests and confirm they fail.** Run `bun test src/gateway test/e2e/gateway.test.ts`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement `chatBackend`, the `channelContext` option and the daemon wiring.** Remove the unconditional `check()` at `daemon.ts:216-217`; docker is now checked inside `chatBackend`. `sweepLeftoverContainers` runs only when `live.chat.backend === "docker"`. Rewrite the runner's comment: "a scheduled run's session carries its project's autonomy; whatever still asks is denied here unless the job lists it". Update the README:
  - **Where commands run:** host with sandbox-exec/bwrap or Docker. Give the write/read rules, network on, the env allowlist, and that setuid tools (`ps`, `sudo`) and nested sandboxes don't work inside.
  - **What confinement does not protect:** reads of non-secret files outside the project are allowed; caches are writable.
  - **Without confinement:** ask works as usual; a higher level needs the "run unconfined" consent.
  - **Existing installs** stay on Docker and ask until switched.
- [ ] **Step 4: Run the tests and confirm they pass.** Run `bun test src/gateway src/exec test/e2e && bun run typecheck`. Expected: PASS.
- [ ] **Step 5: Stage**

```bash
git add src/gateway/chat-exec.ts src/gateway/chat-exec.test.ts src/gateway/policy.ts src/gateway/policy.test.ts src/gateway/daemon.ts src/gateway/daemon.projects.test.ts src/gateway/cron/runner.ts test/e2e/gateway.test.ts README.md
```

---

### Task 8: `/autonomy` in chats (owner only, lower only)

**Files:**
- Modify: `src/gateway/types.ts` (add `ChatAutonomy` after `ChatProjects`, line 73)
- Modify: `src/gateway/telegram/adapter.ts:29-44` (options), `:235-257` (`handleMessage`: route `/autonomy` before the session opens, like `/project`)
- Modify: `src/gateway/telegram/render.ts:155-169` (`HELP_TEXT`, `BOT_COMMANDS`)
- Modify: `src/gateway/daemon.ts:271-280` (pass `autonomy` to the adapter)
- Test: `src/gateway/telegram/adapter.test.ts`, `src/gateway/telegram/render.test.ts`, `src/gateway/daemon.projects.test.ts`
- Modify: `README.md` (autonomy levels table, `/autonomy`, who can raise, and the plain sentence that `balanced` lets the agent run code it wrote, such as tests, inside the confinement)

**Interfaces:**
- Consumes: `Pairing.isOwner(channel, senderId)` (C1; on the `Pairing` interface and `FakePairing` since P1 Task 1). Also `lowerAutonomy`, `effectiveAutonomy`, `canRaise` (Task 1), and the daemon's `refreshConfig` (Task 7).
- Produces:
  - `export interface ChatAutonomy { current(chatKey: string): Promise<{ level: Autonomy; project: { id: string; name: string } }>; lower(chatKey: string, to: Autonomy): Promise<{ changed: boolean; level: Autonomy; project: { id: string; name: string } }> }`. `lower` rejects with `AutonomyError` on a raise.
  - `TelegramAdapterOptions.autonomy?: ChatAutonomy`.
  - The daemon implements it with `router.current(chatKey)` + `lowerAutonomy(home, project.id, to)` + `refreshConfig()`, so open sessions change at their next decision.
  - Exact replies:
    - non-owner: `Only the owner can see or change the autonomy level.`
    - `/autonomy`: `Autonomy in <name>: <level>.\nask: every edit and command asks · balanced: edits, read-only commands and tests run, the rest asks · autonomous: everything in the project runs, MCP tools ask.\nLower it with /autonomy ask or /autonomy balanced. Raising it is done on the computer: tcode config or the dashboard.`
    - lowered: `Autonomy in <name> is now <level>.`
    - unchanged: `Autonomy in <name> is already <level>.`
    - a raise: `RAISE_REFUSED`
    - anything else: `Use /autonomy, /autonomy ask or /autonomy balanced.`
    - without `autonomy` option: `Autonomy isn't available here.`
  - `HELP_TEXT` gains `/autonomy  show the autonomy level, or lower it`. `BOT_COMMANDS` gains `{ command: "autonomy", description: "Show or lower the autonomy level" }`.

- [ ] **Step 1: Write the failing tests**

```ts
// adapter.test.ts (fake ChatAutonomy recording lower() calls)
test("/autonomy shows the level to the owner without opening a session", ...);
test("/autonomy ask lowers; /autonomy autonomous is refused; an unknown argument gets the usage line", ...);
test("an approved sender who isn't the owner can't use /autonomy", ...);   // reply exact; lower() never called
test("help and the bot's command menu mention /autonomy", ...);
// daemon.projects.test.ts
test("/autonomy ask from the owner applies to the open session at once", async () => {
  // gateway.json chat balanced/host; FakeModel: Bash "ls" (runs, no keyboard), text; then after "/autonomy ask": Bash "ls" → a permission keyboard is sent
  // and gateway.json now has chat.autonomy "ask"
});
```

- [ ] **Step 2: Run the tests and confirm they fail.** Run `bun test src/gateway/telegram src/gateway/daemon.projects.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement `handleAutonomyCommand(chatId: number, senderId: string, text: string): Promise<void>` in the adapter, the daemon's `ChatAutonomy`, and the README section.**
- [ ] **Step 4: Run the tests and confirm they pass.** Run `bun test src/gateway && bun run typecheck`. Expected: PASS.
- [ ] **Step 5: Stage**

```bash
git add src/gateway/types.ts src/gateway/telegram/adapter.ts src/gateway/telegram/adapter.test.ts src/gateway/telegram/render.ts src/gateway/telegram/render.test.ts src/gateway/daemon.ts src/gateway/daemon.projects.test.ts README.md
```

---

### Task 9: End-of-task summary in chats

**Files:**
- Modify: `src/gateway/telegram/render.ts` (new `taskSummaryText`)
- Modify: `src/gateway/telegram/adapter.ts:347-383` (`onEvent` records), `:460-488` (`runTurn` resets at start and sends after `flushTools`)
- Test: `src/gateway/telegram/render.test.ts`, `src/gateway/telegram/adapter.test.ts`

**Interfaces:**
- Consumes: `tool_start` (`id`, `name`, `input`) and `tool_end` (`id`, `status`) events; `ChatProjects.current(chatKey).path` to relativise file paths.
- Produces:
  - `taskSummaryText(done: { files: string[]; commands: string[] }): string | undefined`. It returns `undefined` when both are empty. Otherwise it gives the lines `Changed: a.ts, src/b.ts` (deduped, at most 10, then ` and N more`) and `Ran: bun test · git status` (each `oneLine(…, 80)`, at most 8, then ` and N more`), joined by `\n`.
  - The `Chat` record gains `done: { files: Set<string>; commands: string[]; pending: Map<string, { name: string; input: unknown }> }`.
  - On `tool_end` with status `"done"`: `Bash` adds `input.command`, and `Edit`/`Write` add `input.file_path`. The summary is sent once per turn after the answer, whatever the end reason (a busy refusal sends nothing).

- [ ] **Step 1: Write the failing tests**

```ts
test("taskSummaryText lists changed files and commands, capped", () => {
  expect(taskSummaryText({ files: [], commands: [] })).toBeUndefined();
  expect(taskSummaryText({ files: ["src/a.ts"], commands: ["bun test", "git status"] })).toBe("Changed: src/a.ts\nRan: bun test · git status");
  expect(taskSummaryText({ files: Array.from({ length: 12 }, (_, i) => `f${i}`), commands: [] })).toEndWith(" and 2 more");
});
test("after a turn that edited and ran things, the chat gets one summary; denied or failed calls aren't in it", ...);
test("a turn that only answered sends no summary", ...);
```

- [ ] **Step 2: Run the tests and confirm they fail.** Run `bun test src/gateway/telegram`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests and confirm they pass.** Run `bun test src/gateway/telegram && bun run typecheck`. Expected: PASS.
- [ ] **Step 5: Stage**

```bash
git add src/gateway/telegram/render.ts src/gateway/telegram/render.test.ts src/gateway/telegram/adapter.ts src/gateway/telegram/adapter.test.ts
```

---

### Task 10: Admin API for the Autonomy settings tab

**Files:**
- Create: `src/web/admin/autonomy.ts`, `src/web/admin/autonomy.test.ts`
- Modify: `src/web/admin/api.ts` (new section before "the whole API"; `AdminMap` at `:354-368`; `ADMIN_METHODS` at `:376-432`)
- Modify: `src/web/admin/index.ts:28-44`, `src/web/admin/context.ts:5-25`

**Interfaces:**
- Consumes: Task 1 setters, `detectTestCommands` (Task 3), `confinementAvailable` (Task 6), `listProjects`.
- Produces (P3's Settings → Autonomy tab and P4's wizard call these):
  - `api.ts`, browser-safe with no imports from `src/gateway`:

    ```ts
    export type AutonomyLevel = "ask" | "balanced" | "autonomous"; // = Autonomy in src/gateway/autonomy.ts
    export interface AutonomyProjectView { id: string; name: string; builtin?: boolean; level?: AutonomyLevel; effective: AutonomyLevel; testCommands: string[]; detectedTests: string[] }
    export interface AutonomyView { level: AutonomyLevel; backend: "host" | "docker"; confinement: "sandbox-exec" | "bwrap" | null; unconfinedAccepted: boolean; unconfined: boolean; projects: AutonomyProjectView[] }
    export interface AutonomyAdmin {
      "autonomy.get": { params: undefined; result: AutonomyView };
      /** No projectId: the global level. With one: that project's level; null clears it. */
      "autonomy.set": { params: { level: AutonomyLevel | null; projectId?: string; acceptUnconfined?: boolean }; result: AutonomyView };
      "autonomy.setBackend": { params: { backend: "host" | "docker"; acceptUnconfined?: boolean }; result: AutonomyView };
      /** Pins detected test commands for a project; [] unpins. */
      "autonomy.confirmTests": { params: { projectId: string; commands: string[] }; result: AutonomyView };
    }
    ```

  - `AdminContext.probeConfinement?: () => Promise<"sandbox-exec" | "bwrap" | null>` (default `confinementAvailable`).
  - `export async function autonomyView(home: string, confinement: Confinement | null): Promise<AutonomyView>`. P3's `tcode status` may reuse it. `unconfined` is true when the backend is host, confinement is null and the effective global level is above ask with consent.
  - Rules:
    - `AutonomyError` is shown as `AdminError` with the same message.
    - `confirmTests` accepts only commands in `detectTestCommands(project.path)`. Otherwise it fails with `Only detected test commands can be pinned.`
    - The default workspace fails with `The default workspace has no pinned tests.`
    - Every successful set calls `ctx.gateway?.reload()`.

- [ ] **Step 1: Write the failing tests** (host-testkit, as `projects.test.ts:1-12`)

```ts
test("get shows the global level, backend, confinement and each project with detected and pinned tests", ...);
test("set raises the global level with confinement, refuses without it unless run-unconfined is accepted, and reloads the gateway", ...);
test("set on a project, and null clears it; an unknown project is an error", ...);
test("setBackend to host on a machine without confinement needs consent when the level is above ask", ...);
test("confirmTests pins only detected commands; the default workspace has none", ...);
test("the four methods are listed in ADMIN_METHODS and have handlers", ...);
```

- [ ] **Step 2: Run the tests and confirm they fail.** Run `bun test src/web/admin/autonomy.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement `autonomyHandlers(ctx: AdminContext): AdminHandlers` and register it in `createAdmin`.**
- [ ] **Step 4: Run the tests and confirm they pass.** Run `bun test src/web/admin && bun run typecheck`. Expected: PASS.
- [ ] **Step 5: Stage**

```bash
git add src/web/admin/autonomy.ts src/web/admin/autonomy.test.ts src/web/admin/api.ts src/web/admin/index.ts src/web/admin/context.ts
```

---

### Task 11: Doctor: unconfined warning, the offer to switch, Docker optional

**Files:**
- Create: `src/doctor/checks/chat-exec.ts`, `src/doctor/checks/chat-exec.test.ts`
- Modify: `src/doctor/checks/index.ts` (add after `dockerCheck`), `src/doctor/checks/docker.ts:20-32`, `src/doctor/checks/docker.test.ts`

**Interfaces:**
- Consumes: `detectConfinement(env.runner.exec, env.platform)` (Task 6); raw `gateway.json` read like `sandboxImage` (`docker.ts:9-18`) so config errors stay the gateway check's to report; `effectiveAutonomy` / `needsUnconfinedConsent` semantics from Task 1.
- Produces `chatExecCheck: Check` (`id: "chat.exec"`, `area: "security"`). The findings (none fixable, since a switch is the user's to accept):
  - `chat.exec` ok: `Chat commands run on this machine, confined by <tool>, at <level>`, or `Chat commands run in Docker, at <level>`.
  - `chat.exec.unconfined` warn: `Chat commands run unconfined on this machine`, with detail `Install bubblewrap (bwrap) to confine them, or lower the autonomy level to ask.` on linux, or `sandbox-exec isn't working here; lower the autonomy level to ask.` on darwin.
  - `chat.exec.held` info: `Chats are held at ask: commands can't be confined here and running unconfined wasn't confirmed`.
  - `chat.exec.switch` info, when backend is docker and level is ask: `Chats use Docker and ask before everything. They can run on this Mac without Docker, confined, at a higher autonomy level: Settings → Autonomy, or tcode onboard.`
  - `docker.ts`: when the raw `chat.backend` is `"host"`, "Docker is not installed" / "daemon not reachable" become `info` with detail `Optional: chats run on this machine. Docker is only needed if you switch chats to the Docker backend.`

- [ ] **Step 1: Write the failing tests**, covering each finding above with `fakeRunner` and fixture gateway.json files, plus the two Docker levels.
- [ ] **Step 2: Run the tests and confirm they fail.** Run `bun test src/doctor/checks/chat-exec.test.ts src/doctor/checks/docker.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests and confirm they pass.** Run `bun test src/doctor && bun run typecheck`. Expected: PASS.
- [ ] **Step 5: Stage**

```bash
git add src/doctor/checks/chat-exec.ts src/doctor/checks/chat-exec.test.ts src/doctor/checks/index.ts src/doctor/checks/docker.ts src/doctor/checks/docker.test.ts
```

---

### Task 12: Dashboard chat as an owner session per project (server side)

**Files:**
- Create: `src/web/project-hosts.ts`, `src/web/project-hosts.test.ts`
- Modify: `src/web/protocol.ts:8-20` (`HelloInfo.project`), `:62-87` (`RpcMap`), `:90-112` (`RPC_METHODS`)
- Modify: `src/web/host.ts` (a `"project.select"` case in the RPC switch near `:250`)
- Modify: `src/web/server.ts:12-13` (`host: ChatHost`)
- Modify: `src/gateway/daemon.ts:282-336` (build `ProjectHosts`), `:393-403` (shutdown)

**Interfaces:**
- Consumes: `ProjectSource` (`get`, `defaultId`), P1 Task 8's `ProjectContexts.acquire(project)` (which replaced the daemon's `contextFor`), and `createRuntime` with `modes: MODES.filter((m) => m !== "bypass")` and the role `"owner"` from P1. There is no chat confinement here: `origin` stays local, so there is no `autonomy` and the exec stays local.
- Produces:
  - `protocol.ts`: `HelloInfo.project?: { id: string; name: string }`; `RpcMap["project.select"]: { params: string; result: HelloInfo }`.
  - `project-hosts.ts`:

    ```ts
    export interface ChatHost { attach(send: Send): () => void; handle(message: ClientMessage, reply: Send): Promise<void>; shutdown(): Promise<void> }
    export interface ProjectHostsOptions { get(id: string): Promise<{ id: string; name: string } | undefined>; defaultId(): Promise<string>; open(projectId: string): Promise<WebHost> }
    export class ProjectHosts implements ChatHost { static create(opts: ProjectHostsOptions): Promise<ProjectHosts> }
    ```

    - `create` opens the default project's host up front, so a broken default project fails as today.
    - Every tab starts in the default project and is tracked by its `send` function.
    - `{t:"hello"}` messages to a tab get `project` injected.
    - `project.select` validates the id (`There is no project "<id>".` as an RPC error), opens the host once (cached), detaches the tab from the old host and attaches it to the new one, which sends hello, state and pending asks. It replies with that hello.
    - Every other message goes to the tab's current host.
    - `shutdown` shuts down every opened host.
  - `WebHost` answers `project.select` with `RpcError("Switching projects needs the background service's dashboard (tcode dashboard).")`, which is what plain `tcode web` gives.

- [ ] **Step 1: Write the failing tests** (fake WebHost-shaped objects recording attach, detach and handle)

```ts
test("a new tab is in the default project and its hello names it", ...);
test("project.select moves only that tab, opens each project's host once, and replies with the new hello", ...);
test("an unknown project is an RPC error and the tab stays", ...);
test("prompts and permission answers go to the tab's current project", ...);
test("shutdown closes every opened host", ...);
// host.test.ts
test("a plain WebHost refuses project.select", ...);
```

- [ ] **Step 2: Run the tests and confirm they fail.** Run `bun test src/web`. Expected: FAIL.
- [ ] **Step 3: Implement.** In the daemon, `open(projectId)` builds the runtime as `daemon.ts:289-303` does today, on the context from `contexts.acquire(project)`; the host's `shutdown` calls that acquisition's `release()`.
- [ ] **Step 4: Run the tests and confirm they pass.** Run `bun test src/web src/gateway && bun run typecheck`. Expected: PASS.
- [ ] **Step 5: Stage**

```bash
git add src/web/project-hosts.ts src/web/project-hosts.test.ts src/web/protocol.ts src/web/host.ts src/web/host.test.ts src/web/server.ts src/gateway/daemon.ts
```

---

### Task 13: Project picker in the dashboard Chat

**Files:**
- Create: `web/src/components/chat/ProjectPicker.tsx`, `web/src/components/chat/ProjectPicker.test.tsx`
- Modify: `web/src/app/layout/TopBar.tsx` (render the picker left of the model chip when `hello.project` is set)
- Modify: `web/src/components/chat/chat-test-kit.ts` (`FakeSocket.adminHandlers`, answered like `handlers` for `{t:"admin"}`)

**Interfaces:**
- Consumes: `useHello`, `useHelloSeq`, `useBusy`, `store.admin("projects.list")`, `store.rpc("project.select", id)`; `HelloInfo.project` (Task 12).
- Produces `ProjectPicker()`:
  - It is hidden when `hello.project` is undefined (plain `tcode web`, the demo).
  - The button reads `Project: <name>` (aria-label `Project: <name>. Change project`). It follows the `ModelChip` styling in `TopBar.tsx`, including its focus-visible ring, hover and active states.
  - It opens a list (role `listbox`) of `projects.list` entries, with the current one marked `aria-selected`.
  - Choosing one calls `project.select` and stores the id in `sessionStorage["tcode.chatProject"]`, wrapped in try/catch.
  - It is disabled while `useBusy()` is true, with the title `Finish or stop the current turn first`.
  - After a reconnect hello whose project differs from the stored id, it re-selects once.
  - Failures toast `Could not switch project` with the error message.

- [ ] **Step 1: Write the failing tests**

```ts
test("hidden without a project in hello", ...);
test("shows the current project and lists the registered ones", ...);
test("choosing a project sends project.select and remembers it for this tab", ...);
test("after reconnecting into the default project, the remembered project is selected again", ...);
test("disabled while a turn runs", ...);
```

- [ ] **Step 2: Run the tests and confirm they fail.** Run `bun test web/src/components/chat/ProjectPicker.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests and confirm they pass.** Run `bun test web/src && bun run typecheck`. Expected: PASS.
- [ ] **Step 5: Visual check.** Run `bun run build:web`, start a gateway on a temp `TROPOS_HOME` with two projects, and look at Chat with the picker open at 320, 375, 768, 1024 and 1440 px under both system color schemes (the app is light-only, as P3 decided: under a dark scheme it must stay light and legible). Confirm there is no horizontal overflow, the menu stays reachable by keyboard (Tab, Enter, Esc), and the animation is off under reduced motion. Owner's rule: Playwright screenshots once P3's shared harness lands.
- [ ] **Step 6: Stage**

```bash
git add web/src/components/chat/ProjectPicker.tsx web/src/components/chat/ProjectPicker.test.tsx web/src/app/layout/TopBar.tsx web/src/components/chat/chat-test-kit.ts
```

---

## Notes for sibling plans

- **P3 (Settings → Autonomy, Advanced → Docker, `tcode status`):** call `autonomy.get` / `autonomy.set` / `autonomy.setBackend` / `autonomy.confirmTests` (Task 10). Show `UNCONFINED_CONSENT` as the confirmation text. `autonomyView(home, confinement)` is exported for `tcode status`.
- **P4 (wizard "autonomy" step, offer to install bwrap):** use `setAutonomy` / `setChatBackend` (Task 1, consent stored as `chat.allowUnconfined`) and `confinementAvailable()` (Task 6), and call `ensureChatSettings(home)` when setup starts. Step order doesn't matter: `existingInstall` (Task 1) looks only at approved senders and finished setup, never at `gateway.json` alone.
- **P7 (`TroposSetup` "lower autonomy"):** use `lowerAutonomy(home, projectId, to)`.

## Self-review

- **Spec coverage:**
  - §5.1: host backend and confinement (Tasks 5–7), env allowlist (Task 5), migration (Tasks 1, 7), unconfined consent (Tasks 1, 10, 11), doctor warning (Task 11). Wizard and status surfaces belong to P4 and P3 (notes above).
  - §5.2: table (Task 4), classifier (Task 2), tests, pinning and manifests (Tasks 3, 4, 10), scheduled runs (Task 7), who can change it (Tasks 1, 7, 8, 10), `/autonomy` (Task 8), end-of-task summary (Task 9), README (Tasks 7, 8).
  - §5.3: owner session per project with a picker (Tasks 12, 13). Approvals on the phone belong to P3.
- **Type consistency:**
  - `Autonomy` (gateway) and `AutonomyLevel` (browser-safe api.ts) are the same union.
  - `AutonomyPolicy` is defined in engine.ts and consumed by runtime.ts, policy.ts and the daemon.
  - `Confinement` lives in backend.ts and is used by Tasks 1, 6, 7, 10, 11.
  - `channelContext(base, exec, { role, autonomy })`: P1 introduced `opts` with `role`; this plan adds `autonomy`, set by the daemon only.
- **Review Focus:** each of the five items has a named test (Tasks 1, 8, 4, 7, 5).
