// src/ui/BlinkingDot.tsx
import { Text } from "ink";
import { useEffect, useState } from "react";

export const BLINK_MS = 600;

/**
 * One clock for every blinking dot, so parallel running tools blink in step instead of drifting,
 * and only one timer runs however many rows are on screen. It stops when the last dot unmounts.
 */
const listeners = new Set<(on: boolean) => void>();
let timer: ReturnType<typeof setInterval> | undefined;
let on = true;

function subscribe(listener: (on: boolean) => void): () => void {
  listeners.add(listener);
  if (!timer) {
    timer = setInterval(() => {
      on = !on;
      for (const l of listeners) l(on);
    }, BLINK_MS);
    // A blinking dot must never keep the process alive on its own.
    timer.unref?.();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = undefined;
      on = true;
    }
  };
}

/** Whether blinking things are in their visible phase right now. */
export function useBlink(): boolean {
  const [visible, setVisible] = useState(on);
  useEffect(() => subscribe(setVisible), []);
  return visible;
}

/** A dot that blinks every BLINK_MS; it keeps its width while hidden so the row doesn't shift. */
export function BlinkingDot({ glyph, color }: { glyph: string; color?: string }) {
  const visible = useBlink();
  return (
    <Text color={color} dimColor>
      {visible ? glyph : " "}
    </Text>
  );
}
