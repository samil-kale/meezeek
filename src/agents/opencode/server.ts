import { spawn, type ChildProcess } from "node:child_process";
import * as crypto from "node:crypto";
import { countActivity } from "../../main/event-loop-monitor";
import { resolveCommand } from "../../main/pty";
import type { AgentPaths, SpawnPreparation } from "../agent";
import { NOTIFICATIONS } from "../notifications";
import { installContextPlugin } from "./context-plugin";
import { createOpencodeNotifier } from "./notify";

const SERVER_START_TIMEOUT_MS = 15_000;
const EVENT_RETRY_MS = 2000;

/**
 * opencode is a client/server program: `opencode serve` is the instance that owns the
 * SQLite database, and the TUI is one of its clients (`opencode attach <url>`). Meezeek
 * runs that server itself and points everything at it — the session listing, renames, the
 * event stream, and the terminal's own TUI.
 *
 * Talking to opencode any other way means running a second, unrelated instance that only
 * shares the database file. Measured costs of that: every `session list` boots an instance
 * (~1.2s, versus ~12ms over HTTP), a read writes to the database, and events never cross
 * the process boundary — a change made in the terminal's TUI stays invisible to us.
 */
export class OpencodeServer {
  private eventsAborted: AbortController | undefined;
  private readonly subscribers = new Set<(type: string) => void>();
  private readonly child: ChildProcess;
  readonly url: string;
  readonly password: string;
  private readonly authorization: string;

  private constructor(child: ChildProcess, url: string, password: string) {
    this.child = child;
    this.url = url;
    this.password = password;
    this.authorization = "Basic " + Buffer.from(`opencode:${password}`).toString("base64");
  }

  static async start(executable: string, cwd: string, env?: Record<string, string>): Promise<OpencodeServer> {
    // Without a password opencode serves every local process unauthenticated — it says so
    // on startup. The secret is generated per server and never leaves this process and the
    // ones we hand it to, so the port is only useful to us.
    const password = crypto.randomBytes(24).toString("base64url");
    const { command, args } = resolveCommand(executable, ["serve", "--port", "0", "--hostname", "127.0.0.1"]);
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      // Same precedence as spawnAgentProcess: what the caller passes are defaults a
      // variable the user already has set still wins over — we must not silently replace
      // their own OPENCODE_CONFIG_DIR. The password is ours alone and does win.
      env: { ...env, ...process.env, OPENCODE_SERVER_PASSWORD: password }
    });
    try {
      return new OpencodeServer(child, await waitForServerUrl(child), password);
    } catch (error) {
      killTree(child);
      throw error;
    }
  }

  get running(): boolean {
    return this.child.exitCode === null && !this.child.killed;
  }

  /**
   * Every endpoint we use is scoped by `directory`, so it's added here rather than at each
   * call site. Paths carry no query string of their own.
   */
  async request(path: string, cwd: string, init?: RequestInit): Promise<Response> {
    const url = `${this.url}${path}?directory=${encodeURIComponent(cwd)}`;
    const response = await fetch(url, {
      ...init,
      headers: { ...init?.headers, Authorization: this.authorization }
    });
    if (!response.ok) {
      throw new Error(`opencode ${init?.method ?? "GET"} ${path} failed: ${response.status} ${await response.text()}`);
    }
    return response;
  }

  /**
   * Reports each event's type until dispose(), reconnecting if the stream drops. One
   * stream serves every subscriber — opencode delivers the same events to each connection,
   * so a second one would only cost another server-side subscriber for the same payload.
   */
  subscribe(cwd: string, onEvent: (type: string) => void): () => void {
    this.subscribers.add(onEvent);
    if (!this.eventsAborted) {
      this.eventsAborted = new AbortController();
      void this.streamEvents(cwd, this.eventsAborted);
    }
    return () => this.subscribers.delete(onEvent);
  }

  private async streamEvents(cwd: string, controller: AbortController): Promise<void> {
    while (!controller.signal.aborted && this.running) {
      try {
        const response = await this.request("/event", cwd, { signal: controller.signal });
        const reader = response.body?.getReader();
        if (!reader) {
          return;
        }
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          buffer += decoder.decode(value, { stream: true });
          // Server-sent events are separated by a blank line; only the "data:" line of
          // each carries the payload.
          let boundary: number;
          while ((boundary = buffer.indexOf("\n\n")) >= 0) {
            const frame = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            countActivity("sse");
            const data = frame.split("\n").find((line) => line.startsWith("data: "));
            const type = data === undefined ? undefined : eventType(data.slice("data: ".length));
            if (type !== undefined) {
              for (const subscriber of this.subscribers) {
                subscriber(type);
              }
            }
          }
        }
      } catch {
        // Stream dropped (server restart, transient error) — retried below. An abort
        // leaves the loop through its own condition instead.
      }
      if (controller.signal.aborted) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, EVENT_RETRY_MS));
    }
  }

  dispose(): void {
    this.eventsAborted?.abort();
    killTree(this.child);
  }
}

interface ServerEntry {
  executable: string;
  server: Promise<OpencodeServer>;
}

/** One server per repository — meezeek can have several projects open at once. */
const servers = new Map<string, ServerEntry>();

/** A start that never succeeded has nothing to dispose, hence the swallowed rejection. */
function disposeQuietly(entry: ServerEntry | undefined): void {
  entry?.server.then((server) => server.dispose()).catch(() => undefined);
}

export async function ensureServer(
  executable: string,
  cwd: string,
  env?: Record<string, string>
): Promise<OpencodeServer> {
  const existing = servers.get(cwd);
  if (existing?.executable === executable) {
    try {
      const server = await existing.server;
      if (server.running) {
        return server;
      }
    } catch {
      // Previous start failed — fall through and try again below.
    }
  }
  disposeQuietly(existing);
  const started = OpencodeServer.start(executable, cwd, env);
  servers.set(cwd, { executable, server: started });
  return started;
}

/**
 * The server this repository is already running on, if any — never starts one. For callers
 * that are only along for the ride (a url lookup triggered by a hover), where starting a
 * second instance would be the very thing this module exists to avoid.
 */
export async function runningServer(executable: string, cwd: string): Promise<OpencodeServer | undefined> {
  const existing = servers.get(cwd);
  if (existing?.executable !== executable) {
    return undefined;
  }
  try {
    const server = await existing.server;
    return server.running ? server : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Brings the server up before any terminal is spawned and hands the TUI the arguments to
 * attach to it, so the terminal's session and everything else meezeek does run in the same
 * opencode instance rather than two that only share a database.
 */
export async function prepareOpencodeSpawn(
  executable: string,
  cwd: string,
  paths: AgentPaths
): Promise<SpawnPreparation> {
  // On the server, not on the terminal: under `attach` the TUI is only a client, and the
  // server is what composes messages and therefore what loads the plugin.
  const server = await ensureServer(executable, cwd, installContextPlugin(paths.storageRoot, cwd, paths.contextFile));
  // Subscribing here rather than in the notifier keeps the stream's lifetime tied to the
  // server's: it is torn down in the same dispose that stops the server.
  const unsubscribe = server.subscribe(
    cwd,
    createOpencodeNotifier(paths.agentDir, cwd, "OpenCode", NOTIFICATIONS)
  );
  return {
    args: ["attach", server.url, "--dir", cwd],
    // A whole process per repository, started for the session listing alone — not worth
    // keeping up for a project whose opencode is never used.
    releaseWhenIdle: true,
    // attach reads the password from the environment; passing it as --password would put
    // the secret in the process command line, where any local process can read it.
    env: { OPENCODE_SERVER_PASSWORD: server.password },
    dispose: () => {
      unsubscribe();
      const previous = servers.get(cwd);
      servers.delete(cwd);
      disposeQuietly(previous);
    }
  };
}

function eventType(payload: string): string | undefined {
  try {
    const event = JSON.parse(payload) as { type?: unknown };
    return typeof event.type === "string" ? event.type : undefined;
  } catch {
    return undefined;
  }
}

/** The tail of what the server said, for a failure that otherwise names no cause at all. */
function said(output: string): string {
  const text = output.trim().split("\n").slice(-3).join(" / ").slice(0, 300);
  return text ? ` — it said: ${text}` : " and said nothing";
}

/**
 * Resolves once `opencode serve` reports the URL it's listening on. **Both** streams are read:
 * the url only ever comes on stdout, but a server that dies instead says why on stderr, and
 * without that the failure reaches the user as "it did not start" and nothing else.
 */
function waitForServerUrl(server: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`opencode serve timed out waiting for its listening URL${said(buffer)}`));
    }, SERVER_START_TIMEOUT_MS);
    const onData = (data: Buffer) => {
      buffer += data.toString();
      const match = /listening on (http:\/\/\S+)/.exec(buffer);
      if (match) {
        cleanup();
        resolve(match[1]);
      }
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      const how = code === null ? `on ${signal}` : `with code ${code}`;
      reject(new Error(`opencode serve exited ${how} before reporting a listening URL${said(buffer)}`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      server.stdout?.off("data", onData);
      server.stderr?.off("data", onData);
      server.off("error", onError);
      server.off("exit", onExit);
    };
    server.stdout?.on("data", onData);
    server.stderr?.on("data", onData);
    server.on("error", onError);
    server.on("exit", onExit);
  });
}

/**
 * On win32 resolveCommand routes a shim install (`opencode.cmd`) through cmd.exe, and
 * kill() would only take down that wrapper — verified: the server keeps running, and once
 * its parent is gone it can no longer be reached through the process tree either. So kill
 * the tree instead of the process, while the tree still exists.
 */
function killTree(child: ChildProcess): void {
  if (process.platform === "win32" && child.pid !== undefined) {
    spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
    return;
  }
  child.kill();
}
