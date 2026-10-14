// web/src/lib/ui-store.ts — UI-only state shared by distant components (no server data): which global overlay is open.
import { useSyncExternalStore } from "react";

/** The chat's panels (opened by /help, /cost, /effort, /resume); the model picker has its own flag. */
export type ChatPanel = "help" | "cost" | "effort" | "resume";

export interface UiState {
  /** The "Select model" modal (opened from the top bar's model chip). */
  modelPickerOpen: boolean;
  panel: ChatPanel | null;
}

let state: UiState = { modelPickerOpen: false, panel: null };
const listeners = new Set<() => void>();

function set(patch: Partial<UiState>): void {
  state = { ...state, ...patch };
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export const ui = {
  openModelPicker: (): void => set({ modelPickerOpen: true, panel: null }),
  closeModelPicker: (): void => set({ modelPickerOpen: false }),
  openPanel: (panel: ChatPanel): void => set({ panel, modelPickerOpen: false }),
  closePanel: (): void => set({ panel: null }),
};

export function useModelPickerOpen(): boolean {
  return useSyncExternalStore(subscribe, () => state.modelPickerOpen, () => false);
}

export function useChatPanel(): ChatPanel | null {
  return useSyncExternalStore(subscribe, () => state.panel, () => null);
}
