//! Parsing a delegate CLI's structured turn stream.
//!
//! `claude -p --output-format stream-json --verbose` emits one JSON object per
//! line for everything it does: an `init` line naming the session, `assistant`
//! messages carrying text and `tool_use` blocks, `user` messages carrying the
//! matching `tool_result`s, and a final `result` line with cost and turn count.
//! The prose-only mode (`--output-format text`) throws all of that away, which
//! is why a delegate conversation used to show an answer with no visible work
//! behind it.
//!
//! This module is the pure half: bytes in, [`StreamItem`]s out. It knows
//! nothing about processes, channels or the harness, so the whole vocabulary is
//! testable against captured output — which matters, because this is a shape
//! defined by somebody else's CLI and it will move.
//!
//! Anything unrecognised is *ignored*, never an error: a new line type in a
//! future Claude Code release must not fail a turn that otherwise worked.

use serde_json::Value;

/// One meaningful thing found on one line of the stream.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum StreamItem {
    /// The session id this turn runs under — what `--resume` needs later.
    Session(String),
    /// Assistant prose. This, joined, is the turn's answer.
    Text(String),
    /// A tool the CLI called on its own.
    ToolCall {
        id: String,
        name: String,
        input: Value,
    },
    /// The result it got back.
    ToolResult {
        id: String,
        ok: bool,
        content: String,
    },
    /// The terminating line: what the CLI thinks the turn cost.
    Finished {
        cost_usd: Option<f64>,
        turns: Option<i64>,
    },
}

/// Parse one line. Blank lines, unknown `type`s and malformed JSON yield no
/// items rather than an error — see the module note on forward compatibility.
pub(crate) fn parse_stream_line(line: &str) -> Vec<StreamItem> {
    let line = line.trim();
    if line.is_empty() {
        return Vec::new();
    }
    let Ok(value) = serde_json::from_str::<Value>(line) else {
        return Vec::new();
    };
    match value.get("type").and_then(Value::as_str) {
        // The `init` subtype carries the session id; other `system` lines
        // (hook_started, hook_response, …) are noise for our purposes.
        Some("system") => match value.get("subtype").and_then(Value::as_str) {
            Some("init") => value
                .get("session_id")
                .and_then(Value::as_str)
                .map(|id| vec![StreamItem::Session(id.to_string())])
                .unwrap_or_default(),
            _ => Vec::new(),
        },
        Some("assistant") => message_blocks(&value)
            .iter()
            .filter_map(assistant_block)
            .collect(),
        // Tool results come back addressed to the *user* role, because that is
        // how they are fed to the model on the next turn.
        Some("user") => message_blocks(&value)
            .iter()
            .filter_map(tool_result_block)
            .collect(),
        Some("result") => vec![StreamItem::Finished {
            cost_usd: value.get("total_cost_usd").and_then(Value::as_f64),
            turns: value.get("num_turns").and_then(Value::as_i64),
        }],
        _ => Vec::new(),
    }
}

fn message_blocks(value: &Value) -> Vec<Value> {
    value
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn assistant_block(block: &Value) -> Option<StreamItem> {
    match block.get("type").and_then(Value::as_str) {
        Some("text") => {
            let text = block.get("text").and_then(Value::as_str)?;
            // Empty text blocks appear between tool calls; they would add blank
            // lines to the answer.
            (!text.is_empty()).then(|| StreamItem::Text(text.to_string()))
        }
        Some("tool_use") => Some(StreamItem::ToolCall {
            id: block
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            name: block
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("tool")
                .to_string(),
            input: block.get("input").cloned().unwrap_or(Value::Null),
        }),
        _ => None,
    }
}

fn tool_result_block(block: &Value) -> Option<StreamItem> {
    if block.get("type").and_then(Value::as_str) != Some("tool_result") {
        return None;
    }
    Some(StreamItem::ToolResult {
        id: block
            .get("tool_use_id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        // `is_error` absent means it worked.
        ok: !block
            .get("is_error")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        content: result_text(block.get("content")),
    })
}

/// A tool result's content is either a plain string or Anthropic's block list.
/// Both flatten to text; anything else is rendered as its JSON so a reader sees
/// *something* rather than an empty row.
fn result_text(content: Option<&Value>) -> String {
    match content {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(blocks)) => blocks
            .iter()
            .filter_map(|b| b.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        Some(other) => other.to_string(),
    }
}

/// A one-line label for a tool call: the argument that says *what* it acted on,
/// preferred over dumping the whole input object into the row.
pub(crate) fn summarize_call(name: &str, input: &Value) -> String {
    const SUBJECT_KEYS: [&str; 6] = ["file_path", "path", "command", "pattern", "url", "prompt"];
    let subject = SUBJECT_KEYS
        .iter()
        .find_map(|key| input.get(*key).and_then(Value::as_str))
        .map(str::trim)
        .filter(|s| !s.is_empty());
    match subject {
        Some(subject) => {
            // One line only — a multi-line Bash script would break the row.
            let first = subject.lines().next().unwrap_or(subject);
            let clipped: String = first.chars().take(120).collect();
            if clipped.len() < first.len() {
                format!("{name} {clipped}…")
            } else {
                format!("{name} {clipped}")
            }
        }
        None => name.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Captured from a real `claude -p --output-format stream-json --verbose`
    // run, trimmed to the lines that matter. Kept verbatim so a CLI change
    // shows up here as a failing test rather than as an empty conversation.
    const INIT: &str = r#"{"type":"system","subtype":"init","cwd":"/ws","session_id":"abc-123"}"#;
    const HOOK: &str = r#"{"type":"system","subtype":"hook_started","hook_id":"9dec"}"#;
    const TEXT_AND_CALL: &str = r#"{"type":"assistant","message":{"content":[{"type":"text","text":"I'll read the first line."},{"type":"tool_use","id":"toolu_1","name":"Read","input":{"file_path":"/ws/README.md","limit":1}}]}}"#;
    const RESULT_LINE: &str = r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_1","content":"1\t<div align=\"center\">"}]}}"#;
    const RATE_LIMIT: &str = r#"{"type":"rate_limit_event","rate_limit_info":{"status":"allowed"}}"#;
    const FINISHED: &str = r#"{"type":"result","subtype":"success","total_cost_usd":0.348942,"num_turns":2}"#;

    #[test]
    fn reads_session_text_calls_and_results_from_a_real_turn() {
        assert_eq!(
            parse_stream_line(INIT),
            vec![StreamItem::Session("abc-123".into())]
        );
        assert_eq!(
            parse_stream_line(TEXT_AND_CALL),
            vec![
                StreamItem::Text("I'll read the first line.".into()),
                StreamItem::ToolCall {
                    id: "toolu_1".into(),
                    name: "Read".into(),
                    input: serde_json::json!({"file_path": "/ws/README.md", "limit": 1}),
                },
            ]
        );
        assert_eq!(
            parse_stream_line(RESULT_LINE),
            vec![StreamItem::ToolResult {
                id: "toolu_1".into(),
                ok: true,
                content: "1\t<div align=\"center\">".into(),
            }]
        );
        assert_eq!(
            parse_stream_line(FINISHED),
            vec![StreamItem::Finished {
                cost_usd: Some(0.348942),
                turns: Some(2)
            }]
        );
    }

    #[test]
    fn unknown_and_malformed_lines_are_ignored_not_fatal() {
        // A hook line, a line type that did not exist when this was written,
        // half-written JSON, and a blank line all yield nothing — a turn must
        // not fail because the CLI grew a new event.
        for line in [HOOK, RATE_LIMIT, "{not json", "", "   "] {
            assert!(parse_stream_line(line).is_empty(), "line: {line}");
        }
    }

    #[test]
    fn tool_result_blocks_flatten_and_errors_are_marked() {
        let blocks = r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t2","is_error":true,"content":[{"type":"text","text":"line one"},{"type":"text","text":"line two"}]}]}}"#;
        assert_eq!(
            parse_stream_line(blocks),
            vec![StreamItem::ToolResult {
                id: "t2".into(),
                ok: false,
                content: "line one\nline two".into(),
            }]
        );
    }

    #[test]
    fn call_summary_names_the_subject_and_stays_one_line() {
        assert_eq!(
            summarize_call("Read", &serde_json::json!({"file_path": "src/main.rs"})),
            "Read src/main.rs"
        );
        assert_eq!(
            summarize_call("Bash", &serde_json::json!({"command": "npm test\nnpm run build"})),
            "Bash npm test"
        );
        // No recognised subject key → the tool name alone, never a JSON dump.
        assert_eq!(summarize_call("TodoWrite", &serde_json::json!({"todos": []})), "TodoWrite");
    }
}
