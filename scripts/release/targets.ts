// scripts/release/targets.ts
import type { Platform } from "../../src/install/platform";

/** Release platform → Bun compile target (spec §5.1). Order matches PLATFORMS. */
export const RELEASE_TARGETS: Record<Platform, Bun.Build.CompileTarget> = {
  "darwin-arm64": "bun-darwin-arm64",
  "darwin-x64": "bun-darwin-x64",
  "linux-x64": "bun-linux-x64",
  "linux-arm64": "bun-linux-arm64",
  "linux-x64-musl": "bun-linux-x64-musl",
  "linux-arm64-musl": "bun-linux-arm64-musl",
};
