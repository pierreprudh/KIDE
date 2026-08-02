// ProfileModal — a centered, SkillsModal-style overlay that surfaces
// "you, the person using this IDE" with the smallest possible surface:
// avatar + username + hostname + whether a workspace is active. The identity
// stays local, but reuses the authenticated GitHub profile picture when one is
// available — no account controls, sign out, or parallel identity model.

import { useEffect } from "react";
import { Z } from "../zLayers";
import { initialsOf, useUserInfo } from "../hooks/useUserInfo";

type Props = {
  open: boolean;
  workspaceRoot: string | null;
  onClose: () => void;
};

/* ------------------------------------------------------------------ icons */

function CloseIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

/* ============================================================ the modal ===*/

export function ProfileModal({ open, workspaceRoot, onClose }: Props) {
  const { username: localUsername, hostname, avatarUrl } = useUserInfo();

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const username = localUsername || "you";
  const hasWorkspace = Boolean(workspaceRoot);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Profile"
      onClick={onClose}
      className="skills-tab-in"
      style={{
        position: "fixed", inset: 0, zIndex: Z.modal,
        display: "grid", placeItems: "center",
        background: "var(--modal-scrim)",
        backdropFilter: "blur(3px)",
      }}
    >
      <div
        className="floating-panel"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(420px, calc(100vw - 80px))",
          borderRadius: "var(--radius-lg)",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        {/* Centered hero — avatar + identity + workspace line. No
            sections, no lists, no actions. The point is to confirm
            "you, on this machine" with the smallest possible surface. */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 16,
            padding: "22px 24px 18px",
            position: "relative",
          }}
        >
          <Avatar name={username} avatarUrl={avatarUrl} size={48} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 17, fontWeight: 600, color: "var(--fg-strong)", letterSpacing: "-0.014em" }}>
              {username}
              {hostname && (
                <span style={{ color: "var(--fg-dim)", fontSize: 12, fontWeight: 400, marginLeft: 8, fontFamily: "var(--font-mono)" }}>
                  · {hostname}
                </span>
              )}
            </div>
            <div style={{ fontSize: 12, color: "var(--fg-subtle)", marginTop: 4, letterSpacing: "-0.005em" }}>
              {hasWorkspace
                ? <>Workspace open</>
                : <>No workspace open</>}
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="klide-button klide-button-ghost"
            style={{ minHeight: 28, padding: "0 8px", color: "var(--fg-subtle)" }}
            onMouseEnter={(e) => { e.currentTarget.style.color = "var(--fg-strong)"; e.currentTarget.style.background = "var(--bg-hover)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = "var(--fg-subtle)"; e.currentTarget.style.background = "transparent"; }}
          >
            <CloseIcon />
          </button>
        </div>

        <div
          style={{
            padding: "0 24px 16px",
            fontSize: 10.5,
            fontFamily: "var(--font-mono)",
            color: "var(--fg-dim)",
            letterSpacing: "0.04em",
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          <span>Klide · local</span>
          <span style={{ flex: 1 }} />
          <span>esc to close</span>
        </div>
      </div>
    </div>
  );
}

/* ============================================================ pieces ===*/

function Avatar({ name, avatarUrl, size }: { name: string; avatarUrl: string; size: number }) {
  const initials = initialsOf(name);
  // Deterministic hue from the name so the same user always gets the
  // same colour, but it's a quiet hue (saturated very low) so it
  // doesn't compete with the rest of the UI.
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return (
    <div
      aria-hidden
      style={{
        position: "relative",
        width: size,
        height: size,
        overflow: "hidden",
        borderRadius: "50%",
        flexShrink: 0,
        display: "grid",
        placeItems: "center",
        background: `linear-gradient(140deg, oklch(0.78 0.10 ${hue}), oklch(0.62 0.12 ${(hue + 40) % 360}))`,
        color: "var(--bg-elevated)",
        fontFamily: "var(--font-ui)",
        fontSize: size * 0.36,
        fontWeight: 600,
        letterSpacing: "-0.01em",
        boxShadow: "inset 0 1px 0 rgba(255,255,255,0.2)",
      }}
    >
      {initials}
      {avatarUrl ? (
        <img
          src={avatarUrl}
          alt=""
          onError={(event) => { event.currentTarget.style.display = "none"; }}
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            borderRadius: "inherit",
            objectFit: "cover",
          }}
        />
      ) : null}
    </div>
  );
}
