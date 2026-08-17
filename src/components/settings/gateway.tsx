// Provider gateway — Settings block for the opencodex proxy.
//
// Two questions, deliberately kept apart because they fail apart: is the proxy
// *running* (a process Klide can start and stop), and is it *connected* (a
// self-hosted endpoint the model picker offers). A running proxy nobody
// registered is invisible to the harness; a registered endpoint with nothing
// behind it errors on the first turn.

import { useCallback, useEffect, useState } from "react";
import {
  readGatewayStatus,
  startGateway,
  stopGateway,
  type GatewayStatus,
} from "../../ipc/gateway";
import {
  GATEWAY_DASHBOARD_URL,
  GATEWAY_DEFAULT_MODEL,
  GATEWAY_PROVIDER_ID,
  connectGateway,
  disconnectGateway,
} from "../../gateway";
import { useCustomProviders } from "../../hooks/useCustomProviders";
import { errMessage } from "../../errors";
import { notify } from "../../toast";
import { CodeText, Panel, Row, StatusText } from "./controls";

/** Same affordance as LocalServerRow's toggle — one primary action per row. */
function ActionButton({
  label,
  busy,
  onClick,
  tone = "primary",
  disabled,
}: {
  label: string;
  busy: boolean;
  onClick: () => void;
  tone?: "primary" | "quiet";
  disabled?: boolean;
}) {
  const inert = busy || disabled;
  return (
    <button
      onClick={onClick}
      disabled={inert}
      style={{
        height: 28,
        padding: "0 12px",
        borderRadius: "var(--radius-sm)",
        border: "1px solid var(--border-strong)",
        background: tone === "primary" ? "var(--accent)" : "var(--bg-hover)",
        color: tone === "primary" ? "var(--control-primary-fg)" : "var(--fg-strong)",
        fontSize: 12,
        fontWeight: 600,
        cursor: inert ? "default" : "pointer",
        opacity: inert ? 0.6 : 1,
        transition: "opacity var(--motion-fast) var(--ease-out)",
      }}
    >
      {busy ? "…" : label}
    </button>
  );
}

export function GatewayBlock() {
  const [status, setStatus] = useState<GatewayStatus | null>(null);
  const [busy, setBusy] = useState<"process" | "connection" | null>(null);
  // The registered endpoint is read from the shared custom-provider store, so
  // adding it here immediately re-renders the model picker and every other
  // surface that names providers.
  const customProviders = useCustomProviders();
  const connected = customProviders.find((p) => p.id === GATEWAY_PROVIDER_ID);
  const [model, setModel] = useState(GATEWAY_DEFAULT_MODEL);

  useEffect(() => {
    if (connected?.defaultModel) setModel(connected.defaultModel);
  }, [connected?.defaultModel]);

  const refresh = useCallback(async () => {
    try {
      setStatus(await readGatewayStatus());
    } catch {
      setStatus(null);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 4000);
    return () => clearInterval(timer);
  }, [refresh]);

  async function toggleProcess() {
    if (busy) return;
    setBusy("process");
    try {
      const next = status?.running ? await stopGateway() : await startGateway();
      setStatus(next);
      // A start that came up but couldn't un-inject the Codex config is a
      // half-success — say so rather than showing a green "Running".
      if (next.warning) notify(next.warning, { tone: "warn" });
    } catch (e) {
      notify(errMessage(e), { tone: "error" });
      void refresh();
    } finally {
      setBusy(null);
    }
  }

  async function toggleConnection() {
    if (busy) return;
    setBusy("connection");
    try {
      if (connected) {
        await disconnectGateway();
        notify("opencodex removed from your providers");
      } else {
        await connectGateway(status?.baseUrl ?? "", model);
        notify("opencodex is now a provider — pick it in the model menu", {
          tone: "success",
        });
      }
    } catch (e) {
      notify(errMessage(e), { tone: "error" });
    } finally {
      setBusy(null);
    }
  }

  async function saveModel() {
    const next = model.trim();
    if (!connected || !next || next === connected.defaultModel) return;
    try {
      await connectGateway(connected.baseUrl, next);
    } catch (e) {
      notify(errMessage(e), { tone: "error" });
    }
  }

  const running = status?.running ?? false;
  const installed = status?.installed ?? false;

  return (
    <>
      <Panel>
        <Row
          title="opencodex proxy"
          description={status?.detail ?? "Checking…"}
          control={
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <StatusText tone={running ? "ok" : "idle"}>
                {running ? "Running" : "Stopped"}
              </StatusText>
              {installed ? (
                <ActionButton
                  label={running ? "Stop" : "Start"}
                  busy={busy === "process"}
                  tone={running ? "quiet" : "primary"}
                  onClick={() => void toggleProcess()}
                />
              ) : (
                <CodeText>npm install -g @bitkyc08/opencodex</CodeText>
              )}
            </div>
          }
        />
        <Row
          title="Use in Klide"
          description={
            connected
              ? `Registered as a self-hosted endpoint at ${connected.baseUrl} — it appears in the model menu everywhere, Focus included.`
              : "Register the proxy as a self-hosted endpoint so the harness can run it like any other provider."
          }
          control={
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <StatusText tone={connected ? "ok" : "idle"}>
                {connected ? "Connected" : "Not connected"}
              </StatusText>
              <ActionButton
                label={connected ? "Remove" : "Connect"}
                busy={busy === "connection"}
                tone={connected ? "quiet" : "primary"}
                disabled={!connected && !status}
                onClick={() => void toggleConnection()}
              />
            </div>
          }
        />
        {connected && (
          <Row
            title="Default model"
            description="opencodex routes on a provider/model pair — a bare model id falls through to its own default provider."
            control={
              <input
                value={model}
                onChange={(e) => setModel(e.target.value)}
                onBlur={() => void saveModel()}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void saveModel();
                }}
                aria-label="Gateway default model"
                placeholder={GATEWAY_DEFAULT_MODEL}
                className="klide-field"
                autoComplete="off"
                spellCheck={false}
                style={{ height: 30, padding: "0 10px", width: 260 }}
              />
            }
          />
        )}
        <Row
          title="Dashboard"
          description="Add upstream providers, sign in to accounts, and set routing rules in the proxy's own web dashboard."
          control={<CodeText>{GATEWAY_DASHBOARD_URL}</CodeText>}
        />
      </Panel>
      <Panel>
        <Row
          title="Codex CLI"
          description={
            status?.codexRouted
              ? "Codex is pointed at the gateway ($CODEX_HOME/config.toml), so the Codex delegate routes through it too. Run `ocx restore` to point it back at OpenAI."
              : "Untouched. Starting opencodex injects itself into the Codex config; Klide un-injects right after, so your Codex delegate keeps talking to OpenAI directly."
          }
          control={
            <StatusText tone={status?.codexRouted ? "warn" : "idle"}>
              {status?.codexRouted ? "Routed via gateway" : "Native"}
            </StatusText>
          }
        />
        <Row
          title="Subscription terms"
          description="Routing a ChatGPT or Claude subscription login through a third-party proxy can breach that provider's terms. API keys and self-hosted models are unaffected."
          control={<CodeText>Your call</CodeText>}
        />
      </Panel>
    </>
  );
}
