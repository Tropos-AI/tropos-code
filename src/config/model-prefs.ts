// src/config/model-prefs.ts
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { ModelPrefsControl } from "../ui/runtime";

/** How many recently used models the /model picker remembers. */
export const MAX_RECENT = 10;

const fileSchema = z.object({
  recent: z.array(z.string()).optional(),
  favorites: z.array(z.string()).optional(),
});

type Prefs = { recent: string[]; favorites: string[] };

/**
 * Recently used and favorite models, in `<home>/models.json`. A damaged file reads as empty: these are
 * conveniences, never a reason to fail. Writes go through a temp file and rename.
 */
export class ModelPrefs implements ModelPrefsControl {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly home: string) {}

  get path(): string {
    return join(this.home, "models.json");
  }

  async get(): Promise<Prefs> {
    try {
      const parsed = fileSchema.safeParse(JSON.parse(await readFile(this.path, "utf8")));
      if (!parsed.success) return { recent: [], favorites: [] };
      return { recent: parsed.data.recent ?? [], favorites: parsed.data.favorites ?? [] };
    } catch {
      return { recent: [], favorites: [] };
    }
  }

  recordUse(model: string): Promise<void> {
    return this.update((p) => ({ ...p, recent: [model, ...p.recent.filter((m) => m !== model)].slice(0, MAX_RECENT) })).then(() => {});
  }

  async toggleFavorite(model: string): Promise<boolean> {
    const next = await this.update((p) =>
      p.favorites.includes(model) ? { ...p, favorites: p.favorites.filter((m) => m !== model) } : { ...p, favorites: [model, ...p.favorites] },
    );
    return next.favorites.includes(model);
  }

  /** Changes are queued so two quick updates can't lose one another. */
  private update(change: (p: Prefs) => Prefs): Promise<Prefs> {
    const run = this.queue.then(async () => {
      const next = change(await this.get());
      await mkdir(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.${process.pid}.tmp`;
      await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
      await rename(tmp, this.path);
      return next;
    });
    this.queue = run.catch(() => {});
    return run;
  }
}
