// src/tools/setup/sources.ts — where an install or download comes from, decided once from the text the owner approved:
// the preview and the run both read it through parseSource, so what is fetched is what was shown.
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { isAbsolute, normalize, sep } from "node:path";
import { expandHome } from "../../paths";

/** Why git may not fetch this URL, or undefined: https or file only, and no credentials in it (the approval shows it). */
export function cloneUrlProblem(url: string): string | undefined {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return `${url.slice(0, 80)} isn't a URL I can clone: give an https:// git URL.`;
  }
  if (u.protocol !== "https:" && u.protocol !== "file:") return "I only clone https:// git URLs (or a file:// repository on this computer).";
  if (u.username || u.password) return "That URL carries a username or password; give it without them (a private repo uses your git credentials).";
  return undefined;
}

export type Source =
  /** A repository, cloned shallow; `subdir` is the folder inside it that holds the plugin or skill. */
  | { kind: "git"; url: string; ref?: string; subdir?: string }
  /** One file over https (a SKILL.md). */
  | { kind: "file"; url: string }
  /** A folder on this computer. */
  | { kind: "local"; path: string };

export const PRIVATE_HOST = "That address is on this computer or your local network, which I don't fetch from here.";

function ipv4Private(ip: string): boolean {
  const [a = 0, b = 0] = ip.split(".").map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

function ipv6Private(ip: string): boolean {
  const v = ip.toLowerCase();
  if (v === "::1" || v === "::") return true;
  if (/^f[cd]/.test(v) || /^fe[89ab]/.test(v)) return true;
  // ::ffff:7f00:1 is 127.0.0.1 written as IPv6.
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(v);
  if (mapped) {
    const hi = parseInt(mapped[1]!, 16);
    const lo = parseInt(mapped[2]!, 16);
    return ipv4Private(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  return /^::ffff:\d/.test(v) && ipv4Private(v.slice(7));
}

/**
 * Why a URL's host is off limits, or undefined: loopback, private, link-local and cloud-metadata addresses. Only the
 * literal host is checked; a public name that resolves to a private address is not caught here.
 */
export function privateHostProblem(url: URL): string | undefined {
  const host = url.hostname.toLowerCase().replace(/^\[(.*)\]$/, "$1").replace(/\.+$/, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return PRIVATE_HOST;
  const family = isIP(host);
  if (family === 4 && ipv4Private(host)) return PRIVATE_HOST;
  if (family === 6 && ipv6Private(host)) return PRIVATE_HOST;
  return undefined;
}

/** Why a folder inside a repo can't be used, or undefined: relative, and never climbing out. */
export function subdirProblem(subdir: string): string | undefined {
  const bad = "The folder inside the repository must be a relative path that stays inside it, like plugins/name.";
  if (subdir.trim() === "" || isAbsolute(subdir) || subdir.startsWith("~") || subdir.includes("\\")) return bad;
  const rel = normalize(subdir);
  if (rel === ".." || rel.startsWith(`..${sep}`)) return bad;
  return undefined;
}

/** Looks a host name up: every address it has. */
export type Resolve = (host: string) => Promise<string[]>;

export const systemResolve: Resolve = async (host) => (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);

/** A host refused before anything is fetched from it. */
export class HostRefused extends Error {}

/**
 * Why a URL's host is off limits, or undefined, after looking the name up: a public name whose addresses include a
 * private, loopback, link-local or unique-local one is refused like the address itself, and so is a name that doesn't
 * resolve. A file:// URL is a path the owner gave on this computer: nothing to look up.
 */
export async function hostProblem(url: URL, resolve: Resolve = systemResolve): Promise<string | undefined> {
  const vetted = await vetHost(url, resolve);
  return "problem" in vetted ? vetted.problem : undefined;
}

/**
 * hostProblem's check, also returning the addresses a name was found at once they all passed (none for a literal
 * address or a file:// URL), so a caller can pin its connection to them.
 */
export async function vetHost(url: URL, resolve: Resolve = systemResolve): Promise<{ problem: string } | { addresses: string[] }> {
  if (url.protocol === "file:") return { addresses: [] };
  const literal = privateHostProblem(url);
  if (literal) return { problem: literal };
  const host = url.hostname.replace(/^\[(.*)\]$/, "$1").replace(/\.+$/, "");
  if (isIP(host)) return { addresses: [] };
  let addresses: string[];
  try {
    addresses = await resolve(host);
  } catch {
    return { problem: `I couldn't find the host ${host}.` };
  }
  if (!addresses.length) return { problem: `I couldn't find the host ${host}.` };
  const bad = addresses.some((a) => (isIP(a) === 6 ? ipv6Private(a) : isIP(a) !== 4 || ipv4Private(a)));
  return bad ? { problem: PRIVATE_HOST } : { addresses };
}

/** A fetch that refuses every hop (the first URL and each redirect it is handed) to a private host, name looked up first. */
export function guardedFetch(inner: typeof fetch, resolve: Resolve = systemResolve): (url: string, init?: RequestInit) => Promise<Response> {
  return async (url, init) => {
    const problem = await hostProblem(new URL(url), resolve);
    if (problem) throw new HostRefused(problem);
    return inner(url, init);
  };
}

const GITHUB = /^\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/(tree|blob)\/([^/]+)(?:\/(.+?))?)?\/?$/;

/** Where `raw` points, or the reason it can't be used. `subdir` names a folder inside a repository. */
export function parseSource(raw: string, subdir?: string): Source | { problem: string } {
  if (subdir !== undefined) {
    const problem = subdirProblem(subdir);
    if (problem) return { problem };
  }
  if (raw.startsWith("/") || raw.startsWith("~")) return { kind: "local", path: expandHome(raw) };
  const problem = cloneUrlProblem(raw);
  if (problem) return { problem };
  const url = new URL(raw);
  if (url.protocol === "file:") return { kind: "git", url: raw, ...(subdir ? { subdir } : {}) };
  const hostProblem = privateHostProblem(url);
  if (hostProblem) return { problem: hostProblem };
  const gh = url.hostname === "github.com" && !url.search && !url.hash ? GITHUB.exec(url.pathname) : null;
  if (gh) {
    const [, owner, repo, kind, ref, path] = gh;
    if (kind === "blob" && path) return { kind: "file", url: `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${path}` };
    const inner = path ?? subdir;
    if (inner !== undefined && subdirProblem(inner)) return { problem: subdirProblem(inner)! };
    return { kind: "git", url: `https://github.com/${owner}/${repo}.git`, ...(ref ? { ref } : {}), ...(inner ? { subdir: inner } : {}) };
  }
  if (/\.md$/i.test(url.pathname)) return { kind: "file", url: raw };
  return { kind: "git", url: raw, ...(subdir ? { subdir } : {}) };
}
