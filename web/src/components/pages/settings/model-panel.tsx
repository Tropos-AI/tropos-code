// web/src/components/pages/settings/model-panel.tsx — Settings › Model: the session's model and effort with a button that
// opens the model picker, then the favourite and recent models from modelPrefs.get (star to (un)favourite, Use to
// switch).
import { useState } from "react";
import { m } from "motion/react";

import { EFFORTS, type Effort } from "@core/config/constants";
import { splitModelId } from "@core/ui/model-list";
import type { ProviderInfoView } from "@core/web/protocol";

import { ResourceView } from "@/components/pages/resource-view";
import type { Resource } from "@/components/pages/use-rpc-resource";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { usePrefersReducedMotion } from "@/hooks/use-prefers-reduced-motion";
import { CELL, INSTANT } from "@/lib/springs";
import { errorMessage, useAppStore, useSessionState } from "@/lib/store";
import { ui } from "@/lib/ui-store";
import { cn } from "@/lib/utils";

export type ModelPrefs = { recent: string[]; favorites: string[] };

function EffortMeter({ effort }: { effort: Effort }) {
  const level = EFFORTS.indexOf(effort);
  return (
    <span className="inline-flex items-center gap-2">
      <span aria-hidden className="flex items-end gap-[3px]">
        {EFFORTS.map((step, i) => (
          <span key={step} className={cn("w-[5px] rounded-[2px]", i <= level ? "bg-accent" : "bg-rule")} style={{ height: 6 + i * 3 }} />
        ))}
      </span>
      <span className="font-mono text-[12.5px] text-ink">{effort}</span>
    </span>
  );
}

function CurrentModel({ providers }: { providers: ProviderInfoView[] }) {
  const session = useSessionState();
  if (!session) {
    return <div aria-hidden className="h-[132px] rounded-[14px] bg-paper-2 shadow-well" />;
  }
  const { providerName, model } = splitModelId(session.model, providers);
  return (
    <section aria-labelledby="settings-current-model" className="relative overflow-hidden rounded-[14px] border border-rule bg-linear-to-br from-surface via-surface to-accent-wash/70 p-5 shadow-card sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <p id="settings-current-model" className="type-meta text-ink-3">
            This session
          </p>
          <p className="mt-2 break-all text-[22px] font-medium leading-tight tracking-[-0.02em] text-ink [font-stretch:88%]">{model}</p>
          <dl className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-[13px] text-ink-2">
            <div className="flex items-center gap-2">
              <dt className="text-ink-3">Provider</dt>
              <dd className="text-ink">{providerName}</dd>
            </div>
            <div className="flex items-center gap-2">
              <dt className="text-ink-3">Effort</dt>
              <dd>
                <EffortMeter effort={session.effort} />
              </dd>
            </div>
          </dl>
        </div>
        <Button variant="primary" icon="sparkles" onClick={ui.openModelPicker} aria-haspopup="dialog">
          Change model
        </Button>
      </div>
      <p className="mt-4 text-[12.5px] text-ink-3">The picker sets the model and effort for this session and the next turns.</p>
    </section>
  );
}

type ListProps = {
  title: string;
  icon: "star" | "clock";
  ids: string[];
  favorites: ReadonlySet<string>;
  providers: ProviderInfoView[];
  empty: string;
  onChanged: () => void;
};

function ModelList({ title, icon, ids, favorites, providers, empty, onChanged }: ListProps) {
  const store = useAppStore();
  const session = useSessionState();
  const reduced = usePrefersReducedMotion();
  const [pending, setPending] = useState<string | null>(null);

  const use = async (id: string) => {
    setPending(id);
    try {
      await store.rpc("setModel", id);
      await store.rpc("modelPrefs.recordUse", id);
      store.toast({ tone: "ok", title: `Switched to ${id}` });
      onChanged();
    } catch (error) {
      store.toast({ tone: "error", title: "Couldn't switch the model", description: errorMessage(error) });
    } finally {
      setPending(null);
    }
  };

  const star = async (id: string) => {
    try {
      const now = await store.rpc("modelPrefs.toggleFavorite", id);
      store.toast({ tone: "info", title: now ? `${id} is a favourite` : `${id} is no longer a favourite` });
      onChanged();
    } catch (error) {
      store.toast({ tone: "error", title: "Couldn't update favourites", description: errorMessage(error) });
    }
  };

  const headingId = `settings-models-${icon}`;
  return (
    <section aria-labelledby={headingId} className="overflow-hidden rounded-[14px] border border-rule bg-surface shadow-card">
      <header className="flex items-center gap-2.5 border-b border-rule px-4 py-3 sm:px-5">
        <span aria-hidden className="grid size-7 place-items-center rounded-[8px] border border-rule bg-paper-2 text-ink-2 shadow-well">
          <Icon name={icon} size="sm" />
        </span>
        <h3 id={headingId} className="text-[14px] font-medium text-ink">
          {title}
        </h3>
        <span className="ml-auto rounded-full border border-rule px-2 py-px font-mono text-[11px] tabular-nums text-ink-2">{ids.length}</span>
      </header>
      {ids.length === 0 ? (
        <p className="px-5 py-6 text-[13.5px] text-ink-3">{empty}</p>
      ) : (
        <ul className="divide-y divide-rule">
          {ids.map((id) => {
            const { providerName, model } = splitModelId(id, providers);
            const current = session?.model === id;
            const favorite = favorites.has(id);
            return (
              <li key={id} className="flex items-center gap-2 px-3 py-2 sm:px-4">
                <button
                  type="button"
                  aria-pressed={favorite}
                  aria-label={favorite ? `Remove ${id} from favourites` : `Add ${id} to favourites`}
                  title={favorite ? "Unstar" : "Star"}
                  onClick={() => void star(id)}
                  className={cn(
                    "grid size-8 shrink-0 place-items-center rounded-[8px] outline-none transition-colors duration-150 hover:bg-paper-2 focus-visible:shadow-focus",
                    favorite ? "text-warn" : "text-ink-3 hover:text-ink",
                  )}
                >
                  <m.span initial={false} animate={{ scale: favorite ? 1 : 0.88 }} transition={reduced ? INSTANT : CELL} className="inline-flex">
                    <Icon name="star" size="md" treatment={favorite ? "duotone" : "outline"} tone={favorite ? "warn" : "current"} />
                  </m.span>
                </button>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-mono text-[13px] text-ink">{model}</span>
                  <span className="block text-[12px] text-ink-3">{providerName}</span>
                </span>
                {current ? (
                  <Badge tone="accent">current</Badge>
                ) : (
                  <Button size="sm" variant="ghost" onClick={() => void use(id)} disabled={pending !== null || (session?.busy ?? false)} aria-label={`Use ${id}`}>
                    {pending === id ? "Switching…" : "Use"}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

type Props = {
  prefs: Resource<ModelPrefs>;
  providers: ProviderInfoView[];
};

export function ModelPanel({ prefs, providers }: Props) {
  return (
    <div className="flex flex-col gap-5">
      <CurrentModel providers={providers} />
      <ResourceView resource={prefs} noun="model preferences" skeleton={<div aria-hidden className="h-40 rounded-[14px] bg-paper-2 shadow-well" />}>
        {(data) => {
          const favorites = new Set(data.favorites);
          return (
            <div className="grid gap-5 md:grid-cols-2 md:items-start">
              <ModelList title="Favourites" icon="star" ids={data.favorites} favorites={favorites} providers={providers} empty="Star a model to keep it here and at the top of the picker." onChanged={prefs.refresh} />
              <ModelList title="Recent" icon="clock" ids={data.recent} favorites={favorites} providers={providers} empty="Models you pick show up here." onChanged={prefs.refresh} />
            </div>
          );
        }}
      </ResourceView>
    </div>
  );
}
