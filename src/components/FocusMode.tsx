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
import {
  listProviderModels,
  modelSupportsTools as queryModelSupportsTools,
  readProviderKeyStatus,
} from "../ipc/aiProviders";
import { Z } from "../zLayers";
import {
  CloseIcon,
  FolderIcon,
  FreeLayoutIcon,
  GitIcon,
  MemoryIcon,
  MissionIcon,
  NewTaskIcon,
  OrchestratorIcon,
  SearchIcon,
  SendIcon,
  SkillsIcon,
  TerminalIcon,
} from "../icons";
import { railDestination } from "../railDestinations";
import { useUserInfo, initialsOf } from "../hooks/useUserInfo";
import { usePortalMenu } from "../hooks/usePortalMenu";
import { useCustomProviders } from "../hooks/useCustomProviders";
import {
  CONVERSATIONS_CHANGED_EVENT,
  conversationDuration,
  conversationStartedAt,
  formatSpan,
  loadConversations,
  relativeTime,
  isSubsequence,
  type ConversationChangedDetail,
} from "./ai/utils";
import type { Conversation } from "./ai/types";
import type { AgentMode, ProviderId } from "../agent/types";
import { AUTONOMY_RUNGS, effectiveMode as effectiveModeFor } from "./ai/autonomyLadder";
import {
  PROVIDER_GROUPS,
  defaultModelForProvider,
  isDelegateProvider,
  normalizeAgentMode,
  providerGroupsWithCustom,
  providerName,
  providerNeedsApiKey,
} from "../agent/providers";
import { isCustomProvider, type CustomProvider } from "../customProviders";
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
import { listWorkspaceFiles } from "./ai/workspaceFiles";
import { FocusGitIsland } from "./FocusGitIsland";

type Props = {
  workspaceRoot: string | null;
  branch: string | null;
  gitChangeCount: number;
  gitRefreshToken: string;
  /** Recent project roots (the same list the activity-bar popover shows). */
  projects: string[];
  chatActive: boolean;
  onSwitchProject: (root: string) => void;
  /** Back to the hero home — the next submit starts a fresh conversation. */
  onNewChat: () => void;
  /** `continueWith` carries the history reader's composed text: resume the
   *  conversation, then send that as its next turn. */
  onOpenConversation: (convo: Conversation, continueWith?: string) => void;
  onSubmit: (text: string) => void;
  onOpenMissionControl: () => void;
  /** The rail's shared destinations — the same handler the free-mode activity
   *  bar calls, so Focus opens the identical Git view / Memory / Skills /
   *  Settings / Profile surfaces instead of parallel ones. */
  onOpenPanel: (panel: "git" | "memory" | "skills" | "settings" | "profile" | "orchestrator") => void;
  /** Open Settings straight on one section. The composer's provider picker
   *  sends keyless providers to "api" (API keys) instead of dead-ending on a
   *  row you can't run. */
  onOpenSettingsSection: (section: string) => void;
  /** Leave Focus for the Free (floating-panel) layout. Focus has no status
   *  bar, so this rail icon is the only way out. */
  onExitFocus: () => void;
  renderChat: () => ReactNode;
  /** Terminal — the native shell docked under the canvas. It stands beneath the
   *  home/chat surface rather than replacing it, so the conversation keeps its
   *  mount (run subscriptions are mount-tied) and keeps streaming while you
   *  work in the shell. One shell app-wide: the same PTY the workbench drawer
   *  shows, at the same remembered height, so opening it here doesn't start a
   *  second one. The parent renders the whole dock; this is the slot. */
  terminalOpen: boolean;
  onOpenTerminal: () => void;
  onCloseTerminal: () => void;
  renderTerminal: () => ReactNode;
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
  requireDiffReview: boolean;
  onRequireDiffReviewChange: (required: boolean) => void;
};

function basename(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
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

/* Glyphs come from ../icons — one vocabulary for both rails, so a change to
   the Memory mark lands here and in the free-mode rail at the same time. This
   file only decides density: rail rows at 15px, inline controls at 13–14. */

const RAIL_GLYPH = 15;

/* Settings + Profile come from ../railDestinations, shared with the free-mode
   rail's bottom zone — one definition of what the app's destinations are. */
const settingsDest = railDestination("settings");
const profileDest = railDestination("profile");

/** The curve turning off a spine into its row.
 *
 *  It draws only the turn — the vertical is the spine's own `::before` in
 *  tokens.css. The path starts at x=0.5 (the spine's pixel) with a vertical
 *  tangent and ends with a horizontal one, so the two strokes read as a single
 *  continuous line rather than a border meeting an SVG.
 *
 *  It also starts *below* the spine's top, at the same y the spine's own
 *  segment stops for a last child (`--rail-branch-depart`) — so the two never
 *  paint the same pixel twice. That matters: the line is semi-transparent, and
 *  a doubled stroke would darken exactly the stretch meant to look seamless.
 *
 *  The viewBox is 1:1 with the box CSS gives it, so these numbers are pixels: a
 *  quarter-circle of radius 8 from (.5, 7) down to (8.5, 15) — the row's
 *  junction — then a short run that stops `--rail-branch-gap` short of the
 *  row's icon. Note the arc is exactly a quarter: dx and dy both equal the
 *  radius, which is what makes it tangent-vertical where it leaves the trunk
 *  and tangent-horizontal where it reaches the row. An arc rather than a
 *  hand-tuned bezier because its curvature is constant; in a 1px hairline the
 *  eye reads any variation as a kink. So trunk, turn and run are one stroke.
 *
 *  The 13 is the box width CSS computes (spine → icon, less the clearance); the
 *  radius and start match `--rail-branch-radius` / `--rail-branch-depart`, which
 *  is exactly where the trunk's own segment stops. All four move together — if
 *  you retune one, retune the others. */
function TreeElbow() {
  return (
    <span className="klide-focus-tree-elbow" aria-hidden="true">
      <svg viewBox="0 0 13 16" fill="none" shapeRendering="geometricPrecision">
        <path
          d="M.5 7 A8 8 0 0 0 8.5 15 H13"
          stroke="currentColor"
          vectorEffect="non-scaling-stroke"
          /* Normalises the path to 100 units so the reveal's dash animation in
             tokens.css is independent of the radius. */
          pathLength={100}
        />
      </svg>
    </span>
  );
}

/* ---------------------------------------------------------------- sidebar */
/* The rail runs on one indentation grid defined in tokens.css: a row's icon
   box sits at `--rail-row-pad`, so its centre line is `--rail-spine`, and a
   nested group hangs a hairline spine there and steps its content by
   `--rail-step`. Nesting is structural CSS — no hard-coded pixel indents. */

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
      <span className="klide-focus-nav-icon">{icon}</span>
      <span className="klide-focus-nav-label">{label}</span>
      {expanded !== undefined && (
        <span className="klide-focus-nav-chevron" data-expanded={expanded || undefined} aria-hidden>
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
      )}
    </button>
  );
}

/** The sticky project name. Wraps the row rather than being it, so its opaque
 *  background paints *beneath* the row's own hover/active fill — a pseudo-element
 *  on the row itself could not, since negative z-index children paint above
 *  their parent's background, not below it.
 *
 *  CSS cannot tell a sticky element that it has stuck, so the pinned hairline
 *  needs an observer — and it has to watch a zero-size sentinel at the block's
 *  top rather than the header itself. Observing the header directly (ratio < 1
 *  against a 1px-shrunk root) reports "stuck" for any header that is merely
 *  clipped at the *bottom* of the scroller too, so every project below the fold
 *  wears the pinned hairline while sitting still.
 *
 *  The sentinel has one job: it scrolls away. Un-intersecting *and* above the
 *  scroller's top edge means the header has taken its place; un-intersecting
 *  below means the block simply has not been reached. */
function ProjectHead({
  scrollRoot,
  children,
}: {
  scrollRoot: React.RefObject<HTMLDivElement | null>;
  children: ReactNode;
}) {
  const sentinelRef = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(false);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    const root = scrollRoot.current;
    if (!sentinel || !root) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        const rootTop = root.getBoundingClientRect().top;
        setPinned(!entry.isIntersecting && entry.boundingClientRect.top <= rootTop);
      },
      { root, threshold: 0 },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [scrollRoot]);

  return (
    <>
      <div ref={sentinelRef} className="klide-focus-project-sentinel" aria-hidden />
      <div className="klide-focus-project-head" data-pinned={pinned || undefined}>
        {children}
      </div>
    </>
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
  revealDelay,
}: {
  convo: Conversation;
  onOpen: () => void;
  indent?: boolean;
  selected?: boolean;
  /** Set only for rows in a tree — a flat search result appears at once. */
  revealDelay?: string;
}) {
  const identity = modelIdentity(convo.model);
  const ModelLogo = identity?.Logo;

  return (
    <button
      type="button"
      onClick={onOpen}
      title={convo.title}
      className="klide-focus-convo-row"
      data-nested={indent || undefined}
      data-selected={selected || undefined}
      aria-current={selected ? "page" : undefined}
      style={
        revealDelay ? ({ "--rail-reveal-delay": revealDelay } as CSSProperties) : undefined
      }
    >
      {indent ? <TreeElbow /> : null}
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

/* ── Expand choreography ───────────────────────────────────────────────────
   Opening a project reveals its tree in two beats: the providers cascade top to
   bottom, then the conversations beneath them follow. Each row carries its own
   `--rail-reveal-delay`, computed from its index here and consumed by the
   keyframes in tokens.css — DOM order drives the cascade, so there is no stack
   of nth-child rules to keep in sync with the data.

   The steps are much shorter than each row's own animation (see the envelope in
   tokens.css), so a row starts while the row above it is still settling. That
   overlap is the whole point: it reads as one wave travelling down the tree.
   Widen these and the cascade degrades into a queue of separate animations —
   the choppiness is in the gaps, not in the durations.

   The cap matters: a project with forty conversations must not turn a half-
   second reveal into a four-second one. Past the cap rows share the last delay
   and land together. */
const PROVIDER_REVEAL_STEP_MS = 30;
const CONVO_REVEAL_STEP_MS = 20;
/** Beat between the provider wave and the conversation wave. Small on purpose:
 *  the two should overlap enough to feel continuous while still reading in
 *  order. */
const REVEAL_PHASE_GAP_MS = 40;
const REVEAL_STAGGER_CAP = 12;

/** How many projects the rail lists. The rest are reached through "More", which
 *  runs the same Open Folder… the macOS File menu does — the rail stays a short
 *  list of what you are working on rather than a full recents browser. */
const PROJECT_ROW_LIMIT = 3;

function revealDelay(index: number, stepMs: number, baseMs = 0): string {
  return `${baseMs + Math.min(index, REVEAL_STAGGER_CAP) * stepMs}ms`;
}

function ProviderHistoryGroup({
  group,
  expanded,
  selectedConversationId,
  revealIndex,
  conversationRevealBase,
  onToggle,
  onOpen,
}: {
  group: ProviderHistory;
  expanded: boolean;
  selectedConversationId?: string;
  /** Position in the provider cascade — 0 is the first to appear. */
  revealIndex: number;
  /** Delay this group's conversations wait out before their own cascade. Zero
   *  when only this provider was toggled: nothing else is animating, so the
   *  click must be answered immediately rather than after a dead pause. */
  conversationRevealBase: number;
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
      /* The wrapper carries the delay so its row, its trunk segment and its
         curve all read the same value. */
      style={{
        "--rail-reveal-delay": revealDelay(revealIndex, PROVIDER_REVEAL_STEP_MS),
      } as CSSProperties}
    >
      <button
        type="button"
        className="klide-focus-provider-history-row"
        onClick={onToggle}
        aria-expanded={expanded}
        /* Read-only is carried by the row's dimmer colour; the reason belongs
           in the tooltip, not in a badge beside the name. */
        title={`${providerName(group.provider)} · ${countLabel}${readOnly ? " · read only in Focus" : ""}`}
      >
        <TreeElbow />
        <span className="klide-focus-provider-history-logo" aria-hidden="true">
          <ProviderLogo id={group.provider} size={16} />
        </span>
        <span className="klide-focus-provider-history-name">
          {providerName(group.provider)}
        </span>
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
        /* The container's own delay drives the segment climbing back up to the
           provider's junction, so the trunk reaches down before the first
           conversation fades in. Rows then override it with their own. */
        <div
          className="klide-focus-provider-conversations"
          style={{ "--rail-reveal-delay": `${conversationRevealBase}ms` } as CSSProperties}
        >
          {group.conversations.map((conversation, index) => (
            <ConvoRow
              key={conversation.id}
              convo={conversation}
              indent
              revealDelay={revealDelay(index, CONVO_REVEAL_STEP_MS, conversationRevealBase)}
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
  controls,
}: {
  conversation: Conversation;
  projectRoot?: string | null;
  onClose: () => void;
  /** Picking the thread back up: the conversation is resumed into the live
   *  panel and this text is sent into it as the next turn. */
  onContinue: (text: string) => void;
  controls: FocusComposerControls;
}) {
  const provider = conversation.provider ?? "ollama";
  const delegate = isDelegateProvider(provider);
  const project = projectRoot
    ? basename(projectRoot)
    : conversation.cwd ? basename(conversation.cwd) : null;
  const folder = linkedFolderLabel(conversation.cwd, projectRoot);
  // Everything the meta line no longer spends a word on, on one hover.
  const duration = conversationDuration(conversation);
  const metaDetail = [
    `Started ${new Date(conversationStartedAt(conversation)).toLocaleString()}`,
    `Last activity ${new Date(conversation.updatedAt).toLocaleString()}`,
    duration >= 1000 ? `Ran ${formatSpan(duration)}` : null,
    providerName(provider),
    project,
    folder,
  ]
    .filter(Boolean)
    .join("\n");

  // With the header bar gone, Escape is what leaves — the rail is still there
  // to switch conversations, but a keyboard user needs a way out of the read.
  // Not while composing, though: leaving would take a half-written turn with
  // it, and the reader has no draft to come back to.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      const target = e.target as HTMLElement | null;
      if (target?.isContentEditable) return;
      const tag = target?.tagName;
      if (tag === "TEXTAREA" || tag === "INPUT") return;
      onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <section
      className="klide-focus-history-reader klide-focus-chat-in"
      aria-label={`Conversation history: ${conversation.title || "Untitled"}`}
    >
      <div className="klide-focus-history-scroll">
        <div className="klide-focus-history-transcript">
          {/* Identity rides at the top of the transcript and scrolls away with
              it, rather than holding a bar over the read. It sits on the same
              avatar/body grid as an assistant turn and wears the same provider
              mark, so it reads as the head of this conversation rather than a
              panel heading that happens to be above one. */}
          <header className="klide-focus-history-intro">
            <span className="klide-focus-history-avatar" aria-hidden="true">
              <ProviderLogo id={provider} size={16} />
            </span>
            <div className="klide-focus-history-intro-body">
              <h1>{conversation.title || "Untitled conversation"}</h1>
              {/* Two facts, held apart by space rather than punctuation. The
                  provider mark beside this already says who answered and the
                  rail says which project, so neither is repeated here. The
                  exact timestamp, the run's length, and the folder stay
                  available on hover — quieted, not dropped. */}
              <div className="klide-focus-history-meta">
                {conversation.model ? <span>{conversation.model}</span> : null}
                <span className="klide-focus-history-when" title={metaDetail}>
                  {relativeTime(conversationStartedAt(conversation))}
                </span>
              </div>
            </div>
          </header>
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

      {/* Continuing is not a separate mode you enter — the composer is simply
          here, the way it is everywhere else in Focus. Typing into it resumes
          this conversation and sends the turn. */}
      {delegate ? (
        <div
          className="klide-focus-history-readonly"
          title="Delegate and CLI conversations are temporarily read-only in Focus mode"
        >
          CLI history · read only
        </div>
      ) : (
        <FocusComposer
          controls={controls}
          onSubmit={onContinue}
          placeholder="Continue this conversation…"
          autoFocus={false}
        />
      )}
    </section>
  );
}

/* ----------------------------------------------------------------- screen */

export function FocusMode({
  workspaceRoot,
  branch,
  gitChangeCount,
  gitRefreshToken,
  projects,
  chatActive,
  onSwitchProject,
  onNewChat,
  onOpenConversation,
  onSubmit,
  onOpenMissionControl,
  onOpenPanel,
  onOpenSettingsSection,
  onExitFocus,
  renderChat,
  terminalOpen,
  onOpenTerminal,
  onCloseTerminal,
  renderTerminal,
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
  requireDiffReview,
  onRequireDiffReviewChange,
}: Props) {
  // Conversation groups + the hero footer name self-hosted endpoints through
  // providerName(); subscribing keeps those labels live across a rename.
  useCustomProviders();
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
  // The rail lists only the few projects you are actually moving between — a
  // long recents list buries the history it is meant to introduce. "More"
  // unfolds the rest; opening a project that is not among them is the macOS
  // menu bar's job (File ▸ Open Folder…), not a second picker in here.
  const [showAllProjects, setShowAllProjects] = useState(false);
  const visibleProjects = useMemo(() => {
    if (showAllProjects || focusProjects.length <= PROJECT_ROW_LIMIT) return focusProjects;
    const shown = focusProjects.slice(0, PROJECT_ROW_LIMIT);
    // The open project has to be on the list whatever its recency, or the rail
    // stops describing where you actually are. It takes the lead slot and the
    // least-recent of the others drops into the hidden tail.
    if (activeProjectRoot && !shown.includes(activeProjectRoot)) {
      return [activeProjectRoot, ...shown.slice(0, PROJECT_ROW_LIMIT - 1)];
    }
    return shown;
  }, [activeProjectRoot, focusProjects, showAllProjects]);
  const hiddenProjectCount = focusProjects.length - visibleProjects.length;

  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [historyConversation, setHistoryConversation] = useState<Conversation | null>(null);
  // "Ask both" strip composer — local draft, cleared on send.
  const [raceAsk, setRaceAsk] = useState("");
  const { username, hostname, avatarUrl } = useUserInfo();
  const searchRef = useRef<HTMLInputElement>(null);
  // The rail's scroller — the sticky project names observe it to know when they
  // have pinned.
  const railBodyRef = useRef<HTMLDivElement>(null);
  // Several projects can hold their history open at once. The active project
  // opens itself; the rest remember their state for the session.
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(
    () => new Set(activeProjectRoot ? [activeProjectRoot] : [])
  );
  // Absence means "follow the active provider". Explicit booleans preserve
  // the user's disclosure choice independently for every project/provider.
  // Bumped when the composer strip's branch is clicked, so the git island can
  // pulse. A counter rather than a boolean: every click has to land, including
  // two in a row, and the island only cares that the value moved.
  const [gitPing, setGitPing] = useState(0);
  const [expandedProviderGroups, setExpandedProviderGroups] = useState<Map<string, boolean>>(
    () => new Map()
  );
  // Projects whose whole tree is being revealed, so their conversations wait out
  // the provider cascade. A project drops out once a provider inside it is
  // toggled on its own — from then on that click is the only thing animating and
  // must be answered at once.
  const [cascadingProjects, setCascadingProjects] = useState<Set<string>>(
    () => new Set(activeProjectRoot ? [activeProjectRoot] : [])
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
    // Switching to a project opens its tree, so that reveal is a full cascade.
    setCascadingProjects((prev) => {
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
    setCascadingProjects((prev) => {
      const next = new Set(prev);
      next.add(p);
      return next;
    });
  }

  // `currentlyExpanded` is the state the row is actually rendering, resolved by
  // providerHistoryExpanded at the call site. Taking it from there rather than
  // recomputing a default here is the whole point: this used to fall back to
  // `historyProvider === provider`, which disagrees with the renderer's
  // "active OR newest" rule. On the newest group of a non-active provider the
  // two answers differed, so the first click wrote the value the row already
  // had and nothing moved — it took two clicks to collapse.
  function toggleProviderHistory(
    project: string,
    historyProvider: ProviderId,
    currentlyExpanded: boolean,
  ) {
    const key = providerHistoryKey(project, historyProvider);
    setExpandedProviderGroups((prev) => {
      const next = new Map(prev);
      next.set(key, !currentlyExpanded);
      return next;
    });
    // This click is now the only thing animating in that project.
    setCascadingProjects((prev) => {
      if (!prev.has(project)) return prev;
      const next = new Set(prev);
      next.delete(project);
      return next;
    });
  }

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
  // The dispatch settings the composer edits, wherever it is mounted. Both the
  // start stage and the history reader read and write this same set, so what
  // you pick while reading an old thread is what the resumed run uses.
  const composerControls = useMemo<FocusComposerControls>(
    () => ({
      workspaceRoot,
      provider,
      onProviderChange,
      model,
      onModelChange,
      effort,
      onEffortChange,
      contextWindow,
      onContextWindowChange,
      requireDiffReview,
      onRequireDiffReviewChange,
      onOpenSettingsSection,
    }),
    [
      workspaceRoot,
      provider,
      onProviderChange,
      model,
      onModelChange,
      effort,
      onEffortChange,
      contextWindow,
      onContextWindowChange,
      requireDiffReview,
      onRequireDiffReviewChange,
      onOpenSettingsSection,
    ]
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
      {/* The rail runs to the window's top edge and carries the traffic lights,
          so it doubles as the window's drag handle — its blank areas move the
          window the way a Mac sidebar does. Rows and buttons are their own
          event targets, so they still click through. */}
      <aside className="klide-focus-rail" aria-label="Focus navigation" data-tauri-drag-region>
        {/* Brand row doubles as the search row: the field takes the brand
            slot rather than pushing a new row in, so opening search never
            moves the list it filters. */}
        <div className="klide-focus-brand">
          {searchOpen ? (
            <input
              ref={searchRef}
              className="klide-focus-brand-search"
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
            />
          ) : (
            /* Reserved slot — the logo drops in here. */
            <span className="klide-focus-brand-slot" aria-hidden="true" />
          )}
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
            {searchOpen ? <CloseIcon size={RAIL_GLYPH} /> : <SearchIcon size={RAIL_GLYPH} />}
          </button>
        </div>

        <div className="klide-focus-nav-group">
          <NavRow
            icon={<NewTaskIcon size={RAIL_GLYPH} />}
            label="New task"
            onClick={() => {
              setHistoryConversation(null);
              onNewChat();
            }}
          />
          <NavRow
            icon={<MissionIcon size={RAIL_GLYPH} />}
            label="Mission Control"
            onClick={() => {
              setHistoryConversation(null);
              onOpenMissionControl();
            }}
          />
          <NavRow
            icon={<OrchestratorIcon size={RAIL_GLYPH} />}
            label="Orchestrator"
            onClick={() => {
              setHistoryConversation(null);
              onOpenPanel("orchestrator");
            }}
          />
          <NavRow
            icon={<MemoryIcon size={RAIL_GLYPH} />}
            label="Memory"
            onClick={() => {
              setHistoryConversation(null);
              onOpenPanel("memory");
            }}
          />
          <NavRow
            icon={<SkillsIcon size={RAIL_GLYPH} />}
            label="Skills"
            onClick={() => {
              setHistoryConversation(null);
              onOpenPanel("skills");
            }}
          />
        </div>

        {/* Section break — a gradient hairline, not another written label
            (the same recipe the free-mode rail uses between its zones),
            separating the actions above from the workspace list below. */}
        <div aria-hidden="true" className="klide-focus-rail-divider" />

        <div className="klide-focus-rail-body" ref={railBodyRef}>
          {searching ? (
            <>
              <SectionLabel>Results</SectionLabel>
              {filtered.length === 0 ? (
                <p className="klide-focus-rail-empty">No conversations match.</p>
              ) : (
                <div className="klide-focus-project-list">
                  {filtered.map((c) => (
                    <ConvoRow
                      key={c.id}
                      convo={c}
                      selected={historyConversation?.id === c.id}
                      onOpen={() => openHistoryConversation(c)}
                    />
                  ))}
                </div>
              )}
            </>
          ) : (
            <>
              {focusProjects.length === 0 && (
                <p className="klide-focus-rail-empty">Open a folder to start.</p>
              )}
              <div className="klide-focus-project-list">
              {visibleProjects.map((p) => {
                const isActive = p === activeProjectRoot;
                const isExpanded = expandedProjects.has(p);
                const history = convosByProject.get(p) ?? [];
                const providerHistories = providerHistoriesByProject.get(p) ?? [];
                return (
                  <div key={p} className="klide-focus-project">
                    {/* The project's name pins to the top of the rail while you
                        read down its history, and hands over when the next
                        project reaches it — so you always know whose
                        conversations you are looking at. */}
                    <ProjectHead scrollRoot={railBodyRef}>
                      <NavRow
                        icon={<FolderIcon size={14} />}
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
                    </ProjectHead>
                    {isExpanded && history.length > 0 ? (
                      <div
                        className="klide-focus-provider-groups"
                        data-contains-selected={
                          history.some((c) => c.id === historyConversation?.id) || undefined
                        }
                      >
                        {providerHistories.map((providerHistory, providerIndex) => {
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
                              revealIndex={providerIndex}
                              conversationRevealBase={
                                cascadingProjects.has(p)
                                  ? providerHistories.length * PROVIDER_REVEAL_STEP_MS +
                                    REVEAL_PHASE_GAP_MS
                                  : 0
                              }
                              onToggle={() =>
                                toggleProviderHistory(
                                  p,
                                  providerHistory.provider,
                                  providerExpanded,
                                )
                              }
                              onOpen={openHistoryConversation}
                            />
                          );
                        })}
                      </div>
                    ) : null}
                    {isExpanded && history.length === 0 ? (
                      <p className="klide-focus-rail-empty" data-nested="true">
                        No conversations yet.
                      </p>
                    ) : null}
                  </div>
                );
              })}
              {/* Unfolds the rest of the recents. Opening a project that is not
                  in that list belongs to the macOS menu bar — File ▸ Open
                  Folder… (⌘O) — so the rail never grows a second picker. */}
              {hiddenProjectCount > 0 || showAllProjects ? (
                <button
                  type="button"
                  className="klide-focus-more-projects"
                  aria-expanded={showAllProjects}
                  onClick={() => setShowAllProjects((shown) => !shown)}
                >
                  {showAllProjects ? "Less" : "More"}
                </button>
              ) : null}
              </div>
            </>
          )}
        </div>

        {/* Destinations — the same set the free-mode rail's bottom zone
            renders, read from one definition (../railDestinations) so adding
            one never means editing two rails. Focus draws them as labeled
            rows like every other row here; Profile is the exception, drawn as
            the identity card because it has a name and a host to show. */}
        <div className="klide-rail-dest-group">
          <NavRow
            icon={<settingsDest.Icon size={15} />}
            label={settingsDest.label}
            onClick={() => {
              setHistoryConversation(null);
              onOpenPanel("settings");
            }}
          />
          {/* Identity row — the profile card takes the space its name and host
              need, and the view switch hangs off the ragged right edge. Focus
              has no status bar, so this is the way back to the panel
              workspace; it sits apart from the destinations above because it
              changes the shell rather than opening a surface. */}
          <div className="klide-rail-identity-row">
            <button
              type="button"
              className="klide-rail-profile"
              aria-label={`Open ${profileDest.label.toLowerCase()}`}
              title={profileDest.label}
              onClick={() => onOpenPanel("profile")}
            >
              <span className="klide-rail-profile-avatar" aria-hidden>
                {initialsOf(username || "?")}
                {avatarUrl ? (
                  <img
                    src={avatarUrl}
                    alt=""
                    onError={(event) => { event.currentTarget.style.display = "none"; }}
                  />
                ) : null}
              </span>
              <span className="klide-rail-profile-identity">
                <span className="klide-rail-profile-name">{username || "Local profile"}</span>
                <span className="klide-rail-profile-host">{hostname}</span>
              </span>
            </button>
            {/* Terminal — icon only, on the rail's bottom-right edge beside the
                view switch. It earns no label: it toggles a dock rather than
                opening a destination, and the two shell-level controls read as
                a pair down here instead of another written row above. */}
            <button
              type="button"
              className="klide-rail-view-switch"
              data-active={terminalOpen || undefined}
              aria-label={terminalOpen ? "Hide the terminal" : "Show the terminal"}
              aria-pressed={terminalOpen}
              title={terminalOpen ? "Hide the terminal" : "Terminal"}
              onClick={() => (terminalOpen ? onCloseTerminal() : onOpenTerminal())}
            >
              <TerminalIcon size={14} />
            </button>
            <button
              type="button"
              className="klide-rail-view-switch"
              aria-label="Leave Focus — Free layout"
              title="Leave Focus — Free layout"
              onClick={onExitFocus}
            >
              <FreeLayoutIcon size={14} />
            </button>
          </div>
        </div>
      </aside>

      {/* ── Canvas ────────────────────────────────────────────────── */}
      {/* Its top inset is the title-bar band, so that strip drags the window
          too — the canvas below it keeps its own clicks. */}
      <main className="klide-focus-main" data-tauri-drag-region>
        {workspaceRoot && !chatActive && !historyConversation ? (
          <FocusGitIsland
            workspaceRoot={workspaceRoot}
            branch={branch}
            changeCount={gitChangeCount}
            avatarUrl={avatarUrl}
            profileInitials={initialsOf(username || "?")}
            refreshToken={gitRefreshToken}
            pingToken={gitPing}
            onOpen={() => onOpenPanel("git")}
          />
        ) : null}
        {historyConversation ? (
          <HistoryReader
            conversation={historyConversation}
            projectRoot={linkedProjectByConversationId.get(historyConversation.id)}
            onClose={() => setHistoryConversation(null)}
            onContinue={(text) => {
              const conversation = historyConversation;
              setHistoryConversation(null);
              onOpenConversation(conversation, text);
            }}
            controls={composerControls}
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
            onPingGit={() => setGitPing((n) => n + 1)}
            recent={projectConvos.slice(0, 3)}
            onOpenConversation={onOpenConversation}
            onSubmit={onSubmit}
            controls={composerControls}
          />
        )}
        </div>
        {/* Terminal — a bottom dock under the canvas, not a replacement for it:
            the conversation (or the home hero) stays put above and keeps its
            mount, so a running turn is never interrupted by reaching for a
            shell. The parent owns the whole dock — height, drag handle, slide —
            because the drawer's height is remembered app-wide; this is only
            the slot it lands in. */}
        {renderTerminal()}
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
  /** Quiet the row (or a whole stack's eyebrow): it exists but isn't usable
   *  yet — a provider with no API key resolved, for instance. */
  dimmed?: boolean;
  /** Turns the row into a way out instead of a choice: it grows a trailing ↗
   *  and clicking anywhere on it runs this rather than selecting the value.
   *  Focus uses it to send keyless providers to Settings → API keys. */
  resolve?: { title: string; run: () => void };
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

/** The "this leads out of here" mark — a small arrow to the top-right, the
 *  same stroke language as the rail glyphs. Sits at the end of a menu row that
 *  opens Settings instead of selecting a value. */
function ArrowUpRightIcon({ size = 12 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M7 17 17 7" />
      <path d="M8 7h9v9" />
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
  /** The picker header: framed icon + title + quiet caption. Omit it when the
   *  trigger already names what the menu is — the provider picker opens right
   *  under a logo and a provider name, so a "Provider / where this runs" block
   *  is a sentence you've already read. Skipping it also lets the glass show
   *  through the whole card instead of being capped by a tinted bar. */
  header?: { icon: ReactNode; title: string; caption: string };
  width?: number;
  /** "ring" renders the AI panel's context-meter circle as the trigger —
   *  28px round button, border track ring, accent arc — instead of text.
   *  `ringRatio` (0..1) drives the arc; the panel floors it at 2 so the glyph
   *  always reads as a meter.
   *
   *  **A ring means "this much of the window is used".** The context-window
   *  menu used to render one from `contextWindow / 131072` — the size the user
   *  had *chosen*, divided by the largest option. Picking 128K read as 100%
   *  full, 32K as 25%, and the default "Auto" sat on the 2% floor forever,
   *  while the visually identical ring in the AI panel showed real measured
   *  usage. There is no usage to show on the start stage — no conversation
   *  exists yet — so a setting gets a label, not a gauge. Only pass `ringRatio`
   *  a measured fraction. */
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
          className="popover-enter menu-glass"
          style={{
            position: "fixed",
            bottom: menuPos.bottom,
            left: menuPos.left,
            width,
            maxHeight: 340,
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
            zIndex: Z.popover,
          }}
        >
          {/* Header — same frame as the ModelPicker's: a bordered icon tile,
              the menu's name, and a quiet caption. Menus whose trigger already
              names them go without, and open straight onto their options. */}
          {header && (
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
          )}
          <div className="menu-scroll" style={{ flex: 1, minHeight: 0, overflow: "auto", padding: 5 }}>
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
                      opacity: o.dimmed ? 0.5 : 1,
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
                  title={o.resolve?.title}
                  onClick={() => {
                    setOpen(false);
                    if (o.resolve) {
                      o.resolve.run();
                      return;
                    }
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
                      ? "var(--menu-row-active)"
                      : focused
                        ? "var(--menu-row-hover)"
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
                          opacity: o.dimmed ? 0.4 : 1,
                          transition: "opacity var(--motion-fast) var(--ease-out)",
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
                        opacity: o.dimmed ? 0.45 : 1,
                        transition: "opacity var(--motion-fast) var(--ease-out)",
                      }}
                    >
                      {o.label}
                    </span>
                    {o.resolve && (
                      <span
                        className="menu-leadout"
                        style={{ flexShrink: 0, display: "grid", placeItems: "center" }}
                      >
                        <ArrowUpRightIcon />
                      </span>
                    )}
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
//
// `custom` adds the "Self-hosted" stack, so an endpoint configured in Settings
// can start a Focus conversation without going through a standard AI panel
// first. Those rows are never quieted: a self-hosted endpoint may need no auth
// at all, and the ones that do resolve a `${VAR}` reference outside the
// keychain — "no key" there is not the same signal it is for a hosted API.
//
// A provider in `keyless` has no key Rust can resolve, so it can't run: the row
// is quieted and routes to Settings → API keys instead of being selectable, and
// a stack whose every row is keyless is quieted along with them.
export function buildProviderOptions(
  custom: CustomProvider[],
  keyless: ReadonlySet<string>,
  onOpenKeySettings: () => void,
): MenuOption[] {
  return providerGroupsWithCustom(custom).flatMap((group) => {
    // Focus currently supports native API/local runs only. Delegate CLIs mount
    // a separate PTY surface and stay out of this picker until that path is
    // stable.
    const items = group.items.filter((item) => item.available && !isDelegateProvider(item.id));
    if (items.length === 0) return [];
    const rows: MenuOption[] = items.map((item) => {
      const missingKey = keyless.has(item.id) && !isCustomProvider(item.id);
      return {
        label: item.name,
        value: item.id,
        icon: <ProviderLogo id={item.id} size={17} />,
        dimmed: missingKey,
        // No caption: the quieted row plus its ↗ already say "not set up, and
        // here's the way out". A sentence under every hosted provider would
        // turn a glance into a read.
        resolve: missingKey
          ? { title: `${item.name} has no API key — open Settings`, run: onOpenKeySettings }
          : undefined,
      };
    });
    return [
      {
        label: group.label,
        value: `__heading_${group.label}`,
        heading: true,
        dimmed: rows.every((row) => row.dimmed),
      },
      ...rows,
    ];
  });
}

/** Hosted providers offered in the picker — the rows worth probing for a key. */
const KEYED_PROVIDERS = PROVIDER_GROUPS.flatMap((group) => group.items).filter(
  (item) => item.available && providerNeedsApiKey(item.id),
);

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


/** Focus home's counterpart to the live AI panel's + menu. It persists the
 *  selected mode before the first message hands off to AiPanel, so the first
 *  run and every later turn share one mode/review setting. */
function FocusAddMenu({
  workspaceRoot,
  mode,
  supportsTools,
  requireDiffReview,
  onModeChange,
  onRequireDiffReviewChange,
  onAddFile,
}: {
  workspaceRoot: string | null;
  mode: AgentMode;
  supportsTools: boolean;
  requireDiffReview: boolean;
  onModeChange: (mode: AgentMode) => void;
  onRequireDiffReviewChange: (required: boolean) => void;
  onAddFile: (path: string) => void;
}) {
  const [view, setView] = useState<"actions" | "files">("actions");
  const [files, setFiles] = useState<string[] | null>(null);
  const [fileQuery, setFileQuery] = useState("");
  const fileSearchRef = useRef<HTMLInputElement>(null);
  const {
    open,
    pos,
    triggerRef,
    menuRef,
    openMenu,
    close,
  } = usePortalMenu({
    closeOnOutsideClick: true,
    computePos: (rect) => {
      const width = 238;
      return {
        bottom: Math.round(window.innerHeight - rect.top + 8),
        left: Math.round(Math.min(Math.max(8, rect.left), window.innerWidth - width - 8)),
      };
    },
  });

  useEffect(() => {
    setFiles(null);
    setFileQuery("");
    setView("actions");
    close();
  }, [workspaceRoot, close]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") close();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  async function showFiles() {
    if (!workspaceRoot) return;
    setView("files");
    setFileQuery("");
    requestAnimationFrame(() => fileSearchRef.current?.focus());
    if (files !== null) return;
    try {
      setFiles(await listWorkspaceFiles(workspaceRoot));
    } catch {
      setFiles([]);
    }
  }

  function toggle() {
    if (open) {
      close();
      return;
    }
    setView("actions");
    openMenu();
  }

  // Through the shared ladder. Focus's own copy of this rule omitted the
  // delegate exemption; it didn't bite only because Focus filters delegates out
  // of its picker, which is a coincidence rather than a reason.
  const effectiveMode = effectiveModeFor({
    mode,
    modelSupportsTools: supportsTools,
    providerDelegatesWork: false,
  });
  const activeKey = effectiveMode === "goal"
    ? requireDiffReview ? "goal-review" : "goal-auto"
    : effectiveMode;
  const matchingFiles = (files ?? [])
    .filter((path) => !fileQuery || isSubsequence(fileQuery, path))
    .slice(0, 12);

  return (
    <div style={{ display: "flex", flexShrink: 0 }}>
      <button
        ref={triggerRef}
        type="button"
        onClick={toggle}
        title="Add files and more"
        aria-label="Add files and choose a mode"
        aria-haspopup="menu"
        aria-expanded={open}
        className="klide-focus-add"
        data-open={open || undefined}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
          <path d="M12 5v14M5 12h14" />
        </svg>
      </button>
      {open && pos && createPortal(
        <div
          ref={menuRef}
          role="menu"
          aria-label={view === "files" ? "Add a file" : "Add files and choose a mode"}
          className="popover-enter menu-glass klide-focus-add-menu"
          style={{ left: pos.left, bottom: pos.bottom, zIndex: Z.popover }}
        >
          {view === "files" ? (
            <>
              <div className="klide-focus-add-menu-header">
                <button type="button" onClick={() => setView("actions")} aria-label="Back to actions">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="m15 18-6-6 6-6" />
                  </svg>
                </button>
                <input
                  ref={fileSearchRef}
                  value={fileQuery}
                  onChange={(e) => setFileQuery(e.target.value)}
                  placeholder="Find a workspace file…"
                  aria-label="Find a workspace file"
                />
              </div>
              <div className="klide-focus-add-file-list">
                {files === null ? (
                  <div className="klide-focus-add-empty">Loading files…</div>
                ) : matchingFiles.length === 0 ? (
                  <div className="klide-focus-add-empty">No matching files</div>
                ) : matchingFiles.map((path) => (
                  <button
                    key={path}
                    type="button"
                    role="menuitem"
                    title={path}
                    onClick={() => {
                      close();
                      onAddFile(path);
                    }}
                  >
                    {path}
                  </button>
                ))}
              </div>
            </>
          ) : (
            <>
              <button
                type="button"
                role="menuitem"
                className="klide-focus-add-menu-row"
                disabled={!workspaceRoot}
                onClick={() => void showFiles()}
              >
                <span>Add file</span>
                <span className="klide-focus-add-menu-meta">@</span>
              </button>
              <div className="klide-focus-add-menu-divider" />
              {AUTONOMY_RUNGS.map((choice) => {
                const disabled = choice.mode === "goal" && !supportsTools;
                const active = choice.key === activeKey;
                return (
                  <button
                    key={choice.key}
                    type="button"
                    role="menuitemradio"
                    aria-checked={active}
                    disabled={disabled}
                    title={disabled ? "This model cannot use edit tools" : choice.description}
                    className="klide-focus-add-menu-row"
                    onClick={() => {
                      if (disabled) return;
                      onModeChange(choice.mode);
                      if (choice.mode === "goal" && choice.review !== null) {
                        onRequireDiffReviewChange(choice.review);
                      }
                      close();
                    }}
                  >
                    <span>
                      {choice.label}
                      <small>{choice.description}</small>
                    </span>
                    {active ? (
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M20 6 9 17l-5-5" />
                      </svg>
                    ) : null}
                  </button>
                );
              })}
            </>
          )}
        </div>,
        document.body
      )}
    </div>
  );
}

/** Everything the composer needs beyond its own draft. Bundled because the
 *  composer now has two homes — the start stage and the history reader — and
 *  threading fourteen props through both invites them to drift apart. There is
 *  one composer in Focus, the same way there is one chat surface. */
export type FocusComposerControls = {
  workspaceRoot: string | null;
  provider: ProviderId;
  onProviderChange: (provider: ProviderId) => void;
  model: string;
  onModelChange: (model: string) => void;
  effort: string | undefined;
  onEffortChange: (effort: string | undefined) => void;
  contextWindow: number | undefined;
  onContextWindowChange: (window: number | undefined) => void;
  requireDiffReview: boolean;
  onRequireDiffReviewChange: (required: boolean) => void;
  onOpenSettingsSection: (section: string) => void;
};

/** The bottom-anchored task dock: context strip, textarea, and the provider /
 *  model / effort / context controls that decide how the next run is dispatched.
 *  Mounted by the start stage and by the history reader, so "send" always means
 *  the same thing and the run always reaches the same Rust harness. */
function FocusComposer({
  controls,
  branch,
  onPingGit,
  onSubmit,
  placeholder = "Describe a task or ask a question…",
  autoFocus = true,
}: {
  controls: FocusComposerControls;
  /** Omitted in the history reader — the strip points at the current checkout,
   *  which has nothing to do with the conversation being read. */
  branch?: string | null;
  onPingGit?: () => void;
  onSubmit: (text: string) => void;
  placeholder?: string;
  /** The start stage takes the caret on arrival; the history reader does not —
   *  you opened it to read, and the cursor jumping to the composer would say
   *  otherwise. */
  autoFocus?: boolean;
}) {
  const {
    workspaceRoot,
    provider,
    onProviderChange,
    model,
    onModelChange,
    effort,
    onEffortChange,
    contextWindow,
    onContextWindowChange,
    requireDiffReview,
    onRequireDiffReviewChange,
    onOpenSettingsSection,
  } = controls;
  const [draft, setDraft] = useState("");
  const [focused, setFocused] = useState(false);
  const [agentMode, setAgentMode] = useState<AgentMode>(
    () => normalizeAgentMode(localStorage.getItem("klide.agentMode"))
  );
  const [supportsTools, setSupportsTools] = useState(true);
  const taRef = useRef<HTMLTextAreaElement>(null);
  // The model list for the chosen provider — the same discovery command the
  // AI panel and Settings use. Falls back to the provider's default so the
  // menu is never empty while a server is down.
  const [models, setModels] = useState<string[]>([]);
  // Hosted providers with no key Rust can resolve. Probed once per mount —
  // opening Settings unmounts Focus, so coming back re-probes and a provider
  // you just configured stops reading as keyless. A failed probe leaves the
  // row alone rather than quieting a provider that might work.
  const [keylessProviders, setKeylessProviders] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );

  useEffect(() => {
    let cancelled = false;
    void Promise.all(
      KEYED_PROVIDERS.map(async (item) => {
        try {
          const status = await readProviderKeyStatus(item.id);
          return status.hasKey ? null : item.id;
        } catch {
          return null;
        }
      }),
    ).then((probed) => {
      if (!cancelled) setKeylessProviders(new Set(probed.filter((id): id is ProviderId => !!id)));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Self-hosted endpoints, from the shared store — it refreshes on mount and
  // republishes on add/rename/remove, so the stack here matches Settings
  // without leaving Focus.
  const customProviders = useCustomProviders();
  const providerMenuOptions = useMemo(
    () => buildProviderOptions(customProviders, keylessProviders, () => onOpenSettingsSection("api")),
    [customProviders, keylessProviders, onOpenSettingsSection],
  );

  useEffect(() => {
    let cancelled = false;
    // defaultModelForProvider resolves a self-hosted id through the custom
    // store, so an endpoint's pinned default is offered even if /models is
    // unreachable.
    const fallback = [model, defaultModelForProvider(provider)].filter(Boolean) as string[];
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
    let cancelled = false;
    queryModelSupportsTools(provider, model)
      .then((supported) => {
        if (!cancelled) setSupportsTools(supported);
      })
      .catch(() => {
        if (!cancelled) setSupportsTools(true);
      });
    return () => {
      cancelled = true;
    };
  }, [provider, model]);

  useEffect(() => {
    if (autoFocus) taRef.current?.focus();
  }, [autoFocus]);

  function submit() {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    onSubmit(text);
  }

  function selectAgentMode(next: AgentMode) {
    setAgentMode(next);
    localStorage.setItem("klide.agentMode", next);
  }

  function addFile(path: string) {
    const textarea = taRef.current;
    const caret = textarea?.selectionStart ?? draft.length;
    const before = draft.slice(0, caret);
    const after = draft.slice(caret);
    const prefix = before.length === 0 || before.endsWith(" ") ? "" : " ";
    const inserted = `${before}${prefix}@${path} `;
    const next = inserted + after;
    setDraft(next);
    requestAnimationFrame(() => {
      textarea?.focus();
      textarea?.setSelectionRange(inserted.length, inserted.length);
    });
  }

  const canSend = draft.trim().length > 0;

  // The persistent task dock combines Codex's context ribbon with Claude's
  // bottom-anchored composer.
  return (
    <div className="klide-focus-composer-dock">
      {branch && onPingGit && (
        <div className="klide-focus-context-strip" role="group" aria-label="Task context">
          <button
            type="button"
            onClick={onPingGit}
            title={`On ${branch} — show me the git panel`}
          >
            <GitIcon size={13} />
            {branch}
          </button>
        </div>
      )}

      <div className="klide-focus-composer" data-focused={focused || undefined}>
        <textarea
          ref={taRef}
          name="task-prompt"
          aria-label={placeholder}
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
          placeholder={placeholder}
          rows={2}
        />

        <div className="klide-focus-composer-footer">
          <div className="klide-focus-provider-control">
            <FocusAddMenu
              workspaceRoot={workspaceRoot}
              mode={agentMode}
              supportsTools={supportsTools}
              requireDiffReview={requireDiffReview}
              onModeChange={selectAgentMode}
              onRequireDiffReviewChange={onRequireDiffReviewChange}
              onAddFile={addFile}
            />
            <InlineMenu
              label="Provider"
              display={providerName(provider)}
              leading={<ProviderLogo id={provider} size={13} />}
              options={providerMenuOptions}
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
              header={{
                icon: <ContextGaugeIcon />,
                title: "Context window",
                // Klide can't set the window on a self-hosted OpenAI-wire
                // endpoint — the server owns it (num_ctx in a Modelfile, and
                // so on). Say so here rather than let the override read as
                // if it reached the server. Same signal the AI panel gives.
                caption: isCustomProvider(provider)
                  ? "Set server-side for a self-hosted endpoint"
                  : "Override the auto-detected window",
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
              <SendIcon size={14} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function FocusHome({
  projectName,
  branch,
  onPingGit,
  recent,
  onOpenConversation,
  onSubmit,
  controls,
}: {
  projectName: string | null;
  branch: string | null;
  /** Draw the eye to the git island — the branch in the context strip is the
   *  one thing in there that has somewhere to point. */
  onPingGit: () => void;
  recent: Conversation[];
  onOpenConversation: (convo: Conversation) => void;
  onSubmit: (text: string) => void;
  controls: FocusComposerControls;
}) {
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

      <FocusComposer
        controls={controls}
        branch={branch}
        onPingGit={onPingGit}
        onSubmit={onSubmit}
      />
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
            data-bare="true"
            title={identity.name}
            aria-hidden="true"
          >
            <ModelLogo size={24} />
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
