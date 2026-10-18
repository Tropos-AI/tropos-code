import { expect, test } from "bun:test";

import { localCredentials } from "@/lib/credentials";

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v), removeItem: (k: string) => void map.delete(k) } as unknown as Storage;
}

test("saves, loads and clears through storage, persistently", () => {
  const storage = memoryStorage();
  const c = localCredentials(() => storage);
  expect(c.load()).toBeNull();
  c.save("K");
  expect(localCredentials(() => storage).load()).toBe("K");
  expect(c.persistent).toBe(true);
  c.clear();
  expect(c.load()).toBeNull();
});

test("throwing storage keeps the key in memory and reports persistent=false", () => {
  const c = localCredentials(() => {
    throw new Error("SecurityError");
  });
  expect(c.persistent).toBe(false);
  c.save("K");
  expect(c.load()).toBe("K");
  c.clear();
  expect(c.load()).toBeNull();
});
