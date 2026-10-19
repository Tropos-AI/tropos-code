// web/src/components/pages/settings/add-provider-form.tsx — Settings › Providers › Add a provider: any endpoint that
// speaks the Anthropic, OpenAI Chat Completions or OpenAI Responses API (a proxy, vLLM, LiteLLM, a hosted gateway). The
// endpoint goes to ~/.tropos/settings.json through config.set (validated there); the key goes to providers.connect and
// leaves React state as soon as the form is sent, like ConnectForm.
import { useState, type FormEvent } from "react";

import { redactKey } from "@/components/pages/settings/connect-form";
import { SelectField, TextField } from "@/components/setup/admin-ui";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { errorMessage, useAdmin, useRpc } from "@/lib/store";

export type ProviderApi = "anthropic" | "chat" | "responses";

export const API_OPTIONS: { value: ProviderApi; label: string }[] = [
  { value: "chat", label: "OpenAI-compatible (Chat Completions)" },
  { value: "anthropic", label: "Anthropic-compatible (Messages)" },
  { value: "responses", label: "OpenAI Responses" },
];

/** The settings key for a name: lowercase letters, digits and dashes, as settings.json requires. */
export function providerId(name: string): string {
  return name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

/** Why the form can't be sent yet, or null. */
export function addProviderProblem(name: string, baseURL: string, taken: readonly string[]): string | null {
  const id = providerId(name);
  if (!id) return "Give it a name (letters or digits).";
  if (taken.includes(id)) return `There is already a provider called "${id}". Pick another name.`;
  let url: URL;
  try {
    url = new URL(baseURL.trim());
  } catch {
    return "The address must be a full URL, like https://api.example.com/v1.";
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return "The address must start with https:// (or http:// for this computer or your network).";
  return null;
}

type Props = {
  /** Ids already in use (built in or added), so a new one never replaces them. */
  taken: readonly string[];
  onAdded: (name: string) => void;
  onCancel: () => void;
};

export function AddProviderForm({ taken, onAdded, onCancel }: Props) {
  const admin = useAdmin();
  const rpc = useRpc();
  const [name, setName] = useState("");
  const [api, setApi] = useState<ProviderApi>("chat");
  const [baseURL, setBaseURL] = useState("");
  const [key, setKey] = useState("");
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending) return;
    const problem = addProviderProblem(name, baseURL, taken);
    if (problem) {
      setFailure(problem);
      return;
    }
    const secret = key.trim();
    setKey("");
    setFailure(null);
    setPending(true);
    const id = providerId(name);
    try {
      await admin("config.set", { file: "settings", path: `providers.${id}`, value: { name: name.trim(), api, baseURL: baseURL.trim() } });
      if (secret) await rpc("providers.connect", { id, key: secret });
      onAdded(name.trim());
    } catch (error) {
      setPending(false);
      setFailure(redactKey(errorMessage(error), secret));
    }
  };

  return (
    <form onSubmit={(event) => void submit(event)} noValidate aria-label="Add a provider" className="flex flex-col gap-3 rounded-[12px] border border-rule bg-paper/70 p-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField label="Name" value={name} onChange={setName} placeholder="My gateway" disabled={pending} hint={name ? `Models are picked as ${providerId(name) || "…"}/<model>.` : undefined} />
        <SelectField label="API" value={api} onChange={(v) => setApi(v as ProviderApi)} options={API_OPTIONS} disabled={pending} />
      </div>
      <TextField label="Base URL" value={baseURL} onChange={setBaseURL} placeholder={api === "anthropic" ? "https://gateway.example.com" : "https://api.example.com/v1"} mono disabled={pending} />
      <TextField label="API key (optional)" type="password" value={key} onChange={setKey} disabled={pending} hint="Saved to ~/.tropos/credentials.json, readable only by you, and sent only to this address." />
      {failure ? (
        <p role="alert" className="flex items-start gap-1.5 text-[13px] text-error">
          <span className="mt-[3px] inline-flex">
            <Icon name="circle-alert" size="sm" />
          </span>
          <span>{failure}</span>
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" variant="primary" size="sm" icon="plus" disabled={pending}>
          {pending ? "Adding…" : "Add provider"}
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
