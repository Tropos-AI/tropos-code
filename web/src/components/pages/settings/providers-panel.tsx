// web/src/components/pages/settings/providers-panel.tsx — Settings › Providers: who is connected and how (an environment
// variable or a saved key — never the key), Connect with an inline key form, Disconnect for saved keys.
import { useState } from "react";
import { AnimatePresence, m } from "motion/react";

import type { ProviderInfoView } from "@core/web/protocol";

import { API_OPTIONS, AddProviderForm } from "@/components/pages/settings/add-provider-form";
import { ConnectForm } from "@/components/pages/settings/connect-form";
import { ResourceView } from "@/components/pages/resource-view";
import type { Resource } from "@/components/pages/use-rpc-resource";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { usePrefersReducedMotion } from "@/hooks/use-prefers-reduced-motion";
import { CELL, CROSSFADE, INSTANT } from "@/lib/springs";
import { errorMessage, useAdmin, useAppStore } from "@/lib/store";
import { cn } from "@/lib/utils";

/** The status line, as /providers words it in the terminal. */
export function keyLabel(p: ProviderInfoView): string {
  if (p.key?.kind === "env") return `connected · ${p.key.name}`;
  if (p.key?.kind === "saved") return "connected · saved key";
  return p.keyRequired ? "not connected" : (p.noKeyNote ?? "no key needed");
}

/** A provider a key can be saved for (local providers without key variables have nothing to connect). */
const connectable = (p: ProviderInfoView) => p.key === null && (p.keyRequired || p.keyEnv.length > 0);

function KeyLine({ provider }: { provider: ProviderInfoView }) {
  const label = keyLabel(provider);
  if (provider.key?.kind === "env") {
    return (
      <>
        connected · <code className="font-mono text-[12px] text-ink">{provider.key.name}</code>
      </>
    );
  }
  return <>{label}</>;
}

function Indicator({ provider }: { provider: ProviderInfoView }) {
  const connected = provider.key !== null;
  const ready = connected || !provider.keyRequired;
  return (
    <span
      aria-hidden
      className={cn(
        "mt-[7px] size-2 shrink-0 rounded-full",
        connected ? "bg-ok shadow-[0_0_0_3px_var(--ok-wash)]" : ready ? "bg-accent-soft" : "border-[1.5px] border-ink-4",
      )}
    />
  );
}

type RowProps = {
  provider: ProviderInfoView;
  inUse: boolean;
  formOpen: boolean;
  onOpenForm: () => void;
  onCloseForm: () => void;
  onChanged: () => void;
};

function ProviderRow({ provider, inUse, formOpen, onOpenForm, onCloseForm, onChanged }: RowProps) {
  const store = useAppStore();
  const admin = useAdmin();
  const reduced = usePrefersReducedMotion();
  const [removing, setRemoving] = useState(false);

  // An added endpoint goes away entirely: its settings.json entry, then its saved key.
  const remove = async () => {
    setRemoving(true);
    try {
      await admin("config.set", { file: "settings", path: `providers.${provider.id}`, value: null });
      await store.rpc("providers.disconnect", provider.id).catch(() => false);
      store.toast({ tone: "ok", title: `Removed ${provider.name}` });
      onChanged();
    } catch (error) {
      store.toast({ tone: "error", title: `Couldn't remove ${provider.name}`, description: errorMessage(error) });
    } finally {
      setRemoving(false);
    }
  };

  const disconnect = async () => {
    setRemoving(true);
    try {
      const removed = await store.rpc("providers.disconnect", provider.id);
      store.toast(removed ? { tone: "ok", title: `Disconnected ${provider.name}`, description: "The saved key was removed." } : { tone: "info", title: `${provider.name} had no saved key` });
      onChanged();
    } catch (error) {
      store.toast({ tone: "error", title: `Couldn't disconnect ${provider.name}`, description: errorMessage(error) });
    } finally {
      setRemoving(false);
    }
  };

  return (
    <m.li layout="position" transition={reduced ? INSTANT : CELL} className={cn("px-4 py-3.5 sm:px-5", formOpen && "bg-paper/70")}>
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
        <Indicator provider={provider} />
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <strong className="text-[14px] font-medium text-ink">{provider.name}</strong>
            {inUse ? (
              <Badge tone="accent" className="h-5 text-[11px]">
                in use
              </Badge>
            ) : null}
          </p>
          <p className={cn("mt-0.5 text-[13px]", provider.key ? "text-ok" : "text-ink-2")}>
            <KeyLine provider={provider} />
          </p>
          {provider.custom ? (
            <p className="mt-0.5 break-all text-[12px] text-ink-3">
              {API_OPTIONS.find((o) => o.value === provider.custom!.api)?.label} · <code className="font-mono">{provider.custom.baseURL}</code>
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2 self-center">
          {provider.custom ? (
            <Button variant="danger" size="sm" icon="trash-2" onClick={() => void remove()} disabled={removing} aria-label={`Remove ${provider.name}`}>
              {removing ? "Removing…" : "Remove"}
            </Button>
          ) : null}
          {provider.key?.kind === "saved" && !provider.custom ? (
            <Button variant="danger" size="sm" icon="log-out" onClick={() => void disconnect()} disabled={removing} aria-label={`Disconnect ${provider.name}`}>
              {removing ? "Removing…" : "Disconnect"}
            </Button>
          ) : null}
          {provider.key?.kind === "env" ? <span className="hidden text-[12px] text-ink-3 sm:inline">from your shell</span> : null}
          {connectable(provider) && !formOpen ? (
            <Button size="sm" icon="key" onClick={onOpenForm} aria-label={`Connect ${provider.name}`}>
              Connect
            </Button>
          ) : null}
        </div>
      </div>
      <div>
        <AnimatePresence initial={false}>
          {formOpen ? (
            <m.div
              key="form"
              initial={reduced ? { opacity: 0 } : { opacity: 0, y: -6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, transition: reduced ? INSTANT : { duration: 0.12 } }}
              transition={reduced ? INSTANT : CROSSFADE}
              className="pt-2 sm:pl-5"
            >
              <ConnectForm
                provider={provider}
                onCancel={onCloseForm}
                onConnected={() => {
                  store.toast({ tone: "ok", title: `Connected ${provider.name}`, description: "The key is saved in ~/.tropos/credentials.json." });
                  onCloseForm();
                  onChanged();
                }}
              />
            </m.div>
          ) : null}
        </AnimatePresence>
      </div>
    </m.li>
  );
}

type Props = {
  resource: Resource<ProviderInfoView[]>;
  /** The provider of the session's model, for the "in use" badge. */
  currentProvider?: string;
};

export function ProvidersPanel({ resource, currentProvider }: Props) {
  const store = useAppStore();
  const [formFor, setFormFor] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  return (
    <div className="flex flex-col gap-4">
      <p className="max-w-[62ch] text-[13.5px] leading-relaxed text-ink-2">
        Keys from environment variables win over saved ones. A saved key is stored on this machine only; the browser never sees it again.
      </p>
      <ResourceView resource={resource} noun="providers">
        {(providers) => (
          <ul className="divide-y divide-rule overflow-hidden rounded-[12px] border border-rule bg-surface">
            {providers.map((provider) => (
              <ProviderRow
                key={provider.id}
                provider={provider}
                inUse={provider.id === currentProvider}
                formOpen={formFor === provider.id}
                onOpenForm={() => setFormFor(provider.id)}
                onCloseForm={() => setFormFor((open) => (open === provider.id ? null : open))}
                onChanged={resource.refresh}
              />
            ))}
          </ul>
        )}
      </ResourceView>
      {adding ? (
        <AddProviderForm
          taken={(resource.data ?? []).map((p) => p.id)}
          onCancel={() => setAdding(false)}
          onAdded={(name) => {
            store.toast({ tone: "ok", title: `Added ${name}`, description: "Pick its models in the model picker." });
            setAdding(false);
            resource.refresh();
          }}
        />
      ) : (
        <div>
          <Button size="sm" icon="plus" onClick={() => setAdding(true)}>
            Add a provider
          </Button>
          <p className="mt-1.5 text-[12.5px] text-ink-3">Any endpoint compatible with Anthropic or OpenAI: a proxy, LiteLLM, vLLM, a hosted gateway.</p>
        </div>
      )}
    </div>
  );
}
