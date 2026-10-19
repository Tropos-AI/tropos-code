// web/src/lib/agent-activity.ts — the agents' live activity as the browser keeps it: a snapshot on login, then start,
// delta and end events from the server's feed (src/agents/activity.ts). Pure: app-state.ts reduces with it.
import type { ActivityEvent, ActivitySnapshot, AgentRunEnd, AgentRunView } from "@core/agents/activity";

export type ActivityState = ActivitySnapshot;
export type LiveState = "idle" | "working" | "waiting";

export const emptyActivity: ActivityState = { running: [], last: [] };

const MAX_LAST = 50;

export function applyActivity(state: ActivityState, event: ActivityEvent): ActivityState {
  switch (event.type) {
    case "start":
      return { ...state, running: [...state.running.filter((r) => r.id !== event.run.id), event.run] };
    case "delta": {
      if (!state.running.some((r) => r.id === event.id)) return state;
      const { type: _type, id, ...patch } = event;
      return { ...state, running: state.running.map((r) => (r.id === id ? { ...r, ...patch } : r)) };
    }
    case "end": {
      const run = event.run;
      const last = [run, ...state.last.filter((r) => r.kind !== run.kind || r.agent !== run.agent)].slice(0, MAX_LAST);
      return { running: state.running.filter((r) => r.id !== run.id), last };
    }
  }
}

/** The running runs of the chief (every chat) or of one specialist, oldest first. */
export function runsOf(state: ActivityState, kind: AgentRunView["kind"], agent?: string): AgentRunView[] {
  return state.running.filter((r) => r.kind === kind && (agent === undefined || r.agent === agent));
}

export function lastRunOf(state: ActivityState, kind: AgentRunView["kind"], agent?: string): AgentRunEnd | undefined {
  return state.last.find((r) => r.kind === kind && (agent === undefined || r.agent === agent));
}

/** Waiting for approval wins: that is what the owner must act on. */
export function liveState(runs: AgentRunView[]): LiveState {
  if (runs.length === 0) return "idle";
  return runs.some((r) => r.state === "waiting") ? "waiting" : "working";
}

/** Specialists working for this conversation right now. */
export function workingInSession(state: ActivityState, sessionId: string | undefined): number {
  if (!sessionId) return 0;
  return state.running.filter((r) => r.kind === "specialist" && r.session.id === sessionId).length;
}
