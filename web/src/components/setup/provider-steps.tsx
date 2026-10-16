// web/src/components/setup/provider-steps.tsx — the wizard's Provider and Model steps. They reuse the session RPCs the
// Settings page uses (providers.status / providers.connect / providers.models / setModel) and add onboard.validateKey,
// which makes a real call with the pasted key before anything is saved.
import { useMemo, useState } from "react";

import { modelId } from "@core/ui/model-list";
import type { ProviderInfoView } from "@core/web/protocol";

import { redactKey } from "@/components/pages/settings/connect-form";
import { useRpcResource } from "@/components/pages/use-rpc-resource";
import { LiveRegion, Notice, TextField, useAction } from "@/components/setup/admin-ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { errorMessage, useAdmin, useAppStore, useRpc, useSessionState } from "@/lib/store";
import { cn } from "@/lib/utils";

const connectable = (p: ProviderInfoView): boolean => p.key !== null ? p.key.kind === "saved" : p.keyRequired || p.keyEnv.length > 0;
const isReady = (p: ProviderInfoView): boolean => p.key !== null || !p.keyRequired;
const isLocal = (p: ProviderInfoView): boolean => !p.keyRequired && p.keyEnv.length === 0;

function connectionLabel(p: ProviderInfoView): string {
  if (p.key?.kind === "env") return `connected · ${p.key.name}`;
  if (p.key?.kind === "saved") return "connected · saved key";
  return isLocal(p) ? "no key needed" : "not connected";
}

export function ProviderStep({ onChanged }: { onChanged: () => void }) {
  const rpc = useRpc();
  const admin = useAdmin();
  const store = useAppStore();
  const providers = useRpcResource("setup:providers", () => rpc("providers.status"));
  const [picked, setPicked] = useState<string | null>(null);
  const [key, setKey] = useState("");
  const [found, setFound] = useState<{ ok: boolean; models: string[]; error?: string } | null>(null);
  const check = useAction();
  const save = useAction();

  const list = providers.data;
  const chosen = useMemo(() => {
    if (!list) return undefined;
    return list.find((p) => p.id === picked) ?? list.find((p) => p.key === null && connectable(p)) ?? list[0];
  }, [list, picked]);

  if (providers.status === "error") {
    return (
      <div className="flex flex-col items-start gap-2">
        <Notice tone="error">Couldn't load the providers: {providers.error}</Notice>
        <Button size="sm" icon="refresh-cw" onClick={providers.refresh}>
          Retry
        </Button>
      </div>
    );
  }
  if (!list || !chosen) return <p className="text-[13px] text-ink-3">Loading providers…</p>;

  const pick = (id: string) => {
    setPicked(id);
    setKey("");
    setFound(null);
    check.clear();
    save.clear();
  };

  const runCheck = async () => {
    const value = key.trim();
    if (!value) return;
    setFound(null);
    const result = await check.run(async () => {
      try {
        return await admin("onboard.validateKey", { provider: chosen.id, key: value });
      } catch (error) {
        throw new Error(redactKey(errorMessage(error), value));
      }
    });
    if (result) setFound({ ...result, ...(result.error ? { error: redactKey(result.error, value) } : {}) });
  };

  const runSave = async () => {
    const value = key.trim();
    if (!value) return;
    setKey("");
    setFound(null);
    const done = await save.run(async () => {
      try {
        await rpc("providers.connect", { id: chosen.id, key: value });
        return true;
      } catch (error) {
        throw new Error(redactKey(errorMessage(error), value));
      }
    });
    if (done) {
      store.toast({ tone: "ok", title: `Connected ${chosen.name}`, description: "The key is saved in ~/.tropos/credentials.json." });
      providers.refresh();
      onChanged();
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div role="radiogroup" aria-label="Provider" className="grid gap-2 sm:grid-cols-2">
        {list.map((p) => {
          const active = p.id === chosen.id;
          return (
            <button
              key={p.id}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => pick(p.id)}
              className={cn(
                "flex items-center gap-2.5 rounded-[10px] border px-3 py-2.5 text-left outline-none transition-[border-color,background-color,box-shadow] duration-150 focus-visible:shadow-focus",
                active ? "border-accent bg-accent-wash/60" : "border-rule bg-surface hover:border-rule-strong hover:bg-paper",
              )}
            >
              <span aria-hidden className={cn("size-2 shrink-0 rounded-full", p.key ? "bg-ok" : isReady(p) ? "bg-accent-soft" : "border-[1.5px] border-ink-4")} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13.5px] font-medium text-ink">{p.name}</span>
                <span className="block truncate text-[12px] text-ink-3">{connectionLabel(p)}</span>
              </span>
            </button>
          );
        })}
      </div>

      {isLocal(chosen) ? (
        <Notice tone="info">{chosen.noKeyNote ?? `${chosen.name} runs on your machine and needs no key.`} Make sure it is running, then pick a model in the next step.</Notice>
      ) : chosen.key?.kind === "env" ? (
        <Notice tone="ok">
          {chosen.name} is connected through the environment variable <code className="font-mono text-[12px]">{chosen.key.name}</code>. Nothing to paste.
        </Notice>
      ) : (
        <form
          noValidate
          aria-label={`Connect ${chosen.name}`}
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void runSave();
          }}
        >
          {chosen.key?.kind === "saved" ? <Notice tone="ok">A key is already saved for {chosen.name}. Paste a new one only to replace it.</Notice> : null}
          <TextField
            label={`${chosen.name} API key`}
            type="password"
            value={key}
            onChange={(value) => {
              setKey(value);
              setFound(null);
            }}
            mono
            disabled={save.pending}
            hint={`Saved to ~/.tropos/credentials.json, readable only by you. The browser never sees it again.${chosen.keyEnv.length > 0 ? ` Or set ${chosen.keyEnv.join(" / ")} in your shell.` : ""}`}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" icon="shield-check" onClick={() => void runCheck()} disabled={check.pending || save.pending || key.trim() === ""}>
              {check.pending ? "Checking…" : "Check key"}
            </Button>
            <Button type="submit" variant="primary" size="sm" icon="key" disabled={save.pending || check.pending || key.trim() === ""}>
              {save.pending ? "Saving…" : "Save key"}
            </Button>
            {chosen.keyURL ? (
              <a
                href={chosen.keyURL}
                target="_blank"
                rel="noopener noreferrer"
                className="ml-auto inline-flex h-8 items-center gap-1.5 rounded-[8px] px-2 text-[13px] font-medium text-accent-ink outline-none transition-colors duration-150 hover:bg-accent-wash focus-visible:shadow-focus"
              >
                Get a key
                <Icon name="external-link" size="sm" />
                <span className="sr-only">(opens in a new tab)</span>
              </a>
            ) : null}
          </div>
          <p className="text-[12px] leading-relaxed text-ink-3">
            <strong className="font-medium text-ink-2">Check key</strong> sends the key to {chosen.name} once to list its models; nothing is stored. <strong className="font-medium text-ink-2">Save key</strong> stores it on this machine.
          </p>
        </form>
      )}

      <LiveRegion>
        {check.error ? <Notice tone="error">Couldn't check the key: {check.error}</Notice> : null}
        {found?.ok ? (
          <Notice tone="ok">
            The key works. Found {found.models.length} {found.models.length === 1 ? "model" : "models"}
            {found.models.length > 0 ? `: ${found.models.slice(0, 4).join(", ")}${found.models.length > 4 ? `, and ${found.models.length - 4} more` : ""}` : ""}. Save it to use them.
          </Notice>
        ) : null}
        {found && !found.ok ? <Notice tone="error">The provider didn't accept that key{found.error ? `: ${found.error}` : ""}.</Notice> : null}
        {save.error ? <Notice tone="error">Couldn't save the key: {save.error}. Paste it again to retry.</Notice> : null}
      </LiveRegion>
    </div>
  );
}

export function ModelStep({ onChanged }: { onChanged: () => void }) {
  const rpc = useRpc();
  const store = useAppStore();
  const session = useSessionState();
  const providers = useRpcResource("setup:model-providers", () => rpc("providers.status"));
  const [picked, setPicked] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const setModel = useAction();

  const ready = (providers.data ?? []).filter(isReady);
  const provider = ready.find((p) => p.id === picked) ?? ready[0];
  const models = useRpcResource(`setup:models:${provider?.id ?? "-"}`, () => (provider ? rpc("providers.models", provider.id) : Promise.resolve([] as string[])));

  if (providers.status === "error") {
    return (
      <div className="flex flex-col items-start gap-2">
        <Notice tone="error">Couldn't load the providers: {providers.error}</Notice>
        <Button size="sm" icon="refresh-cw" onClick={providers.refresh}>
          Retry
        </Button>
      </div>
    );
  }
  if (!providers.data) return <p className="text-[13px] text-ink-3">Loading providers…</p>;
  if (!provider) return <Notice tone="warn">Connect a provider first, then come back to pick a model.</Notice>;

  const all = models.data ?? [];
  const shown = all.filter((m) => m.toLowerCase().includes(filter.trim().toLowerCase())).slice(0, 40);
  const current = session?.model;

  const choose = async (model: string) => {
    const id = modelId(provider.id, model);
    const done = await setModel.run(() => rpc("setModel", id).then(() => true));
    if (done) {
      store.toast({ tone: "ok", title: "Model set", description: id });
      onChanged();
    }
  };

  return (
    <div className="flex flex-col gap-3">
      {ready.length > 1 ? (
        <div role="radiogroup" aria-label="Provider for the model" className="flex flex-wrap gap-2">
          {ready.map((p) => (
            <button
              key={p.id}
              type="button"
              role="radio"
              aria-checked={p.id === provider.id}
              onClick={() => setPicked(p.id)}
              className={cn(
                "h-8 rounded-full border px-3 text-[12.5px] font-medium outline-none transition-colors duration-150 focus-visible:shadow-focus",
                p.id === provider.id ? "border-accent bg-accent-wash text-accent-ink" : "border-rule bg-surface text-ink-2 hover:bg-paper",
              )}
            >
              {p.name}
            </button>
          ))}
        </div>
      ) : null}
      {models.status === "error" ? (
        <div className="flex flex-col items-start gap-2">
          <Notice tone="error">Couldn't list {provider.name}'s models: {models.error}</Notice>
          <Button size="sm" icon="refresh-cw" onClick={models.refresh}>
            Retry
          </Button>
        </div>
      ) : models.data === undefined ? (
        <p className="text-[13px] text-ink-3">Loading models…</p>
      ) : all.length === 0 ? (
        <Notice tone="info">{provider.name} didn't list any models. If it runs locally, start it and retry.</Notice>
      ) : (
        <>
          {all.length > 8 ? <TextField label="Filter models" value={filter} onChange={setFilter} placeholder="Type to narrow the list" /> : null}
          <ul aria-label={`${provider.name} models`} className="max-h-[280px] divide-y divide-rule overflow-y-auto rounded-[10px] border border-rule bg-surface">
            {shown.map((model) => {
              const active = current !== undefined && modelId(provider.id, model) === current;
              return (
                <li key={model}>
                  <button
                    type="button"
                    onClick={() => void choose(model)}
                    disabled={setModel.pending}
                    aria-label={`Use ${model}`}
                    className="flex w-full items-center gap-2.5 px-3 py-2 text-left outline-none transition-colors duration-150 hover:bg-paper focus-visible:bg-accent-wash/60 focus-visible:shadow-[inset_0_0_0_1px_var(--accent)] disabled:opacity-60"
                  >
                    <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-ink">{model}</span>
                    {active ? <Badge tone="accent">in use</Badge> : <span className="text-[12px] text-ink-3">Use</span>}
                  </button>
                </li>
              );
            })}
            {shown.length === 0 ? <li className="px-3 py-4 text-center text-[13px] text-ink-3">No model matches “{filter}”.</li> : null}
          </ul>
          <p className="text-[12px] text-ink-3">Choosing one sets the model for this session and the next turns. You can change it any time from the chat or Settings.</p>
        </>
      )}
      <LiveRegion>{setModel.error ? <Notice tone="error">Couldn't set the model: {setModel.error}</Notice> : null}</LiveRegion>
    </div>
  );
}
