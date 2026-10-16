// web/src/components/admin/config-form.tsx — the form mode of the Config page: one card per top-level group of the file's
// JSON Schema, each field saving on its own through config.set.
import { useMemo } from "react";

import type { ConfigView } from "@core/web/admin/api";

import { AdminCard } from "@/components/admin/admin-parts";
import { FieldNode, FormProvider, type FormContextValue } from "@/components/admin/schema-fields";
import { describeField, getAtPath, humanize, type Schema } from "@/components/admin/schema-utils";
import { EmptyState } from "@/components/ui/empty-state";
import type { IconName } from "@/components/ui/icon";

const ICONS: Record<string, IconName> = { permissions: "shield", sandbox: "shield-check", providers: "key", mcpServers: "network", hooks: "workflow", env: "terminal", telegram: "send" };

export function ConfigForm({ view, commit }: { view: ConfigView; commit: FormContextValue["commit"] }) {
  const ctx = useMemo<FormContextValue>(() => ({ root: view.schema, commit }), [view.schema, commit]);
  const top = describeField(view.schema, view.schema);
  const properties = top.properties ?? [];

  if (properties.length === 0) {
    return (
      <AdminCard title="Fields" icon="sliders-horizontal">
        <EmptyState icon="code" title="No form for this file" description="Its schema has no named fields. Use Raw JSON to edit it." />
      </AdminCard>
    );
  }

  // Scalars first in one "General" card, then a card for every group (object or record or list).
  const leaves = properties.filter(([, schema]) => describeField(schema, view.schema).kind !== "object");
  const scalars = leaves.filter(([, schema]) => ["string", "number", "integer", "boolean", "enum"].includes(describeField(schema, view.schema).kind));
  const others = leaves.filter((entry) => !scalars.includes(entry));
  const groups = properties.filter(([, schema]) => describeField(schema, view.schema).kind === "object");

  type Entry = { name: string; path: string; schema: Schema; value: unknown };
  const topEntry = ([key, schema]: [string, Schema]): Entry => ({ name: key, path: key, schema, value: getAtPath(view.value, key) });
  const card = (title: string, icon: IconName, entries: Entry[], description?: string) => (
    <AdminCard key={title} title={title} icon={icon} bodyClassName="divide-y divide-rule py-0">
      {description ? <p className="py-3 text-[12.5px] leading-relaxed text-ink-2">{description}</p> : null}
      {entries.map((e) => (
        <FieldNode key={e.path} name={e.name} path={e.path} schema={e.schema} value={e.value} depth={1} />
      ))}
    </AdminCard>
  );
  // A group's own fields become the card's rows (the card title already names the group).
  const groupCard = ([key, schema]: [string, Schema]) => {
    const info = describeField(schema, view.schema);
    const groupValue = getAtPath(view.value, key);
    const entries = (info.properties ?? []).map(([child, childSchema]): Entry => ({ name: child, path: `${key}.${child}`, schema: childSchema, value: getAtPath(groupValue, child) }));
    return card(humanize(key), ICONS[key] ?? "layers", entries, info.description);
  };

  return (
    <FormProvider value={ctx}>
      <div className="flex flex-col gap-6">
        {scalars.length > 0 ? card("General", "settings", scalars.map(topEntry)) : null}
        {groups.map(groupCard)}
        {others.map((entry) => card(humanize(entry[0]), ICONS[entry[0]] ?? "layers", [topEntry(entry)]))}
      </div>
    </FormProvider>
  );
}
