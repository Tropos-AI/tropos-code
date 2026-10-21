// src/doctor/checks/index.ts — every check, in the order the report lists them.
import type { Check } from "../types";
import { chatExecCheck } from "./chat-exec";
import { containersCheck } from "./containers";
import { dockerCheck } from "./docker";
import { driftCheck } from "./drift";
import { gatewayCheck } from "./gateway";
import { gatewayStateCheck } from "./gateway-state";
import { homeLayoutCheck } from "./home-layout";
import { installCheck } from "./install";
import { mcpCheck } from "./mcp";
import { messagesCheck } from "./messages";
import { permissionsCheck } from "./permissions";
import { providersCheck } from "./providers";
import { securityGatewayCheck } from "./security-gateway";
import { securityPairingCheck } from "./security-pairing";
import { securitySettingsCheck } from "./security-settings";
import { securityWorkspaceCheck } from "./security-workspace";
import { sessionsDefaultCheck } from "./sessions";
import { settingsCheck } from "./settings";
import { toolsCheck } from "./tools";
import { webAccessCheck } from "./web-access";
import { workspaceCheck } from "./workspace";

export const ALL_CHECKS: Check[] = [
  installCheck,
  settingsCheck,
  providersCheck,
  permissionsCheck,
  dockerCheck,
  chatExecCheck,
  containersCheck,
  gatewayCheck,
  gatewayStateCheck,
  webAccessCheck,
  workspaceCheck,
  homeLayoutCheck,
  sessionsDefaultCheck,
  driftCheck,
  mcpCheck,
  toolsCheck,
  messagesCheck,
  securityGatewayCheck,
  securityPairingCheck,
  securitySettingsCheck,
  securityWorkspaceCheck,
];
