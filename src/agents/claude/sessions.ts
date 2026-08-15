import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import type { AgentSessionInfo, SessionProvider } from "../agent";

/**
 * Claude Code has no session CLI — sessions are the `<uuid>.jsonl` transcripts in
 * ~/.claude/projects/<cwd with non-alphanumerics replaced by "-">, identified by
 * filename and ordered by mtime. Deleting a session means deleting its transcript.
 */
export const claudeSessionProvider: SessionProvider = {
  async list(_executable: string, cwd: string): Promise<AgentSessionInfo[]> {
    try {
      const projectDir = await findProjectDir(cwd);
      if (!projectDir) {
        return [];
      }
      const files = (await fs.promises.readdir(projectDir)).filter((file) => file.endsWith(".jsonl"));
      const entries = await Promise.all(
        files.map(async (file) => {
          const id = file.slice(0, -".jsonl".length);
          const filePath = path.join(projectDir, file);
          const [tail, mtime, createdAt] = await Promise.all([
            scanTail(filePath, id),
            fs.promises.stat(filePath).then((stat) => stat.mtimeMs),
            extractCreatedAt(filePath)
          ]);
          const { title, provisional } = await extractTitle(filePath, tail.customTitle);
          return {
            id,
            title,
            updatedAt: mtime,
            provisionalTitle: provisional,
            createdAt: createdAt ?? mtime,
            turnEndedAt: tail.turnEndedAt
          };
        })
      );
      entries.sort((a, b) => a.createdAt - b.createdAt);
      return entries;
    } catch (error) {
      console.error("[meezeek] claude session listing failed:", error);
      return [];
    }
  },

  resumeArgs(sessionId: string): string[] {
    return ["--resume", sessionId];
  },

  async remove(_executable: string, cwd: string, sessionId: string): Promise<void> {
    const projectDir = await findProjectDir(cwd);
    if (!projectDir) {
      throw new Error("Claude project directory not found");
    }
    await fs.promises.rm(path.join(projectDir, `${sessionId}.jsonl`));
  },

  /**
   * Mirrors Claude Code's own (CLI-flag-less) `/rename` slash command: a rename is persisted
   * as a `custom-title` transcript entry, which — like Claude's own title resolution — always
   * wins over the derived `ai-title`/`summary`/message fallback.
   */
  async rename(_executable: string, cwd: string, sessionId: string, title: string): Promise<void> {
    const trimmed = title.trim();
    if (!trimmed) {
      throw new Error("title must be non-empty");
    }
    const projectDir = await findProjectDir(cwd);
    if (!projectDir) {
      throw new Error("Claude project directory not found");
    }
    const line = JSON.stringify({ type: "custom-title", customTitle: trimmed, sessionId }) + "\n";
    await fs.promises.appendFile(path.join(projectDir, `${sessionId}.jsonl`), line);
  },

  /**
   * Watches the project's transcripts. Non-recursive on purpose: a write inside a session's
   * own `subagents/` subdirectory then doesn't fire at all, and the directory entries that do
   * fire are filtered out by extension.
   *
   * Two-stage because the project directory doesn't exist until Claude first writes a
   * transcript there, and fs.watch throws ENOENT on a missing one: until then, watch the
   * projects root (which does report the new directory appearing) and arm the real watcher
   * once it shows up.
   */
  watch(_executable: string, cwd: string, onChange: () => void): () => void {
    let projectWatcher: fs.FSWatcher | undefined;
    let rootWatcher: fs.FSWatcher | undefined;
    let stopped = false;

    const armProjectWatcher = async (): Promise<void> => {
      if (stopped || projectWatcher) {
        return;
      }
      // Rejects when the projects root itself is absent (Claude never ran here) — that's
      // the normal starting state for a fresh install, not a failure worth reporting.
      const projectDir = await findProjectDir(cwd).catch(() => undefined);
      if (!projectDir || stopped || projectWatcher) {
        return;
      }
      projectWatcher = fs.watch(projectDir, (_eventType, filename) => {
        // A null filename means "something here changed" on platforms that don't report
        // it — reconciling then is the safe read.
        if (filename === null || filename.endsWith(".jsonl")) {
          onChange();
        }
      });
      rootWatcher?.close();
      rootWatcher = undefined;
    };

    void armProjectWatcher().then(() => {
      if (stopped || projectWatcher) {
        return;
      }
      try {
        rootWatcher = fs.watch(projectsRoot(), () => void armProjectWatcher());
      } catch {
        // Claude has never run on this machine — nothing to watch, listing stays polled.
      }
    });

    return () => {
      stopped = true;
      projectWatcher?.close();
      rootWatcher?.close();
    };
  }
};

function projectsRoot(): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
  return path.join(configDir, "projects");
}

async function findProjectDir(cwd: string): Promise<string | undefined> {
  const projectsDir = projectsRoot();
  const encoded = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  // Windows paths are case-insensitive and the CLI preserves whatever casing it saw,
  // so the same project can have differently-cased directories there.
  const ignoreCase = process.platform === "win32";
  const wanted = ignoreCase ? encoded.toLowerCase() : encoded;
  for (const entry of await fs.promises.readdir(projectsDir)) {
    if ((ignoreCase ? entry.toLowerCase() : entry) === wanted) {
      return path.join(projectsDir, entry);
    }
  }
  return undefined;
}

const TITLE_MAX_LENGTH = 60;
const TITLE_SCAN_BYTE_LIMIT = 256 * 1024;

interface ResolvedTitle {
  title: string;
  /** No name assigned by Claude yet — `title` is the first prompt standing in for one. */
  provisional: boolean;
}

/**
 * Resolves a session's display name the same way Claude Code's own `/resume` list does
 * (order verified against the CLI, including that a rename outranks an "agent-name"):
 * a `custom-title` entry (Claude's own `/rename`, and what our rename writes) wins and
 * is appended at the true end of the file, so it comes from the tail scan the caller has
 * already run rather than from the head window below. Otherwise "agent-name", else
 * "ai-title" — for both, the last
 * occurrence *within that window* wins, since a later one supersedes an earlier one. Else
 * a "summary" entry (only seen after `/compact`), else the first prompt the user typed:
 * Claude assigns no title at all to short sessions, and `/resume` labels those by that
 * prompt rather than leaving them blank. Falls back to "" — the UI shows a placeholder.
 *
 * Don't change this scanning logic casually: a regression here silently shows the wrong
 * tab title with nothing to catch it.
 */
async function extractTitle(filePath: string, customTitle: string | undefined): Promise<ResolvedTitle> {
  if (customTitle) {
    return { title: truncateTitle(customTitle), provisional: false };
  }

  const stream = fs.createReadStream(filePath, { encoding: "utf8", end: TITLE_SCAN_BYTE_LIMIT });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let agentName: string | undefined;
  let aiTitle: string | undefined;
  let summary: string | undefined;
  let firstPrompt: string | undefined;
  try {
    for await (const line of lines) {
      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      // agent-name/ai-title keep the last occurrence (a later one supersedes an earlier
      // one), summary and the first prompt the first — an empty value never displaces
      // what's already there either way.
      if (entry.type === "agent-name") {
        agentName = nonEmptyString(entry.agentName) ?? agentName;
      } else if (entry.type === "ai-title") {
        aiTitle = nonEmptyString(entry.aiTitle) ?? aiTitle;
      } else if (entry.type === "summary") {
        summary ??= nonEmptyString(entry.summary);
      } else if (firstPrompt === undefined && entry.type === "user") {
        firstPrompt = typedPromptText(entry);
      }
    }
  } catch (error) {
    console.error("[meezeek] claude title extraction failed:", error);
  } finally {
    lines.close();
    stream.destroy();
  }
  const assigned = agentName ?? aiTitle ?? summary;
  const title = assigned ?? firstPrompt;
  return { title: title ? truncateTitle(title) : "", provisional: assigned === undefined };
}

/**
 * A transcript's own first timestamped entry is a far more stable "created" signal than the
 * file's mtime, which shifts on every append. Deliberately independent of extractTitle rather
 * than folded into its scan: that one returns early once it finds a custom-title, skipping its
 * head-scan — reusing it here would leave every renamed session without a createdAt.
 */
async function extractCreatedAt(filePath: string): Promise<number | undefined> {
  const stream = fs.createReadStream(filePath, { encoding: "utf8", end: TITLE_SCAN_BYTE_LIMIT });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      const timestamp = nonEmptyString(entry.timestamp);
      if (timestamp) {
        const ms = Date.parse(timestamp);
        if (!Number.isNaN(ms)) {
          return ms;
        }
      }
    }
  } catch (error) {
    console.error("[meezeek] claude createdAt extraction failed:", error);
  } finally {
    lines.close();
    stream.destroy();
  }
  return undefined;
}

/**
 * Most `user` entries are tool results the CLI writes back into the transcript itself; only
 * those tagged `origin.kind === "human"` are prompts the user typed.
 */
function typedPromptText(entry: Record<string, unknown>): string | undefined {
  const origin = entry.origin as { kind?: unknown } | undefined;
  if (origin?.kind !== "human") {
    return undefined;
  }
  const message = entry.message as { content?: unknown } | undefined;
  return nonEmptyString(message?.content);
}

/** Transcript fields are untrusted JSON — a title only counts if it's a non-blank string. */
function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/** What one pass over the transcript's tail answers — see scanTail. */
interface TranscriptTail {
  /** The last `custom-title` entry, if the tail holds one. */
  customTitle?: string;
  /** When the last turn ended, from the `turn_duration` entry Claude writes at every end. */
  turnEndedAt?: number;
}

/**
 * Reads just the transcript's tail once and answers both questions that live at the end of the
 * file: the custom-title (appended at the true end, potentially well past extractTitle's head
 * window) and when the last turn ended. One pass because both are read on every listing, and a
 * listing runs for every session of the repository.
 *
 * Both take the *last* occurrence, so the scan runs backwards and stops as soon as it has them.
 * Claude writes a `turn_duration` entry when a turn ends whichever way it ended — the one after
 * an interrupted turn is what the Stop hook never reports, and what AgentSessionInfo.turnEndedAt
 * exists for. Sidechain entries are a subagent's own turns, not the session's.
 */
async function scanTail(filePath: string, sessionId: string): Promise<TranscriptTail> {
  const tail: TranscriptTail = {};
  let handle: fs.promises.FileHandle | undefined;
  try {
    handle = await fs.promises.open(filePath, "r");
    const { size } = await handle.stat();
    const start = Math.max(0, size - TITLE_SCAN_BYTE_LIMIT);
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    const lines = buffer.toString("utf8").split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(lines[i]) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (tail.customTitle === undefined && entry.type === "custom-title" && entry.sessionId === sessionId) {
        tail.customTitle = nonEmptyString(entry.customTitle);
      } else if (
        tail.turnEndedAt === undefined &&
        entry.type === "system" &&
        entry.subtype === "turn_duration" &&
        entry.isSidechain !== true
      ) {
        const ms = Date.parse(nonEmptyString(entry.timestamp) ?? "");
        tail.turnEndedAt = Number.isNaN(ms) ? undefined : ms;
      }
      if (tail.customTitle !== undefined && tail.turnEndedAt !== undefined) {
        break;
      }
    }
  } catch (error) {
    console.error("[meezeek] claude transcript tail scan failed:", error);
  } finally {
    await handle?.close();
  }
  return tail;
}

function truncateTitle(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > TITLE_MAX_LENGTH ? `${normalized.slice(0, TITLE_MAX_LENGTH - 1)}…` : normalized;
}
