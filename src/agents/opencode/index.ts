import type { AgentDefinition } from "../agent";

export const opencodeAgent: AgentDefinition = {
  id: "opencode",
  displayName: "OpenCode",
  executable: () => "opencode"
};
