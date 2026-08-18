import { useEffect, useImperativeHandle, useRef } from "react";
import type { editor as MonacoEditor } from "monaco-editor";
import { languageForPath } from "../diff-highlight";
import { editorOptions, ensureLanguage, loadMonaco } from "../editor";

export interface CodeEditorHandle {
  /** The model's current text, BOM preserved — see `Repository.writeFile`. */
  getValue(): string;
  /** Marks the current text as the saved baseline: dirty goes false until it changes again. */
  markSaved(): void;
  /** Replaces the model's text in place (kept on the undo stack) and marks it saved. */
  setContent(text: string): void;
}

interface CodeEditorProps {
  path: string;
  content: string;
  onDirty: (dirty: boolean) => void;
  onSave: () => void;
  onBusy: (busy: boolean) => void;
  ref?: React.Ref<CodeEditorHandle>;
}

/**
 * The dialog's Edit mode: one editor and one model for this component's whole lifetime.
 * `DiffDialog` only ever mounts it once it already has the right file's content in hand (its own
 * `file.path === path` guard) and unmounts it the moment another file is chosen, so `path` and
 * `content` are read once, at mount, and nothing here ever needs to swap a model under the user —
 * a look-and-fix dialog, not a multi-file editing session (see CLAUDE.md).
 */
export function CodeEditor({ path, content, onDirty, onSave, onBusy, ref }: CodeEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null);
  const savedVersionId = useRef(0);
  const onDirtyRef = useRef(onDirty);
  onDirtyRef.current = onDirty;
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;

  useImperativeHandle(ref, () => ({
    getValue: () => editorRef.current?.getModel()?.getValue(undefined, true) ?? "",
    markSaved: () => {
      const model = editorRef.current?.getModel();
      if (model) {
        savedVersionId.current = model.getAlternativeVersionId();
        onDirtyRef.current(false);
      }
    },
    setContent: (text) => {
      const model = editorRef.current?.getModel();
      if (!model) {
        return;
      }
      model.pushEditOperations([], [{ range: model.getFullModelRange(), text }], () => null);
      savedVersionId.current = model.getAlternativeVersionId();
      onDirtyRef.current(false);
    }
  }));

  useEffect(() => {
    let cancelled = false;
    onBusy(true);
    void (async () => {
      const monaco = await loadMonaco();
      // Only a grammar diff-highlight.ts bundles gets shiki's colors — same rule the diff view
      // itself follows; anything else reads as monaco's built-in, uncolored "plaintext".
      const language = languageForPath(path);
      if (language) {
        await ensureLanguage(monaco, language);
      }
      if (cancelled || !hostRef.current) {
        return;
      }
      const model = monaco.editor.createModel(content, language ?? "plaintext", monaco.Uri.parse(`tet:/${path}`));
      savedVersionId.current = model.getAlternativeVersionId();
      model.onDidChangeContent(() => {
        onDirtyRef.current(model.getAlternativeVersionId() !== savedVersionId.current);
      });
      const fontFamily = getComputedStyle(document.documentElement).getPropertyValue("--vscode-editor-font-family").trim();
      editorRef.current = monaco.editor.create(hostRef.current, { ...editorOptions(fontFamily), model });
      editorRef.current.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => onSaveRef.current());
      editorRef.current.focus();
      onBusy(false);
    })();
    return () => {
      cancelled = true;
      const model = editorRef.current?.getModel();
      editorRef.current?.dispose();
      model?.dispose();
      editorRef.current = null;
    };
    // Mount-once, deliberately: `path` and `content` are this instance's fixed starting point,
    // never a later value to re-sync to — see the doc comment above for why that always holds.
  }, []);

  return <div className="editor-host" ref={hostRef} />;
}
