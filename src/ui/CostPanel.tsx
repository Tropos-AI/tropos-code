// src/ui/CostPanel.tsx — /cost as a small panel instead of a transcript notice.
import { Text, useInput } from "ink";
import { Pane } from "./design/Pane";
import { sanitizeForTerminal } from "./terminal-safe";
import { useTheme } from "./theme-context";

export interface CostPanelProps {
  model: string;
  /** Undefined when a model without a known price answered, so no total can be trusted. */
  costUsd: number | undefined;
  contextTokens: number;
  contextPct?: number;
  turns?: number;
  onClose(): void;
}

/** Cents for normal sessions, four decimals below a cent so a cheap session doesn't read as free. */
export function formatCost(costUsd: number | undefined): string {
  if (costUsd === undefined) return "unknown (a model without a known price answered)";
  return costUsd > 0 && costUsd < 0.01 ? `$${costUsd.toFixed(4)}` : `$${costUsd.toFixed(2)}`;
}

export function formatContext(tokens: number, pct?: number): string {
  const count = `${tokens.toLocaleString("en-US")} tokens`;
  return pct === undefined ? count : `${count} (${pct}% of the window)`;
}

/** Label/value rows with the values in one column. esc or enter closes. */
export function CostPanel({ model, costUsd, contextTokens, contextPct, turns, onClose }: CostPanelProps) {
  const theme = useTheme();
  useInput((_input, key) => {
    if (key.escape || key.return) onClose();
  });
  const rows: Array<[string, string]> = [
    ["Model", sanitizeForTerminal(model)],
    ["Cost", formatCost(costUsd)],
    ["Context", formatContext(contextTokens, contextPct)],
    ...(turns === undefined ? [] : [["Turns", String(turns)] as [string, string]]),
  ];
  const width = Math.max(...rows.map(([label]) => label.length)) + 3;
  return (
    <Pane title="Session cost" footer="esc to close">
      {rows.map(([label, value]) => (
        <Text key={label}>
          <Text color={theme.muted}>{label.padEnd(width)}</Text>
          <Text color={costUsd === undefined && label === "Cost" ? theme.warning : undefined}>{value}</Text>
        </Text>
      ))}
    </Pane>
  );
}
