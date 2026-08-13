import type { AgentDefinition } from "../agent";
import { prepareOpencodeSpawn } from "./server";
import { opencodeSessionProvider } from "./sessions";

export const opencodeAgent: AgentDefinition = {
  id: "opencode",
  displayName: "OpenCode",
  executable: () => "opencode",
  versionArgs: ["--version"],
  sessions: opencodeSessionProvider,
  prepareSpawn: prepareOpencodeSpawn
};
