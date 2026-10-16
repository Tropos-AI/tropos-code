// web/src/app/pages/SetupPage.tsx — the first-run wizard and setup checklist (onboard.state). A stepper: every step
// expands in place, the state is read from the server each time (so it is resumable), optional steps never block, and
// "Finish" / "Reopen setup" call onboard.finish / onboard.reopen.
import { useState } from "react";
import { m } from "motion/react";

import type { OnboardState, OnboardStep, OnboardStepId } from "@core/web/admin/api";

import { PageFrame } from "@/app/layout/PageFrame";
import { PageActions } from "@/components/pages/page-actions";
import { ResourceView } from "@/components/pages/resource-view";
import { useRpcResource } from "@/components/pages/use-rpc-resource";
import { LiveRegion, Notice, useAction } from "@/components/setup/admin-ui";
import { HealthStep, PairingStep, SandboxStep, ServiceStep, TelegramStep } from "@/components/setup/host-steps";
import { ModelStep, ProviderStep } from "@/components/setup/provider-steps";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Icon, type IconName } from "@/components/ui/icon";
import { usePrefersReducedMotion } from "@/hooks/use-prefers-reduced-motion";
import { CROSSFADE, INSTANT } from "@/lib/springs";
import { useAdmin, useAppStore } from "@/lib/store";
import { cn } from "@/lib/utils";

const STATUS: Record<OnboardStep["status"], { tone: BadgeTone; label: string; icon: IconName }> = {
  done: { tone: "ok", label: "done", icon: "circle-check" },
  todo: { tone: "off", label: "to do", icon: "circle-dashed" },
  skipped: { tone: "neutral", label: "skipped", icon: "skip-forward" },
  warn: { tone: "warn", label: "needs a look", icon: "triangle-alert" },
  error: { tone: "error", label: "problem", icon: "circle-alert" },
};

const SUMMARY: Record<OnboardStepId, string> = {
  provider: "Connect the AI provider that does the thinking.",
  model: "Choose which model answers.",
  telegram: "Talk to Tropos from your phone through your own bot.",
  pairing: "Let your own Telegram account in.",
  sandbox: "Docker keeps commands from chats away from your machine.",
  service: "Start Tropos by itself when you log in.",
  health: "Make sure everything above works together.",
};

/** The first step still to do, required ones first; what the wizard opens on. */
export function firstOpenStep(steps: OnboardStep[], skipped: ReadonlySet<OnboardStepId>): OnboardStepId | null {
  const open = (s: OnboardStep) => (s.status === "todo" || s.status === "error" || s.status === "warn") && !skipped.has(s.id);
  return (steps.find((s) => !s.optional && open(s)) ?? steps.find(open))?.id ?? null;
}

interface StepBodyProps {
  step: OnboardStep;
  steps: OnboardStep[];
  changed: () => void;
  skip: (id: OnboardStepId) => void;
}

function StepBody({ step, steps, changed, skip }: StepBodyProps) {
  switch (step.id) {
    case "provider":
      return <ProviderStep onChanged={changed} />;
    case "model":
      return <ModelStep onChanged={changed} />;
    case "telegram":
      return <TelegramStep onChanged={changed} onSkip={() => skip("telegram")} />;
    case "pairing":
      return <PairingStep telegramReady={steps.find((s) => s.id === "telegram")?.status === "done"} onChanged={changed} onSkip={() => skip("pairing")} />;
    case "sandbox":
      return <SandboxStep onChanged={changed} onSkip={() => skip("sandbox")} />;
    case "service":
      return <ServiceStep onChanged={changed} />;
    case "health":
      return <HealthStep onChanged={changed} />;
  }
}

function StepItem({ step, index, steps, open, skipped, onToggle, changed, skip }: StepBodyProps & { index: number; open: boolean; skipped: boolean; onToggle: () => void }) {
  const reduced = usePrefersReducedMotion();
  const status = skipped && step.status === "todo" ? STATUS.skipped : STATUS[step.status];
  const panelId = `setup-step-${step.id}`;
  return (
    <li className="overflow-hidden rounded-[14px] border border-rule bg-surface shadow-card">
      <h2>
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          aria-controls={panelId}
          className="flex w-full items-center gap-3.5 px-5 py-4 text-left outline-none transition-colors duration-150 hover:bg-paper focus-visible:bg-accent-wash/50 focus-visible:shadow-[inset_0_0_0_1px_var(--accent)]"
        >
          <span
            aria-hidden
            className={cn(
              "grid size-8 shrink-0 place-items-center rounded-full border text-[12.5px] font-medium tabular-nums",
              step.status === "done" ? "border-ok/20 bg-ok-wash text-ok" : "border-rule bg-paper-2 text-ink-2",
            )}
          >
            {step.status === "done" ? <Icon name="check" size="sm" /> : index + 1}
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="text-[14.5px] font-medium text-ink">{step.title}</span>
              {step.optional ? <span className="text-[11.5px] text-ink-3">optional</span> : null}
            </span>
            <span className="mt-0.5 block text-[12.5px] leading-snug text-ink-3">{step.detail ?? SUMMARY[step.id]}</span>
          </span>
          <Badge tone={status.tone}>{status.label}</Badge>
          <span aria-hidden className={cn("text-ink-3 transition-transform duration-150 motion-reduce:transition-none", open && "rotate-90")}>
            <Icon name="chevron-right" size="sm" />
          </span>
        </button>
      </h2>
      {open ? (
        <m.div
          id={panelId}
          role="region"
          aria-label={`${step.title} setup`}
          initial={reduced ? false : { opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={reduced ? INSTANT : CROSSFADE}
          className="border-t border-rule px-5 pb-5 pt-4"
        >
          <StepBody step={step} steps={steps} changed={changed} skip={skip} />
        </m.div>
      ) : null}
    </li>
  );
}

function Wizard({ state, refresh }: { state: OnboardState; refresh: () => void }) {
  const admin = useAdmin();
  const store = useAppStore();
  const [skipped, setSkipped] = useState<ReadonlySet<OnboardStepId>>(new Set());
  const [choice, setChoice] = useState<{ id: OnboardStepId | null } | null>(null);
  const finish = useAction();
  const reopen = useAction();

  const openId = choice ? choice.id : firstOpenStep(state.steps, skipped);
  const required = state.steps.filter((s) => !s.optional);
  const requiredDone = required.filter((s) => s.status === "done").length;

  const skip = (id: OnboardStepId) => {
    const next = new Set(skipped);
    next.add(id);
    setSkipped(next);
    setChoice({ id: firstOpenStep(state.steps, next) });
  };

  const doFinish = async () => {
    const skippedIds = state.steps.filter((s) => s.optional && s.status !== "done").map((s) => s.id);
    const next = await finish.run(() => admin("onboard.finish", { skipped: skippedIds }));
    if (next) {
      store.toast({ tone: "ok", title: next.complete ? "Setup finished" : "Setup dismissed", description: next.complete ? undefined : "You can reopen it from this page." });
      refresh();
    }
  };
  const doReopen = async () => {
    const next = await reopen.run(() => admin("onboard.reopen"));
    if (next) {
      setSkipped(new Set());
      setChoice(null);
      refresh();
    }
  };

  return (
    <>
      <section aria-label="Setup progress" className="rounded-[14px] border border-rule bg-linear-to-br from-surface via-surface to-accent-wash/70 p-5 shadow-card">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="min-w-0">
            <p className="type-meta text-ink-3">{state.dismissed ? "Setup finished" : state.complete ? "Ready to finish" : "Getting started"}</p>
            <p className="mt-1.5 text-[17px] font-medium tracking-[-0.01em] text-ink">
              {requiredDone} of {required.length} required steps done
            </p>
            <p className="mt-1 max-w-[52ch] text-[13px] leading-relaxed text-ink-2">
              {state.dismissed
                ? "Everything below stays available. Change anything any time."
                : state.complete
                  ? "You have what you need. The optional steps can wait."
                  : "Connect a provider and pick a model; that's enough to start. Everything else is optional."}
            </p>
          </div>
          {state.dismissed ? (
            <Button icon="rocket" onClick={() => void doReopen()} disabled={reopen.pending}>
              {reopen.pending ? "Reopening…" : "Reopen setup"}
            </Button>
          ) : (
            <Button variant="primary" icon="check" onClick={() => void doFinish()} disabled={finish.pending}>
              {finish.pending ? "Saving…" : state.complete ? "Finish setup" : "Dismiss setup"}
            </Button>
          )}
        </div>
        {!state.dismissed ? (
          <p className="mt-3 text-[12px] text-ink-3">
            {state.complete ? <strong className="font-medium text-ink-2">Finish setup</strong> : <strong className="font-medium text-ink-2">Dismiss setup</strong>} stops the reminder. Nothing is changed or removed; optional steps you haven't done are noted as skipped.
          </p>
        ) : null}
        <LiveRegion>
          {finish.error ? <Notice tone="error" className="mt-3">Couldn't save that: {finish.error}</Notice> : null}
          {reopen.error ? <Notice tone="error" className="mt-3">Couldn't reopen setup: {reopen.error}</Notice> : null}
        </LiveRegion>
      </section>

      <ol aria-label="Setup steps" className="flex flex-col gap-3">
        {state.steps.map((step, index) => (
          <StepItem
            key={step.id}
            step={step}
            index={index}
            steps={state.steps}
            open={openId === step.id}
            skipped={skipped.has(step.id)}
            onToggle={() => setChoice({ id: openId === step.id ? null : step.id })}
            changed={refresh}
            skip={skip}
          />
        ))}
      </ol>
    </>
  );
}

export function SetupPage() {
  const admin = useAdmin();
  const resource = useRpcResource("onboard.state", () => admin("onboard.state"));
  return (
    <PageFrame
      title="Setup"
      eyebrow="Control"
      description="Get Tropos ready, one step at a time. Pick up where you left off any time: nothing here blocks you."
      width="reading"
      actions={<PageActions resource={resource} noun="setup state" />}
    >
      <ResourceView resource={resource} noun="setup">
        {(state) => <Wizard state={state} refresh={resource.refresh} />}
      </ResourceView>
    </PageFrame>
  );
}
