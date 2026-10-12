const IGNORED = /(^|\/)(node_modules|\.git)\//;

/** Relative file paths under `base` matching `pattern`, skipping node_modules/.git unless the pattern names them. */
export async function* walkFiles(base: string, pattern: string): AsyncGenerator<string> {
  const includeIgnored = /node_modules|\.git/.test(pattern);
  const glob = new Bun.Glob(pattern);
  for await (const rel of glob.scan({ cwd: base, onlyFiles: true, dot: true, followSymlinks: false })) {
    if (!includeIgnored && IGNORED.test(rel)) continue;
    yield rel;
  }
}
