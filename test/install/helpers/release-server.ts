// test/install/helpers/release-server.ts
// A local stand-in for GitHub Releases with the same URL shapes, including the releases/latest redirect.
import { githubReleaseUrls, type ReleaseUrls } from "../../../src/install/urls";

export interface ReleaseServer {
  base: string;
  urls: ReleaseUrls;
  requests: string[];
  put(tag: string, name: string, data: Uint8Array | string): void;
  remove(tag: string, name: string): void;
  setLatest(tag: string | null): void;
  failNext(tag: string, name: string, status: number, times?: number): void;
  stop(): void;
}

export const TEST_REPO = "t/r";

export function startReleaseServer(): ReleaseServer {
  const assets = new Map<string, Uint8Array>();
  const failures = new Map<string, { status: number; times: number }>();
  const requests: string[] = [];
  let latest: string | null = null;
  const prefix = `/${TEST_REPO}/releases/`;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const { pathname, origin } = new URL(req.url);
      requests.push(pathname);
      if (!pathname.startsWith(prefix)) return new Response("<html>Not Found</html>", { status: 404 });
      const rest = pathname.slice(prefix.length);
      const viaLatest = /^latest\/download\/([^/]+)$/.exec(rest);
      if (viaLatest) {
        return latest ? Response.redirect(`${origin}${prefix}download/${latest}/${viaLatest[1]}`, 302) : new Response("<html>Not Found</html>", { status: 404 });
      }
      const direct = /^download\/([^/]+)\/([^/]+)$/.exec(rest);
      if (!direct) return new Response("<html>Not Found</html>", { status: 404 });
      const key = `${direct[1]}/${direct[2]}`;
      const failure = failures.get(key);
      if (failure && failure.times > 0) {
        failure.times--;
        return new Response("<html>error</html>", { status: failure.status });
      }
      const data = assets.get(key);
      return data ? new Response(data as BodyInit) : new Response("<html>Not Found</html>", { status: 404 });
    },
  });
  const base = `http://127.0.0.1:${server.port}`;
  return {
    base,
    urls: githubReleaseUrls({ base, repo: TEST_REPO, channelsRepo: TEST_REPO }),
    requests,
    put: (tag, name, data) => void assets.set(`${tag}/${name}`, typeof data === "string" ? new TextEncoder().encode(data) : data),
    remove: (tag, name) => void assets.delete(`${tag}/${name}`),
    setLatest: (tag) => void (latest = tag),
    failNext: (tag, name, status, times = 1) => void failures.set(`${tag}/${name}`, { status, times }),
    stop: () => void server.stop(true),
  };
}
