// web/src/lib/login-link.ts — `tcode dashboard` opens http://127.0.0.1:<port>/#login=<one-time key>. The key is read once
// and removed from the address bar at once, so it never sits in the URL, the history or a screenshot.

export function takeLoginFragment(location: Pick<Location, "hash">, history: Pick<History, "replaceState">): string | null {
  const match = /^#login=(.+)$/.exec(location.hash);
  if (!match) return null;
  history.replaceState(null, "", "#/chat");
  try {
    return decodeURIComponent(match[1]!);
  } catch {
    return match[1]!;
  }
}
