// src/ui/model-list.ts — the /model picker's rows: sections, fuzzy search and ordering, kept free of React so it can be unit-tested.
import { EFFORTS, type Effort } from "../config/constants";

/** One provider as the picker sees it. `models` is null while its list is still loading. */
export interface ProviderModels {
  id: string;
  name: string;
  models: string[] | null;
  /** Why listing failed; the section then says so instead of showing models. */
  error?: string;
}

/** A pickable model. `id` is what the rest of the app uses (`deepseek/deepseek-chat`, or a bare Anthropic id). */
export interface ModelRow {
  kind: "model";
  key: string;
  section?: string;
  id: string;
  /** The model part of the id, shown as the label. */
  model: string;
  providerName: string;
  /** Show the provider as an aside: in Favorites, Recent and search results, where rows from many providers mix. */
  showProvider: boolean;
  favorite: boolean;
  current: boolean;
}

/** A non-selectable line inside a section ("Loading…", "Could not list models: …"). */
export interface NoteRow {
  kind: "note";
  key: string;
  section?: string;
  text: string;
  tone: "muted" | "warning";
}

export type PickerRow = ModelRow | NoteRow;

export interface RowInput {
  providers: ProviderModels[];
  recent: string[];
  favorites: string[];
  current: string;
  query: string;
  /** Every provider, ready or not, for naming Favorites and Recent rows; `providers` by default. */
  known?: Pick<ProviderModels, "id" | "name">[];
}

const ANTHROPIC = "anthropic";

/**
 * The id the app stores for a provider's model. Anthropic models stay bare (`claude-opus-5-5`) because
 * that is how settings, `/model <id>` and the router's parseModelId have always named them.
 */
export function modelId(providerId: string, model: string): string {
  return providerId === ANTHROPIC ? model : `${providerId}/${model}`;
}

/** `anthropic/claude-x` and `claude-x` are the same model; compare and dedupe on the bare form. */
export function canonicalModelId(id: string): string {
  return id.startsWith(`${ANTHROPIC}/`) ? id.slice(ANTHROPIC.length + 1) : id;
}

/** Splits an id the way the router does: a known provider prefix names the provider; anything else is Anthropic. */
export function splitModelId(id: string, providers: Pick<ProviderModels, "id" | "name">[]): { providerId: string; providerName: string; model: string } {
  const bare = canonicalModelId(id);
  const slash = bare.indexOf("/");
  const named = slash > 0 ? providers.find((p) => p.id === bare.slice(0, slash)) : undefined;
  if (named) return { providerId: named.id, providerName: named.name, model: bare.slice(slash + 1) };
  const anthropic = providers.find((p) => p.id === ANTHROPIC);
  return { providerId: ANTHROPIC, providerName: anthropic?.name ?? "Anthropic", model: bare };
}

const BOUNDARY = /[/\-_.: ]/;

/**
 * Subsequence match of `query` in `text`, case-insensitive, spaces ignored. Higher is better; null means
 * no match. Consecutive letters, word starts and an early first hit score higher, so "opus" ranks
 * `claude-opus-…` above a model that merely contains o…p…u…s.
 */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.toLowerCase().replace(/\s+/g, "");
  if (!q) return 0;
  const t = text.toLowerCase();
  let score = 0;
  let from = 0;
  let prev = -2;
  let first = -1;
  for (const ch of q) {
    const at = t.indexOf(ch, from);
    if (at === -1) return null;
    if (first === -1) first = at;
    score += at === prev + 1 ? 3 : 1;
    if (at === 0 || BOUNDARY.test(t[at - 1]!)) score += 2;
    prev = at;
    from = at + 1;
  }
  if (t.includes(q)) score += q.length * 2;
  return score - first / 100;
}

/**
 * Rows for the picker. Without a query: Favorites, Recent (minus favorites), then one section per
 * provider with its models, a loading note or its error. With a query: one flat list of every known
 * model that matches `provider/model` or the provider's name, favorites first, then by match quality.
 */
export function buildRows({ providers, recent, favorites, current, query, known = providers }: RowInput): PickerRow[] {
  const favs = unique(favorites.map(canonicalModelId));
  const favSet = new Set(favs);
  const cur = canonicalModelId(current);
  const row = (id: string, section: string | undefined, showProvider: boolean): ModelRow => {
    const { providerName, model } = splitModelId(id, known);
    return { kind: "model", key: `${section ?? "match"}:${id}`, section, id, model, providerName, showProvider, favorite: favSet.has(id), current: id === cur };
  };

  if (query.trim()) {
    const all = unique([
      ...favs,
      ...recent.map(canonicalModelId),
      ...providers.flatMap((p) => (p.models ?? []).map((m) => modelId(p.id, m))),
    ]);
    const scored: { id: string; score: number; order: number }[] = [];
    all.forEach((id, order) => {
      const { providerId, providerName, model } = splitModelId(id, known);
      const a = fuzzyScore(query, `${providerId}/${model}`);
      const b = fuzzyScore(query, providerName);
      if (a === null && b === null) return;
      scored.push({ id, score: Math.max(a ?? -Infinity, b ?? -Infinity), order });
    });
    scored.sort((x, y) => Number(favSet.has(y.id)) - Number(favSet.has(x.id)) || y.score - x.score || x.order - y.order);
    return scored.map((s) => row(s.id, undefined, true));
  }

  const rows: PickerRow[] = [];
  for (const id of favs) rows.push(row(id, "Favorites", true));
  for (const id of unique(recent.map(canonicalModelId))) if (!favSet.has(id)) rows.push(row(id, "Recent", true));
  for (const p of providers) {
    const section = p.name;
    if (p.error !== undefined) rows.push({ kind: "note", key: `${p.id}:error`, section, text: shortError(p.error), tone: "warning" });
    else if (p.models === null) rows.push({ kind: "note", key: `${p.id}:loading`, section, text: "Loading…", tone: "muted" });
    else if (p.models.length === 0) rows.push({ kind: "note", key: `${p.id}:empty`, section, text: "No models listed", tone: "muted" });
    else for (const m of p.models) rows.push(row(modelId(p.id, m), section, false));
  }
  return rows;
}

/** Index after moving `delta` rows from `from`, skipping notes and stopping at the ends. -1 when nothing is selectable. */
export function moveSelection(rows: PickerRow[], from: number, delta: number): number {
  const selectable = rows.flatMap((r, i) => (r.kind === "model" ? [i] : []));
  if (selectable.length === 0) return -1;
  const pos = selectable.indexOf(from);
  if (pos === -1) return selectable[0]!;
  return selectable[Math.max(0, Math.min(selectable.length - 1, pos + delta))]!;
}

/** Where the cursor starts: the current model if it is listed, otherwise the first model. */
export function initialSelection(rows: PickerRow[]): number {
  const current = rows.findIndex((r) => r.kind === "model" && r.current);
  return current !== -1 ? current : moveSelection(rows, -1, 0);
}

/** Effort glyphs, filling up from low to max. */
export const EFFORT_GLYPH: Record<Effort, string> = { low: "○", medium: "◔", high: "◑", xhigh: "◕", max: "●" };

/** The next effort level up or down, stopping at low and max. */
export function stepEffort(effort: Effort, delta: number): Effort {
  const i = EFFORTS.indexOf(effort);
  return EFFORTS[Math.max(0, Math.min(EFFORTS.length - 1, i + delta))]!;
}

function unique(ids: string[]): string[] {
  return [...new Set(ids)];
}

/** One short line for a provider whose model list failed: a local server that isn't running says just that. */
export function shortError(error: string): string {
  if (/could not reach|unable to connect|ECONNREFUSED/i.test(error)) return "Not running";
  const first = error.split("\n")[0]!.trim();
  const text = `Could not list models: ${first}`;
  return text.length > 70 ? `${text.slice(0, 69)}…` : text;
}
