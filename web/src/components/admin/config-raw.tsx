// web/src/components/admin/config-raw.tsx — the Raw JSON mode of the Config page: the (redacted) file as text, checked
// in the browser first, then validated and written by config.apply. A refusal keeps the text and, when the message
// names a line, selects it.
import { useId, useRef, useState } from "react";

import type { ConfigFile, ConfigView } from "@core/web/admin/api";

import { FIELD_CLASS, ResultNote, type ActionResult } from "@/components/admin/admin-parts";
import { errorLocation } from "@/components/admin/schema-utils";
import { useAdminResource } from "@/components/admin/use-admin-resource";
import { ResourceView } from "@/components/pages/resource-view";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { errorMessage, useAdmin } from "@/lib/store";
import { cn } from "@/lib/utils";

type Props = {
  file: ConfigFile;
  /** Unsaved text, kept by the parent so switching to the form and back loses nothing. */
  draft: string | null;
  onDraft: (text: string | null) => void;
  onApplied: (view: ConfigView) => void;
};

export function RawEditor({ file, draft, onDraft, onApplied }: Props) {
  const admin = useAdmin();
  const resource = useAdminResource("config.raw", { file });
  const area = useRef<HTMLTextAreaElement>(null);
  const errorId = useId();
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<{ message: string; line?: number } | null>(null);
  const [ok, setOk] = useState<ActionResult | null>(null);
  const [applied, setApplied] = useState<{ base: unknown; text: string } | null>(null);

  const select = (text: string, line: number) => {
    const el = area.current;
    if (!el) return;
    const lines = text.split("\n");
    const start = lines.slice(0, line - 1).reduce((n, l) => n + l.length + 1, 0);
    el.focus();
    el.setSelectionRange(start, start + (lines[line - 1]?.length ?? 0));
  };

  const fail = (message: string, text: string) => {
    const where = errorLocation(message, text);
    setFailure({ message, line: where?.line });
    if (where) requestAnimationFrame(() => select(text, where.line));
  };

  return (
    <ResourceView resource={resource} noun="the raw file" className="gap-3">
      {(raw) => {
        const base = applied && applied.base === raw ? applied.text : raw.text;
        const text = draft ?? base;
        const dirty = draft !== null && draft !== base;

        const submit = async () => {
          setOk(null);
          setFailure(null);
          try {
            JSON.parse(text);
          } catch (error) {
            return fail(`Not valid JSON: ${error instanceof Error ? error.message : String(error)}`, text);
          }
          setPending(true);
          try {
            const view = await admin("config.apply", { file, text });
            setApplied({ base: raw, text });
            onDraft(null);
            onApplied(view);
            setOk({ tone: "ok", message: `Saved to ${raw.path}. Changes apply the next time the gateway or app starts, unless a setting says otherwise.` });
            resource.refresh();
          } catch (error) {
            fail(errorMessage(error), text);
          } finally {
            setPending(false);
          }
        };

        return (
          <>
            <textarea
              ref={area}
              value={text}
              aria-label={`${file}.json`}
              aria-invalid={failure ? true : undefined}
              aria-describedby={failure ? errorId : undefined}
              spellCheck={false}
              wrap="off"
              onChange={(event) => {
                onDraft(event.target.value);
                setOk(null);
                if (failure) setFailure(null);
              }}
              className={cn(FIELD_CLASS, "scroll-quiet h-[min(60vh,520px)] resize-y whitespace-pre py-3 font-mono text-[12.5px] leading-[1.6]")}
            />
            {failure ? (
              <p id={errorId} role="alert" className="flex items-start gap-2 rounded-[10px] border border-error/20 bg-error-wash px-3 py-2 text-[13px] leading-relaxed text-error">
                <span className="mt-[3px] inline-flex shrink-0">
                  <Icon name="circle-alert" size="sm" />
                </span>
                <span className="min-w-0 break-words">
                  {failure.line ? <strong className="mr-1.5 font-mono font-medium">Line {failure.line}.</strong> : null}
                  {failure.message}
                  <span className="mt-0.5 block text-ink-2">Nothing was written. Your text is still here.</span>
                </span>
              </p>
            ) : null}
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="primary" size="sm" icon="save" disabled={!dirty || pending} onClick={() => void submit()}>
                {pending ? "Saving…" : "Validate & save"}
              </Button>
              <Button variant="ghost" size="sm" icon="undo-2" disabled={!dirty || pending} onClick={() => { onDraft(null); setFailure(null); }}>
                Revert
              </Button>
              <span className="ml-auto font-mono text-[12px] tabular-nums text-ink-3">{text.split("\n").length} lines</span>
            </div>
            <ResultNote result={ok} className="mt-0" />
          </>
        );
      }}
    </ResourceView>
  );
}
