# Changelog

Notable changes per milestone. Dates are completion dates.

## Unreleased (0.6.1)

Work on the v0.6 line. The orchestration milestone itself — Missions as
outcomes, budgets, capacity, capability routing, validation contracts — is still
open; these are the shell and correctness changes landed so far.

### One sidebar

- Focus and the free/anchored workbench now render **the same rail**
  (`WorkspaceRail`). There used to be two components — Focus's full-height rail
  over a project tree, and a separate icon-strip `ActivityBar` — which shared a
  few classes, drifted anyway, and made one workspace look like two different
  apps depending on the layout. The workbench keeps the panel tools only it can
  open (Explorer, Git, AI) by passing them in `nav`; that array and where a
  conversation lands are the only things the shells still differ in.
- The workbench therefore gains the **conversation history** that existed in
  Focus alone: projects, provider groups, search. Opening a row resumes it into
  an AI panel — into the panel already holding it, if one is.
- The tree marks **every conversation currently loaded**, not just one. Free
  mode can hold several at once across panels, and the rail is the only surface
  that can say which — so it says it the way this rail says everything, in the
  text: open rows go strong, and the one you are actually looking at keeps the
  accent route through the branch, because the route is what means "here" and
  there is only ever one here. No dot, no badge, no pill.
- Marking them is not enough, so the tree also **keeps them reachable**: an open
  conversation pins itself into its group's collapsed row window, its provider
  group and project unfold when it is loaded (once, on the transition — you can
  still fold it away), and a project holding one never drops into the "More"
  tail on recency. A conversation the rail claims is open can always be found.
- Gone with the ActivityBar: its collapse-to-56px pebble, the hover flyouts, and
  the Settings-section submenu. The rail is one width in every layout.

### Focus rail

- The rail is a flat surface again: one hairline on its inner edge instead of a
  30px `backdrop-filter`, a drop shadow and an inset highlight stacked together.
  Rows moved onto the app-wide soft-fill recipe, and radii, heights and weights
  onto the token scale.
- Nesting rebuilt on a single indentation grid, so a child's icon lands exactly
  where its parent's label began at every level and rail width.
- The tree reads as one continuous line. The vertical was a CSS border and the
  curve an SVG stroke in a different colour, with the curve redrawing its own
  stub over the border, so the join was visible. Both now share one colour
  token; the turn is an exact quarter-arc, tangent where it leaves the trunk and
  where it reaches the row; the vertical belongs to each item, so it ends at the
  last junction instead of dangling past it and climbs to its parent's junction
  instead of starting a row late.
- The tree clears row icons on both axes, measured from the icon box rather than
  the artwork — the horizontal run used to cross any provider mark that fills
  its box, and the trunk descended through the parent glyph it hung from.
- Expanding a project draws its tree: trunk grows down, curve unrolls, row
  fades, overlapping into one wave that runs providers first and then
  conversations. Rows only fade, because translating one would drag its curve
  off the trunk for the length of the animation.
- Project names pin to the top of the rail while their history scrolls, with the
  pinned state detected from a sentinel — observing the header itself reports
  "stuck" for any header merely clipped at the bottom of the scroller.
- The project list is capped with a quiet More toggle, the "Projects" eyebrow is
  gone, and the rail has its own 6px scrollbar instead of the app-wide 10px one.
- A Git island on the Focus canvas, rail destination rows and an identity row.

### Menus

- Rust owns the application menu. The frontend had been calling
  `Menu.default().append(Projects).setAsAppMenu()`, and `Menu.default()` is
  Tauri's *stock* menu whose macOS File submenu holds nothing but Close Window —
  so every rebuild, including one per change to the recents list, silently
  replaced the real menu and took Open Folder, Close Tab, Find in Files, the
  Command Palette and Settings with it. The frontend now calls
  `menu_sync_projects` and Rust stays the only writer.
- File gains Open Project… (⌘O), Open Recent, Save (⌘S) and Close Project; Edit
  and View are restored.

### Harness and providers

- Subagents are the harness's own work. `spawn_subagent` used to emit an event
  and park on the question pause while the AI panel resolved the role, composed
  the child prompt, ran the nested Run, and answered with its last message — so
  closing or reloading the panel mid-subagent left the parent parked forever and
  its report lost. The Rust harness now owns all of it behind the supervisor
  seam: the role comes from `agent::subagents`, the child inherits the parent's
  system prompt with a role block appended, and the report is read from the
  child's transcript, which is durable. A subagent survives a panel unmount, a
  reload and a reattach, like every other Harness run.
- Cancelling a run now cancels the subagent it is waiting on, instead of
  orphaning a child that keeps running headless.
- A run that names an editing subagent is refused. The tool promises a delegate
  that "cannot edit", and only the schema's `enum` was holding that line; the
  model's menu is now derived from the roles that are read-only, and the same
  list is checked again when the call arrives. Editing roles stay reachable
  where they always were — a human naming one in an `@mention`.
- A run waiting on a subagent reports `Paused` rather than borrowing the
  question pause's `WaitingForPermission`, which claimed a prompt was waiting
  when nothing was.
- Fresh Klide conversations and Mission Control tasks now run in a dedicated
  Git worktree by default. The checkout is created before the Harness or
  delegate CLI starts, remains pinned across every workspace layout, and is
  cleaned up if a delegate fails to launch without writing work. Non-Git
  folders continue locally; other isolation failures never silently fall back
  to the main checkout.
- The harness measures model time per turn, and conversations carry a creation
  date, so duration is never re-derived from wall-clock time at render.
- Self-hosted provider endpoints can be renamed from Settings.
- Vision detection stops waving through text-only models: `claude-3-5-haiku`
  (Anthropic's one text-only chat model, dotted OpenRouter spelling included)
  and the o-series small builds (`o1-mini`, `o1-preview`, `o3-mini`) no longer
  read as vision-capable. And the adapter seam now forwards only the image
  formats the hosted APIs accept (jpeg/png/gif/webp) — an svg or bmp
  attachment is dropped instead of 400-failing the whole turn.
- Reopening the Mission console no longer re-announces a mission that finished
  long ago: terminal events toast exactly once, when they happen. Both console
  effects read the event log through one `terminalOutcome` helper, so the
  reopen state and the announcement can't disagree about whether a mission is
  parked.

### Focus shell and terminal

- The native shell docks *under* the Focus canvas instead of replacing it, so
  the conversation keeps its mount and its run subscriptions keep streaming
  while you work in the shell. It is the same single PTY the workbench drawer
  shows, at the same remembered height — opening it in Focus never starts a
  second one.
- One icon vocabulary: thirty private glyph copies across ActivityBar,
  FocusMode, StatusBar, WelcomeScreen and the rail destinations now resolve to
  `src/icons.tsx` (Phosphor Light behind an `Icon` primitive; provider logos,
  file-type marks and AgentMark stay hand-drawn). The AI panel's mark is a
  speech bubble, not the sparkle cliché.
- In Focus the terminal renders as a floating card — inset, four rounded
  corners, a hairline all the way round — because xterm's composited canvas
  can ignore a radius clip in this webview. Split panes now share their
  alignment rules with the header, so a tab sits over the pane it names and
  both dividers resolve to the same pixel.

### GitHub identity

- Klide pins its GitHub identity in `~/.klide/github_account.json` and applies
  it per-command via `GH_TOKEN`, instead of wearing whichever account `gh`
  happened to have active — the avatar, PR author, and push credentials can no
  longer disagree (and pushes from the wrong account no longer 403). Settings
  grows a GitHub account row to choose it.

### Architecture review (2026-08-04, PR #31)

Six reproduced defects fixed:

- **The Transcript is as durable as the Mission log.** Appends go through one
  flushed `O_APPEND` write and summaries through an atomic replace
  (`durable.rs`), so a crash can't publish a torn line and the polling run
  board can't read half a summary. Reading now tolerates exactly one thing — a
  torn *final* line — and errors on interior corruption instead of silently
  skipping it, which used to shorten replayed history, under-count the
  Validation contract, and lower cost totals with no sign anything was wrong.
- **Validation no longer misreports allowlisted command tools.** The
  transcript records each tool call's *capability* at dispatch time instead of
  leaving readers to guess from the tool's name, so a run that validated its
  own edits through a workspace-defined command tool no longer reads
  `unverified`. Headless Mission attempts derive the interactive tools to
  disable from the Pause capability rather than a hand-written list.
- **Live ptyd sessions survive the persistence toggle.** The toggle only
  routes *new* spawns; existing daemon sessions keep write, snapshot, and
  reuse — previously keystrokes into them were silently dropped and reattach
  repainted without a dedup high-water mark.
- **The delegate layer compiles off unix.** The ptyd wire types moved to an
  ungated `pty_wire.rs` and the client answers "no daemon here" on non-unix
  targets — one of two real blockers behind the Windows/Linux TODO item (the
  keyring feature selection remains the other).
- **The git IPC drift guard got its blind spot closed.** `create_pr` and
  `github_commit_avatars` gained wrappers and the guard now matches the whole
  family, the skills wire is typed end-to-end, and a literal NUL byte that had
  been hiding `settings/accounts.tsx` from every grep is gone.
- **Persistent-approval trust has teeth.** The repository fingerprint guarding
  persisted permission decisions is now covered by tests that fail if it stops
  moving for tracked edits, new commits, or untracked-file contents.

And the duplication sweep behind them:

- One `SessionHosting` trait over the in-process and ptyd session hosts, with
  the reuse/broadcast policies tested against fake hosts.
- `src/runPresentation.ts` — one module turns a Run's state into its word and
  tone (was eight drifting tables); the two legitimate meanings of "waiting"
  are documented and pinned instead of "fixed" into agreement.
- `ai/contextBudget.ts` extracts the auto-compaction arithmetic behind 21
  tests (the draft can no longer trigger a paid summarisation call), and
  `ai/autonomyLadder.ts` single-sources the Mode × diff-review ladder. The
  Focus start stage's fake context gauge — chosen window size divided by the
  largest option — is a label now.
- Mission Control gives one answer per provider name, colour, and mark
  (`providerShortName`, `providerBrandColor`, shared brand paths).
- The four Pause ceremonies collapse into one `run_pause_tool`;
  `AgentEvent::ts()` replaces two 23-arm matches; one shared `glob_match`
  serves the glob tool and the command allowlist.
- Shared modules earn their callers: `time.ts` owns `relativeTime` (four
  byte-identical copies gone), new `fileSearch.ts` gives ⌘P and the `@file`
  picker the same ranking, new `dragSession.ts` ends the stashed-cursor resize
  ritual, new `editorLanguage.ts` ends the twin extension tables, and the Rust
  menu builds from one `MENU_ITEMS` table with a source-reading drift test.

## v0.5.0 — Agent Operations (2026-07-16; closeout 2026-07-21)

- Race the same task across two Harness runs in isolated worktrees, keep sibling
  runs together in Mission Control, and compare status, validation, files,
  commands, tokens, cost, time, and worktree evidence side by side.
- Remove a newly created race worktree — including its recipe-copied config
  files and the branch created for it — when its Harness run fails to start,
  while preserving any checkout that holds other work.
- Validate persisted race groups before projecting them into Mission Control,
  with direct regression coverage for persistence, bounded history, partial
  dispatch, and orphan cleanup.
- Run frontend tests/build and Rust tests automatically on pushes to `main` and
  on pull requests.
- Verify that the release profile produces a 26 MB Apple Silicon `Klide.app`;
  the final closeout reran the frontend suite, production build, and full Rust
  suite (including PTY socket integration), then booted the bundled app and
  embedded frontend successfully. Distribution signing and notarization remain
  the publishing gate.

- Git Review grew into a full workbench: branch diff against the recorded fork base, PR list/create/open/checkout/merge actions, a commit history graph, and a structured commit-detail pane with avatars and full-width diffs.
- Delegate live status moved to hooks for Claude Code, Codex, and OpenCode, so Mission Control can show working/waiting/blocked state without scraping terminal output.
- Live-strip urgency and needs-you toasts make active delegate sessions visible while keeping the main workbench quiet.
- Subscription and custom CLI providers now share a cleaner default-model path: the "default" sentinel lets each CLI use its own configured default instead of forcing a stale model flag.
- Custom CLI agents are first-class in Settings, the AI panel, and dispatch.
- Mission Control now scopes delegate run history to the current workspace, keeping old runs from other projects out of the operator view.
- Production build splits the heaviest browser libraries (Monaco, xterm, Tauri, React) into named vendor chunks, and the main screens and modals now lazy-load on demand instead of shipping in the initial bundle.
- Docs were refreshed for the production README and changelog.

## v0.4 — Review Queue + Evidence Layer

- Mission Control answers "what is running?", "what needs me?", and "what changed?" at a glance — quiet rows, attention queue, per-run reasons + one next action.
- Evidence summaries per run — last meaningful event, branch, files touched, diff/review entry point, tokens/cost, sub-agent count, and saved-memory status, consistent across Klide and delegate runs.
- Delegate observability — Claude sub-agent visibility (counts `Agent`/`Task` calls, excludes sidechain turns) and symmetric routine badging.
- Reviewable memory — completed runs draft a note you accept, edit, or skip in the Memory modal before it becomes durable.
- Settings open instantly — sections mount on first visit, so per-provider status calls don't block the surface.
- Delegate account switching — save and switch Codex / Claude Code / OpenCode CLI logins from Settings without minting tokens.
- Parked (intentionally): natural-language scheduling and proactive suggestions — until the review/evidence loop has more daily mileage.

### Agent harness capability

- `run_command` — approval-gated shell execution so the agent can run tests/build/lint and verify its own work.
- Configurable turn cap (default 50) + command timeout (default 180s) + per-run command allowlist.
- Eval foundation — golden tool-layer scenarios run as `cargo test`; documented tool schema + lineage in `KLIDE_HARNESS_SCHEMA.md`.
- Scripted model-loop eval — fake provider turns choose tools, real tools execute, and tool results replay into the next provider message.
- Project-persistent command allowlist — "Approve for project" stores exact `run_command` approvals in `.klide/command-allowlist.json`.
- Test-after-edit — optional Settings → Harness command runs after accepted edits, alongside built-in Rust/JSON syntax checks.
- Provider seam extracted into `run_agent_loop` — production calls `ai_chat` through `RealProviderCaller`; tests can inject a mock provider caller.

## v0.3

- Self-hosted providers — add your own OpenAI-compatible endpoints (label + base URL + keychain token) in Settings; they appear in the provider picker under "Self-hosted", with live model listing and per-endpoint default model.
- Collapsible, glass-headed provider picker that scales to many providers.
- Project Memory v3 — touched-file links, run metadata, and automatic durable notes for completed Klide runs.
- Skills install/uninstall plus "Save as skill" generation from finished sessions.
- Mission Control handoff polish — resume/open delegate sessions in the right CLI surface, nested sub-agent runs, token/cost/file summaries, and brand marks.
- Workspace-rooted filesystem hardening — file reads/writes flow through checked Rust commands instead of broad webview FS permissions.
- Codebase Interview — `userAnswerQuestion` pause tool plus `/interview` for capturing project decisions.

## v0.2 (verified 2026-06-08)

- Plan / Build modes, `@`-mentions, slash commands, project-rules loading.
- Provider switcher — Ollama, OpenAI-compatible APIs, and subscription CLIs all live.
- Streaming through Rust for every provider.
- API keys stored in the OS keychain, managed from Settings.
- Quiet agent control surface with mode switching, provider choice, context pressure, skills, rules, history, and diff review.
- Real Claude Code / Codex / OpenCode delegate PTYs in the AI panel.
- Mission Control v2 — inspect runs, resume delegate sessions, and hand off a run to another CLI.
- Project Memory v1 — summarize a session into durable `.klide/memory/` markdown and browse it in a centered modal.
- Skills install + uninstall via `npx skills add`, with provenance grouping (Vercel / Matt Pocock / Anthropic / Personal / Workspace).
- "Save as skill" sparkle — auto-generates a `SKILL.md` for reusable patterns in finished sessions.
- Profile modal — local IDE profile (avatar + identity + workspace), `⌘.`
- Command palette · find-in-files · editable harness settings · checkpoint rollback.
- Live provider smoke matrix verified for Ollama, MLX, Anthropic direct API, one OpenAI-compatible API, and Claude Code / Codex / OpenCode delegates.
- Premium polish pass on the always-visible chrome (ActivityBar, TabBar, StatusBar, WelcomeScreen).
- Parked: Context Lens/project graph heuristics. If revived, feed Memory/summarization instead of silently injecting chat context.

## v0.1 — MVP

- Layout shell — activity bar, sidebar, tabs, editor, terminal, AI panel, status bar.
- File explorer — open folder, tree view, click to open.
- Tabs — multiple files, switch, close.
- Editor — Monaco with syntax highlighting + `Cmd+S`.
- Status bar — filename, language, cursor position.
- Terminal panel — real shell via PTY, toggleable.
- AI panel — streaming chat against local Ollama (native `tools` API).
- Agent mode — `write_file` / `create_file` with diff review.
