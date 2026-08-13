import { createRoot } from "react-dom/client";
import "./vscode-theme.css";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";
import { App } from "./App";

const container = document.getElementById("root");
if (!container) {
  throw new Error("Root container not found");
}

createRoot(container).render(<App />);
