// web/src/app/pages/ProjectsPage.tsx — the folders Tropos works in (projects.list): default and built-in badges, a git
// indicator with the reason behind the warning, Add project (folder browser), Make default and Remove with confirm.
import { useState } from "react";

import type { ProjectView } from "@core/web/admin/api";

import { PageFrame } from "@/app/layout/PageFrame";
import { PageActions } from "@/components/pages/page-actions";
import { ResourceView } from "@/components/pages/resource-view";
import { useRpcResource } from "@/components/pages/use-rpc-resource";
import { AddProjectDialog } from "@/components/setup/AddProjectDialog";
import { ConfirmDialog, Notice, useAction } from "@/components/setup/admin-ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Icon } from "@/components/ui/icon";
import { useAdmin } from "@/lib/store";

function ProjectRow({ project, onChanged, onRemove }: { project: ProjectView; onChanged: () => void; onRemove: (project: ProjectView) => void }) {
  const admin = useAdmin();
  const makeDefault = useAction();
  const toDefault = async () => {
    const done = await makeDefault.run(() => admin("projects.setDefault", { id: project.id }));
    if (done) onChanged();
  };
  return (
    <li className="flex flex-col gap-3 px-5 py-4">
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
        <span className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-[10px] border border-rule bg-paper-2 text-ink-2">
          <Icon name={project.gitRepo ? "git-branch" : "folder"} size="md" tone={project.isDefault ? "accent" : "current"} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <strong className="text-[14.5px] font-medium text-ink">{project.name}</strong>
            {project.isDefault ? <Badge tone="accent">default</Badge> : null}
            {project.builtin ? <Badge tone="neutral">built-in</Badge> : null}
            {project.gitRepo ? (
              <Badge tone="ok" dot={false}>
                git repo
              </Badge>
            ) : (
              <Badge tone="warn">no git</Badge>
            )}
          </p>
          <p className="mt-1 break-all font-mono text-[12.5px] text-ink-2">{project.path}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {!project.isDefault ? (
            <Button size="sm" icon="check" onClick={() => void toDefault()} disabled={makeDefault.pending} aria-label={`Make ${project.name} the default project`}>
              {makeDefault.pending ? "Saving…" : "Make default"}
            </Button>
          ) : null}
          {!project.builtin ? (
            <Button variant="danger" size="sm" icon="trash-2" onClick={() => onRemove(project)} aria-label={`Remove ${project.name}`}>
              Remove
            </Button>
          ) : null}
        </div>
      </div>
      {!project.gitRepo ? (
        <Notice tone="warn">
          Not a git repository. The sandbox keeps <code className="font-mono text-[12px]">.git/hooks</code> and <code className="font-mono text-[12px]">.git/config</code> read-only so a command run in Docker can't plant something your next{" "}
          <code className="font-mono text-[12px]">git</code> command would run. With no <code className="font-mono text-[12px]">.git</code> folder that protection can't apply: run <code className="font-mono text-[12px]">git init</code> in this folder.
        </Notice>
      ) : null}
      {makeDefault.error ? <Notice tone="error">Couldn't change the default: {makeDefault.error}</Notice> : null}
    </li>
  );
}

function Explainer() {
  return (
    <Card className="flex flex-col gap-2 bg-paper/60">
      <h2 className="text-[14px] font-medium text-ink">How projects work</h2>
      <ul className="flex list-disc flex-col gap-1.5 pl-5 text-[13.5px] leading-relaxed text-ink-2 marker:text-ink-4">
        <li>A chat from Telegram works in its <strong className="font-medium text-ink">active project</strong>: files it creates or edits live in that folder.</li>
        <li>
          Send <code className="font-mono text-[12.5px] text-ink">/project</code> in a chat to see the list or switch the active project for that chat.
        </li>
        <li>The <strong className="font-medium text-ink">default project</strong> is where new chats start. The built-in one needs no setup: Tropos creates it for you.</li>
      </ul>
    </Card>
  );
}

export function ProjectsPage() {
  const admin = useAdmin();
  const resource = useRpcResource("projects.list", () => admin("projects.list"));
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<ProjectView | null>(null);
  const remove = useAction();

  const confirmRemove = async () => {
    if (!removing) return;
    const done = await remove.run(() => admin("projects.remove", { id: removing.id }));
    if (done) {
      setRemoving(null);
      resource.refresh();
    }
  };

  return (
    <PageFrame
      title="Projects"
      eyebrow="Work"
      description="The folders the agent can work in. Removing a project only forgets it here: your files stay where they are."
      actions={
        <>
          <PageActions resource={resource} noun="projects" />
          <Button variant="primary" size="sm" icon="folder-plus" onClick={() => setAdding(true)} aria-haspopup="dialog">
            Add project
          </Button>
        </>
      }
    >
      <Explainer />
      <ResourceView resource={resource} noun="projects">
        {(projects) =>
          projects.length === 0 ? (
            <Card>
              <EmptyState icon="folder" title="No projects yet" description="Add a folder to work in. Without one, chats use the built-in project." action={<Button variant="primary" icon="folder-plus" onClick={() => setAdding(true)}>Add project</Button>} />
            </Card>
          ) : (
            <ul aria-label="Projects" className="divide-y divide-rule overflow-hidden rounded-[14px] border border-rule bg-surface shadow-card">
              {projects.map((project) => (
                <ProjectRow
                  key={project.id}
                  project={project}
                  onChanged={resource.refresh}
                  onRemove={(p) => {
                    remove.clear();
                    setRemoving(p);
                  }}
                />
              ))}
            </ul>
          )
        }
      </ResourceView>
      <AddProjectDialog
        open={adding}
        onClose={() => setAdding(false)}
        onAdded={() => {
          setAdding(false);
          resource.refresh();
        }}
      />
      <ConfirmDialog
        open={removing !== null}
        title={`Remove ${removing?.name ?? "project"}?`}
        description={
          <>
            Tropos forgets <code className="break-all font-mono text-[12.5px]">{removing?.path}</code>. The folder and its files are not touched.
          </>
        }
        confirmLabel="Remove project"
        pending={remove.pending}
        error={remove.error}
        onConfirm={() => void confirmRemove()}
        onCancel={() => setRemoving(null)}
      />
    </PageFrame>
  );
}
