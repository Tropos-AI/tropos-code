// src/learning/threats.ts

/**
 * A cheap scan for text that tries to steer the model or leak data. Everything the agent learns
 * (notes, skills, the soul) is prompt text for later sessions, so it is checked when written and
 * again when loaded. The patterns aim at unambiguous attacks: ordinary skills mention curl, ssh and
 * environment variables all the time, and a false positive silently blinds the agent.
 */

export type ScanResult = { ok: true } | { ok: false; reason: string };

interface Rule {
  /** Why the text is refused, or undefined when this rule has nothing against it. */
  check: (text: string) => string | undefined;
}

const INJECTION: Array<[RegExp, string]> = [
  [
    /\b(?:ignore|disregard|forget)\s+(?:(?:all|any|every|the|your|of|these|those)\s+){0,3}(?:previous|prior|above|earlier|preceding|original|system)\s+(?:instructions?|prompts?|rules|directions|directives|guidelines)\b/i,
    'prompt injection ("ignore previous instructions")',
  ],
  [
    /\bdisregard\s+(?:(?:all|any|every|the|your|of|these|those|its)\s+){0,3}(?:instructions?|rules|guidelines|directives|system\s+prompt|safety)\b/i,
    'prompt injection ("disregard instructions")',
  ],
  [
    /\byou\s+are\s+now\s+(?:(?:a|an|the)\s+)?(?:new|different|unrestricted|unfiltered|uncensored|jailbroken|evil|rogue|malicious|free\s+(?:of|from)|no\s+longer|not\s+(?:bound|restricted)|dan\b|in\s+(?:developer|god|jailbreak|dan|unrestricted)\s+mode)/i,
    'prompt injection ("you are now …")',
  ],
  [/\bnew\s+system\s+(?:prompt|instructions?)\b/i, 'prompt injection ("new system prompt")'],
  [
    /\b(?:reveal|print|show|output|repeat|leak|dump|expose|disclose)\s+(?:me\s+)?(?:your|the)\s+(?:full\s+|entire\s+|original\s+|hidden\s+|initial\s+|secret\s+)?(?:system\s+prompt|(?:hidden|secret|original|initial)\s+instructions)\b/i,
    'prompt injection ("reveal your system prompt")',
  ],
];

/** Commands and calls that send data over the network. */
const NETWORK = /\b(?:curl|wget|nc|ncat|netcat|socat|Invoke-WebRequest|Invoke-RestMethod)\b|\bfetch\s*\(|\b(?:requests|httpx|axios)\.(?:post|put|get|patch)\s*\(|\burllib\.request\b/;

/** A shell variable or process env lookup that names a credential, in any case (`$GITHUB_TOKEN`, `$github_token`). */
const SECRET_VAR =
  /\$\{?[A-Z_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|COOKIE)[A-Z0-9_]*\}?|process\.env\.[A-Z_]*(?:KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*|os\.environ(?:\.get\(|\[)\s*["'][A-Z_]*(?:KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*/i;

/** The whole environment, as a value. */
const ENV_DUMP = /\$\(\s*(?:env|printenv|set)\s*\)|`(?:env|printenv)`|JSON\.stringify\(\s*process\.env\s*\)|\bos\.environ\b(?!\s*(?:\.get\(|\[))|\bprocess\.env\b(?!\s*[.[])/;

/** env / printenv piped straight into a network command. */
const ENV_PIPE = /\b(?:env|printenv|set)\s*\|\s*(?:[\w./-]+\s*\|\s*)*(?:curl|wget|nc|ncat|netcat|socat)\b/;

/** Files whose contents are credentials. `.pub` keys are public and excluded below. */
const SENSITIVE_FILE = /(?:\.ssh\/[^\s'"`;|)]*|(?<![\w$])\.env\b(?!\.example|\.sample|\.template)|\.aws\/credentials|\.netrc\b|\.npmrc\b|\.pypirc\b|\.git-credentials\b|\.docker\/config\.json|\.kube\/config|\/etc\/shadow)/g;

/** Header arguments are where credentials legitimately travel (`-H "Authorization: Bearer $TOKEN"`). */
const HEADER_ARG = /(?:-H|--header)\s*(?:"[^"]*"|'[^']*'|\S+)/g;

function sensitiveFileOnLine(line: string): boolean {
  for (const match of line.matchAll(SENSITIVE_FILE)) {
    const token = match[0];
    if (token.startsWith(".ssh/") && (token.endsWith(".pub") || token === ".ssh/" || token.endsWith("known_hosts") || token.endsWith("config"))) continue;
    return true;
  }
  return false;
}

/** One line sends a secret: a network call next to a credential, the environment or a key file. */
function leaksOnLine(line: string): boolean {
  if (!NETWORK.test(line)) return false;
  return ENV_DUMP.test(line) || SECRET_VAR.test(line.replace(HEADER_ARG, " ")) || sensitiveFileOnLine(line);
}

/**
 * Lines as the shell runs them: a trailing backslash, pipe or && carries the command onto the next
 * line. Markdown table rows (which start with a pipe) are left apart.
 */
function logicalLines(text: string): string[] {
  const lines: string[] = [];
  let carried = "";
  for (const line of text.split(/\r?\n/)) {
    // The shell carries a trailing pipe over blank lines as well.
    if (carried !== "" && line.trim() === "") continue;
    if (line.endsWith("\\")) {
      carried += `${line.slice(0, -1)} `;
    } else if (/(?:\||&&)\s*$/.test(line) && !/^\s*\|/.test(line)) {
      carried += `${line} `;
    } else {
      lines.push(carried + line);
      carried = "";
    }
  }
  if (carried !== "") lines.push(carried);
  return lines;
}

/** A network call whose arguments are in parentheses, which may span lines (`fetch(url, {\n body: … })`). */
const NETWORK_CALL = /\bfetch\s*\(|\b(?:requests|httpx|axios)\.(?:post|put|get|patch)\s*\(/g;
const MAX_CALL_CHARS = 4_000;

/** For each "(" in `text`, the index of its matching ")", in one pass. */
function matchingParens(text: string): Map<number, number> {
  const pairs = new Map<number, number>();
  const open: number[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "(") open.push(i);
    else if (text[i] === ")" && open.length > 0) pairs.set(open.pop()!, i);
  }
  return pairs;
}

/**
 * Each network call that spans lines, from its name to the matching close parenthesis, on one line.
 * Calls nested in one already taken are covered by it, so the spans are disjoint and the scan stays
 * linear however the calls nest.
 */
function networkCalls(text: string): string[] {
  const calls: string[] = [];
  let pairs: Map<number, number> | undefined;
  let taken = 0;
  for (const match of text.matchAll(NETWORK_CALL)) {
    const start = match.index;
    if (start < taken) continue;
    pairs ??= matchingParens(text);
    const close = pairs.get(start + match[0].length - 1);
    if (close === undefined || close - start > MAX_CALL_CHARS) continue;
    const call = text.slice(start, close + 1);
    if (call.includes("\n")) calls.push(call.replace(/\s+/g, " "));
    taken = close + 1;
  }
  return calls;
}

function exfiltration(text: string): boolean {
  const joined = logicalLines(text);
  if (ENV_PIPE.test(text) || ENV_PIPE.test(joined.join("\n"))) return true;
  return joined.some(leaksOnLine) || networkCalls(text).some(leaksOnLine);
}

/**
 * Code fetched or decoded and handed straight to a shell: `curl … | sh`, `base64 -d | bash`, `bash <(curl …)`,
 * `sh -c "$(curl …)"`. The one place a skill's text decides what runs unseen, so it is refused outright.
 */
const SHELL_START = /^\s*(?:sudo\s+(?:-\S+\s+)*)?(?:\S*\/)?(?:ba|z|da|k|a)?sh(?![\w.-])/i;
const DOWNLOADER = /\b(?:curl|wget)\b/i;
const DECODER = /\bbase64\b[^|]*(?:\s-[a-zA-Z]*[dD]\b|--decode)/i;
/** Fetched text handed to a shell without a pipe in between: bash <(curl …), sh -c "$(curl …)", eval "$(curl …)". */
const SUBSTITUTED_EXEC = [/\b(?:ba|z|da|k|a)?sh\s+(?:-c\s+)?["']?(?:<\(|\$\()\s*(?:curl|wget)\b/i, /\beval\s+["']?\$\(\s*(?:curl|wget)\b/i];

/** One pass over the pipe-separated segments (never a scan per "curl", so a line of thousands of them stays linear). */
function pipesToShell(line: string, isSource: (segment: string) => boolean): boolean {
  const segments = line.split("|");
  let source = -1;
  for (let i = 0; i < segments.length; i++) {
    if (source < 0) {
      if (isSource(segments[i]!)) source = i;
    } else if (SHELL_START.test(segments[i]!)) return true;
  }
  return false;
}

function pipedExecution(text: string): boolean {
  return logicalLines(text).some((line) => pipesToShell(line, (s) => DOWNLOADER.test(s)) || pipesToShell(line, (s) => DECODER.test(s)) || SUBSTITUTED_EXEC.some((re) => re.test(line)));
}

/** Writing to authorized_keys grants whoever holds the key a shell; mentioning the file is fine. */
const KEY_PLANTING = [
  /(?<![-=])>>?[ \t]{0,8}["']?[^\s"'|;<>]{0,256}authorized_keys/,
  /\btee\b[^|;\n]{0,256}authorized_keys/,
  /\b(?:cp|mv|ln|install|dd|rsync|scp)\s[^|;\n]{0,256}authorized_keys/,
  /\b(?:appendFile|writeFile|write_text|write)(?:Sync)?\s{0,8}\([^)\n]{0,256}authorized_keys/,
  /\bopen\(.{0,200}?authorized_keys.{0,40}?,\s*["'][aw]\+?["']/,
  /authorized_keys["']?\)?\.(?:write_text|write_bytes|open\(\s*["'][aw])/,
];

function sshPlanting(text: string): boolean {
  return KEY_PLANTING.some((re) => re.test(text));
}

/**
 * Zero-width and bidi controls hide or reorder text so a reader sees something other than what the
 * model gets; tag characters and variation selectors smuggle invisible data; soft hyphens and the
 * Hangul and Mongolian fillers render as nothing. Joiners between non-ASCII letters or emoji
 * (family emoji, Persian, Indic scripts) are legitimate, and so is a leading byte-order mark and a
 * single emoji presentation selector (U+FE0F) right after an emoji, as in "❤️".
 */
const INVISIBLE =
  /[\u00AD\u115F\u1160\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\u3164\uFE00-\uFE0F\uFEFF\uFFA0]|[\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/u;
const JOINERS = new Set([0x200c, 0x200d]);
const RICH = /^[\p{L}\p{M}\p{Extended_Pictographic}\p{Emoji_Modifier}\uFE0F]$/u;
const PICTOGRAPHIC = /^\p{Extended_Pictographic}$/u;
const EMOJI_PRESENTATION = 0xfe0f;

/** A joiner whose neighbours are both non-ASCII letters, marks or emoji parts. */
function benignJoiner(chars: string[], i: number): boolean {
  const prev = chars[i - 1];
  const next = chars[i + 1];
  const rich = (c: string | undefined) => c !== undefined && c.codePointAt(0)! > 0x7f && RICH.test(c);
  return rich(prev) && rich(next);
}

/** U+FE0F right after a pictograph ("❤️"), or in a keycap ("1️⃣"). */
function benignPresentation(chars: string[], i: number): boolean {
  const prev = chars[i - 1];
  if (prev === undefined) return false;
  return PICTOGRAPHIC.test(prev) || (/^[0-9#*]$/.test(prev) && chars[i + 1] === "\u20E3");
}

function invisibleChar(text: string): string | undefined {
  const body = text.replace(/^\uFEFF/, "");
  if (!INVISIBLE.test(body)) return undefined;
  const chars = Array.from(body);
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i]!;
    if (!INVISIBLE.test(c)) continue;
    const code = c.codePointAt(0)!;
    if (JOINERS.has(code) && benignJoiner(chars, i)) continue;
    if (code === EMOJI_PRESENTATION && benignPresentation(chars, i)) continue;
    return `U+${code.toString(16).toUpperCase().padStart(4, "0")}`;
  }
  return undefined;
}

/**
 * Literal credentials. Notes and skills ride in every later session (and in the ledger's blobs), so
 * a secret written there leaks far beyond the turn it came from. Placeholders (`$API_KEY`, `sk-...`,
 * `xoxb-your-token`) and names (`ANTHROPIC_API_KEY`) pass.
 */
const SECRET_TOKENS: Array<[RegExp, string]> = [
  [/-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/, "private key"],
  [/\b(?:AKIA|ASIA)(?![0-9A-Z]{9}EXAMPLE\b)[0-9A-Z]{16}\b/, "AWS access key id"],
  [/\bgh[pousr]_[A-Za-z0-9]{36}|\bgithub_pat_[A-Za-z0-9_]{22}/, "GitHub token"],
  [/\bxox[abprs]-(?=[A-Za-z-]{0,64}\d)[A-Za-z0-9-]{10}/, "Slack token"],
  [/\bsk-(?:ant-)?(?=[A-Za-z_-]{0,64}\d)(?=[\d_-]{0,64}[A-Za-z])[A-Za-z0-9_-]{20}/, "API key"],
  [/\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/, "Google API key"],
];

/**
 * `API_KEY=…`, `"token": "…"`, `client_secret: …`: a secret-looking name given a literal value.
 * Every quantifier is bounded, so a huge single-token line scans in linear time.
 */
const SECRET_ASSIGNMENT =
  /(?:api[_-]?key|secret|token|passw(?:or)?d|pwd|access[_-]?key|private[_-]?key|credentials?)[A-Za-z0-9_-]{0,64}["'`]?[ \t]{0,8}(?:=>?|:)[ \t]{0,8}["'`]?([A-Za-z0-9_\-+/=]{20,256})/gi;

function shannonBits(value: string): number {
  const counts = new Map<string, number>();
  for (const c of value) counts.set(c, (counts.get(c) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) bits -= (n / value.length) * Math.log2(n / value.length);
  return bits;
}

/** Random-looking: letters and digits, mixed case (or hex-length), and no long runs of the same few characters. */
function highEntropy(value: string): boolean {
  if (!/\d/.test(value) || !/[A-Za-z]/.test(value)) return false;
  const mixedCase = /[a-z]/.test(value) && /[A-Z]/.test(value);
  return (mixedCase || value.length >= 32) && shannonBits(value) >= 3;
}

function secretMaterial(text: string): string | undefined {
  for (const [re, kind] of SECRET_TOKENS) {
    if (re.test(text)) return `looks like a secret (${kind})`;
  }
  for (const match of text.matchAll(SECRET_ASSIGNMENT)) {
    if (highEntropy(match[1]!)) return "looks like a secret (credential assigned a literal value)";
  }
  return undefined;
}

const when =
  (test: (text: string) => boolean, reason: string): Rule["check"] =>
  (text) =>
    test(text) ? reason : undefined;

const RULES: Rule[] = [
  ...INJECTION.map(([re, reason]): Rule => ({ check: when((t) => re.test(t), reason) })),
  { check: when(exfiltration, "possible exfiltration of secrets over the network") },
  { check: when(sshPlanting, "SSH key planting (writes authorized_keys)") },
  { check: secretMaterial },
];

/**
 * Rules only applied to content that arrives from outside (`tcode migrate`): an install snippet in the user's own
 * skill is documentation, but the same line in a file imported from somebody else's tool is a thing to look at first.
 */
const STRICT_RULES: Rule[] = [{ check: when(pipedExecution, "downloads or decodes code and runs it straight from a pipe") }];

export interface ScanOptions {
  /** Also refuse code that is fetched or decoded and piped straight into a shell. */
  strict?: boolean;
}

/** Checks text the agent wrote, or is about to load, for injection, exfiltration, secrets and hidden characters. */
export function scanText(text: string, options: ScanOptions = {}): ScanResult {
  const hidden = invisibleChar(text);
  if (hidden) return { ok: false, reason: `invisible or bidi Unicode character ${hidden}` };
  // Normalise compatibility forms (full-width letters) so they can't dodge the word patterns.
  const normal = text.normalize("NFKC");
  for (const rule of options.strict ? [...RULES, ...STRICT_RULES] : RULES) {
    const reason = rule.check(normal);
    if (reason) return { ok: false, reason };
  }
  return { ok: true };
}

/** What a flagged entry or skill body is replaced with when loaded. */
export function blockedPlaceholder(reason: string): string {
  return `[blocked: ${reason}]`;
}
