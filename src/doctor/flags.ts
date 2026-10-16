// src/doctor/flags.ts — the tiny flag parser the doctor, status and security commands share.
export interface FlagSpec {
  bool: readonly string[];
  value: readonly string[];
}

export type ParsedFlags = { ok: true; bool: Set<string>; value: Map<string, string>; rest: string[] } | { ok: false; error: string };

/** `--flag`, `--name value` and `--name=value`. Anything else starting with `-` is an error; words are returned in `rest`. */
export function parseFlags(argv: readonly string[], spec: FlagSpec): ParsedFlags {
  const bool = new Set<string>();
  const value = new Map<string, string>();
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) {
      if (arg.startsWith("-") && arg !== "-") return { ok: false, error: `unknown option ${arg}` };
      rest.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    if (spec.bool.includes(name)) {
      if (eq !== -1) return { ok: false, error: `--${name} takes no value` };
      bool.add(name);
    } else if (spec.value.includes(name)) {
      const v = eq === -1 ? argv[++i] : arg.slice(eq + 1);
      if (v === undefined || v === "" || (eq === -1 && v.startsWith("--"))) return { ok: false, error: `--${name} needs a value` };
      value.set(name, v);
    } else return { ok: false, error: `unknown option --${name}` };
  }
  return { ok: true, bool, value, rest };
}
