import type { AgentId } from "../shared/types";

/**
 * Everything the shared terminal layer needs to start one agent. Agent-specific behaviour
 * (session enumeration, resume, agent-specific options) belongs in the agent's own folder,
 * not in the shared layer — see the `agents/<id>/` structure.
 */
export interface AgentDefinition {
  id: AgentId;
  displayName: string;
  /** Resolved at spawn time, since the shell's executable depends on the platform. */
  executable(): string;
  args?: string[];
  /** Defaults, not overrides — a variable the user already has set wins (see spawnAgentProcess). */
  env?: Record<string, string>;
}
