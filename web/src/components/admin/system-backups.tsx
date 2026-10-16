// web/src/components/admin/system-backups.tsx — the System page's Backups section (create with options, list, verify,
// restore with a dry-run preview first, delete) and Uninstall section (commands to copy; the app cannot remove itself).
import { useState, type ReactNode } from "react";

import type { BackupInfo } from "@core/web/admin/api";

import { AdminCard, ConfirmBar, ResultNote, useSectionActions } from "@/components/admin/admin-parts";
import { useAdminResource } from "@/components/admin/use-admin-resource";
import { CommandBlock } from "@/components/pages/panel-parts";
import { ResourceView } from "@/components/pages/resource-view";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatBytes, formatDateTime } from "@/lib/ops-format";
import { useAdmin } from "@/lib/store";

function Option({ label, hint, checked, onChange, disabled }: { label: string; hint: string; checked: boolean; onChange: (next: boolean) => void; disabled?: boolean }) {
  return (
    <label className="flex cursor-pointer items-start gap-2.5 rounded-[10px] border border-rule bg-surface px-3 py-2.5 transition-[border-color,background-color] duration-150 hover:border-rule-strong has-[:focus-visible]:border-accent has-[:focus-visible]:shadow-focus has-[:checked]:bg-accent-wash/50">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} className="mt-[3px] size-4 accent-[var(--accent-strong)] outline-none" />
      <span className="min-w-0">
        <span className="block text-[13.5px] font-medium text-ink">{label}</span>
        <span className="block text-[12.5px] leading-snug text-ink-2">{hint}</span>
      </span>
    </label>
  );
}

/** `risky` are the files that can run code or let people in; with any, restoring takes a second, separate confirm ("trust"). */
type Pending = { name: string; kind: "restore"; files: string[]; risky: Array<{ path: string; why: string }>; stage: "preview" | "trust" };

function BackupRow({ backup, busy, onVerify, onRestore, onDelete, children }: { backup: BackupInfo; busy: string | null; onVerify: () => void; onRestore: () => void; onDelete: () => void; children?: ReactNode }) {
  const [deleting, setDeleting] = useState(false);
  const locked = busy !== null;
  return (
    <li className="flex flex-col gap-2 px-4 py-3 sm:px-5">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1 basis-52">
          <p className="break-all font-mono text-[13px] font-medium text-ink">{backup.name}</p>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] text-ink-2">
            <span>{formatDateTime(backup.createdAt)}</span>
            <span aria-hidden>·</span>
            <span className="tabular-nums">{formatBytes(backup.size)}</span>
            {backup.sessions ? <Badge tone="neutral" dot={false}>sessions</Badge> : null}
            {backup.secrets ? <Badge tone="warn" dot={false}>secrets</Badge> : null}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" icon="shield-check" disabled={locked} onClick={onVerify} aria-label={`Verify ${backup.name}`}>
            {busy === `verify:${backup.name}` ? "Verifying…" : "Verify"}
          </Button>
          <Button variant="secondary" size="sm" icon="undo-2" disabled={locked} onClick={onRestore} aria-label={`Restore ${backup.name}`}>
            {busy === `preview:${backup.name}` ? "Checking…" : "Restore"}
          </Button>
          <Button variant="danger" size="sm" icon="trash-2" disabled={locked} aria-expanded={deleting} onClick={() => setDeleting((v) => !v)} aria-label={`Delete ${backup.name}`}>
            Delete
          </Button>
        </div>
      </div>
      {deleting ? <ConfirmBar danger message={`Delete ${backup.name}? This cannot be undone.`} confirmLabel="Delete backup" onCancel={() => setDeleting(false)} onConfirm={() => { setDeleting(false); onDelete(); }} /> : null}
      {children}
    </li>
  );
}

export function BackupsSection() {
  const admin = useAdmin();
  const list = useAdminResource("backup.list");
  const actions = useSectionActions();
  const [options, setOptions] = useState({ quick: false, sessions: true, secrets: false });
  const [pending, setPending] = useState<Pending | null>(null);

  const create = () =>
    void actions.run("create", async () => {
      const made = await admin("backup.create", options);
      list.refresh();
      return `Created ${made.name} (${formatBytes(made.size)}).`;
    });

  const verify = (name: string) =>
    void actions.run(`verify:${name}`, async () => {
      const out = await admin("backup.verify", { name });
      if (out.ok) return `${name} is intact.`;
      return { tone: "error", message: `${name} has problems:\n${out.problems.join("\n")}` };
    });

  const preview = (name: string) => {
    setPending(null);
    void actions.run(`preview:${name}`, async () => {
      const out = await admin("backup.restore", { name, dryRun: true });
      setPending({ name, kind: "restore", files: out.restored, risky: out.risky ?? [], stage: "preview" });
      return { tone: "info", message: `Nothing has changed yet. Restoring ${name} would replace ${out.restored.length} ${out.restored.length === 1 ? "file" : "files"}.` };
    });
  };

  const restore = (name: string, trustCode: boolean) => {
    setPending(null);
    void actions.run(`restore:${name}`, async () => {
      // trustCode is only ever sent after the person confirmed the risky files a second time.
      const out = await admin("backup.restore", trustCode ? { name, trustCode: true } : { name });
      list.refresh();
      return `Restored ${out.restored.length} ${out.restored.length === 1 ? "file" : "files"} from ${name}.${out.safetyBackup ? ` The state before is saved as ${out.safetyBackup}.` : ""} Restart the gateway to load it.`;
    });
  };

  const remove = (name: string) =>
    void actions.run(`delete:${name}`, async () => {
      const out = await admin("backup.delete", { name });
      list.refresh();
      return out.removed ? `Deleted ${name}.` : `${name} was already gone.`;
    });

  const restoring = pending?.kind === "restore" ? pending : null;

  return (
    <AdminCard title="Backups" icon="archive" bodyClassName="p-0">
      <div className="flex flex-col gap-3 border-b border-rule p-4 sm:p-5">
        <fieldset className="grid gap-2 sm:grid-cols-3" disabled={actions.busy !== null}>
          <legend className="type-meta mb-2 text-ink-3">New backup</legend>
          <Option label="Quick" hint="Settings only. Skips sessions, plugins and learning data." checked={options.quick} onChange={(quick) => setOptions((o) => ({ ...o, quick }))} />
          <Option label="Sessions" hint="Include conversation history." checked={options.sessions && !options.quick} disabled={options.quick} onChange={(sessions) => setOptions((o) => ({ ...o, sessions }))} />
          <Option label="Secrets" hint="Include API keys and the bot token. Keep the archive private." checked={options.secrets} onChange={(secrets) => setOptions((o) => ({ ...o, secrets }))} />
        </fieldset>
        <div>
          <Button variant="primary" size="sm" icon="archive" disabled={actions.busy !== null} onClick={create}>
            {actions.busy === "create" ? "Creating…" : "Create backup"}
          </Button>
        </div>
        <ResultNote result={actions.result} className="mt-0" />
      </div>
      <ResourceView resource={list} noun="backups" className="gap-0">
        {(backups) =>
          backups.length === 0 ? (
            <p className="px-5 py-8 text-center text-[13.5px] text-ink-2">No backups yet. Create one above; tcode also makes one before a restore or an update.</p>
          ) : (
            <ul className="divide-y divide-rule" aria-label="Backups">
              {backups.map((backup) => (
                <BackupRow key={backup.name} backup={backup} busy={actions.busy} onVerify={() => verify(backup.name)} onRestore={() => preview(backup.name)} onDelete={() => remove(backup.name)}>
                  {restoring && restoring.name === backup.name ? (
                    <div className="flex flex-col gap-3">
                      <div className="rounded-[10px] border border-rule bg-paper-2 p-3">
                        <p className="type-meta text-ink-3">Would restore</p>
                        {restoring.files.length === 0 ? (
                          <p className="mt-1 text-[13px] text-ink-2">No files would change.</p>
                        ) : (
                          <ul className="scroll-quiet mt-1.5 max-h-40 overflow-y-auto font-mono text-[12px] leading-relaxed text-ink-2" aria-label="Files that would be restored">
                            {restoring.files.map((file) => (
                              <li key={file} className="break-all">
                                {file}
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                      {restoring.risky.length > 0 ? (
                        <div role="alert" className="rounded-[10px] border border-error/20 bg-error-wash p-3">
                          <p className="text-[13px] font-medium text-ink">This backup replaces files that can run code or let people in</p>
                          <ul className="mt-1.5 flex flex-col gap-1 text-[12.5px] leading-snug text-ink-2" aria-label="Files that can run code or let people in">
                            {restoring.risky.map((item) => (
                              <li key={item.path}>
                                <span className="break-all font-mono text-[12px] text-ink">{item.path}</span> <span>{item.why}</span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      ) : null}
                      {restoring.stage === "trust" ? (
                        <ConfirmBar
                          danger
                          message="Only continue if you made this backup or fully trust whoever did. These files will run or be followed as if you had written them."
                          confirmLabel="I trust it, restore"
                          disabled={actions.busy !== null}
                          onCancel={() => setPending(null)}
                          onConfirm={() => restore(backup.name, true)}
                        />
                      ) : (
                        <ConfirmBar
                          message="Restore these files? tcode saves the current state as a safety backup first."
                          confirmLabel={restoring.risky.length > 0 ? "Continue" : "Restore now"}
                          disabled={actions.busy !== null}
                          onCancel={() => setPending(null)}
                          onConfirm={() => (restoring.risky.length > 0 ? setPending({ ...restoring, stage: "trust" }) : restore(backup.name, false))}
                        />
                      )}
                    </div>
                  ) : null}
                </BackupRow>
              ))}
            </ul>
          )
        }
      </ResourceView>
    </AdminCard>
  );
}

const UNINSTALL: Array<{ command: string; title: string; text: string }> = [
  { command: "tcode uninstall --dry-run", title: "Preview", text: "Lists everything an uninstall would remove and changes nothing. Start here." },
  { command: "tcode uninstall", title: "Remove the program", text: "Removes the installed versions, the tcode command, the PATH line the installer added and the login service. Your settings, keys and sessions stay in ~/.tropos." },
  { command: "tcode uninstall --all", title: "Remove everything", text: "Also deletes ~/.tropos: settings, keys, sessions, memory and backups. Make a backup above first if you may want any of it." },
];

export function UninstallSection() {
  return (
    <AdminCard title="Uninstall" icon="trash-2">
      <p className="text-[13px] leading-relaxed text-ink-2">This app is running from the installation it would remove, so it cannot do this itself. Run one of these in a terminal.</p>
      <ol className="mt-4 flex flex-col gap-4">
        {UNINSTALL.map((item) => (
          <li key={item.command} className="flex flex-col gap-1.5">
            <p className="text-[13.5px] font-medium text-ink">{item.title}</p>
            <CommandBlock command={item.command} label={`Copy ${item.command}`} />
            <p className="text-[12.5px] leading-relaxed text-ink-2">{item.text}</p>
          </li>
        ))}
      </ol>
    </AdminCard>
  );
}
