// src/ui/ListPanel.tsx — /skills, /agents, /hooks, /mcp, /plugins and /memory as a browsable panel.
import { Box, Text, useInput } from "ink";
import { useState } from "react";
import { Pane } from "./design/Pane";
import { SelectList, type SelectItem } from "./design/SelectList";
import type { PanelData, PanelItem } from "./runtime";
import { sanitizeForTerminal } from "./terminal-safe";
import type { Theme } from "./theme";
import { useTheme } from "./theme-context";

/** Rows of the selected item's detail shown under the list; more are summarised as "… +N lines". */
export const DETAIL_LINES = 6;
const VISIBLE = 10;
const PAGE = 10;

const STATUS_GLYPHS: Record<NonNullable<PanelItem["status"]>, string> = { ok: "✔", warn: "△", error: "✘", off: "◯" };

function statusColor(theme: Theme, status: NonNullable<PanelItem["status"]>): string {
  return { ok: theme.success, warn: theme.warning, error: theme.danger, off: theme.muted }[status];
}

/** Sections flattened into one list; each item carries its section title so SelectList draws the headers. */
export function flattenPanel(data: PanelData, theme: Theme): { rows: SelectItem[]; items: PanelItem[] } {
  const rows: SelectItem[] = [];
  const items: PanelItem[] = [];
  data.sections.forEach((section, s) => {
    for (const item of section.items) {
      rows.push({
        // Keys are only unique within a section (two MCP servers can both have a "search" tool).
        key: `${s}:${item.key}`,
        label: item.label,
        hint: item.hint,
        aside: item.aside,
        section: section.title,
        mark: item.status ? { glyph: STATUS_GLYPHS[item.status], color: statusColor(theme, item.status) } : undefined,
        color: item.status === "off" ? theme.muted : undefined,
      });
      items.push(item);
    }
  });
  return { rows, items };
}

/**
 * A read-only list from runtime.panel(): sections with status marks, and the selected row's details
 * under the list so long descriptions don't crowd every row. ↑/↓ and pageup/pagedown move; esc or
 * enter close (enter has no action of its own yet).
 */
export function ListPanel({ data, onClose }: { data: PanelData; onClose(): void }) {
  const theme = useTheme();
  const { rows, items } = flattenPanel(data, theme);
  const [selected, setSelected] = useState(0);
  const last = Math.max(0, rows.length - 1);
  const current = Math.min(selected, last);

  useInput((_input, key) => {
    if (key.escape || key.return) return onClose();
    const move = (by: number) => setSelected((s) => Math.max(0, Math.min(last, Math.min(s, last) + by)));
    if (key.upArrow) return move(-1);
    if (key.downArrow) return move(1);
    if (key.pageUp) return move(-PAGE);
    if (key.pageDown) return move(PAGE);
  });

  const detail = (items[current]?.detail ?? []).flatMap((line) => sanitizeForTerminal(line).split("\n"));
  const shownDetail = detail.slice(0, DETAIL_LINES);
  const count = rows.length === 1 ? "1 item" : `${rows.length} items`;

  return (
    <Pane title={data.title} subtitle={data.subtitle} aside={rows.length > 0 ? count : undefined} footer={rows.length > 0 ? "↑↓ to move · esc to close" : "esc to close"}>
      <SelectList items={rows} selected={current} visible={VISIBLE} empty={sanitizeForTerminal(data.empty ?? "Nothing here.")} />
      {shownDetail.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          {shownDetail.map((line, i) => (
            <Text key={i} color={theme.muted}>
              {line || " "}
            </Text>
          ))}
          {detail.length > DETAIL_LINES ? <Text color={theme.subtle}>{`… +${detail.length - DETAIL_LINES} lines`}</Text> : null}
        </Box>
      ) : null}
    </Pane>
  );
}
