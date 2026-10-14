// web/src/components/chat/HelpPanel.tsx — /help as a modal with Interior Tabs (General · Commands · Custom · Shortcuts),
// the web twin of src/ui/HelpPanel.tsx. Nothing here goes into the transcript.
import type { ReactNode } from "react";

import { COMMANDS, type ExtraCommand } from "@core/ui/commands";

import { Modal } from "@/components/interior/modal";
import { Tabs } from "@/components/interior/tabs";
import { Kbd } from "@/components/ui/kbd";
import { cn } from "@/lib/utils";

const TABS = [
  { value: "general", label: "General" },
  { value: "commands", label: "Commands" },
  { value: "custom", label: "Custom" },
  { value: "shortcuts", label: "Shortcuts" },
];

/** The browser's keys; the terminal's shift+tab and ctrl+c have no meaning here. */
export const WEB_SHORTCUTS: ReadonlyArray<readonly [string[], string]> = [
  [["⏎"], "send (queues while Tropos works)"],
  [["⇧", "⏎"], "new line"],
  [["Esc"], "interrupt Tropos; on an empty input, discard the queue"],
  [["↑"], "edit queued messages, or step back through what you sent"],
  [["/"], "commands and skills; from anywhere, jump to the message box"],
  [["@"], "mention a file (⇥ to complete)"],
  [["1", "2", "3"], "answer a permission prompt"],
  [["⌃", "F"], "star a model in the model picker"],
];

const GENERAL = [
  "Tropos Code reads, edits and runs code in this project — the same agent, sessions and settings as the terminal.",
  "Say what you want in plain words. You can keep typing while it works: messages sent mid-turn are queued and run next.",
  "Mention files with @path, and type / for commands and skills.",
  "The mode under the message box decides what needs your approval: Default asks before edits and commands, Accept edits applies edits without asking, and Plan looks around and proposes a plan before changing anything.",
  "Permission prompts let you allow once, allow a rule for good, or say no and tell Tropos what to do instead.",
];

const SKILL_PREFIX = /^\(skill\)\s*/;

function Row({ name, children, tone = "text-ink", narrow = false }: { name: ReactNode; children: ReactNode; tone?: string; narrow?: boolean }) {
  return (
    <div className={cn("grid items-baseline gap-3 py-1.5", narrow ? "grid-cols-[minmax(0,6.5rem)_minmax(0,1fr)]" : "grid-cols-[minmax(0,11rem)_minmax(0,1fr)]")}>
      <dt className={cn("truncate font-mono text-[12.5px] font-medium", tone)}>{name}</dt>
      <dd className="text-[13px] leading-relaxed text-ink-2">{children}</dd>
    </div>
  );
}

function Panel({ tab, version, commands }: { tab: string; version?: string; commands: ExtraCommand[] }) {
  if (tab === "general") {
    return (
      <div className="flex flex-col gap-2.5 text-[13.5px] leading-relaxed text-ink-2">
        {GENERAL.map((line) => (
          <p key={line}>{line}</p>
        ))}
        {version ? <p className="pt-1 font-mono text-[12px] text-ink-3">tcode v{version}</p> : null}
      </div>
    );
  }
  if (tab === "commands") {
    return (
      <dl className="divide-y divide-rule/70">
        {COMMANDS.map((c) => (
          <Row key={c.name} name={`/${c.name}`}>
            {c.description}
          </Row>
        ))}
      </dl>
    );
  }
  if (tab === "custom") {
    if (commands.length === 0) {
      return (
        <p className="text-[13.5px] leading-relaxed text-ink-2">
          No custom commands or skills yet. Add commands as <code className="font-mono text-[12.5px]">.tropos/commands/name.md</code> and skills as{" "}
          <code className="font-mono text-[12.5px]">.tropos/skills/name/SKILL.md</code>.
        </p>
      );
    }
    return (
      <dl className="divide-y divide-rule/70">
        {commands.map((c) => {
          const skill = SKILL_PREFIX.test(c.description);
          return (
            <Row key={c.name} name={`/${c.name}${c.argumentHint ? ` ${c.argumentHint}` : ""}`} tone={skill ? "text-violet" : "text-accent-ink"}>
              {c.description.replace(SKILL_PREFIX, "")}
              {skill ? <span className="ml-2 rounded-[5px] bg-violet-wash px-1.5 py-px text-[10.5px] font-medium text-violet">skill</span> : null}
            </Row>
          );
        })}
      </dl>
    );
  }
  return (
    <dl className="divide-y divide-rule/70">
      {WEB_SHORTCUTS.map(([keys, what]) => (
        <Row
          key={what}
          narrow
          name={
            <span className="inline-flex gap-1">
              {keys.map((k) => (
                <Kbd key={k}>{k}</Kbd>
              ))}
            </span>
          }
        >
          {what}
        </Row>
      ))}
    </dl>
  );
}

export function HelpPanel({ open, onClose, version, commands }: { open: boolean; onClose: () => void; version?: string; commands: ExtraCommand[] }) {
  return (
    <Modal open={open} onClose={onClose} title="Help" description="Commands, shortcuts and how Tropos Code works." maxWidth={620}>
      <Tabs items={TABS} label="Help topics" renderPanel={(tab) => <Panel tab={tab} version={version} commands={commands} />} panelClassName="scroll-quiet max-h-[52vh] overflow-y-auto px-5 py-4" />
    </Modal>
  );
}
