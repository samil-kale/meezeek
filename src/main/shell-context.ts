import * as fs from "node:fs";
import * as path from "node:path";

/** Collapses the burst of chunks a single command's output arrives in into one write. */
const WRITE_DEBOUNCE_MS = 250;
/**
 * The log lives in its own file rather than being inlined into every prompt, so it can hold
 * far more than an excerpt. A verbose producer still fills it without bound, so keep the
 * most recent slice rather than an ever-growing file.
 */
const MAX_LOG_CHARS = 500_000;
const LOG_TRUNCATION_NOTE = "... [earlier output dropped, showing most recent]\n";
// PowerShell 5.1's Get-Content decodes BOM-less files as ANSI, so on win32 the context file
// needs a UTF-8 BOM or non-ASCII output gets garbled on its way into the prompt.
const CONTEXT_FILE_BOM = process.platform === "win32" ? "﻿" : "";

/**
 * Replaces a file's contents without ever holding it open for writing. Everything written
 * here is read by another process — an agent's prompt hook, or the agent's own file reads —
 * and on Windows opening a file that is mid-write fails outright rather than returning
 * partial data. Writing beside it and renaming into place means a reader gets either the
 * previous file or the new one, never one under construction.
 */
async function replaceFile(file: string, contents: string): Promise<void> {
  const temp = `${file}.tmp`;
  await fs.promises.writeFile(temp, contents);
  await fs.promises.rename(temp, file);
}

/** A bounded log file, written only when its contents actually changed. */
class CappedLogFile {
  private content = "";
  private truncated = false;
  private dirty = false;
  /** Writes are chained rather than started concurrently — they share one temp path. */
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly file: string) {}

  get chars(): number {
    return this.content.length;
  }

  append(text: string): void {
    this.content += text;
    if (this.content.length > MAX_LOG_CHARS) {
      this.content = this.content.slice(-MAX_LOG_CHARS);
      this.truncated = true;
    }
    this.dirty = true;
  }

  flush(): void {
    if (!this.dirty) {
      return;
    }
    this.dirty = false;
    const contents = this.truncated ? LOG_TRUNCATION_NOTE + this.content : this.content;
    this.writing = this.writing
      .then(() => replaceFile(this.file, contents))
      .catch((error) => {
        console.error(`[meeseex] failed to write ${path.basename(this.file)}:`, error);
        // Nothing landed on disk, so the next flush has to try again.
        this.dirty = true;
      });
  }
}

// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

/**
 * Terminal data arrives raw. Escape sequences mean nothing in a log file, and a progress bar
 * redraws its line with a bare carriage return — keeping only what follows the last one
 * leaves each line as the terminal finally showed it, instead of one line per redraw.
 */
function cleanTerminalOutput(data: string): string {
  return data
    .replace(ANSI_PATTERN, "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.slice(line.lastIndexOf("\r") + 1))
    .join("\n");
}

/**
 * What meeseex tells an agent about the repository it is working in: the running transcript
 * of the shell tabs the user opened next to it. Modelled on how the VS Code extension passes
 * a debug session's console output — a capped file the agent is pointed at and reads on
 * demand, rather than an excerpt inlined into every prompt.
 *
 * Only shell tabs feed it. An agent tab's output is its TUI redrawing itself, and handing
 * that back to the agent that produced it is noise at best.
 */
export class ShellContext {
  private readonly log: CappedLogFile;
  private writeTimer: ReturnType<typeof setTimeout> | undefined;
  /** What was last written, so an unchanged context isn't rewritten on every burst. */
  private written: string | undefined;
  /** Writes are chained rather than started concurrently — they share one temp path. */
  private writing: Promise<void> = Promise.resolve();

  constructor(
    private readonly directory: string,
    private readonly repositoryName: string
  ) {
    fs.mkdirSync(directory, { recursive: true });
    this.log = new CappedLogFile(this.logFile);
    // Written up front so the agent's hook has something to read before the first output
    // ever arrives — an absent file would make the hook fail rather than say nothing.
    this.writeContext();
  }

  get logFile(): string {
    return path.join(this.directory, "shell-output.log");
  }

  get contextFile(): string {
    return path.join(this.directory, "context.md");
  }

  append(data: string): void {
    this.log.append(cleanTerminalOutput(data));
    clearTimeout(this.writeTimer);
    this.writeTimer = setTimeout(() => {
      this.log.flush();
      this.writeContext();
    }, WRITE_DEBOUNCE_MS);
  }

  private writeContext(): void {
    // Nothing run yet: an empty file is what says "no context", since both delivery paths
    // treat blank content as nothing to attach.
    const contents =
      this.log.chars === 0
        ? ""
        : [
            "<meeseex_context>",
            `Shell output in ${this.repositoryName} (${Math.ceil(this.log.chars / 1024)} KB), from the` +
              ` shell tabs the user has open next to you: ${this.logFile}`,
            "Read that file when the user asks about something they ran in a shell.",
            "</meeseex_context>",
            "This is the state of the user's workspace at the time the message was sent." +
              " It may or may not be relevant to the request."
          ].join("\n");
    if (contents === this.written) {
      return;
    }
    this.written = contents;
    this.writing = this.writing
      .then(() => replaceFile(this.contextFile, contents === "" ? "" : CONTEXT_FILE_BOM + contents))
      .catch((error) => {
        console.error("[meeseex] failed to write the context file:", error);
        // Nothing landed on disk, so the next write must not be skipped as unchanged.
        this.written = undefined;
      });
  }

  dispose(): void {
    clearTimeout(this.writeTimer);
    this.log.flush();
  }
}
