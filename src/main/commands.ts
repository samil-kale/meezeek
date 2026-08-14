import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isSameCommand } from "../shared/command";
import type { ProjectCommand } from "../shared/types";
import { resolveCommand } from "./pty";

/**
 * Shell commands a project keeps around — "npm run build", a deploy script, whatever is typed
 * often enough to be worth a button. They live in the repository rather than in meezeek's own
 * storage, so they travel with it like any other project file.
 */
const FILE = "meezeek.json";

/**
 * What that file holds. A command is a plain string while the command line alone says
 * everything, and an object once it needs a directory, variables or a shell — so the common
 * case stays a one-line entry a person can read, and a file full of strings stays valid.
 */
type StoredCommand =
  | string
  | { command?: unknown; name?: unknown; cwd?: unknown; env?: unknown; shell?: unknown };

interface ProjectFile {
  commands?: StoredCommand[];
}

/** How many characters of a command's or an agent's output a notice is worth. */
const MAX_OUTPUT = 600;
/**
 * How much a command may write before node stops buffering it. Its own default is 1MB, and
 * going over it does not truncate — node *kills* the process and reports ENOBUFS, which for a
 * build with a lot to say would look like a failure it never had. Same figure as git.ts.
 */
const MAX_BUFFER = 64 * 1024 * 1024;

function file(root: string): string {
  return path.join(root, FILE);
}

/**
 * The file's contents, or **null** when there is no meezeek.json at all — the one case worth
 * telling apart, since that is when the caller offers to fill the list itself. One that is
 * there but unreadable or shaped differently is no commands rather than none: it is a file in
 * the user's repository, and half of it being someone else's is reason neither to throw nor to
 * write over it.
 */
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

/** Only the string values of an `env`; anything else in there is not an environment. */
function toEnv(value: unknown): Record<string, string> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const env = Object.fromEntries(
    Object.entries(value).filter((pair): pair is [string, string] => typeof pair[1] === "string")
  );
  return Object.keys(env).length > 0 ? env : undefined;
}

/** Both spellings in, one shape out; anything that is neither is dropped. */
function toCommand(entry: StoredCommand): ProjectCommand | undefined {
  if (typeof entry === "string") {
    return entry.trim() ? { command: entry } : undefined;
  }
  if (typeof entry?.command !== "string" || !entry.command.trim()) {
    return undefined;
  }
  const command: ProjectCommand = { command: entry.command };
  if (typeof entry.name === "string" && entry.name.trim()) {
    command.name = entry.name;
  }
  if (typeof entry.cwd === "string" && entry.cwd.trim()) {
    command.cwd = entry.cwd;
  }
  const env = toEnv(entry.env);
  if (env) {
    command.env = env;
  }
  if (entry.shell === true) {
    command.shell = true;
  }
  return command;
}


export async function readCommands(root: string): Promise<ProjectCommand[] | null> {
  const content = await read(root);
  if (content === null) {
    return null;
  }
  if (!Array.isArray(content.commands)) {
    return [];
  }
  return content.commands.map(toCommand).filter((command): command is ProjectCommand => command !== undefined);
}

export function writeCommands(root: string, commands: ProjectCommand[]): Promise<void> {
  // Back to the short form wherever there is nothing else to say about the command.
  return patch(root, {
    commands: commands.map((command) =>
      command.name || command.cwd || command.env || command.shell ? command : command.command
    )
  });
}


/**
 * What an agent is asked when the wand is pressed. Deliberately concrete about where commands
 * hide — a model told only "find the commands" answers with what it would type in a generic
 * project of that kind rather than with what this one declares.
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
  "Each command is started as a program with arguments, with no shell in between, so that the",
  "same entry works on Windows and on Unix. Nothing in it is interpreted: no pipes, no",
  '"&&" or "||", no ">" redirection, no "$(...)", no backticks, no "$VAR", and no',
  '"VAR=value cmd" prefix. Quotes group one argument and are the only way to put a space in',
  "one.",
  'Environment variables go in an "env" object instead, and meezeek sets them:',
  '  {"command": "java -jar target/app.jar", "env": {"PROFILE": "DEVELOPMENT"}}',
  "Two things that have to run one after the other are two entries, not one line.",
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
function parseSuggestions(reply: string): ProjectCommand[] {
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
    return (parsed as StoredCommand[])
      .map(toCommand)
      .filter((command): command is ProjectCommand => command !== undefined);
  } catch {
    return [];
  }
}

/**
 * Asks an agent what this project can run, and answers with the commands it named. Runs
 * without a terminal — the wand is a button in the sidebar, not a session — so the agent gets
 * one question and one shot at replying.
 */
export function suggestCommands(root: string, executable: string, args: string[]): Promise<ProjectCommand[]> {
  const { command, args: resolved } = resolveCommand(executable, args);
  return new Promise((resolve, reject) => {
    execFile(
      command,
      resolved,
      { cwd: root, maxBuffer: MAX_BUFFER, windowsHide: true, encoding: "utf8", timeout: SUGGEST_TIMEOUT_MS },
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
export function mergeCommands(existing: ProjectCommand[], found: ProjectCommand[]): ProjectCommand[] {
  const merged = [...existing];
  for (const command of found) {
    if (merged.some((entry) => isSameCommand(entry, command))) {
      continue;
    }
    let last = -1;
    for (let index = 0; index < merged.length; index++) {
      if (tool(merged[index].command) === tool(command.command)) {
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
