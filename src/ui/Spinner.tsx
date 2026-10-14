// src/ui/Spinner.tsx
import { Text } from "ink";
import { useEffect, useState } from "react";
import { useTheme } from "./theme-context";

const GLYPHS = ["·", "✢", "✳", "✶", "✻", "✽"];
/** Forward then back without repeating the ends, so the glyph breathes instead of jumping from ✽ to ·. */
export const SPINNER_FRAMES = [...GLYPHS, ...GLYPHS.slice(1, -1).reverse()];
/** Tropos is Greek for "turn". */
export const SPINNER_VERBS = ["Turning", "Pivoting", "Orbiting", "Revolving"];
const TICK_MS = 120;
const BAND = 3;

/** Output-token count as the spinner shows it: "980", "1.2k", "3.4m". */
export function formatTokens(n: number): string {
  if (n < 1000) return String(Math.max(0, Math.round(n)));
  if (n < 1_000_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
}

/**
 * Splits `text` around the shimmer band for animation tick `tick`. The band enters from the left and leaves
 * on the right, with a short pause off-screen, so the sweep reads as a highlight passing over the word.
 */
export function shimmerParts(text: string, tick: number): [before: string, band: string, after: string] {
  const chars = [...text];
  const cycle = chars.length + BAND * 2;
  const end = (tick % cycle) + 1; // band covers [end - BAND, end)
  const start = Math.max(0, end - BAND);
  const stop = Math.min(chars.length, end);
  if (start >= stop) return [text, "", ""];
  return [chars.slice(0, start).join(""), chars.slice(start, stop).join(""), chars.slice(stop).join("")];
}

/** The working indicator: glyph, verb with a moving shimmer, then dim elapsed time and output tokens. */
export function Spinner({ verb, tokens }: { verb?: string; tokens?: number }) {
  const theme = useTheme();
  const [tick, setTick] = useState(0);
  const [startedAt] = useState(() => Date.now());
  const [word] = useState(() => verb ?? SPINNER_VERBS[Math.floor(Math.random() * SPINNER_VERBS.length)]!);
  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), TICK_MS);
    return () => clearInterval(timer);
  }, []);
  const seconds = Math.floor((Date.now() - startedAt) / 1000);
  const [before, band, after] = shimmerParts(`${word}…`, tick);
  const tokenPart = tokens ? ` · ↓ ${formatTokens(tokens)} tokens` : "";
  return (
    <Text>
      <Text color={theme.accent}>{`${SPINNER_FRAMES[tick % SPINNER_FRAMES.length]} `}</Text>
      <Text color={theme.accent}>{before}</Text>
      <Text color={theme.shimmer}>{band}</Text>
      <Text color={theme.accent}>{after}</Text>
      <Text dimColor>{` (${seconds}s${tokenPart})`}</Text>
    </Text>
  );
}
