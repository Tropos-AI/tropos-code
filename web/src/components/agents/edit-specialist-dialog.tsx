// web/src/components/agents/edit-specialist-dialog.tsx — the owner's edit form for one specialist. It sends the revision
// it was opened on and only the fields that changed; a refusal (someone changed it meanwhile) stays in the dialog.
import { useState } from "react";

import type { AgentRoster, AutonomyLevel, SpecialistEdit, SpecialistView } from "@core/web/admin/api";

import { Modal } from "@/components/interior/modal";
import { Notice, SelectField, TextArea, TextField, useAction } from "@/components/setup/admin-ui";
import { Button } from "@/components/ui/button";
import { useAdmin } from "@/lib/store";

const AUTONOMY_OPTIONS = [
  { value: "", label: "Same as the chief" },
  { value: "ask", label: "ask" },
  { value: "balanced", label: "balanced" },
  { value: "autonomous", label: "autonomous" },
];

const splitTools = (text: string): string[] => text.split(",").map((t) => t.trim()).filter(Boolean);

/** Only what differs from `spec`; empty model, tools, emoji and autonomy mean "unset". */
export function changesFrom(spec: SpecialistView, form: { description: string; contract: string; model: string; tools: string; emoji: string; autonomy: string }): SpecialistEdit {
  const out: SpecialistEdit = {};
  if (form.description.trim() !== spec.description) out.description = form.description.trim();
  if (form.contract !== spec.contract) out.contract = form.contract;
  if (form.model.trim() !== (spec.model ?? "")) out.model = form.model.trim() || null;
  const tools = splitTools(form.tools);
  if (JSON.stringify(tools) !== JSON.stringify(spec.tools ?? [])) out.tools = tools.length > 0 ? tools : null;
  if (form.emoji.trim() !== (spec.emoji ?? "")) out.emoji = form.emoji.trim() || null;
  if (form.autonomy !== (spec.autonomy ?? "")) out.autonomy = (form.autonomy || null) as AutonomyLevel | null;
  return out;
}

interface Props {
  spec: SpecialistView;
  open: boolean;
  onClose: () => void;
  onSaved: (roster: AgentRoster) => void;
}

export function EditSpecialistDialog({ spec, open, onClose, onSaved }: Props) {
  const admin = useAdmin();
  const save = useAction();
  const [form, setForm] = useState({
    description: spec.description,
    contract: spec.contract,
    model: spec.model ?? "",
    tools: (spec.tools ?? []).join(", "),
    emoji: spec.emoji ?? "",
    autonomy: spec.autonomy ?? "",
  });
  const set = (key: keyof typeof form) => (value: string) => setForm((f) => ({ ...f, [key]: value }));

  const submit = async () => {
    const roster = await save.run(() => admin("agents.update", { id: spec.id, revision: spec.revision, changes: changesFrom(spec, form) }));
    if (roster) {
      onSaved(roster);
      onClose();
    }
  };

  return (
    <Modal open={open} onClose={save.pending ? () => {} : onClose} title={`Edit ${spec.id}`} description="Changes are saved as a new revision and can be undone." closeLabel="Close dialog" maxWidth={640}>
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <TextField label="Description" value={form.description} onChange={set("description")} hint="One line the chief reads when deciding who to ask." />
        <TextArea label="Role contract" value={form.contract} onChange={set("contract")} rows={12} mono hint="Purpose, what it leaves to others, what it reports, when it hands back." />
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField label="Model" value={form.model} onChange={set("model")} mono placeholder="the chief's model" hint="Empty uses the chief's model." />
          <TextField label="Emoji" value={form.emoji} onChange={set("emoji")} />
        </div>
        <TextField label="Tools" value={form.tools} onChange={set("tools")} mono placeholder="all the chief's tools" hint="Comma-separated. Empty gives it every tool the chief has." />
        <SelectField label="Autonomy" value={form.autonomy} onChange={set("autonomy")} options={AUTONOMY_OPTIONS} />
        {save.error ? <Notice tone="error">{save.error}</Notice> : null}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={save.pending}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" disabled={save.pending}>
            {save.pending ? "Saving…" : "Save changes"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
