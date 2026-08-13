import { createByteThresholdCheck } from "../../main/session-ready";
import type { AgentDefinition } from "../agent";
import { prepareOpencodeSpawn } from "./server";
import { resolveOpencodeUrlPrefix } from "./session-urls";
import { opencodeSessionProvider } from "./sessions";

export const opencodeAgent: AgentDefinition = {
  id: "opencode",
  displayName: "OpenCode",
  executable: () => "opencode",
  versionArgs: ["--version"],
  sessions: opencodeSessionProvider,
  prepareSpawn: prepareOpencodeSpawn,
  resolveUrlPrefix: resolveOpencodeUrlPrefix,
  // No grace period: `attach` has no splash — it opens with a 4-byte and a 19-byte frame —
  // so a grace window would throw away every byte the session ever produces and leave the
  // bar up forever. What is left is the byte count: the frames before the first real redraw
  // total ~530 bytes, the redraw itself is one chunk of 0.6 KB to 7.4 KB. 800 sits between.
  createIsSessionReady: () => createByteThresholdCheck(800)
};
