/** Tree View — Interior.dev by ddoemonn via 21st.dev (@ddoemonn/tree-view). Adapted for Tropos Code: lazy `m`, shared EASE/INSTANT and reduced-motion hook, palette tokens, Icon caret, valid ul > li group markup, callback refs synced in an effect. */

import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { AnimatePresence, m } from "motion/react";

import { Icon } from "@/components/ui/icon";
import { usePrefersReducedMotion } from "@/hooks/use-prefers-reduced-motion";
import { EASE, INSTANT } from "@/lib/springs";
import { cn } from "@/lib/utils";

const LEAVE = [0.4, 0, 1, 1] as const;

const SMALL = { type: "spring", stiffness: 700, damping: 46, mass: 0.5 } as const;

const OPEN_H = { duration: 0.28, ease: EASE } as const;
const OPEN_O = { duration: 0.18, ease: EASE } as const;
const SHUT_H = { duration: 0.2, ease: LEAVE } as const;
const SHUT_O = { duration: 0.14, ease: LEAVE } as const;

export type TreeNode = {
  id: string;
  label: string;
  /** Trailing detail, e.g. a file size. */
  meta?: string;
  children?: TreeNode[];
};

export type TreeRow = {
  node: TreeNode;
  level: number;
  parentId: string | null;
  posinset: number;
  setsize: number;
  branch: boolean;
  open: boolean;
};

function flatten(
  nodes: TreeNode[],
  openSet: ReadonlySet<string>,
  level = 1,
  parentId: string | null = null,
  out: TreeRow[] = [],
): TreeRow[] {
  nodes.forEach((node, i) => {
    const children = node.children ?? [];
    const branch = children.length > 0;
    const open = branch && openSet.has(node.id);
    out.push({ node, level, parentId, posinset: i + 1, setsize: nodes.length, branch, open });
    if (open) flatten(children, openSet, level + 1, node.id, out);
  });
  return out;
}

export type UseTreeViewOptions = {
  nodes: TreeNode[];
  expanded?: string[];
  defaultExpanded?: string[];
  onExpandedChange?: (expanded: string[]) => void;
  selected?: string | null;
  defaultSelected?: string | null;
  onSelectedChange?: (selected: string) => void;
};

export function useTreeView({
  nodes,
  expanded,
  defaultExpanded = [],
  onExpandedChange,
  selected,
  defaultSelected = null,
  onSelectedChange,
}: UseTreeViewOptions) {
  const [internalOpen, setInternalOpen] = useState<string[]>(defaultExpanded);
  const openControlled = expanded !== undefined;
  const openList = openControlled ? expanded : internalOpen;
  const openSet = new Set(openList);

  const [internalSel, setInternalSel] = useState<string | null>(defaultSelected);
  const selControlled = selected !== undefined;
  const selectedId = selControlled ? selected : internalSel;

  const emitOpen = useRef(onExpandedChange);
  const emitSel = useRef(onSelectedChange);
  useEffect(() => {
    emitOpen.current = onExpandedChange;
    emitSel.current = onSelectedChange;
  });

  const rows = flatten(nodes, openSet);

  // Roving tabindex: the focused row if still visible, else the selection, else the first row.
  const [focusId, setFocusId] = useState<string | null>(null);
  const visible =
    focusId !== null && rows.some((r) => r.node.id === focusId)
      ? focusId
      : (rows.find((r) => r.node.id === selectedId)?.node.id ?? rows[0]?.node.id ?? null);

  const refs = useRef(new Map<string, HTMLElement>());
  const register = useCallback((id: string, el: HTMLElement | null) => {
    if (el) refs.current.set(id, el);
    else refs.current.delete(id);
  }, []);

  const focusRow = useCallback((id: string) => {
    setFocusId(id);
    refs.current.get(id)?.focus();
  }, []);

  const setOpen = useCallback(
    (next: string[]) => {
      if (!openControlled) setInternalOpen(next);
      emitOpen.current?.(next);
    },
    [openControlled],
  );

  const toggle = useCallback(
    (id: string) => {
      const has = openList.includes(id);
      setOpen(has ? openList.filter((v) => v !== id) : [...openList, id]);
    },
    [openList, setOpen],
  );

  const select = useCallback(
    (id: string) => {
      if (!selControlled) setInternalSel(id);
      emitSel.current?.(id);
    },
    [selControlled],
  );

  const handleKey = useCallback(
    (event: ReactKeyboardEvent, row: TreeRow) => {
      const at = rows.findIndex((r) => r.node.id === row.node.id);
      const go = (index: number) => {
        const target = rows[index];
        if (target) focusRow(target.node.id);
      };

      switch (event.key) {
        case "ArrowDown":
          event.preventDefault();
          go(at + 1);
          return;
        case "ArrowUp":
          event.preventDefault();
          go(at - 1);
          return;
        case "ArrowRight":
          event.preventDefault();
          if (row.branch && !row.open) toggle(row.node.id);
          else if (row.open) go(at + 1);
          return;
        case "ArrowLeft":
          event.preventDefault();
          if (row.open) toggle(row.node.id);
          else if (row.parentId) focusRow(row.parentId);
          return;
        case "Home":
          event.preventDefault();
          go(0);
          return;
        case "End":
          event.preventDefault();
          go(rows.length - 1);
          return;
        case "Enter":
        case " ":
          event.preventDefault();
          select(row.node.id);
          if (row.branch) toggle(row.node.id);
          return;
        default:
      }

      // Typeahead: jump to the next visible row starting with the typed letter.
      if (event.key.length === 1 && !event.metaKey && !event.ctrlKey) {
        const letter = event.key.toLowerCase();
        for (let step = 1; step <= rows.length; step++) {
          const candidate = rows[(at + step) % rows.length];
          if (candidate.node.label.toLowerCase().startsWith(letter)) {
            event.preventDefault();
            focusRow(candidate.node.id);
            return;
          }
        }
      }
    },
    [rows, focusRow, toggle, select],
  );

  return {
    rows,
    openSet,
    selectedId,
    tabStop: visible,
    register,
    focusRow,
    setFocusId,
    toggle,
    select,
    handleKey,
  };
}

function Caret({ open }: { open: boolean }) {
  const reduced = usePrefersReducedMotion();
  return (
    <m.span
      aria-hidden
      initial={false}
      animate={{ rotate: open ? 90 : 0 }}
      transition={reduced ? INSTANT : SMALL}
      className="flex size-4 shrink-0 items-center justify-center text-ink-3"
    >
      <Icon name="chevron-right" size="sm" className="size-3" />
    </m.span>
  );
}

export type TreeViewProps = {
  nodes: TreeNode[];
  label: string;
  expanded?: string[];
  defaultExpanded?: string[];
  onExpandedChange?: (expanded: string[]) => void;
  selected?: string | null;
  defaultSelected?: string | null;
  onSelectedChange?: (selected: string) => void;
  className?: string;
};

export function TreeView({
  nodes,
  label,
  expanded,
  defaultExpanded,
  onExpandedChange,
  selected,
  defaultSelected,
  onSelectedChange,
  className,
}: TreeViewProps) {
  const tree = useTreeView({
    nodes,
    expanded,
    defaultExpanded,
    onExpandedChange,
    selected,
    defaultSelected,
    onSelectedChange,
  });
  const reduced = usePrefersReducedMotion();
  const hintId = useId();

  const renderNodes = (list: TreeNode[], level: number) =>
    list.map((node, i) => {
      const row = tree.rows.find((r) => r.node.id === node.id);
      if (!row) return null;

      const isSelected = tree.selectedId === node.id;

      return (
        <li key={node.id} role="none">
          <div
            role="treeitem"
            ref={(el) => tree.register(node.id, el)}
            aria-level={level}
            aria-posinset={i + 1}
            aria-setsize={list.length}
            aria-expanded={row.branch ? row.open : undefined}
            aria-selected={isSelected}
            aria-describedby={hintId}
            tabIndex={tree.tabStop === node.id ? 0 : -1}
            onFocus={() => tree.setFocusId(node.id)}
            onKeyDown={(e) => tree.handleKey(e, row)}
            onClick={() => {
              tree.select(node.id);
              tree.focusRow(node.id);
              if (row.branch) tree.toggle(node.id);
            }}
            className={cn(
              "flex h-7 cursor-default select-none items-center gap-1 rounded-[8px] px-1.5 outline-none transition-colors duration-150 focus-visible:bg-accent/[0.06] focus-visible:shadow-[inset_0_0_0_1px_var(--accent)]",
              isSelected ? "bg-paper-2/80 text-ink" : "text-ink-2 hover:bg-paper-2/60",
            )}
          >
            {row.branch ? <Caret open={row.open} /> : <span className="size-4 shrink-0" />}

            <span className={cn("min-w-0 flex-1 truncate text-[12.5px]", isSelected && "font-medium")}>{node.label}</span>

            {node.meta ? <span className="shrink-0 font-mono text-[10.5px] tabular-nums text-ink-3">{node.meta}</span> : null}
          </div>

          {row.branch ? (
            <AnimatePresence initial={false}>
              {row.open ? (
                <m.div
                  key="group"
                  initial={reduced ? { opacity: 0 } : { height: 0, opacity: 0 }}
                  animate={{ height: "auto", opacity: 1 }}
                  exit={
                    reduced
                      ? { opacity: 0, transition: INSTANT }
                      : { height: 0, opacity: 0, transition: { height: SHUT_H, opacity: SHUT_O } }
                  }
                  transition={reduced ? INSTANT : { height: OPEN_H, opacity: OPEN_O }}
                  className="overflow-hidden"
                >
                  <ul role="group" className="ml-[13px] border-l border-rule/80 pl-[7px]">
                    {renderNodes(node.children ?? [], level + 1)}
                  </ul>
                </m.div>
              ) : null}
            </AnimatePresence>
          ) : null}
        </li>
      );
    });

  return (
    <div className={cn("rounded-[13px] border border-rule bg-surface p-[5px] shadow-card", className)}>
      <ul role="tree" aria-label={label}>
        {renderNodes(nodes, 1)}
      </ul>
      <span id={hintId} className="sr-only">
        Use the arrow keys to move. Right expands a folder, left collapses it or climbs to its parent. Home and End jump to
        the ends, and typing a letter jumps to the next name starting with it.
      </span>
    </div>
  );
}

export default TreeView;
