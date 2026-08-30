//! The Permission engine (CONTEXT.md).
//!
//! One decision path for every command- and network-capability Tool: classify
//! a capability against what's already trusted or already refused, ask the user
//! only when it's genuinely new, emit the request/resolved events, remember the
//! answer at the chosen scope, and persist project-scoped approvals to disk.
//!
//! The two capabilities differ in exactly three places — which run-scoped
//! `HashSet`s they touch, which on-disk allowlist backs the project scope, and
//! the wording shown to the model on refusal. That variation is the `Capability`
//! enum; the policy around it (scope rules, pre-check, the pause ceremony) is
//! shared here. The handlers keep only what is genuinely theirs: parsing the
//! tool call into an invocation, and running the approved command.

use super::tools::NormalizedToolCall;
use super::transcripts::now_ms;
use super::types::{AgentEvent, AgentRunStatus, PermissionRequest};
use super::{command_allowlist, network_allowlist};
use super::{pause_for_user, with_run_handle, PauseOutcome, ToolCtx};

/// Which trust namespace a gated Tool draws on. Command- and network-capability
/// tools keep separate run-scoped sets and separate project allowlists so trust
/// never bleeds across capability kinds.
#[derive(Clone, Copy)]
pub enum Capability {
    Command,
    Network,
}

/// Everything the engine remembers about this run's approvals and rejections,
/// across every gated capability — commands, network targets, and rejected
/// edits. One value on the run handle instead of five loose sets, so the
/// "remembers per-run approvals/rejections" half of the engine is testable
/// without a supervisor.
#[derive(Default)]
pub struct TrustMemory {
    /// Commands approved with scope "run"/"project" earlier in this run —
    /// re-running an identical command skips the prompt.
    approved_commands: std::sync::Mutex<std::collections::HashSet<String>>,
    /// Commands rejected this run: proposing the same one again is
    /// auto-declined, not re-asked.
    rejected_commands: std::sync::Mutex<std::collections::HashSet<String>>,
    /// Network targets approved for this run (`web_search`, `host:docs.rs`).
    approved_network: std::sync::Mutex<std::collections::HashSet<String>>,
    /// Network targets rejected this run.
    rejected_network: std::sync::Mutex<std::collections::HashSet<String>>,
    /// Edit proposals rejected this run, keyed `<path>::<new_hash>`. Write has
    /// no approved set: a write approval is the diff decision itself and is
    /// never remembered across proposals — only a rejection sticks, so one
    /// "Reject" stops the byte-identical re-proposal.
    rejected_edits: std::sync::Mutex<std::collections::HashSet<String>>,
    /// "Validate all" from the diff card: every later edit this run applies
    /// without pausing — the mid-run counterpart of starting the run with
    /// `require_diff_review: false`. One-way for the run's life; the surface
    /// flips its rung alongside so later turns arrive already auto-accepting.
    edits_auto_apply: std::sync::atomic::AtomicBool,
}

impl TrustMemory {
    pub fn approved(&self, cap: Capability, key: &str) -> bool {
        match cap {
            Capability::Command => self.approved_commands.lock().unwrap().contains(key),
            Capability::Network => self.approved_network.lock().unwrap().contains(key),
        }
    }

    pub fn rejected(&self, cap: Capability, key: &str) -> bool {
        match cap {
            Capability::Command => self.rejected_commands.lock().unwrap().contains(key),
            Capability::Network => self.rejected_network.lock().unwrap().contains(key),
        }
    }

    pub fn remember_approved(&self, cap: Capability, key: &str) {
        let set = match cap {
            Capability::Command => &self.approved_commands,
            Capability::Network => &self.approved_network,
        };
        set.lock().unwrap().insert(key.to_string());
    }

    pub fn remember_rejected(&self, cap: Capability, key: &str) {
        let set = match cap {
            Capability::Command => &self.rejected_commands,
            Capability::Network => &self.rejected_network,
        };
        set.lock().unwrap().insert(key.to_string());
    }

    pub fn write_rejected(&self, edit_key: &str) -> bool {
        self.rejected_edits.lock().unwrap().contains(edit_key)
    }

    pub fn remember_write_rejection(&self, edit_key: &str) {
        self.rejected_edits
            .lock()
            .unwrap()
            .insert(edit_key.to_string());
    }

    pub fn edits_auto_applied(&self) -> bool {
        self.edits_auto_apply
            .load(std::sync::atomic::Ordering::Relaxed)
    }

    pub fn remember_edits_auto_apply(&self) {
        self.edits_auto_apply
            .store(true, std::sync::atomic::Ordering::Relaxed);
    }
}

/// Was this exact edit (path + resulting content hash) already rejected this
/// run? The Write capability's rejection memory lives in the engine like the
/// other capabilities'; the diff ceremony itself stays with the Write handler.
pub fn write_already_rejected(ctx: &ToolCtx<'_>, edit_key: &str) -> bool {
    with_run_handle(ctx.sup, ctx.id, |h| h.trust.write_rejected(edit_key)).unwrap_or(false)
}

pub fn remember_write_rejection(ctx: &ToolCtx<'_>, edit_key: &str) {
    with_run_handle(ctx.sup, ctx.id, |h| {
        h.trust.remember_write_rejection(edit_key)
    });
}

/// Has "Validate all" been chosen earlier in this run? Later edits then apply
/// without pausing, exactly as if the run had started with review off.
pub fn edits_auto_applied(ctx: &ToolCtx<'_>) -> bool {
    with_run_handle(ctx.sup, ctx.id, |h| h.trust.edits_auto_applied()).unwrap_or(false)
}

pub fn remember_edits_auto_apply(ctx: &ToolCtx<'_>) {
    with_run_handle(ctx.sup, ctx.id, |h| h.trust.remember_edits_auto_apply());
}

/// What the pre-check concluded before any prompt is shown.
pub enum Precheck {
    /// Already trusted — a run-scoped approval or the project allowlist covers
    /// it. Run it without asking.
    Execute,
    /// Already refused this run. Return this canned message to the model so it
    /// changes course, and never re-ask for the same key.
    AutoReject(&'static str),
    /// Genuinely new. Ask the user.
    Ask,
}

/// The user's answer to a gate prompt, normalized out of the decision JSON.
pub enum GateDecision {
    Approved {
        scope: String,
        /// The allowlist pattern the user chose, if they widened it (command
        /// capability only). Falls back to the literal key when absent.
        pattern: Option<String>,
    },
    Rejected,
    /// The user cancelled the whole run while the prompt was up.
    Cancelled,
}

impl Capability {
    /// Persist a project-scoped approval to the on-disk allowlist. `persist`
    /// is the value to store (a command string, or a network target); for the
    /// command capability the user may have widened it to a wildcard `pattern`.
    fn persist_project(
        &self,
        runs_dir: &std::path::Path,
        root: &str,
        persist: &str,
        pattern: Option<&str>,
    ) {
        let result = match self {
            Capability::Command => {
                let pattern = pattern.unwrap_or(persist);
                if pattern.contains('*') || pattern.contains('?') {
                    command_allowlist::add_rule(runs_dir, root, pattern)
                } else {
                    command_allowlist::add(runs_dir, root, pattern)
                }
            }
            Capability::Network => network_allowlist::add(runs_dir, root, persist),
        };
        if let Err(err) = result {
            eprintln!("failed to persist project {} allowlist: {err}", self.noun());
        }
    }

    fn noun(&self) -> &'static str {
        match self {
            Capability::Command => "command",
            Capability::Network => "network",
        }
    }

    /// Shown to the model when an identical key was already refused this run.
    fn already_refused(&self) -> &'static str {
        match self {
            Capability::Command => {
                "You already proposed this exact command and the user rejected it. \
Do not run it again — take a different approach or ask the user what they'd prefer."
            }
            Capability::Network => {
                "You already proposed this exact network target and the user rejected it. \
Do not use it again — take a different approach or ask the user what they'd prefer."
            }
        }
    }

    /// Shown to the model when the user rejects this fresh prompt.
    pub fn rejected_message(&self) -> &'static str {
        match self {
            Capability::Command => {
                "Rejected by user: command not run. Do not propose this exact \
command again — take a different approach or ask the user what they'd prefer."
            }
            Capability::Network => {
                "Rejected by user: network request not run. Do not propose this exact \
network target again — take a different approach or ask the user what they'd prefer."
            }
        }
    }
}

/// The id that ties a `PermissionRequested` event to its `PermissionResolved`
/// twin. Deterministic from the run + tool call so the request JSON's `id` and
/// the resolved event always agree.
pub fn request_id(ctx: &ToolCtx<'_>, call: &NormalizedToolCall) -> String {
    format!("perm_{}_{}", ctx.id, call.id)
}

/// Classify a capability before prompting. `run_key` is the run-scoped trust
/// key; `project_ok` is the caller's project-allowlist verdict (kept in the
/// handler because the command capability's wildcard/external-path nuance is
/// command-specific). Falls back to `Ask` whenever the run handle is missing.
pub fn precheck(ctx: &ToolCtx<'_>, cap: Capability, run_key: &str, project_ok: bool) -> Precheck {
    let (run_ok, run_no) = with_run_handle(ctx.sup, ctx.id, |h| {
        (h.trust.approved(cap, run_key), h.trust.rejected(cap, run_key))
    })
    .unwrap_or((false, false));

    if run_ok || project_ok {
        Precheck::Execute
    } else if run_no {
        Precheck::AutoReject(cap.already_refused())
    } else {
        Precheck::Ask
    }
}

/// The pause ceremony: flip to waiting, stash the permission oneshot, emit the
/// request, await the decision (or cancellation), emit the resolved event, and
/// hand back the normalized verdict. Identical for both capabilities — only the
/// `request` JSON the caller built differs.
pub async fn run_gate<E>(
    ctx: &ToolCtx<'_>,
    call: &NormalizedToolCall,
    request: PermissionRequest,
    emit: &mut E,
) -> Result<GateDecision, String>
where
    E: FnMut(AgentEvent) -> Result<(), String>,
{
    let decision = match pause_for_user(
        ctx.sup,
        ctx.id,
        AgentRunStatus::WaitingForPermission,
        AgentEvent::PermissionRequested {
            run_id: ctx.id.to_string(),
            request,
            ts: now_ms(),
        },
        "{\"behavior\":\"deny\"}",
        ctx.cancel,
        emit,
        |handle, tx| {
            *handle.pending_permission.lock().unwrap() = Some(tx);
        },
    )
    .await?
    {
        PauseOutcome::Cancelled => return Ok(GateDecision::Cancelled),
        PauseOutcome::Resolved(decision) => decision,
    };

    let decision_val: serde_json::Value =
        serde_json::from_str(&decision).unwrap_or(serde_json::json!({ "behavior": "deny" }));
    let allowed = decision_val.get("behavior").and_then(|b| b.as_str()) == Some("allow");
    let scope = decision_val
        .get("scope")
        .and_then(|s| s.as_str())
        .unwrap_or("once")
        .to_string();

    emit(AgentEvent::PermissionResolved {
        run_id: ctx.id.to_string(),
        request_id: request_id(ctx, call),
        decision: decision_val.clone(),
        ts: now_ms(),
    })?;

    Ok(if allowed {
        GateDecision::Approved {
            scope,
            pattern: decision_val
                .get("pattern")
                .and_then(|v| v.as_str())
                .map(str::to_string),
        }
    } else {
        GateDecision::Rejected
    })
}

/// Remember a gate decision. `run_key` is what the run-scoped sets and pre-check
/// match on; `persist` is what a project-scoped approval writes to disk (they
/// differ for commands: the run key may carry a cwd prefix, the persisted value
/// is the bare command). A `Cancelled` decision records nothing.
pub fn record(
    ctx: &ToolCtx<'_>,
    cap: Capability,
    run_key: &str,
    persist: &str,
    decision: &GateDecision,
) {
    match decision {
        GateDecision::Approved { scope, pattern } => {
            if scope == "run" || scope == "project" {
                with_run_handle(ctx.sup, ctx.id, |h| h.trust.remember_approved(cap, run_key));
            }
            if scope == "project" {
                if let Some(root) = ctx.request.workspace_root.as_deref() {
                    cap.persist_project(ctx.runs_dir, root, persist, pattern.as_deref());
                }
            }
        }
        GateDecision::Rejected => {
            with_run_handle(ctx.sup, ctx.id, |h| h.trust.remember_rejected(cap, run_key));
        }
        GateDecision::Cancelled => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::process::Command;

    fn temp_workspace(name: &str) -> (String, PathBuf) {
        let dir =
            std::env::temp_dir().join(format!("klide-permission-{name}-{}", std::process::id()));
        let runs_dir = std::env::temp_dir().join(format!(
            "klide-permission-runs-{name}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&runs_dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::create_dir_all(&runs_dir).unwrap();
        Command::new("git")
            .args(["init", "-q"])
            .current_dir(&dir)
            .status()
            .unwrap();
        Command::new("git")
            .args([
                "-c",
                "user.name=Klide",
                "-c",
                "user.email=test@klide.local",
                "commit",
                "--allow-empty",
                "-qm",
                "initial",
            ])
            .current_dir(&dir)
            .status()
            .unwrap();
        (dir.to_string_lossy().to_string(), runs_dir)
    }

    #[test]
    fn command_project_persist_routes_exact_vs_wildcard() {
        let (root, runs_dir) = temp_workspace("cmd-persist");
        // An exact command lands in the `commands` list verbatim.
        Capability::Command.persist_project(&runs_dir, &root, "cargo test", None);
        // A widened pattern lands as a wildcard rule, matching a family.
        Capability::Command.persist_project(&runs_dir, &root, "cargo build", Some("cargo *"));

        let stored = command_allowlist::list(&runs_dir, &root).unwrap();
        assert!(stored.contains(&"cargo test".to_string()));
        assert!(stored.contains(&"cargo *".to_string()));
        let matched = command_allowlist::match_rule(&stored, "cargo run", "cargo run")
            .expect("wildcard covers the family");
        assert_eq!(matched.pattern, "cargo *");
        assert!(!matched.exact);
        let _ = std::fs::remove_dir_all(root);
        let _ = std::fs::remove_dir_all(runs_dir);
    }

    #[test]
    fn network_project_persist_writes_the_target() {
        let (root, runs_dir) = temp_workspace("net-persist");
        Capability::Network.persist_project(&runs_dir, &root, "host:docs.rs", None);
        assert!(network_allowlist::is_allowed(&runs_dir, &root, "host:docs.rs").unwrap());
        assert!(!network_allowlist::is_allowed(&runs_dir, &root, "host:example.com").unwrap());
        let _ = std::fs::remove_dir_all(root);
        let _ = std::fs::remove_dir_all(runs_dir);
    }

    #[test]
    fn trust_memory_keeps_capabilities_separate() {
        let trust = TrustMemory::default();
        trust.remember_approved(Capability::Command, "cargo test");
        trust.remember_rejected(Capability::Network, "host:evil.example");

        assert!(trust.approved(Capability::Command, "cargo test"));
        // Trust never bleeds across capability kinds: the same key in the
        // other namespace stays unknown.
        assert!(!trust.approved(Capability::Network, "cargo test"));
        assert!(trust.rejected(Capability::Network, "host:evil.example"));
        assert!(!trust.rejected(Capability::Command, "host:evil.example"));
        assert!(!trust.approved(Capability::Command, "cargo build"));
    }

    #[test]
    fn trust_memory_write_rejection_sticks_and_stays_its_own_namespace() {
        let trust = TrustMemory::default();
        assert!(!trust.write_rejected("src/a.rs::abc123"));
        trust.remember_write_rejection("src/a.rs::abc123");
        assert!(trust.write_rejected("src/a.rs::abc123"));
        // A revised edit hashes differently and prompts normally.
        assert!(!trust.write_rejected("src/a.rs::def456"));
        // Edit keys never read as commands or network targets.
        assert!(!trust.rejected(Capability::Command, "src/a.rs::abc123"));
        assert!(!trust.rejected(Capability::Network, "src/a.rs::abc123"));
    }

    #[test]
    fn refusal_wording_is_capability_specific() {
        assert!(Capability::Command
            .rejected_message()
            .contains("command not run"));
        assert!(Capability::Network
            .rejected_message()
            .contains("network request not run"));
        assert!(Capability::Command
            .already_refused()
            .contains("exact command"));
        assert!(Capability::Network
            .already_refused()
            .contains("exact network target"));
    }
}
