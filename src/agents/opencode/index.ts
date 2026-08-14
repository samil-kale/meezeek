import { createByteThresholdCheck } from "../../main/session-ready";
import type { AgentDefinition } from "../agent";
import { prepareOpencodeSpawn } from "./server";
import { resolveOpencodeUrlPrefix } from "./session-urls";
import { opencodeSessionProvider } from "./sessions";

/** What a background question's session is called, so it can be found and removed again. */
const ASK_TITLE = "meezeek: project commands";

export const opencodeAgent: AgentDefinition = {
  id: "opencode",
  displayName: "OpenCode",
  executable: () => "opencode",
  versionArgs: ["--version"],
  installUrl: "https://opencode.ai/docs/",
  /*
   * Its own non-interactive mode: prints the reply and exits. It has no way to skip persisting
   * the session, so the run is titled and `cleanupAsk` deletes it again by that title — the
   * alternative, deleting whatever appeared while the question ran, would also catch a session
   * the user started themselves in the meantime.
   */
  askArgs: (question) => ["run", "--title", ASK_TITLE, question],
  cleanupAsk: async (executable, cwd) => {
    const sessions = await opencodeSessionProvider.list(executable, cwd);
    for (const session of sessions.filter((candidate) => candidate.title === ASK_TITLE)) {
      await opencodeSessionProvider.remove(executable, cwd, session.id).catch(() => undefined);
    }
  },
  sessions: opencodeSessionProvider,
  prepareSpawn: prepareOpencodeSpawn,
  resolveUrlPrefix: resolveOpencodeUrlPrefix,
  // No grace period: `attach` has no splash — it opens with a 4-byte and a 19-byte frame —
  // so a grace window would throw away every byte the session ever produces and leave the
  // bar up forever. What is left is the byte count: the frames before the first real redraw
  // total ~530 bytes, the redraw itself is one chunk of 0.6 KB to 7.4 KB. 800 sits between.
  createIsSessionReady: () => createByteThresholdCheck(800)
};
