import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type {
  CheckoutResult,
  CheckoutTarget,
  ChangeStatus,
  DiffLine,
  FileChange,
  FileDiff,
  RemoteInfo,
  RepositoryState
} from "../shared/types";

const MAX_BUFFER = 64 * 1024 * 1024;
/** Rendering a whole huge diff would stall the renderer; the viewer shows a hint instead. */
const MAX_DIFF_LINES = 5000;
/** Untracked files are read to synthesise their diff — do not pull a huge file into memory. */
const MAX_UNTRACKED_BYTES = 2 * 1024 * 1024;

export interface GitResult {
  stdout: string;
  stderr: string;
  code: number;
}

/**
 * Runs the local git CLI. Resolves for any exit code (callers decide what a non-zero one
 * means) and rejects only when git itself could not be started.
 */
export function git(cwd: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      { cwd, maxBuffer: MAX_BUFFER, windowsHide: true, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (error && typeof error.code !== "number") {
          reject(new Error(`git could not be started (${error.code ?? error.message})`));
          return;
        }
        resolve({ stdout, stderr, code: error ? Number(error.code) : 0 });
      }
    );
  });
}

export async function isRepository(cwd: string): Promise<boolean> {
  try {
    const result = await git(cwd, ["rev-parse", "--git-dir"]);
    return result.code === 0;
  } catch {
    return false;
  }
}

/**
 * The repository root of `cwd`, or undefined when it is not inside one. A picked folder may
 * well be a subdirectory of the repository, and every path git reports is relative to the
 * root — so the root is what the project has to work against.
 */
export async function resolveRoot(cwd: string): Promise<string | undefined> {
  try {
    const result = await git(cwd, ["rev-parse", "--show-toplevel"]);
    const root = result.stdout.trim();
    return result.code === 0 && root ? path.normalize(root) : undefined;
  } catch {
    return undefined;
  }
}

async function readHead(cwd: string): Promise<{ head: string; detached: boolean }> {
  const current = await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (current.code !== 0) {
    // Unborn branch (a fresh repository without commits): HEAD points at a ref that does
    // not exist yet, so only symbolic-ref can name it.
    const symbolic = await git(cwd, ["symbolic-ref", "--short", "HEAD"]);
    return { head: symbolic.code === 0 ? symbolic.stdout.trim() : "HEAD", detached: false };
  }
  const name = current.stdout.trim();
  if (name !== "HEAD") {
    return { head: name, detached: false };
  }
  const short = await git(cwd, ["rev-parse", "--short", "HEAD"]);
  return { head: short.stdout.trim() || "HEAD", detached: true };
}

async function readBranches(cwd: string): Promise<{ localBranches: string[]; remotes: RemoteInfo[] }> {
  // Full ref names, not %(refname:short): git shortens "refs/remotes/origin/HEAD" to plain
  // "origin", which cannot be told apart from a branch named after its remote.
  const result = await git(cwd, ["for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes"]);

  const localBranches: string[] = [];
  const remotes = new Map<string, string[]>();

  for (const line of result.stdout.split("\n")) {
    const refname = line.trim();
    if (!refname) {
      continue;
    }
    if (refname.startsWith("refs/heads/")) {
      localBranches.push(refname.slice("refs/heads/".length));
      continue;
    }
    const remoteRef = refname.slice("refs/remotes/".length);
    // "origin/HEAD" is a symbolic pointer at the remote's default branch, not a branch
    // of its own — listing it would duplicate an entry that is already there.
    const separator = remoteRef.indexOf("/");
    if (separator < 0 || remoteRef.endsWith("/HEAD")) {
      continue;
    }
    const remote = remoteRef.slice(0, separator);
    const branch = remoteRef.slice(separator + 1);
    const branches = remotes.get(remote);
    if (branches) {
      branches.push(branch);
    } else {
      remotes.set(remote, [branch]);
    }
  }

  return {
    localBranches,
    remotes: [...remotes].map(([name, branches]) => ({ name, branches }))
  };
}

const CONFLICT_CODES = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

function toChangeStatus(code: string): ChangeStatus {
  if (code === "??") {
    return "untracked";
  }
  if (CONFLICT_CODES.has(code)) {
    return "conflicted";
  }
  // Index status first, worktree status second; the first non-space one describes the change.
  const letter = code[0] !== " " ? code[0] : code[1];
  switch (letter) {
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    case "C":
      return "added";
    default:
      return "modified";
  }
}

async function readChanges(cwd: string): Promise<FileChange[]> {
  // core.quotePath=false keeps non-ASCII paths readable instead of octal-escaped.
  const result = await git(cwd, [
    "-c",
    "core.quotePath=false",
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all"
  ]);

  const entries = result.stdout.split("\0");
  const changes: FileChange[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.length < 4) {
      continue;
    }
    const code = entry.slice(0, 2);
    const filePath = entry.slice(3);
    const status = toChangeStatus(code);
    if (status === "renamed" || code[0] === "C" || code[1] === "C") {
      // Renames and copies are two records: the new path, then the old one.
      const origPath = entries[++i];
      changes.push({ path: filePath, status, origPath });
      continue;
    }
    changes.push({ path: filePath, status });
  }
  return changes;
}

export async function readState(cwd: string): Promise<RepositoryState> {
  const empty: RepositoryState = {
    head: "",
    detached: false,
    localBranches: [],
    remotes: [],
    changes: []
  };

  try {
    if (!(await isRepository(cwd))) {
      return { ...empty, error: "Not a git repository" };
    }
    const [head, branches, changes] = await Promise.all([readHead(cwd), readBranches(cwd), readChanges(cwd)]);
    return { ...head, ...branches, changes };
  } catch (error) {
    return { ...empty, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function checkout(cwd: string, target: CheckoutTarget, localBranches: string[]): Promise<CheckoutResult> {
  // A remote branch is checked out by name once a local branch of that name exists;
  // otherwise git creates it as a tracking branch.
  const args =
    target.remote === undefined || localBranches.includes(target.name)
      ? ["switch", target.name]
      : ["switch", "--track", `${target.remote}/${target.name}`];

  try {
    let result = await git(cwd, args);
    if (result.code !== 0 && args.includes("--track")) {
      // The local branch may have appeared since the last refresh — then a plain switch
      // is what was needed, and its own error is the one worth reporting.
      result = await git(cwd, ["switch", target.name]);
    }
    if (result.code === 0) {
      return { ok: true };
    }
    return { ok: false, error: (result.stderr || result.stdout).trim() };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

function parseUnifiedDiff(text: string): { lines: DiffLine[]; truncated: boolean } {
  const lines: DiffLine[] = [];
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;

  for (const raw of text.split("\n")) {
    const header = HUNK_HEADER.exec(raw);
    if (header) {
      oldLine = Number(header[1]);
      newLine = Number(header[2]);
      inHunk = true;
      lines.push({ type: "hunk", text: raw });
      continue;
    }
    if (!inHunk) {
      continue;
    }
    if (raw.startsWith("+")) {
      lines.push({ type: "add", newLine: newLine++, text: raw.slice(1) });
    } else if (raw.startsWith("-")) {
      lines.push({ type: "del", oldLine: oldLine++, text: raw.slice(1) });
    } else if (raw.startsWith(" ")) {
      lines.push({ type: "context", oldLine: oldLine++, newLine: newLine++, text: raw.slice(1) });
    }
    // "\ No newline at end of file" and any trailing empty line are not part of the content.

    if (lines.length >= MAX_DIFF_LINES) {
      return { lines, truncated: true };
    }
  }

  return { lines, truncated: false };
}

/** An untracked file has nothing to diff against, so its content becomes an all-added diff. */
async function readUntrackedDiff(cwd: string, filePath: string): Promise<FileDiff> {
  const absolute = path.join(cwd, filePath);
  const base: FileDiff = { path: filePath, lines: [], binary: false, truncated: false };
  try {
    const stat = await fs.stat(absolute);
    if (stat.size > MAX_UNTRACKED_BYTES) {
      return { ...base, truncated: true };
    }
    const content = await fs.readFile(absolute);
    if (content.includes(0)) {
      return { ...base, binary: true };
    }
    const text = content.toString("utf8");
    const rows = text.split("\n");
    if (rows.at(-1) === "") {
      rows.pop();
    }
    const lines: DiffLine[] = rows
      .slice(0, MAX_DIFF_LINES)
      .map((row, index) => ({ type: "add" as const, newLine: index + 1, text: row }));
    return { ...base, lines, truncated: rows.length > MAX_DIFF_LINES };
  } catch (error) {
    return { ...base, error: error instanceof Error ? error.message : String(error) };
  }
}

export interface DiffOptions {
  untracked: boolean;
  /** The rename's source path — without it git diffs the new path as a wholly new file. */
  origPath?: string;
}

/**
 * The diff of one file against HEAD — index and worktree changes combined, which is what
 * the "Local Changes" list shows as a single entry.
 */
export async function readDiff(cwd: string, filePath: string, options: DiffOptions): Promise<FileDiff> {
  if (options.untracked) {
    return readUntrackedDiff(cwd, filePath);
  }

  const paths = options.origPath ? [options.origPath, filePath] : [filePath];
  const base: FileDiff = { path: filePath, lines: [], binary: false, truncated: false };
  try {
    let result = await git(cwd, ["diff", "HEAD", "--no-color", "--", ...paths]);
    if (result.code !== 0) {
      // No HEAD yet (unborn branch): compare against the index instead.
      result = await git(cwd, ["diff", "--no-color", "--", ...paths]);
      if (result.code !== 0) {
        return { ...base, error: (result.stderr || result.stdout).trim() };
      }
    }
    if (/^Binary files /m.test(result.stdout)) {
      return { ...base, binary: true };
    }
    const { lines, truncated } = parseUnifiedDiff(result.stdout);
    return { ...base, lines, truncated };
  } catch (error) {
    return { ...base, error: error instanceof Error ? error.message : String(error) };
  }
}
