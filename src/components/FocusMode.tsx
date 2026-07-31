// FocusMode — Klide's chat-first workspace, blending the project/thread
// command-centre pattern with an artifact-first agent home. A quiet left rail
// groups conversations by project; the main canvas pairs a centered start /
// resume stage with a persistent bottom composer. A live conversation reuses
// the fully-wired AiPanel in its fullscreen "focus" design variant — centered
// reading column, roomier type — passed in via `renderChat`.
//
// Identity rules honoured here: bone surfaces, hairline borders, sage accent
// only, no chips/pills/status dots. Motion is choreography, not decoration:
// the rail settles from its hairline, hero elements and task cards arrive in
// short beats, the composer springs up once, and home ⇄ chat crossfades as one
// surface. All of it collapses under prefers-reduced-motion.

import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { listProviderModels } from "../ipc/aiProviders";
import { Z } from "../zLayers";
import {
  CONVERSATIONS_CHANGED_EVENT,
  loadConversations,
  relativeTime,
  isSubsequence,
  type ConversationChangedDetail,
} from "./ai/utils";
import type { Conversation } from "./ai/types";
import type { ProviderId } from "../agent/types";
import { PROVIDER_GROUPS, DEFAULT_MODELS, isDelegateProvider, providerName } from "../agent/providers";
import { ModelPicker } from "./ai/ModelPicker";
import { ProviderLogo } from "./ai/icons";
import { renderMessageBody } from "./ai/ChatMessage";
import { modelIdentity } from "../modelIdentity";
import { providerHistoryExpanded } from "../focusHistory";
import {
  linkedFolderLabel,
  linkedProjectForPath,
  normalizeProjectPath,
} from "../projectPaths";

type Props = {
  workspaceRoot: string | null;
  branch: string | null;
  /** Recent project roots (the same list the activity-bar popover shows). */
  projects: string[];
  chatActive: boolean;
  onSwitchProject: (root: string) => void;
  /** Back to the hero home — the next submit starts a fresh conversation. */
  onNewChat: () => void;
  onOpenConversation: (convo: Conversation) => void;
  onSubmit: (text: string) => void;
  onOpenMissionControl: () => void;
  /** The rail's shared destinations — the same handler the free-mode activity
   *  bar calls, so Focus opens the identical Git view / Memory / Skills /
   *  Settings / Profile surfaces instead of parallel ones. */
  onOpenPanel: (panel: "git" | "memory" | "skills" | "settings" | "profile" | "orchestrator") => void;
  /** Leave Focus for the Free (floating-panel) layout. Focus has no status
   *  bar, so this rail icon is the only way out. */
  onExitFocus: () => void;
  renderChat: () => ReactNode;
  /** Race watch — one tab per racing agent over the chat canvas. Empty or
   *  absent means the normal single-conversation chat. The parent keeps every
   *  tab's panel mounted; this component only draws the strip. */
  raceTabs?: { panelId: string; label: string }[];
  activeRaceTab?: string | null;
  onSelectRaceTab?: (panelId: string) => void;
  /** "Ask both" — send one follow-up into every racer's conversation. */
  onRaceFollowUp?: (text: string) => void;
  /** Leave the race view — close the racers' panels and go back home. */
  onCloseRaceTabs?: () => void;
  /** Composer run settings — the same per-panel / per-model state the AI
   *  panel and Settings read (provider → model → effort → context). */
  provider: ProviderId;
  onProviderChange: (provider: ProviderId) => void;
  model: string;
  onModelChange: (model: string) => void;
  effort: string | undefined;
  onEffortChange: (effort: string | undefined) => void;
  contextWindow: number | undefined;
  onContextWindowChange: (window: number | undefined) => void;
};

function basename(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

function initialsOf(name: string): string {
  const parts = name.replace(/[^a-zA-Z0-9]+/g, " ").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/* ------------------------------------------------------------------ icons */

const iconProps = {
  width: 15,
  height: 15,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.7,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
} as const;

function NewChatIcon() {
  return (
    <svg {...iconProps}>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg {...iconProps}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  );
}

/** The layout picker's Free-layout mark, minus its connector line — two offset
 *  panels read clearly at 14px where the extra stroke was just noise. */
function FreeLayoutIcon() {
  return (
    <svg {...iconProps} width={14} height={14} strokeWidth={1.5}>
      <rect x="3.5" y="3.5" width="8.5" height="8.5" rx="1.4" />
      <rect x="12" y="12" width="8.5" height="8.5" rx="1.4" />
    </svg>
  );
}

function BoardIcon() {
  return (
    <svg {...iconProps}>
      <circle cx="12" cy="12" r="7.5" opacity="0.5" />
      <circle cx="12" cy="12" r="2" fill="currentColor" stroke="none" />
      <circle cx="19.5" cy="12" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="7" cy="5" r="1.5" fill="currentColor" stroke="none" />
    </svg>
  );
}

/* The destinations Focus shares with the free-mode rail keep that rail's
   glyphs, so the same thing never has two marks in one app. */

function OrchestratorIcon() {
  return (
    <svg {...iconProps} strokeWidth={1.5}>
      <path d="M4 6.5h4.5" />
      <path d="M15.5 6.5H20" />
      <circle cx="12" cy="6.5" r="2.4" />
      <path d="M4 17.5h4.5" />
      <path d="M15.5 17.5H20" />
      <circle cx="12" cy="17.5" r="2.4" />
      <path d="M12 8.9v6.2" />
    </svg>
  );
}

function GitIcon() {
  return (
    <svg {...iconProps} strokeWidth={1.5}>
      <circle cx="6" cy="5" r="2.4" />
      <circle cx="6" cy="19" r="2.4" />
      <circle cx="18" cy="12" r="2.4" />
      <path d="M6 7.4v9.2" />
      <path d="M8.1 6.2A8.2 8.2 0 0 1 15.7 10" />
    </svg>
  );
}

function MemoryIcon() {
  return (
    <svg {...iconProps} strokeWidth={1.5}>
      <path d="M5 3.5h11.5a1 1 0 0 1 1 1V20l-3-1.5L11.5 20l-3-1.5L5 20V3.5z" />
      <path d="M8 8h6" />
      <path d="M8 12h6" />
      <path d="M8 16h4" />
    </svg>
  );
}

function SkillsIcon() {
  return (
    <svg {...iconProps} strokeWidth={1.5}>
      <path d="M15 4l1.1 3L19 8l-2.9 1L15 12l-1.1-3L11 8l2.9-1L15 4z" />
      <path d="M6.5 12l.8 2.2L9.5 15l-2.2.8L6.5 18l-.8-2.2L3.5 15l2.2-.8L6.5 12z" />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg {...iconProps} strokeWidth={1.5}>
      <path d="M4 6h10" />
      <path d="M18 6h2" />
      <path d="M16 4v4" />
      <path d="M4 12h3" />
      <path d="M11 12h9" />
      <path d="M9 10v4" />
      <path d="M4 18h11" />
      <path d="M19 18h1" />
      <path d="M17 16v4" />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg {...iconProps} width={14} height={14}>
      <path d="M3.5 6.5a2 2 0 0 1 2-2h4l2 2.5h7a2 2 0 0 1 2 2v8.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />
    </svg>
  );
}

function SendIcon() {
  return (
    <svg {...iconProps} width={14} height={14} strokeWidth={2}>
      <path d="M12 19V5" />
      <path d="m5 12 7-7 7 7" />
    </svg>
  );
}

function BranchIcon() {
  return (
    <svg {...iconProps} width={13} height={13}>
      <circle cx="6" cy="5" r="2" />
      <circle cx="18" cy="6" r="2" />
      <circle cx="6" cy="19" r="2" />
      <path d="M6 7v10" />
      <path d="M8 7c5 0 3 8 8 8h2" />
    </svg>
  );
}

function LocalIcon() {
  return (
    <svg {...iconProps} width={13} height={13}>
      <rect x="3" y="4" width="18" height="13" rx="2" />
      <path d="M8 21h8" />
      <path d="M12 17v4" />
    </svg>
  );
}

function TreeBranch() {
  return (
    <span className="klide-focus-tree-branch" aria-hidden="true">
      <svg
        width="16"
        height="16"
        viewBox="0 0 16 16"
        fill="none"
        shapeRendering="geometricPrecision"
      >
        <path
          d="M.5.5v5c0 5 4 9 9 9h6"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
    </span>
  );
}

/* ---------------------------------------------------------------- sidebar */

// One shared rail row for navigation and workspace disclosure. Hover/focus
// styling lives in CSS so pointer movement does not trigger React renders.
function NavRow({
  icon,
  label,
  onClick,
  active = false,
  expanded,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  active?: boolean;
  /** When defined, the row is a disclosure — a small chevron turns with it. */
  expanded?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      aria-expanded={expanded}
      className="klide-focus-nav-row"
      data-active={active || undefined}
    >
      <span style={{ width: 16, height: 16, display: "grid", placeItems: "center", flexShrink: 0 }}>
        {icon}
      </span>
      <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {label}
      </span>
      {expanded !== undefined && (
        <svg
          width="9"
          height="9"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
          style={{
            flexShrink: 0,
            opacity: 0.55,
            transform: expanded ? "rotate(90deg)" : "none",
            transition: "transform var(--motion-med) var(--ease-out)",
          }}
        >
          <path d="m9 6 6 6-6 6" />
        </svg>
      )}
    </button>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <h2 className="klide-focus-section-label">
      {children}
    </h2>
  );
}

function ConvoRow({
  convo,
  onOpen,
  indent = false,
  selected = false,
}: {
  convo: Conversation;
  onOpen: () => void;
  indent?: boolean;
  selected?: boolean;
}) {
  const identity = modelIdentity(convo.model);
  const ModelLogo = identity?.Logo;

  return (
    <button
      type="button"
      onClick={onOpen}
      title={convo.title}
      className="klide-focus-convo-row"
      data-selected={selected || undefined}
      aria-current={selected ? "page" : undefined}
      style={{ paddingLeft: indent ? 38 : 10 }}
    >
      {indent ? <TreeBranch /> : null}
      {ModelLogo ? (
        <span
          className="klide-focus-convo-model"
          title={identity.name}
          aria-hidden="true"
        >
          <ModelLogo size={15} />
        </span>
      ) : null}
      <span
        style={{
          flex: 1,
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          lineHeight: "27px",
        }}
      >
        {convo.title || "Untitled"}
      </span>
      <span className="klide-focus-convo-time">
        {relativeTime(convo.updatedAt)}
      </span>
    </button>
  );
}

type ProviderHistory = {
  provider: ProviderId;
  conversations: Conversation[];
  updatedAt: number;
};

function groupHistoryByProvider(conversations: Conversation[]): ProviderHistory[] {
  const groups = new Map<ProviderId, Conversation[]>();

  for (const conversation of conversations) {
    const conversationProvider = conversation.provider ?? "ollama";
    const existing = groups.get(conversationProvider);
    if (existing) existing.push(conversation);
    else groups.set(conversationProvider, [conversation]);
  }

  return Array.from(groups, ([groupProvider, groupedConversations]) => {
    groupedConversations.sort((a, b) => b.updatedAt - a.updatedAt);
    return {
      provider: groupProvider,
      conversations: groupedConversations,
      updatedAt: groupedConversations[0]?.updatedAt ?? 0,
    };
  }).sort((a, b) => b.updatedAt - a.updatedAt);
}

function providerHistoryKey(project: string, historyProvider: ProviderId): string {
  return `${project}\u0000${historyProvider}`;
}

function ProviderHistoryGroup({
  group,
  expanded,
  selectedConversationId,
  onToggle,
  onOpen,
}: {
  group: ProviderHistory;
  expanded: boolean;
  selectedConversationId?: string;
  onToggle: () => void;
  onOpen: (conversation: Conversation) => void;
}) {
  const readOnly = isDelegateProvider(group.provider);
  const containsSelectedConversation = selectedConversationId !== undefined &&
    group.conversations.some((conversation) => conversation.id === selectedConversationId);
  const countLabel = `${group.conversations.length} ${group.conversations.length === 1 ? "conversation" : "conversations"}`;

  return (
    <div
      className="klide-focus-provider-history"
      data-readonly={readOnly || undefined}
      data-contains-selected={containsSelectedConversation || undefined}
    >
      <button
        type="button"
        className="klide-focus-provider-history-row"
        onClick={onToggle}
        aria-expanded={expanded}
        title={`${providerName(group.provider)} · ${countLabel}${readOnly ? " · Read only" : ""}`}
      >
        <TreeBranch />
        <span className="klide-focus-provider-history-logo" aria-hidden="true">
          <ProviderLogo id={group.provider} size={16} />
        </span>
        <span className="klide-focus-provider-history-name">
          {providerName(group.provider)}
        </span>
        {readOnly ? (
          <span className="klide-focus-provider-history-readonly">Read only</span>
        ) : null}
        <span
          className="klide-focus-provider-history-count"
          aria-label={countLabel}
        >
          {group.conversations.length}
        </span>
        <span className="klide-focus-provider-history-chevron" aria-hidden="true">
          <svg
            width="9"
            height="9"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="m9 6 6 6-6 6" />
          </svg>
        </span>
      </button>

      {expanded ? (
        <div className="klide-focus-convo-tree klide-focus-provider-conversations">
          {group.conversations.map((conversation) => (
            <ConvoRow
              key={conversation.id}
              convo={conversation}
              indent
              selected={selectedConversationId === conversation.id}
              onOpen={() => onOpen(conversation)}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function HistoryReader({
  conversation,
  projectRoot,
  onClose,
  onContinue,
}: {
  conversation: Conversation;
  projectRoot?: string | null;
  onClose: () => void;
  onContinue: () => void;
}) {
  const provider = conversation.provider ?? "ollama";
  const delegate = isDelegateProvider(provider);
  const project = projectRoot
    ? basename(projectRoot)
    : conversation.cwd ? basename(conversation.cwd) : null;
  const folder = linkedFolderLabel(conversation.cwd, projectRoot);

  return (
    <section
      className="klide-focus-history-reader klide-focus-chat-in"
      aria-label={`Conversation history: ${conversation.title || "Untitled"}`}
    >
      <header className="klide-focus-history-header">
        <button
          type="button"
          className="klide-focus-history-back"
          onClick={onClose}
          aria-label="Back from conversation history"
          title="Back"
        >
          <svg {...iconProps} width={16} height={16}>
            <path d="m15 18-6-6 6-6" />
          </svg>
        </button>

        <span className="klide-focus-history-provider" aria-hidden="true">
          <ProviderLogo id={provider} size={20} />
        </span>

        <div className="klide-focus-history-heading">
          <h1>{conversation.title || "Untitled conversation"}</h1>
          <div className="klide-focus-history-meta">
            <span>{providerName(provider)}</span>
            {conversation.model ? <span>{conversation.model}</span> : null}
            {project ? <span title={projectRoot ?? undefined}>{project}</span> : null}
            {folder ? <span title={conversation.cwd ?? undefined}>{folder}</span> : null}
            <span>{new Date(conversation.updatedAt).toLocaleString()}</span>
          </div>
        </div>

        {delegate ? (
          <span
            className="klide-focus-history-readonly"
            title="Delegate and CLI conversations are temporarily read-only in Focus mode"
          >
            CLI history · read only
          </span>
        ) : (
          <button
            type="button"
            className="klide-focus-history-continue"
            onClick={onContinue}
          >
            Continue
            <svg {...iconProps} width={14} height={14}>
              <path d="M5 12h14" />
              <path d="m13 6 6 6-6 6" />
            </svg>
          </button>
        )}
      </header>

      <div className="klide-focus-history-scroll">
        <div className="klide-focus-history-transcript">
          {conversation.msgs.length === 0 ? (
            <div className="klide-focus-history-empty">
              This conversation has no saved messages.
            </div>
          ) : (
            conversation.msgs.map((message, index) => {
              const process = message.role === "tool" || message.role === "system";
              if (process) {
                return (
                  <div
                    key={`${message.role}-${index}`}
                    className="klide-focus-history-process"
                  >
                    {renderMessageBody(message)}
                  </div>
                );
              }
              const user = message.role === "user";
              return (
                <article
                  key={`${message.role}-${index}`}
                  className="klide-focus-history-turn"
                  data-role={message.role}
                >
                  {!user ? (
                    <span className="klide-focus-history-avatar" aria-hidden="true">
                      <ProviderLogo id={provider} size={16} />
                    </span>
                  ) : null}
                  <div className="klide-focus-history-turn-body">
                    <div className="klide-focus-history-role">
                      {user ? "You" : providerName(provider)}
                    </div>
                    <div className="klide-focus-history-bubble">
                      {renderMessageBody(message)}
                    </div>
                  </div>
                </article>
              );
            })
          )}
        </div>
      </div>
    </section>
  );
}

/* ----------------------------------------------------------------- screen */

export function FocusMode({
  workspaceRoot,
  branch,
  projects,
  chatActive,
  onSwitchProject,
  onNewChat,
  onOpenConversation,
  onSubmit,
  onOpenMissionControl,
  onOpenPanel,
  onExitFocus,
  renderChat,
  raceTabs,
  activeRaceTab,
  onSelectRaceTab,
  onRaceFollowUp,
  onCloseRaceTabs,
  provider,
  onProviderChange,
  model,
  onModelChange,
  effort,
  onEffortChange,
  contextWindow,
  onContextWindowChange,
}: Props) {
  const activeProjectRoot = normalizeProjectPath(workspaceRoot);
  const focusProjects = useMemo(() => {
    const seen = new Set<string>();
    const roots: string[] = [];
    for (const project of projects) {
      const normalized = normalizeProjectPath(project);
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      roots.push(normalized);
    }
    if (activeProjectRoot && !seen.has(activeProjectRoot)) roots.push(activeProjectRoot);
    return roots;
  }, [activeProjectRoot, projects]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [historyConversation, setHistoryConversation] = useState<Conversation | null>(null);
  // "Ask both" strip composer — local draft, cleared on send.
  const [raceAsk, setRaceAsk] = useState("");
  const [username, setUsername] = useState<string>("");
  const [hostname, setHostname] = useState<string>("");
  const searchRef = useRef<HTMLInputElement>(null);
  // Several projects can hold their history open at once. The active project
  // opens itself; the rest remember their state for the session.
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(
    () => new Set(activeProjectRoot ? [activeProjectRoot] : [])
  );
  // Absence means "follow the active provider". Explicit booleans preserve
  // the user's disclosure choice independently for every project/provider.
  const [expandedProviderGroups, setExpandedProviderGroups] = useState<Map<string, boolean>>(
    () => new Map()
  );

  useEffect(() => {
    if (!isDelegateProvider(provider)) return;
    // Keep the unstable delegate/PTY route out of Focus even when a previous
    // standard-panel session left one selected.
    onProviderChange("ollama");
  }, [provider, onProviderChange]);

  useEffect(() => {
    if (!activeProjectRoot) return;
    setExpandedProjects((prev) => {
      if (prev.has(activeProjectRoot)) return prev;
      const next = new Set(prev);
      next.add(activeProjectRoot);
      return next;
    });
  }, [activeProjectRoot]);

  function toggleProject(p: string) {
    setExpandedProjects((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });
  }

  function toggleProviderHistory(project: string, historyProvider: ProviderId) {
    const key = providerHistoryKey(project, historyProvider);
    setExpandedProviderGroups((prev) => {
      const next = new Map(prev);
      const isExpanded = next.get(key) ?? historyProvider === provider;
      next.set(key, !isExpanded);
      return next;
    });
  }

  useEffect(() => {
    invoke<{ username: string; hostname: string }>("app_user_info")
      .then((u) => {
        setUsername(u.username);
        setHostname(u.hostname);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (searchOpen) searchRef.current?.focus();
  }, [searchOpen]);

  const [convos, setConvos] = useState<Conversation[]>(
    () => loadConversations<Conversation>(),
  );

  // Same-window localStorage writes do not emit the browser's `storage`
  // event. AiPanel publishes this focused index event after the first durable
  // snapshot, so a brand-new conversation arrives with its model logo while
  // Focus stays mounted. View changes still reload as a defensive fallback.
  useEffect(() => {
    const reload = (event: Event) => {
      setConvos(loadConversations<Conversation>());
      const detail = (event as CustomEvent<ConversationChangedDetail | undefined>).detail;
      if (!detail) return;
      const project = linkedProjectForPath(detail.cwd, focusProjects);
      if (!project) return;

      // Work in a secondary AI panel still belongs in the Focus rail. Reveal
      // the owning project/provider rather than leaving the new row hidden
      // because the primary panel happens to use another provider.
      setExpandedProjects((previous) => {
        if (previous.has(project)) return previous;
        const next = new Set(previous);
        next.add(project);
        return next;
      });
      setExpandedProviderGroups((previous) => {
        const key = providerHistoryKey(project, detail.provider);
        if (previous.get(key) === true) return previous;
        const next = new Map(previous);
        next.set(key, true);
        return next;
      });
    };
    window.addEventListener(CONVERSATIONS_CHANGED_EVENT, reload);
    return () => window.removeEventListener(CONVERSATIONS_CHANGED_EVENT, reload);
  }, [focusProjects]);
  useEffect(() => {
    setConvos(loadConversations<Conversation>());
  }, [chatActive, searchOpen]);

  const projectName = activeProjectRoot ? basename(activeProjectRoot) : null;
  const folderedHistory = useMemo(() => {
    const byProject = new Map<string, Conversation[]>();
    const projectByConversationId = new Map<string, string>();
    for (const c of convos) {
      const linkedProject = linkedProjectForPath(c.cwd, focusProjects);
      if (!linkedProject) continue;
      projectByConversationId.set(c.id, linkedProject);
      const list = byProject.get(linkedProject);
      if (list) list.push(c);
      else byProject.set(linkedProject, [c]);
    }
    return { byProject, projectByConversationId };
  }, [convos, focusProjects]);
  const convosByProject = folderedHistory.byProject;
  const linkedProjectByConversationId = folderedHistory.projectByConversationId;
  const providerHistoriesByProject = useMemo(() => {
    const byProject = new Map<string, ProviderHistory[]>();
    for (const [project, projectHistory] of convosByProject) {
      byProject.set(project, groupHistoryByProvider(projectHistory));
    }
    return byProject;
  }, [convosByProject]);
  const projectConvos = useMemo(
    () => (activeProjectRoot ? convosByProject.get(activeProjectRoot) ?? [] : []),
    [activeProjectRoot, convosByProject]
  );
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return convos
      .filter(
        (c) =>
          (c.title || "").toLowerCase().includes(q) ||
          isSubsequence(q, (c.title || "").toLowerCase())
      )
      .slice(0, 20);
  }, [convos, query]);

  function openHistoryConversation(conversation: Conversation) {
    setHistoryConversation(conversation);
    const conversationProject = linkedProjectByConversationId.get(conversation.id);
    if (!conversationProject) return;

    const historyProvider = conversation.provider ?? "ollama";
    setExpandedProjects((prev) => {
      if (prev.has(conversationProject)) return prev;
      const next = new Set(prev);
      next.add(conversationProject);
      return next;
    });
    setExpandedProviderGroups((prev) => {
      const key = providerHistoryKey(conversationProject, historyProvider);
      if (prev.get(key) === true) return prev;
      const next = new Map(prev);
      next.set(key, true);
      return next;
    });
  }

  const searching = searchOpen && query.trim().length > 0;

  return (
    <div className="klide-focus-shell">
      {/* ── Left rail ─────────────────────────────────────────────── */}
      <aside className="klide-focus-rail" aria-label="Focus navigation">
        <div className="klide-focus-brand">
          <span className="klide-focus-brand-mark" aria-hidden="true">K</span>
          <span className="klide-focus-brand-name">Klide</span>
          <button
            type="button"
            className="klide-focus-brand-action"
            aria-label={searchOpen ? "Close conversation search" : "Search conversations"}
            aria-expanded={searchOpen}
            onClick={() => {
              setSearchOpen((v) => !v);
              setQuery("");
            }}
          >
            <SearchIcon />
          </button>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
          <NavRow
            icon={<NewChatIcon />}
            label="New task"
            onClick={() => {
              setHistoryConversation(null);
              onNewChat();
            }}
          />
          <NavRow
            icon={<BoardIcon />}
            label="Mission Control"
            onClick={() => {
              setHistoryConversation(null);
              onOpenMissionControl();
            }}
          />
          <NavRow
            icon={<OrchestratorIcon />}
            label="Orchestrator"
            onClick={() => {
              setHistoryConversation(null);
              onOpenPanel("orchestrator");
            }}
          />
        </div>

        {searchOpen && (
          <input
            ref={searchRef}
            className="klide-focus-search"
            type="search"
            name="conversation-search"
            aria-label="Search conversations"
            autoComplete="off"
            spellCheck={false}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setSearchOpen(false);
                setQuery("");
              }
            }}
            placeholder="Search conversations…"
            style={{
              margin: "8px 2px 0",
              padding: "5px 9px",
              fontSize: 12,
              borderRadius: "var(--radius-sm)",
              border: "1px solid var(--border)",
              background: "var(--bg-elevated)",
              color: "var(--fg-strong)",
            }}
          />
        )}

        {/* Section break — a gradient hairline, not another written label
            (the same recipe the free-mode rail uses between its zones). It
            separates the actions above from the workspace list below, so the
            search field stays attached to what it filters. */}
        <div aria-hidden="true" className="klide-focus-rail-divider" />

        <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
          {searching ? (
            <>
              <SectionLabel>Results</SectionLabel>
              {filtered.length === 0 ? (
                <div style={{ padding: "4px 10px", fontSize: 12, color: "var(--fg-subtle)" }}>
                  No conversations match.
                </div>
              ) : (
                filtered.map((c) => (
                  <ConvoRow
                    key={c.id}
                    convo={c}
                    selected={historyConversation?.id === c.id}
                    onOpen={() => openHistoryConversation(c)}
                  />
                ))
              )}
            </>
          ) : (
            <>
              <SectionLabel>Projects</SectionLabel>
              {focusProjects.length === 0 && (
                <div style={{ padding: "4px 10px", fontSize: 12, color: "var(--fg-subtle)" }}>
                  Open a folder to start.
                </div>
              )}
              {focusProjects.map((p) => {
                const isActive = p === activeProjectRoot;
                const isExpanded = expandedProjects.has(p);
                const history = convosByProject.get(p) ?? [];
                const providerHistories = providerHistoriesByProject.get(p) ?? [];
                return (
                  <div key={p}>
                    <NavRow
                      icon={<FolderIcon />}
                      label={basename(p)}
                      active={isActive}
                      expanded={isExpanded}
                      onClick={() => {
                        // Switching makes a project current; clicking the
                        // current one just folds its history open/closed.
                        if (isActive) toggleProject(p);
                        else {
                          setHistoryConversation(null);
                          onSwitchProject(p);
                        }
                      }}
                    />
                    {isExpanded && history.length > 0 ? (
                      <div className="klide-focus-provider-groups">
                        {providerHistories.map((providerHistory) => {
                          const key = providerHistoryKey(p, providerHistory.provider);
                          const providerExpanded = providerHistoryExpanded(
                            expandedProviderGroups.get(key),
                            providerHistory.provider,
                            provider,
                            providerHistories[0]?.provider,
                          );
                          return (
                            <ProviderHistoryGroup
                              key={providerHistory.provider}
                              group={providerHistory}
                              expanded={providerExpanded}
                              selectedConversationId={historyConversation?.id}
                              onToggle={() => toggleProviderHistory(p, providerHistory.provider)}
                              onOpen={openHistoryConversation}
                            />
                          );
                        })}
                      </div>
                    ) : null}
                    {isExpanded && history.length === 0 ? (
                      <div style={{ padding: "2px 10px 4px 35px", fontSize: 11.5, color: "var(--fg-subtle)", opacity: 0.72 }}>
                        No conversations yet.
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </>
          )}
        </div>

        {/* Foot — the rail's utility zone, mirroring the free-mode rail's
            bottom half: shared destinations as one quiet icon strip (labels
            live in their tooltips, as they do on the collapsed rail), the
            layout switch pushed to the far edge, then identity. */}
        <div className="klide-focus-foot-strip">
          {(
            [
              ["git", "Git", GitIcon],
              ["memory", "Memory", MemoryIcon],
              ["skills", "Skills", SkillsIcon],
              ["settings", "Settings", SettingsIcon],
            ] as const
          ).map(([panel, label, Icon]) => (
            <button
              key={panel}
              type="button"
              className="klide-focus-foot-action"
              aria-label={label}
              title={label}
              onClick={() => {
                setHistoryConversation(null);
                onOpenPanel(panel);
              }}
            >
              <Icon />
            </button>
          ))}
          {/* Focus has no status bar; this is the way back to the panel
              workspace. Set apart at the trailing edge — it changes the shell,
              the others only open a surface. */}
          <button
            type="button"
            className="klide-focus-foot-action"
            style={{ marginLeft: "auto" }}
            aria-label="Leave Focus — Free layout"
            title="Leave Focus — Free layout"
            onClick={onExitFocus}
          >
            <FreeLayoutIcon />
          </button>
        </div>

        {/* Profile foot — local identity, flat avatar (allowed circle).
            Clicking it opens the same Profile modal the free-mode rail does. */}
        <button
          type="button"
          className="klide-focus-profile"
          aria-label="Open profile"
          title="Profile"
          onClick={() => onOpenPanel("profile")}
        >
          <span
            aria-hidden
            style={{
              width: 26,
              height: 26,
              borderRadius: "50%",
              flexShrink: 0,
              display: "grid",
              placeItems: "center",
              background: "var(--accent-soft)",
              color: "var(--fg-strong)",
              fontSize: 10.5,
            }}
          >
            {initialsOf(username || "?")}
          </span>
          <span style={{ minWidth: 0, display: "flex", flexDirection: "column" }}>
            <span
              style={{
                fontSize: 12.5,
                color: "var(--fg-strong)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {username || "Local profile"}
            </span>
            <span style={{ fontSize: 10.5, color: "var(--fg-subtle)", opacity: 0.72 }}>{hostname}</span>
          </span>
        </button>
      </aside>

      {/* ── Canvas ────────────────────────────────────────────────── */}
      <main className="klide-focus-main">
        {historyConversation ? (
          <HistoryReader
            conversation={historyConversation}
            projectRoot={linkedProjectByConversationId.get(historyConversation.id)}
            onClose={() => setHistoryConversation(null)}
            onContinue={() => {
              const conversation = historyConversation;
              setHistoryConversation(null);
              onOpenConversation(conversation);
            }}
          />
        ) : null}
        <div
          className="klide-focus-current-surface"
          data-hidden={historyConversation ? true : undefined}
        >
        {chatActive ? (
          <div
            className="klide-focus-chat-in"
            style={{
              flex: 1,
              minHeight: 0,
              display: "flex",
              flexDirection: "column",
              overflow: "hidden",
            }}
          >
            {raceTabs && raceTabs.length > 0 && (
              /* Race watch — one soft-segment tab per racing agent: the same
                 design as the docked editor and Artifact Inspector strips.
                 The active tab carries a quiet neutral fill (the hover token,
                 not a saturated pill) as its only marker; the panels stay
                 mounted in the parent, this strip only picks which is
                 visible. */
              <div
                role="tablist"
                aria-label="Racing agents"
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 4,
                  padding: "0 16px",
                  height: 38,
                  flexShrink: 0,
                  borderBottom: "1px solid var(--border)",
                }}
              >
                {raceTabs.map((t) => {
                  const active = t.panelId === (activeRaceTab ?? raceTabs[0].panelId);
                  return (
                    <button
                      key={t.panelId}
                      type="button"
                      role="tab"
                      aria-selected={active}
                      onClick={() => onSelectRaceTab?.(t.panelId)}
                      style={{
                        border: "none",
                        background: active ? "var(--bg-hover)" : "transparent",
                        font: "inherit",
                        fontSize: 12.5,
                        fontWeight: active ? 550 : 400,
                        color: active ? "var(--fg-strong)" : "var(--fg-subtle)",
                        padding: "0 10px",
                        height: 24,
                        borderRadius: "var(--radius-sm)",
                        cursor: "pointer",
                        transition:
                          "color var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out)",
                      }}
                      onMouseEnter={(e) => {
                        if (!active) {
                          e.currentTarget.style.color = "var(--fg-strong)";
                          e.currentTarget.style.background =
                            "color-mix(in srgb, var(--bg-hover) 45%, transparent)";
                        }
                      }}
                      onMouseLeave={(e) => {
                        if (!active) {
                          e.currentTarget.style.color = "var(--fg-subtle)";
                          e.currentTarget.style.background = "transparent";
                        }
                      }}
                    >
                      {t.label}
                    </button>
                  );
                })}
                {onRaceFollowUp && (
                  <input
                    type="text"
                    name="race-follow-up"
                    aria-label={raceTabs.length > 1 ? "Ask all racing agents" : "Ask the racing agent"}
                    autoComplete="off"
                    value={raceAsk}
                    onChange={(e) => setRaceAsk(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key !== "Enter") return;
                      e.preventDefault();
                      const t = raceAsk.trim();
                      if (!t) return;
                      onRaceFollowUp(t);
                      setRaceAsk("");
                    }}
                    placeholder={raceTabs.length > 1 ? "Ask both…" : "Ask the racer…"}
                    title="One follow-up, sent into every racer's conversation"
                    style={{
                      marginLeft: "auto",
                      width: 220,
                      fontSize: 12,
                      fontFamily: "inherit",
                      color: "var(--fg-strong)",
                      background: "var(--bg)",
                      border: "1px solid var(--border)",
                      borderRadius: "var(--radius-sm)",
                      padding: "4px 8px",
                      transition: "border-color var(--motion-fast) var(--ease-out)",
                    }}
                    onFocus={(e) => { e.currentTarget.style.borderColor = "var(--border-strong)"; }}
                    onBlur={(e) => { e.currentTarget.style.borderColor = "var(--border)"; }}
                  />
                )}
                <button
                  type="button"
                  onClick={() => onCloseRaceTabs?.()}
                  title="Close the race view — both runs keep going and stay on Mission Control"
                  style={{
                    marginLeft: onRaceFollowUp ? undefined : "auto",
                    border: "none",
                    background: "transparent",
                    font: "inherit",
                    fontSize: 11.5,
                    color: "var(--fg-dim)",
                    padding: 0,
                    cursor: "pointer",
                    flexShrink: 0,
                    transition: "color var(--motion-fast) var(--ease-out)",
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.color = "var(--fg-strong)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.color = "var(--fg-dim)"; }}
                >
                  End watch
                </button>
              </div>
            )}
            {renderChat()}
          </div>
        ) : (
          <FocusHome
            projectName={projectName}
            branch={branch}
            recent={projectConvos.slice(0, 3)}
            onOpenConversation={onOpenConversation}
            onSubmit={onSubmit}
            provider={provider}
            onProviderChange={onProviderChange}
            model={model}
            onModelChange={onModelChange}
            effort={effort}
            onEffortChange={onEffortChange}
            contextWindow={contextWindow}
            onContextWindowChange={onContextWindowChange}
          />
        )}
        </div>
      </main>
    </div>
  );
}

/* ------------------------------------------------------------ inline menu */

type MenuOption = {
  label: string;
  value: string | number | undefined;
  /** Non-clickable section eyebrow inside the menu (provider groups). */
  heading?: boolean;
  /** Per-row mark, in the ModelPicker idiom (provider logo, effort bars). */
  icon?: ReactNode;
  /** Quiet second line under the label. */
  caption?: string;
};

/** Reasoning-effort glyph — the AI panel's reflection-bars language: five
 *  bars, filled up to the chosen level; Auto shows them all at rest. */
function EffortBars({ level, size = 16 }: { level: number; size?: number }) {
  const heights = [5, 7, 9, 11, 13];
  return (
    <svg width={size} height={size * 0.875} viewBox="0 0 16 14" aria-hidden>
      {heights.map((h, i) => (
        <rect
          key={i}
          x={i * 3 + 0.5}
          y={13.5 - h}
          width="2"
          height={h}
          rx="1"
          fill="currentColor"
          opacity={level > 0 && i < level ? 0.9 : 0.28}
        />
      ))}
    </svg>
  );
}

/** Context-window glyph — a simple gauge arc in the same stroke language. */
function ContextGaugeIcon({ size = 15 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      aria-hidden
    >
      <path d="M5 17a8 8 0 1 1 14 0" />
      <path d="M12 13l3.5-3.5" />
    </svg>
  );
}

/** A flat text trigger opening the AI panel's picker surface — the same
 *  design as the ModelPicker dropdown: glass card, framed-icon header with a
 *  caption, hairline dividers, icon rows with the accent-tint active state.
 *  Portalled to <body> so no ancestor clip can swallow it. */
function InlineMenu({
  label,
  display,
  options,
  selected,
  onSelect,
  mono = false,
  leading,
  header,
  width = 236,
  variant = "text",
  ringRatio = 0,
}: {
  label: string;
  display: string;
  options: MenuOption[];
  selected: string | number | undefined;
  onSelect: (value: string | number | undefined) => void;
  mono?: boolean;
  /** Optional glyph before the value (the provider trigger's logo). */
  leading?: ReactNode;
  /** The picker header: framed icon + title + quiet caption. */
  header: { icon: ReactNode; title: string; caption: string };
  width?: number;
  /** "ring" renders the AI panel's context-meter circle as the trigger —
   *  28px round button, border track ring, accent arc — instead of text.
   *  `ringRatio` (0..1) drives the arc; the panel floors it at 2 so the
   *  glyph always reads as a meter. */
  variant?: "text" | "ring";
  ringRatio?: number;
}) {
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState(false);
  const [focusIdx, setFocusIdx] = useState(-1);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // Portalled to <body> (fixed, measured from the trigger) so it escapes the
  // composer card's `overflow: hidden` clip — the same reason the AI panel
  // portals its ModelPicker and mode menus.
  const [menuPos, setMenuPos] = useState<{ bottom: number; left: number } | null>(null);

  function toggleMenu() {
    if (open) {
      setOpen(false);
      return;
    }
    const r = rootRef.current?.getBoundingClientRect();
    if (!r) return;
    const left = Math.max(8, Math.min(Math.round(r.left), window.innerWidth - width - 8));
    setMenuPos({ bottom: Math.round(window.innerHeight - r.top + 8), left });
    setFocusIdx(-1);
    setOpen(true);
  }

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      const target = e.target as Node | null;
      if (rootRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const hasIcons = options.some((o) => !o.heading && o.icon);

  return (
    <div ref={rootRef} style={{ position: "relative", display: "flex", minWidth: 0 }}>
      {variant === "ring" ? (
        /* The AI panel's context-meter circle, verbatim: 28px round button,
           `--border` track ring, accent arc floored at 2% so the glyph
           always reads as a meter. */
        <button
          type="button"
          onClick={toggleMenu}
          onMouseEnter={() => setHover(true)}
          onMouseLeave={() => setHover(false)}
          aria-label={`${label} — ${display}`}
          aria-haspopup="listbox"
          aria-expanded={open}
          title={`${label} · ${display}`}
          style={{
            width: 28,
            height: 28,
            flexShrink: 0,
            display: "grid",
            placeItems: "center",
            border: "none",
            borderRadius: "50%",
            background: open || hover ? "var(--bg-hover)" : "transparent",
            color: "var(--accent)",
            cursor: "pointer",
            transition:
              "background var(--motion-fast) var(--ease-out), color var(--motion-med) var(--ease-out)",
          }}
        >
          <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true">
            <circle cx="11" cy="11" r="7.5" fill="none" stroke="var(--border)" strokeWidth="1.6" />
            <circle
              cx="11"
              cy="11"
              r="7.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              pathLength="100"
              strokeDasharray={`${Math.max(2, Math.round(ringRatio * 100))} 100`}
              transform="rotate(-90 11 11)"
              style={{
                transition:
                  "stroke-dasharray var(--motion-med) var(--ease-out), stroke var(--motion-med) var(--ease-out)",
              }}
            />
          </svg>
        </button>
      ) : (
      <button
        type="button"
        onClick={toggleMenu}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={label}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 5,
          height: 24,
          border: "1px solid transparent",
          background: open ? "var(--bg-hover)" : "transparent",
          padding: "0 5px",
          borderRadius: "var(--radius-sm)",
          fontSize: 11,
          fontWeight: 500,
          fontFamily: mono ? "var(--font-mono)" : "inherit",
          color: open || hover ? "var(--fg-strong)" : "var(--fg-subtle)",
          cursor: "pointer",
          minWidth: 0,
          transition:
            "color var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out)",
        }}
      >
        {leading && <span style={{ display: "flex", flexShrink: 0 }}>{leading}</span>}
        <span
          style={{
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            maxWidth: 170,
          }}
        >
          {display}
        </span>
        <svg
          width="9"
          height="9"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
          style={{
            flexShrink: 0,
            color: "var(--fg-dim)",
            transform: open ? "rotate(180deg)" : "none",
            transition: "transform var(--motion-fast) var(--ease-out)",
          }}
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      )}
      {open && menuPos && createPortal(
        <div
          ref={menuRef}
          role="listbox"
          aria-label={label}
          className="popover-enter"
          style={{
            position: "fixed",
            bottom: menuPos.bottom,
            left: menuPos.left,
            width,
            maxHeight: 340,
            display: "flex",
            flexDirection: "column",
            background: "var(--panel-glass)",
            border: "1px solid var(--panel-border)",
            borderRadius: "var(--radius-md)",
            boxShadow: "var(--panel-shadow)",
            backdropFilter: "blur(22px) saturate(1.18)",
            WebkitBackdropFilter: "blur(22px) saturate(1.18)",
            overflow: "hidden",
            zIndex: Z.popover,
          }}
        >
          {/* Header — same frame as the ModelPicker's: a bordered icon tile,
              the menu's name, and a quiet caption. */}
          <div
            style={{
              flexShrink: 0,
              display: "flex",
              alignItems: "center",
              gap: 9,
              padding: "10px 12px 9px",
              borderBottom: "1px solid var(--panel-border)",
              background: "color-mix(in srgb, var(--panel-highlight) 30%, transparent)",
            }}
          >
            <span
              style={{
                display: "grid",
                placeItems: "center",
                width: 26,
                height: 26,
                borderRadius: 8,
                background: "var(--bg-elevated)",
                border: "1px solid var(--border)",
                color: "var(--fg-subtle)",
                flexShrink: 0,
              }}
            >
              {header.icon}
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  color: "var(--fg-strong)",
                  letterSpacing: "-0.005em",
                }}
              >
                {header.title}
              </div>
              <div style={{ fontSize: 10, color: "var(--fg-dim)", marginTop: 1 }}>
                {header.caption}
              </div>
            </div>
          </div>
          <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: 4 }}>
            {options.map((o, idx) => {
              if (o.heading) {
                return (
                  <div
                    key={`h-${o.label}`}
                    style={{
                      padding: "7px 9px 3px",
                      fontSize: 9.5,
                      fontWeight: 600,
                      letterSpacing: "0.07em",
                      textTransform: "uppercase",
                      color: "var(--fg-dim)",
                    }}
                  >
                    {o.label}
                  </div>
                );
              }
              const active = o.value === selected;
              const focused = idx === focusIdx;
              return (
                <button
                  key={String(o.value)}
                  type="button"
                  role="option"
                  aria-selected={active}
                  onClick={() => {
                    setOpen(false);
                    onSelect(o.value);
                  }}
                  onMouseEnter={() => setFocusIdx(idx)}
                  onMouseLeave={() => setFocusIdx((i) => (i === idx ? -1 : i))}
                  style={{
                    display: "block",
                    width: "100%",
                    padding: "7px 9px",
                    border: "none",
                    borderRadius: "var(--radius-sm)",
                    background: active
                      ? "color-mix(in srgb, var(--accent-soft) 80%, transparent)"
                      : focused
                        ? "var(--bg-hover)"
                        : "transparent",
                    color: "var(--fg-strong)",
                    textAlign: "left",
                    cursor: "pointer",
                    transition: "background var(--motion-fast) var(--ease-out)",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    {hasIcons && (
                      <span
                        style={{
                          width: 20,
                          height: 20,
                          flexShrink: 0,
                          display: "grid",
                          placeItems: "center",
                          color: "var(--fg-subtle)",
                        }}
                      >
                        {o.icon}
                      </span>
                    )}
                    <span
                      style={{
                        flex: 1,
                        minWidth: 0,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        fontSize: 12,
                        fontWeight: active ? 550 : 500,
                        fontFamily: mono ? "var(--font-mono)" : "inherit",
                      }}
                    >
                      {o.label}
                    </span>
                  </div>
                  {o.caption && (
                    <div
                      style={{
                        marginTop: 2,
                        marginLeft: hasIcons ? 26 : 0,
                        fontSize: 10,
                        color: "var(--fg-dim)",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {o.caption}
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}

// Providers the hero can start a conversation on — the same groups the AI
// panel's picker shows, minus the not-yet-available rows. Each row carries
// its provider mark, ModelPicker-style.
const PROVIDER_OPTIONS: MenuOption[] = PROVIDER_GROUPS.flatMap((group) => {
  // Focus currently supports native API/local runs only. Delegate CLIs mount a
  // separate PTY surface and stay out of this picker until that path is stable.
  const items = group.items.filter((item) => item.available && !isDelegateProvider(item.id));
  if (items.length === 0) return [];
  return [
    { label: group.label, value: `__heading_${group.label}`, heading: true },
    ...items.map((item) => ({
      label: item.name,
      value: item.id,
      icon: <ProviderLogo id={item.id} size={17} />,
    })),
  ];
});

const EFFORT_LEVELS: { label: string; value: string | undefined; level: number; caption: string }[] = [
  { label: "Auto", value: undefined, level: 0, caption: "Provider default" },
  { label: "minimal", value: "minimal", level: 1, caption: "Smallest reasoning effort" },
  { label: "low", value: "low", level: 2, caption: "Lower reasoning effort" },
  { label: "medium", value: "medium", level: 3, caption: "Default reasoning effort" },
  { label: "high", value: "high", level: 4, caption: "Higher reasoning effort" },
  { label: "xhigh", value: "xhigh", level: 5, caption: "Highest reasoning effort" },
];

const EFFORT_OPTIONS: MenuOption[] = EFFORT_LEVELS.map((e) => ({
  label: e.label,
  value: e.value,
  caption: e.caption,
  icon: <EffortBars level={e.level} />,
}));

function effortLevelOf(effort: string | undefined): number {
  return EFFORT_LEVELS.find((e) => e.value === effort)?.level ?? 0;
}

const CONTEXT_OPTIONS: MenuOption[] = [
  { label: "Auto", value: undefined, caption: "Detected from the model" },
  { label: "8K", value: 8192 },
  { label: "16K", value: 16384 },
  { label: "32K", value: 32768 },
  { label: "64K", value: 65536 },
  { label: "128K", value: 131072 },
];

function contextLabel(window: number | undefined): string {
  if (window === undefined) return "auto ctx";
  return `${Math.round(window / 1024)}K ctx`;
}

/* ------------------------------------------------------------------- home */

type StarterKind = "explore" | "build" | "review" | "fix" | "resume";

const STARTERS: { title: string; sub: string; prompt: string; kind: StarterKind }[] = [
  {
    title: "Explore the codebase",
    sub: "Understand the architecture and key decisions",
    prompt: "Give me a tour of this codebase: the structure, the key modules, and how they fit together.",
    kind: "explore",
  },
  {
    title: "Build a feature",
    sub: "Turn an idea into a working implementation",
    prompt: "Help me build a feature. Start by asking what outcome I want, then inspect the codebase and propose a focused implementation.",
    kind: "build",
  },
  {
    title: "Review changes",
    sub: "Find risks and improvements before commit",
    prompt: "Review my uncommitted changes and point out bugs, risks, and cleanups before I commit.",
    kind: "review",
  },
  {
    title: "Fix a problem",
    sub: "Diagnose a bug, failure, or regression",
    prompt: "Help me diagnose and fix a problem. Ask for the symptoms, reproduce it, and propose the smallest reliable fix.",
    kind: "fix",
  },
];

function StarterIcon({ kind }: { kind: StarterKind }) {
  if (kind === "build") {
    return (
      <svg {...iconProps} width={17} height={17}>
        <path d="m14 4 6 6-10 10H4v-6z" />
        <path d="m12 6 6 6" />
      </svg>
    );
  }
  if (kind === "review") {
    return (
      <svg {...iconProps} width={17} height={17}>
        <path d="M4 5h10" />
        <path d="M4 10h8" />
        <path d="M4 15h6" />
        <path d="m15 16 2 2 4-5" />
      </svg>
    );
  }
  if (kind === "fix") {
    return (
      <svg {...iconProps} width={17} height={17}>
        <path d="m14 6 4-4 4 4-4 4" />
        <path d="M18 6h-7a7 7 0 1 0 7 7" />
      </svg>
    );
  }
  if (kind === "resume") {
    return (
      <svg {...iconProps} width={17} height={17}>
        <path d="M4 12a8 8 0 1 0 2.3-5.7L4 8.6" />
        <path d="M4 4v4.6h4.6" />
      </svg>
    );
  }
  return (
    <svg {...iconProps} width={17} height={17}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-4-4" />
      <path d="M8 11h6" />
      <path d="M11 8v6" />
    </svg>
  );
}

function FocusHome({
  projectName,
  branch,
  recent,
  onOpenConversation,
  onSubmit,
  provider,
  onProviderChange,
  model,
  onModelChange,
  effort,
  onEffortChange,
  contextWindow,
  onContextWindowChange,
}: {
  projectName: string | null;
  branch: string | null;
  recent: Conversation[];
  onOpenConversation: (convo: Conversation) => void;
  onSubmit: (text: string) => void;
  provider: ProviderId;
  onProviderChange: (provider: ProviderId) => void;
  model: string;
  onModelChange: (model: string) => void;
  effort: string | undefined;
  onEffortChange: (effort: string | undefined) => void;
  contextWindow: number | undefined;
  onContextWindowChange: (window: number | undefined) => void;
}) {
  const [draft, setDraft] = useState("");
  const [focused, setFocused] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  // The model list for the chosen provider — the same discovery command the
  // AI panel and Settings use. Falls back to the provider's default so the
  // menu is never empty while a server is down.
  const [models, setModels] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    const fallback = [model, DEFAULT_MODELS[provider]].filter(Boolean) as string[];
    setModels(Array.from(new Set(fallback)));
    listProviderModels(provider)
      .then((list) => {
        if (!cancelled && Array.isArray(list) && list.length > 0) setModels(list);
      })
      .catch(() => {
        /* server down / no key — keep the fallback */
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider]);

  useEffect(() => {
    taRef.current?.focus();
  }, []);

  function submit() {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    onSubmit(text);
  }

  const canSend = draft.trim().length > 0;

  return (
    <div className="klide-focus-home">
      <section className="klide-focus-stage" aria-labelledby="klide-focus-title">
        <div className="klide-focus-rise klide-focus-hero-mark" aria-hidden="true">
          <span>K</span>
        </div>
        <h1 id="klide-focus-title" className="klide-focus-rise">
          {projectName ? `What should we build in ${projectName}?` : "What should we build?"}
        </h1>

        <div className="klide-focus-rise klide-focus-card-area" data-beat="1">
          <div className="klide-focus-card-label">
            {recent.length > 0 ? "Continue where you left off" : "Start with a direction"}
          </div>
          <div className="klide-focus-card-grid">
            {(recent.length > 0
              ? recent.map((c) => ({
                  key: c.id,
                  title: c.title || "Untitled conversation",
                  sub: `${relativeTime(c.updatedAt)} · Resume`,
                  kind: "resume" as StarterKind,
                  model: c.model,
                  onClick: () => onOpenConversation(c),
                }))
              : STARTERS.map((s) => ({
                  key: s.title,
                  title: s.title,
                  sub: s.sub,
                  kind: s.kind,
                  model: undefined,
                  onClick: () => onSubmit(s.prompt),
                }))
            ).map((card, index) => (
              <HomeCard
                key={card.key}
                title={card.title}
                sub={card.sub}
                kind={card.kind}
                model={card.model}
                index={index}
                onClick={card.onClick}
              />
            ))}
          </div>
        </div>
      </section>

      {/* The persistent task dock combines Codex's context ribbon with
          Claude's bottom-anchored composer. */}
      <div className="klide-focus-composer-dock">
        <div className="klide-focus-context-strip" role="group" aria-label="Task context">
          {projectName && (
            <span>
              <FolderIcon />
              {projectName}
            </span>
          )}
          <span>
            <LocalIcon />
            Local
          </span>
          {branch && (
            <span>
              <BranchIcon />
              {branch}
            </span>
          )}
        </div>

        <div className="klide-focus-composer" data-focused={focused || undefined}>
          <textarea
            ref={taRef}
            name="task-prompt"
            aria-label="Describe a task or ask a question"
            autoComplete="off"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder="Describe a task or ask a question…"
            rows={2}
          />

          <div className="klide-focus-composer-footer">
            <div className="klide-focus-provider-control">
              <InlineMenu
                label="Provider"
                display={providerName(provider)}
                leading={<ProviderLogo id={provider} size={13} />}
                header={{
                  icon: <ProviderLogo id={provider} size={15} />,
                  title: "Provider",
                  caption: "Where this conversation runs",
                }}
                options={PROVIDER_OPTIONS}
                selected={provider}
                onSelect={(v) => {
                  if (typeof v === "string" && !v.startsWith("__heading_")) {
                    onProviderChange(v as ProviderId);
                  }
                }}
              />
            </div>

            <div className="klide-focus-model-controls">
              <ModelPicker
                provider={provider}
                model={model}
                availableModels={models}
                disabled={false}
                onChange={onModelChange}
              />
              <InlineMenu
                label="Reasoning effort"
                display={effort ?? "auto"}
                leading={<EffortBars level={effortLevelOf(effort)} size={13} />}
                header={{
                  icon: <EffortBars level={effortLevelOf(effort)} />,
                  title: "Reasoning effort",
                  caption: "Applied per model, saved in harness settings",
                }}
                width={216}
                options={EFFORT_OPTIONS}
                selected={effort}
                onSelect={(v) => onEffortChange(v === undefined ? undefined : String(v))}
              />
              <InlineMenu
                label="Context window"
                display={contextLabel(contextWindow)}
                variant="ring"
                ringRatio={contextWindow ? contextWindow / 131072 : 0}
                header={{
                  icon: <ContextGaugeIcon />,
                  title: "Context window",
                  caption: "Override the auto-detected window",
                }}
                width={200}
                options={CONTEXT_OPTIONS}
                selected={contextWindow}
                onSelect={(v) => onContextWindowChange(typeof v === "number" ? v : undefined)}
              />
              <button
                type="button"
                onClick={submit}
                aria-label="Send task"
                disabled={!canSend}
                className="klide-focus-send"
                data-ready={canSend || undefined}
              >
                <SendIcon />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function HomeCard({
  title,
  sub,
  kind,
  model,
  index,
  onClick,
}: {
  title: string;
  sub: string;
  kind: StarterKind;
  model?: string | null;
  index: number;
  onClick: () => void;
}) {
  const identity = kind === "resume" ? modelIdentity(model) : null;
  const ModelLogo = identity?.Logo;

  return (
    <button
      type="button"
      onClick={onClick}
      className="klide-focus-home-card"
      style={{ "--focus-card-delay": `${index * 35}ms` } as CSSProperties}
    >
      {kind === "resume" ? (
        ModelLogo ? (
          <span
            className="klide-focus-home-card-icon"
            title={identity.name}
            aria-hidden="true"
          >
            <ModelLogo size={17} />
          </span>
        ) : null
      ) : (
        <span className="klide-focus-home-card-icon" aria-hidden="true">
          <StarterIcon kind={kind} />
        </span>
      )}
      <span className="klide-focus-home-card-title">{title}</span>
      <span className="klide-focus-home-card-sub">{sub}</span>
      <span className="klide-focus-home-card-arrow" aria-hidden="true">↗</span>
    </button>
  );
}
