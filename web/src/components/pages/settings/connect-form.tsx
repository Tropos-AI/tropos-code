// web/src/components/pages/settings/connect-form.tsx — the inline "connect a provider" form: an Interior Floating Label
// password field with Inline Validation (non-empty). The key leaves React state (and so the DOM) the moment the form is
// submitted; it is only ever sent to providers.connect and never shown, logged or kept.
import { useEffect, useRef, useState, type FormEvent } from "react";

import type { ProviderInfoView } from "@core/web/protocol";

import { FloatingLabelInput } from "@/components/interior/floating-label";
import { useInlineValidation } from "@/components/interior/inline-validation";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { errorMessage, useRpc } from "@/lib/store";

const requireKey = (value: string): string | null => (value.trim() ? null : "Paste a key first.");

/** Never echo a key back, even if a server error happens to contain it. */
export function redactKey(message: string, key: string): string {
  return key.length >= 4 ? message.split(key).join("••••") : message;
}

type Props = {
  provider: ProviderInfoView;
  onConnected: () => void;
  onCancel: () => void;
};

export function ConnectForm({ provider, onConnected, onCancel }: Props) {
  const rpc = useRpc();
  const [value, setValue] = useState("");
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const validation = useInlineValidation({ value, validate: requireKey, debounce: 250 });

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending) return;
    const key = value.trim();
    validation.commit();
    if (!key) {
      inputRef.current?.focus();
      return;
    }
    // Drop the key from state before the request goes out: the field (and its value attribute) empties right away.
    setValue("");
    validation.reset();
    setFailure(null);
    setPending(true);
    try {
      await rpc("providers.connect", { id: provider.id, key });
      onConnected();
    } catch (error) {
      setPending(false);
      setFailure(redactKey(errorMessage(error), key));
      inputRef.current?.focus();
    }
  };

  const invalid = validation.status === "invalid";
  const envHint = provider.keyEnv.length > 0 ? ` Or set ${provider.keyEnv.join(" / ")} in your shell.` : "";

  return (
    <form onSubmit={(event) => void submit(event)} noValidate aria-label={`Connect ${provider.name}`} className="flex flex-col gap-3">
      <FloatingLabelInput
        inputRef={inputRef}
        type="password"
        name={`${provider.id}-api-key`}
        label={`${provider.name} API key`}
        value={value}
        onChange={(next) => {
          setValue(next);
          if (failure) setFailure(null);
        }}
        onBlur={validation.fieldProps.onBlur}
        invalid={invalid}
        required
        autoComplete="off"
        disabled={pending}
        hint={invalid ? (validation.error ?? "Paste a key first.") : `Saved to ~/.tropos/credentials.json, readable only by you.${envHint}`}
      />
      {failure ? (
        <p role="alert" className="-mt-1 flex items-start gap-1.5 text-[13px] text-error">
          <span className="mt-[3px] inline-flex">
            <Icon name="circle-alert" size="sm" />
          </span>
          <span>
            Couldn't save the key: {failure}. Paste it again to retry.
          </span>
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" variant="primary" size="sm" icon="key" disabled={pending}>
          {pending ? "Saving…" : "Save key"}
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
        {provider.keyURL ? (
          <a
            href={provider.keyURL}
            target="_blank"
            rel="noopener noreferrer"
            className="ml-auto inline-flex h-8 items-center gap-1.5 rounded-[8px] px-2 text-[13px] font-medium text-accent-ink outline-none transition-colors duration-150 hover:bg-accent-wash focus-visible:shadow-focus"
          >
            Create a key
            <Icon name="external-link" size="sm" />
            <span className="sr-only">(opens in a new tab)</span>
          </a>
        ) : null}
      </div>
    </form>
  );
}
