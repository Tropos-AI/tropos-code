// src/web/admin/api.ts — the host-level admin API of `tcode web` and the gateway (spec §2.7). No Node imports: the
// browser app imports this too. Each area's methods live in their own interface so the pieces that implement and use
// them can be written side by side; AdminMap is their union. Secrets are write-only: nothing here returns a key.

// ---------- status ----------

export interface ServiceInfo {
  manager: "launchd" | "systemd" | "none";
  installed: boolean;
  running: boolean;
  pid?: number;
}

export interface StatusSnapshot {
  version: string;
  channel: "latest" | "stable";
  /** Set when a newer release is known from the last check (no network call is made by status.get). */
  updateAvailable?: string;
  service: ServiceInfo;
  gateway: { running: boolean; pid?: number; startedAt?: string; telegram: boolean; webPort?: number };
  providers: { id: string; name: string; connected: boolean }[];
  docker: { ok: boolean; problem?: string };
  projects: { count: number; defaultId: string };
  pairedSenders: number;
  cronJobs: number;
  /** Counts from a read-only doctor run. */
  health: { ok: number; warn: number; error: number };
  /** True until the owner has a provider connected and has seen the setup wizard through. */
  needsOnboarding: boolean;
}

export interface StatusAdmin {
  "status.get": { params: undefined; result: StatusSnapshot };
}

// ---------- doctor ----------

export type FindingLevel = "ok" | "info" | "warn" | "error";

export interface DoctorFinding {
  id: string;
  area: string;
  level: FindingLevel;
  message: string;
  detail?: string;
  fixable?: boolean;
  fixed?: boolean;
}

export interface DoctorReport {
  findings: DoctorFinding[];
  summary: { ok: number; info: number; warn: number; error: number; fixed: number };
}

export interface DoctorAdmin {
  /** `fix` applies the safe fixes; `deep` adds checks that use the network. */
  "doctor.run": { params: { fix?: boolean; deep?: boolean; only?: string } | undefined; result: DoctorReport };
  /** Applies the fix of one finding, whether or not it is "safe". */
  "doctor.fix": { params: { id: string }; result: { ok: boolean; message: string } };
}

// ---------- config ----------

export type ConfigFile = "settings" | "gateway";

export interface ConfigView {
  file: ConfigFile;
  path: string;
  /** The current values with secrets replaced by "••••" (and `…Set` flags where useful). */
  value: Record<string, unknown>;
  /** JSON Schema of the file, to render the form. */
  schema: Record<string, unknown>;
  /** When the file was last written (ISO), if it exists. */
  modifiedAt?: string;
}

export interface ConfigAdmin {
  "config.get": { params: { file: ConfigFile }; result: ConfigView };
  /**
   * Sets one dotted path (`permissions.deny`, `sandbox.network`); `value: null` unsets it. Validated before writing.
   * A value equal to the mask "••••" means "keep what is stored" (the form and the raw editor send it back for secrets).
   */
  "config.set": { params: { file: ConfigFile; path: string; value: unknown }; result: ConfigView };
  /** The file as text, redacted, for the raw editor. */
  "config.raw": { params: { file: ConfigFile }; result: { text: string; path: string } };
  /**
   * Replaces the file with edited text from the raw editor; refuses invalid JSON/values with the reason (include
   * "line N" in the message when the position is known). Any secret still shown as the mask "••••" keeps its stored value.
   */
  "config.apply": { params: { file: ConfigFile; text: string }; result: ConfigView };
}

// ---------- channels (Telegram) ----------

export interface TelegramInfo {
  configured: boolean;
  /** Where the token comes from; the token itself is never returned. */
  source: "env" | "file" | null;
  bot?: { username: string; name: string };
}

export interface ChannelsAdmin {
  "channels.get": { params: undefined; result: { telegram: TelegramInfo } };
  /** Verifies the token with Telegram (getMe) and saves it to gateway.json. */
  "channels.telegram.set": { params: { token: string }; result: TelegramInfo };
  "channels.telegram.clear": { params: undefined; result: TelegramInfo };
  /** Checks the saved token against Telegram without changing anything. */
  "channels.telegram.test": { params: undefined; result: { ok: boolean; bot?: { username: string; name: string }; error?: string } };
}

// ---------- pairing ----------

export interface PairingView {
  approved: { channel: string; senderId: string; approvedAt: number }[];
  /** Codes handed out and not yet approved: the code itself is not stored, only when it was asked for and when it lapses. */
  pending: { channel: string; requestedAt: number; expiresAt: number }[];
  owner?: { channel: string; senderId: string };
}

export interface PairingAdmin {
  "pairing.list": { params: undefined; result: PairingView };
  /** The owner enters the code the person was shown in the chat. */
  "pairing.approve": { params: { channel: string; code: string }; result: { senderId: string } };
  "pairing.revoke": { params: { channel: string; senderId: string }; result: { removed: boolean } };
  /** Makes an approved sender the owner. */
  "pairing.setOwner": { params: { channel: string; senderId: string }; result: PairingView };
}

// ---------- projects ----------

export interface ProjectView {
  id: string;
  name: string;
  path: string;
  builtin?: boolean;
  isDefault: boolean;
  gitRepo: boolean;
}

export interface BrowseEntry {
  name: string;
  path: string;
  isGitRepo: boolean;
}

export interface ProjectsAdmin {
  "projects.list": { params: undefined; result: ProjectView[] };
  "projects.add": { params: { path: string; name?: string }; result: ProjectView };
  "projects.remove": { params: { id: string }; result: { removed: boolean } };
  "projects.setDefault": { params: { id: string }; result: ProjectView[] };
  /** Lists sub-directories for the folder picker. Starts in the home directory; never lists files. */
  "projects.browse": { params: { path?: string } | undefined; result: { path: string; parent: string | null; entries: BrowseEntry[] } };
}

// ---------- service (run at login) and sandbox ----------

export interface ServiceAdmin {
  "service.status": { params: undefined; result: ServiceInfo & { unitPath?: string; logPath: string } };
  "service.install": { params: undefined; result: ServiceInfo & { unitPath?: string } };
  "service.uninstall": { params: undefined; result: { removed: boolean } };
  "service.start": { params: undefined; result: ServiceInfo };
  "service.stop": { params: undefined; result: ServiceInfo };
  "service.restart": { params: undefined; result: ServiceInfo };
  /** Docker reachable and the sandbox image present; `pull` fetches the image. */
  "sandbox.check": { params: { pull?: boolean } | undefined; result: { ok: boolean; docker: boolean; image: string; imagePresent: boolean; problem?: string } };
}

// ---------- logs ----------

export type LogName = "gateway" | "install" | "update";

export interface LogsAdmin {
  "logs.tail": { params: { name: LogName; lines?: number }; result: { path: string; exists: boolean; lines: string[]; offset: number } };
  /** Everything written after `offset` (from a previous tail/since), for a live view by polling. */
  "logs.since": { params: { name: LogName; offset: number }; result: { chunk: string; offset: number; truncated: boolean } };
}

// ---------- usage ----------

export interface UsageDay {
  date: string;
  sessions: number;
  inputTokens: number;
  outputTokens: number;
  /** Undefined when a model without a known price took part. */
  costUsd?: number;
}

export interface UsageSummary {
  days: number;
  totals: { sessions: number; turns: number; inputTokens: number; outputTokens: number; costUsd?: number };
  byDay: UsageDay[];
  byModel: { model: string; inputTokens: number; outputTokens: number; costUsd?: number }[];
  topSessions: { id: string; title: string; project: string; updatedAt: string; costUsd?: number; tokens: number }[];
}

export interface UsageAdmin {
  "usage.summary": { params: { days: 7 | 30 | 90 }; result: UsageSummary };
}

// ---------- update ----------

export interface UpdateStatus {
  current: string;
  channel: "latest" | "stable";
  latest?: string;
  available: boolean;
  checkedAt?: string;
  autoUpdates: boolean;
  /** Set while an update is being installed. */
  running?: boolean;
}

export interface UpdateAdmin {
  "update.status": { params: undefined; result: UpdateStatus };
  /** Asks the release channel (network). */
  "update.check": { params: undefined; result: UpdateStatus };
  /** Installs the newest release of the channel; the new version runs after a restart. */
  "update.run": { params: undefined; result: { ok: boolean; from: string; to?: string; message: string } };
  "update.setChannel": { params: { channel: "latest" | "stable" }; result: UpdateStatus };
  "update.setAuto": { params: { enabled: boolean }; result: UpdateStatus };
}

// ---------- backup ----------

export interface BackupInfo {
  name: string;
  path: string;
  size: number;
  createdAt: string;
  secrets: boolean;
  sessions: boolean;
}

export interface BackupAdmin {
  "backup.list": { params: undefined; result: BackupInfo[] };
  "backup.create": { params: { quick?: boolean; sessions?: boolean; secrets?: boolean } | undefined; result: BackupInfo };
  "backup.verify": { params: { name: string }; result: { ok: boolean; problems: string[] } };
  /**
   * Always takes a safety backup of the current state first. `dryRun` only reports what would change. A backup is only
   * as trustworthy as whoever made it: restoring one replaces files that can run code or let people in (hooks, MCP
   * servers, env, plugins, skills, the gateway's pairing list and scheduled jobs). Those are returned as `risky` (also
   * by a dry run), and a real restore that includes any is refused unless `trustCode` is true.
   */
  "backup.restore": {
    params: { name: string; dryRun?: boolean; trustCode?: boolean };
    result: { restored: string[]; safetyBackup?: string; risky: { path: string; why: string }[] };
  };
  "backup.delete": { params: { name: string }; result: { removed: boolean } };
}

// ---------- cron ----------

export type CronScheduleView =
  | { kind: "cron"; expr: string; tz?: string }
  | { kind: "every"; ms: number }
  | { kind: "at"; at: string };

export interface CronJobView {
  id: string;
  name: string;
  schedule: CronScheduleView;
  /** A readable form of the schedule ("every day at 09:00"). */
  scheduleText: string;
  prompt: string;
  project: string;
  deliver: string;
  enabled: boolean;
  nextRunAt?: string;
  lastRunAt?: string;
  lastStatus?: string;
  createdBy: "user" | "agent";
}

export interface CronRunView {
  runId: string;
  startedAt: string;
  endedAt?: string;
  status: string;
  summary: string;
  error?: string;
}

export interface CronAdmin {
  "cron.list": { params: undefined; result: CronJobView[] };
  /** `schedule` is a structured schedule or text such as "every 30m" / "0 9 * * 1-5". */
  "cron.add": { params: { name: string; schedule: CronScheduleView | string; prompt: string; project?: string; deliver?: string; tz?: string }; result: CronJobView };
  "cron.update": { params: { id: string; patch: Partial<{ name: string; schedule: CronScheduleView | string; prompt: string; project: string; deliver: string; tz: string }> }; result: CronJobView };
  "cron.remove": { params: { id: string }; result: { removed: boolean } };
  "cron.setEnabled": { params: { id: string; enabled: boolean }; result: CronJobView };
  /** Runs the job now through the running gateway; fails with a clear message when the gateway is not running. */
  "cron.runNow": { params: { id: string }; result: { started: boolean } };
  "cron.runs": { params: { id: string; limit?: number }; result: CronRunView[] };
}

// ---------- MCP servers and plugins ----------

export interface McpServerView {
  name: string;
  type: "stdio" | "http" | "sse";
  /** The command line or URL (arguments are shown, environment values are not). */
  target: string;
  state: "connected" | "failed" | "disabled" | "unknown";
  tools?: number;
  error?: string;
}

export interface McpServerInput {
  type: "stdio" | "http" | "sse";
  command?: string;
  args?: string[];
  url?: string;
  /** Write-only. */
  env?: Record<string, string>;
  headers?: Record<string, string>;
}

export interface ExtensionsAdmin {
  "mcp.list": { params: undefined; result: McpServerView[] };
  "mcp.add": { params: { name: string; server: McpServerInput }; result: McpServerView[] };
  "mcp.remove": { params: { name: string }; result: McpServerView[] };
  /** Starts the server briefly and lists its tools, to show a bad command before it is saved. */
  "mcp.test": { params: { server: McpServerInput }; result: { ok: boolean; tools: string[]; error?: string } };
  "plugins.setEnabled": { params: { name: string; enabled: boolean }; result: { name: string; enabled: boolean } };
}

// ---------- onboarding ----------

export type OnboardStepId = "provider" | "model" | "telegram" | "pairing" | "sandbox" | "service" | "health";

export interface OnboardStep {
  id: OnboardStepId;
  title: string;
  status: "done" | "todo" | "skipped" | "warn" | "error";
  optional: boolean;
  detail?: string;
}

/** Someone who wrote to the bot while setup listened: shown on the computer so the owner can say "that's me". */
export interface OwnerCandidateView {
  senderId: string;
  chatId: number;
  name: string;
  username?: string;
  at: number;
}

export interface OnboardState {
  steps: OnboardStep[];
  /** Every required step done. */
  complete: boolean;
  /** The owner finished or dismissed the wizard. */
  dismissed: boolean;
}

export interface RepoCandidateView {
  path: string;
  name: string;
  /** ms since epoch of the newest git activity. */
  touchedAt: number;
  /** Touched in the last 30 days. */
  recent: boolean;
  registered: boolean;
}

export interface OnboardAdmin {
  "onboard.state": { params: undefined; result: OnboardState };
  /** Checks a key before it is saved: a real call to the provider. The key is not stored by this method. */
  "onboard.validateKey": { params: { provider: string; key: string }; result: { ok: boolean; models: string[]; error?: string } };
  /** Marks the wizard finished (or dismissed) so it stops opening by itself. */
  "onboard.finish": { params: { skipped?: OnboardStepId[] } | undefined; result: OnboardState };
  "onboard.reopen": { params: undefined; result: OnboardState };
}

// ---------- autonomy (how freely chats act) ----------

export type AutonomyLevel = "ask" | "balanced" | "autonomous"; // = Autonomy in src/gateway/autonomy.ts

export interface AutonomyProjectView {
  id: string;
  name: string;
  builtin?: boolean;
  /** The project's own level; absent when it follows the global one. */
  level?: AutonomyLevel;
  /** What an owner chat really runs at (unconfined without consent stays at ask). */
  effective: AutonomyLevel;
  testCommands: string[];
  detectedTests: string[];
}

export interface AutonomyView {
  level: AutonomyLevel;
  backend: "host" | "docker";
  confinement: "sandbox-exec" | "bwrap" | null;
  unconfinedAccepted: boolean;
  /** Host commands run with no confinement, with consent, at a level above ask. */
  unconfined: boolean;
  projects: AutonomyProjectView[];
}

export interface AutonomyAdmin {
  "autonomy.get": { params: undefined; result: AutonomyView };
  /** No projectId: the global level. With one: that project's level; null clears it. */
  "autonomy.set": { params: { level: AutonomyLevel | null; projectId?: string; acceptUnconfined?: boolean }; result: AutonomyView };
  "autonomy.setBackend": { params: { backend: "host" | "docker"; acceptUnconfined?: boolean }; result: AutonomyView };
  /** Pins detected test commands for a project; [] unpins. */
  "autonomy.confirmTests": { params: { projectId: string; commands: string[] }; result: AutonomyView };
}

export interface DeviceView {
  id: string;
  name: string;
  createdAt: number;
  lastSeen: number;
  via: "local" | "tailscale";
  /** The device that made this call. */
  current: boolean;
}

export interface DevicesAdmin {
  "devices.list": { params: undefined; result: DeviceView[] };
  "devices.revoke": { params: { id: string }; result: { removed: boolean } };
  /** Logs out every device, this one included. */
  "devices.revokeAll": { params: undefined; result: { removed: number } };
  /** A 6-digit code for another browser or a phone. */
  "login.issueCode": { params: undefined; result: { code: string; expiresAt: number } };
}

export interface RemoteView {
  enabled: boolean;
  tailscale: { installed: boolean; running: boolean; dnsName?: string };
  /** The phone address while phone access is on. */
  url?: string;
  /** Guidance or something to know, in plain words. */
  note?: string;
}

export interface RemoteAdmin {
  "remote.status": { params: undefined; result: RemoteView };
  "remote.enable": { params: undefined; result: RemoteView };
  "remote.disable": { params: undefined; result: RemoteView };
}

// ---------- the whole API ----------

export type AdminMap = StatusAdmin &
  DoctorAdmin &
  ConfigAdmin &
  ChannelsAdmin &
  PairingAdmin &
  ProjectsAdmin &
  ServiceAdmin &
  LogsAdmin &
  UsageAdmin &
  UpdateAdmin &
  BackupAdmin &
  CronAdmin &
  ExtensionsAdmin &
  OnboardAdmin &
  AutonomyAdmin &
  DevicesAdmin &
  RemoteAdmin;

export type AdminMethod = keyof AdminMap;

export type AdminParams<M extends AdminMethod> = AdminMap[M]["params"];
export type AdminResult<M extends AdminMethod> = AdminMap[M]["result"];

/** The server answers any method name it does not know with an error, so this list is only for validation. */
export const ADMIN_METHODS: AdminMethod[] = [
  "status.get",
  "doctor.run",
  "doctor.fix",
  "config.get",
  "config.set",
  "config.raw",
  "config.apply",
  "channels.get",
  "channels.telegram.set",
  "channels.telegram.clear",
  "channels.telegram.test",
  "pairing.list",
  "pairing.approve",
  "pairing.revoke",
  "pairing.setOwner",
  "projects.list",
  "projects.add",
  "projects.remove",
  "projects.setDefault",
  "projects.browse",
  "service.status",
  "service.install",
  "service.uninstall",
  "service.start",
  "service.stop",
  "service.restart",
  "sandbox.check",
  "logs.tail",
  "logs.since",
  "usage.summary",
  "update.status",
  "update.check",
  "update.run",
  "update.setChannel",
  "update.setAuto",
  "backup.list",
  "backup.create",
  "backup.verify",
  "backup.restore",
  "backup.delete",
  "cron.list",
  "cron.add",
  "cron.update",
  "cron.remove",
  "cron.setEnabled",
  "cron.runNow",
  "cron.runs",
  "mcp.list",
  "mcp.add",
  "mcp.remove",
  "mcp.test",
  "plugins.setEnabled",
  "onboard.state",
  "onboard.validateKey",
  "onboard.finish",
  "onboard.reopen",
  "autonomy.get",
  "autonomy.set",
  "autonomy.setBackend",
  "autonomy.confirmTests",
  "devices.list",
  "devices.revoke",
  "devices.revokeAll",
  "login.issueCode",
  "remote.status",
  "remote.enable",
  "remote.disable",
];
