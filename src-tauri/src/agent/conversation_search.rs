//! Workspace-scoped search over prior Klide Harness Conversations.
//!
//! The Transcript is the durable source of what a Conversation contained, so
//! search reads JSONL events rather than the browser's bounded localStorage
//! index. Results deliberately include user/assistant prose and compaction
//! summaries only: tool outputs are often huge, noisy, and may contain file
//! contents that the user did not mean by "what did we discuss?".

use super::transcripts::{list_summaries, read_events};
use super::types::{AgentContentBlock, AgentEvent};
use serde::Serialize;
use std::path::Path;

/// Bound one query so an old installation with years of Transcripts cannot
/// turn a model tool call into an unbounded disk scan.
const MAX_SCANNED_CONVERSATIONS: usize = 500;
const MAX_SNIPPET_CHARS: usize = 320;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationSearchMatch {
    pub conversation_id: String,
    pub title: String,
    pub role: String,
    pub snippet: String,
    pub match_count: usize,
    pub updated_ms: i64,
    #[serde(skip)]
    score: usize,
}

#[derive(Clone)]
struct SearchSegment {
    role: &'static str,
    text: String,
}

/// Search recent, top-level Klide Conversations from `workspace_root`, newest
/// metadata first and relevance-ranked after their Transcripts are read.
/// `current_run_id` is excluded so the tool does not rediscover the question
/// that invoked it and present that as historical evidence.
pub fn search_conversations(
    runs_dir: &Path,
    workspace_root: &Path,
    current_run_id: &str,
    query: &str,
    limit: usize,
) -> Result<Vec<ConversationSearchMatch>, String> {
    let phrase = normalize_text(query);
    if phrase.is_empty() {
        return Err("search_conversations requires a non-empty query.".to_string());
    }
    let terms = search_terms(query);
    let summaries = list_summaries(runs_dir, Some(MAX_SCANNED_CONVERSATIONS), None)?;
    let mut matches = Vec::new();

    for summary in summaries {
        if summary.id == current_run_id || summary.parent_id.is_some() {
            continue;
        }
        let Some(cwd) = summary.cwd.as_deref() else {
            continue;
        };
        if !same_workspace(cwd, workspace_root) {
            continue;
        }
        // Search is best-effort across independent records. One corrupt old
        // Transcript must not hide every healthy match from the user.
        let Ok(events) = read_events(runs_dir, &summary.id) else {
            continue;
        };
        let segments = searchable_segments(&events);
        let title = conversation_title(&segments, &summary.title);
        let title_normalized = normalize_text(&title);
        let title_matches = text_matches(&title_normalized, &phrase, &terms);

        let mut best: Option<(usize, &SearchSegment)> = None;
        let mut match_count = 0;
        for segment in &segments {
            let normalized = normalize_text(&segment.text);
            if !text_matches(&normalized, &phrase, &terms) {
                continue;
            }
            match_count += 1;
            let exact_phrase = normalized.contains(&phrase);
            let role_score = match segment.role {
                "user" => 30,
                "assistant" => 15,
                _ => 5,
            };
            let score =
                usize::from(exact_phrase) * 100 + usize::from(title_matches) * 40 + role_score;
            if best
                .as_ref()
                .is_none_or(|(best_score, _)| score > *best_score)
            {
                best = Some((score, segment));
            }
        }
        let Some((score, segment)) = best else {
            continue;
        };
        let updated_ms = events
            .last()
            .map(AgentEvent::ts)
            .unwrap_or(summary.updated_ms);
        matches.push(ConversationSearchMatch {
            conversation_id: summary.id,
            title,
            role: segment.role.to_string(),
            snippet: snippet_around_terms(&segment.text, &terms),
            match_count,
            updated_ms,
            score,
        });
    }

    matches.sort_by(|a, b| {
        b.score
            .cmp(&a.score)
            .then_with(|| b.updated_ms.cmp(&a.updated_ms))
            .then_with(|| a.conversation_id.cmp(&b.conversation_id))
    });
    matches.truncate(limit);
    Ok(matches)
}

fn same_workspace(recorded: &str, workspace_root: &Path) -> bool {
    std::fs::canonicalize(recorded)
        .map(|path| path == workspace_root)
        .unwrap_or_else(|_| {
            recorded.trim().trim_end_matches('/')
                == workspace_root.to_string_lossy().trim_end_matches('/')
        })
}

fn searchable_segments(events: &[AgentEvent]) -> Vec<SearchSegment> {
    let mut segments = Vec::new();
    for event in events {
        match event {
            AgentEvent::UserMessage { text, .. } if !text.trim().is_empty() => {
                segments.push(SearchSegment {
                    role: "user",
                    text: text.clone(),
                });
            }
            AgentEvent::AssistantMessage { content, .. } => {
                let text = content
                    .iter()
                    .filter_map(|block| match block {
                        AgentContentBlock::Text { text } => Some(text.trim()),
                        _ => None,
                    })
                    .filter(|text| !text.is_empty())
                    .collect::<Vec<_>>()
                    .join("\n");
                if !text.is_empty() {
                    segments.push(SearchSegment {
                        role: "assistant",
                        text,
                    });
                }
            }
            AgentEvent::ContextCompacted { summary, .. } if !summary.trim().is_empty() => {
                segments.push(SearchSegment {
                    role: "summary",
                    text: summary.clone(),
                });
            }
            _ => {}
        }
    }
    segments
}

fn conversation_title(segments: &[SearchSegment], fallback: &str) -> String {
    let candidate = segments
        .iter()
        .find(|segment| segment.role == "user")
        .map(|segment| segment.text.as_str())
        .unwrap_or(fallback);
    truncate_chars(&collapse_whitespace(candidate), 80)
}

fn normalize_text(text: &str) -> String {
    collapse_whitespace(text).to_lowercase()
}

fn collapse_whitespace(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn search_terms(query: &str) -> Vec<String> {
    query
        .split(|ch: char| !ch.is_alphanumeric())
        .filter(|part| !part.is_empty())
        .map(str::to_lowercase)
        .collect()
}

fn text_matches(text: &str, phrase: &str, terms: &[String]) -> bool {
    text.contains(phrase) || (!terms.is_empty() && terms.iter().all(|term| text.contains(term)))
}

fn snippet_around_terms(text: &str, terms: &[String]) -> String {
    let words: Vec<&str> = text.split_whitespace().collect();
    if words.is_empty() {
        return String::new();
    }
    let first_match = words.iter().position(|word| {
        let normalized = word.to_lowercase();
        terms.iter().any(|term| normalized.contains(term))
    });
    let start = first_match.unwrap_or(0).saturating_sub(12);
    let end = (start + 48).min(words.len());
    let mut snippet = truncate_chars(&words[start..end].join(" "), MAX_SNIPPET_CHARS);
    if start > 0 {
        snippet.insert_str(0, "… ");
    }
    if end < words.len() {
        snippet.push_str(" …");
    }
    snippet
}

fn truncate_chars(text: &str, max: usize) -> String {
    let mut chars = text.chars();
    let prefix: String = chars.by_ref().take(max).collect();
    if chars.next().is_some() {
        format!("{prefix}…")
    } else {
        prefix
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::transcripts::{append_event, transcript_path, write_summary};
    use crate::agent::types::{AgentMode, AgentRunSummary};

    fn sandbox(name: &str) -> (std::path::PathBuf, std::path::PathBuf, std::path::PathBuf) {
        let base = std::env::temp_dir().join(format!(
            "klide-conversation-search-{name}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&base);
        let runs = base.join("runs");
        let workspace = base.join("workspace");
        let other = base.join("other");
        std::fs::create_dir_all(&runs).unwrap();
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::create_dir_all(&other).unwrap();
        (
            base,
            std::fs::canonicalize(workspace).unwrap(),
            std::fs::canonicalize(other).unwrap(),
        )
    }

    fn write_conversation(
        runs: &Path,
        id: &str,
        workspace: &Path,
        user: &str,
        assistant: &str,
        updated_ms: i64,
        parent_id: Option<&str>,
    ) {
        append_event(
            runs,
            id,
            0,
            &AgentEvent::RunStarted {
                run_id: id.to_string(),
                cwd: Some(workspace.to_string_lossy().to_string()),
                mode: AgentMode::Plan,
                provider: "ollama".to_string(),
                model: "test".to_string(),
                ts: updated_ms - 2,
            },
        )
        .unwrap();
        append_event(
            runs,
            id,
            1,
            &AgentEvent::UserMessage {
                run_id: id.to_string(),
                message_id: format!("{id}-user"),
                text: user.to_string(),
                attachments: Vec::new(),
                ts: updated_ms - 1,
            },
        )
        .unwrap();
        append_event(
            runs,
            id,
            2,
            &AgentEvent::AssistantMessage {
                run_id: id.to_string(),
                message_id: format!("{id}-assistant"),
                content: vec![AgentContentBlock::Text {
                    text: assistant.to_string(),
                }],
                usage: None,
                timing: None,
                ts: updated_ms,
            },
        )
        .unwrap();
        write_summary(
            runs,
            &AgentRunSummary {
                id: id.to_string(),
                path: transcript_path(runs, id).to_string_lossy().to_string(),
                source: "klide".to_string(),
                title: user.to_string(),
                status: "done".to_string(),
                provider: "ollama".to_string(),
                model: "test".to_string(),
                cwd: Some(workspace.to_string_lossy().to_string()),
                project: None,
                git_branch: None,
                created_ms: updated_ms - 2,
                updated_ms,
                message_count: 2,
                input_tokens: 0,
                output_tokens: 0,
                files_touched: 0,
                cost_usd: None,
                last_event: None,
                worktree: None,
                validation: None,
                parent_id: parent_id.map(str::to_string),
            },
        )
        .unwrap();
    }

    #[test]
    fn search_is_workspace_scoped_and_excludes_current_and_child_runs() {
        let (base, workspace, other) = sandbox("scope");
        let runs = base.join("runs");
        write_conversation(
            &runs,
            "old-conversation",
            &workspace,
            "How should refresh tokens work?",
            "Rotate them after every exchange.",
            100,
            None,
        );
        write_conversation(
            &runs,
            "current-conversation",
            &workspace,
            "Search refresh tokens",
            "This is the current run.",
            400,
            None,
        );
        write_conversation(
            &runs,
            "other-workspace",
            &other,
            "Refresh tokens elsewhere",
            "Not part of this project.",
            300,
            None,
        );
        write_conversation(
            &runs,
            "child-run",
            &workspace,
            "Investigate refresh tokens",
            "Child report.",
            200,
            Some("old-conversation"),
        );

        let matches = search_conversations(
            &runs,
            &workspace,
            "current-conversation",
            "refresh tokens",
            10,
        )
        .unwrap();

        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].conversation_id, "old-conversation");
        assert_eq!(matches[0].role, "user");
        assert!(matches[0].snippet.contains("refresh tokens"));
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn search_ranks_user_matches_and_respects_the_result_limit() {
        let (base, workspace, _) = sandbox("rank");
        let runs = base.join("runs");
        write_conversation(
            &runs,
            "assistant-match",
            &workspace,
            "Discuss session storage",
            "The refresh token belongs in the keychain.",
            300,
            None,
        );
        write_conversation(
            &runs,
            "user-match",
            &workspace,
            "Where should the refresh token live?",
            "Use the keychain.",
            100,
            None,
        );

        let matches =
            search_conversations(&runs, &workspace, "current", "refresh token", 1).unwrap();

        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].conversation_id, "user-match");
        assert_eq!(matches[0].match_count, 1);
        let _ = std::fs::remove_dir_all(base);
    }
}
