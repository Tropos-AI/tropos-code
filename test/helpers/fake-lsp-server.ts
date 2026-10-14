// test/helpers/fake-lsp-server.ts
/**
 * A tiny stdio language server for tests: run as `<bun> fake-lsp-server.ts [flags]`.
 *
 * Diagnostics: every line containing "ERROR:" yields a severity-1 diagnostic at that column whose
 * message is the rest of the line; "WARN:" yields severity 2.
 *
 * Flags change its behaviour to exercise failure paths:
 *   --log <file>          append every received message as a JSON line
 *   --fail-initialize     answer initialize with an error
 *   --hang-initialize     never answer initialize
 *   --crash-on-open       exit(1) when a document is opened
 *   --silent              never publish diagnostics
 *   --two-pass            publish an empty pass first, then the real one 100 ms later
 *   --stale-version       also publish for the previous version right after the real one
 *   --ask-config          send workspace/configuration before answering initialize
 *   --ignore-exit         ignore shutdown and exit (forces a kill)
 */
import { appendFileSync } from "node:fs";

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(name);
const logIndex = argv.indexOf("--log");
const logFile = logIndex >= 0 ? argv[logIndex + 1] : undefined;

// Stay up even after stdin closes, so the client has to kill us.
if (flag("--ignore-exit")) setInterval(() => {}, 60_000);

let buffer = Buffer.alloc(0);
let nextId = 1000;
const waiting = new Map<number, () => void>();

function send(message: object): void {
  const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...message }), "utf8");
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}

function diagnosticsFor(text: string): object[] {
  const out: object[] = [];
  text.split("\n").forEach((line, i) => {
    for (const [marker, severity] of [["ERROR:", 1], ["WARN:", 2]] as const) {
      const at = line.indexOf(marker);
      if (at >= 0) {
        out.push({
          range: { start: { line: i, character: at }, end: { line: i, character: line.length } },
          severity,
          message: line.slice(at + marker.length).trim().replaceAll("\\n", "\n"),
        });
      }
    }
  });
  return out;
}

function publish(uri: string, version: number, text: string): void {
  if (flag("--silent")) return;
  const real = () => {
    send({ method: "textDocument/publishDiagnostics", params: { uri, version, diagnostics: diagnosticsFor(text) } });
    if (flag("--stale-version")) {
      send({ method: "textDocument/publishDiagnostics", params: { uri, version: version - 1, diagnostics: [] } });
    }
  };
  if (flag("--two-pass")) {
    send({ method: "textDocument/publishDiagnostics", params: { uri, version, diagnostics: [] } });
    setTimeout(real, 100);
  } else {
    real();
  }
}

function handle(message: { id?: number; method?: string; params?: any; result?: unknown }): void {
  if (logFile) appendFileSync(logFile, JSON.stringify(message) + "\n");
  if (message.method === undefined) {
    if (typeof message.id === "number") waiting.get(message.id)?.();
    return;
  }
  switch (message.method) {
    case "initialize": {
      if (flag("--hang-initialize")) return;
      const answer = () =>
        flag("--fail-initialize")
          ? send({ id: message.id, error: { code: -32603, message: "cannot initialize" } })
          : send({ id: message.id, result: { capabilities: { textDocumentSync: 1 } } });
      if (flag("--ask-config")) {
        const id = nextId++;
        waiting.set(id, answer);
        send({ id, method: "workspace/configuration", params: { items: [{ section: "fake" }] } });
      } else {
        answer();
      }
      return;
    }
    case "textDocument/didOpen":
      if (flag("--crash-on-open")) process.exit(1);
      publish(message.params.textDocument.uri, message.params.textDocument.version, message.params.textDocument.text);
      return;
    case "textDocument/didChange":
      publish(message.params.textDocument.uri, message.params.textDocument.version, message.params.contentChanges[0].text);
      return;
    case "shutdown":
      if (!flag("--ignore-exit")) send({ id: message.id, result: null });
      return;
    case "exit":
      if (!flag("--ignore-exit")) process.exit(0);
      return;
    default:
      if (message.id !== undefined) send({ id: message.id, result: null });
  }
}

process.stdin.on("data", (chunk: Buffer) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) return;
    const length = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, headerEnd).toString())?.[1] ?? 0);
    const start = headerEnd + 4;
    if (buffer.length < start + length) return;
    const body = buffer.subarray(start, start + length).toString("utf8");
    buffer = buffer.subarray(start + length);
    handle(JSON.parse(body));
  }
});
