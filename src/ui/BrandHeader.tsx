// src/ui/BrandHeader.tsx
import { Box, Text } from "ink";
import { homedir } from "node:os";
import { sanitizeForTerminal } from "./terminal-safe";
import { useTheme } from "./theme-context";

/** The Tropos angular T: two slanted bars and a slanted stem. Tune glyphs visually if needed. */
const MARK = ["▟█████▛ ▟█████▛", "     ▟██▛", "     ███", "     ██▘"];

function shortenHome(path: string): string {
  const home = homedir();
  return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

/** Keeps the end of a long path (the part that names the project) and marks the cut with "…". */
export function fitPath(path: string, max: number): string {
  if (path.length <= max) return path;
  return `…${path.slice(path.length - Math.max(1, max - 1))}`;
}

/** Columns left for the text column: the mark (15), the gap (3) and the padding (2). */
const TEXT_OFFSET = 20;

export function BrandHeader({
  version,
  model,
  effort,
  cwd,
  width = 80,
  identity = {},
}: {
  version: string;
  model: string;
  effort: string;
  cwd: string;
  width?: number;
  /** The agent's own name and emoji (~/.tropos/workspace/IDENTITY.md), shown above the product name. */
  identity?: { name?: string; emoji?: string };
}) {
  const theme = useTheme();
  const room = Math.max(20, width - TEXT_OFFSET);
  return (
    <Box flexDirection="row" gap={3} paddingX={1} marginBottom={1}>
      <Box flexDirection="column">
        {MARK.map((line, i) => (
          <Text key={i} color={theme.accent}>
            {line}
          </Text>
        ))}
      </Box>
      <Box flexDirection="column" justifyContent="center">
        {identity.name ? (
          <Text bold color={theme.accent}>
            {sanitizeForTerminal(identity.emoji ? `${identity.emoji} ${identity.name}` : identity.name)}
          </Text>
        ) : null}
        <Text bold>
          Tropos Code <Text color={theme.muted}>v{sanitizeForTerminal(version)}</Text>
        </Text>
        <Text color={theme.muted}>
          {sanitizeForTerminal(model)} · effort {sanitizeForTerminal(effort)}
        </Text>
        <Text color={theme.muted}>{fitPath(sanitizeForTerminal(shortenHome(cwd)), room)}</Text>
      </Box>
    </Box>
  );
}
