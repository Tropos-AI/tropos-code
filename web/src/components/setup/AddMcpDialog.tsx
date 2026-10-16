// web/src/components/setup/AddMcpDialog.tsx — "Add MCP server": stdio (command, args, env pairs) or http/sse (url,
// headers). "Test" starts the server briefly via mcp.test and lists its tools or the error before anything is saved.
// Environment and header values are write-only and typed into password fields.
import { useState } from "react";

import type { McpServerInput, McpServerView } from "@core/web/admin/api";

import { Modal } from "@/components/interior/modal";
import { LiveRegion, Notice, SelectField, TextField, useAction } from "@/components/setup/admin-ui";
import { Button, IconButton } from "@/components/ui/button";
import { pairsToRecord, splitArgs } from "@/lib/admin-format";
import { useAdmin } from "@/lib/store";

interface Pair {
  key: string;
  value: string;
}

function PairRows({ legend, keyLabel, pairs, onChange }: { legend: string; keyLabel: string; pairs: Pair[]; onChange: (next: Pair[]) => void }) {
  const set = (i: number, patch: Partial<Pair>) => onChange(pairs.map((p, n) => (n === i ? { ...p, ...patch } : p)));
  return (
    <fieldset className="flex flex-col gap-2 rounded-[12px] border border-rule bg-paper px-4 pb-3 pt-2">
      <legend className="px-1 text-[13px] font-medium text-ink-2">{legend}</legend>
      {pairs.map((pair, i) => (
        <div key={i} className="flex items-end gap-2">
          <TextField label={`${keyLabel} ${i + 1}`} value={pair.key} onChange={(key) => set(i, { key })} mono className="flex-1" />
          <TextField label={`Value ${i + 1}`} type="password" value={pair.value} onChange={(value) => set(i, { value })} mono className="flex-1" />
          <IconButton icon="trash-2" label={`Remove ${keyLabel.toLowerCase()} ${i + 1}`} className="mb-0.5" onClick={() => onChange(pairs.filter((_, n) => n !== i))} />
        </div>
      ))}
      <div>
        <Button variant="ghost" size="sm" icon="plus" onClick={() => onChange([...pairs, { key: "", value: "" }])}>
          Add {keyLabel.toLowerCase()}
        </Button>
        <span className="ml-2 text-[12px] text-ink-3">Values are saved but never shown again.</span>
      </div>
    </fieldset>
  );
}

function Form({ onClose, onAdded }: { onClose: () => void; onAdded: (servers: McpServerView[]) => void }) {
  const admin = useAdmin();
  const [name, setName] = useState("");
  const [type, setType] = useState<McpServerInput["type"]>("stdio");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [url, setUrl] = useState("");
  const [env, setEnv] = useState<Pair[]>([]);
  const [headers, setHeaders] = useState<Pair[]>([]);
  const [formError, setFormError] = useState<string | null>(null);
  const [tested, setTested] = useState<{ sig: string; ok: boolean; tools: string[]; error?: string } | null>(null);
  const test = useAction();
  const add = useAction();

  const build = (): McpServerInput | string => {
    if (type === "stdio") {
      if (!command.trim()) return "Enter the command that starts the server.";
      const e = pairsToRecord(env);
      return { type, command: command.trim(), args: splitArgs(args), ...(e ? { env: e } : {}) };
    }
    if (!/^https?:\/\//i.test(url.trim())) return "Enter the server's address, starting with http:// or https://.";
    const h = pairsToRecord(headers);
    return { type, url: url.trim(), ...(h ? { headers: h } : {}) };
  };
  const signature = JSON.stringify({ type, command, args, url, env, headers });

  const runTest = async () => {
    setFormError(null);
    const server = build();
    if (typeof server === "string") return setFormError(server);
    const result = await test.run(() => admin("mcp.test", { server }));
    if (result) setTested({ sig: signature, ...result });
  };

  const submit = async () => {
    setFormError(null);
    if (!name.trim()) return setFormError("Give the server a name.");
    const server = build();
    if (typeof server === "string") return setFormError(server);
    const servers = await add.run(() => admin("mcp.add", { name: name.trim(), server }));
    if (servers) onAdded(servers);
  };

  const result = tested && tested.sig === signature ? tested : null;

  return (
    <form
      noValidate
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField label="Name" value={name} onChange={setName} placeholder="github" hint="Tools appear as mcp__<name>__<tool>." />
        <SelectField
          label="Type"
          value={type}
          onChange={(v) => setType(v as McpServerInput["type"])}
          options={[
            { value: "stdio", label: "stdio (a command on this machine)" },
            { value: "http", label: "http (a remote URL)" },
            { value: "sse", label: "sse (a remote URL)" },
          ]}
        />
      </div>
      {type === "stdio" ? (
        <>
          <TextField label="Command" value={command} onChange={setCommand} mono placeholder="npx" />
          <TextField label="Arguments" value={args} onChange={setArgs} mono placeholder="-y @modelcontextprotocol/server-filesystem /tmp" hint="Separated by spaces; use quotes for an argument with spaces." />
          <PairRows legend="Environment variables" keyLabel="Variable" pairs={env} onChange={setEnv} />
        </>
      ) : (
        <>
          <TextField label="URL" type="url" value={url} onChange={setUrl} mono placeholder="https://example.com/mcp" />
          <PairRows legend="Headers" keyLabel="Header" pairs={headers} onChange={setHeaders} />
        </>
      )}
      <p className="text-[12px] leading-relaxed text-ink-3">
        <strong className="font-medium text-ink-2">Test</strong> starts the server briefly and lists its tools; nothing is saved. <strong className="font-medium text-ink-2">Add server</strong> saves it to your settings.
      </p>
      <LiveRegion>
        {formError ? <Notice tone="error">{formError}</Notice> : null}
        {test.error ? <Notice tone="error">Couldn't run the test: {test.error}</Notice> : null}
        {result?.ok ? (
          <Notice tone="ok">
            Connected. {result.tools.length} {result.tools.length === 1 ? "tool" : "tools"}
            {result.tools.length > 0 ? `: ${result.tools.slice(0, 6).join(", ")}${result.tools.length > 6 ? ", …" : ""}` : ""}.
          </Notice>
        ) : null}
        {result && !result.ok ? <Notice tone="error">The server didn't start: {result.error ?? "no reason given"}</Notice> : null}
        {add.error ? <Notice tone="error">Couldn't add the server: {add.error}</Notice> : null}
      </LiveRegion>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose} disabled={add.pending}>
          Cancel
        </Button>
        <Button icon="activity" onClick={() => void runTest()} disabled={test.pending || add.pending}>
          {test.pending ? "Testing…" : "Test"}
        </Button>
        <Button type="submit" variant="primary" icon="plus" disabled={add.pending}>
          {add.pending ? "Adding…" : "Add server"}
        </Button>
      </div>
    </form>
  );
}

export function AddMcpDialog({ open, onClose, onAdded }: { open: boolean; onClose: () => void; onAdded: (servers: McpServerView[]) => void }) {
  return (
    <Modal open={open} onClose={onClose} title="Add an MCP server" description="Give the agent more tools." maxWidth={620} closeLabel="Close dialog">
      <Form onClose={onClose} onAdded={onAdded} />
    </Modal>
  );
}
