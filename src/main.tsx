import React from "react";
import ReactDOM from "react-dom/client";
// Bundle the design-system fonts locally (offline-first). The family names
// these register ("Atkinson Hyperlegible", "Monaspace Neon") match tokens.css.
import "@fontsource/atkinson-hyperlegible/400.css";
import "@fontsource/atkinson-hyperlegible/700.css";
import "@fontsource/monaspace-neon/400.css";
import "@fontsource/monaspace-neon/700.css";
// Point Monaco at the bundled package (offline, no CDN) before <App> mounts.
import "./monaco-setup";
import App from "./App";
import { healStoredConversationOrigins } from "./components/ai/conversationOriginHeal";

// Repair conversations whose Provider label an older build overwrote (a Claude
// Code thread showing as OpenRouter). Runs before the first surface reads the
// index — Mission Control re-derives its rows from it on the same boot.
try {
  healStoredConversationOrigins();
} catch {
  /* a broken conversation index must never block the app from starting */
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
