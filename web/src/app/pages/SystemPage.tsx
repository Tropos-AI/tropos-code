// web/src/app/pages/SystemPage.tsx — operating the install: the login service, the sandbox, updates, backups and how
// to uninstall. Each section loads on its own, so one failing call leaves the rest usable.
import { PageFrame } from "@/app/layout/PageFrame";
import { BackupsSection, UninstallSection } from "@/components/admin/system-backups";
import { SandboxSection, ServiceSection } from "@/components/admin/system-service";
import { UpdateSection } from "@/components/admin/system-update";

export function SystemPage() {
  return (
    <PageFrame title="System" eyebrow="Control" description="The login service, the sandbox, updates and backups of this installation.">
      <ServiceSection />
      <SandboxSection />
      <UpdateSection />
      <BackupsSection />
      <UninstallSection />
    </PageFrame>
  );
}
