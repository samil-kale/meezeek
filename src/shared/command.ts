/**
 * A saved command as the program and the arguments it is started with. Deliberately not a
 * shell: quotes group a word and are dropped, and everything else is literal — a backslash
 * included, because a Windows path is full of them and `meeseek.json` is read on every
 * platform. So the way to put a space in an argument is to quote it, and there is no way to
 * smuggle a pipe, a redirection or a variable in. A command that really needs one says
 * `"shell": true`.
 *
 * Shared rather than owned by the main process: the dialog that saves a command reads its
 * environment field the same way, and two spellings of "what counts as one word" would drift.
 */
export function splitCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  // Told apart from `current === ""` so that an empty quoted argument survives as one.
  let started = false;
  let quote: string | undefined;

  for (const char of command) {
    if (quote !== undefined) {
      if (char === quote) {
        quote = undefined;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started) {
        tokens.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    current += char;
    started = true;
  }
  // A quote nobody closed takes the rest of the line with it, which is what the user typed.
  if (started) {
    tokens.push(current);
  }
  return tokens;
}

/**
 * `NAME=value NAME2="a b"` as an environment, for the one field a dialog has room for. A word
 * without an `=` names nothing and is dropped; the first `=` separates, so a value may hold
 * more of them.
 */
export function parseEnv(text: string): Record<string, string> | undefined {
  const env: Record<string, string> = {};
  for (const token of splitCommand(text)) {
    const separator = token.indexOf("=");
    if (separator > 0) {
      env[token.slice(0, separator)] = token.slice(separator + 1);
    }
  }
  return Object.keys(env).length > 0 ? env : undefined;
}
