// src/ui/EffortPicker.tsx — /effort without an argument: pick a reasoning effort level from a short menu.
import { useInput } from "ink";
import { useState } from "react";
import { EFFORTS, type Effort } from "../config/constants";
import { Pane } from "./design/Pane";
import { SelectList, type SelectItem } from "./design/SelectList";
import { EFFORT_GLYPH } from "./model-list";
import { useTheme } from "./theme-context";

/** One line per level, so the trade-off is visible where the choice is made. */
export const EFFORT_DESCRIPTION: Record<Effort, string> = {
  low: "fastest, cheapest; light reasoning",
  medium: "balanced speed and depth",
  high: "thorough reasoning for everyday coding",
  xhigh: "extra reasoning for hard problems",
  max: "deepest reasoning, slowest",
};

export interface EffortPickerProps {
  current: Effort;
  onPick(effort: Effort): void;
  onClose(): void;
}

/** A numbered menu of the five levels; the cursor starts on the current one, and 1-5 pick directly. */
export function EffortPicker({ current, onPick, onClose }: EffortPickerProps) {
  const theme = useTheme();
  const [selected, setSelected] = useState(() => Math.max(0, EFFORTS.indexOf(current)));

  useInput((ch, key) => {
    if (key.escape) return onClose();
    if (key.upArrow) return setSelected((s) => Math.max(0, s - 1));
    if (key.downArrow) return setSelected((s) => Math.min(EFFORTS.length - 1, s + 1));
    if (key.return) return onPick(EFFORTS[selected]!);
    const n = Number(ch);
    if (Number.isInteger(n) && n >= 1 && n <= EFFORTS.length) onPick(EFFORTS[n - 1]!);
  });

  const items: SelectItem[] = EFFORTS.map((level) => ({
    key: level,
    label: level,
    hint: EFFORT_DESCRIPTION[level],
    aside: level === current ? "current" : undefined,
    mark: { glyph: EFFORT_GLYPH[level], color: level === current ? theme.success : theme.accent },
  }));

  return (
    <Pane title="Effort" subtitle="How hard the model thinks before answering" footer="↑↓ move · 1-5 or enter select · esc close">
      <SelectList items={items} selected={selected} numbered visible={EFFORTS.length} />
    </Pane>
  );
}
