//! The per-capability tool-call ceremony: what happens between the run
//! loop deciding a call may execute and the uniform emit/append of its
//! result. One handler per Tool capability — Pause (question / subagent /
//! advisor), Command, Network, Write — plus the loop monitor's advisor
//! escalation, which reuses the same pause. Execution itself stays in the
//! registry (tools.rs); mode gating stays in run_core; this module owns
//! only the ceremony: permission gates, pauses, checkpoints, rejection
//! memory.

use super::*;

/// Pause tool (`userAnswerQuestion`): ask the user a typed question and feed
/// their verbatim answer back to the model. "(skipped)" is the sentinel the
/// user can send to decline. Cancelling during the wait bubbles up as
/// The ceremony every Pause tool performs.
///
/// All four of them — question, subagent, advisor, and the advisor escalation the
/// loop monitor triggers — did the same six steps, and the closure that stashes
/// the reply channel was byte-identical in each. What differs is only which args
/// they read, which two events they emit, and what a skipped answer means.
///
/// Note the status: all four report `WaitingForPermission`, even though only one
/// of them is a permission. That is the wire vocabulary being narrower than the
/// states it has to describe (`AgentRunStatus` has no `WaitingForUser`), not a
/// choice worth preserving — but widening it is a wire change with a frontend
/// mirror, so it stays as-is here and is written down instead of re-derived four
/// times.
///
/// `Ok(None)` means the run was cancelled while parked.
async fn run_pause_tool<E, R, S>(
    ctx: &ToolCtx<'_>,
    call: &NormalizedToolCall,
    emit: &mut E,
    key_prefix: &str,
    default_answer: &str,
    requested: R,
    resolved: S,
) -> Result<Option<String>, String>
where
    E: FnMut(AgentEvent) -> Result<(), String>,
    R: FnOnce(&str) -> AgentEvent,
    S: FnOnce(&str, &str) -> AgentEvent,
{
    let request_id = format!("{key_prefix}_{}_{}", ctx.id, call.id);

    let answer = match pause_for_user(
        ctx.sup,
        ctx.id,
        AgentRunStatus::WaitingForPermission,
        requested(&request_id),
        default_answer,
        ctx.cancel,
        emit,
        |handle, tx| {
            *handle.pending_question.lock().unwrap() = Some(tx);
        },
    )
    .await?
    {
        PauseOutcome::Cancelled => return Ok(None),
        PauseOutcome::Resolved(answer) => answer,
    };

    emit(resolved(&request_id, &answer))?;
    Ok(Some(answer))
}

/// `Cancelled`.
pub(super) async fn process_pause_tool<E>(
    ctx: &ToolCtx<'_>,
    call: &NormalizedToolCall,
    emit: &mut E,
) -> Result<ToolOutcome, String>
where
    E: FnMut(AgentEvent) -> Result<(), String>,
{
    let question = call
        .input
        .get("question")
        .and_then(|v| v.as_str())
        .unwrap_or("(empty question)")
        .to_string();
    let Some(answer) = run_pause_tool(
        ctx,
        call,
        emit,
        "q",
        "(skipped)",
        |request_id| AgentEvent::UserQuestionRequested {
            run_id: ctx.id.to_string(),
            request_id: request_id.to_string(),
            question: question.clone(),
            ts: now_ms(),
        },
        |request_id, answer| AgentEvent::UserQuestionResolved {
            run_id: ctx.id.to_string(),
            request_id: request_id.to_string(),
            answer: answer.to_string(),
            ts: now_ms(),
        },
    )
    .await?
    else {
        return Ok(ToolOutcome::Cancelled);
    };

    Ok(ToolOutcome::Produced(ToolResult {
        ok: true,
        content: if answer == "(skipped)" {
            "[user skipped this question]".to_string()
        } else {
            answer
        },
        metadata: None,
    }))
}

/// Subagent spawn tool (`spawn_subagent`): a Pause tool that delegates a
/// focused, read-only investigation to a named subagent. The loop emits
/// `SubagentRequested` and parks on the same oneshot the question pause uses;
/// the frontend runs the child subagent (nested under this run via `parentId`)
/// and resolves through `agent_resolve_question` with the subagent's report,
/// which becomes this tool's result. Cancelling during the wait bubbles up as
/// `Cancelled`.
pub(super) async fn process_subagent_tool<E>(
    ctx: &ToolCtx<'_>,
    call: &NormalizedToolCall,
    emit: &mut E,
) -> Result<ToolOutcome, String>
where
    E: FnMut(AgentEvent) -> Result<(), String>,
{
    let subagent = call
        .input
        .get("subagent")
        .and_then(|v| v.as_str())
        .unwrap_or("explorer")
        .to_string();
    let task = call
        .input
        .get("task")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let Some(report) = run_pause_tool(
        ctx,
        call,
        emit,
        "sub",
        "(subagent produced no output)",
        |request_id| AgentEvent::SubagentRequested {
            run_id: ctx.id.to_string(),
            request_id: request_id.to_string(),
            subagent: subagent.clone(),
            task: task.clone(),
            ts: now_ms(),
        },
        |request_id, report| AgentEvent::SubagentResolved {
            run_id: ctx.id.to_string(),
            request_id: request_id.to_string(),
            result: report.to_string(),
            ts: now_ms(),
        },
    )
    .await?
    else {
        return Ok(ToolOutcome::Cancelled);
    };

    Ok(ToolOutcome::Produced(ToolResult {
        ok: true,
        content: report,
        metadata: Some(serde_json::json!({ "subagent": subagent })),
    }))
}

/// Advisor consult tool (`consult_advisor`): a Pause tool that escalates one
/// hard decision to a stronger advisor model. The loop emits `AdvisorRequested`
/// and parks on the shared question oneshot; the frontend asks a bigger model
/// (or a Claude Code session) the executor's question and resolves through
/// `agent_resolve_question` with the advice, which becomes this tool's result.
/// Distinct from `spawn_subagent`: the advisor gives *guidance*, not a nested
/// agentic run — the executor stays in control and applies the advice itself.
/// Cancelling during the wait bubbles up as `Cancelled`.
/// Sentinel the frontend prepends when an advisor consult fails (no key,
/// provider unreachable, empty reply). The shared question oneshot only carries
/// a string, so this marker is how a failure crosses back — process_advisor_tool
/// strips it and returns a NOT-ok tool result. Keep in sync with the same
/// constant in AiPanel's runAdvisorConsult.
pub(super) const ADVISOR_ERROR_PREFIX: &str = "[advisor:error] ";

pub(super) async fn process_advisor_tool<E>(
    ctx: &ToolCtx<'_>,
    call: &NormalizedToolCall,
    emit: &mut E,
) -> Result<ToolOutcome, String>
where
    E: FnMut(AgentEvent) -> Result<(), String>,
{
    let question = call
        .input
        .get("question")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    // Fold optional `context` into the question so the advisor sees one
    // self-contained prompt — the frontend forwards this verbatim.
    let question = match call.input.get("context").and_then(|v| v.as_str()) {
        Some(c) if !c.trim().is_empty() => format!("{question}\n\nContext:\n{}", c.trim()),
        _ => question,
    };
    let Some(advice) = run_pause_tool(
        ctx,
        call,
        emit,
        "adv",
        // A closed channel is a failure, not advice — mark it so below.
        ADVISOR_ERROR_PREFIX,
        |request_id| AgentEvent::AdvisorRequested {
            run_id: ctx.id.to_string(),
            request_id: request_id.to_string(),
            question: question.clone(),
            ts: now_ms(),
        },
        |request_id, advice| AgentEvent::AdvisorResolved {
            run_id: ctx.id.to_string(),
            request_id: request_id.to_string(),
            advice: advice.to_string(),
            ts: now_ms(),
        },
    )
    .await?
    else {
        return Ok(ToolOutcome::Cancelled);
    };

    // A failed consult (no key, provider down, empty reply) is prefixed with
    // ADVISOR_ERROR_PREFIX by the frontend. Surface it as a NOT-ok tool result
    // so the executor treats it as a failure, not as guidance it should follow.
    if let Some(msg) = advice.strip_prefix(ADVISOR_ERROR_PREFIX) {
        return Ok(ToolOutcome::Produced(ToolResult {
            ok: false,
            content: format!("Advisor consult failed: {}", msg.trim()),
            metadata: Some(serde_json::json!({ "advisor": true })),
        }));
    }

    Ok(ToolOutcome::Produced(ToolResult {
        ok: true,
        content: format!("Advisor guidance:\n{advice}"),
        metadata: Some(serde_json::json!({ "advisor": true })),
    }))
}

/// Outcome of an auto-escalated advisor consult (see `steer_via_advisor`).
pub(super) enum AdvisorSteer {
    /// The advisor answered; inject this guidance into the next turn.
    Advice(String),
    /// No advisor configured, or the consult failed — fall back to the plain
    /// steering nudge so the run still gets a course-correction.
    FallbackNudge,
    /// The user cancelled while the consult was parked; the caller settles the
    /// run and returns (only it can leave the loop).
    Cancelled,
}

/// Consult a stronger advisor *without* a model-initiated tool call: the loop
/// monitor detected a stuck failure loop and is escalating on the executor's
/// behalf. Emits the same `AdvisorRequested`/`AdvisorResolved` pause the
/// `consult_advisor` tool uses, so any run-owner (AI panel or headless mission)
/// services it unchanged. A closed channel or an `ADVISOR_ERROR_PREFIX` reply
/// (no advisor configured, provider down) degrades to `FallbackNudge`.
pub(super) async fn steer_via_advisor<E>(
    sup: &dyn RunSupervisor,
    id: &str,
    request_id: String,
    question: String,
    cancel: &CancellationToken,
    emit: &mut E,
) -> Result<AdvisorSteer, String>
where
    E: FnMut(AgentEvent) -> Result<(), String>,
{
    let advice = match pause_for_user(
        sup,
        id,
        AgentRunStatus::WaitingForPermission,
        AgentEvent::AdvisorRequested {
            run_id: id.to_string(),
            request_id: request_id.clone(),
            question,
            ts: now_ms(),
        },
        ADVISOR_ERROR_PREFIX,
        cancel,
        emit,
        |handle, tx| {
            *handle.pending_question.lock().unwrap() = Some(tx);
        },
    )
    .await?
    {
        PauseOutcome::Cancelled => return Ok(AdvisorSteer::Cancelled),
        PauseOutcome::Resolved(advice) => advice,
    };

    emit(AgentEvent::AdvisorResolved {
        run_id: id.to_string(),
        request_id,
        advice: advice.clone(),
        ts: now_ms(),
    })?;

    if advice.strip_prefix(ADVISOR_ERROR_PREFIX).is_some() {
        return Ok(AdvisorSteer::FallbackNudge);
    }
    Ok(AdvisorSteer::Advice(advice))
}

/// The most recent tool result text in the provider message stream, truncated —
/// the error the advisor most needs to see when a failure loop is escalated.
pub(super) fn last_tool_output(messages: &[serde_json::Value]) -> Option<String> {
    messages.iter().rev().find_map(|m| {
        if m.get("role").and_then(|r| r.as_str()) == Some("tool") {
            m.get("content")
                .and_then(|c| c.as_str())
                .map(|s| s.chars().take(800).collect::<String>())
        } else {
            None
        }
    })
}

/// Command tool (`run_command` and dynamic command-capability tools): run a
/// shell command, but only after the user approves it through the permission
/// gate. Approvals/rejections are remembered per-run (and project-scoped ones
/// persist to the on-disk allowlist) so an identical command doesn't re-prompt.
/// Cancelling during the approval wait bubbles up as `Cancelled`.
/// The four options every command/network gate offers, declared once so the
/// optionId / behavior / scope wire contract can't drift between capabilities.
/// Only the run/project labels differ ("Approve for this run" vs "Approve
/// target for this run"). Serde owns the field names now, so the frontend
/// mirror can't disagree with them by hand.
pub(super) fn standard_gate_options(run_label: &str, project_label: &str) -> Vec<PermissionOption> {
    let option = |id: &str, label: &str, behavior: &str, scope: Option<&str>| PermissionOption {
        option_id: id.to_string(),
        label: label.to_string(),
        behavior: behavior.to_string(),
        scope: scope.map(str::to_string),
    };
    vec![
        option("allow_once", "Approve", "allow", Some("once")),
        option("allow_run", run_label, "allow", Some("run")),
        option("allow_project", project_label, "allow", Some("project")),
        option("deny", "Reject", "deny", None),
    ]
}

pub(super) async fn process_command_tool<E>(
    ctx: &ToolCtx<'_>,
    call: &NormalizedToolCall,
    emit: &mut E,
) -> Result<ToolOutcome, String>
where
    E: FnMut(AgentEvent) -> Result<(), String>,
{
    let root_value = match ctx.request.workspace_root.as_deref() {
        Some(root) => root,
        None => return Ok(ToolOutcome::Produced(no_workspace_result())),
    };

    // The registry resolves which command actually runs (builtin shell input
    // vs a dynamic tool's template) — tool identity is its data, not ours.
    // Default 180s; configurable for long builds.
    let invocation = match tools::command_invocation(
        call,
        root_value,
        ctx.request.command_timeout_secs.unwrap_or(180),
    ) {
        Ok(invocation) => invocation,
        Err(result) => return Ok(ToolOutcome::Produced(result)),
    };
    let tools::CommandInvocation {
        tool_name: permission_tool_name,
        command,
        cwd,
        timeout_secs,
        summary: permission_summary,
        reason,
    } = invocation;

    let approval_key = if cwd == root_value {
        command.clone()
    } else {
        format!("{cwd} :: {command}")
    };
    let preflight = preflight_command(root_value, &cwd, &command);
    // Wildcard allowlist rules are intentionally narrower than exact approvals:
    // if a wildcard command references outside-workspace paths, ask again so the
    // path is visible to the user instead of hidden behind a broad pattern. That
    // nuance is command-specific, so the project verdict is computed here and
    // handed to the engine as a plain bool.
    let matched_rule =
        command_allowlist::match_rule(&ctx.request.command_allowlist, &command, &approval_key);
    let project_ok = matched_rule
        .as_ref()
        .map(|rule| rule.exact || preflight.external_paths.is_empty())
        .unwrap_or(false);

    match permission::precheck(
        ctx,
        permission::Capability::Command,
        &approval_key,
        project_ok,
    ) {
        permission::Precheck::Execute => {
            return Ok(ToolOutcome::Produced(
                run_command_capture_in(root_value, &cwd, &command, timeout_secs).await,
            ));
        }
        permission::Precheck::AutoReject(msg) => {
            return Ok(ToolOutcome::Produced(ToolResult {
                ok: false,
                content: msg.to_string(),
                metadata: None,
            }));
        }
        permission::Precheck::Ask => {}
    }

    let external_paths = preflight.external_paths.clone();
    let mut permission_reason = reason;
    if !external_paths.is_empty() {
        permission_reason.push_str(" It references paths outside the workspace: ");
        permission_reason.push_str(&external_paths.join(", "));
        permission_reason.push('.');
    }
    if let Some(rule) = matched_rule.as_ref() {
        permission_reason.push_str(&format!(
            " Project rule `{}` matched, but this command still needs approval.",
            rule.pattern
        ));
    }

    let perm = PermissionRequest {
        id: permission::request_id(ctx, call),
        run_id: ctx.id.to_string(),
        tool_call_id: call.id.clone(),
        tool_name: permission_tool_name.to_string(),
        input: serde_json::json!({
            "command": command,
            "cwd": cwd,
            "externalPaths": external_paths,
            "matchedAllowRule": matched_rule.as_ref().map(|rule| rule.pattern.clone())
        }),
        summary: permission_summary,
        reason: permission_reason,
        options: standard_gate_options("Approve for this run", "Approve for this project"),
    };

    let decision = match permission::run_gate(ctx, call, perm, emit).await? {
        permission::GateDecision::Cancelled => return Ok(ToolOutcome::Cancelled),
        decision => decision,
    };
    permission::record(
        ctx,
        permission::Capability::Command,
        &approval_key,
        &command,
        &decision,
    );

    let result = match decision {
        permission::GateDecision::Approved { .. } => {
            run_command_capture_in(root_value, &cwd, &command, timeout_secs).await
        }
        _ => ToolResult {
            ok: false,
            content: permission::Capability::Command
                .rejected_message()
                .to_string(),
            metadata: None,
        },
    };
    Ok(ToolOutcome::Produced(result))
}

pub(super) struct NetworkInvocation {
    pub(super) target: String,
    pub(super) summary: String,
    pub(super) reason: String,
    pub(super) input: serde_json::Value,
}

const NETWORK_TOOL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

/// Web Tools use reqwest's blocking client because the registry's read seam is
/// synchronous. Keep that work off the async Harness thread: reqwest panics if
/// its blocking runtime is dropped from an async context. Join failures and a
/// DNS/request that outlives the bound become ordinary Tool errors, allowing
/// the Harness to emit ToolCallFinished and continue the Run.
async fn execute_network_tool(root: &str, call: &NormalizedToolCall, run_id: &str) -> ToolResult {
    let root = root.to_string();
    let call = call.clone();
    let run_id = run_id.to_string();
    let task = tokio::task::spawn_blocking(move || execute_read_only_tool(&root, &call, &run_id));

    match tokio::time::timeout(NETWORK_TOOL_TIMEOUT, task).await {
        Ok(Ok(result)) => result,
        Ok(Err(error)) => ToolResult {
            ok: false,
            content: format!("Network tool failed unexpectedly: {error}"),
            metadata: None,
        },
        Err(_) => ToolResult {
            ok: false,
            content: format!(
                "Network tool timed out after {} seconds.",
                NETWORK_TOOL_TIMEOUT.as_secs()
            ),
            metadata: None,
        },
    }
}

pub(super) fn network_invocation(call: &NormalizedToolCall) -> Result<NetworkInvocation, ToolResult> {
    match call.name.as_str() {
        "web_search" => {
            let query = call
                .input
                .get("query")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or_else(|| ToolResult {
                    ok: false,
                    content: "web_search requires a query.".to_string(),
                    metadata: None,
                })?;
            Ok(NetworkInvocation {
                target: "web_search".to_string(),
                summary: format!("web_search {query}"),
                reason: "The agent wants to search the web.".to_string(),
                input: serde_json::json!({
                    "query": query,
                    "target": "web_search"
                }),
            })
        }
        "web_fetch" => {
            let url = call
                .input
                .get("url")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or_else(|| ToolResult {
                    ok: false,
                    content: "web_fetch requires a url.".to_string(),
                    metadata: None,
                })?;
            let parsed = reqwest::Url::parse(url).map_err(|e| ToolResult {
                ok: false,
                content: format!("web_fetch requires a valid URL: {e}"),
                metadata: None,
            })?;
            let host = parsed.host_str().ok_or_else(|| ToolResult {
                ok: false,
                content: "web_fetch URL must include a host.".to_string(),
                metadata: None,
            })?;
            let host = host.to_ascii_lowercase();
            Ok(NetworkInvocation {
                target: format!("host:{host}"),
                summary: format!("web_fetch {host}"),
                reason: format!("The agent wants to fetch content from {host}."),
                input: serde_json::json!({
                    "url": url,
                    "host": host,
                    "target": format!("host:{host}")
                }),
            })
        }
        _ => Ok(NetworkInvocation {
            target: format!("tool:{}", call.name),
            summary: call.name.clone(),
            reason: "The agent wants to use a network-capability tool.".to_string(),
            input: serde_json::json!({
                "target": format!("tool:{}", call.name)
            }),
        }),
    }
}

pub(super) async fn process_network_tool<E>(
    ctx: &ToolCtx<'_>,
    call: &NormalizedToolCall,
    emit: &mut E,
) -> Result<ToolOutcome, String>
where
    E: FnMut(AgentEvent) -> Result<(), String>,
{
    let root_value = match ctx.request.workspace_root.as_deref() {
        Some(root) => root,
        None => return Ok(ToolOutcome::Produced(no_workspace_result())),
    };
    let invocation = match network_invocation(call) {
        Ok(invocation) => invocation,
        Err(result) => return Ok(ToolOutcome::Produced(result)),
    };
    let target = invocation.target.clone();
    let project_ok =
        network_allowlist::is_allowed(ctx.runs_dir, root_value, &target).unwrap_or(false);

    match permission::precheck(ctx, permission::Capability::Network, &target, project_ok) {
        permission::Precheck::Execute => {
            return Ok(ToolOutcome::Produced(
                execute_network_tool(root_value, call, ctx.id).await,
            ));
        }
        permission::Precheck::AutoReject(msg) => {
            return Ok(ToolOutcome::Produced(ToolResult {
                ok: false,
                content: msg.to_string(),
                metadata: None,
            }));
        }
        permission::Precheck::Ask => {}
    }

    let perm = PermissionRequest {
        id: permission::request_id(ctx, call),
        run_id: ctx.id.to_string(),
        tool_call_id: call.id.clone(),
        tool_name: call.name.clone(),
        input: invocation.input.clone(),
        summary: invocation.summary.clone(),
        reason: invocation.reason.clone(),
        options: standard_gate_options(
            "Approve target for this run",
            "Approve target for this project",
        ),
    };

    let decision = match permission::run_gate(ctx, call, perm, emit).await? {
        permission::GateDecision::Cancelled => return Ok(ToolOutcome::Cancelled),
        decision => decision,
    };
    permission::record(
        ctx,
        permission::Capability::Network,
        &target,
        &target,
        &decision,
    );

    let result = match decision {
        permission::GateDecision::Approved { .. } => {
            execute_network_tool(root_value, call, ctx.id).await
        }
        _ => ToolResult {
            ok: false,
            content: permission::Capability::Network
                .rejected_message()
                .to_string(),
            metadata: None,
        },
    };
    Ok(ToolOutcome::Produced(result))
}

/// Write tool (`write_file`, `create_file`): preview the edit as a diff, pass it
/// through the diff-review gate (or auto-apply when review is off), and on
/// "apply" write the file, save a checkpoint for rollback, and run the
/// optional test-after-edit command. A byte-identical re-proposal of an
/// already-rejected change is auto-declined. Cancelling during review bubbles
/// up as `Cancelled`.
/// Parse a resolved diff decision. The channel carries either a bare behavior
/// string ("apply" / "reject" — also the pause's cancellation default) or the
/// frontend's full decision JSON `{"behavior": "...", "note": "..."}` where
/// `note` is the user's review feedback. Tolerates both; unknown shapes read
/// as a plain rejection.
pub(super) fn parse_diff_decision(raw: &str) -> (String, Option<String>) {
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(raw) {
        if let Some(obj) = value.as_object() {
            let behavior = obj
                .get("behavior")
                .and_then(|b| b.as_str())
                .unwrap_or("reject")
                .to_string();
            let note = obj
                .get("note")
                .and_then(|n| n.as_str())
                .map(str::trim)
                .filter(|n| !n.is_empty())
                .map(str::to_string);
            return (behavior, note);
        }
        if let Some(s) = value.as_str() {
            return (s.to_string(), None);
        }
    }
    (raw.to_string(), None)
}

pub(super) async fn process_write_tool<E>(
    ctx: &ToolCtx<'_>,
    call: &NormalizedToolCall,
    emit: &mut E,
) -> Result<ToolOutcome, String>
where
    E: FnMut(AgentEvent) -> Result<(), String>,
{
    let root = match ctx.request.workspace_root.as_deref() {
        Some(root) => root,
        None => return Ok(ToolOutcome::Produced(no_workspace_result())),
    };

    let proposal = match execute_write_tool_preview(root, call, ctx.id) {
        Ok(p) => p,
        Err(error_result) => return Ok(ToolOutcome::Produced(error_result)),
    };

    // Identical to a change the user already rejected this run? (Same path +
    // same resulting content.) Auto-decline without a second diff prompt so one
    // "Reject" sticks; tell the model to change course rather than re-surfacing
    // the same diff.
    let edit_key = format!("{}::{}", proposal.path, proposal.new_hash);
    let already_rejected = permission::write_already_rejected(ctx, &edit_key);
    if already_rejected {
        return Ok(ToolOutcome::Produced(ToolResult {
            ok: false,
            content: format!(
                "You already proposed this exact change to {} and the user rejected it. \
Do not propose it again — take a different approach or ask the user what they'd prefer.",
                proposal.path
            ),
            metadata: None,
        }));
    }

    // Auto-accept mode (require_diff_review == Some(false)): apply without
    // pausing. Still emit the proposed diff so the edit stays visible in the
    // conversation, and the checkpoint written below keeps it revertable —
    // which is what makes auto-accept safe. Otherwise pause for diff review.
    let decision = if ctx.request.require_diff_review == Some(false) {
        emit(AgentEvent::DiffProposed {
            run_id: ctx.id.to_string(),
            proposal: proposal.clone(),
            ts: now_ms(),
        })?;
        "apply".to_string()
    } else {
        match pause_for_user(
            ctx.sup,
            ctx.id,
            AgentRunStatus::WaitingForDiff,
            AgentEvent::DiffProposed {
                run_id: ctx.id.to_string(),
                proposal: proposal.clone(),
                ts: now_ms(),
            },
            "reject",
            ctx.cancel,
            emit,
            |handle, tx| {
                *handle.pending_diff.lock().unwrap() = Some(tx);
            },
        )
        .await?
        {
            PauseOutcome::Cancelled => return Ok(ToolOutcome::Cancelled),
            PauseOutcome::Resolved(decision) => decision,
        }
    };

    let (behavior, note) = parse_diff_decision(&decision);
    let mut decision_obj = serde_json::json!({ "behavior": behavior });
    if let Some(n) = &note {
        decision_obj["note"] = serde_json::json!(n);
    }
    emit(AgentEvent::DiffResolved {
        run_id: ctx.id.to_string(),
        proposal_id: proposal.id.clone(),
        decision: decision_obj.clone(),
        ts: now_ms(),
    })?;

    if behavior == "apply" {
        match apply_write(root, &proposal) {
            Ok(result) => {
                let mut tool_result = result;
                // Save checkpoint for rollback. Serialize through
                // CheckpointEntry so the saved shape always matches what
                // agent_list_checkpoints deserializes.
                // Through the same two helpers the readers use. The writer used
                // to rebuild both paths by hand, 1130 lines from the functions
                // that define them, so the checkpoint format had two spellers.
                let checkpoint_dir = checkpoint_dir(ctx.runs_dir, ctx.id);
                let _ = std::fs::create_dir_all(&checkpoint_dir);
                let checkpoint_file =
                    checkpoint_file(ctx.runs_dir, ctx.id, &proposal.tool_call_id);
                let entry = CheckpointEntry {
                    tool_call_id: proposal.tool_call_id.clone(),
                    path: proposal.path.clone(),
                    old_content: proposal.old_content.clone(),
                    new_content: proposal.new_content.clone(),
                    is_create: proposal.is_create,
                    workspace_root: root.to_string(),
                    ts: now_ms(),
                };
                if let Ok(json) = serde_json::to_string(&entry) {
                    let _ = std::fs::write(&checkpoint_file, json);
                }
                let timeout_secs = ctx
                    .request
                    .command_timeout_secs
                    .unwrap_or(180)
                    .clamp(1, 1800);
                run_test_after_edit(
                    root,
                    ctx.request.test_after_edit_command.as_deref(),
                    timeout_secs,
                    &mut tool_result,
                )
                .await;
                emit(AgentEvent::FileChanged {
                    run_id: ctx.id.to_string(),
                    path: proposal.path.clone(),
                    old_hash: proposal.old_hash.clone(),
                    new_hash: proposal.new_hash.clone(),
                    ts: now_ms(),
                })?;
                Ok(ToolOutcome::Produced(tool_result))
            }
            Err(result) => Ok(ToolOutcome::Produced(result)),
        }
    } else {
        // Remember this rejection so a byte-identical re-proposal is
        // auto-declined above instead of prompting again. (A revised edit
        // addressing the feedback hashes differently, so it prompts normally.)
        permission::remember_write_rejection(ctx, &edit_key);
        let verb = if proposal.is_create {
            "created"
        } else {
            "changed"
        };
        let content = match note {
            // Review feedback turns the rejection into steering: tell the
            // model to revise toward the note instead of abandoning course.
            Some(note) => format!(
                "The user reviewed this change to {} and rejected it with feedback:\n\
{note}\n\n\
The file was not {verb}. Revise the change to address the feedback (or ask \
the user if it's unclear) — do not re-propose the same edit unchanged.",
                proposal.path
            ),
            None => format!(
                "Rejected by user: {} was not {verb}. Do not propose this exact change again — \
take a different approach or ask the user what they'd prefer.",
                proposal.path
            ),
        };
        Ok(ToolOutcome::Produced(ToolResult {
            ok: false,
            content,
            metadata: None,
        }))
    }
}
