// src/ui/ModelPicker.tsx — /model without an argument: search every connected provider's models, keep favorites and recents, set effort.
import { Box, Text, useInput } from "ink";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Effort } from "../config/constants";
import type { ProviderStatus } from "../providers/router";
import { Pane } from "./design/Pane";
import { SelectList, type SelectItem } from "./design/SelectList";
import { buildRows, canonicalModelId, EFFORT_GLYPH, initialSelection, moveSelection, stepEffort, type PickerRow, type ProviderModels } from "./model-list";
import type { ModelPrefsControl, ProviderControl } from "./runtime";
import { sanitizeForTerminal } from "./terminal-safe";
import { useTheme } from "./theme-context";

/** Rows of the list window; section headers come on top, so the pane stays a predictable height. */
const VISIBLE = 12;
const PAGE = 10;

export interface ModelPickerProps {
  control: ProviderControl;
  prefs: ModelPrefsControl;
  currentModel: string;
  effort: Effort;
  onPick(model: string, effort: Effort): void;
  onClose(): void;
  /** ctrl+a: open /providers to connect another provider. */
  onConnect(): void;
}

type Listing = { models: string[] | null; error?: string };

/** Same rule as /providers: a provider is usable when it has a key or doesn't need one. */
const isReady = (s: ProviderStatus) => s.key !== null || !s.info.keyRequired;

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * The model picker. Every ready provider's models load in parallel so one slow or failing provider
 * only affects its own section. The selection is remembered by row key (and model id), not index, so
 * it stays put while sections finish loading or a favorite moves between sections.
 */
export function ModelPicker({ control, prefs, currentModel, effort: initialEffort, onPick, onClose, onConnect }: ModelPickerProps) {
  const theme = useTheme();
  const [statuses, setStatuses] = useState<ProviderStatus[] | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [listings, setListings] = useState<Record<string, Listing>>({});
  const [saved, setSaved] = useState<{ recent: string[]; favorites: string[] }>({ recent: [], favorites: [] });
  const [query, setQuery] = useState("");
  const [chosen, setChosen] = useState<{ key: string; id: string } | null>(null);
  const [effort, setEffort] = useState<Effort>(initialEffort);
  // A ref, not state: a key that arrives after a save has settled but before React re-renders must not be dropped,
  // and two keys in one burst must not both start a save.
  const busy = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    const live = () => !controller.signal.aborted;
    prefs.get().then(
      (p) => live() && setSaved(p),
      () => {}, // recents and favorites are conveniences; the picker works without them
    );
    control.status().then(
      (all) => {
        if (!live()) return;
        setStatuses(all);
        const ready = all.filter(isReady);
        setListings(Object.fromEntries(ready.map((s) => [s.info.id, { models: null }])));
        for (const s of ready) {
          const id = s.info.id;
          control.models(id, controller.signal).then(
            (models) => live() && setListings((l) => ({ ...l, [id]: { models } })),
            (e: unknown) => live() && setListings((l) => ({ ...l, [id]: { models: [], error: message(e) } })),
          );
        }
      },
      (e: unknown) => live() && setStatusError(message(e)),
    );
    return () => controller.abort();
  }, [control, prefs]);

  const rows = useMemo(() => {
    const all = statuses ?? [];
    const providers: ProviderModels[] = all.filter(isReady).map((s) => ({ id: s.info.id, name: s.info.name, models: listings[s.info.id]?.models ?? null, error: listings[s.info.id]?.error }));
    const known = all.map((s) => ({ id: s.info.id, name: s.info.name }));
    return buildRows({ providers, known, recent: saved.recent, favorites: saved.favorites, current: currentModel, query });
  }, [statuses, listings, saved, currentModel, query]);

  const selected = resolveSelection(rows, chosen);
  const row = rows[selected];
  const model = row?.kind === "model" ? row : undefined;

  const move = (delta: number) => {
    const next = rows[moveSelection(rows, selected, delta)];
    if (next) setChosen({ key: next.key, id: next.kind === "model" ? next.id : "" });
  };

  const pick = async () => {
    if (!model) return;
    busy.current = true;
    try {
      await prefs.recordUse(model.id);
    } catch {
      // Not being able to remember a recent model must not block switching to it.
    }
    busy.current = false;
    onPick(model.id, effort);
  };

  const toggleFavorite = async () => {
    if (!model) return;
    busy.current = true;
    try {
      await prefs.toggleFavorite(model.id);
      setSaved(await prefs.get());
    } catch {
      // Same as above: favorites are optional.
    } finally {
      busy.current = false;
    }
  };

  useInput((ch, key) => {
    if (busy.current) return;
    if (key.escape) {
      if (query) {
        setQuery("");
        return setChosen(null);
      }
      return onClose();
    }
    if (key.upArrow || (key.ctrl && ch === "p")) return move(-1);
    if (key.downArrow || (key.ctrl && ch === "n")) return move(1);
    if (key.pageUp) return move(-PAGE);
    if (key.pageDown) return move(PAGE);
    if (key.leftArrow) return setEffort((e) => stepEffort(e, -1));
    if (key.rightArrow) return setEffort((e) => stepEffort(e, 1));
    if (key.return) return void pick();
    if (key.ctrl && ch === "f") return void toggleFavorite();
    if (key.ctrl && ch === "a") return onConnect();
    if (key.backspace || key.delete) {
      setChosen(null);
      return setQuery((q) => q.slice(0, -1));
    }
    if (ch && !key.ctrl && !key.meta && !key.tab) {
      setChosen(null);
      setQuery((q) => q + ch.replace(/[\r\n\t]/g, ""));
    }
  });

  const items = rows.map((r) => toItem(r, theme));
  const empty = query
    ? `No models match “${sanitizeForTerminal(query)}”.`
    : statuses
      ? "No provider is connected. Press ctrl+a to connect one."
      : "Loading providers…";

  return (
    <Pane title="Select model" subtitle={canonicalModelId(currentModel)} footer="↑↓ move · enter select · ctrl+f favorite · ctrl+a connect provider · esc close">
      <Text>
        <Text color={theme.muted}>⌕ </Text>
        {sanitizeForTerminal(query)}
        <Text color={theme.accent}>▏</Text>
        {query ? null : <Text color={theme.subtle}>type to search</Text>}
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {statusError ? <Text color={theme.danger}>{`Could not load providers: ${sanitizeForTerminal(statusError)}`}</Text> : <SelectList items={items} selected={selected} visible={VISIBLE} empty={empty} />}
      </Box>
      <Box marginTop={1}>
        <Text>
          <Text color={theme.accent}>{`${EFFORT_GLYPH[effort]} `}</Text>
          <Text bold>{effort}</Text>
          <Text color={theme.muted}>{" effort  ← → to adjust"}</Text>
        </Text>
      </Box>
    </Pane>
  );
}

/** The chosen row if it is still listed, else the same model elsewhere (it may have moved to Favorites), else the default. */
function resolveSelection(rows: PickerRow[], chosen: { key: string; id: string } | null): number {
  if (chosen) {
    const byKey = rows.findIndex((r) => r.key === chosen.key);
    if (byKey !== -1) return byKey;
    const byId = rows.findIndex((r) => r.kind === "model" && r.id === chosen.id);
    if (byId !== -1) return byId;
  }
  return initialSelection(rows);
}

/** Every row gets a mark (blank unless current) so labels line up in one column. */
function toItem(r: PickerRow, theme: ReturnType<typeof useTheme>): SelectItem {
  if (r.kind === "note") {
    return { key: r.key, section: r.section, label: r.text, mark: { glyph: " ", color: theme.muted }, ...(r.tone === "warning" ? { color: theme.warning } : { disabled: true }) };
  }
  return {
    key: r.key,
    section: r.section,
    label: r.model,
    hint: r.favorite ? "★" : undefined,
    aside: r.showProvider ? r.providerName : undefined,
    mark: r.current ? { glyph: "●", color: theme.success } : { glyph: " ", color: theme.muted },
  };
}
