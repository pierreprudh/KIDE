//! Durable inter-agent coordination.
//!
//! Runs and Delegates already have execution owners: the Harness owns native
//! Runs, while the Delegate module owns CLI processes. This module sits above
//! both. It owns the semantic coordination record — stable Run identities,
//! normalized state, addressed envelopes, cancellation requests, and
//! structured results — without taking over either execution loop.
//!
//! `.klide/coordination/events.jsonl` is the authority. A snapshot is always a
//! fold of that append-only journal, so a UI, an embedded MCP adapter, and a
//! future local socket can share one control surface without sharing process
//! memory. The command seam is intentionally provider-neutral. Adapters must
//! bind `CoordinationActor::Run` to their authenticated Run identity rather
//! than trusting an actor supplied by a remote caller.

use crate::agent::transcripts::{now_ms, validate_run_id};
use crate::workspace::Workspace;
use serde::{Deserialize, Serialize};
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

pub const COORDINATION_SCHEMA_VERSION: u8 = 1;
const MAX_BODY_BYTES: usize = 32 * 1024;
const MAX_SUMMARY_BYTES: usize = 64 * 1024;
const MAX_REASON_BYTES: usize = 4 * 1024;
const MAX_REFERENCE_BYTES: usize = 2 * 1024;
const MAX_EVENTS_PER_READ: usize = 1_000;

/// One app-process writer keeps read → validate → append atomic. Embedded MCP
/// and socket adapters terminate in this process and therefore share the same
/// gate. The journal remains the only durable authority across restarts.
#[derive(Default)]
pub struct CoordinationStoreState {
    write_gate: Mutex<()>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CoordinationWorkerKind {
    Harness,
    Delegate,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CoordinationRunState {
    Queued,
    Starting,
    Working,
    Blocked,
    Waiting,
    Reviewing,
    Done,
    Failed,
    Cancelled,
}

impl CoordinationRunState {
    fn is_terminal(self) -> bool {
        matches!(self, Self::Done | Self::Failed | Self::Cancelled)
    }

    fn may_transition_to(self, next: Self) -> bool {
        use CoordinationRunState::*;
        matches!(
            (self, next),
            (Queued, Starting | Working | Failed | Cancelled)
                | (Starting, Working | Blocked | Waiting | Failed | Cancelled)
                | (
                    Working,
                    Blocked | Waiting | Reviewing | Done | Failed | Cancelled
                )
                | (Blocked, Working | Waiting | Failed | Cancelled)
                | (
                    Waiting,
                    Working | Blocked | Reviewing | Done | Failed | Cancelled
                )
                | (Reviewing, Working | Done | Failed | Cancelled)
        )
    }
}

/// Immutable routing metadata for one Run. A child must name an already
/// registered parent, which makes cycles impossible and lets authorization
/// follow explicit lineage rather than whichever panel happens to be focused.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoordinationRunRegistration {
    pub run_id: String,
    pub worker_kind: CoordinationWorkerKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_run_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mission_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mission_task_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum CoordinationActor {
    Operator,
    Run { run_id: String },
}

impl CoordinationActor {
    fn run_id(&self) -> Option<&str> {
        match self {
            Self::Operator => None,
            Self::Run { run_id } => Some(run_id),
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CoordinationEnvelopeKind {
    Instruction,
    Question,
    Answer,
    Progress,
    Handoff,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CoordinationSourceType {
    Run,
    Transcript,
    Commit,
    File,
    Memory,
    MissionTask,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoordinationSourceRef {
    pub source_type: CoordinationSourceType,
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line_start: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line_end: Option<u32>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoordinationEnvelope {
    pub id: String,
    pub from: CoordinationActor,
    pub to_run_id: String,
    pub kind: CoordinationEnvelopeKind,
    pub body: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reply_to: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub correlation_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub idempotency_key: Option<String>,
    #[serde(default)]
    pub source_refs: Vec<CoordinationSourceRef>,
    pub created_at_ms: i64,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CoordinationDeliveryState {
    Queued,
    Delivered,
    Acknowledged,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CoordinationResultStatus {
    Succeeded,
    Partial,
    Failed,
    Cancelled,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CoordinationArtifactKind {
    File,
    Commit,
    Transcript,
    Diff,
    Memory,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoordinationArtifact {
    pub kind: CoordinationArtifactKind,
    pub reference: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoordinationResult {
    pub id: String,
    pub run_id: String,
    pub status: CoordinationResultStatus,
    pub summary: String,
    #[serde(default)]
    pub artifacts: Vec<CoordinationArtifact>,
    #[serde(default)]
    pub source_refs: Vec<CoordinationSourceRef>,
    pub published_at_ms: i64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum CoordinationEvent {
    RunRegistered {
        registration: CoordinationRunRegistration,
        state: CoordinationRunState,
    },
    RunStateChanged {
        actor: CoordinationActor,
        run_id: String,
        from_state: CoordinationRunState,
        to_state: CoordinationRunState,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
    },
    EnvelopeQueued {
        envelope: CoordinationEnvelope,
    },
    EnvelopeDelivered {
        envelope_id: String,
        run_id: String,
    },
    EnvelopeAcknowledged {
        envelope_id: String,
        run_id: String,
    },
    CancelRequested {
        actor: CoordinationActor,
        run_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
    },
    ResultPublished {
        result: CoordinationResult,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoordinationEventLine {
    pub schema_version: u8,
    pub seq: u64,
    pub ts: i64,
    pub event: CoordinationEvent,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoordinationCancelRequest {
    pub actor: CoordinationActor,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub requested_at_ms: i64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoordinationRunSnapshot {
    pub registration: CoordinationRunRegistration,
    pub state: CoordinationRunState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state_reason: Option<String>,
    pub registered_at_ms: i64,
    pub state_changed_at_ms: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cancel_request: Option<CoordinationCancelRequest>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoordinationEnvelopeSnapshot {
    pub envelope: CoordinationEnvelope,
    pub delivery_state: CoordinationDeliveryState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delivered_at_ms: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub acknowledged_at_ms: Option<i64>,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoordinationSnapshot {
    pub schema_version: u8,
    /// Inclusive cursor for the next event read. A subscriber asks for events
    /// from this sequence after taking the snapshot.
    pub next_seq: u64,
    pub runs: Vec<CoordinationRunSnapshot>,
    pub envelopes: Vec<CoordinationEnvelopeSnapshot>,
    pub results: Vec<CoordinationResult>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum CoordinationCommand {
    RegisterRun {
        registration: CoordinationRunRegistration,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        initial_state: Option<CoordinationRunState>,
    },
    SetRunState {
        actor: CoordinationActor,
        run_id: String,
        state: CoordinationRunState,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
    },
    SendEnvelope {
        from: CoordinationActor,
        to_run_id: String,
        kind: CoordinationEnvelopeKind,
        body: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reply_to: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        correlation_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        idempotency_key: Option<String>,
        #[serde(default)]
        source_refs: Vec<CoordinationSourceRef>,
    },
    MarkEnvelopeDelivered {
        run_id: String,
        envelope_id: String,
    },
    AcknowledgeEnvelope {
        run_id: String,
        envelope_id: String,
    },
    RequestCancel {
        actor: CoordinationActor,
        run_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
    },
    PublishResult {
        run_id: String,
        status: CoordinationResultStatus,
        summary: String,
        #[serde(default)]
        artifacts: Vec<CoordinationArtifact>,
        #[serde(default)]
        source_refs: Vec<CoordinationSourceRef>,
    },
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoordinationCommandOutcome {
    /// `None` means an idempotent command was already represented by the
    /// journal. The returned snapshot is still current.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub appended: Option<CoordinationEventLine>,
    pub snapshot: CoordinationSnapshot,
}

fn validate_component(id: &str, label: &str) -> Result<(), String> {
    if id.trim().is_empty() || id.len() > 180 || id.contains('\\') {
        return Err(format!("Invalid {label} id."));
    }
    let mut components = Path::new(id).components();
    match (components.next(), components.next()) {
        (Some(Component::Normal(_)), None) => Ok(()),
        _ => Err(format!("Invalid {label} id.")),
    }
}

fn validate_optional_text(value: &Option<String>, label: &str, max: usize) -> Result<(), String> {
    if let Some(value) = value {
        if value.trim().is_empty() {
            return Err(format!("{label} cannot be blank."));
        }
        if value.len() > max {
            return Err(format!("{label} is too long (maximum {max} bytes)."));
        }
    }
    Ok(())
}

fn validate_relative_path(path: &str) -> Result<(), String> {
    let path = Path::new(path);
    if path.as_os_str().is_empty()
        || path.is_absolute()
        || path
            .components()
            .any(|part| !matches!(part, Component::Normal(_) | Component::CurDir))
    {
        return Err("Coordination source paths must be Workspace-relative.".to_string());
    }
    Ok(())
}

fn validate_source_refs(refs: &[CoordinationSourceRef]) -> Result<(), String> {
    if refs.len() > 64 {
        return Err("A coordination record can carry at most 64 source references.".to_string());
    }
    for source in refs {
        if source.id.trim().is_empty() || source.id.len() > MAX_REFERENCE_BYTES {
            return Err("Coordination source ids must be non-empty and bounded.".to_string());
        }
        validate_optional_text(&source.label, "Source label", 240)?;
        if let Some(path) = &source.path {
            validate_relative_path(path)?;
        }
        if source.line_end.is_some() && source.line_start.is_none() {
            return Err("lineEnd requires lineStart on a coordination source.".to_string());
        }
        if let (Some(start), Some(end)) = (source.line_start, source.line_end) {
            if start == 0 || end < start {
                return Err("Invalid coordination source line range.".to_string());
            }
        } else if source.line_start == Some(0) {
            return Err("Coordination source lines are one-based.".to_string());
        }
    }
    Ok(())
}

fn validate_artifacts(artifacts: &[CoordinationArtifact]) -> Result<(), String> {
    if artifacts.len() > 64 {
        return Err("A coordination result can carry at most 64 artifacts.".to_string());
    }
    for artifact in artifacts {
        if artifact.reference.trim().is_empty() || artifact.reference.len() > MAX_REFERENCE_BYTES {
            return Err("Coordination artifact references must be non-empty and bounded.".into());
        }
        validate_optional_text(&artifact.label, "Artifact label", 240)?;
        if matches!(artifact.kind, CoordinationArtifactKind::File) {
            validate_relative_path(&artifact.reference)?;
        }
    }
    Ok(())
}

fn validate_registration(
    snapshot: &CoordinationSnapshot,
    registration: &CoordinationRunRegistration,
) -> Result<(), String> {
    validate_run_id(&registration.run_id)?;
    validate_optional_text(&registration.label, "Run label", 160)?;
    if registration.mission_id.is_some() != registration.mission_task_id.is_some() {
        return Err(
            "A coordinated Mission Run must carry both missionId and missionTaskId.".into(),
        );
    }
    if let Some(id) = &registration.mission_id {
        validate_component(id, "Mission")?;
    }
    if let Some(id) = &registration.mission_task_id {
        validate_component(id, "Mission Task")?;
    }
    if let Some(parent_id) = &registration.parent_run_id {
        validate_run_id(parent_id)?;
        if parent_id == &registration.run_id {
            return Err("A Run cannot be its own coordination parent.".into());
        }
        if find_run(snapshot, parent_id).is_none() {
            return Err(format!(
                "Coordination parent Run `{parent_id}` must be registered first."
            ));
        }
    }
    Ok(())
}

fn find_run<'a>(
    snapshot: &'a CoordinationSnapshot,
    run_id: &str,
) -> Option<&'a CoordinationRunSnapshot> {
    snapshot
        .runs
        .iter()
        .find(|run| run.registration.run_id == run_id)
}

fn find_run_mut<'a>(
    snapshot: &'a mut CoordinationSnapshot,
    run_id: &str,
) -> Option<&'a mut CoordinationRunSnapshot> {
    snapshot
        .runs
        .iter_mut()
        .find(|run| run.registration.run_id == run_id)
}

fn find_envelope<'a>(
    snapshot: &'a CoordinationSnapshot,
    envelope_id: &str,
) -> Option<&'a CoordinationEnvelopeSnapshot> {
    snapshot
        .envelopes
        .iter()
        .find(|entry| entry.envelope.id == envelope_id)
}

fn find_envelope_mut<'a>(
    snapshot: &'a mut CoordinationSnapshot,
    envelope_id: &str,
) -> Option<&'a mut CoordinationEnvelopeSnapshot> {
    snapshot
        .envelopes
        .iter_mut()
        .find(|entry| entry.envelope.id == envelope_id)
}

fn validate_actor(
    snapshot: &CoordinationSnapshot,
    actor: &CoordinationActor,
) -> Result<(), String> {
    if let Some(run_id) = actor.run_id() {
        validate_run_id(run_id)?;
        if find_run(snapshot, run_id).is_none() {
            return Err(format!(
                "Coordination actor Run `{run_id}` is not registered."
            ));
        }
    }
    Ok(())
}

fn is_parent_child(snapshot: &CoordinationSnapshot, left: &str, right: &str) -> bool {
    find_run(snapshot, left).and_then(|run| run.registration.parent_run_id.as_deref())
        == Some(right)
        || find_run(snapshot, right).and_then(|run| run.registration.parent_run_id.as_deref())
            == Some(left)
}

fn shares_mission(snapshot: &CoordinationSnapshot, left: &str, right: &str) -> bool {
    let Some(left) = find_run(snapshot, left) else {
        return false;
    };
    let Some(right) = find_run(snapshot, right) else {
        return false;
    };
    left.registration.mission_id.is_some()
        && left.registration.mission_id == right.registration.mission_id
}

/// A Run may exchange envelopes with its direct parent/children and with Runs
/// participating in the same Mission. The operator can address any Run. This
/// is deliberately narrower than "any live process on the machine".
fn may_message(
    snapshot: &CoordinationSnapshot,
    actor: &CoordinationActor,
    target_run_id: &str,
) -> bool {
    match actor {
        CoordinationActor::Operator => true,
        CoordinationActor::Run { run_id } => {
            run_id == target_run_id
                || is_parent_child(snapshot, run_id, target_run_id)
                || shares_mission(snapshot, run_id, target_run_id)
        }
    }
}

/// Cancellation is stronger than messaging: a Run can request cancellation
/// only for itself or a direct child. The operator remains the broad owner.
fn may_cancel(
    snapshot: &CoordinationSnapshot,
    actor: &CoordinationActor,
    target_run_id: &str,
) -> bool {
    match actor {
        CoordinationActor::Operator => true,
        CoordinationActor::Run { run_id } => {
            run_id == target_run_id
                || find_run(snapshot, target_run_id)
                    .and_then(|run| run.registration.parent_run_id.as_deref())
                    == Some(run_id)
        }
    }
}

fn mint_id(prefix: &str) -> Result<String, String> {
    let mut bytes = [0u8; 12];
    getrandom::fill(&mut bytes).map_err(|e| format!("OS RNG unavailable: {e}"))?;
    let suffix = bytes
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    Ok(format!("{prefix}_{suffix}"))
}

fn apply_event(
    snapshot: &mut CoordinationSnapshot,
    line: &CoordinationEventLine,
) -> Result<(), String> {
    match &line.event {
        CoordinationEvent::RunRegistered {
            registration,
            state,
        } => {
            if find_run(snapshot, &registration.run_id).is_some() {
                return Err(format!(
                    "Run `{}` was registered more than once.",
                    registration.run_id
                ));
            }
            validate_registration(snapshot, registration)?;
            snapshot.runs.push(CoordinationRunSnapshot {
                registration: registration.clone(),
                state: *state,
                state_reason: None,
                registered_at_ms: line.ts,
                state_changed_at_ms: line.ts,
                cancel_request: None,
            });
        }
        CoordinationEvent::RunStateChanged {
            actor,
            run_id,
            from_state,
            to_state,
            reason,
        } => {
            validate_actor(snapshot, actor)?;
            validate_optional_text(reason, "State reason", MAX_REASON_BYTES)?;
            if !matches!(actor, CoordinationActor::Operator)
                && actor.run_id() != Some(run_id.as_str())
            {
                return Err("A Run may publish coordination state only for itself.".into());
            }
            let run = find_run_mut(snapshot, run_id)
                .ok_or_else(|| format!("Coordination Run `{run_id}` is not registered."))?;
            if run.state != *from_state {
                return Err(format!(
                    "Run `{run_id}` state projection expected {from_state:?}, found {:?}.",
                    run.state
                ));
            }
            if from_state == to_state || !from_state.may_transition_to(*to_state) {
                return Err(format!(
                    "Invalid coordination state transition for `{run_id}`: {from_state:?} → {to_state:?}."
                ));
            }
            run.state = *to_state;
            run.state_reason = reason.clone();
            run.state_changed_at_ms = line.ts;
        }
        CoordinationEvent::EnvelopeQueued { envelope } => {
            validate_actor(snapshot, &envelope.from)?;
            validate_run_id(&envelope.to_run_id)?;
            let target = find_run(snapshot, &envelope.to_run_id).ok_or_else(|| {
                format!(
                    "Coordination target Run `{}` is not registered.",
                    envelope.to_run_id
                )
            })?;
            if target.state.is_terminal() {
                return Err(format!(
                    "Coordination target Run `{}` is already terminal.",
                    envelope.to_run_id
                ));
            }
            if !may_message(snapshot, &envelope.from, &envelope.to_run_id) {
                return Err("The coordination actor cannot address that Run.".into());
            }
            if envelope.body.trim().is_empty() || envelope.body.len() > MAX_BODY_BYTES {
                return Err(format!(
                    "Coordination envelope bodies must be 1–{MAX_BODY_BYTES} bytes."
                ));
            }
            validate_component(&envelope.id, "Envelope")?;
            validate_optional_text(&envelope.correlation_id, "Correlation id", 180)?;
            validate_optional_text(&envelope.idempotency_key, "Idempotency key", 180)?;
            validate_source_refs(&envelope.source_refs)?;
            if find_envelope(snapshot, &envelope.id).is_some() {
                return Err(format!("Envelope `{}` already exists.", envelope.id));
            }
            if let Some(reply_to) = &envelope.reply_to {
                validate_component(reply_to, "Reply envelope")?;
                let prior = find_envelope(snapshot, reply_to)
                    .ok_or_else(|| format!("Reply envelope `{reply_to}` does not exist."))?;
                let from_run = envelope.from.run_id();
                let prior_from_run = prior.envelope.from.run_id();
                let participates = from_run == Some(prior.envelope.to_run_id.as_str())
                    || prior_from_run == Some(envelope.to_run_id.as_str());
                if !participates {
                    return Err(
                        "A reply must remain between participants in the original envelope.".into(),
                    );
                }
            }
            snapshot.envelopes.push(CoordinationEnvelopeSnapshot {
                envelope: envelope.clone(),
                delivery_state: CoordinationDeliveryState::Queued,
                delivered_at_ms: None,
                acknowledged_at_ms: None,
            });
        }
        CoordinationEvent::EnvelopeDelivered {
            envelope_id,
            run_id,
        } => {
            validate_run_id(run_id)?;
            let envelope = find_envelope_mut(snapshot, envelope_id)
                .ok_or_else(|| format!("Envelope `{envelope_id}` does not exist."))?;
            if envelope.envelope.to_run_id != *run_id {
                return Err("Only the addressed Run may receive an envelope.".into());
            }
            if envelope.delivery_state != CoordinationDeliveryState::Queued {
                return Err(format!("Envelope `{envelope_id}` is not queued."));
            }
            envelope.delivery_state = CoordinationDeliveryState::Delivered;
            envelope.delivered_at_ms = Some(line.ts);
        }
        CoordinationEvent::EnvelopeAcknowledged {
            envelope_id,
            run_id,
        } => {
            validate_run_id(run_id)?;
            let envelope = find_envelope_mut(snapshot, envelope_id)
                .ok_or_else(|| format!("Envelope `{envelope_id}` does not exist."))?;
            if envelope.envelope.to_run_id != *run_id {
                return Err("Only the addressed Run may acknowledge an envelope.".into());
            }
            if envelope.delivery_state != CoordinationDeliveryState::Delivered {
                return Err(format!("Envelope `{envelope_id}` has not been delivered."));
            }
            envelope.delivery_state = CoordinationDeliveryState::Acknowledged;
            envelope.acknowledged_at_ms = Some(line.ts);
        }
        CoordinationEvent::CancelRequested {
            actor,
            run_id,
            reason,
        } => {
            validate_actor(snapshot, actor)?;
            validate_optional_text(reason, "Cancellation reason", MAX_REASON_BYTES)?;
            if !may_cancel(snapshot, actor, run_id) {
                return Err("The coordination actor cannot cancel that Run.".into());
            }
            let run = find_run_mut(snapshot, run_id)
                .ok_or_else(|| format!("Coordination Run `{run_id}` is not registered."))?;
            if run.state.is_terminal() {
                return Err(format!("Coordination Run `{run_id}` is already terminal."));
            }
            if run.cancel_request.is_some() {
                return Err(format!(
                    "Cancellation was already requested for `{run_id}`."
                ));
            }
            run.cancel_request = Some(CoordinationCancelRequest {
                actor: actor.clone(),
                reason: reason.clone(),
                requested_at_ms: line.ts,
            });
        }
        CoordinationEvent::ResultPublished { result } => {
            validate_run_id(&result.run_id)?;
            if find_run(snapshot, &result.run_id).is_none() {
                return Err(format!(
                    "Coordination Run `{}` is not registered.",
                    result.run_id
                ));
            }
            validate_component(&result.id, "Result")?;
            if result.summary.trim().is_empty() || result.summary.len() > MAX_SUMMARY_BYTES {
                return Err(format!(
                    "Coordination result summaries must be 1–{MAX_SUMMARY_BYTES} bytes."
                ));
            }
            validate_artifacts(&result.artifacts)?;
            validate_source_refs(&result.source_refs)?;
            if snapshot
                .results
                .iter()
                .any(|prior| prior.run_id == result.run_id)
            {
                return Err(format!(
                    "Coordination Run `{}` already published a result.",
                    result.run_id
                ));
            }
            snapshot.results.push(result.clone());
        }
    }
    snapshot.next_seq = line.seq + 1;
    Ok(())
}

fn fold_events(events: &[CoordinationEventLine]) -> Result<CoordinationSnapshot, String> {
    let mut snapshot = CoordinationSnapshot {
        schema_version: COORDINATION_SCHEMA_VERSION,
        ..CoordinationSnapshot::default()
    };
    for line in events {
        apply_event(&mut snapshot, line).map_err(|error| {
            format!(
                "Coordination event seq {} violates the domain contract: {error}",
                line.seq
            )
        })?;
    }
    Ok(snapshot)
}

fn main_checkout_root(root: &Path) -> Option<PathBuf> {
    let git_marker = root.join(".git");
    if !std::fs::symlink_metadata(&git_marker).ok()?.is_file() {
        return None;
    }
    let content = std::fs::read_to_string(&git_marker).ok()?;
    let gitdir = content
        .lines()
        .find_map(|line| line.strip_prefix("gitdir:"))?
        .trim();
    let gitdir = if Path::new(gitdir).is_absolute() {
        PathBuf::from(gitdir)
    } else {
        root.join(gitdir)
    };
    let canonical = std::fs::canonicalize(gitdir).ok()?;
    let mut current = canonical.as_path();
    while let Some(parent) = current.parent() {
        if current.file_name().and_then(|name| name.to_str()) == Some(".git") {
            return Some(parent.to_path_buf());
        }
        current = parent;
    }
    None
}

/// Coordination crosses private worktrees. Resolve `.klide/coordination`
/// against the checkout that owns the real `.git` directory so all Runs see
/// the same inbox and journal.
fn effective_workspace(workspace_root: &str) -> Result<Workspace, String> {
    let base = Workspace::new(workspace_root)?;
    let Some(main_root) = main_checkout_root(base.root()) else {
        return Ok(base);
    };
    Workspace::new(
        main_root
            .to_str()
            .ok_or_else(|| "Main checkout path is not valid UTF-8.".to_string())?,
    )
}

fn coordination_dir(workspace_root: &str, create: bool) -> Result<Option<PathBuf>, String> {
    let workspace = effective_workspace(workspace_root)?;
    if !create {
        return Ok(workspace.resolve_existing(".klide/coordination").ok());
    }
    let dir = workspace.resolve_new(".klide/coordination")?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Unable to create .klide/coordination: {e}"))?;
    Ok(Some(workspace.resolve_existing(".klide/coordination")?))
}

fn events_path(dir: &Path) -> PathBuf {
    dir.join("events.jsonl")
}

fn read_events_unlocked(workspace_root: &str) -> Result<Vec<CoordinationEventLine>, String> {
    let Some(dir) = coordination_dir(workspace_root, false)? else {
        return Ok(Vec::new());
    };
    let path = events_path(&dir);
    if !path.exists() {
        return Ok(Vec::new());
    }
    let raw = std::fs::read_to_string(&path)
        .map_err(|e| format!("Unable to read coordination journal: {e}"))?;
    let mut events = Vec::new();
    for (index, text) in raw.lines().enumerate() {
        if text.trim().is_empty() {
            continue;
        }
        let line: CoordinationEventLine = serde_json::from_str(text).map_err(|e| {
            format!(
                "Coordination journal {path:?} is corrupt at line {}: {e}. Klide will not guess past durable inter-agent state.",
                index + 1
            )
        })?;
        if line.schema_version != COORDINATION_SCHEMA_VERSION {
            return Err(format!(
                "Coordination journal {path:?} line {} has unsupported schemaVersion {} (expected {COORDINATION_SCHEMA_VERSION}).",
                index + 1,
                line.schema_version
            ));
        }
        let expected = events.len() as u64;
        if line.seq != expected {
            return Err(format!(
                "Coordination journal {path:?} line {} breaks sequence ordering (expected seq {expected}, found {}).",
                index + 1,
                line.seq
            ));
        }
        events.push(line);
    }
    // Validate semantic references and transitions during every replay, not
    // only when this build authored the event.
    let _ = fold_events(&events)?;
    Ok(events)
}

fn idempotent_event(
    snapshot: &CoordinationSnapshot,
    command: &CoordinationCommand,
) -> Result<bool, String> {
    match command {
        CoordinationCommand::RegisterRun {
            registration,
            initial_state: _,
        } => {
            let Some(existing) = find_run(snapshot, &registration.run_id) else {
                return Ok(false);
            };
            // Initial state is meaningful only on first registration. A
            // retry can arrive after the Run has legitimately moved on, so
            // immutable identity decides whether this is the same intent.
            if existing.registration == *registration {
                Ok(true)
            } else {
                Err(format!(
                    "Coordination Run `{}` is already registered with different metadata.",
                    registration.run_id
                ))
            }
        }
        CoordinationCommand::SetRunState { run_id, state, .. } => {
            Ok(find_run(snapshot, run_id).map(|run| run.state) == Some(*state))
        }
        CoordinationCommand::SendEnvelope {
            from,
            to_run_id,
            kind,
            body,
            reply_to,
            correlation_id,
            idempotency_key: Some(key),
            source_refs,
        } => {
            let Some(existing) = snapshot.envelopes.iter().find(|entry| {
                entry.envelope.from == *from
                    && entry.envelope.idempotency_key.as_deref() == Some(key.as_str())
            }) else {
                return Ok(false);
            };
            let envelope = &existing.envelope;
            if envelope.to_run_id == *to_run_id
                && envelope.kind == *kind
                && envelope.body == *body
                && envelope.reply_to == *reply_to
                && envelope.correlation_id == *correlation_id
                && envelope.source_refs == *source_refs
            {
                Ok(true)
            } else {
                Err(format!(
                    "Idempotency key `{key}` was already used for a different coordination envelope."
                ))
            }
        }
        CoordinationCommand::MarkEnvelopeDelivered {
            envelope_id,
            run_id,
        } => Ok(find_envelope(snapshot, envelope_id).is_some_and(|entry| {
            entry.envelope.to_run_id == *run_id
                && matches!(
                    entry.delivery_state,
                    CoordinationDeliveryState::Delivered | CoordinationDeliveryState::Acknowledged
                )
        })),
        CoordinationCommand::AcknowledgeEnvelope {
            envelope_id,
            run_id,
        } => Ok(find_envelope(snapshot, envelope_id).is_some_and(|entry| {
            entry.envelope.to_run_id == *run_id
                && entry.delivery_state == CoordinationDeliveryState::Acknowledged
        })),
        CoordinationCommand::RequestCancel {
            actor,
            run_id,
            reason,
        } => {
            let Some(existing) =
                find_run(snapshot, run_id).and_then(|run| run.cancel_request.as_ref())
            else {
                return Ok(false);
            };
            if existing.actor == *actor && existing.reason == *reason {
                Ok(true)
            } else {
                Err(format!(
                    "Cancellation for `{run_id}` was already requested with different intent."
                ))
            }
        }
        CoordinationCommand::PublishResult {
            run_id,
            status,
            summary,
            artifacts,
            source_refs,
        } => {
            let Some(existing) = snapshot
                .results
                .iter()
                .find(|result| result.run_id == *run_id)
            else {
                return Ok(false);
            };
            if existing.status == *status
                && existing.summary == *summary
                && existing.artifacts == *artifacts
                && existing.source_refs == *source_refs
            {
                Ok(true)
            } else {
                Err(format!(
                    "Coordination Run `{run_id}` already published a different result."
                ))
            }
        }
        CoordinationCommand::SendEnvelope {
            idempotency_key: None,
            ..
        } => Ok(false),
    }
}

fn event_for_command(
    snapshot: &CoordinationSnapshot,
    command: CoordinationCommand,
    ts: i64,
) -> Result<CoordinationEvent, String> {
    match command {
        CoordinationCommand::RegisterRun {
            registration,
            initial_state,
        } => Ok(CoordinationEvent::RunRegistered {
            registration,
            state: initial_state.unwrap_or(CoordinationRunState::Queued),
        }),
        CoordinationCommand::SetRunState {
            actor,
            run_id,
            state,
            reason,
        } => {
            let from_state = find_run(snapshot, &run_id)
                .ok_or_else(|| format!("Coordination Run `{run_id}` is not registered."))?
                .state;
            Ok(CoordinationEvent::RunStateChanged {
                actor,
                run_id,
                from_state,
                to_state: state,
                reason,
            })
        }
        CoordinationCommand::SendEnvelope {
            from,
            to_run_id,
            kind,
            body,
            reply_to,
            correlation_id,
            idempotency_key,
            source_refs,
        } => Ok(CoordinationEvent::EnvelopeQueued {
            envelope: CoordinationEnvelope {
                id: mint_id("env")?,
                from,
                to_run_id,
                kind,
                body,
                reply_to,
                correlation_id,
                idempotency_key,
                source_refs,
                created_at_ms: ts,
            },
        }),
        CoordinationCommand::MarkEnvelopeDelivered {
            run_id,
            envelope_id,
        } => Ok(CoordinationEvent::EnvelopeDelivered {
            envelope_id,
            run_id,
        }),
        CoordinationCommand::AcknowledgeEnvelope {
            run_id,
            envelope_id,
        } => Ok(CoordinationEvent::EnvelopeAcknowledged {
            envelope_id,
            run_id,
        }),
        CoordinationCommand::RequestCancel {
            actor,
            run_id,
            reason,
        } => Ok(CoordinationEvent::CancelRequested {
            actor,
            run_id,
            reason,
        }),
        CoordinationCommand::PublishResult {
            run_id,
            status,
            summary,
            artifacts,
            source_refs,
        } => Ok(CoordinationEvent::ResultPublished {
            result: CoordinationResult {
                id: mint_id("result")?,
                run_id,
                status,
                summary,
                artifacts,
                source_refs,
                published_at_ms: ts,
            },
        }),
    }
}

pub(crate) fn apply_coordination_command(
    state: &CoordinationStoreState,
    workspace_root: &str,
    command: CoordinationCommand,
) -> Result<CoordinationCommandOutcome, String> {
    let _guard = state
        .write_gate
        .lock()
        .map_err(|_| "Coordination store lock is poisoned.".to_string())?;
    let events = read_events_unlocked(workspace_root)?;
    let snapshot = fold_events(&events)?;
    if idempotent_event(&snapshot, &command)? {
        return Ok(CoordinationCommandOutcome {
            appended: None,
            snapshot,
        });
    }

    let ts = now_ms();
    let event = event_for_command(&snapshot, command, ts)?;
    let line = CoordinationEventLine {
        schema_version: COORDINATION_SCHEMA_VERSION,
        seq: snapshot.next_seq,
        ts,
        event,
    };
    let mut next_snapshot = snapshot;
    apply_event(&mut next_snapshot, &line)?;

    let dir = coordination_dir(workspace_root, true)?
        .ok_or_else(|| "Unable to resolve coordination directory.".to_string())?;
    let encoded = serde_json::to_string(&line)
        .map_err(|e| format!("Unable to encode coordination event: {e}"))?;
    crate::durable::append_line(&events_path(&dir), &encoded)
        .map_err(|e| format!("Unable to append coordination event: {e}"))?;

    Ok(CoordinationCommandOutcome {
        appended: Some(line),
        snapshot: next_snapshot,
    })
}

fn read_snapshot(
    state: &CoordinationStoreState,
    workspace_root: &str,
) -> Result<CoordinationSnapshot, String> {
    let _guard = state
        .write_gate
        .lock()
        .map_err(|_| "Coordination store lock is poisoned.".to_string())?;
    fold_events(&read_events_unlocked(workspace_root)?)
}

#[tauri::command]
pub fn coordination_apply_command(
    state: tauri::State<'_, CoordinationStoreState>,
    workspace_root: String,
    command: CoordinationCommand,
) -> Result<CoordinationCommandOutcome, String> {
    // This is a trusted local supervisor seam. MCP/socket adapters must not
    // expose it verbatim: they bind the caller's Run identity, then construct
    // a command with that actor on the Rust side.
    apply_coordination_command(&state, &workspace_root, command)
}

#[tauri::command]
pub fn coordination_snapshot(
    state: tauri::State<'_, CoordinationStoreState>,
    workspace_root: String,
) -> Result<CoordinationSnapshot, String> {
    read_snapshot(&state, &workspace_root)
}

#[tauri::command]
pub fn coordination_events(
    state: tauri::State<'_, CoordinationStoreState>,
    workspace_root: String,
    from_seq: Option<u64>,
    limit: Option<usize>,
) -> Result<Vec<CoordinationEventLine>, String> {
    let _guard = state
        .write_gate
        .lock()
        .map_err(|_| "Coordination store lock is poisoned.".to_string())?;
    let from = from_seq.unwrap_or(0);
    let limit = limit.unwrap_or(200).clamp(1, MAX_EVENTS_PER_READ);
    Ok(read_events_unlocked(&workspace_root)?
        .into_iter()
        .filter(|line| line.seq >= from)
        .take(limit)
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_workspace(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "klide-coordination-test-{name}-{}-{}",
            std::process::id(),
            now_ms()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn registration(run_id: &str, parent: Option<&str>) -> CoordinationRunRegistration {
        CoordinationRunRegistration {
            run_id: run_id.to_string(),
            worker_kind: CoordinationWorkerKind::Harness,
            parent_run_id: parent.map(str::to_string),
            mission_id: None,
            mission_task_id: None,
            label: None,
        }
    }

    fn rust_event_types() -> Vec<String> {
        let source = std::fs::read_to_string(
            Path::new(env!("CARGO_MANIFEST_DIR")).join("src/coordination.rs"),
        )
        .expect("read coordination Rust source");
        let start = source
            .find("pub enum CoordinationEvent {")
            .expect("CoordinationEvent enum");
        let body = &source[start..];
        let end = body.find("\n}").expect("end of CoordinationEvent enum");
        body[..end]
            .lines()
            .filter_map(|line| line.strip_prefix("    ")?.strip_suffix(" {"))
            .filter(|name| {
                name.starts_with(|ch: char| ch.is_ascii_uppercase())
                    && name.chars().all(|ch| ch.is_ascii_alphanumeric())
            })
            .map(|variant| {
                let mut out = String::new();
                for (index, ch) in variant.char_indices() {
                    if ch.is_ascii_uppercase() {
                        if index != 0 {
                            out.push('_');
                        }
                        out.push(ch.to_ascii_lowercase());
                    } else {
                        out.push(ch);
                    }
                }
                out
            })
            .collect()
    }

    fn register(
        state: &CoordinationStoreState,
        root: &Path,
        run_id: &str,
        parent: Option<&str>,
    ) -> CoordinationCommandOutcome {
        apply_coordination_command(
            state,
            root.to_str().unwrap(),
            CoordinationCommand::RegisterRun {
                registration: registration(run_id, parent),
                initial_state: None,
            },
        )
        .unwrap()
    }

    fn send(
        state: &CoordinationStoreState,
        root: &Path,
        from: CoordinationActor,
        to: &str,
        key: Option<&str>,
    ) -> Result<CoordinationCommandOutcome, String> {
        apply_coordination_command(
            state,
            root.to_str().unwrap(),
            CoordinationCommand::SendEnvelope {
                from,
                to_run_id: to.to_string(),
                kind: CoordinationEnvelopeKind::Question,
                body: "What did you find?".to_string(),
                reply_to: None,
                correlation_id: Some("investigation".to_string()),
                idempotency_key: key.map(str::to_string),
                source_refs: vec![],
            },
        )
    }

    #[test]
    fn empty_snapshot_is_read_only() {
        let root = temp_workspace("empty");
        let state = CoordinationStoreState::default();
        let snapshot = read_snapshot(&state, root.to_str().unwrap()).unwrap();
        assert_eq!(snapshot.schema_version, COORDINATION_SCHEMA_VERSION);
        assert_eq!(snapshot.next_seq, 0);
        assert!(snapshot.runs.is_empty());
        assert!(!root.join(".klide").exists());
    }

    #[test]
    fn registration_and_state_replay_survive_a_fresh_store_state() {
        let root = temp_workspace("replay");
        let state = CoordinationStoreState::default();
        register(&state, &root, "run_parent", None);
        register(&state, &root, "run_child", Some("run_parent"));
        apply_coordination_command(
            &state,
            root.to_str().unwrap(),
            CoordinationCommand::SetRunState {
                actor: CoordinationActor::Run {
                    run_id: "run_child".into(),
                },
                run_id: "run_child".into(),
                state: CoordinationRunState::Starting,
                reason: Some("provider boot".into()),
            },
        )
        .unwrap();

        let replayed =
            read_snapshot(&CoordinationStoreState::default(), root.to_str().unwrap()).unwrap();
        assert_eq!(replayed.next_seq, 3);
        let child = find_run(&replayed, "run_child").unwrap();
        assert_eq!(child.state, CoordinationRunState::Starting);
        assert_eq!(child.state_reason.as_deref(), Some("provider boot"));

        // A lost registration response can be retried after later state
        // events. Immutable metadata makes it the same intent; current state
        // must not make the retry fail or append another registration.
        let retry = register(&state, &root, "run_child", Some("run_parent"));
        assert!(retry.appended.is_none());
        assert_eq!(retry.snapshot.next_seq, 3);
    }

    #[test]
    fn parent_child_messages_are_durable_and_idempotent() {
        let root = temp_workspace("envelope");
        let state = CoordinationStoreState::default();
        register(&state, &root, "run_parent", None);
        register(&state, &root, "run_child", Some("run_parent"));

        let first = send(
            &state,
            &root,
            CoordinationActor::Run {
                run_id: "run_parent".into(),
            },
            "run_child",
            Some("question-1"),
        )
        .unwrap();
        assert!(first.appended.is_some());
        let second = send(
            &state,
            &root,
            CoordinationActor::Run {
                run_id: "run_parent".into(),
            },
            "run_child",
            Some("question-1"),
        )
        .unwrap();
        assert!(second.appended.is_none());
        assert_eq!(second.snapshot.envelopes.len(), 1);
        assert_eq!(second.snapshot.next_seq, 3);

        let error = apply_coordination_command(
            &state,
            root.to_str().unwrap(),
            CoordinationCommand::SendEnvelope {
                from: CoordinationActor::Run {
                    run_id: "run_parent".into(),
                },
                to_run_id: "run_child".into(),
                kind: CoordinationEnvelopeKind::Instruction,
                body: "This is a different intent.".into(),
                reply_to: None,
                correlation_id: Some("investigation".into()),
                idempotency_key: Some("question-1".into()),
                source_refs: vec![],
            },
        )
        .unwrap_err();
        assert!(
            error.contains("already used for a different"),
            "got: {error}"
        );
    }

    #[test]
    fn unrelated_runs_cannot_message_or_cancel_one_another() {
        let root = temp_workspace("authority");
        let state = CoordinationStoreState::default();
        register(&state, &root, "run_a", None);
        register(&state, &root, "run_b", None);

        let error = send(
            &state,
            &root,
            CoordinationActor::Run {
                run_id: "run_a".into(),
            },
            "run_b",
            None,
        )
        .unwrap_err();
        assert!(error.contains("cannot address"), "got: {error}");

        let error = apply_coordination_command(
            &state,
            root.to_str().unwrap(),
            CoordinationCommand::RequestCancel {
                actor: CoordinationActor::Run {
                    run_id: "run_a".into(),
                },
                run_id: "run_b".into(),
                reason: None,
            },
        )
        .unwrap_err();
        assert!(error.contains("cannot cancel"), "got: {error}");
    }

    #[test]
    fn operator_can_steer_any_registered_run() {
        let root = temp_workspace("operator");
        let state = CoordinationStoreState::default();
        register(&state, &root, "run_a", None);
        register(&state, &root, "run_b", None);
        assert!(send(&state, &root, CoordinationActor::Operator, "run_b", None,).is_ok());
        let outcome = apply_coordination_command(
            &state,
            root.to_str().unwrap(),
            CoordinationCommand::RequestCancel {
                actor: CoordinationActor::Operator,
                run_id: "run_a".into(),
                reason: Some("operator stopped the work".into()),
            },
        )
        .unwrap();
        assert!(find_run(&outcome.snapshot, "run_a")
            .unwrap()
            .cancel_request
            .is_some());
    }

    #[test]
    fn delivery_requires_the_recipient_and_preserves_lifecycle() {
        let root = temp_workspace("delivery");
        let state = CoordinationStoreState::default();
        register(&state, &root, "run_parent", None);
        register(&state, &root, "run_child", Some("run_parent"));
        let sent = send(
            &state,
            &root,
            CoordinationActor::Operator,
            "run_child",
            None,
        )
        .unwrap();
        let id = sent.snapshot.envelopes[0].envelope.id.clone();

        let error = apply_coordination_command(
            &state,
            root.to_str().unwrap(),
            CoordinationCommand::MarkEnvelopeDelivered {
                run_id: "run_parent".into(),
                envelope_id: id.clone(),
            },
        )
        .unwrap_err();
        assert!(error.contains("addressed Run"), "got: {error}");

        apply_coordination_command(
            &state,
            root.to_str().unwrap(),
            CoordinationCommand::MarkEnvelopeDelivered {
                run_id: "run_child".into(),
                envelope_id: id.clone(),
            },
        )
        .unwrap();
        let acknowledged = apply_coordination_command(
            &state,
            root.to_str().unwrap(),
            CoordinationCommand::AcknowledgeEnvelope {
                run_id: "run_child".into(),
                envelope_id: id,
            },
        )
        .unwrap();
        assert_eq!(
            acknowledged.snapshot.envelopes[0].delivery_state,
            CoordinationDeliveryState::Acknowledged
        );
    }

    #[test]
    fn terminal_state_cannot_reopen() {
        let root = temp_workspace("terminal");
        let state = CoordinationStoreState::default();
        register(&state, &root, "run_one", None);
        for next in [
            CoordinationRunState::Starting,
            CoordinationRunState::Working,
            CoordinationRunState::Done,
        ] {
            apply_coordination_command(
                &state,
                root.to_str().unwrap(),
                CoordinationCommand::SetRunState {
                    actor: CoordinationActor::Run {
                        run_id: "run_one".into(),
                    },
                    run_id: "run_one".into(),
                    state: next,
                    reason: None,
                },
            )
            .unwrap();
        }
        let error = apply_coordination_command(
            &state,
            root.to_str().unwrap(),
            CoordinationCommand::SetRunState {
                actor: CoordinationActor::Operator,
                run_id: "run_one".into(),
                state: CoordinationRunState::Working,
                reason: None,
            },
        )
        .unwrap_err();
        assert!(
            error.contains("Invalid coordination state transition"),
            "got: {error}"
        );
    }

    #[test]
    fn result_is_structured_and_published_once() {
        let root = temp_workspace("result");
        let state = CoordinationStoreState::default();
        register(&state, &root, "run_one", None);
        let command = CoordinationCommand::PublishResult {
            run_id: "run_one".into(),
            status: CoordinationResultStatus::Succeeded,
            summary: "Implemented the parser and verified its fixtures.".into(),
            artifacts: vec![CoordinationArtifact {
                kind: CoordinationArtifactKind::File,
                reference: "src/parser.rs".into(),
                label: Some("parser".into()),
            }],
            source_refs: vec![CoordinationSourceRef {
                source_type: CoordinationSourceType::Transcript,
                id: "run_one:1-9".into(),
                label: None,
                path: None,
                line_start: None,
                line_end: None,
            }],
        };
        let first =
            apply_coordination_command(&state, root.to_str().unwrap(), command.clone()).unwrap();
        assert_eq!(first.snapshot.results.len(), 1);
        let second = apply_coordination_command(&state, root.to_str().unwrap(), command).unwrap();
        assert!(second.appended.is_none());
        assert_eq!(second.snapshot.results, first.snapshot.results);
    }

    #[test]
    fn strict_reader_rejects_corrupt_and_gapped_journals() {
        let root = temp_workspace("strict");
        let dir = root.join(".klide/coordination");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("events.jsonl"), "not json\n").unwrap();
        let error = read_events_unlocked(root.to_str().unwrap()).unwrap_err();
        assert!(error.contains("corrupt at line 1"), "got: {error}");

        let line = CoordinationEventLine {
            schema_version: COORDINATION_SCHEMA_VERSION,
            seq: 2,
            ts: now_ms(),
            event: CoordinationEvent::RunRegistered {
                registration: registration("run_one", None),
                state: CoordinationRunState::Queued,
            },
        };
        std::fs::write(
            dir.join("events.jsonl"),
            format!("{}\n", serde_json::to_string(&line).unwrap()),
        )
        .unwrap();
        let error = read_events_unlocked(root.to_str().unwrap()).unwrap_err();
        assert!(error.contains("expected seq 0, found 2"), "got: {error}");

        let line = CoordinationEventLine {
            schema_version: 0,
            seq: 0,
            ts: now_ms(),
            event: CoordinationEvent::RunRegistered {
                registration: registration("run_one", None),
                state: CoordinationRunState::Queued,
            },
        };
        std::fs::write(
            dir.join("events.jsonl"),
            format!("{}\n", serde_json::to_string(&line).unwrap()),
        )
        .unwrap();
        let error = read_events_unlocked(root.to_str().unwrap()).unwrap_err();
        assert!(
            error.contains("unsupported schemaVersion 0"),
            "got: {error}"
        );
    }

    #[test]
    fn linked_worktrees_share_the_main_coordination_store() {
        let base = temp_workspace("worktree");
        let main = base.join("main");
        let linked = base.join("linked");
        std::fs::create_dir_all(main.join(".git/worktrees/linked")).unwrap();
        std::fs::create_dir_all(&linked).unwrap();
        std::fs::write(
            linked.join(".git"),
            format!("gitdir: {}\n", main.join(".git/worktrees/linked").display()),
        )
        .unwrap();
        let state = CoordinationStoreState::default();
        register(&state, &linked, "run_one", None);
        assert!(main.join(".klide/coordination/events.jsonl").exists());
        assert!(!linked.join(".klide").exists());
        assert_eq!(
            read_snapshot(&state, main.to_str().unwrap())
                .unwrap()
                .runs
                .len(),
            1
        );
    }

    #[test]
    fn event_wire_uses_tagged_snake_case_and_camel_case_fields() {
        let event = CoordinationEvent::RunStateChanged {
            actor: CoordinationActor::Run {
                run_id: "run_one".into(),
            },
            run_id: "run_one".into(),
            from_state: CoordinationRunState::Starting,
            to_state: CoordinationRunState::Working,
            reason: None,
        };
        let value = serde_json::to_value(event).unwrap();
        assert_eq!(value["type"], "run_state_changed");
        assert_eq!(value["runId"], "run_one");
        assert_eq!(value["fromState"], "starting");
        assert_eq!(value["toState"], "working");
        assert!(value.get("reason").is_none());
        assert_eq!(value["actor"]["type"], "run");
        assert_eq!(value["actor"]["runId"], "run_one");
    }

    #[test]
    fn frontend_event_mirror_matches_the_rust_journal_vocabulary() {
        let source = std::fs::read_to_string(
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/agent/coordination.ts"),
        )
        .expect("read coordination TypeScript mirror");
        let marker = "export type CoordinationEvent =";
        let start = source.find(marker).expect("CoordinationEvent mirror") + marker.len();
        let end = source[start..]
            .find("\nexport type CoordinationEventLine")
            .map(|offset| start + offset)
            .expect("end of CoordinationEvent mirror");
        let union = &source[start..end];
        let mut frontend = union
            .match_indices("type: \"")
            .map(|(index, matched)| {
                let rest = &union[index + matched.len()..];
                rest[..rest.find('"').expect("event type closing quote")].to_string()
            })
            .collect::<Vec<_>>();
        frontend.sort();
        frontend.dedup();
        let mut backend = rust_event_types();
        backend.sort();
        assert_eq!(
            backend, frontend,
            "CoordinationEvent drifted between Rust and TypeScript"
        );
    }

    #[test]
    fn published_schemas_are_valid_json() {
        for name in [
            "klide-coordination-command.schema.json",
            "klide-coordination-event.schema.json",
            "klide-coordination-snapshot.schema.json",
        ] {
            let path = Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../schemas")
                .join(name);
            let raw = std::fs::read_to_string(&path)
                .unwrap_or_else(|error| panic!("read {}: {error}", path.display()));
            serde_json::from_str::<serde_json::Value>(&raw)
                .unwrap_or_else(|error| panic!("parse {}: {error}", path.display()));
        }
    }
}
