// web/src/app/pages/ConfigPage.tsx — settings.json and gateway.json as a form generated from their JSON Schema, or as raw
// JSON. The form saves one field at a time; the raw editor validates the whole file before writing it.
import { useCallback, useState } from "react";

import type { ConfigFile, ConfigView } from "@core/web/admin/api";

import { PageFrame } from "@/app/layout/PageFrame";
import { ConfigForm } from "@/components/admin/config-form";
import { RawEditor } from "@/components/admin/config-raw";
import { useAdminResource } from "@/components/admin/use-admin-resource";
import { SegmentedControl } from "@/components/interior/segmented-control";
import { Tabs, type TabItem } from "@/components/interior/tabs";
import { PathLine } from "@/components/pages/panel-parts";
import { ResourceView } from "@/components/pages/resource-view";
import { Button } from "@/components/ui/button";
import { errorMessage, useAdmin } from "@/lib/store";

const FILES: TabItem[] = [
  { value: "settings", label: "Settings" },
  { value: "gateway", label: "Gateway" },
];

const MODES = [
  { value: "form", label: "Form" },
  { value: "raw", label: "Raw JSON" },
];

function FilePanel({ file }: { file: ConfigFile }) {
  const admin = useAdmin();
  const resource = useAdminResource("config.get", { file });
  const [mode, setMode] = useState<"form" | "raw">("form");
  const [rawDraft, setRawDraft] = useState<string | null>(null);
  const [saved, setSaved] = useState<{ base: unknown; view: ConfigView } | null>(null);
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const base = resource.data;

  const take = useCallback((view: ConfigView) => {
    setSaved({ base, view });
    setSavedAt(new Date());
  }, [base]);

  const commit = useCallback(
    async (path: string, value: unknown): Promise<string | null> => {
      try {
        take(await admin("config.set", { file, path, value }));
        return null;
      } catch (error) {
        return errorMessage(error);
      }
    },
    [admin, file, take],
  );

  return (
    <div className="flex flex-col gap-5">
      <ResourceView resource={resource} noun={`${file}.json`}>
        {(loaded) => {
          const view = saved && saved.base === loaded ? saved.view : loaded;
          return (
            <>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
                <SegmentedControl label="Editing mode" options={MODES} value={mode} onValueChange={(next) => setMode(next as "form" | "raw")} className="w-[15rem] max-w-full" />
                <div className="min-w-0 flex-1 basis-60">
                  <PathLine path={view.path} label={`Copy the path of ${file}.json`} />
                </div>
                <p className="text-[12.5px] text-ink-3" aria-live="polite">
                  {savedAt ? `Last saved ${savedAt.toLocaleTimeString()}` : "Not saved in this session"}
                </p>
                <Button variant="ghost" size="sm" icon="refresh-cw" onClick={() => { setSaved(null); resource.refresh(); }}>
                  Reload from disk
                </Button>
              </div>
              {mode === "form" ? (
                <ConfigForm view={view} commit={commit} />
              ) : (
                <RawEditor file={file} draft={rawDraft} onDraft={setRawDraft} onApplied={take} />
              )}
            </>
          );
        }}
      </ResourceView>
    </div>
  );
}

export function ConfigPage() {
  return (
    <PageFrame title="Configuration" eyebrow="Control" description="Everything in settings.json and gateway.json. Secrets are never shown: leave a secret field empty to keep it.">
      <Tabs items={FILES} defaultValue="settings" label="Config files" panelClassName="p-4 sm:p-6" renderPanel={(value) => <FilePanel key={value} file={value as ConfigFile} />} />
    </PageFrame>
  );
}
