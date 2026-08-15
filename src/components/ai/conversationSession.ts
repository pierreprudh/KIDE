import type { ProviderId } from "../../agent/types";
import { isDelegateProvider } from "../../agent/providers";
import type { Conversation, Msg } from "./types";
import {
  deriveTitle,
  latestRestorableConversationId,
  loadConversations,
  loadPanelSession,
  messagesForPersist,
  savePanelSession,
  type PanelSession,
} from "./storedConversations";
import { genId } from "./utils";

export type ConversationRunActivity = "thinking" | "waiting" | null;

/**
 * The complete live state of one AI-panel Conversation. Keeping these fields
 * together makes identity changes atomic: a resume or branch cannot adopt new
 * messages while accidentally retaining the previous Conversation's lineage
 * or Git metadata. The durable panel↔Conversation binding is part of that
 * atomicity: apply transitions through `applyConversationSessionTransition`,
 * which writes the binding for every identity-carrying transition — a caller
 * cannot adopt a new identity and forget to persist it.
 */
export type ConversationSession = {
  conversationId: string;
  messages: Msg[];
  provider: ProviderId;
  model: string;
  workspaceRoot: string | null;
  branch: string | null;
  worktree: string | null;
  forkedFrom: Conversation["forkedFrom"];
  run: {
    active: boolean;
    activity: ConversationRunActivity;
  };
};

export type RestoreConversationSessionInput = {
  panelId?: string;
  initialConversationId?: string | null;
  provider: ProviderId;
  model: string;
  workspaceRoot: string | null;
  /** Branch currently checked out when a new Conversation identity is
   *  created. Restored Conversations keep their own recorded branch. */
  workspaceBranch?: string | null;
  /** A composer handoff that semantically starts a new Conversation must not
   *  inherit this panel's durable binding or latest saved Conversation. */
  startFresh?: boolean;
  createId?: () => string;
};

export type ConversationSessionAction =
  | { type: "messages-replaced"; messages: Msg[] }
  | {
      type: "configured";
      provider?: ProviderId;
      model?: string;
      workspaceRoot?: string | null;
    }
  | { type: "fresh-started"; conversationId: string; branch?: string | null }
  | { type: "branch-captured"; branch: string }
  | { type: "resumed"; conversation: Conversation }
  | {
      type: "branched";
      conversationId: string;
      messageIndex: number;
      mode: "chat" | "worktree";
      createdAt: number;
    }
  | { type: "run-started"; activity?: ConversationRunActivity }
  | { type: "run-settled" };

function workspaceMatches(conversation: Conversation, workspaceRoot: string | null): boolean {
  return !workspaceRoot || !conversation.cwd || conversation.cwd === workspaceRoot;
}

/**
 * Restore one Conversation session in precedence order: an explicit reattach,
 * the panel's durable binding, the primary panel's latest Conversation, then a
 * fresh identity. The entire saved Conversation is adopted in one read.
 */
export function restoreConversationSession({
  panelId,
  initialConversationId,
  provider,
  model,
  workspaceRoot,
  workspaceBranch = null,
  startFresh = false,
  createId = genId,
}: RestoreConversationSessionInput): ConversationSession {
  if (startFresh) {
    return {
      conversationId: createId(),
      messages: [],
      provider,
      model,
      workspaceRoot,
      branch: workspaceBranch,
      worktree: null,
      forkedFrom: null,
      run: { active: false, activity: null },
    };
  }

  const conversations = loadConversations<Conversation>();
  const byId = new Map(conversations.map((conversation) => [conversation.id, conversation]));
  const explicitId = initialConversationId || null;
  const panelBinding = panelId ? loadPanelSession(panelId) : null;
  const boundConversation = panelBinding ? byId.get(panelBinding.convoId) : undefined;
  const panelWorkspaceMatches =
    !panelBinding ||
    panelBinding.workspaceRoot === undefined ||
    panelBinding.workspaceRoot === workspaceRoot;
  const boundProvider = panelBinding?.provider ?? provider;
  const bindingIsScoped =
    panelBinding?.workspaceRoot !== undefined && panelBinding.provider !== undefined;
  const canUsePanelBinding =
    !!panelBinding &&
    panelWorkspaceMatches &&
    (bindingIsScoped ||
      isDelegateProvider(boundProvider) ||
      (!!boundConversation && workspaceMatches(boundConversation, workspaceRoot)));
  const latestId =
    !explicitId &&
    !canUsePanelBinding &&
    !isDelegateProvider(provider) &&
    (!panelId || panelId === "ai-main")
      ? latestRestorableConversationId(workspaceRoot, provider)
      : null;
  const conversationId =
    explicitId ??
    (canUsePanelBinding ? panelBinding?.convoId ?? null : null) ??
    latestId ??
    createId();
  const saved = byId.get(conversationId);

  return {
    conversationId,
    messages: saved?.msgs ?? [],
    provider: saved?.provider ?? (canUsePanelBinding ? boundProvider : provider),
    model: saved?.model || model,
    workspaceRoot,
    // A restored Conversation without branch metadata predates branch
    // capture. Treat that as unknown: assigning today's checked-out branch
    // would rewrite its history and make navigation look like branch creation.
    // A genuinely new identity still snapshots the live branch.
    branch: saved ? saved.branch ?? null : workspaceBranch,
    worktree: saved?.worktree ?? null,
    forkedFrom: saved?.forkedFrom ?? null,
    run: { active: false, activity: null },
  };
}

export function conversationSessionReducer(
  session: ConversationSession,
  action: ConversationSessionAction,
): ConversationSession {
  switch (action.type) {
    case "messages-replaced":
      return { ...session, messages: action.messages };
    case "configured":
      return {
        ...session,
        provider: action.provider ?? session.provider,
        model: action.model ?? session.model,
        workspaceRoot:
          action.workspaceRoot === undefined ? session.workspaceRoot : action.workspaceRoot,
      };
    case "fresh-started":
      return {
        ...session,
        conversationId: action.conversationId,
        messages: [],
        branch: action.branch ?? null,
        worktree: null,
        forkedFrom: null,
        run: { active: false, activity: null },
      };
    case "branch-captured":
      return { ...session, branch: action.branch };
    case "resumed": {
      const conversation = action.conversation;
      return {
        ...session,
        conversationId: conversation.id,
        messages: conversation.msgs,
        provider: conversation.provider ?? session.provider,
        model: conversation.model || session.model,
        branch: conversation.branch ?? null,
        worktree: conversation.worktree ?? null,
        forkedFrom: conversation.forkedFrom ?? null,
        run: { active: false, activity: null },
      };
    }
    case "branched":
      return {
        ...session,
        conversationId: action.conversationId,
        messages: session.messages.slice(0, action.messageIndex + 1),
        forkedFrom: {
          conversationId: session.conversationId,
          title: deriveTitle(session.messages),
          messageIndex: action.messageIndex,
          createdAt: action.createdAt,
          mode: action.mode,
        },
        run: { active: false, activity: null },
      };
    case "run-started":
      return {
        ...session,
        run: { active: true, activity: action.activity ?? null },
      };
    case "run-settled":
      return { ...session, run: { active: false, activity: null } };
  }
}

/** The Conversation's recorded branch is historical truth. Older snapshots
 * without branch metadata remain unknown instead of borrowing today's branch. */
export function displayedConversationBranch(
  conversationBranch: string | null | undefined,
): string | null {
  return conversationBranch ?? null;
}

/** Injectable durable write, so tests can prove the binding lands without a
 *  real localStorage. Production uses `savePanelSession`. */
export type PanelBindingWrite = (panelId: string, binding: PanelSession) => void;

/** The durable panel↔Conversation binding this session state implies. */
export function sessionPanelBinding(session: ConversationSession): PanelSession {
  return {
    convoId: session.conversationId,
    provider: session.provider,
    workspaceRoot: session.workspaceRoot,
  };
}

/** The single place the durable panel binding is written. AiPanel's delegate
 *  panels call this directly (their binding must be durable the moment the
 *  provider/convo pair binds, not on a transition); everything else goes
 *  through `applyConversationSessionTransition` below. */
export function persistConversationSessionBinding(
  panelId: string,
  session: ConversationSession,
  write: PanelBindingWrite = savePanelSession,
): void {
  write(panelId, sessionPanelBinding(session));
}

/** Which transitions must land in the durable panel binding. Identity changes
 *  (fresh, resume, branch) and Provider changes rebind the panel; a Run start
 *  re-asserts the binding so a mid-run view switch reattaches to this
 *  Conversation even when it was restored without ever transitioning.
 *  Message streaming and Run settle change no binding field. */
function transitionRebindsPanel(action: ConversationSessionAction): boolean {
  switch (action.type) {
    case "fresh-started":
    case "resumed":
    case "branched":
    case "run-started":
      return true;
    case "configured":
      return action.provider !== undefined || action.workspaceRoot !== undefined;
    case "messages-replaced":
    case "branch-captured":
    case "run-settled":
      return false;
  }
}

/**
 * Apply one transition *and* its durable persist. The reducer above stays
 * pure (React mirrors state through it), but an identity transition is not
 * complete until the panel binding is durable — previously each call site had
 * to remember its own `savePanelSession`, and ~8 scattered writes kept that
 * promise by hand. Returns the next session; the binding write happens here.
 */
export function applyConversationSessionTransition(
  session: ConversationSession,
  action: ConversationSessionAction,
  panelId: string | null | undefined,
  write?: PanelBindingWrite,
): ConversationSession {
  const next = conversationSessionReducer(session, action);
  if (panelId && transitionRebindsPanel(action)) {
    persistConversationSessionBinding(panelId, next, write);
  }
  return next;
}

/** Build the durable Conversation snapshot. Empty sessions are intentionally
 * not persisted; a trailing empty assistant placeholder is removed. */
export function snapshotConversationSession(
  session: ConversationSession,
  updatedAt = Date.now(),
): Conversation | null {
  const messages = messagesForPersist(session.messages);
  if (messages.length === 0) return null;
  // The first stamped message is the thread's start. `upsertConversation`
  // keeps whatever the stored record already had, so this only ever sets it
  // on the first save.
  const firstStamped = messages.find((m) => typeof (m as { ts?: number }).ts === "number");
  return {
    id: session.conversationId,
    title: deriveTitle(messages),
    msgs: messages,
    updatedAt,
    createdAt: (firstStamped as { ts?: number } | undefined)?.ts ?? updatedAt,
    provider: session.provider,
    model: session.model,
    cwd: session.workspaceRoot,
    branch: session.branch,
    worktree: session.worktree,
    forkedFrom: session.forkedFrom ?? null,
  };
}
