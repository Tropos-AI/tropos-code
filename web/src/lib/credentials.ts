// web/src/lib/credentials.ts — where this browser keeps its device key. localStorage when it works; when it is blocked
// (private window, site data off) the key lives in memory for this tab and `persistent` says it will be forgotten.
import { DEVICE_KEY_STORAGE } from "@core/web/protocol";

export interface Credentials {
  load(): string | null;
  save(key: string): void;
  clear(): void;
  /** False once storage proved unusable: the login will not survive a reload. */
  readonly persistent: boolean;
}

export function localCredentials(storage: () => Storage = () => window.localStorage): Credentials {
  let memory: string | null = null;
  let persistent = true;
  try {
    storage().getItem(DEVICE_KEY_STORAGE);
  } catch {
    persistent = false;
  }
  return {
    get persistent() {
      return persistent;
    },
    load() {
      if (memory !== null) return memory;
      try {
        return storage().getItem(DEVICE_KEY_STORAGE);
      } catch {
        persistent = false;
        return null;
      }
    },
    save(key) {
      memory = key;
      try {
        storage().setItem(DEVICE_KEY_STORAGE, key);
      } catch {
        persistent = false;
      }
    },
    clear() {
      memory = null;
      try {
        storage().removeItem(DEVICE_KEY_STORAGE);
      } catch {
        persistent = false;
      }
    },
  };
}
