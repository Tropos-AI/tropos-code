// src/web/assets.ts — the browser app's files: embedded in the compiled binary, or read from web/dist when run from source.
import { existsSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";

/** Request path ("/assets/index-abc.js") → a path Bun.file can read (on disk or in the binary's $bunfs). */
export type AssetMap = Map<string, string>;

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".txt": "text/plain; charset=utf-8",
  ".webp": "image/webp",
};

export function contentType(path: string): string {
  return TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

/** Every file under `dist`, keyed by its URL path. */
export function assetsFromDir(dist: string): AssetMap {
  const map: AssetMap = new Map();
  if (!existsSync(dist)) return map;
  for (const file of walk(dist)) map.set(`/${relative(dist, file).split(sep).join("/")}`, file);
  return map;
}

/** web/dist next to the sources, for `bun src/index.ts web` and tests. */
export const SOURCE_DIST = join(import.meta.dir, "..", "..", "web", "dist");

/**
 * The build (build.ts) provides the virtual module `tcode:web-assets` with every web/dist file imported
 * `with { type: "file" }`, so `bun build --compile` embeds them. From source that module doesn't exist,
 * and the files are read from web/dist instead.
 */
export async function loadAssets(fallbackDir = SOURCE_DIST): Promise<AssetMap> {
  try {
    const embedded = (await import("tcode:web-assets")) as { ASSETS: Record<string, string> };
    return new Map(Object.entries(embedded.ASSETS));
  } catch {
    return assetsFromDir(fallbackDir);
  }
}
