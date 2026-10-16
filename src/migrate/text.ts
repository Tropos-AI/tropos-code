// src/migrate/text.ts — tolerant readers for the foreign file formats (JSON5-ish, flat YAML, .env) and text hygiene.

/** Per-file ceiling for imported text. */
export const MAX_FILE_BYTES = 256 * 1024;

/** Strips the BOM, normalises line ends and drops control characters (keeps \n and \t). */
export function sanitizeText(text: string): string {
  return text
    .replace(/^﻿/, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "");
}

type Obj = Record<string, unknown>;
const newObj = (): Obj => Object.create(null) as Obj;

/**
 * Parses JSON with comments, trailing commas, single-quoted strings and unquoted keys (what
 * openclaw.json is written in). Objects have no prototype so a "__proto__" key is plain data.
 */
export function parseJson5(text: string): unknown {
  const s = text.replace(/^﻿/, "");
  let i = 0;
  const fail = (msg: string): never => {
    throw new SyntaxError(`${msg} at offset ${i}`);
  };
  const ws = () => {
    for (;;) {
      const c = s[i];
      if (c === " " || c === "\t" || c === "\n" || c === "\r") i++;
      else if (c === "/" && s[i + 1] === "/") while (i < s.length && s[i] !== "\n") i++;
      else if (c === "/" && s[i + 1] === "*") {
        const end = s.indexOf("*/", i + 2);
        if (end < 0) fail("Unterminated comment");
        i = end + 2;
      } else return;
    }
  };
  const str = (): string => {
    const q = s[i++]!;
    let out = "";
    while (i < s.length && s[i] !== q) {
      let c = s[i++]!;
      if (c === "\\") {
        c = s[i++] ?? "";
        if (c === "n") out += "\n";
        else if (c === "t") out += "\t";
        else if (c === "r") out += "\r";
        else if (c === "b") out += "\b";
        else if (c === "f") out += "\f";
        else if (c === "v") out += "\v";
        else if (c === "0") out += "\0";
        else if (c === "u") {
          out += String.fromCharCode(parseInt(s.slice(i, i + 4), 16) || 0);
          i += 4;
        } else if (c === "x") {
          out += String.fromCharCode(parseInt(s.slice(i, i + 2), 16) || 0);
          i += 2;
        } else if (c === "\n") {
          /* line continuation */
        } else out += c;
      } else out += c;
    }
    if (s[i] !== q) fail("Unterminated string");
    i++;
    return out;
  };
  const ident = /[A-Za-z_$][\w$-]*/y;
  const value = (depth: number): unknown => {
    if (depth > 64) fail("Too deeply nested");
    ws();
    const c = s[i];
    if (c === "{") {
      i++;
      const o = newObj();
      for (;;) {
        ws();
        if (s[i] === "}") {
          i++;
          return o;
        }
        let key: string;
        if (s[i] === '"' || s[i] === "'") key = str();
        else {
          ident.lastIndex = i;
          const m = ident.exec(s);
          if (!m) return fail("Expected a key");
          key = m[0];
          i += key.length;
        }
        ws();
        if (s[i++] !== ":") fail("Expected ':'");
        o[key] = value(depth + 1);
        ws();
        if (s[i] === ",") i++;
        else if (s[i] !== "}") fail("Expected ',' or '}'");
      }
    }
    if (c === "[") {
      i++;
      const a: unknown[] = [];
      for (;;) {
        ws();
        if (s[i] === "]") {
          i++;
          return a;
        }
        a.push(value(depth + 1));
        ws();
        if (s[i] === ",") i++;
        else if (s[i] !== "]") fail("Expected ',' or ']'");
      }
    }
    if (c === '"' || c === "'") return str();
    const m = /[+-]?(?:0x[0-9a-f]+|(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?|Infinity|NaN)/iy;
    m.lastIndex = i;
    const n = m.exec(s);
    if (n) {
      i += n[0].length;
      return Number(n[0]);
    }
    for (const [word, v] of [["true", true], ["false", false], ["null", null]] as const) {
      if (s.startsWith(word, i)) {
        i += word.length;
        return v;
      }
    }
    return fail("Unexpected token");
  };
  const result = value(0);
  ws();
  if (i < s.length) fail("Unexpected trailing text");
  return result;
}

function unquote(v: string): string {
  const t = v.trim();
  if (t.length >= 2 && (t[0] === '"' || t[0] === "'") && t.at(-1) === t[0]) return t.slice(1, -1);
  return t;
}

/** Removes a trailing " # comment" that is outside quotes. */
function stripComment(line: string): string {
  let q = "";
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (q) {
      if (c === q) q = "";
    } else if (c === '"' || c === "'") q = c;
    else if (c === "#" && (i === 0 || /\s/.test(line[i - 1]!))) return line.slice(0, i);
  }
  return line;
}

/**
 * A tiny reader for the flat/nested `key: value` subset of YAML (enough to find `model` and
 * `provider`). Lists, anchors and block scalars are not interpreted; lines it does not understand are ignored.
 */
export function parseYamlLite(text: string): Record<string, unknown> {
  const root = newObj();
  const stack: { indent: number; obj: Obj }[] = [{ indent: -1, obj: root }];
  for (const raw of text.replace(/^﻿/, "").split(/\r?\n/)) {
    const line = stripComment(raw).replace(/\s+$/, "");
    if (!line.trim() || line.trim() === "---" || line.trim().startsWith("-")) continue;
    const indent = line.length - line.trimStart().length;
    const m = /^(?:"([^"]*)"|'([^']*)'|([A-Za-z0-9_.\-/]+))\s*:(?:\s+(.*))?$/.exec(line.trim());
    if (!m) continue;
    const key = m[1] ?? m[2] ?? m[3]!;
    while (stack.length > 1 && indent <= stack.at(-1)!.indent) stack.pop();
    const parent = stack.at(-1)!.obj;
    const val = (m[4] ?? "").trim();
    if (val === "" || val === "|" || val === ">" || val === "|-" || val === ">-") {
      const child = newObj();
      parent[key] = child;
      stack.push({ indent, obj: child });
    } else parent[key] = unquote(val);
  }
  return root;
}

/** KEY=VALUE lines of a .env file (export prefix, quotes and comments handled). */
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = Object.create(null);
  for (const line of text.replace(/^﻿/, "").split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2]!.trim();
    if (v[0] === '"' || v[0] === "'") {
      const end = v.indexOf(v[0], 1);
      v = end > 0 ? v.slice(1, end) : v.slice(1);
    } else v = stripComment(v).trim();
    out[m[1]!] = v;
  }
  return out;
}
