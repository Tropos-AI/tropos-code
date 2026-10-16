// web/src/components/setup/host-steps.tsx — the wizard's Telegram, Pairing, Sandbox, Service and Health steps. Each shows
// what its buttons do, keeps the server as the source of truth and never blocks on being optional.
import { useEffect, useRef, useState } from "react";

import type { DoctorFinding, DoctorReport } from "@core/web/admin/api";

import { useRpcResource } from "@/components/pages/use-rpc-resource";
import { LiveRegion, Notice, useAction } from "@/components/setup/admin-ui";
import { ApproveCodeForm, ApprovedList, TelegramTokenForm } from "@/components/setup/channel-forms";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { useAdmin, useAppStore } from "@/lib/store";

function LoadError({ what, message, onRetry }: { what: string; message: string; onRetry: () => void }) {
  return (
    <div className="flex flex-col items-start gap-2">
      <Notice tone="error">
        Couldn't load {what}: {message}
      </Notice>
      <Button size="sm" icon="refresh-cw" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}

function SkipRow({ onSkip, label = "Skip for now" }: { onSkip: () => void; label?: string }) {
  return (
    <div className="flex items-center gap-2 border-t border-rule pt-3">
      <Button variant="ghost" size="sm" icon="skip-forward" onClick={onSkip}>
        {label}
      </Button>
      <span className="text-[12px] text-ink-3">You can come back to this any time.</span>
    </div>
  );
}

export function TelegramStep({ onChanged, onSkip }: { onChanged: () => void; onSkip: () => void }) {
  const admin = useAdmin();
  const channels = useRpcResource("setup:channels", () => admin("channels.get"));
  const [replacing, setReplacing] = useState(false);
  const test = useAction();
  const [tested, setTested] = useState<string | null>(null);

  if (channels.status === "error") return <LoadError what="Telegram" message={channels.error ?? ""} onRetry={channels.refresh} />;
  if (!channels.data) return <p className="text-[13px] text-ink-3">Loading…</p>;
  const { telegram } = channels.data;

  const runTest = async () => {
    setTested(null);
    const result = await test.run(() => admin("channels.telegram.test"));
    if (result) setTested(result.ok ? `Telegram answered${result.bot ? `: @${result.bot.username}` : ""}.` : (result.error ?? "Telegram did not accept the token."));
  };

  const saved = () => {
    setReplacing(false);
    channels.refresh();
    onChanged();
  };

  return (
    <div className="flex flex-col gap-4">
      {telegram.configured && !replacing ? (
        <>
          <p className="flex flex-wrap items-center gap-2 text-[13.5px] text-ink-2">
            <Badge tone="ok">{telegram.bot ? `@${telegram.bot.username}` : "configured"}</Badge>
            {telegram.bot ? <span>{telegram.bot.name}</span> : null}
            <span className="text-ink-3">· token from {telegram.source === "env" ? "your environment" : "gateway.json"}</span>
          </p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" icon="activity" onClick={() => void runTest()} disabled={test.pending}>
              {test.pending ? "Testing…" : "Test connection"}
            </Button>
            {telegram.source !== "env" ? (
              <Button size="sm" icon="key" onClick={() => setReplacing(true)}>
                Replace token
              </Button>
            ) : null}
          </div>
          <LiveRegion>
            {tested ? <Notice tone="info">{tested}</Notice> : null}
            {test.error ? <Notice tone="error">Couldn't test: {test.error}</Notice> : null}
          </LiveRegion>
        </>
      ) : (
        <>
          <ol className="flex list-decimal flex-col gap-1 pl-5 text-[13.5px] leading-relaxed text-ink-2 marker:text-ink-4">
            <li>
              In Telegram, message <strong className="font-medium text-ink">@BotFather</strong> and send <code className="font-mono text-[12.5px] text-ink">/newbot</code>.
            </li>
            <li>Choose a name, then a username that ends in "bot".</li>
            <li>Copy the token it replies with and paste it here.</li>
          </ol>
          <TelegramTokenForm replacing={telegram.configured} onSaved={saved} onCancel={telegram.configured ? () => setReplacing(false) : undefined} />
        </>
      )}
      {!telegram.configured ? <SkipRow onSkip={onSkip} label="Skip Telegram" /> : null}
    </div>
  );
}

export function PairingStep({ telegramReady, onChanged, onSkip }: { telegramReady: boolean; onChanged: () => void; onSkip: () => void }) {
  const admin = useAdmin();
  const pairing = useRpcResource("setup:pairing", () => admin("pairing.list"));

  return (
    <div className="flex flex-col gap-4">
      {!telegramReady ? <Notice tone="info">Add your Telegram bot first. Until then nobody can message it.</Notice> : null}
      <p className="text-[13.5px] leading-relaxed text-ink-2">
        <strong className="font-medium text-ink">Message your bot from your own Telegram account.</strong> It answers with a short code. Enter that code here to let that account in. Nobody is allowed by default.
      </p>
      <ApproveCodeForm
        onApproved={() => {
          pairing.refresh();
          onChanged();
        }}
      />
      <div className="flex flex-col gap-2">
        <h4 className="text-[13px] font-medium text-ink">Approved senders</h4>
        {pairing.status === "error" ? <LoadError what="the access list" message={pairing.error ?? ""} onRetry={pairing.refresh} /> : pairing.data ? <ApprovedList pairing={pairing.data} /> : <p className="text-[13px] text-ink-3">Loading…</p>}
      </div>
      <SkipRow onSkip={onSkip} label="Skip pairing" />
    </div>
  );
}

export function SandboxStep({ onChanged, onSkip }: { onChanged: () => void; onSkip: () => void }) {
  const admin = useAdmin();
  const sandbox = useRpcResource("setup:sandbox", () => admin("sandbox.check"));
  const pull = useAction();
  const [pulled, setPulled] = useState<string | null>(null);

  if (sandbox.status === "error") return <LoadError what="the sandbox check" message={sandbox.error ?? ""} onRetry={sandbox.refresh} />;
  if (!sandbox.data) return <p className="text-[13px] text-ink-3">Checking Docker…</p>;
  const info = sandbox.data;

  const runPull = async () => {
    setPulled(null);
    const result = await pull.run(() => admin("sandbox.check", { pull: true }));
    if (result) {
      setPulled(result.imagePresent ? "The sandbox image is ready." : (result.problem ?? "The image is still missing."));
      sandbox.refresh();
      onChanged();
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <p className="text-[13.5px] leading-relaxed text-ink-2">
        Commands the agent runs for chats (from Telegram, or on a schedule) run inside a <strong className="font-medium text-ink">Docker container</strong>, not on your machine. That is what makes it safe to let a chat run things while you are away.
      </p>
      <ul className="flex flex-col gap-1.5 text-[13.5px]">
        <li className="flex items-center gap-2 text-ink-2">
          <Icon name={info.docker ? "circle-check" : "circle-alert"} size="md" tone={info.docker ? "ok" : "warn"} />
          {info.docker ? "Docker is running." : "Docker isn't reachable."}
        </li>
        <li className="flex items-center gap-2 text-ink-2">
          <Icon name={info.imagePresent ? "circle-check" : "circle-dashed"} size="md" tone={info.imagePresent ? "ok" : "current"} />
          {info.imagePresent ? (
            <>
              The sandbox image <code className="font-mono text-[12px] text-ink">{info.image}</code> is installed.
            </>
          ) : (
            <>
              The sandbox image <code className="font-mono text-[12px] text-ink">{info.image}</code> isn't downloaded yet.
            </>
          )}
        </li>
      </ul>
      {info.problem ? <Notice tone="warn">{info.problem}</Notice> : null}
      <div className="flex flex-wrap items-center gap-2">
        {info.docker && !info.imagePresent ? (
          <Button variant="primary" size="sm" icon="download" onClick={() => void runPull()} disabled={pull.pending}>
            {pull.pending ? "Pulling image…" : "Pull image"}
          </Button>
        ) : null}
        {!info.docker ? (
          <a
            href="https://docs.docker.com/get-docker/"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex h-8 items-center gap-1.5 rounded-[8px] px-2 text-[13px] font-medium text-accent-ink outline-none transition-colors duration-150 hover:bg-accent-wash focus-visible:shadow-focus"
          >
            Get Docker
            <Icon name="external-link" size="sm" />
            <span className="sr-only">(opens in a new tab)</span>
          </a>
        ) : null}
        <Button size="sm" icon="refresh-cw" onClick={sandbox.refresh} disabled={pull.pending}>
          Check again
        </Button>
      </div>
      <p className="text-[12px] leading-relaxed text-ink-3">
        <strong className="font-medium text-ink-2">Pull image</strong> downloads <code className="font-mono">{info.image}</code> with Docker. It can take a minute.
      </p>
      <LiveRegion>
        {pulled ? <Notice tone={pulled.includes("ready") ? "ok" : "warn"}>{pulled}</Notice> : null}
        {pull.error ? <Notice tone="error">Couldn't pull the image: {pull.error}</Notice> : null}
      </LiveRegion>
      {!info.ok ? <SkipRow onSkip={onSkip} label="Skip: chats will not run commands until Docker is available" /> : null}
    </div>
  );
}

export function ServiceStep({ onChanged }: { onChanged: () => void }) {
  const admin = useAdmin();
  const store = useAppStore();
  const service = useRpcResource("setup:service", () => admin("service.status"));
  const install = useAction();
  const uninstall = useAction();

  if (service.status === "error") return <LoadError what="the service status" message={service.error ?? ""} onRetry={service.refresh} />;
  if (!service.data) return <p className="text-[13px] text-ink-3">Loading…</p>;
  const info = service.data;
  const manager = info.manager === "launchd" ? "launchd (macOS)" : info.manager === "systemd" ? "systemd (your user services)" : null;

  const run = async () => {
    const done = await install.run(() => admin("service.install"));
    if (done) {
      store.toast({ tone: "ok", title: "Tropos will run at login" });
      service.refresh();
      onChanged();
    }
  };
  const stop = async () => {
    const done = await uninstall.run(() => admin("service.uninstall"));
    if (done) {
      service.refresh();
      onChanged();
    }
  };

  if (!manager) return <Notice tone="info">This system has no supported service manager, so Tropos can't start itself at login. Run <code className="font-mono text-[12px]">tcode gateway</code> when you need it.</Notice>;

  return (
    <div className="flex flex-col gap-4">
      <p className="text-[13.5px] leading-relaxed text-ink-2">Keep Tropos running in the background so your Telegram bot and scheduled jobs work without opening anything.</p>
      <p className="flex flex-wrap items-center gap-2 text-[13px] text-ink-2">
        <Badge tone={info.installed ? "ok" : "off"}>{info.installed ? "runs at login" : "not set up"}</Badge>
        {info.installed ? <Badge tone={info.running ? "ok" : "warn"}>{info.running ? `running${info.pid ? ` · pid ${info.pid}` : ""}` : "not running"}</Badge> : null}
      </p>
      <div className="flex flex-wrap gap-2">
        {info.installed ? (
          <Button variant="danger" size="sm" icon="power" onClick={() => void stop()} disabled={uninstall.pending}>
            {uninstall.pending ? "Removing…" : "Stop running at login"}
          </Button>
        ) : (
          <Button variant="primary" size="sm" icon="power" onClick={() => void run()} disabled={install.pending}>
            {install.pending ? "Setting up…" : "Run at login"}
          </Button>
        )}
      </div>
      <p className="text-[12px] leading-relaxed text-ink-3">
        {info.installed ? (
          <>
            <strong className="font-medium text-ink-2">Stop running at login</strong> removes the {manager} entry{info.unitPath ? <> at <code className="break-all font-mono">{info.unitPath}</code></> : ""}.
          </>
        ) : (
          <>
            <strong className="font-medium text-ink-2">Run at login</strong> adds a {manager} entry that starts <code className="font-mono">tcode gateway</code> when you log in. Logs go to <code className="break-all font-mono">{info.logPath}</code>.
          </>
        )}
      </p>
      <LiveRegion>
        {install.error ? <Notice tone="error">Couldn't set it up: {install.error}</Notice> : null}
        {uninstall.error ? <Notice tone="error">Couldn't remove it: {uninstall.error}</Notice> : null}
      </LiveRegion>
    </div>
  );
}

const LEVEL: Record<DoctorFinding["level"], { tone: BadgeTone; label: string }> = {
  ok: { tone: "ok", label: "ok" },
  info: { tone: "neutral", label: "info" },
  warn: { tone: "warn", label: "warning" },
  error: { tone: "error", label: "problem" },
};

export function HealthStep({ onChanged }: { onChanged: () => void }) {
  const admin = useAdmin();
  const check = useAction();
  const fix = useAction();
  const [report, setReport] = useState<DoctorReport | null>(null);
  const [fixing, setFixing] = useState<string | null>(null);
  const [fixNote, setFixNote] = useState<string | null>(null);
  const started = useRef(false);

  const run = async (options?: { fix: boolean }) => {
    const next = await check.run(() => admin("doctor.run", options));
    if (next) {
      setReport(next);
      onChanged();
    }
  };

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fixOne = async (finding: DoctorFinding) => {
    setFixing(finding.id);
    setFixNote(null);
    const result = await fix.run(() => admin("doctor.fix", { id: finding.id }));
    setFixing(null);
    if (result) {
      setFixNote(result.message);
      await run();
    }
  };

  const shown = (report?.findings ?? []).filter((f) => f.level !== "ok");
  const okCount = report?.summary.ok ?? 0;

  return (
    <div className="flex flex-col gap-4">
      <p className="text-[13.5px] leading-relaxed text-ink-2">A quick check of everything above, plus your install, permissions and settings files.</p>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" icon="stethoscope" onClick={() => void run()} disabled={check.pending}>
          {check.pending ? "Checking…" : "Run checks"}
        </Button>
        <Button size="sm" icon="zap" onClick={() => void run({ fix: true })} disabled={check.pending || shown.every((f) => !f.fixable)}>
          Fix safe issues
        </Button>
      </div>
      <p className="text-[12px] leading-relaxed text-ink-3">
        <strong className="font-medium text-ink-2">Run checks</strong> only looks. <strong className="font-medium text-ink-2">Fix safe issues</strong> applies the fixes that cannot lose anything; each finding's own Fix button applies just that one.
      </p>
      <LiveRegion>
        {check.error ? <Notice tone="error">Couldn't run the checks: {check.error}</Notice> : null}
        {report ? (
          shown.length === 0 ? (
            <Notice tone="ok">All {okCount} checks passed.</Notice>
          ) : (
            <p className="text-[13px] text-ink-2">
              {okCount} passed, {shown.length} to look at.
            </p>
          )
        ) : null}
        {fixNote ? <Notice tone="info">{fixNote}</Notice> : null}
        {fix.error ? <Notice tone="error">Couldn't apply the fix: {fix.error}</Notice> : null}
      </LiveRegion>
      {shown.length > 0 ? (
        <ul aria-label="Findings" className="divide-y divide-rule overflow-hidden rounded-[10px] border border-rule bg-surface">
          {shown.map((finding) => (
            <li key={finding.id} className="flex flex-wrap items-start gap-x-3 gap-y-2 px-3.5 py-3">
              <Badge tone={LEVEL[finding.level].tone}>{LEVEL[finding.level].label}</Badge>
              <div className="min-w-0 flex-1">
                <p className="text-[13.5px] text-ink">{finding.message}</p>
                {finding.detail ? <p className="mt-0.5 break-words font-mono text-[12px] text-ink-3">{finding.detail}</p> : null}
                <p className="mt-0.5 text-[11.5px] text-ink-3">{finding.area}</p>
              </div>
              {finding.fixable && !finding.fixed ? (
                <Button size="sm" icon="zap" onClick={() => void fixOne(finding)} disabled={fixing !== null || check.pending} aria-label={`Fix: ${finding.message}`}>
                  {fixing === finding.id ? "Fixing…" : "Fix"}
                </Button>
              ) : null}
              {finding.fixed ? <Badge tone="ok">fixed</Badge> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
