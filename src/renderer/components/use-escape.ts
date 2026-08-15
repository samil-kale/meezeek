import { useEffect } from "react";

/**
 * Closes whatever is over the window when Escape is pressed. Listened for in the capture phase
 * and swallowed, so closing it can't double as an ESC keystroke for the terminal that had focus
 * before it opened. On `document`, which is why a question (`Dialog.tsx`) listens on `window`
 * instead: it can be asked from one of these, and one keystroke must not answer both.
 */
export function useEscape(onClose: () => void): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [onClose]);
}
