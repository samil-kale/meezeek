import { createHighlighterCore, type HighlighterCore, type LanguageRegistration, type ThemedToken } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import type { DiffLine, FileDiff } from "../shared/types";

/**
 * Syntax colors for the diff, through Shiki — the same TextMate grammars and the same theme
 * VS Code itself uses, so a file reads here the way it reads in an editor.
 *
 * This is the one place colors do not come from a --vscode-* variable: a theme assigns them
 * per grammar scope, of which there are hundreds, and Shiki hands them back per token. The
 * theme below is the token half of the "Dark Modern" the rest of the UI is styled after.
 */
const THEME = "dark-plus";

/**
 * The grammars meeseex bundles. The renderer is one file with no code splitting, so a
 * language is in the bundle whether it is used or not — hence a list of what an agent's
 * repository plausibly holds rather than all two hundred Shiki ships. Anything missing is
 * shown uncolored, which is what the diff looked like before.
 *
 * Each is imported lazily: esbuild keeps a dynamic import in its own module and only
 * evaluates it when awaited, so an unopened language costs parse time, not startup.
 */
const GRAMMARS: Record<string, () => Promise<{ default: LanguageRegistration[] }>> = {
  c: () => import("@shikijs/langs/c"),
  cpp: () => import("@shikijs/langs/cpp"),
  csharp: () => import("@shikijs/langs/csharp"),
  css: () => import("@shikijs/langs/css"),
  go: () => import("@shikijs/langs/go"),
  html: () => import("@shikijs/langs/html"),
  ini: () => import("@shikijs/langs/ini"),
  java: () => import("@shikijs/langs/java"),
  javascript: () => import("@shikijs/langs/javascript"),
  json: () => import("@shikijs/langs/json"),
  jsx: () => import("@shikijs/langs/jsx"),
  markdown: () => import("@shikijs/langs/markdown"),
  powershell: () => import("@shikijs/langs/powershell"),
  python: () => import("@shikijs/langs/python"),
  rust: () => import("@shikijs/langs/rust"),
  shellscript: () => import("@shikijs/langs/shellscript"),
  sql: () => import("@shikijs/langs/sql"),
  toml: () => import("@shikijs/langs/toml"),
  tsx: () => import("@shikijs/langs/tsx"),
  typescript: () => import("@shikijs/langs/typescript"),
  xml: () => import("@shikijs/langs/xml"),
  yaml: () => import("@shikijs/langs/yaml")
};

/** File extension, lowercased, to the grammar that colors it. */
const EXTENSIONS: Record<string, string> = {
  bash: "shellscript",
  c: "c",
  cc: "cpp",
  cfg: "ini",
  cjs: "javascript",
  cpp: "cpp",
  cs: "csharp",
  css: "css",
  cts: "typescript",
  cxx: "cpp",
  go: "go",
  h: "c",
  hpp: "cpp",
  htm: "html",
  html: "html",
  ini: "ini",
  java: "java",
  js: "javascript",
  json: "json",
  jsonc: "json",
  jsx: "jsx",
  md: "markdown",
  mjs: "javascript",
  mts: "typescript",
  ps1: "powershell",
  psm1: "powershell",
  py: "python",
  rs: "rust",
  sh: "shellscript",
  sql: "sql",
  toml: "toml",
  ts: "typescript",
  tsx: "tsx",
  xml: "xml",
  yaml: "yaml",
  yml: "yaml",
  zsh: "shellscript"
};

let core: Promise<HighlighterCore> | undefined;
/** One load per grammar, kept as the promise so two files of a kind don't race it. */
const grammars = new Map<string, Promise<void>>();

function highlighter(): Promise<HighlighterCore> {
  core ??= createHighlighterCore({
    // Spelled out rather than built from THEME: esbuild can only bundle an import whose
    // path it can read off the call.
    themes: [import("@shikijs/themes/dark-plus")],
    langs: [],
    // The JavaScript engine rather than the oniguruma one: that would pull in a wasm binary,
    // which a single-file bundle can only carry base64-encoded. "forgiving" skips the few
    // patterns it cannot express instead of refusing the whole grammar.
    engine: createJavaScriptRegexEngine({ forgiving: true })
  });
  return core;
}

function loadGrammar(shiki: HighlighterCore, language: string): Promise<void> {
  let pending = grammars.get(language);
  if (!pending) {
    pending = shiki.loadLanguage(GRAMMARS[language]());
    grammars.set(language, pending);
  }
  return pending;
}

/** A run of lines that were contiguous in one version of the file, and their code. */
interface Block {
  /** Index in the diff's line list for each line of `code`, in order. */
  indices: number[];
  code: string;
}

/**
 * A diff is not a file: it holds fragments of two versions of one, interleaved. Handing that
 * to a grammar as written would have it read the old and the new half of every changed line
 * as consecutive code, which goes wrong wherever a construct spans lines — a string, a block
 * comment, a template literal.
 *
 * So each hunk is tokenized twice: once as the file was, once as it is. Context lines are in
 * both passes and end up with the colors of the second, which for unchanged text is the same
 * answer anyway.
 */
function blocksOf(lines: readonly DiffLine[]): Block[] {
  const blocks: Block[] = [];
  let old: Block = { indices: [], code: "" };
  let fresh: Block = { indices: [], code: "" };

  const flush = (): void => {
    blocks.push(old, fresh);
    old = { indices: [], code: "" };
    fresh = { indices: [], code: "" };
  };
  const push = (block: Block, index: number, text: string): void => {
    block.code += block.indices.length === 0 ? text : `\n${text}`;
    block.indices.push(index);
  };

  lines.forEach((line, index) => {
    if (line.type === "hunk") {
      // The lines around a hunk header are not adjacent in the file, so nothing carries over.
      flush();
      return;
    }
    if (line.type !== "add") {
      push(old, index, line.text);
    }
    if (line.type !== "del") {
      push(fresh, index, line.text);
    }
  });
  flush();

  return blocks.filter((block) => block.indices.length > 0);
}

/**
 * Colors a diff, one token list per line of it. Lines the grammar had nothing to say about —
 * hunk headers, and everything in a language that isn't bundled — stay undefined and are
 * rendered as plain text.
 *
 * Resolves to undefined when nothing could be colored at all, so the caller can keep what it
 * already has on screen rather than repaint it.
 */
export async function highlightDiff(diff: FileDiff): Promise<(ThemedToken[] | undefined)[] | undefined> {
  const name = diff.path.slice(diff.path.lastIndexOf("/") + 1).toLowerCase();
  const language = EXTENSIONS[name.slice(name.lastIndexOf(".") + 1)];
  if (!language) {
    return undefined;
  }

  try {
    const shiki = await highlighter();
    await loadGrammar(shiki, language);
    const colored: (ThemedToken[] | undefined)[] = [];
    for (const block of blocksOf(diff.lines)) {
      const { tokens } = shiki.codeToTokens(block.code, { lang: language, theme: THEME });
      // One array per line of the block — but only if the tokenizer split it the way it was
      // joined, so a mismatch leaves those lines plain instead of coloring them out of step.
      if (tokens.length === block.indices.length) {
        block.indices.forEach((index, line) => (colored[index] = tokens[line]));
      }
    }
    return colored;
  } catch (error) {
    console.error("[meeseex] could not highlight the diff:", error);
    return undefined;
  }
}
