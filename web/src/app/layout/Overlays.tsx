// web/src/app/layout/Overlays.tsx — the app-wide modals, mounted once by App on every page: the permission prompt, the
// model picker and the chat's panels (/help, /cost, /effort, /resume). A permission prompt outranks everything: while one
// waits, the other dialogs step aside (and come back once it is answered).
import { CostPanel } from "@/components/chat/CostPanel";
import { EffortPicker } from "@/components/chat/EffortPicker";
import { HelpPanel } from "@/components/chat/HelpPanel";
import { ModelPicker } from "@/components/chat/ModelPicker";
import { PermissionModal } from "@/components/chat/PermissionModal";
import { ResumePicker } from "@/components/chat/ResumePicker";
import { useAppSelector, useHello } from "@/lib/store";
import { ui, useChatPanel, useModelPickerOpen } from "@/lib/ui-store";

export function Overlays() {
  const asking = useAppSelector((s) => s.asks.length > 0);
  const modelPickerOpen = useModelPickerOpen();
  const panel = useChatPanel();
  const hello = useHello();
  const free = !asking;
  return (
    <>
      <ModelPicker open={modelPickerOpen && free} onClose={ui.closeModelPicker} />
      <HelpPanel open={panel === "help" && free} onClose={ui.closePanel} version={hello?.version} commands={hello?.commands ?? []} />
      <CostPanel open={panel === "cost" && free} onClose={ui.closePanel} />
      <EffortPicker open={panel === "effort" && free} onClose={ui.closePanel} />
      <ResumePicker open={panel === "resume" && free} onClose={ui.closePanel} />
      <PermissionModal />
    </>
  );
}
