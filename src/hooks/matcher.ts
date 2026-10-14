// src/hooks/matcher.ts

/** Plain names and `A|B` lists are compared literally, so `Edit` never matches `NotebookEdit` by accident. */
const NAME_LIST = /^[A-Za-z0-9_|]+$/;

/** Compiled matcher regexes; `null` remembers an invalid pattern so it is not recompiled on every call. */
const compiled = new Map<string, RegExp | null>();

function compile(pattern: string): RegExp | null {
  let re = compiled.get(pattern);
  if (re === undefined) {
    try {
      re = new RegExp(`^(?:${pattern})$`);
    } catch {
      re = null;
    }
    compiled.set(pattern, re);
  }
  return re;
}

/**
 * Whether a hook group's `matcher` applies to `value` (a tool name, agent type, session source or end reason).
 * An empty matcher or `*` matches everything; so does an undefined `value`, because events without a matcher
 * field (UserPromptSubmit, Stop) run every group. A regex that does not compile never matches: a typo in one
 * hook must not turn it into a catch-all.
 */
export function matchesHook(matcher: string | undefined, value: string | undefined): boolean {
  if (value === undefined) return true;
  const m = (matcher ?? "").trim();
  if (m === "" || m === "*") return true;
  if (NAME_LIST.test(m)) return m.split("|").includes(value);
  return compile(m)?.test(value) ?? false;
}
