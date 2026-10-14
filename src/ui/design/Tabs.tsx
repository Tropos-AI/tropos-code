// src/ui/design/Tabs.tsx
import { Box, Text } from "ink";
import { useTheme } from "../theme-context";

/** A tab bar: the active tab on the accent background, the rest dim. ←/→ or tab switch (the owner handles keys). */
export function Tabs({ tabs, active }: { tabs: string[]; active: number }) {
  const theme = useTheme();
  return (
    <Box>
      {tabs.map((tab, i) => (
        <Text key={tab} backgroundColor={i === active ? theme.accent : undefined} color={i === active ? (theme.name === "dark" ? "#000000" : "#FFFFFF") : theme.muted}>
          {` ${tab} `}
        </Text>
      ))}
    </Box>
  );
}
