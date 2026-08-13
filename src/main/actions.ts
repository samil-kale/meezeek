import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ProjectAction } from "../shared/types";
import { resolveCommand } from "./pty";

/**
 * Shell commands a project keeps around — "npm run build", a deploy script, whatever is typed
 * often enough to be worth a button. They live in the repository rather than in meeseek's own
 * storage, so they travel with it and can be shared like any other project file.
 */
const FILE = "meeseek.json";

/**
 * What that file holds. An action is written as a plain string while it runs in the project
 * root, and as an object once it needs a directory of its own — so the common case stays a
 * one-line entry a person can read, and an older file full of strings is still a valid one.
 */
type StoredAction = string | { command?: unknown; cwd?: unknown };

interface ProjectFile {
  actions?: StoredAction[];
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

/** Both spellings in, one shape out; anything that is neither is dropped. */
function toAction(entry: StoredAction): ProjectAction | undefined {
  if (typeof entry === "string") {
    return entry.trim() ? { command: entry } : undefined;
  }
  if (typeof entry?.command !== "string" || !entry.command.trim()) {
    return undefined;
  }
  return typeof entry.cwd === "string" && entry.cwd.trim() ? { command: entry.command, cwd: entry.cwd } : { command: entry.command };
}

export async function readActions(root: string): Promise<ProjectAction[] | null> {
  const content = await read(root);
  if (content === null) {
    return null;
  }
  if (!Array.isArray(content.actions)) {
    return [];
  }
  return content.actions.map(toAction).filter((action): action is ProjectAction => action !== undefined);
}

export function writeActions(root: string, actions: ProjectAction[]): Promise<void> {
  // Back to the short form wherever there is nothing else to say about the command.
  return patch(root, { actions: actions.map((action) => (action.cwd ? action : action.command)) });
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
  "Include how the project is *started*, even where nobody wrote that command down. A class",
  "with a main method, a `func main`, a `__main__.py`, a binary target — each of those is a",
  "runnable program, and the project's own tooling already knows how to run it:",
  '  mvn compile exec:java -Dexec.mainClass=com.example.Application',
  "  cargo run --bin server",
  "  go run ./cmd/api",
  "  dotnet run --project src/App",
  "  python -m package",
  "Those are examples, not the list — whatever this project is written in, if it has something",
  "to start, name the command that starts it.",
  "Where the project depends on a framework with a runner of its own, that one wins:",
  "spring-boot:run rather than exec:java, quarkus:dev rather than a plain main.",
  "Launch configurations count as well (.vscode/launch.json, .idea/runConfigurations,",
  "nbactions.xml): give the shell command that does what they do, not the IDE's own wrapper.",
  "",
  "Leave out what nobody types: lifecycle hooks (prepare, postinstall), scripts that only exist",
  "for another script or for CI to call, and the internal steps of a build. If a project really",
  "does offer twenty commands worth running by hand, name all twenty — the number is not the",
  "point, being able to use each one is.",
  "",
  "Write every command the way it would be typed in the folder that declares it — plain",
  '"npm run build", not "npm run build --prefix web". Where that folder is not the repository',
  'root, say so with "cwd", relative to the root. A command that runs in the root is a plain',
  "string.",
  "",
  "Answer with nothing but a JSON array. The command that starts the project comes first — it",
  "is the one reached for most. After it, keep the ones that use the same tool next to each",
  "other.",
  'Example: ["mvn spring-boot:run", "mvn test", {"command": "npm run build", "cwd": "web"}]'
].join("\n");

/** An agent that neither answers nor gives up is not going to; the wand says so and stops. */
const SUGGEST_TIMEOUT_MS = 5 * 60_000;

/**
 * Pulls the JSON array out of an agent's reply. Asked for "nothing but", they still tend to
 * wrap it in a fenced block or a sentence, so the first bracketed run is what counts.
 */
function parseSuggestions(reply: string): ProjectAction[] {
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
    // The same two spellings the file takes: a bare string, or a command with a directory.
    return (parsed as StoredAction[])
      .map(toAction)
      .filter((action): action is ProjectAction => action !== undefined);
  } catch {
    return [];
  }
}

/**
 * Asks an agent what this project can run, and answers with the commands it named. Runs
 * without a terminal — the wand is a button in the sidebar, not a session — so the agent gets
 * one question and one shot at replying.
 */
export function suggestActions(root: string, executable: string, args: string[]): Promise<ProjectAction[]> {
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
export function mergeActions(existing: ProjectAction[], found: ProjectAction[]): ProjectAction[] {
  const merged = [...existing];
  for (const action of found) {
    // Same command in the same place is the same action; the same command elsewhere is not.
    if (merged.some((entry) => entry.command === action.command && entry.cwd === action.cwd)) {
      continue;
    }
    let last = -1;
    for (let index = 0; index < merged.length; index++) {
      if (tool(merged[index].command) === tool(action.command)) {
        last = index;
      }
    }
    if (last < 0) {
      merged.push(action);
    } else {
      merged.splice(last + 1, 0, action);
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
export function runAction(root: string, action: ProjectAction): Promise<ActionResult> {
  const [shell, args] =
    process.platform === "win32"
      ? ["powershell.exe", ["-NoProfile", "-Command", action.command]]
      : [process.env.SHELL ?? "/bin/bash", ["-c", action.command]];
  // Its own directory when it has one, the project root otherwise. `resolve` rather than
  // `join`, so a cwd that is already absolute is left where it is.
  const cwd = action.cwd ? path.resolve(root, action.cwd) : root;

  return new Promise((resolve) => {
    execFile(shell, args, { cwd, windowsHide: true, encoding: "utf8" }, (error, stdout, stderr) => {
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
