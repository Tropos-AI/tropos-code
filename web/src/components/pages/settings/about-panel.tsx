// web/src/components/pages/settings/about-panel.tsx — Settings › About: version, working directory and session id (each
// copyable), the permission mode and where its rules live, and where the docs are.
import type { Mode } from "@core/config/constants";

import { CopyIconButton } from "@/components/pages/copy-chip";
import { withInlineCode } from "@/components/pages/panel-empty";
import { Badge } from "@/components/ui/badge";
import { Icon } from "@/components/ui/icon";
import { useAppStore, useHello, useSessionState } from "@/lib/store";

const DOCS_URL = "https://github.com/Tropos-AI/tropos-code#readme";

const MODE_LABEL: Record<Mode, string> = {
  default: "Default · asks before edits and commands",
  acceptEdits: "Accept edits · file edits run without asking",
  plan: "Plan · read-only until you approve a plan",
  bypass: "Bypass · nothing asks (started with --dangerously-skip-permissions)",
};

function Row({ label, value, copyLabel, mono = true }: { label: string; value: string; copyLabel?: string; mono?: boolean }) {
  return (
    <div className="grid gap-1 px-4 py-3.5 sm:grid-cols-[10rem_minmax(0,1fr)] sm:items-center sm:gap-4 sm:px-5">
      <dt className="type-meta text-ink-3">{label}</dt>
      <dd className="flex min-w-0 items-center gap-1">
        <span className={mono ? "min-w-0 flex-1 break-all font-mono text-[12.5px] text-ink" : "min-w-0 flex-1 text-[13.5px] text-ink"}>{value}</span>
        {copyLabel ? <CopyIconButton value={value} label={copyLabel} /> : null}
      </dd>
    </div>
  );
}

export function AboutPanel() {
  const hello = useHello();
  const session = useSessionState();
  const demo = useAppStore().demo;

  if (!hello) {
    return <div aria-hidden className="h-48 rounded-[12px] bg-paper-2 shadow-well" />;
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="overflow-hidden rounded-[12px] border border-rule bg-surface">
        <div className="flex flex-wrap items-center gap-3 border-b border-rule bg-linear-to-r from-surface to-accent-wash/60 px-4 py-4 sm:px-5">
          <img src="/brand/tropos-logo.png" alt="" width={32} height={32} className="size-8 select-none" draggable={false} />
          <p className="min-w-0 flex-1 text-[15px] font-semibold tracking-[-0.01em] text-ink [font-stretch:86%]">Tropos Code</p>
          {demo ? <Badge tone="accent">demo</Badge> : null}
        </div>
        <dl className="divide-y divide-rule">
        <Row label="Version" value={hello.version} copyLabel="Copy the version" />
        <Row label="Working directory" value={hello.cwd} copyLabel="Copy the working directory" />
        <Row label="Session id" value={hello.sessionId} copyLabel="Copy the session id" />
        {session ? <Row label="Permission mode" value={MODE_LABEL[session.mode]} mono={false} /> : null}
        </dl>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <section aria-labelledby="about-permissions" className="rounded-[12px] border border-rule bg-paper/70 p-4 shadow-well">
          <h3 id="about-permissions" className="flex items-center gap-2 text-[13.5px] font-medium text-ink">
            <Icon name="shield" size="sm" />
            Permissions
          </h3>
          <p className="mt-1.5 text-[13px] leading-relaxed text-ink-2">
            Allow and deny rules live in {withInlineCode("~/.tropos/settings.json")} and the project's {withInlineCode(".tropos/settings.json")}. Change the mode under the composer.
          </p>
        </section>
        <section aria-labelledby="about-docs" className="rounded-[12px] border border-rule bg-paper/70 p-4 shadow-well">
          <h3 id="about-docs" className="flex items-center gap-2 text-[13.5px] font-medium text-ink">
            <Icon name="book-open" size="sm" />
            Docs
          </h3>
          <p className="mt-1.5 text-[13px] leading-relaxed text-ink-2">
            Run <code className="rounded-[5px] bg-paper-2 px-1 py-px font-mono text-[0.9em] text-ink shadow-[inset_0_0_0_1px_var(--rule)]">tcode --help</code> in a terminal, or read the{" "}
            <a href={DOCS_URL} target="_blank" rel="noopener noreferrer" className="font-medium text-accent-ink underline decoration-accent/40 underline-offset-[3px] outline-none hover:decoration-current focus-visible:shadow-focus">
              README<span className="sr-only"> (opens in a new tab)</span>
            </a>{" "}
            for settings, hooks, skills and MCP.
          </p>
        </section>
      </div>
    </div>
  );
}
