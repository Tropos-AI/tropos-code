// src/tools/webfetch/webfetch.test.ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { makeToolContext } from "../../../test/helpers/tool-context";
import { toInputSchema } from "../schema";
import { createWebFetchTool, normalizeUrl, permissionHost, webFetchTool } from "./webfetch";

let server: ReturnType<typeof Bun.serve>;
let base: string;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const path = new URL(req.url).pathname;
      switch (path) {
        case "/html":
          return new Response(
            "<html><head><style>p{color:red}</style><script>alert('x')</script></head>" +
              "<body><h1>Title</h1><p>Hello <b>world</b></p><noscript>enable js</noscript>" +
              "<svg><text>vector</text></svg><iframe src='x'>frame</iframe></body></html>",
            { headers: { "content-type": "text/html; charset=utf-8" } },
          );
        case "/json":
          return Response.json({ a: 1 });
        case "/vnd":
          return new Response('{"b":2}', { headers: { "content-type": "application/vnd.api+json" } });
        case "/plain":
          return new Response("just text", { headers: { "content-type": "text/plain" } });
        case "/latin1":
          return new Response(new Uint8Array([0x63, 0x61, 0x66, 0xe9]), { headers: { "content-type": "text/plain; charset=iso-8859-1" } });
        case "/badcharset":
          return new Response("ok", { headers: { "content-type": "text/plain; charset=nope-42" } });
        case "/redirect-same":
          return new Response(null, { status: 302, headers: { location: "/plain" } });
        case "/redirect-other":
          return new Response(null, { status: 301, headers: { location: "https://example.com/elsewhere" } });
        case "/redirect-ftp":
          return new Response(null, { status: 302, headers: { location: "ftp://example.com/x" } });
        case "/loop":
          return new Response(null, { status: 302, headers: { location: "/loop" } });
        case "/missing":
          return new Response("x".repeat(3000), { status: 404, statusText: "Not Found", headers: { "content-type": "text/plain" } });
        case "/binary":
          return new Response(new Uint8Array([0, 1, 2]), { headers: { "content-type": "image/png" } });
        case "/notype":
          return new Response(new Blob([new Uint8Array([1, 2])]));
        case "/big-declared":
          return new Response("y".repeat(2000), { headers: { "content-type": "text/plain" } });
        case "/big-streamed":
          return new Response(
            new ReadableStream({
              pull(controller) {
                controller.enqueue(new TextEncoder().encode("z".repeat(512)));
              },
            }),
            { headers: { "content-type": "text/plain" } },
          );
        case "/big-error":
          return new Response("e".repeat(2000), { status: 500, headers: { "content-type": "text/plain" } });
        case "/long":
          return new Response("abcdefghij".repeat(10), { headers: { "content-type": "text/plain" } });
        case "/slow":
          await Bun.sleep(500);
          return new Response("late", { headers: { "content-type": "text/plain" } });
        default:
          return new Response("nope", { status: 404 });
      }
    },
  });
  base = `http://127.0.0.1:${server.port}`;
});
afterAll(() => server.stop(true));

const tool = createWebFetchTool({ maxBytes: 1024 });
const run = (input: Parameters<typeof tool.run>[0], ctx = makeToolContext()) => tool.run(input, ctx);
const text = (out: { content: unknown }) => out.content as string;

describe("normalizeUrl", () => {
  test("upgrades http to https for remote hosts", () => {
    expect(normalizeUrl("http://example.com/a?b=1").href).toBe("https://example.com/a?b=1");
  });
  test("keeps http for localhost, 127.0.0.1 and ::1", () => {
    expect(normalizeUrl("http://localhost:3000/").protocol).toBe("http:");
    expect(normalizeUrl("http://127.0.0.1:8080/").protocol).toBe("http:");
    expect(normalizeUrl("http://[::1]:8080/").protocol).toBe("http:");
    expect(normalizeUrl("http://LOCALHOST/").protocol).toBe("http:");
  });
  test("keeps https as is", () => {
    expect(normalizeUrl("https://example.com/").href).toBe("https://example.com/");
  });
  test("rejects other schemes and garbage", () => {
    expect(() => normalizeUrl("ftp://example.com/")).toThrow("Only http and https");
    expect(() => normalizeUrl("file:///etc/passwd")).toThrow("Only http and https");
    expect(() => normalizeUrl("not a url")).toThrow("Invalid URL");
  });
});

describe("permissionHost", () => {
  test("lowercases, strips IPv6 brackets and trailing dots", () => {
    expect(permissionHost(new URL("https://Docs.Python.ORG./x"))).toBe("docs.python.org");
    expect(permissionHost(new URL("http://[::1]:80/"))).toBe("::1");
  });
});

describe("WebFetch: metadata", () => {
  test("name, kind, summary and subject", () => {
    expect(webFetchTool.name).toBe("WebFetch");
    expect(webFetchTool.kind).toBe("net");
    expect(webFetchTool.summarize({ url: "https://a.b/c" })).toBe("https://a.b/c");
    expect(webFetchTool.subject({ url: "http://Docs.Python.org/3/" }, "/")).toEqual({ paths: [], target: "domain:docs.python.org" });
    expect(webFetchTool.description).toContain("untrusted");
    expect(toInputSchema(webFetchTool.schema)).toBeDefined();
  });
  test("subject throws for an invalid URL so the call fails closed", () => {
    expect(() => webFetchTool.subject({ url: "nope" }, "/")).toThrow("Invalid URL: nope");
    expect(() => webFetchTool.subject({ url: "javascript:alert(1)" }, "/")).toThrow("Only http and https");
  });
  test("schema bounds max_chars", () => {
    expect(webFetchTool.schema.safeParse({ url: "https://a.b", max_chars: 200_001 }).success).toBe(false);
    expect(webFetchTool.schema.safeParse({ url: "https://a.b", max_chars: 200_000 }).success).toBe(true);
  });
});

describe("WebFetch: content", () => {
  test("converts HTML to markdown without scripts, styles and embeds", async () => {
    const out = await run({ url: `${base}/html` });
    expect(out.isError).toBeUndefined();
    const body = text(out);
    expect(body.startsWith(`URL: ${base}/html\nStatus: 200\n\n`)).toBe(true);
    expect(body).toContain("# Title");
    expect(body).toContain("Hello **world**");
    for (const gone of ["alert", "color:red", "enable js", "vector", "frame"]) expect(body).not.toContain(gone);
    expect(out.summary).toMatch(/ B · 200$/);
  });
  test("returns JSON, +json and plain text as is", async () => {
    expect(text(await run({ url: `${base}/json` }))).toEndWith('\n\n{"a":1}');
    expect(text(await run({ url: `${base}/vnd` }))).toEndWith('\n\n{"b":2}');
    expect(text(await run({ url: `${base}/plain` }))).toEndWith("\n\njust text");
  });
  test("honours the charset and falls back to UTF-8 for unknown ones", async () => {
    expect(text(await run({ url: `${base}/latin1` }))).toEndWith("café");
    expect(text(await run({ url: `${base}/badcharset` }))).toEndWith("\n\nok");
  });
  test("truncates to max_chars with a note", async () => {
    const out = await run({ url: `${base}/long`, max_chars: 25 });
    expect(text(out)).toEndWith(`\n\n${"abcdefghij".repeat(2)}abcde\n\n[truncated: 75 more characters]`);
  });
  test("refuses binary content types, naming them", async () => {
    const out = await run({ url: `${base}/binary` });
    expect(out.isError).toBe(true);
    expect(text(out)).toContain("content type image/png");
  });
  test("refuses a body with no text content type", async () => {
    const out = await run({ url: `${base}/notype` });
    expect(out.isError).toBe(true);
    expect(text(out)).toContain("content type");
  });
});

describe("WebFetch: size limit", () => {
  test("refuses a body whose content-length is over the limit", async () => {
    const out = await run({ url: `${base}/big-declared` });
    expect(out.isError).toBe(true);
    expect(text(out)).toContain("over the 1.0 KB limit");
  });
  test("refuses a streamed body once the received bytes pass the limit", async () => {
    const out = await run({ url: `${base}/big-streamed` });
    expect(out.isError).toBe(true);
    expect(text(out)).toContain("over the 1.0 KB limit");
  });
  test("an oversized error body is not shown", async () => {
    const out = await run({ url: `${base}/big-error` });
    expect(out.isError).toBe(true);
    expect(text(out)).toContain("Status: 500");
    expect(text(out)).toContain("over the size limit");
  });
});

describe("WebFetch: status and redirects", () => {
  test("non-2xx is an error with the status and the first 2,000 characters of the body", async () => {
    const out = await createWebFetchTool().run({ url: `${base}/missing` }, makeToolContext());
    expect(out.isError).toBe(true);
    expect(text(out)).toContain("Status: 404");
    expect(text(out)).toContain("HTTP 404 Not Found");
    expect(text(out)).toContain("x".repeat(2000));
    expect(text(out)).not.toContain("x".repeat(2001));
  });
  test("follows a redirect on the same host", async () => {
    const out = await run({ url: `${base}/redirect-same` });
    expect(out.isError).toBeUndefined();
    expect(text(out)).toBe(`URL: ${base}/plain\nStatus: 200\n\njust text`);
  });
  test("reports a redirect to another host instead of following it", async () => {
    const out = await run({ url: `${base}/redirect-other` });
    expect(out.isError).toBeUndefined();
    expect(text(out)).toContain("Redirected to https://example.com/elsewhere (a different host). Fetch that URL to continue.");
    expect(out.summary).toBe("redirect · 301");
  });
  test("refuses a redirect to a non-http scheme", async () => {
    const out = await run({ url: `${base}/redirect-ftp` });
    expect(out.isError).toBe(true);
    expect(text(out)).toContain("unusable location");
  });
  test("stops after 5 redirects", async () => {
    const out = await run({ url: `${base}/loop` });
    expect(out.isError).toBe(true);
    expect(text(out)).toContain("Too many redirects (more than 5)");
  });
  test("a stubbed fetch sees manual redirects and the https upgrade", async () => {
    const seen: { url: string; redirect?: RequestRedirect }[] = [];
    const stub = (async (input: URL | RequestInfo, init?: RequestInit) => {
      seen.push({ url: String(input), redirect: init?.redirect });
      return new Response("hi", { headers: { "content-type": "text/plain" } });
    }) as typeof fetch;
    const out = await createWebFetchTool({ fetch: stub }).run({ url: "http://example.com/x" }, makeToolContext());
    expect(text(out)).toBe("URL: https://example.com/x\nStatus: 200\n\nhi");
    expect(seen).toEqual([{ url: "https://example.com/x", redirect: "manual" }]);
  });
});

describe("WebFetch: failures", () => {
  test("an invalid URL is an error result from run", async () => {
    const out = await run({ url: "ftp://example.com" });
    expect(out.isError).toBe(true);
    expect(text(out)).toContain("Only http and https");
  });
  test("cancellation through ctx.signal", async () => {
    const controller = new AbortController();
    const pending = run({ url: `${base}/slow` }, makeToolContext({ signal: controller.signal }));
    setTimeout(() => controller.abort(), 50);
    const out = await pending;
    expect(out.isError).toBe(true);
    expect(text(out)).toContain("was cancelled");
  });
  test("times out", async () => {
    const out = await createWebFetchTool({ timeoutMs: 100 }).run({ url: `${base}/slow` }, makeToolContext());
    expect(out.isError).toBe(true);
    expect(text(out)).toContain("timed out after 0.1 s");
  });
  test("a network error is an error result", async () => {
    const stub = (async () => {
      throw new Error("connection refused");
    }) as unknown as typeof fetch;
    const out = await createWebFetchTool({ fetch: stub }).run({ url: "https://example.com/" }, makeToolContext());
    expect(out.isError).toBe(true);
    expect(text(out)).toBe("Fetch of https://example.com/ failed: connection refused");
  });
});

test("a host spelled with * is refused, so it can't become a wildcard rule", () => {
  expect(() => normalizeUrl("https://*/x")).toThrow("Invalid host");
  expect(() => normalizeUrl("https://%2a/x")).toThrow("Invalid host");
});
