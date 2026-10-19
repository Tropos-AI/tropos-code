// web/src/components/chat/ModelPicker.tsx — "Select model", the web twin of src/ui/ModelPicker:
// rows from @core/ui/model-list (Favorites, Recent, one section per ready provider; one ranked list while searching),
// every ready provider's models loading in parallel, a star per row, effort on Interior Slider Detents. The search field
// is a combobox over the listbox: ↑↓ move, Enter picks, Ctrl+F stars, Esc clears the search, then closes.
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";

import { EFFORTS, type Effort } from "@core/config/constants";
import { buildRows, EFFORT_GLYPH, initialSelection, moveSelection, type ModelRow, type PickerRow, type ProviderModels } from "@core/ui/model-list";
import type { ProviderInfoView } from "@core/web/protocol";

import { hrefFor } from "@/app/routes";
import { Modal } from "@/components/interior/modal";
import { SliderDetents } from "@/components/interior/slider-detents";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Kbd } from "@/components/ui/kbd";
import { errorMessage, useAppStore, useSessionState } from "@/lib/store";
import { cn } from "@/lib/utils";

/** Same rule as /providers: a provider is usable when it has a key or doesn't need one. */
const isReady = (p: ProviderInfoView) => p.key !== null || !p.keyRequired;

type Listing = { models: string[] | null; error?: string };
type Prefs = { recent: string[]; favorites: string[] };

const EFFORT_DETENTS = EFFORTS.map((effort, i) => ({ value: i, label: EFFORT_GLYPH[effort] }));

/** Loads providers, their models and the user's model preferences once per opening. */
function usePickerData() {
  const store = useAppStore();
  const [providers, setProviders] = useState<ProviderInfoView[] | null>(null);
  const [listings, setListings] = useState<Record<string, Listing>>({});
  const [prefs, setPrefs] = useState<Prefs>({ recent: [], favorites: [] });
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    store.rpc("modelPrefs.get").then(
      (p) => live && setPrefs(p),
      () => {},
    );
    store.rpc("providers.status").then(
      (list) => {
        if (!live) return;
        setProviders(list);
        for (const p of list.filter(isReady)) {
          store.rpc("providers.models", p.id).then(
            (models) => live && setListings((all) => ({ ...all, [p.id]: { models } })),
            (error: unknown) => live && setListings((all) => ({ ...all, [p.id]: { models: null, error: errorMessage(error) } })),
          );
        }
      },
      (error: unknown) => live && setFailed(errorMessage(error)),
    );
    return () => {
      live = false;
    };
  }, [store]);

  return { providers, listings, prefs, setPrefs, failed };
}

function ModelOption({ row, selected, id, onPick, onHover, onStar }: { row: ModelRow; selected: boolean; id: string; onPick: () => void; onHover: () => void; onStar: () => void }) {
  return (
    <li
      id={id}
      role="option"
      aria-selected={selected}
      aria-label={`${row.id}${row.current ? ", current" : ""}${row.favorite ? ", favourite" : ""}`}
      onMouseDown={(event) => event.preventDefault()}
      onPointerMove={() => !selected && onHover()}
      onClick={onPick}
      className={cn(
        "group flex h-10 cursor-pointer items-center gap-2.5 rounded-[9px] pl-3 pr-1.5 transition-colors duration-100",
        selected ? "bg-accent-wash shadow-[inset_2px_0_0_var(--accent)]" : "hover:bg-paper-2",
      )}
    >
      <span className={cn("min-w-0 flex-1 truncate font-mono text-[13px]", row.current ? "font-semibold text-ink" : "text-ink")}>{row.model}</span>
      {row.showProvider ? <span className="shrink-0 text-[12px] text-ink-3">{row.providerName}</span> : null}
      {row.current ? (
        <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-ok-wash px-2 py-0.5 text-[11px] font-medium text-ok">
          <Icon name="check" size="sm" className="size-3" />
          Current
        </span>
      ) : null}
      {/* A pointer shortcut for Ctrl+F; the option's name already says whether it is a favourite. */}
      <button
        type="button"
        tabIndex={-1}
        aria-hidden
        title={row.favorite ? "Remove from favourites (Ctrl+F)" : "Add to favourites (Ctrl+F)"}
        onClick={(event) => {
          event.stopPropagation();
          onStar();
        }}
        className={cn(
          "grid size-7 shrink-0 place-items-center rounded-[7px] transition-[opacity,color,background-color] duration-150 hover:bg-surface",
          row.favorite ? "text-accent-ink" : "text-ink-3 opacity-0 group-hover:opacity-100 group-aria-selected:opacity-100",
        )}
      >
        <Icon name="star" size="sm" treatment={row.favorite ? "duotone" : "outline"} tone={row.favorite ? "accent" : "current"} />
      </button>
    </li>
  );
}

function NoteOption({ text, tone }: { text: string; tone: "muted" | "warning" }) {
  return (
    <li role="presentation" className={cn("flex h-9 items-center gap-2 px-3 text-[12.5px]", tone === "warning" ? "text-warn" : "text-ink-3")}>
      {tone === "warning" ? <Icon name="triangle-alert" size="sm" /> : <span aria-hidden className="size-1.5 animate-pulse-dot rounded-full bg-ink-4" />}
      {text}
    </li>
  );
}

function PickerBody({ onClose }: { onClose: () => void }) {
  const store = useAppStore();
  const session = useSessionState();
  const { providers, listings, prefs, setPrefs, failed } = usePickerData();
  const [query, setQuery] = useState("");
  const [chosen, setChosen] = useState<string | null>(null);
  const [effort, setEffort] = useState<Effort>(session?.effort ?? "high");
  const [picking, setPicking] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const baseId = useId();
  const listId = `${baseId}-list`;
  const optionId = useCallback((key: string) => `${baseId}-o-${key.replace(/[^a-zA-Z0-9_-]/g, "_")}`, [baseId]);

  const current = session?.model ?? "";
  const ready = useMemo<ProviderModels[]>(
    () => (providers ?? []).filter(isReady).map((p) => ({ id: p.id, name: p.name, models: listings[p.id]?.models ?? null, ...(listings[p.id]?.error ? { error: listings[p.id]!.error } : {}) })),
    [providers, listings],
  );
  const rows = useMemo<PickerRow[]>(
    () => buildRows({ providers: ready, recent: prefs.recent, favorites: prefs.favorites, current, query, known: providers ?? [] }),
    [ready, prefs, current, query, providers],
  );
  // The selection is remembered by row key, so it stays put while sections load; otherwise it starts on the current model.
  const found = chosen === null ? -1 : rows.findIndex((r) => r.key === chosen);
  const selectedIndex = found !== -1 ? found : initialSelection(rows);
  const selectedRow = rows[selectedIndex];

  useEffect(() => {
    if (selectedRow) document.getElementById(optionId(selectedRow.key))?.scrollIntoView?.({ block: "nearest" });
  }, [selectedRow, optionId]);

  const toggleFavorite = async (row: ModelRow) => {
    try {
      const on = await store.rpc("modelPrefs.toggleFavorite", row.id);
      setPrefs((p) => ({ ...p, favorites: on ? [...p.favorites.filter((f) => f !== row.id), row.id] : p.favorites.filter((f) => f !== row.id) }));
    } catch (error) {
      store.toast({ tone: "error", title: "Could not update favourites", description: errorMessage(error) });
    }
  };

  const pick = async (row: ModelRow) => {
    if (picking) return;
    setPicking(true);
    try {
      if (row.id !== current) await store.rpc("setModel", row.id);
      const effortChanged = effort !== session?.effort;
      if (effortChanged) await store.rpc("setEffort", effort);
      void store.rpc("modelPrefs.recordUse", row.id).catch(() => {});
      store.toast({ tone: "ok", title: `Model set to ${row.id}`, ...(effortChanged ? { description: `${effort} effort` } : {}) });
      onClose();
    } catch (error) {
      store.toast({ tone: "error", title: "Could not switch models", description: errorMessage(error) });
      setPicking(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const move = (delta: number) => {
      const next = moveSelection(rows, selectedIndex, delta);
      if (next >= 0) setChosen(rows[next]!.key);
    };
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      move(event.key === "ArrowDown" ? 1 : -1);
    } else if (event.key === "PageDown" || event.key === "PageUp") {
      event.preventDefault();
      move(event.key === "PageDown" ? 8 : -8);
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (selectedRow?.kind === "model") void pick(selectedRow);
    } else if (event.key === "f" && event.ctrlKey) {
      event.preventDefault();
      if (selectedRow?.kind === "model") void toggleFavorite(selectedRow);
    } else if (event.key === "Escape" && query) {
      event.preventDefault();
      event.stopPropagation();
      setQuery("");
      setChosen(null);
    }
  };

  // Rows grouped into their sections, in order.
  const groups: Array<{ section: string | undefined; rows: PickerRow[] }> = [];
  for (const row of rows) {
    const last = groups.at(-1);
    if (last && last.section === row.section) last.rows.push(row);
    else groups.push({ section: row.section, rows: [row] });
  }
  const noReady = providers !== null && ready.length === 0;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex h-10 items-center gap-2 rounded-[10px] border border-rule bg-paper-2 px-3 shadow-well focus-within:border-accent/50 focus-within:bg-surface focus-within:shadow-[0_0_0_3px_rgb(69_104_255/0.12)]">
        <span className="text-ink-3">
          <Icon name="search" size="sm" />
        </span>
        <input
          ref={searchRef}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setChosen(null);
          }}
          onKeyDown={onKeyDown}
          placeholder="Search models or providers"
          aria-label="Search models"
          role="combobox"
          aria-expanded
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={selectedRow?.kind === "model" ? optionId(selectedRow.key) : undefined}
          aria-keyshortcuts="Control+F"
          autoFocus
          className="h-full min-w-0 flex-1 bg-transparent text-[14px] text-ink outline-none placeholder:text-ink-3"
        />
      </div>

      <div className="scroll-quiet -mx-2 h-[min(360px,46vh)] overflow-y-auto overscroll-contain px-2">
        {failed ? (
          <p className="px-3 py-6 text-center text-[13px] text-error">Could not load providers: {failed}</p>
        ) : providers === null ? (
          <ul aria-busy="true" aria-label="Loading models" className="flex flex-col gap-1.5 pt-1">
            {["62%", "48%", "70%", "55%", "66%"].map((w) => (
              <li key={w} className="flex h-9 items-center px-3">
                <span className="h-2.5 rounded-[5px] bg-rule" style={{ width: w }} />
              </li>
            ))}
          </ul>
        ) : (
          <ul id={listId} role="listbox" aria-label="Models" className="flex flex-col gap-3">
            {groups.map((group) => (
              <li key={group.section ?? "matches"} role="presentation">
                <ul role="group" aria-label={group.section ?? "Matches"} className="flex flex-col gap-px">
                  {group.section ? (
                    <li role="presentation" className="type-meta px-3 pb-1 pt-0.5 text-ink-3">
                      {group.section}
                    </li>
                  ) : null}
                  {group.rows.map((row) =>
                    row.kind === "model" ? (
                      <ModelOption
                        key={row.key}
                        id={optionId(row.key)}
                        row={row}
                        selected={row === selectedRow}
                        onPick={() => void pick(row)}
                        onHover={() => setChosen(row.key)}
                        onStar={() => void toggleFavorite(row)}
                      />
                    ) : (
                      <NoteOption key={row.key} text={row.text} tone={row.tone} />
                    ),
                  )}
                </ul>
              </li>
            ))}
            {rows.length === 0 ? (
              <li role="presentation" className="px-3 py-8 text-center text-[13px] text-ink-3">
                {noReady ? "No provider is connected yet." : `No model matches “${query}”.`}
              </li>
            ) : null}
          </ul>
        )}
      </div>

      <div className="rounded-[12px] border border-rule bg-paper px-4 pb-2 pt-3">
        <SliderDetents
          label="Effort"
          value={EFFORTS.indexOf(effort)}
          onValueChange={(v) => setEffort(EFFORTS[Math.round(v)] ?? effort)}
          min={0}
          max={EFFORTS.length - 1}
          step={1}
          detents={EFFORT_DETENTS}
          format={(v) => EFFORTS[Math.round(v)] ?? ""}
          haptic={false}
        />
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-[11.5px] text-ink-3">
        <span className="inline-flex items-center gap-1">
          <Kbd>↑↓</Kbd> select
        </span>
        <span className="inline-flex items-center gap-1">
          <Kbd>⏎</Kbd> pick
        </span>
        <span className="inline-flex items-center gap-1">
          <Kbd>⌃F</Kbd> favourite
        </span>
        <span className="ml-auto">
          <Button
            variant="ghost"
            size="sm"
            icon="key"
            onClick={() => {
              onClose();
              window.location.hash = hrefFor("settings");
            }}
          >
            Connect a provider
          </Button>
        </span>
      </div>
    </div>
  );
}

export function ModelPicker({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Modal open={open} onClose={onClose} title="Select model" description="Favorites and recent first; type to search every connected provider." maxWidth={600}>
      {open ? <PickerBody onClose={onClose} /> : null}
    </Modal>
  );
}
