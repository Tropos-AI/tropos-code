// web/src/components/admin/schema-fields.tsx — the controls of the schema-driven config form. Every leaf field saves on
// its own through the form's `commit(path, value)`: text and number inputs on blur or Enter, switches, selects and chip
// lists immediately, key/value records and JSON fallbacks with an explicit Save. A refusal is shown next to the field
// and the user's input stays. Secrets are write-only: an empty field leaves the stored value alone.
import { createContext, useContext, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import { FIELD_CLASS, Switch } from "@/components/admin/admin-parts";
import { MASK, describeField, getAtPath, humanize, isMasked, isSecretField, type FieldInfo, type Schema } from "@/components/admin/schema-utils";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

export interface FormContextValue {
  root: Schema;
  /** Saves one dotted path (`null` unsets it). Resolves with the server's refusal, or null when it was saved. */
  commit: (path: string, value: unknown) => Promise<string | null>;
}

const FormContext = createContext<FormContextValue | null>(null);
export const FormProvider = FormContext.Provider;

function useForm(): FormContextValue {
  const ctx = useContext(FormContext);
  if (!ctx) throw new Error("Field used outside a config form");
  return ctx;
}

type SaveState = { status: "idle" | "saving" | "saved" | "error"; error?: string };

/** One field's save lifecycle. `save` resolves true when the server accepted the value. */
function useFieldSave(path: string) {
  const { commit } = useForm();
  const [state, setState] = useState<SaveState>({ status: "idle" });
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const save = async (value: unknown): Promise<boolean> => {
    setState({ status: "saving" });
    const error = await commit(path, value);
    if (alive.current) setState(error === null ? { status: "saved" } : { status: "error", error });
    return error === null;
  };
  const fail = (error: string) => setState({ status: "error", error });
  const touch = () => setState((s) => (s.status === "idle" ? s : { status: "idle" }));
  const begin = () => setState({ status: "saving" });
  const done = () => setState({ status: "saved" });
  return { state, save, fail, touch, begin, done };
}

type ControlIds = { id: string; describedBy: string | undefined; invalid: boolean };

type ShellProps = {
  name: string;
  path: string;
  info: FieldInfo;
  value: unknown;
  state: SaveState;
  onReset: () => void;
  children: (ids: ControlIds) => ReactNode;
};

/** Label and description on the left, the control with its status line on the right. */
function FieldShell({ name, path, info, value, state, onReset, children }: ShellProps) {
  const id = useId();
  const descId = useId();
  const errorId = useId();
  const invalid = state.status === "error";
  const hasDefault = info.defaultValue !== undefined && typeof info.defaultValue !== "object";
  const canReset = !info.readOnly && value !== undefined && value !== null && !(hasDefault && value === info.defaultValue);
  const describedBy = [info.description ? descId : null, invalid ? errorId : null].filter(Boolean).join(" ") || undefined;
  return (
    <div className="grid gap-x-8 gap-y-2 py-4 sm:grid-cols-[minmax(0,15rem)_minmax(0,1fr)]" data-field={path}>
      <div className="min-w-0">
        <label htmlFor={id} className="inline-flex items-center gap-1.5 break-words font-mono text-[12.5px] font-medium text-ink">
          {name}
          {info.readOnly ? (
            <span className="inline-flex items-center gap-1 rounded-full border border-rule bg-paper-2 px-1.5 py-px font-sans text-[10.5px] font-normal text-ink-2">
              <Icon name="lock" size="sm" /> read-only
            </span>
          ) : null}
        </label>
        {info.description ? (
          <p id={descId} className="mt-1 text-[12.5px] leading-relaxed text-ink-2">
            {info.description}
          </p>
        ) : null}
        {hasDefault ? <p className="mt-1 font-mono text-[11.5px] text-ink-3">default: {String(info.defaultValue)}</p> : null}
      </div>
      <div className="min-w-0">
        {children({ id, describedBy, invalid })}
        <div className="mt-1.5 flex min-h-[22px] flex-wrap items-center gap-x-3 gap-y-1">
          <span aria-live="polite" className="text-[12.5px] text-ink-3">
            {state.status === "saving" ? "Saving…" : state.status === "saved" ? <span className="inline-flex items-center gap-1 text-ok"><Icon name="check" size="sm" /> Saved</span> : ""}
          </span>
          {invalid ? (
            <p id={errorId} role="alert" className="flex items-start gap-1.5 text-[12.5px] leading-snug text-error">
              <span className="mt-px inline-flex shrink-0">
                <Icon name="circle-alert" size="sm" />
              </span>
              <span className="min-w-0 break-words">{state.error}</span>
            </p>
          ) : null}
          {canReset ? (
            <button
              type="button"
              onClick={onReset}
              aria-label={`Reset ${name} to default`}
              className="ml-auto inline-flex h-6 items-center gap-1 rounded-[6px] px-1.5 text-[12px] font-medium text-ink-2 outline-none transition-colors duration-150 hover:bg-paper-2 hover:text-ink focus-visible:shadow-focus active:bg-paper-3"
            >
              <Icon name="undo-2" size="sm" />
              Reset
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

// ---------- scalar controls ----------

function TextControl({ ids, value, secret, readOnly, numeric, info, save, fail, touch }: { ids: ControlIds; value: unknown; secret: boolean; readOnly: boolean; numeric: boolean; info: FieldInfo; save: (v: unknown) => Promise<boolean>; fail: (e: string) => void; touch: () => void }) {
  const stored = value === undefined || value === null ? "" : secret ? "" : String(value);
  const [draft, setDraft] = useState<string | null>(null);
  const masked = secret && isMasked(value);
  const text = draft ?? stored;

  const commit = async () => {
    if (draft === null) return;
    if (draft === stored || (secret && draft === "")) {
      setDraft(null);
      return;
    }
    let out: unknown = draft;
    if (numeric) {
      const n = Number(draft);
      if (draft.trim() === "" || !Number.isFinite(n)) return fail("Enter a number.");
      if (info.kind === "integer" && !Number.isInteger(n)) return fail("Enter a whole number.");
      if (info.min !== undefined && n < info.min) return fail(`Must be at least ${info.min}.`);
      if (info.max !== undefined && n > info.max) return fail(`Must be at most ${info.max}.`);
      out = n;
    }
    if (await save(out)) setDraft(null);
  };

  if (readOnly) return <p id={ids.id} className="break-all font-mono text-[13px] text-ink-2">{secret ? MASK : stored || "—"}</p>;
  return (
    <input
      id={ids.id}
      type={secret ? "password" : numeric ? "number" : "text"}
      inputMode={numeric ? "decimal" : undefined}
      min={info.min}
      max={info.max}
      step={info.kind === "integer" ? 1 : "any"}
      value={text}
      placeholder={secret ? (masked ? `${MASK} set. Type to replace` : "Not set") : undefined}
      autoComplete="off"
      spellCheck={false}
      aria-invalid={ids.invalid || undefined}
      aria-describedby={ids.describedBy}
      onChange={(event) => {
        setDraft(event.target.value);
        touch();
      }}
      onBlur={() => void commit()}
      onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
        if (event.key === "Enter") {
          event.preventDefault();
          void commit();
        } else if (event.key === "Escape") setDraft(null);
      }}
      className={cn(FIELD_CLASS, "h-9", !secret && !numeric && "font-mono text-[13px]")}
    />
  );
}

function EnumControl({ ids, info, value, save }: { ids: ControlIds; info: FieldInfo; value: unknown; save: (v: unknown) => Promise<boolean> }) {
  const current = value === undefined || value === null ? "" : String(value);
  return (
    <select
      id={ids.id}
      value={current}
      aria-invalid={ids.invalid || undefined}
      aria-describedby={ids.describedBy}
      onChange={(event) => {
        const picked = info.options!.find((o) => String(o) === event.target.value);
        if (picked !== undefined) void save(picked);
      }}
      className={cn(FIELD_CLASS, "h-9 max-w-[22rem]")}
    >
      {current === "" ? <option value="">{info.defaultValue !== undefined ? `default (${String(info.defaultValue)})` : "not set"}</option> : null}
      {info.options!.map((option) => (
        <option key={String(option)} value={String(option)}>
          {String(option)}
        </option>
      ))}
    </select>
  );
}

function StringListControl({ ids, name, value, save, fail }: { ids: ControlIds; name: string; value: unknown; save: (v: unknown) => Promise<boolean>; fail: (e: string) => void }) {
  const list = Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  const [draft, setDraft] = useState("");
  const add = async () => {
    const item = draft.trim();
    if (!item) return;
    if (list.includes(item)) return fail(`"${item}" is already in the list.`);
    if (await save([...list, item])) setDraft("");
  };
  return (
    <div className="flex flex-col gap-2">
      {list.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5" aria-label={`${name} entries`}>
          {list.map((item) => (
            <li key={item} className="inline-flex max-w-full items-center gap-1 rounded-[8px] border border-rule bg-paper-2 py-0.5 pl-2 pr-0.5 shadow-well">
              <span className="min-w-0 break-all font-mono text-[12px] text-ink">{item}</span>
              <button
                type="button"
                aria-label={`Remove ${item}`}
                onClick={() => void save(list.filter((x) => x !== item))}
                className="grid size-5 shrink-0 place-items-center rounded-[5px] text-ink-3 outline-none transition-colors duration-150 hover:bg-paper-3 hover:text-ink focus-visible:shadow-focus"
              >
                <Icon name="x" size="sm" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex gap-2">
        <input
          id={ids.id}
          value={draft}
          placeholder="Add an entry and press Enter"
          autoComplete="off"
          spellCheck={false}
          aria-invalid={ids.invalid || undefined}
          aria-describedby={ids.describedBy}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void add();
            }
          }}
          className={cn(FIELD_CLASS, "h-9 font-mono text-[13px]")}
        />
        <Button variant="secondary" size="sm" icon="plus" className="h-9" disabled={!draft.trim()} onClick={() => void add()}>
          Add
        </Button>
      </div>
    </div>
  );
}

// ---------- records and the JSON fallback ----------

type Row = { key: string; value: string; original: string | undefined; masked: boolean; rid: number };

function rowsOf(value: unknown): Row[] {
  const entries = value && typeof value === "object" && !Array.isArray(value) ? Object.entries(value as Record<string, unknown>) : [];
  return entries.map(([key, v], i) => ({ key, value: isMasked(v) ? "" : String(v ?? ""), original: String(v ?? ""), masked: isMasked(v), rid: i }));
}

function RecordRows({ ids, name, path, info, value, begin, done, fail }: { ids: ControlIds; name: string; path: string; info: FieldInfo; value: unknown; begin: () => void; done: () => void; fail: (e: string) => void }) {
  const { commit } = useForm();
  const [rows, setRows] = useState<Row[]>(() => rowsOf(value));
  const [dirty, setDirty] = useState(false);
  const nextId = useRef(1000);
  // Follow the saved value, but never while the user has unsaved edits (a refused save keeps them).
  const latest = JSON.stringify(value ?? null);
  useEffect(() => {
    if (!dirty) setRows(rowsOf(JSON.parse(latest) as unknown));
  }, [latest, dirty]);
  const patch = (rid: number, change: Partial<Row>) => {
    setRows((rs) => rs.map((r) => (r.rid === rid ? { ...r, ...change } : r)));
    setDirty(true);
  };

  const convert = (text: string): unknown => (info.valueKind === "number" ? Number(text) : info.valueKind === "boolean" ? text === "true" : text);

  const saveAll = async () => {
    const keys = rows.map((r) => r.key.trim());
    if (keys.some((k) => k === "")) return fail("Every row needs a name.");
    if (keys.some((k) => k.includes("."))) return fail("Names can't contain a dot.");
    if (new Set(keys).size !== keys.length) return fail("Two rows have the same name.");
    if (info.valueKind === "number" && rows.some((r) => r.value.trim() !== "" && !Number.isFinite(Number(r.value)))) return fail("Values must be numbers.");
    // One key at a time keeps masked secrets out of the request: only what changed is sent.
    const before = (value && typeof value === "object" ? Object.keys(value as object) : []) as string[];
    const removed = before.filter((k) => !keys.includes(k));
    const changed = rows.filter((r) => (r.masked ? r.value !== "" : r.value !== r.original || !before.includes(r.key.trim())));
    begin();
    for (const key of removed) {
      const err = await commit(`${path}.${key}`, null);
      if (err) return fail(err);
    }
    for (const r of changed) {
      const err = await commit(`${path}.${r.key.trim()}`, convert(r.value));
      if (err) return fail(err);
    }
    setDirty(false);
    done();
  };

  return (
    <div className="flex flex-col gap-2" role="group" aria-label={name} aria-describedby={ids.describedBy}>
      {rows.length === 0 ? <p className="text-[12.5px] text-ink-3">No entries.</p> : null}
      {rows.map((row, index) => {
        const secret = row.masked || isSecretField(row.key, undefined);
        return (
          <div key={row.rid} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_auto] gap-2">
            <input aria-label={`${name} name ${index + 1}`} value={row.key} onChange={(e) => patch(row.rid, { key: e.target.value })} spellCheck={false} autoComplete="off" className={cn(FIELD_CLASS, "h-9 font-mono text-[12.5px]")} />
            <input
              aria-label={`${name} value ${index + 1}`}
              type={secret ? "password" : "text"}
              value={row.value}
              placeholder={row.masked ? `${MASK} set` : undefined}
              onChange={(e) => patch(row.rid, { value: e.target.value })}
              spellCheck={false}
              autoComplete="off"
              className={cn(FIELD_CLASS, "h-9 font-mono text-[12.5px]")}
            />
            <button
              type="button"
              aria-label={`Remove ${row.key || `row ${index + 1}`}`}
              onClick={() => {
                setRows((rs) => rs.filter((r) => r.rid !== row.rid));
                setDirty(true);
              }}
              className="grid size-9 place-items-center rounded-[8px] text-ink-3 outline-none transition-colors duration-150 hover:bg-error-wash hover:text-error focus-visible:shadow-focus active:bg-error-wash"
            >
              <Icon name="trash-2" size="sm" />
            </button>
          </div>
        );
      })}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          size="sm"
          icon="plus"
          onClick={() => {
            setRows((rs) => [...rs, { key: "", value: "", original: undefined, masked: false, rid: nextId.current++ }]);
            setDirty(true);
          }}
        >
          Add entry
        </Button>
        <Button variant="primary" size="sm" icon="save" disabled={!dirty} onClick={() => void saveAll()}>
          Save {name}
        </Button>
      </div>
    </div>
  );
}

function JsonControl({ ids, name, value, save, fail }: { ids: ControlIds; name: string; value: unknown; save: (v: unknown) => Promise<boolean>; fail: (e: string) => void }) {
  const stored = value === undefined ? "" : JSON.stringify(value, null, 2);
  const [draft, setDraft] = useState<string | null>(null);
  const text = draft ?? stored;
  const submit = async () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      return fail(`Not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (await save(parsed)) setDraft(null);
  };
  return (
    <div className="flex flex-col gap-2">
      <textarea
        id={ids.id}
        value={text}
        rows={Math.min(12, Math.max(3, text.split("\n").length))}
        spellCheck={false}
        placeholder="null"
        aria-invalid={ids.invalid || undefined}
        aria-describedby={ids.describedBy}
        onChange={(event) => setDraft(event.target.value)}
        className={cn(FIELD_CLASS, "scroll-quiet resize-y py-2 font-mono text-[12.5px] leading-relaxed")}
      />
      {text.includes(MASK) ? <p className="text-[12px] text-ink-3">Values shown as {MASK} are secrets. Leave them as they are to keep them.</p> : null}
      <div>
        <Button variant="secondary" size="sm" icon="save" disabled={draft === null || draft === stored} onClick={() => void submit()} aria-label={`Save ${name}`}>
          Save
        </Button>
      </div>
    </div>
  );
}

// ---------- the recursive node ----------

export function FieldNode({ name, path, schema, value, depth = 0 }: { name: string; path: string; schema: Schema; value: unknown; depth?: number }) {
  const { root } = useForm();
  const info = describeField(schema, root);
  if (info.kind === "object") return <ObjectGroup name={name} path={path} info={info} value={value} depth={depth} />;
  return <LeafField name={name} path={path} info={info} value={value} />;
}

function ObjectGroup({ name, path, info, value, depth }: { name: string; path: string; info: FieldInfo; value: unknown; depth: number }) {
  return (
    <fieldset className={cn("min-w-0", depth > 0 && "border-l-2 border-rule pl-4")} data-group={path}>
      <legend className="pb-1 pt-4 text-[13.5px] font-medium text-ink">{humanize(name)}</legend>
      {info.description ? <p className="pb-1 text-[12.5px] leading-relaxed text-ink-2">{info.description}</p> : null}
      <div className="divide-y divide-rule">
        {info.properties!.map(([key, child]) => (
          <FieldNode key={key} name={key} path={`${path}.${key}`} schema={child} value={getAtPath(value, key)} depth={depth + 1} />
        ))}
      </div>
    </fieldset>
  );
}

function LeafField({ name, path, info, value }: { name: string; path: string; info: FieldInfo; value: unknown }) {
  const { state, save, fail, touch, begin, done } = useFieldSave(path);
  const reset = () => void save(null);
  const secret = info.kind === "string" && isSecretField(name, value);
  return (
    <FieldShell name={name} path={path} info={info} value={value} state={state} onReset={reset}>
      {(ids) => {
        if (info.readOnly) {
          return <p id={ids.id} className="break-all font-mono text-[13px] text-ink-2">{info.kind === "json" || typeof value === "object" ? JSON.stringify(value ?? null) : secret ? MASK : value === undefined ? "—" : String(value)}</p>;
        }
        switch (info.kind) {
          case "string":
          case "number":
          case "integer":
            return <TextControl ids={ids} value={value} secret={secret} readOnly={false} numeric={info.kind !== "string"} info={info} save={save} fail={fail} touch={touch} />;
          case "boolean":
            return <Switch id={ids.id} label={name} checked={value === undefined ? info.defaultValue === true : value === true} onChange={(next) => void save(next)} />;
          case "enum":
            return <EnumControl ids={ids} info={info} value={value} save={save} />;
          case "stringArray":
            return <StringListControl ids={ids} name={name} value={value} save={save} fail={fail} />;
          case "record":
            return <RecordRows ids={ids} name={name} path={path} info={info} value={value} begin={begin} done={done} fail={fail} />;
          default:
            return <JsonControl key={JSON.stringify(value ?? null)} ids={ids} name={name} value={value} save={save} fail={fail} />;
        }
      }}
    </FieldShell>
  );
}
