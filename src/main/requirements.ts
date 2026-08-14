import * as os from "node:os";
import { AGENTS } from "../agents";
import type { AgentDefinition } from "../agents/agent";
import type { Requirement, Requirements } from "../shared/types";
import { git } from "./git-client";
import { checkAgentInstalled } from "./terminal-session";

/** An agent that has to be installed; the shell has no `versionArgs` and is always there. */
type InstallableAgent = AgentDefinition & { versionArgs: string[] };

const GIT: Omit<Requirement, "installed"> = {
  name: "Git",
  command: "git",
  url: "https://git-scm.com/downloads"
};

/**
 * The commands `--simulate` names, reported missing however installed they are. On a machine
 * that has everything the dialog is unreachable otherwise, and it is the one view in here
 * nobody can call up on purpose: `npm start -- --simulate=git,claude`, where npm's own `--`
 * is what hands the flag past the script to electron.
 */
const SIMULATED_MISSING = (process.argv.find((arg) => arg.startsWith("--simulate=")) ?? "")
  .slice("--simulate=".length)
  .split(",")
  .map((entry) => entry.trim())
  .filter((entry) => entry !== "");

/**
 * What has to be on the machine before the app opens: git, because the whole git side is the
 * local CLI, and one of the agents, because the terminals are what meezeek is for.
 *
 * Nothing is cached — the dialog this feeds offers a re-check for the user who installs
 * something while it stands. What a re-check cannot do is see a program that was installed
 * into a folder this process does not have on its PATH yet; only a restart picks that up,
 * which is what the dialog says.
 */
export async function checkRequirements(): Promise<Requirements> {
  // Somewhere every machine has and no repository owns: the checks are about the programs,
  // not about a project.
  const cwd = os.tmpdir();
  const installable = AGENTS.filter((agent): agent is InstallableAgent => agent.versionArgs !== undefined);
  const [installed, agents] = await Promise.all([
    // A git process that could not be started answers the question by rejecting.
    SIMULATED_MISSING.includes(GIT.command) ? false : git.isAvailable().catch(() => false),
    Promise.all(
      installable.map(async (agent): Promise<Requirement> => {
        const command = agent.executable();
        return {
          name: agent.displayName,
          command,
          installed:
            !SIMULATED_MISSING.includes(command) && (await checkAgentInstalled(command, agent.versionArgs, cwd)),
          url: agent.installUrl ?? ""
        };
      })
    )
  ]);
  return {
    met: installed && agents.some((agent) => agent.installed),
    git: { ...GIT, installed },
    agents
  };
}
