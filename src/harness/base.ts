// src/harness/base.ts — the built-in harness tree, compiled into the binary. Overlays in ~/.tropos/harness replace its
// files one by one (src/harness/tree.ts).
import system from "./base/system.md" with { type: "text" };
import type { HarnessTree } from "./tree";

export const BASE_TREE: HarnessTree = new Map([["system.md", system]]);
