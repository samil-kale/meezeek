import * as path from "node:path";
import { watchMarkers } from "../../main/marker-watch";
import { createByteThresholdCheck } from "../../main/session-ready";
import type { AgentDefinition } from "../agent";
import { setupCodexHooks } from "./hooks";
import { codexSessionProvider } from "./sessions";

export const codexAgent: AgentDefinition = {
  id: "codex",
  displayName: "Codex",
  executable: () => "codex",
  versionArgs: ["--version"],
  installUrl: "https://github.com/openai/codex",
  // `--ephemeral` skips the rollout file entirely, so nothing is left behind for cleanupAsk to
  // remove — the same reasoning as Claude's `--no-session-persistence`.
  askArgs: ["exec", "--ephemeral", "--skip-git-repo-check", "--color", "never"],
  sessions: codexSessionProvider,
  prepareSpawn: (_executable, cwd, paths) => {
    let args: string[] = [];
    const watchers: (() => void)[] = [];
    try {
      args = setupCodexHooks(paths.agentDir, "Codex", paths.notifications, path.basename(cwd), paths.contextFile);
      // Same shape as Claude's: a hook is a process of its own and cannot call back into
      // meezeek, so each end of a turn — and the point part-way through where it stops for an
      // answer — leaves a marker file behind, and these are what pick them up.
      watchers.push(watchMarkers(paths.agentDir, "busy", paths.onSessionBusy));
      watchers.push(watchMarkers(paths.agentDir, "finished", paths.onSessionFinished));
      watchers.push(watchMarkers(paths.agentDir, "waiting", paths.onSessionWaiting));
    } catch (error) {
      // As with Claude, losing the hooks must not keep Codex from starting — swallowed rather
      // than rejected, since a rejection here marks the whole agent unstartable.
      console.error("[meezeek] could not set up Codex hooks:", error);
    }
    return Promise.resolve({ args, dispose: () => watchers.forEach((stop) => stop()) });
  },
  // No documented readiness signal (no port, no log line, no flag) — a plain byte count, tuned
  // against the TUI's own startup frames observed on a real install: setup/onboarding chunks
  // total a few hundred bytes before the first real redraw, itself a single ~700-900 byte chunk.
  // Unverified against a *logged-in* start, which may draw less before the first redraw — revisit
  // once that is checked.
  createIsSessionReady: () => createByteThresholdCheck(600)
};
