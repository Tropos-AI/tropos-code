import { createContext, useContext, type ReactNode } from "react";
import { DARK, type Theme } from "./theme";

const ThemeContext = createContext<Theme>(DARK);

export function ThemeProvider({ theme, children }: { theme: Theme; children: ReactNode }) {
  return <ThemeContext.Provider value={theme}>{children}</ThemeContext.Provider>;
}

export function useTheme(): Theme {
  return useContext(ThemeContext);
}
