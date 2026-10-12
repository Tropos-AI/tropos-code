// src/ui/Spinner.tsx
import { Text } from "ink";
import { useEffect, useState } from "react";
import { useTheme } from "./theme-context";

const FRAMES = ["◐", "◓", "◑", "◒"];
/** Tropos is Greek for "turn". */
export const SPINNER_VERBS = ["Turning", "Pivoting", "Orbiting", "Revolving"];

export function Spinner({ verb }: { verb?: string }) {
  const theme = useTheme();
  const [frame, setFrame] = useState(0);
  const [startedAt] = useState(() => Date.now());
  const [word] = useState(() => verb ?? SPINNER_VERBS[Math.floor(Math.random() * SPINNER_VERBS.length)]!);
  useEffect(() => {
    const timer = setInterval(() => setFrame((f) => f + 1), 120);
    return () => clearInterval(timer);
  }, []);
  const seconds = Math.floor((Date.now() - startedAt) / 1000);
  return (
    <Text>
      <Text color={theme.accent}>
        {FRAMES[frame % FRAMES.length]} {word}…
      </Text>
      <Text color={theme.muted}> ({seconds}s · esc to interrupt)</Text>
    </Text>
  );
}
