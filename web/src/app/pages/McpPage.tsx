// web/src/app/pages/McpPage.tsx — MCP servers (rpc("panel", "mcp")) in an Interior Sortable Table (Name, Type, State,
// Tools, Error); below 720px the rows become stacked cards. A server's name opens a Drawer with its details.
import { useCallback, useMemo, useState } from "react";

import type { McpServerView as ManagedServer } from "@core/web/admin/api";

import type { PanelData, PanelItem } from "@core/ui/runtime";

import { PanelHead, PanelStack } from "@/components/pages/panel-head";
import { CopyIconButton } from "@/components/pages/copy-chip";
import { PageActions } from "@/components/pages/page-actions";
import { splitEmptyText, withInlineCode } from "@/components/pages/panel-empty";
import { CommandBlock, DetailField, DetailList, MonoChip, STATUS_TONE, StatusDot, type PanelStatus } from "@/components/pages/panel-parts";
import { ResourceView } from "@/components/pages/resource-view";
import { isPanelEmpty, usePanel, useRpcResource } from "@/components/pages/use-rpc-resource";
import { AddMcpDialog } from "@/components/setup/AddMcpDialog";
import { ConfirmDialog, Notice, useAction } from "@/components/setup/admin-ui";
import { Button } from "@/components/ui/button";
import { useAdmin } from "@/lib/store";
import { Drawer } from "@/components/interior/drawer";
import { SortableTable, type SortableColumn } from "@/components/interior/sortable-table";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Icon } from "@/components/ui/icon";
import { useMediaQuery } from "@/hooks/use-media-query";
import { cn } from "@/lib/utils";

export interface McpServerView {
  key: string;
  name: string;
  type: string;
  status: PanelStatus;
  state: "connected" | "failed" | "disabled";
  tools: number;
  error?: string;
  /** Detail lines the table doesn't already show. */
  notes: string[];
}

const TOOLS_LINE = /^(\d+) tools?, named /;

/** Reads an MCP panel row (see extensionPanel in src/cli/runtime.ts). */
export function mcpView(item: PanelItem): McpServerView {
  const status: PanelStatus = item.status ?? "ok";
  const state = status === "off" ? "disabled" : status === "error" ? "failed" : "connected";
  const detail = item.detail ?? [];
  const toolsLine = detail.find((line) => TOOLS_LINE.test(line));
  const count = /(\d+)\s+tools?/.exec(item.hint ?? "") ?? (toolsLine ? TOOLS_LINE.exec(toolsLine) : null);
  const rest = detail.filter((line) => line !== toolsLine);
  const error = status === "warn" || status === "error" ? rest.join("\n") || undefined : undefined;
  return {
    key: item.key,
    name: item.label,
    type: item.aside ?? "stdio",
    status,
    state,
    tools: count ? Number(count[1]) : 0,
    error,
    notes: error ? [] : rest,
  };
}

const STATE_RANK: Record<PanelStatus, number> = { error: 0, warn: 1, ok: 2, off: 3 };
const STATE_LABEL: Record<PanelStatus, string> = { ok: "connected", warn: "connected", error: "failed", off: "disabled" };

function StateBadge({ server }: { server: McpServerView }) {
  return (
    <Badge tone={STATUS_TONE[server.status]} className={server.status === "warn" ? "gap-1" : undefined}>
      {STATE_LABEL[server.status]}
      {server.status === "warn" ? <span className="sr-only">, with a warning</span> : null}
    </Badge>
  );
}

const EXAMPLE = `{
  "mcpServers": {
    "github": {
      "command": "github-mcp-server",
      "args": ["stdio"],
      "env": { "GITHUB_TOKEN": "\${GITHUB_TOKEN}" }
    },
    "docs": { "type": "http", "url": "https://example.com/mcp" }
  }
}`;

function McpEmpty({ text }: { text: string }) {
  const { title, rest } = splitEmptyText(text);
  return (
    <Card>
      <EmptyState icon="network" title={title} description={rest ? withInlineCode(rest) : undefined} className="pb-6" />
      <div className="mx-auto w-full max-w-[34rem]">
        <p className="type-meta mb-2 text-ink-3">Example · ~/.tropos/settings.json</p>
        <CommandBlock command={EXAMPLE} label="Copy the example settings" />
        <p className="mt-3 text-[12.5px] leading-relaxed text-ink-2">
          Servers connect when tcode starts. Their tools are named {withInlineCode("mcp__<server>__<tool>")}, and each asks before running unless a permission rule allows it.
        </p>
      </div>
    </Card>
  );
}

function ServerDetail({ server }: { server: McpServerView }) {
  const pattern = `mcp__${server.name}__<tool>`;
  return (
    <div className="flex flex-col gap-4 px-2 py-2">
      {server.error ? (
        <div role="note" className={cn("rounded-[10px] border p-3", server.status === "error" ? "border-error/20 bg-error-wash" : "border-warn/20 bg-warn-wash")}>
          <p className={cn("flex items-center gap-1.5 text-[12.5px] font-medium", server.status === "error" ? "text-error" : "text-warn")}>
            <Icon name={server.status === "error" ? "circle-alert" : "triangle-alert"} size="sm" />
            {server.status === "error" ? "Error" : "Warning"}
          </p>
          <p className="mt-1 whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed text-ink">{server.error}</p>
        </div>
      ) : null}
      <DetailList>
        <DetailField label="State">
          <StateBadge server={server} />
        </DetailField>
        <DetailField label="Transport">
          <MonoChip>{server.type}</MonoChip>
        </DetailField>
        <DetailField label="Tools">
          <span className="font-mono text-[12.5px] tabular-nums text-ink">{server.tools}</span>
        </DetailField>
        <DetailField label="Tool names">
          <span className="flex min-w-0 items-center gap-1">
            <code className="min-w-0 break-all font-mono text-[12px] text-ink">{pattern}</code>
            <CopyIconButton value={`mcp__${server.name}__`} label={`Copy the tool prefix of ${server.name}`} />
          </span>
        </DetailField>
        <DetailField label="Allow all">
          Add {withInlineCode(`"mcp__${server.name}"`)} to your allow rules to skip the prompt for every tool of this server.
        </DetailField>
        {server.notes.map((line) => (
          <DetailField key={line} label="Note">
            {line}
          </DetailField>
        ))}
      </DetailList>
    </div>
  );
}

function NameButton({ server, onOpen, className }: { server: McpServerView; onOpen: (key: string) => void; className?: string }) {
  return (
    <button
      type="button"
      onClick={() => onOpen(server.key)}
      aria-haspopup="dialog"
      className={cn(
        "group/name inline-flex max-w-full items-center gap-2 rounded-[6px] text-left font-medium text-ink outline-none decoration-accent/40 underline-offset-[3px] hover:underline focus-visible:shadow-focus",
        className,
      )}
    >
      <StatusDot status={server.status} className="mt-0" />
      <span className="truncate">{server.name}</span>
      <span className="sr-only">, show details</span>
    </button>
  );
}

function ServerCards({ servers, onOpen }: { servers: McpServerView[]; onOpen: (key: string) => void }) {
  return (
    <ul className="flex flex-col gap-3" aria-label="MCP servers">
      {servers.map((server) => (
        <li key={server.key}>
          <button
            type="button"
            onClick={() => onOpen(server.key)}
            aria-haspopup="dialog"
            className="flex w-full flex-col gap-2 rounded-[14px] border border-rule bg-surface p-4 text-left shadow-card outline-none transition-[border-color,box-shadow] duration-150 hover:border-rule-strong focus-visible:shadow-focus"
          >
            <span className="flex w-full items-center gap-2.5">
              <StatusDot status={server.status} className="mt-0" />
              <strong className="min-w-0 flex-1 truncate text-[14.5px] font-medium text-ink">{server.name}</strong>
              <StateBadge server={server} />
            </span>
            <span className="flex items-center gap-2 font-mono text-[12px] text-ink-2">
              <MonoChip>{server.type}</MonoChip>
              <span className="tabular-nums">
                {server.tools} {server.tools === 1 ? "tool" : "tools"}
              </span>
              <span aria-hidden className="ml-auto text-ink-3">
                <Icon name="chevron-right" size="sm" />
              </span>
            </span>
            {server.error ? <span className={cn("line-clamp-2 font-mono text-[12px]", server.status === "error" ? "text-error" : "text-warn")}>{server.error}</span> : null}
          </button>
        </li>
      ))}
    </ul>
  );
}

function McpServers({ data }: { data: PanelData }) {
  const wide = useMediaQuery("(min-width: 720px)");
  const servers = useMemo(() => data.sections.flatMap((s) => s.items.map(mcpView)), [data]);
  const [selected, setSelected] = useState<{ key: string; open: boolean } | null>(null);
  const open = useCallback((key: string) => setSelected({ key, open: true }), []);
  const getRowId = useCallback((s: McpServerView) => s.key, []);

  const columns = useMemo<SortableColumn<McpServerView>[]>(
    () => [
      { id: "name", header: "Name", width: "minmax(0,1.15fr)", value: (s) => s.name, cell: (s) => <NameButton server={s} onOpen={open} /> },
      { id: "type", header: "Type", width: "76px", value: (s) => s.type, cell: (s) => <MonoChip>{s.type}</MonoChip> },
      { id: "state", header: "State", width: "118px", value: (s) => STATE_RANK[s.status], cell: (s) => <StateBadge server={s} /> },
      { id: "tools", header: "Tools", width: "84px", align: "end", numeric: true, value: (s) => s.tools },
      {
        id: "error",
        header: "Error",
        width: "minmax(0,1.6fr)",
        value: (s) => s.error ?? "",
        cell: (s) =>
          s.error ? (
            <span title={s.error} className={cn("font-mono text-[12px]", s.status === "error" ? "text-error" : "text-warn")}>
              {s.error}
            </span>
          ) : (
            <span className="text-ink-4" aria-label="none">
              —
            </span>
          ),
      },
    ],
    [open],
  );

  if (isPanelEmpty(data)) return <McpEmpty text={data.empty ?? 'No MCP servers. Add them under "mcpServers" in ~/.tropos/settings.json.'} />;

  const current = selected ? servers.find((s) => s.key === selected.key) : undefined;
  const failing = servers.filter((s) => s.status === "error").length;

  return (
    <>
      {failing > 0 ? (
        <p role="status" className="flex items-center gap-2 rounded-[12px] border border-error/15 bg-error-wash px-3.5 py-2.5 text-[13px] text-error">
          <Icon name="circle-alert" size="sm" />
          {failing === 1 ? "1 server failed to start." : `${failing} servers failed to start.`} Open it for the error.
        </p>
      ) : null}
      {wide ? (
        <SortableTable rows={servers} columns={columns} getRowId={getRowId} label="MCP servers" rowHeight={48} getRowLabel={(s) => s.name} />
      ) : (
        <ServerCards servers={servers} onOpen={open} />
      )}
      <Drawer
        open={selected?.open ?? false}
        onOpenChange={(next) => setSelected((prev) => (prev ? { ...prev, open: next } : prev))}
        title={current?.name ?? "MCP server"}
        description={current ? `${current.type} · ${STATE_LABEL[current.status]} · ${current.tools} ${current.tools === 1 ? "tool" : "tools"}` : undefined}
        side="right"
        width={400}
        closeLabel="Close server details"
        footer={<p className="text-[12.5px] leading-relaxed text-ink-3">Configured under {withInlineCode('"mcpServers"')} in your settings.</p>}
      >
        {current ? <ServerDetail server={current} /> : null}
      </Drawer>
    </>
  );
}

const MANAGED_TONE = { connected: "ok", failed: "error", disabled: "off", unknown: "neutral" } as const;

/** Saved servers from mcp.list with Remove; renders nothing while loading or when the admin API is unavailable. */
function ManagedServers({ servers, onChanged }: { servers: ManagedServer[]; onChanged: () => void }) {
  const admin = useAdmin();
  const [removing, setRemoving] = useState<ManagedServer | null>(null);
  const remove = useAction();
  if (servers.length === 0) return null;
  const confirm = async () => {
    if (!removing) return;
    const done = await remove.run(() => admin("mcp.remove", { name: removing.name }));
    if (done) {
      setRemoving(null);
      onChanged();
    }
  };
  return (
    <section aria-labelledby="mcp-saved" className="overflow-hidden rounded-[14px] border border-rule bg-surface shadow-card">
      <h2 id="mcp-saved" className="border-b border-rule px-5 py-3.5 text-[15px] font-medium text-ink">
        Saved servers
      </h2>
      <ul aria-label="Saved servers" className="divide-y divide-rule">
        {servers.map((server) => (
          <li key={server.name} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-5 py-3.5">
            <div className="min-w-0 flex-1">
              <p className="flex flex-wrap items-center gap-2">
                <strong className="text-[14px] font-medium text-ink">{server.name}</strong>
                <MonoChip>{server.type}</MonoChip>
                <Badge tone={MANAGED_TONE[server.state]}>{server.state}</Badge>
                {server.tools !== undefined ? <span className="font-mono text-[12px] text-ink-3">{server.tools} tools</span> : null}
              </p>
              <p className="mt-0.5 break-all font-mono text-[12px] text-ink-2">{server.target}</p>
              {server.error ? <p className="mt-1 break-words font-mono text-[12px] text-error">{server.error}</p> : null}
            </div>
            <Button variant="danger" size="sm" icon="trash-2" aria-label={`Remove ${server.name}`} onClick={() => { remove.clear(); setRemoving(server); }}>
              Remove
            </Button>
          </li>
        ))}
      </ul>
      <ConfirmDialog
        open={removing !== null}
        title={`Remove ${removing?.name ?? "server"}?`}
        description="The server is deleted from your settings. Its tools disappear from the agent."
        confirmLabel="Remove server"
        pending={remove.pending}
        error={remove.error}
        onConfirm={() => void confirm()}
        onCancel={() => setRemoving(null)}
      />
    </section>
  );
}

export function McpPanel() {
  const admin = useAdmin();
  const resource = usePanel("mcp");
  const managed = useRpcResource("mcp.list", () => admin("mcp.list"));
  const [adding, setAdding] = useState(false);
  const reload = () => {
    managed.refresh();
    resource.refresh();
  };
  return (
    <PanelStack>
      <PanelHead
        description="Model Context Protocol servers and the tools they give the agent."
        actions={
        <>
          <PageActions resource={resource} summary={resource.data?.subtitle} noun="MCP servers" />
          <Button variant="primary" size="sm" icon="plus" onClick={() => setAdding(true)} aria-haspopup="dialog">
            Add server
          </Button>
        </>
        }
      />
      <ResourceView resource={resource} noun="MCP servers">
        {(data) => <McpServers data={data} />}
      </ResourceView>
      {managed.data ? <ManagedServers servers={managed.data} onChanged={reload} /> : null}
      {managed.status === "error" ? <Notice tone="info">Managing servers from here isn't available right now ({managed.error}). The list above still shows what is loaded.</Notice> : null}
      <AddMcpDialog
        open={adding}
        onClose={() => setAdding(false)}
        onAdded={() => {
          setAdding(false);
          reload();
        }}
      />
    </PanelStack>
  );
}
