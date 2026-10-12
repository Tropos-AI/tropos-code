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

export function BrandHeader({ version, model, effort, cwd }: { version: string; model: string; effort: string; cwd: string }) {
  const theme = useTheme();
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
        <Text bold>
          Tropos Code <Text color={theme.muted}>v{sanitizeForTerminal(version)}</Text>
        </Text>
        <Text color={theme.muted}>
          {sanitizeForTerminal(model)} · effort {sanitizeForTerminal(effort)}
        </Text>
        <Text color={theme.muted}>{sanitizeForTerminal(shortenHome(cwd))}</Text>
      </Box>
    </Box>
  );
}
