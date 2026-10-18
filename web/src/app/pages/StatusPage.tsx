// web/src/app/pages/StatusPage.tsx — the control plane's overview: what is installed and running (status.get) and a
// health section from the doctor (doctor.run) whose findings can be fixed in place.
import { useMemo, useState, type ReactNode } from "react";

import type { DoctorFinding, DoctorReport, FindingLevel, StatusSnapshot } from "@core/web/admin/api";

import { PageFrame } from "@/app/layout/PageFrame";
import { LogsPanel } from "@/app/pages/LogsPage";
import { UsagePanel } from "@/app/pages/UsagePage";
import { hrefFor, STATUS_TABS } from "@/app/routes";
import { useHashTab } from "@/app/use-hash-tab";
import { AdminCard, ResultNote, useSectionActions } from "@/components/admin/admin-parts";
import { useAdminResource } from "@/components/admin/use-admin-resource";
import { Tabs, type TabItem } from "@/components/interior/tabs";
import { PageActions } from "@/components/pages/page-actions";
import { PanelHead, PanelStack } from "@/components/pages/panel-head";
import { ResourceView } from "@/components/pages/resource-view";
import type { Resource } from "@/components/pages/use-rpc-resource";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Icon, type IconName } from "@/components/ui/icon";
import { formatDateTime } from "@/lib/ops-format";
import { useAdmin } from "@/lib/store";
import { cn } from "@/lib/utils";

const LEVEL: Record<FindingLevel, { label: string; icon: IconName; text: string; badge: BadgeTone }> = {
  ok: { label: "OK", icon: "circle-check", text: "text-ok", badge: "ok" },
  info: { label: "Info", icon: "info", text: "text-ink-3", badge: "neutral" },
  warn: { label: "Warning", icon: "triangle-alert", text: "text-warn", badge: "warn" },
  error: { label: "Error", icon: "circle-alert", text: "text-error", badge: "error" },
};

function LevelMark({ level }: { level: FindingLevel }) {
  const l = LEVEL[level];
  return (
    <span className={cn("mt-px inline-flex shrink-0", l.text)}>
      <Icon name={l.icon} size="md" />
      <span className="sr-only">{l.label}: </span>
    </span>
  );
}

function summaryText(report: DoctorReport): string {
  const s = report.summary;
  const parts = [`${s.ok} ok`, `${s.info} info`, `${s.warn} ${s.warn === 1 ? "warning" : "warnings"}`, `${s.error} ${s.error === 1 ? "error" : "errors"}`];
  if (s.fixed > 0) parts.push(`${s.fixed} fixed`);
  return parts.join(", ");
}

/** Findings grouped by area, in the order the areas first appear. */
export function groupByArea(findings: DoctorFinding[]): Array<{ area: string; findings: DoctorFinding[] }> {
  const groups = new Map<string, DoctorFinding[]>();
  for (const finding of findings) {
    const list = groups.get(finding.area);
    if (list) list.push(finding);
    else groups.set(finding.area, [finding]);
  }
  return [...groups].map(([area, list]) => ({ area, findings: list }));
}

// ---------- overview ----------

type TileProps = {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: BadgeTone;
  /** A route below "#/", for example "settings/service". */
  href?: string;
  linkLabel?: string;
  wide?: boolean;
};

function Tile({ label, value, sub, tone, href, linkLabel, wide }: TileProps) {
  return (
    <div className={cn("relative flex flex-col gap-1.5 rounded-[14px] border border-rule bg-surface p-4 shadow-card transition-[border-color] duration-150 focus-within:border-accent", href && "hover:border-rule-strong", wide ? "sm:col-span-2" : "")}>
      <dt className="type-meta flex items-center gap-2 text-ink-3">
        {tone ? <span aria-hidden className={cn("size-1.5 rounded-full", tone === "ok" && "bg-ok", tone === "warn" && "bg-warn", tone === "error" && "bg-error", tone === "off" && "bg-ink-4", tone === "neutral" && "bg-ink-3")} /> : null}
        {href ? (
          <a href={`#/${href}`} aria-label={linkLabel ?? `Open ${label}`} className="rounded-[4px] outline-none after:absolute after:inset-0 after:rounded-[14px] after:content-[''] focus-visible:after:shadow-focus">
            {label}
          </a>
        ) : (
          label
        )}
      </dt>
      <dd className="text-[20px] font-medium leading-tight tracking-[-0.012em] text-ink">{value}</dd>
      {sub ? <dd className="min-w-0 text-[12.5px] leading-snug text-ink-2">{sub}</dd> : null}
    </div>
  );
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function Overview({ status }: { status: StatusSnapshot }) {
  const connected = status.providers.filter((p) => p.connected);
  const service = status.service;
  const serviceValue = service.manager === "none" ? "Unsupported" : !service.installed ? "Not installed" : service.running ? "Running" : "Stopped";
  const serviceTone: BadgeTone = service.manager === "none" || !service.installed ? "off" : service.running ? "ok" : "warn";
  return (
    <div className="flex flex-col gap-4">
      <Card className="flex flex-wrap items-center gap-x-6 gap-y-3" aria-label="Version">
        <div className="min-w-0">
          <p className="type-meta text-ink-3">Tropos Code</p>
          <p className="mt-1 font-mono text-[24px] font-medium leading-none tracking-[-0.02em] text-ink">v{status.version.replace(/^v/, "")}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="neutral">{status.channel} channel</Badge>
          {status.updateAvailable ? (
            <a href={`#/settings/service`} className="rounded-full outline-none focus-visible:shadow-focus">
              <Badge tone="accent">Update available: v{status.updateAvailable.replace(/^v/, "")}</Badge>
            </a>
          ) : (
            <Badge tone="ok">Up to date</Badge>
          )}
        </div>
        <a
          href="#/settings/service"
          className="ml-auto inline-flex h-8 items-center gap-1.5 rounded-[8px] px-2 text-[13px] font-medium text-accent-ink outline-none transition-colors duration-150 hover:bg-accent-wash focus-visible:shadow-focus"
        >
          Service &amp; updates
          <Icon name="arrow-right" size="sm" />
        </a>
      </Card>
      <dl aria-label="Overview" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Tile
          wide
          label="Service"
          href="settings/service"
          tone={serviceTone}
          value={serviceValue}
          sub={service.manager === "none" ? "No service manager on this system." : `${service.manager}${service.pid ? ` · pid ${service.pid}` : ""}${service.installed ? " · starts at login" : ""}`}
        />
        <Tile
          wide
          label="Gateway"
          tone={status.gateway.running ? "ok" : "off"}
          value={status.gateway.running ? "Running" : "Not running"}
          sub={
            status.gateway.running
              ? `${status.gateway.pid ? `pid ${status.gateway.pid} · ` : ""}since ${formatDateTime(status.gateway.startedAt)}${status.gateway.webPort ? ` · web on port ${status.gateway.webPort}` : ""}`
              : "Start it from Settings, or run tcode gateway."
          }
        />
        <Tile label="Telegram" href="settings/channels" tone={status.gateway.telegram ? "ok" : "off"} value={status.gateway.telegram ? "Connected" : "Off"} sub={status.gateway.telegram ? "The bot is polling." : "No bot configured."} />
        <Tile label="Docker" href="settings/advanced" tone={status.docker.ok ? "ok" : "warn"} value={status.docker.ok ? "Ready" : "Problem"} sub={status.docker.ok ? "Sandbox can run." : (status.docker.problem ?? "Docker is not reachable.")} />
        <Tile label="Projects" href="projects" value={status.projects.count} sub={`default: ${status.projects.defaultId}`} />
        <Tile
          label="Providers"
          href="settings/models"
          linkLabel="Open provider settings"
          tone={connected.length > 0 ? "ok" : "warn"}
          value={`${connected.length} of ${status.providers.length}`}
          sub={connected.length > 0 ? connected.map((p) => p.name).join(", ") : "No provider connected."}
        />
        <Tile wide label="Paired senders" href="settings/channels" value={status.pairedSenders} sub={status.pairedSenders === 0 ? "Nobody can message the bot yet." : `${plural(status.pairedSenders, "person", "people")} can talk to it.`} />
        <Tile wide label="Cron jobs" href="cron" value={status.cronJobs} sub={status.cronJobs === 0 ? "Nothing scheduled." : `${plural(status.cronJobs, "scheduled job")}.`} />
      </dl>
    </div>
  );
}

function OnboardingCard() {
  return (
    <Card className="flex flex-wrap items-center gap-x-5 gap-y-3 border-accent/25 bg-accent-wash" aria-label="Finish setup">
      <span aria-hidden className="grid size-10 shrink-0 place-items-center rounded-[12px] border border-accent/20 bg-surface text-accent-ink shadow-card">
        <Icon name="rocket" size="lg" />
      </span>
      <div className="min-w-0 flex-1 basis-60">
        <p className="text-[15px] font-medium text-ink">Finish setting up Tropos</p>
        <p className="mt-0.5 text-[13px] leading-relaxed text-ink-2">Connect a provider and walk through the first-run checks. It takes a couple of minutes.</p>
      </div>
      <a
        href={hrefFor("setup")}
        className="inline-flex h-10 items-center gap-2 rounded-[10px] border border-accent-strong bg-accent-strong px-3.5 text-[14px] font-medium text-white outline-none transition-[background-color,box-shadow] duration-150 hover:bg-accent-strong/90 focus-visible:shadow-focus active:translate-y-px"
      >
        Open setup
        <Icon name="arrow-right" size="md" />
      </a>
    </Card>
  );
}

// ---------- health ----------

function FindingRow({ finding, busy, locked, onFix }: { finding: DoctorFinding; busy: boolean; locked: boolean; onFix: () => void }) {
  return (
    <li className="flex items-start gap-3 px-4 py-3 sm:px-5">
      <LevelMark level={finding.level} />
      <div className="min-w-0 flex-1">
        <p className="text-[13.5px] leading-snug text-ink">{finding.message}</p>
        {finding.detail ? <p className="mt-1 whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed text-ink-2">{finding.detail}</p> : null}
      </div>
      {finding.fixed ? (
        <Badge tone="ok">Fixed</Badge>
      ) : finding.fixable ? (
        <Button variant="secondary" size="sm" icon="zap" disabled={locked} onClick={onFix} aria-label={`Fix: ${finding.message}`}>
          {busy ? "Fixing…" : "Fix"}
        </Button>
      ) : null}
    </li>
  );
}

function Health({ initial, onChanged }: { initial: DoctorReport; onChanged: () => void }) {
  const admin = useAdmin();
  // A report from a manual run replaces the loaded one until the page's Refresh loads a newer one.
  const [local, setLocal] = useState<{ base: DoctorReport; report: DoctorReport } | null>(null);
  const setReport = (report: DoctorReport) => setLocal({ base: initial, report });
  const actions = useSectionActions();
  const shown = local && local.base === initial ? local.report : initial;
  const groups = useMemo(() => groupByArea(shown.findings), [shown]);
  const locked = actions.busy !== null;

  const runChecks = (id: string, params?: { fix?: boolean; deep?: boolean }) =>
    void actions.run(id, async () => {
      const next = await admin("doctor.run", params);
      setReport(next);
      onChanged();
      return { tone: next.summary.error > 0 ? "error" : next.summary.warn > 0 ? "info" : "ok", message: `Checks finished: ${summaryText(next)}.` };
    });

  const fix = (finding: DoctorFinding) =>
    void actions.run(`fix:${finding.id}`, async () => {
      const outcome = await admin("doctor.fix", { id: finding.id });
      try {
        setReport(await admin("doctor.run"));
        onChanged();
      } catch {
        // The fix itself went through; the list refreshes on the next run.
      }
      return { tone: outcome.ok ? "ok" : "error", message: outcome.message };
    });

  const fixable = shown.findings.some((f) => f.fixable && !f.fixed);

  return (
    <AdminCard
      title="Health"
      icon="stethoscope"
      note={summaryText(shown)}
      actions={
        <>
          <Button variant="secondary" size="sm" icon="play" disabled={locked} onClick={() => runChecks("checks")}>
            {actions.busy === "checks" ? "Running…" : "Run checks"}
          </Button>
          <Button variant="secondary" size="sm" icon="globe" disabled={locked} onClick={() => runChecks("deep", { deep: true })} title="Also checks the things that need the network">
            {actions.busy === "deep" ? "Running…" : "Run deep checks"}
          </Button>
          <Button variant="primary" size="sm" icon="zap" disabled={locked} onClick={() => runChecks("fixall", { fix: true })} title="Applies the fixes that are safe to apply without asking">
            {actions.busy === "fixall" ? "Fixing…" : "Fix all safe issues"}
          </Button>
        </>
      }
      bodyClassName="p-0"
    >
      <div className="px-4 pt-3 sm:px-5">
        <ResultNote result={actions.result} className="mb-3 mt-0" />
      </div>
      {groups.length === 0 ? (
        <p className="px-5 py-8 text-center text-[13.5px] text-ink-2">No findings. Run the checks to look again.</p>
      ) : (
        <div className="divide-y divide-rule">
          {groups.map((group) => (
            <section key={group.area} aria-label={group.area}>
              <h3 className="type-meta flex items-center gap-2 bg-paper/70 px-4 py-2 text-ink-3 sm:px-5">
                {group.area}
                <span className="font-mono normal-case tracking-normal">{group.findings.length}</span>
              </h3>
              <ul className="divide-y divide-rule">
                {group.findings.map((finding) => (
                  <FindingRow key={finding.id} finding={finding} busy={actions.busy === `fix:${finding.id}`} locked={locked} onFix={() => fix(finding)} />
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
      {!fixable && groups.length > 0 ? <p className="border-t border-rule px-5 py-2.5 text-[12.5px] text-ink-3">Nothing here can be fixed automatically.</p> : null}
    </AdminCard>
  );
}

export function HealthPanel() {
  const status = useAdminResource("status.get");
  const doctor = useAdminResource("doctor.run");
  const refreshAll = () => {
    status.refresh();
    doctor.refresh();
  };
  // PageActions drives one resource; a combined one makes its spinner and Refresh cover both.
  const combined: Resource<unknown> = {
    status: status.status === "loading" || doctor.status === "loading" ? "loading" : status.status === "refreshing" || doctor.status === "refreshing" ? "refreshing" : "ready",
    data: undefined,
    error: null,
    refresh: refreshAll,
  };
  return (
    <PanelStack>
      <PanelHead description="What is installed and running, and whether anything needs attention." actions={<PageActions resource={combined} noun="status" />} />
      <ResourceView resource={status} noun="status">
        {(snapshot) => (
          <>
            {snapshot.needsOnboarding ? <OnboardingCard /> : null}
            <Overview status={snapshot} />
          </>
        )}
      </ResourceView>
      <ResourceView resource={doctor} noun="health checks">
        {(report) => <Health initial={report} onChanged={status.refresh} />}
      </ResourceView>
    </PanelStack>
  );
}

const STATUS_ITEMS: TabItem[] = [
  { value: "health", label: "Health" },
  { value: "logs", label: "Logs" },
  { value: "usage", label: "Usage" },
];

export function StatusPage() {
  const [tab, setTab] = useHashTab("status", STATUS_TABS, "health");
  return (
    <PageFrame title="Status" eyebrow="Control" description="What is running, what it says, and what it costs.">
      <Tabs
        items={STATUS_ITEMS}
        value={tab}
        onValueChange={(next) => setTab(next as (typeof STATUS_TABS)[number])}
        label="Status sections"
        panelClassName="p-4 sm:p-6"
        renderPanel={(value) => (value === "logs" ? <LogsPanel /> : value === "usage" ? <UsagePanel /> : <HealthPanel />)}
      />
    </PageFrame>
  );
}
