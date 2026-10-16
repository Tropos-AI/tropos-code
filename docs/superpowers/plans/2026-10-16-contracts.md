# Shared contracts for the 2026-10-16 plans

Specs: `docs/superpowers/specs/2026-10-16-setup-autonomy-access-design.md` (doc 1) and
`docs/superpowers/specs/2026-10-16-growing-agent-design.md` (doc 2).

Seven plans implement them, in this order (a plan may rely on the contracts of the plans before it):

| # | Plan file | Covers |
|---|---|---|
| P1 | `2026-10-16-p1-owner-learning-fixes.md` | owner role, doc 2 Part F + §10 items 1–7, 9–12, 14, 15 |
| P2 | `2026-10-16-p2-chat-execution-autonomy.md` | doc 1 Part B (host backend, confinement, autonomy levels, dashboard chat §5.3) |
| P3 | `2026-10-16-p3-dashboard-access.md` | doc 1 Parts C and D (dedupe, port, device login, Tailscale, mobile) |
| P4 | `2026-10-16-p4-guided-setup.md` | doc 1 Part A |
| P5 | `2026-10-16-p5-home-layout.md` | doc 2 Part E |
| P6 | `2026-10-16-p6-specialists.md` | doc 2 Part G, §10 item 8, item 13 (Agents page) |
| P7 | `2026-10-16-p7-setup-projects-suggestions.md` | doc 2 Parts H, I, J, §10 item 13 (Memory/Skills pages) |

Names below are binding across plans. A plan that needs a contract not listed here defines it in its own
"Interfaces" blocks and must not rename anything listed here.

## C1. Who is acting (P1)

- `src/cli/runtime.ts` `AppContext` gains `role: SessionRole` where
  `export type SessionRole = "owner" | "guest" | "scheduled"` (exported from `src/gateway/types.ts`).
  Terminal, `tcode -p`, and dashboard sessions are `"owner"`. Chat sessions are `"owner"` when the sender is the
  owner, otherwise `"guest"`. Cron runs and the heartbeat are `"scheduled"`. `origin` stays as it is.
- `gateway/pairing.json` gains `owner?: { channel: string; senderId: string; since: number }`.
  `FilePairing` (`src/gateway/pairing.ts`) gains `owner(): Promise<{channel: string; senderId: string} | null>`,
  `setOwner(channel: string, senderId: string): Promise<void>` (the sender must be approved),
  `isOwner(channel: string, senderId: string): Promise<boolean>`. On load, a file with exactly one approved sender and
  no owner gets that sender as owner (written back once).

## C2. Saving without asking (P1)

- User settings: `learning.askBeforeSaving?: boolean` (default `false`).
- `src/learning/stores.ts` exports `troposStorePaths(home: string): string[]` — the directories Memory, DailyNote,
  SkillManage, AgentManage and Identity write to. P5 and P6 extend this list (workspace files, `agents/`).
- `src/permissions/engine.ts`: a call by one of those tools whose every target path is inside `troposStorePaths`
  is allowed without asking when `role` is `"owner"` and `askBeforeSaving` is false; deny rules and asking hooks
  still win; confinement (`confine: true`) lets these paths through for `"owner"` only.

## C3. Autonomy and chat execution (P2)

- `src/gateway/autonomy.ts`: `export type Autonomy = "ask" | "balanced" | "autonomous"`;
  `effectiveAutonomy(config: GatewayConfig, projectId: string): Autonomy`;
  `canRaise(from: Autonomy, to: Autonomy): boolean` (true when `to` is stricter or equal).
- `gateway.json`: `chat: { autonomy: Autonomy; backend: "host" | "docker" }` (defaults for new installs
  `"balanced"` / `"host"`; the migration of P2 writes `"ask"` / `"docker"` for an existing file without `chat`),
  `projects[].autonomy?: Autonomy`, `projects[].testCommands?: string[]` (pinned, confirmed by the user).
- `src/exec/confined.ts`: `confinedBackend(opts: { project: string; home: string; userHome: string; env: NodeJS.ProcessEnv }): ExecBackend`
  and `confinementAvailable(): Promise<"sandbox-exec" | "bwrap" | null>`.
- `src/permissions/readonly.ts`: `isReadOnlyCommand(command: string): boolean`.
- `src/gateway/tests-detect.ts`: `detectTestCommands(projectDir: string): Promise<string[]>`.

## C4. Dashboard access (P3)

- Port: `DEFAULT_PORT = 4317` stays in `src/web/protocol.ts`; no random fallback for the service.
- `src/web/devices.ts`: `DeviceStore` over `gateway/devices.json` (0600) with
  `create(name: string): Promise<{ id: string; key: string }>`, `verify(key: string): Promise<Device | null>`,
  `list(): Promise<Device[]>`, `revoke(id: string)`, `revokeAll()`;
  `interface Device { id: string; name: string; createdAt: number; lastSeen: number; via: "local" | "tailscale" }`.
- `src/web/login-codes.ts`: `LoginCodes` with `issueOneTime(): Promise<string>` (2 minutes, for `#login=`),
  `issueCode(): Promise<string>` (6 digits, 10 minutes, 5 tries), `redeem(value: string): Promise<boolean>`.
- `gateway.json`: `remoteAccess: { tailscale: boolean; httpsPort?: number; hostname?: string }`.
- `src/remote/tailscale.ts`: `tailscaleStatus(runner): Promise<{ installed: boolean; running: boolean; dnsName?: string }>`,
  `enableServe(runner, port: number): Promise<{ url: string; httpsPort: number }>`, `disableServe(runner, httpsPort: number)`.
- `src/ui/qr.ts`: `renderQr(text: string): string` (terminal block characters).

## C5. Onboarding engine (P4)

Step ids (`OnboardStepId` in `src/web/admin/api.ts`) become:
`"welcome" | "provider" | "model" | "identity" | "projects" | "autonomy" | "telegram" | "phone" | "service" | "done"`.
`REQUIRED_STEPS` stays `["provider", "model"]`.

## C6. Home layout (P5)

`src/paths.ts` gains `workspaceDir(home)`, `workspaceFile(home, name: "AGENTS.md" | "SOUL.md" | "IDENTITY.md" | "USER.md" | "MEMORY.md" | "BOOTSTRAP.md")`,
`journalDir(home)` (= `workspace/memory`), `userSkillsDir(home)` (= `workspace/skills`),
`learnedSkillsDir(home)` (= `workspace/skills-learned`), `agentsDir(home)` (= `agents`).
Every reader of the old paths goes through these, with a fallback to the old path for one release.

## C7. Specialists (P6)

`src/agents/specialists.ts`: `interface Specialist extends SubagentDefinition { id: string; dir: string; autonomy?: Autonomy; createdBy: "user" | "chief" | "review"; createdAt: number; revision: number; archived?: boolean }`;
`loadSpecialists(home: string): Promise<Specialist[]>`; limits `MAX_ACTIVE_SPECIALISTS = 12`, `MAX_PARALLEL_SPECIALISTS = 4`,
archive after 60 days unused.

## C8. Proactive and projects (P7)

- `gateway.json`: `proactive: { enabled?: boolean; activeHours: { start: string; end: string }; everyHours: number; maxPerDay: number }`
  defaults `{ activeHours: { start: "09:00", end: "21:00" }, everyHours: 4, maxPerDay: 1 }`; `enabled` unset means
  "on once Telegram is connected". `newProjectsDir?: string` (default `~/Projects`).
- Tool name `TroposSetup` (`src/tools/setup/setup-tool.ts`).

## C9. Reconciled additions

Names the plans define beyond C1–C8 that a later (or, where noted, earlier) plan consumes. Binding like C1–C8; the
owner plan defines each, every other plan uses it as written here.

P1:
- `Pairing.owner()`, `Pairing.setOwner()`, `Pairing.isOwner()` on the `Pairing` interface (`src/gateway/types.ts`), implemented by `FilePairing` and `FakePairing` (`owners`) — P1 Task 1. No later plan adds them again.
- `PairingView.owner?: { channel; senderId }` and admin `"pairing.setOwner"` — P1 Task 1 (P3 Tasks 7, 13; P4).
- `channelContext(base: AppContext, exec: ExecBackend, opts: { role: SessionRole; autonomy?: () => AutonomyPolicy })` — P1 Task 2 (`role`), P2 Task 7 (`autonomy`) (P7).
- `chatRole(chatKey, pairing): Promise<SessionRole>` in `src/gateway/policy.ts` — P1 Task 2; P7 Task 12 maps `heartbeat:` keys to `"scheduled"`.
- `STORE_TOOLS`, `isStoreSave`, `permissionContext(ctx, mode)`, `PermissionContext.role` / `.stores` — P1 Task 3 (P5 Tasks 6, 8).
- Notice event `learned?: boolean`, `savedNotice(tool, input)`, `makeAgent` / `createRuntime` `learn?: boolean` — P1 Task 4 (P6 Tasks 3, 6).
- `ReviewKind "final"`, `FINAL_PROMPT`, `LearningLoop.finish` — P1 Task 6 (P6 Task 8).
- `Extensions.reload()`, `newSessionContext(): Promise<SessionContext>` — P1 Task 7 (P6 Task 6, P7 Task 3).
- `ProjectContexts` (`acquire`, `invalidate`, `closeAll`), `SessionPool.retire()`, the daemon's real `reload()` — P1 Task 8 (P2 Task 12, P3 Task 11, P4, P7 Task 8).
- `ChatSession.command / learned / undoLearned`, `/learned` — P1 Task 9 (P7 Task 4).
- `CronToolOptions.seeAll`, `ownerCronTool(home, opts?)`, `ownerChatKey(pairing)` — P1 Task 10 (P7 Task 8's `cron` factory).
- `SubagentDeps.openTranscript` — P1 Task 11 (P6 Task 5).
- Copy for "channels: none", `gateway install` without a token, empty panels — P1 Task 12 (P7 Task 8 replaces the first two).
- `createCuratorService(opts?)` (`src/gateway/curator-service.ts`) — P1 Task 13 (P5 Task 3, P6 Task 9).

P2:
- `gateway.json chat.allowUnconfined?: boolean`, the only name for the run-unconfined consent — P2 Task 1 (P3, P4).
- `existingInstall(home)` in `src/gateway/config.ts` (approved sender in `gateway/pairing.json`, or `onboarding.json` `dismissedAt`; never `gateway.json` alone) and `ensureChatSettings(home)` — P2 Task 1 (P4 Task 7 calls `ensureChatSettings` from `markStarted`).
- `setAutonomy`, `setChatBackend`, `lowerAutonomy(home, projectId, to)`, `AutonomyError`, `UNCONFINED_CONSENT`, `RAISE_REFUSED`, `Confinement` — P2 Task 1 (P3, P4 Task 6, P7 Task 6).
- `AutonomyPolicy { level; testCommands }`, `PermissionContext.autonomy?: AutonomyPolicy`, `AppContext.autonomy?: () => AutonomyPolicy` — P2 Task 4 (P6 Task 5's `capAutonomy` lowers `autonomy.level`).
- `ConfinementPaths` (`readCarveOut` becomes `readCarveOuts: string[]` in P7 Task 10; `ownFiles` added in P5 Task 8), `confinementPaths`, `sandboxProfile`, `bwrapArgs`, `SECRET_PATHS` — P2 Task 5 (P5, P7).
- `chatBackend(input)` in `src/gateway/chat-exec.ts` (builds the `DockerBackend` and confined backends) — P2 Task 7 (P5 Task 8 `hide`, P7 Task 10).
- `ChatAutonomy`, `/autonomy` — P2 Task 8 (P3 Task 10 routes `/login` beside it).
- `AutonomyLevel`, `AutonomyView`, `AutonomyProjectView` (`src/web/admin/api.ts`) and admin `autonomy.get`, `autonomy.set`, `autonomy.setBackend`, `autonomy.confirmTests`; `autonomyView(home, confinement)` — P2 Task 10 (P3 Tasks 7, 12, 14; P4 Task 6; P6 Task 11).
- `ProjectHosts`, `HelloInfo.project`, RPC `project.select` — P2 Task 12 (P1 Task 8's note).

P3:
- `qrMatrix(text): boolean[][]` in `src/ui/qr.ts` — P3 Task 1 (P3 Task 15, P4).
- `DeviceStore.create(name, via?)`, `verify(key, via?)`, `devicesPath(home)` — P3 Task 2.
- `loginCodesFor(home): LoginCodes`, `loginCodesPath(home)`, `LoginCodes.locked()` — P3 Task 3 (P4 Task 6).
- `AdminCaller`, `AdminContext.gateway.devicesChanged()` — P3 Task 6 (P4 Task 12 fixture, P7 Task 6 `sessionAdmin`).
- `localDashboardUrl(port)`, `dashboardPort(config)`, `dashboardLoginLink(home, port, logins?)` in `src/web/links.ts`; `Status.dashboard / autonomy / telegram` — P3 Task 7 (P4 Tasks 6, 10, 11; P7 Task 1).
- Admin `devices.list`, `devices.revoke`, `devices.revokeAll`, `login.issueCode` — P3 Task 9.
- `remoteUrl(remote)`, `remoteHostHeader(remote)`, `RemoteView`, admin `remote.status / enable / disable` — P3 Task 11 (P4 Task 6).
- `SETTINGS_TABS`, `STATUS_TABS`, `EXTENSIONS_TABS`, `useHashTab`, `redirectHash`, `useNeedsOnboarding` — P3 Task 12 (P4 Task 14; P7 Task 13 appends `"suggestions"` to `SETTINGS_TABS`).
- `QrCode({ text, label })` (`web/src/components/pages/settings/qr-code.tsx`) — P3 Task 15 (P4 Task 14 reuses it).
- Light-only web app: "both themes" means both system color schemes rendering the light app legibly — P3 (P2, P4, P6, P7 screenshot steps).

P4:
- `FilePairing.approveSender(channel, senderId)` (not on `Pairing`) — P4 Task 1.
- `OwnerClaimStore`, `candidateFrom`, `TelegramAdapterOptions.ownerClaim` — P4 Tasks 2, 3.
- `saveIdentity(home, patch)` — P4 Task 5 (P5 Task 4).
- `onboarding.json`: `startedAt`, `reminded`, `autonomyChosen`, `dismissedAt`; `updateOnboardingFlags` — P4 Tasks 6, 7 (P2 Task 1 reads `dismissedAt`; P7 Task 11 reads `reminded`).
- `STEP_ORDER`, `skipStep`, `markStarted` (calls P2's `ensureChatSettings`) — P4 Task 7.
- `openSkippedSteps(deps, known?)`, `markReminded(home, id)`, `REMINDABLE`, `REMINDER_TOPICS`, `Status.setup` — P4 Task 11 (P7 Task 11 builds its `setup:*` signals on them and replaces `takeSetupReminder`'s context).
- Admin `onboard.*` methods, `ChatSettingsView`, `UnconfinedNotConfirmedError` — P4 Tasks 6, 12.

P5:
- `resolveLayoutPath`, `legacyToCurrent`, `workspaceOwnPaths`, `LegacyItem`, `layout.json` — P5 Task 1 (P6, P7).
- `NotesStore.dir`, `NotesTarget "lessons"`, `MEMORY_LIMITS.lessons`, `AGENTS_TEMPLATE`, `sectionEntries`, `withSectionEntries`, `stripAgentSections` — P5 Tasks 2, 5 (P6 Task 4, P7 Tasks 12, 14).
- `SkillManageOptions.dir` (absolute; replaces `folder`) — P5 Task 3 (P6 Task 5, P7 Task 15).
- `BOOTSTRAP_TEXT`, `bootstrapPending` (needs `workspace/BOOTSTRAP.md`) — P5 Task 4 (P4's identity step; `tcode onboard` runs `ensureHomeLayout` first, P5 Task 11).
- `legacyNotesDir(home, cwd)` (replaces `dailyNotesDir`), `formatJournalEntry`, `parseJournal`, `appendJournalText` — P5 Task 6 (P1's `permissionContext`).
- `PermissionContext.ownFiles`, `DockerBackendOptions.hide` — P5 Task 8.
- `ensureHomeLayout(home, opts)` — P5 Task 10.

P6:
- `HUB_ONLY_TOOLS` (`src/agent/subagent.ts`): `Agent`, `AgentManage`, `Cron` and any tool that messages the user; `filterTools` drops it for every subagent and specialist — P6 Task 5 (P7 Tasks 6, 8, 11 add `TroposSetup`, `SwitchProject`, `Suggestion`).
- `SPECIALIST_BLOCKED_TOOLS` (= `HUB_ONLY_TOOLS` + `Identity`, `SessionSearch`), `capAutonomy(ctx, level)` — P6 Task 5.
- `Specialist.paused?: boolean`, `AgentDefinition.source "specialist"`, `loadAllAgents`, `specialistRoster` — P6 Task 1.
- `NotesStore` options `dir` / `targets`, `DailyNotesOptions.dir` — P6 Task 4.
- `recordRun`, `readRuns` (`learning/delegations.jsonl`) — P6 Task 5.
- `contextExtras` option `specialists` — P6 Task 6.
- `Agent.runDirect`, `Runtime.directCall` — P6 Task 10 (P7 Task 3 seals secrets before it).
- Admin `agents.*`, `SpecialistView`, `AgentRoster` — P6 Task 11.

P7:
- `dashboardLink(config, route?)` (built on P3's `localDashboardUrl`) — P7 Task 1.
- `AppContext.secrets`, `Runtime.sealSecrets`, `SecretVault` — P7 Task 3.
- `LedgerKind "setup"`, `recordSetupChange`, `requestGatewayReload`, `RELOAD_SIGNAL`, `onReloadSignal` — P7 Task 4.
- `lowerSetupAutonomy(home, to, projectId?)` (built on P2's `lowerAutonomy`) — P7 Task 6.
- Tools `SwitchProject`, `Suggestion`; `chatSessionTools` — P7 Tasks 8, 11.
- `worktreesDir(home)` in `src/paths.ts`, `readCarveOuts` — P7 Tasks 9, 10.
- `AppContext.contextBlocks`, `AppContext.testWatch` — P7 Tasks 10, 11.
- `NotesTarget "heartbeat"`, `HEARTBEAT_CHAT_KEY`, `heartbeatContext` — P7 Task 12.

## Conventions for every plan

TypeScript on Bun, zod, colocated `*.test.ts`, TDD (failing test first), short comments that say why, match nearby
code. No new runtime dependency without a line in the plan saying why. Each task ends green on its own tests plus
`bun run typecheck`. Per the owner's rule, nothing is committed unless the owner asks; tasks end with "stage" instead of
"commit" (`git add` of the task's files).
