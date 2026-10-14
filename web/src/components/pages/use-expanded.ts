// web/src/components/pages/use-expanded.ts — which disclosure rows are open (several may be at once).
import { useCallback, useState } from "react";

export interface Expanded {
  isOpen: (key: string) => boolean;
  toggle: (key: string) => void;
}

export function useExpanded(initial: readonly string[] = []): Expanded {
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set(initial));
  const toggle = useCallback((key: string) => {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);
  const isOpen = useCallback((key: string) => open.has(key), [open]);
  return { isOpen, toggle };
}
