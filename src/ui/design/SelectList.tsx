// src/ui/design/SelectList.tsx
import { Box, Text } from "ink";
import { sanitizeForTerminal } from "../terminal-safe";
import { useTheme } from "../theme-context";

export interface SelectItem {
  key: string;
  label: string;
  /** Dim text after the label. */
  hint?: string;
  /** Dim, right of everything, e.g. "current" or a provider name. */
  aside?: string;
  /** Label color when not selected (command kinds, statuses). */
  color?: string;
  /** A leading status glyph and its color, e.g. ✔ green. */
  mark?: { glyph: string; color: string };
  /** Shown as a section header row before this item. */
  section?: string;
  disabled?: boolean;
}

/** First visible index for a window of `size` rows that keeps `selected` in view, centered when possible. */
export function windowStart(selected: number, total: number, size: number): number {
  return Math.max(0, Math.min(selected - Math.floor(size / 2), total - size));
}

/**
 * A scrolling list with a `❯` cursor. Pure rendering: the owner keeps `selected` and handles keys, so
 * the same list serves pickers with a search box and plain menus. Scroll markers show hidden rows.
 */
export function SelectList({
  items,
  selected,
  visible = 10,
  numbered = false,
  empty = "Nothing here.",
}: {
  items: SelectItem[];
  selected: number;
  visible?: number;
  numbered?: boolean;
  empty?: string;
}) {
  const theme = useTheme();
  if (items.length === 0) return <Text color={theme.muted}>{empty}</Text>;
  const first = windowStart(selected, items.length, visible);
  const shown = items.slice(first, first + visible);
  return (
    <Box flexDirection="column">
      {first > 0 ? <Text color={theme.muted}>{`  ↑ ${first} more`}</Text> : null}
      {shown.map((item, i) => {
        const index = first + i;
        const active = index === selected;
        const label = sanitizeForTerminal(item.label);
        return (
          <Box key={item.key} flexDirection="column">
            {item.section && (index === first || items[index - 1]?.section !== item.section) ? (
              <Text bold color={theme.muted}>
                {sanitizeForTerminal(item.section)}
              </Text>
            ) : null}
            <Text>
              <Text color={theme.accent}>{active ? "❯ " : "  "}</Text>
              {numbered ? <Text color={theme.muted}>{`${index + 1}. `}</Text> : null}
              {item.mark ? <Text color={item.mark.color}>{`${item.mark.glyph} `}</Text> : null}
              <Text color={item.disabled ? theme.subtle : active ? theme.accent : item.color} bold={active}>
                {label}
              </Text>
              {item.hint ? <Text color={active ? theme.accent : theme.muted}>{`  ${sanitizeForTerminal(item.hint)}`}</Text> : null}
              {item.aside ? <Text color={theme.muted}>{`  · ${sanitizeForTerminal(item.aside)}`}</Text> : null}
            </Text>
          </Box>
        );
      })}
      {first + visible < items.length ? <Text color={theme.muted}>{`  ↓ ${items.length - first - visible} more`}</Text> : null}
    </Box>
  );
}
