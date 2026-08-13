import type { AgentDefinition } from "../agent";

export const shellAgent: AgentDefinition = {
  id: "shell",
  displayName: "Shell",
  executable: () => (process.platform === "win32" ? "powershell.exe" : (process.env.SHELL ?? "/bin/bash"))
};
