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
import {
  healStoredConversationOrigins,
  healStoredConversationsFromTranscripts,
} from "./components/ai/conversationOriginHeal";
import { fetchRunOrigins } from "./runs";

// Repair conversations whose Provider label an older build overwrote (a Claude
// Code thread showing as OpenRouter). Runs before the first surface reads the
// index — Mission Control re-derives its rows from it on the same boot.
try {
  healStoredConversationOrigins();
} catch {
  /* a broken conversation index must never block the app from starting */
}

// The same repair against the stronger evidence: what each Run's Transcript
// says it was dispatched with. This one needs the backend, so it lands just
// after the first render and republishes the index for the surfaces already
// showing it. Deliberately not awaited — the app must start whether or not the
// runs directory can be read.
void healStoredConversationsFromTranscripts(fetchRunOrigins).catch(() => {
  /* no transcripts readable (or not running under Tauri) — labels stand */
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
