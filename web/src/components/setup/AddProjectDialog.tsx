// web/src/components/setup/AddProjectDialog.tsx — "Add project": a folder browser driven by projects.browse (folders only,
// git repositories marked, breadcrumb + Up button, a field to paste a path) and projects.add.
import { useCallback, useEffect, useState } from "react";

import type { BrowseEntry, ProjectView } from "@core/web/admin/api";

import { Modal } from "@/components/interior/modal";
import { Notice, TextField, useAction } from "@/components/setup/admin-ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { errorMessage, useAdmin } from "@/lib/store";
import { cn } from "@/lib/utils";

interface Listing {
  path: string;
  parent: string | null;
  entries: BrowseEntry[];
}

/** "/Users/me/code" → [{name:"/",path:"/"},{name:"Users",…},…] for the breadcrumb. */
export function crumbs(path: string): { name: string; path: string }[] {
  const parts = path.split("/").filter(Boolean);
  const out = [{ name: "/", path: "/" }];
  let acc = "";
  for (const part of parts) {
    acc += `/${part}`;
    out.push({ name: part, path: acc });
  }
  return out;
}

function Browser({ onClose, onAdded }: { onClose: () => void; onAdded: (project: ProjectView) => void }) {
  const admin = useAdmin();
  const [listing, setListing] = useState<Listing | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [pathText, setPathText] = useState("");
  const [name, setName] = useState("");
  const add = useAction();

  const go = useCallback(
    (path?: string) => {
      setLoading(true);
      setLoadError(null);
      admin("projects.browse", path ? { path } : undefined).then(
        (next) => {
          setListing(next);
          setPathText(next.path);
          setLoading(false);
        },
        (error: unknown) => {
          setLoadError(errorMessage(error));
          setLoading(false);
        },
      );
    },
    [admin],
  );

  useEffect(() => {
    go();
  }, [go]);

  const submit = async () => {
    if (!listing) return;
    const project = await add.run(() => admin("projects.add", { path: listing.path, ...(name.trim() ? { name: name.trim() } : {}) }));
    if (project) onAdded(project);
  };

  return (
    <div className="flex flex-col gap-4">
      <form
        className="flex items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          go(pathText.trim() || undefined);
        }}
      >
        <TextField label="Folder path" value={pathText} onChange={setPathText} mono placeholder="/Users/you/code/my-app" className="flex-1" hint="Paste a path and press Go, or click through the folders below." />
        <Button type="submit" variant="secondary" className="mb-[22px]" disabled={loading}>
          Go
        </Button>
      </form>

      {listing ? (
        <nav aria-label="Current folder" className="flex flex-wrap items-center gap-1 text-[12.5px] text-ink-2">
          <Button variant="ghost" size="sm" icon="arrow-up" disabled={listing.parent === null || loading} onClick={() => listing.parent && go(listing.parent)} aria-label="Go to the parent folder">
            Up
          </Button>
          <ol className="flex min-w-0 flex-wrap items-center gap-0.5 font-mono">
            {crumbs(listing.path).map((crumb, index, all) => (
              <li key={crumb.path} className="flex items-center gap-0.5">
                <button
                  type="button"
                  onClick={() => go(crumb.path)}
                  aria-current={index === all.length - 1 ? "location" : undefined}
                  className={cn("rounded-[6px] px-1.5 py-0.5 outline-none transition-colors duration-150 hover:bg-paper-2 hover:text-ink focus-visible:shadow-focus", index === all.length - 1 && "text-ink")}
                >
                  {crumb.name}
                </button>
                {index < all.length - 1 && crumb.name !== "/" ? (
                  <span aria-hidden className="text-ink-4">
                    /
                  </span>
                ) : null}
              </li>
            ))}
          </ol>
        </nav>
      ) : null}

      <div aria-live="polite" aria-busy={loading || undefined}>
        {loadError ? (
          <div className="flex flex-col items-start gap-2">
            <Notice tone="error">Couldn't open that folder: {loadError}</Notice>
            <Button variant="secondary" size="sm" icon="refresh-cw" onClick={() => go(listing?.path)}>
              Retry
            </Button>
          </div>
        ) : null}
        {listing && !loadError ? (
          listing.entries.length === 0 ? (
            <p className="rounded-[10px] border border-dashed border-rule px-3 py-6 text-center text-[13px] text-ink-3">No sub-folders here. You can still use this folder.</p>
          ) : (
            <ul aria-label="Folders" className={cn("max-h-[264px] divide-y divide-rule overflow-y-auto rounded-[10px] border border-rule bg-surface transition-opacity duration-150", loading && "opacity-60")}>
              {listing.entries.map((entry) => (
                <li key={entry.path}>
                  <button
                    type="button"
                    onClick={() => go(entry.path)}
                    className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-[13.5px] text-ink outline-none transition-colors duration-150 hover:bg-paper focus-visible:bg-accent-wash/60 focus-visible:shadow-[inset_0_0_0_1px_var(--accent)]"
                  >
                    <Icon name={entry.isGitRepo ? "git-branch" : "folder"} size="md" tone={entry.isGitRepo ? "accent" : "current"} />
                    <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                    {entry.isGitRepo ? (
                      <Badge tone="accent" className="h-5 text-[11px]">
                        git repo
                      </Badge>
                    ) : null}
                    <Icon name="chevron-right" size="sm" />
                  </button>
                </li>
              ))}
            </ul>
          )
        ) : null}
        {loading && !listing && !loadError ? <p className="text-[13px] text-ink-3">Loading folders…</p> : null}
      </div>

      {listing ? (
        <div className="flex flex-col gap-3 rounded-[12px] border border-rule bg-paper px-4 py-3.5">
          <p className="text-[13px] text-ink-2">
            Use <code className="break-all font-mono text-[12.5px] text-ink">{listing.path}</code> as a project.
          </p>
          <TextField label="Name (optional)" value={name} onChange={setName} placeholder="Defaults to the folder name" />
          {add.error ? <Notice tone="error">Couldn't add the project: {add.error}</Notice> : null}
        </div>
      ) : null}

      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose} disabled={add.pending}>
          Cancel
        </Button>
        <Button variant="primary" icon="folder-plus" onClick={() => void submit()} disabled={!listing || add.pending || loading}>
          {add.pending ? "Adding…" : "Add this folder"}
        </Button>
      </div>
    </div>
  );
}

export function AddProjectDialog({ open, onClose, onAdded }: { open: boolean; onClose: () => void; onAdded: (project: ProjectView) => void }) {
  return (
    <Modal open={open} onClose={onClose} title="Add a project" description="Pick the folder the agent should work in." maxWidth={600} closeLabel="Close dialog">
      <Browser onClose={onClose} onAdded={onAdded} />
    </Modal>
  );
}
