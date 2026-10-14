// src/ui/DiffView.tsx
import { Box, Text } from "ink";
import { sanitizeForTerminal } from "./terminal-safe";
import { useTheme } from "./theme-context";

export type DiffRow =
  | { kind: "add" | "remove" | "context"; num: number; text: string }
  /** The gap between two hunks. */
  | { kind: "gap" };

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * The rows of a unified patch with their line numbers: old numbers for removed lines, new numbers
 * for added and context lines. Everything before the first hunk header is the file header and is
 * skipped by position, so content such as "--- sql comment" inside a hunk survives.
 */
export function diffRows(patch: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;
  for (const line of patch.split("\n")) {
    const hunk = HUNK.exec(line);
    if (hunk) {
      if (inHunk) rows.push({ kind: "gap" });
      inHunk = true;
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      continue;
    }
    if (!inHunk || line.length === 0 || line.startsWith("\\")) continue;
    const text = line.slice(1);
    if (line.startsWith("+")) rows.push({ kind: "add", num: newNo++, text });
    else if (line.startsWith("-")) rows.push({ kind: "remove", num: oldNo++, text });
    else {
      rows.push({ kind: "context", num: newNo, text });
      oldNo++;
      newNo++;
    }
  }
  return rows;
}

const SIGN = { add: "+", remove: "-", context: " " } as const;

export interface DiffViewProps {
  patch: string;
  /** Rows shown before "… +N lines"; ignored when verbose. */
  maxLines?: number;
  /** Columns to fill: added and removed rows get their background across the whole width. */
  width?: number;
  verbose?: boolean;
}

/** A unified diff with line numbers and full-width add/remove backgrounds. */
export function DiffView({ patch, maxLines = 40, width = 80, verbose = false }: DiffViewProps) {
  const theme = useTheme();
  const rows = diffRows(sanitizeForTerminal(patch));
  const shown = verbose ? rows : rows.slice(0, maxLines);
  const more = rows.length - shown.length;
  const numWidth = Math.max(1, ...shown.map((r) => (r.kind === "gap" ? 0 : String(r.num).length)));
  return (
    <Box flexDirection="column">
      {shown.map((row, i) => {
        if (row.kind === "gap") {
          return (
            <Text key={i} color={theme.muted}>
              {" ".repeat(numWidth - 1)}...
            </Text>
          );
        }
        // Tabs would throw the padding off: the terminal, not the string length, decides their width.
        const body = `${SIGN[row.kind]}${row.text.replace(/\t/g, "  ")}`;
        const num = String(row.num).padStart(numWidth);
        const rest = Math.max(0, width - numWidth - 1);
        const bg = row.kind === "add" ? theme.diffAddBg : row.kind === "remove" ? theme.diffRemoveBg : undefined;
        return (
          <Text key={i}>
            <Text color={theme.muted}>{num} </Text>
            {bg ? (
              <Text backgroundColor={bg} color={theme.text}>
                {body.padEnd(rest)}
              </Text>
            ) : (
              <Text>{body}</Text>
            )}
          </Text>
        );
      })}
      {more > 0 ? <Text color={theme.muted}>… +{more} {more === 1 ? "line" : "lines"}</Text> : null}
    </Box>
  );
}
