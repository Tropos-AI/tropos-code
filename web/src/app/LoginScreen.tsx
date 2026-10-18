// web/src/app/LoginScreen.tsx — shown alone while this browser has no device key. One field for the 6-digit code that
// `tcode dashboard --code` or Telegram's /login gives; success flips the connection to open and the app takes over.
import { useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { RpcError } from "@/lib/client";
import { useAppStore } from "@/lib/store";

const INVALID = "That code didn't work. Codes work once, for 10 minutes.";
const LOCKED = "Too many wrong codes. Wait a few minutes, then get a new one.";

export function LoginScreen() {
  const store = useAppStore();
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const value = code.replace(/\s+/g, "");
    if (!value || busy) return;
    setBusy(true);
    setError(null);
    try {
      await store.login(value);
    } catch (e) {
      setError(e instanceof RpcError && e.message === "locked" ? LOCKED : INVALID);
      setBusy(false);
    }
  };

  return (
    <main className="grid min-h-dvh place-items-center bg-paper px-4 py-10 text-ink">
      <div className="w-full max-w-[22rem]">
        <img src="/brand/tropos-logo.png" alt="" width={36} height={36} className="mb-5 size-9 select-none" draggable={false} />
        <h1 className="text-[22px] font-semibold tracking-[-0.01em] [font-stretch:86%]">Log in to Tropos</h1>
        <p className="mt-1.5 text-[14px] text-ink-2">Enter the 6-digit code to connect this browser.</p>

        <form onSubmit={submit} className="mt-6 flex flex-col gap-3">
          <label htmlFor="login-code" className="text-[13px] font-medium text-ink-2">
            Login code
          </label>
          <input
            id="login-code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            autoComplete="one-time-code"
            inputMode="numeric"
            autoFocus
            placeholder="123 456"
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? "login-error" : undefined}
            className="h-12 w-full rounded-[10px] border border-rule bg-surface px-3.5 text-center font-mono text-[20px] tracking-[0.2em] text-ink shadow-well outline-none focus-visible:shadow-focus"
          />
          {error ? (
            <p id="login-error" role="alert" className="text-[13px] text-error">
              {error}
            </p>
          ) : null}
          <Button type="submit" variant="primary" block disabled={busy || code.trim() === ""} className="h-11">
            Log in
          </Button>
        </form>

        <ul className="mt-7 space-y-2 text-[13px] text-ink-2">
          <li>
            On your Mac: <code className="rounded bg-paper-2 px-1.5 py-0.5 font-mono text-[12.5px] text-ink">tcode dashboard --code</code>
          </li>
          <li>
            From Telegram: send <code className="rounded bg-paper-2 px-1.5 py-0.5 font-mono text-[12.5px] text-ink">/login</code> to your bot
          </li>
        </ul>

        {store.loginRemembered ? null : (
          <p className="mt-5 rounded-[10px] bg-warn-wash px-3 py-2 text-[13px] text-ink">
            This browser blocks storage (a private window?), so this login won't be remembered after you close the tab.
          </p>
        )}
      </div>
    </main>
  );
}
