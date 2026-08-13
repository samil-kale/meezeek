import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { resolveCommand } from "./pty";

/**
 * Shell commands a project keeps around — "npm run build", a deploy script, whatever is typed
 * often enough to be worth a button. They live in the repository rather than in meeseek's own
 * storage, so they travel with it and can be shared like any other project file.
 */
const FILE = "meeseek.json";

/** What that file holds. Anything added later joins it rather than replacing it. */
interface ProjectFile {
  actions?: string[];
}

/** How many characters of a command's or an agent's output a notice is worth. */
const MAX_OUTPUT = 600;

function file(root: string): string {
  return path.join(root, FILE);
}

/**
 * The project's saved commands, or **null** when it has no meeseek.json at all — which is the
 * one case worth telling apart, since that is when the caller offers to fill the list itself.
 * A file that is there but unreadable or shaped differently is no actions rather than none:
 * it is a file in the user's repository, and half of it being someone else's is a good enough
 * reason neither to throw nor to go and write over it.
 */
/** The file's contents, or null when there is none — the one case callers tell apart. */
async function read(root: string): Promise<ProjectFile | null> {
  let content: string;
  try {
    content = await fs.readFile(file(root), "utf8");
  } catch {
    return null;
  }
  try {
    return JSON.parse(content) as ProjectFile;
  } catch {
    // There is a file, it just isn't ours to read. Not nothing, but nothing usable.
    return {};
  }
}

/** Writes one key, keeping every other the file already holds. */
async function patch(root: string, changes: Partial<ProjectFile>): Promise<void> {
  const content = (await read(root)) ?? {};
  await fs.writeFile(file(root), `${JSON.stringify({ ...content, ...changes }, undefined, 2)}\n`, "utf8");
}

export async function readActions(root: string): Promise<string[] | null> {
  const content = await read(root);
  if (content === null) {
    return null;
  }
  return Array.isArray(content.actions) ? content.actions.filter((entry) => typeof entry === "string") : [];
}

export function writeActions(root: string, actions: string[]): Promise<void> {
  return patch(root, { actions });
}


/**
 * What an agent is asked when the wand is pressed. Deliberately concrete about where commands
 * hide — a model that is only told "find the commands" answers with what it would type in a
 * generic project of that kind, rather than with what this one actually declares.
 */
const SUGGEST_PROMPT = [
  "List the commands this project can actually run.",
  "Look at what is really in the repository: scripts in package.json, Maven or Gradle goals,",
  "cargo commands, make targets, composer or dotnet commands, task runners, CI workflows —",
  "whatever this project declares. Prefer the ones a developer runs by hand: build, test, lint,",
  "start, deploy.",
  "",
  "List all of them — a project that declares thirty is a project with thirty.",
  "",
  "Answer with nothing but a JSON array of shell command strings, the ones that use the same",
  "tool next to each other.",
  'Example: ["npm run build", "npm test", "mvn verify"]'
].join("\n");

/** An agent that neither answers nor gives up is not going to; the wand says so and stops. */
const SUGGEST_TIMEOUT_MS = 5 * 60_000;

/**
 * Pulls the JSON array out of an agent's reply. Asked for "nothing but", they still tend to
 * wrap it in a fenced block or a sentence, so the first bracketed run is what counts.
 */
function parseSuggestions(reply: string): string[] {
  const start = reply.indexOf("[");
  const end = reply.lastIndexOf("]");
  if (start < 0 || end <= start) {
    return [];
  }
  try {
    const parsed = JSON.parse(reply.slice(start, end + 1)) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Asks an agent what this project can run, and answers with the commands it named. Runs
 * without a terminal — the wand is a button in the sidebar, not a session — so the agent gets
 * one question and one shot at replying.
 */
export function suggestActions(root: string, executable: string, args: string[]): Promise<string[]> {
  const { command, args: resolved } = resolveCommand(executable, args);
  return new Promise((resolve, reject) => {
    execFile(
      command,
      resolved,
      { cwd: root, windowsHide: true, encoding: "utf8", timeout: SUGGEST_TIMEOUT_MS },
      (error, stdout, stderr) => {
        if (error && !stdout.includes("[")) {
          reject(new Error((stderr.trim() || error.message).slice(0, MAX_OUTPUT)));
          return;
        }
        resolve(parseSuggestions(stdout));
      }
    );
  });
}

/**
 * What a command is run with — "npm" out of "npm run build", "mvn" out of "mvn -q test". The
 * first word is enough: it is what makes two commands belong together in the list.
 */
function tool(command: string): string {
  return command.trim().split(/\s+/)[0] ?? "";
}

/**
 * Adds commands to a list, each one behind the last that runs the same tool — so the maven
 * ones end up together, the npm ones together, without reordering what is already there. The
 * order of the array is the order on screen, and the user's own dragging outranks this: it
 * only ever decides where something *new* lands.
 */
export function mergeActions(existing: string[], found: string[]): string[] {
  const merged = [...existing];
  for (const command of found) {
    if (merged.includes(command)) {
      continue;
    }
    let last = -1;
    for (let index = 0; index < merged.length; index++) {
      if (tool(merged[index]) === tool(command)) {
        last = index;
      }
    }
    if (last < 0) {
      merged.push(command);
    } else {
      merged.splice(last + 1, 0, command);
    }
  }
  return merged;
}

/** The question the wand puts, for the caller that knows which agent to put it to. */
export function suggestQuestion(): string {
  return SUGGEST_PROMPT;
}

export interface ActionResult {
  code: number;
  /** stderr, or stdout when the command said nothing there. Trimmed to what a notice can hold. */
  output: string;
}

/**
 * Runs a command in the project's directory, through the same shell its terminals use, and
 * resolves once it is over. Nothing is shown while it runs — an action is something you set
 * going and hear back about, which is what the notice is for.
 *
 * `-NoProfile` / plain `-c`: a saved command should do the same thing on every machine, and
 * loading a profile makes that depend on what the user has in it.
 */
export function runAction(root: string, command: string): Promise<ActionResult> {
  const [shell, args] =
    process.platform === "win32"
      ? ["powershell.exe", ["-NoProfile", "-Command", command]]
      : [process.env.SHELL ?? "/bin/bash", ["-c", command]];

  return new Promise((resolve) => {
    execFile(shell, args, { cwd: root, windowsHide: true, encoding: "utf8" }, (error, stdout, stderr) => {
      const output = (stderr.trim() || stdout.trim()).slice(0, MAX_OUTPUT);
      if (!error) {
        resolve({ code: 0, output });
        return;
      }
      // A shell that could not be started has no exit code of its own; its message is what
      // there is to report.
      resolve({ code: typeof error.code === "number" ? error.code : 1, output: output || error.message });
    });
  });
}
