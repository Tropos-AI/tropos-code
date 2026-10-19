// web/src/components/setup/remote-steps.tsx — the wizard's Telegram (live owner claim), Phone access and All set panels.
// Telegram: the dashboard shows a deep link and its QR; tapping it on the phone proves who the owner is (the link carries a
// secret), and the owner's name then appears here to confirm. The poll is one request at a time and stops when the panel closes.
import { useEffect, useRef, useState, type ReactNode } from "react";

import { BOTFATHER_STEPS, BOTFATHER_URL, STEP_WHY, TAILSCALE_DOWNLOAD_URL } from "@core/onboard/copy";
import type { OwnerCandidateView, PhoneStatusView } from "@core/web/admin/api";

import { QrCode } from "@/components/pages/settings/qr-code";
import { useRpcResource } from "@/components/pages/use-rpc-resource";
import { LiveRegion, Notice, useAction } from "@/components/setup/admin-ui";
import { TelegramTokenForm } from "@/components/setup/channel-forms";
import { HealthStep, SkipRow } from "@/components/setup/host-steps";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { errorMessage, useAdmin } from "@/lib/store";

export const TELEGRAM_POLL_MS = 2000;

const LINK =
  "inline-flex min-h-8 items-center gap-1.5 rounded-[8px] px-2 text-[13px] font-medium text-accent-ink outline-none transition-colors duration-150 hover:bg-accent-wash focus-visible:shadow-focus motion-reduce:transition-none";

function ExternalLink({ href, children, className }: { href: string; children: ReactNode; className?: string }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={className ?? LINK}>
      {children}
      <Icon name="external-link" size="sm" />
      <span className="sr-only">(opens in a new tab)</span>
    </a>
  );
}

const who = (c: OwnerCandidateView): string => (c.username ? `${c.name} (@${c.username})` : c.name);

interface Listening {
  bot: string;
  link?: string;
  candidates: OwnerCandidateView[];
}

/** Opens the owner-claim window and polls it while mounted; each answer replaces the last, errors keep the last good one. */
function useOwnerListen(): { listening: Listening | null; error: string | null } {
  const admin = useAdmin();
  const [listening, setListening] = useState<Listening | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    let inFlight = false;
    const poll = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const next = await admin("onboard.telegram.listen");
        if (live) {
          setListening(next);
          setError(null);
        }
      } catch (cause) {
        if (live) setError(errorMessage(cause));
      } finally {
        inFlight = false;
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), TELEGRAM_POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [admin]);

  return { listening, error };
}

function OwnerClaim({ bot, onChanged }: { bot?: string; onChanged: () => void }) {
  const admin = useAdmin();
  const { listening, error } = useOwnerListen();
  const confirm = useAction();
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const [announced, setAnnounced] = useState("");
  const seen = useRef(new Set<string>());

  const username = listening?.bot ?? bot;
  const link = listening?.link ?? (username ? `https://t.me/${username}` : undefined);
  const waiting = (listening?.candidates ?? []).filter((c) => !hidden.has(c.senderId));
  const waitingKey = waiting.map((c) => c.senderId).join(",");

  useEffect(() => {
    const fresh = waiting.find((c) => !seen.current.has(c.senderId));
    for (const c of waiting) seen.current.add(c.senderId);
    if (fresh) setAnnounced(`${who(fresh)} wrote to your bot. Is this you?`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waitingKey]);

  const accept = async (candidate: OwnerCandidateView) => {
    const done = await confirm.run(() => admin("onboard.telegram.confirm", { senderId: candidate.senderId }));
    if (done) onChanged();
  };

  return (
    <div className="flex flex-col gap-4">
      <p className="text-[13.5px] leading-relaxed text-ink-2">
        <strong className="font-medium text-ink">Now claim your bot from your phone.</strong> Open this link on your phone (or scan the code) and press <strong className="font-medium text-ink">Start</strong>. Your name will appear below so you can confirm it is you.
      </p>
      {link ? (
        <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center">
          <QrCode text={link} label="QR code for your Telegram bot" />
          <div className="min-w-0">
            <ExternalLink href={link} className={`${LINK} max-w-full break-all`}>
              {link.replace(/^https:\/\//, "")}
            </ExternalLink>
            {username ? <p className="mt-1 px-2 text-[12.5px] text-ink-3">Your bot is @{username}.</p> : null}
          </div>
        </div>
      ) : null}
      <p className="flex items-center gap-2 text-[12.5px] text-ink-3">
        <span aria-hidden className="size-1.5 rounded-full bg-accent motion-safe:animate-pulse" />
        Waiting for you to press Start…
      </p>
      <div aria-live="polite" className="sr-only">
        {announced}
      </div>
      {waiting.length > 0 ? (
        <ul aria-label="People who wrote to your bot" className="flex flex-col gap-2">
          {waiting.map((c) => (
            <li key={c.senderId} className="flex flex-col gap-2.5 rounded-[10px] border border-accent/30 bg-accent-wash/60 px-3.5 py-3 sm:flex-row sm:items-center sm:justify-between">
              <p className="min-w-0 break-words text-[13.5px] font-medium text-ink">{who(c)}: is this you?</p>
              <div className="flex flex-wrap gap-2">
                <Button variant="primary" size="sm" icon="check" onClick={() => void accept(c)} disabled={confirm.pending}>
                  Yes, that's me
                </Button>
                <Button size="sm" onClick={() => setHidden(new Set([...hidden, c.senderId]))} disabled={confirm.pending}>
                  Not me
                </Button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      <LiveRegion>
        {confirm.error ? <Notice tone="error">Couldn't confirm that: {confirm.error}</Notice> : null}
        {error ? <Notice tone="warn">Couldn't check for messages: {error}. Is the gateway running? Trying again…</Notice> : null}
      </LiveRegion>
    </div>
  );
}

export function TelegramOwnerStep({ onChanged, onSkip, done = false }: { onChanged: () => void; onSkip: () => void; done?: boolean }) {
  const admin = useAdmin();
  const channels = useRpcResource("setup:channels", () => admin("channels.get"));
  const [again, setAgain] = useState(false);

  if (channels.status === "error") {
    return (
      <div className="flex flex-col items-start gap-2">
        <Notice tone="error">Couldn't load Telegram: {channels.error}</Notice>
        <Button size="sm" icon="refresh-cw" onClick={channels.refresh}>
          Retry
        </Button>
      </div>
    );
  }
  if (!channels.data) return <p className="text-[13px] text-ink-3">Loading…</p>;
  const { telegram } = channels.data;

  if (!telegram.configured) {
    return (
      <div className="flex flex-col gap-4">
        <p className="text-[13.5px] leading-relaxed text-ink-2">{STEP_WHY.telegram}</p>
        <ol aria-label="BotFather steps" className="flex list-decimal flex-col gap-1 pl-5 text-[13.5px] leading-relaxed text-ink-2 marker:text-ink-4">
          {BOTFATHER_STEPS.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ol>
        <div>
          <ExternalLink href={BOTFATHER_URL}>Open BotFather</ExternalLink>
        </div>
        <TelegramTokenForm onSaved={channels.refresh} />
        <SkipRow onSkip={onSkip} label="Skip Telegram" />
      </div>
    );
  }

  if (done && !again) {
    return (
      <div className="flex flex-col gap-3">
        <p className="flex flex-wrap items-center gap-2 text-[13.5px] text-ink-2">
          <Badge tone="ok">{telegram.bot ? `@${telegram.bot.username}` : "connected"}</Badge>
          Telegram is connected and your account is the owner.
        </p>
        <div>
          <Button size="sm" icon="user-plus" onClick={() => setAgain(true)}>
            Claim from another account
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <OwnerClaim bot={telegram.bot?.username} onChanged={onChanged} />
      <SkipRow onSkip={onSkip} label="Skip Telegram" />
    </div>
  );
}

function PhoneCode({ url, code }: { url: string; code: string }) {
  return (
    <div className="flex flex-col items-start gap-4 sm:flex-row sm:items-center">
      <QrCode text={url} label="QR code for the dashboard on your phone" />
      <div className="min-w-0 space-y-2">
        <p className="text-[12.5px] text-ink-3">Scan it with your phone, or open:</p>
        <p className="break-all font-mono text-[13px] text-ink">{url}</p>
        <p className="text-[12.5px] text-ink-3">Then enter this code. It works for 10 minutes.</p>
        <p className="font-mono text-[28px] font-medium leading-none tracking-[0.18em] text-ink tabular-nums">{code}</p>
      </div>
    </div>
  );
}

export function PhoneStep({ onChanged, onSkip, onNext }: { onChanged: () => void; onSkip: () => void; onNext?: () => void }) {
  const admin = useAdmin();
  const status = useRpcResource<PhoneStatusView>("setup:phone", () => admin("onboard.phone.status"));
  const enable = useAction();
  const [issued, setIssued] = useState<{ url: string; code: string } | null>(null);

  if (status.status === "error") {
    return (
      <div className="flex flex-col items-start gap-2">
        <Notice tone="error">Couldn't check Tailscale: {status.error}</Notice>
        <Button size="sm" icon="refresh-cw" onClick={status.refresh}>
          Retry
        </Button>
        <SkipRow onSkip={onSkip} label="Skip phone access" />
      </div>
    );
  }
  if (!status.data) return <p className="text-[13px] text-ink-3">Checking Tailscale…</p>;
  const info = status.data;

  const turnOn = async () => {
    const result = await enable.run(() => admin("onboard.phone.enable"));
    if (result) {
      setIssued(result);
      status.refresh();
      onChanged();
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <p className="text-[13.5px] leading-relaxed text-ink-2">{STEP_WHY.phone}</p>
      {!info.installed ? (
        <>
          <Notice tone="info">Tailscale isn't installed on this computer. Install it, sign in, then come back and check again.</Notice>
          <div className="flex flex-wrap items-center gap-2">
            <ExternalLink href={TAILSCALE_DOWNLOAD_URL}>Download Tailscale</ExternalLink>
            <Button size="sm" icon="refresh-cw" onClick={status.refresh}>
              Check again
            </Button>
          </div>
        </>
      ) : !info.running ? (
        <>
          <Notice tone="info">Open Tailscale and sign in, then check again.</Notice>
          <div>
            <Button size="sm" icon="refresh-cw" onClick={status.refresh}>
              Check again
            </Button>
          </div>
        </>
      ) : (
        <>
          {info.enabled && !issued ? <Notice tone="ok">Phone access is on{info.url ? <>: <span className="break-all font-mono text-[12px]">{info.url}</span></> : "."}</Notice> : null}
          <div>
            <Button variant={info.enabled ? "secondary" : "primary"} icon="smartphone" onClick={() => void turnOn()} disabled={enable.pending}>
              {enable.pending ? "Turning on…" : info.enabled ? "Show a new code" : "Turn on phone access"}
            </Button>
          </div>
        </>
      )}
      <LiveRegion>{enable.error ? <Notice tone="error">Couldn't turn it on: {enable.error}</Notice> : null}</LiveRegion>
      {issued ? <PhoneCode url={issued.url} code={issued.code} /> : null}
      {issued && onNext ? (
        <div>
          <Button variant="primary" icon="arrow-right" onClick={onNext}>
            Continue
          </Button>
        </div>
      ) : null}
      {!issued ? <SkipRow onSkip={onSkip} label="Skip phone access" /> : null}
    </div>
  );
}

const READY: Record<string, "ok" | "neutral" | "warn" | "error" | "off"> = { done: "ok", skipped: "neutral", warn: "warn", error: "error", todo: "off" };

export function DoneStep({ onChanged }: { onChanged: () => void }) {
  const admin = useAdmin();
  const summary = useRpcResource("setup:summary", () => admin("onboard.summary"));

  return (
    <div className="flex flex-col gap-5">
      {summary.status === "error" ? (
        <Notice tone="error">Couldn't load the summary: {summary.error}</Notice>
      ) : summary.data ? (
        <>
          <ul aria-label="What is ready" className="divide-y divide-rule overflow-hidden rounded-[10px] border border-rule bg-surface">
            {summary.data.steps.map((step) => (
              <li key={step.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3.5 py-2.5">
                <span aria-hidden className={step.status === "done" ? "text-ok" : "text-ink-4"}>
                  {step.status === "done" ? "◇" : "○"}
                </span>
                <span className="min-w-0 flex-1 text-[13.5px] text-ink">
                  {step.title}
                  {step.detail ? <span className="block text-[12px] text-ink-3">{step.detail}</span> : null}
                </span>
                <Badge tone={READY[step.status] ?? "neutral"}>{step.status === "done" ? "ready" : step.status}</Badge>
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap items-center gap-2 text-[13.5px] text-ink-2">
            <span>Dashboard</span>
            <span className="break-all font-mono text-[12.5px] text-ink">{summary.data.dashboardUrl}</span>
          </div>
          {summary.data.botUrl ? (
            <div>
              <ExternalLink href={summary.data.botUrl}>{summary.data.botUrl.replace(/^https:\/\//, "")}</ExternalLink>
            </div>
          ) : null}
          <div className="flex flex-col gap-1.5">
            <h3 className="text-[13px] font-medium text-ink">Try asking</h3>
            <ul className="flex flex-col gap-1 text-[13.5px] text-ink-2">
              {summary.data.examples.map((example) => (
                <li key={example} className="rounded-[8px] bg-paper-2 px-3 py-1.5">
                  {example}
                </li>
              ))}
            </ul>
          </div>
          <p className="text-[13px] text-ink-2">{summary.data.updates}</p>
        </>
      ) : (
        <p className="text-[13px] text-ink-3">Loading the summary…</p>
      )}
      <HealthStep onChanged={onChanged} />
    </div>
  );
}
