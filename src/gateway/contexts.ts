// src/gateway/contexts.ts — the gateway's project contexts: one per project directory, shared by its sessions, and
// replaced on reload without closing what a running session still uses (its MCP servers, say).
import type { ProjectContext } from "../cli/context";
import type { Project } from "./projects";

interface Slot {
  pending: Promise<ProjectContext>;
  holders: number;
  /** Replaced by a reload: closed once nobody holds it. */
  stale: boolean;
  closing?: Promise<void>;
}

export class ProjectContexts {
  /** The context new sessions get, by project path. */
  private readonly current = new Map<string, Slot>();
  /** Every context not yet closed, current or stale. */
  private readonly open = new Set<Slot>();
  private readonly closing = new Set<Promise<void>>();

  constructor(private readonly load: (project: Project) => Promise<ProjectContext>) {}

  /** The project's current context, loaded the first time; `release` when the session using it ends. */
  async acquire(project: Project): Promise<{ pc: ProjectContext; release(): void }> {
    let slot = this.current.get(project.path);
    if (!slot) {
      const fresh: Slot = { pending: this.load(project), holders: 0, stale: false };
      // Not cached: once the cause is fixed (a settings file, say), the next session loads again.
      fresh.pending.catch(() => {
        if (this.current.get(project.path) === fresh) this.current.delete(project.path);
        this.open.delete(fresh);
      });
      this.current.set(project.path, fresh);
      this.open.add(fresh);
      slot = fresh;
    }
    // Counted before the load finishes, so an invalidate meanwhile can't close it under this caller.
    const held = slot;
    held.holders++;
    let pc: ProjectContext;
    try {
      pc = await held.pending;
    } catch (e) {
      held.holders--;
      throw e;
    }
    let released = false;
    return {
      pc,
      release: () => {
        if (released) return;
        released = true;
        held.holders--;
        if (held.stale && held.holders === 0) this.close(held);
      },
    };
  }

  /** Later acquires load afresh; each old context closes once its last holder releases it. */
  invalidate(): void {
    for (const slot of this.current.values()) {
      slot.stale = true;
      if (slot.holders === 0) this.close(slot);
    }
    this.current.clear();
  }

  /** The gateway is stopping: closes every context, held or not. */
  async closeAll(): Promise<void> {
    this.current.clear();
    for (const slot of [...this.open]) this.close(slot);
    await Promise.all([...this.closing]);
  }

  private close(slot: Slot): void {
    if (slot.closing) return;
    this.open.delete(slot);
    const closing = slot.pending.then((pc) => pc.close()).catch(() => {});
    slot.closing = closing;
    this.closing.add(closing);
    void closing.then(() => this.closing.delete(closing));
  }
}
