// src/ui/ProvidersDialog.tsx — /providers: connect a provider with a key, then pick one of its models.
import { Box, Text, useInput } from "ink";
import { useEffect, useState, type ReactNode } from "react";
import type { ProviderStatus } from "../providers/router";
import { Pane } from "./design/Pane";
import { windowStart } from "./design/SelectList";
import type { ProviderControl } from "./runtime";
import { sanitizeForTerminal } from "./terminal-safe";
import { useTheme } from "./theme-context";

const VISIBLE = 12;

type Step =
  | { kind: "list" }
  | { kind: "key"; status: ProviderStatus; error?: string }
  | { kind: "models"; status: ProviderStatus; models: string[] | null; error?: string };

export function keyLabel(s: ProviderStatus): string {
  if (s.key?.kind === "env") return `connected · ${s.key.name}`;
  if (s.key?.kind === "saved") return "connected · saved key";
  return s.info.keyRequired ? "not connected" : (s.info.noKeyNote ?? "no key needed");
}

const ready = (s: ProviderStatus) => s.key !== null || !s.info.keyRequired;

export function ProvidersDialog({
  control,
  currentModel,
  onPick,
  onClose,
}: {
  control: ProviderControl;
  currentModel: string;
  onPick(model: string): void;
  onClose(message?: string): void;
}) {
  const theme = useTheme();
  const [statuses, setStatuses] = useState<ProviderStatus[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [step, setStep] = useState<Step>({ kind: "list" });
  const [selected, setSelected] = useState(0);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = () =>
    control.status().then(
      (s) => setStatuses(s),
      (e: Error) => setLoadError(e.message),
    );
  useEffect(() => void refresh(), []); // eslint-disable-line react-hooks/exhaustive-deps

  const openModels = (status: ProviderStatus) => {
    setStep({ kind: "models", status, models: null });
    setSelected(0);
    setInput("");
    const controller = new AbortController();
    control.models(status.info.id, controller.signal).then(
      (models) => setStep((s) => (s.kind === "models" && s.status === status ? { ...s, models } : s)),
      (e: Error) => setStep((s) => (s.kind === "models" && s.status === status ? { ...s, models: [], error: e.message } : s)),
    );
  };

  const filtered = step.kind === "models" && step.models ? step.models.filter((m) => m.toLowerCase().includes(input.toLowerCase())) : [];

  useInput((ch, key) => {
    if (busy) return;
    if (step.kind === "list") {
      if (!statuses) return key.escape ? onClose() : undefined;
      if (key.escape) return onClose();
      if (key.upArrow) return setSelected((s) => Math.max(0, s - 1));
      if (key.downArrow) return setSelected((s) => Math.min(statuses.length - 1, s + 1));
      const current = statuses[selected];
      if (!current) return;
      if (key.return) {
        if (ready(current)) return openModels(current);
        setInput("");
        return setStep({ kind: "key", status: current });
      }
      if (ch === "k" && current.info.keyRequired) {
        setInput("");
        return setStep({ kind: "key", status: current });
      }
      if (ch === "d" && current.key?.kind === "saved") {
        setBusy(true);
        void control
          .disconnect(current.info.id)
          .then(refresh)
          .catch((e: Error) => setLoadError(e.message))
          .finally(() => setBusy(false));
      }
      return;
    }
    if (key.escape) {
      setInput("");
      return setStep({ kind: "list" });
    }
    if (step.kind === "key") {
      if (key.return) {
        setBusy(true);
        void control.connect(step.status.info.id, input).then(
          async () => {
            setBusy(false);
            setInput("");
            try {
              const all = await control.status();
              setStatuses(all);
              openModels(all.find((s) => s.info.id === step.status.info.id) ?? step.status);
            } catch (e) {
              setStep({ ...step, error: (e as Error).message });
            }
          },
          (e: Error) => {
            setBusy(false);
            setStep({ ...step, error: e.message });
          },
        );
        return;
      }
      if (key.backspace || key.delete) return setInput((v) => v.slice(0, -1));
      if (ch && !key.ctrl && !key.meta) return setInput((v) => v + ch.replace(/[\r\n]/g, ""));
      return;
    }
    // models
    if (key.upArrow) return setSelected((s) => Math.max(0, s - 1));
    if (key.downArrow) return setSelected((s) => Math.min(Math.max(0, filtered.length - 1), s + 1));
    if (key.return) {
      // With no list (or no match) the typed text is taken as the model id.
      const model = filtered[selected] ?? input.trim();
      if (model) onPick(`${step.status.info.id}/${model}`);
      return;
    }
    if (key.backspace || key.delete) {
      setSelected(0);
      return setInput((v) => v.slice(0, -1));
    }
    if (ch && !key.ctrl && !key.meta) {
      setSelected(0);
      return setInput((v) => v + ch.replace(/[\r\n]/g, ""));
    }
  });

  // Every step shares the Pane frame; only the title, body and key hints change.
  const frame = (title: string, body: ReactNode, footer: string, aside?: string) => (
    <Pane title={title} footer={footer} aside={aside}>
      <Box flexDirection="column">{body}</Box>
    </Pane>
  );
  const cursor = (active: boolean) => <Text color={theme.accent}>{active ? "❯ " : "  "}</Text>;

  if (step.kind === "key") {
    const { info } = step.status;
    return frame(
      `Connect ${info.name}`,
      <>
        {info.keyURL ? <Text color={theme.muted}>Create a key at {info.keyURL}</Text> : null}
        <Text>
          API key: {"•".repeat(Math.min(input.length, 40))}
          {input.length > 40 ? ` (${input.length} characters)` : ""}
          <Text color={theme.accent}>▏</Text>
        </Text>
        <Text color={theme.muted}>
          Saved to ~/.tropos/credentials.json, readable only by you.{info.keyEnv[0] ? ` ${info.keyEnv[0]} takes precedence when set.` : ""}
        </Text>
        {step.error ? <Text color={theme.danger}>{sanitizeForTerminal(step.error)}</Text> : null}
      </>,
      busy ? "saving…" : "paste the key, then enter · esc to go back",
    );
  }

  if (step.kind === "models") {
    const { info } = step.status;
    const first = windowStart(selected, filtered.length, VISIBLE);
    return frame(
      `${info.name} models`,
      <>
        <Text>
          <Text color={theme.muted}>⌕ </Text>
          {sanitizeForTerminal(input)}
          <Text color={theme.accent}>▏</Text>
        </Text>
        {step.models === null ? <Text color={theme.muted}>Loading models…</Text> : null}
        {step.error ? (
          <Text color={theme.warning}>Could not list models: {sanitizeForTerminal(step.error)}. Type a model id and press enter.</Text>
        ) : null}
        {step.models && step.models.length > 0 && filtered.length === 0 ? <Text color={theme.muted}>No match; enter uses “{sanitizeForTerminal(input)}” as the model id.</Text> : null}
        {filtered.slice(first, first + VISIBLE).map((m, i) => {
          const index = first + i;
          const full = `${info.id}/${m}`;
          return (
            <Text key={m}>
              {cursor(index === selected)}
              <Text color={index === selected ? theme.accent : undefined} bold={index === selected}>
                {sanitizeForTerminal(m)}
              </Text>
              {full === currentModel ? <Text color={theme.muted}> (current)</Text> : null}
            </Text>
          );
        })}
        {filtered.length > VISIBLE ? <Text color={theme.muted}>{filtered.length} models · type to narrow</Text> : null}
      </>,
      "type to filter · enter to use · esc to go back",
      step.models && step.models.length > 0 ? `${filtered.length} of ${step.models.length}` : undefined,
    );
  }

  const first = statuses ? windowStart(selected, statuses.length, VISIBLE) : 0;
  return frame(
    "Providers",
    <>
      {loadError ? <Text color={theme.danger}>{sanitizeForTerminal(loadError)}</Text> : null}
      {!statuses && !loadError ? <Text color={theme.muted}>Loading…</Text> : null}
      {statuses?.slice(first, first + VISIBLE).map((s, i) => {
        const index = first + i;
        const active = currentModel.startsWith(`${s.info.id}/`) || (s.info.id === "anthropic" && !currentModel.includes("/"));
        return (
          <Text key={s.info.id}>
            {cursor(index === selected)}
            <Text color={index === selected ? theme.accent : undefined} bold={index === selected}>
              {s.info.name.padEnd(16)}
            </Text>
            <Text color={ready(s) ? theme.success : theme.muted}>{ready(s) ? "●" : "○"} </Text>
            <Text color={theme.muted}>{keyLabel(s)}</Text>
            {active ? <Text color={theme.accent}> · in use</Text> : null}
          </Text>
        );
      })}
    </>,
    busy ? "working…" : "enter to pick a model (asks for a key first if needed) · k new key · d remove saved key · esc to close",
  );
}
