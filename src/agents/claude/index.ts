import type { AgentDefinition } from "../agent";

export const claudeAgent: AgentDefinition = {
  id: "claude",
  displayName: "Claude",
  executable: () => "claude"
};
