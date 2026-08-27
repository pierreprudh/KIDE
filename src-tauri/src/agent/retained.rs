//! Retained tool outputs — the run's out-of-context value store.
//!
//! A huge tool result (a long test log, a fat grep) used to ride in the
//! provider messages verbatim until auto-compaction gutted it to a 600-char
//! excerpt — after which the original was simply gone and the model had to
//! re-run the tool. Retention makes the large result *addressable* instead:
//! the full text is written once under the run's values directory, the model
//! sees a stub with a head/tail preview, and the `peek_value` tool reads
//! slices or searches the stored text on demand. The transcript still records
//! the full result on `ToolCallFinished` — retention only changes what the
//! *provider* is asked to carry, so the durable record stays complete and
//! replay can rebuild the same stub deterministically from it.
//!
//! Files live at `<runs_dir>/<run_id>.values/<value_id>.txt`, a sibling of the
//! run's `<run_id>.jsonl` transcript. The value id is derived from the tool
//! call id, so a continuation turn (which replays events, not messages) maps
//! a stub back to the same file without any in-memory registry.

use std::path::{Path, PathBuf};

/// A tool result must exceed this byte size before it is retained. Below it,
/// carrying the text in context is cheaper than a stub plus a later peek.
/// Comfortably above [`PEEK_MAX_BYTES`], so a `peek_value` result can never
/// itself be retained — no stub-of-a-stub recursion.
const RETAIN_MIN_BYTES: usize = 20_000;

/// Preview shape inside the stub: enough head to orient the model and enough
/// tail to show how the output ended (test summaries live at the bottom).
const PREVIEW_HEAD_LINES: usize = 25;
const PREVIEW_TAIL_LINES: usize = 10;
const PREVIEW_LINE_CHARS: usize = 200;

/// Caps for one `peek_value` call. The byte cap sits below
/// [`RETAIN_MIN_BYTES`] by construction (see above).
const PEEK_MAX_LINES: usize = 400;
const PEEK_DEFAULT_LINES: usize = 200;
const PEEK_MAX_BYTES: usize = 16_000;
const QUERY_MAX_MATCHES: usize = 100;
const QUERY_LINE_CHARS: usize = 300;

pub(super) fn values_dir(runs_dir: &Path, run_id: &str) -> PathBuf {
    runs_dir.join(format!("{run_id}.values"))
}

/// A value id is the tool call id squeezed into a safe filename: the same
/// derivation runs at retention time, replay time, and peek time, so the
/// three always agree. Sanitizing the *requested* id through the same
/// function also makes path traversal unrepresentable — no separator or dot
/// survives.
pub(super) fn value_id(tool_call_id: &str) -> String {
    let cleaned: String = tool_call_id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .take(48)
        .collect();
    if cleaned.is_empty() {
        "value".to_string()
    } else {
        cleaned
    }
}

fn value_path(runs_dir: &Path, run_id: &str, tool_call_id: &str) -> PathBuf {
    values_dir(runs_dir, run_id).join(format!("{}.txt", value_id(tool_call_id)))
}

fn truncate_line(line: &str, max_chars: usize) -> String {
    if line.chars().count() <= max_chars {
        return line.to_string();
    }
    let mut out: String = line.chars().take(max_chars).collect();
    out.push_str(" […]");
    out
}

/// The stub that replaces a retained result in provider messages. Pure — the
/// replay paths call it without touching disk. Returns `None` when the
/// content is too small to bother retaining.
pub(super) fn stub_for(tool_name: &str, tool_call_id: &str, content: &str) -> Option<String> {
    if content.len() < RETAIN_MIN_BYTES {
        return None;
    }
    let id = value_id(tool_call_id);
    let lines: Vec<&str> = content.lines().collect();
    let total = lines.len();
    let kb = content.len() as f64 / 1024.0;

    let mut stub = format!(
        "[retained #{id}] {tool_name} returned {total} lines ({kb:.1} KB) — too large to keep in \
         context. The full output is stored for this conversation: call peek_value with id \
         \"{id}\" and start_line/end_line to read a slice (line numbers below are real), or \
         query to search it.\n"
    );
    for line in lines.iter().take(PREVIEW_HEAD_LINES) {
        stub.push_str(&truncate_line(line, PREVIEW_LINE_CHARS));
        stub.push('\n');
    }
    let hidden = total.saturating_sub(PREVIEW_HEAD_LINES + PREVIEW_TAIL_LINES);
    if hidden > 0 {
        stub.push_str(&format!("[… {hidden} lines retained — peek_value \"{id}\" …]\n"));
    }
    if total > PREVIEW_HEAD_LINES {
        let tail_start = total.saturating_sub(PREVIEW_TAIL_LINES).max(PREVIEW_HEAD_LINES);
        for line in &lines[tail_start..] {
            stub.push_str(&truncate_line(line, PREVIEW_LINE_CHARS));
            stub.push('\n');
        }
    }
    Some(stub)
}

/// Live-loop retention: store the full content, hand back the stub. On any
/// write failure the result stays in context verbatim — a stub pointing at a
/// file that never landed would send the model chasing a value it can't read.
pub(super) fn retain_large_result(
    runs_dir: &Path,
    run_id: &str,
    tool_call_id: &str,
    tool_name: &str,
    content: &str,
) -> Option<String> {
    let stub = stub_for(tool_name, tool_call_id, content)?;
    let dir = values_dir(runs_dir, run_id);
    if std::fs::create_dir_all(&dir).is_err() {
        return None;
    }
    let path = value_path(runs_dir, run_id, tool_call_id);
    match crate::durable::write_atomic(&path, content.as_bytes()) {
        Ok(()) => Some(stub),
        Err(_) => None,
    }
}

/// Replay-time stub: same shape as the live one, but never writes — the file
/// was written when the result was produced. Falls through to the full
/// content when the result was small enough to keep.
pub(super) fn stub_for_replay(tool_name: &str, tool_call_id: &str, content: &str) -> String {
    stub_for(tool_name, tool_call_id, content).unwrap_or_else(|| content.to_string())
}

/// Executor for the `peek_value` tool. Reads a line range (default: the first
/// 200 lines) or searches for a substring, with hard caps that keep any
/// single peek comfortably below the retention threshold.
pub(super) fn peek(
    runs_dir: Option<&Path>,
    run_id: &str,
    input: &serde_json::Value,
) -> Result<String, String> {
    let Some(runs_dir) = runs_dir else {
        return Err("Retained outputs are unavailable in this Harness environment.".to_string());
    };
    let requested = input
        .get("id")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .unwrap_or("");
    if requested.is_empty() {
        return Err("peek_value requires an id (from a [retained #…] stub).".to_string());
    }
    let id = value_id(requested);
    let path = value_path(runs_dir, run_id, requested);
    let content = std::fs::read_to_string(&path).map_err(|_| {
        format!(
            "No retained output #{id} in this conversation. It may predate retention or the \
             preview already showed everything — re-run the original tool if you still need it."
        )
    })?;
    let lines: Vec<&str> = content.lines().collect();
    let total = lines.len();

    if let Some(query) = input.get("query").and_then(|v| v.as_str()) {
        let query = query.trim();
        if !query.is_empty() {
            return Ok(search_value(&id, &lines, query));
        }
    }

    let start = input
        .get("start_line")
        .and_then(|v| v.as_u64())
        .unwrap_or(1)
        .max(1) as usize;
    if start > total {
        return Err(format!(
            "Retained output #{id} has {total} lines; start_line {start} is past the end."
        ));
    }
    let requested_end = input
        .get("end_line")
        .and_then(|v| v.as_u64())
        .map(|v| v.max(1) as usize)
        .unwrap_or(start + PEEK_DEFAULT_LINES - 1);
    let end = requested_end
        .min(total)
        .min(start + PEEK_MAX_LINES - 1);

    let mut out = format!("[#{id} lines {start}–{end} of {total}]\n");
    let mut clipped_at: Option<usize> = None;
    for (offset, line) in lines[start - 1..end].iter().enumerate() {
        let numbered = format!("{}\t{}\n", start + offset, truncate_line(line, PREVIEW_LINE_CHARS));
        if out.len() + numbered.len() > PEEK_MAX_BYTES {
            clipped_at = Some(start + offset);
            break;
        }
        out.push_str(&numbered);
    }
    if let Some(line_no) = clipped_at {
        out.push_str(&format!(
            "[clipped at line {line_no} to stay within the peek budget — continue with \
             start_line {line_no}]"
        ));
    } else if end < total {
        out.push_str(&format!("[{} more lines — continue with start_line {}]", total - end, end + 1));
    }
    Ok(out)
}

fn search_value(id: &str, lines: &[&str], query: &str) -> String {
    let needle = query.to_lowercase();
    let mut matches = 0usize;
    let mut out = String::new();
    let mut clipped = false;
    for (index, line) in lines.iter().enumerate() {
        if !line.to_lowercase().contains(&needle) {
            continue;
        }
        matches += 1;
        if matches > QUERY_MAX_MATCHES {
            clipped = true;
            break;
        }
        let numbered = format!("{}\t{}\n", index + 1, truncate_line(line, QUERY_LINE_CHARS));
        if out.len() + numbered.len() > PEEK_MAX_BYTES - 200 {
            clipped = true;
            break;
        }
        out.push_str(&numbered);
    }
    if matches == 0 {
        return format!("No lines in retained output #{id} match {query:?}.");
    }
    let mut header = format!(
        "[#{id}] {matches}{} line(s) match {query:?}:\n",
        if clipped { "+" } else { "" }
    );
    header.push_str(&out);
    if clipped {
        header.push_str("[more matches exist — narrow the query or peek a line range]");
    }
    header
}

#[cfg(test)]
mod tests {
    use super::*;

    fn big_output(lines: usize) -> String {
        (1..=lines)
            .map(|i| format!("line {i}: some tool output that pads this row out a fair bit"))
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[test]
    fn small_results_are_not_retained() {
        assert!(stub_for("run_command", "tc1", "short output").is_none());
    }

    #[test]
    fn large_results_get_a_stub_with_head_tail_and_id() {
        let content = big_output(1000);
        let stub = stub_for("run_command", "call_abc/123", &content).unwrap();
        assert!(stub.contains("[retained #call_abc123]"), "sanitized id: {stub}");
        assert!(stub.contains("line 1:"), "head preview missing");
        assert!(stub.contains("line 1000:"), "tail preview missing");
        assert!(stub.contains("lines retained"), "hidden-count marker missing");
        assert!(stub.len() < content.len() / 2, "stub must be much smaller");
    }

    #[test]
    fn retain_writes_the_file_and_peek_reads_a_numbered_range() {
        let dir = std::env::temp_dir().join(format!("klide-retained-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let content = big_output(1000);
        let stub = retain_large_result(&dir, "run1", "tc9", "grep", &content).unwrap();
        assert!(stub.contains("#tc9"));

        let input = serde_json::json!({ "id": "tc9", "start_line": 500, "end_line": 502 });
        let peeked = peek(Some(&dir), "run1", &input).unwrap();
        assert!(peeked.contains("lines 500–502 of 1000"), "{peeked}");
        assert!(peeked.contains("500\tline 500:"), "numbered line missing: {peeked}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn peek_defaults_and_caps_the_range() {
        let dir = std::env::temp_dir().join(format!("klide-retained-cap-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let content = big_output(2000);
        retain_large_result(&dir, "run1", "tc1", "run_command", &content).unwrap();

        let peeked = peek(Some(&dir), "run1", &serde_json::json!({ "id": "tc1" })).unwrap();
        assert!(peeked.len() <= PEEK_MAX_BYTES + 200, "peek exceeded budget");
        assert!(peeked.contains("continue with start_line"), "{peeked}");

        let huge = serde_json::json!({ "id": "tc1", "start_line": 1, "end_line": 2000 });
        let peeked = peek(Some(&dir), "run1", &huge).unwrap();
        assert!(peeked.len() <= PEEK_MAX_BYTES + 200, "range cap failed");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn peek_query_returns_matching_lines_with_numbers() {
        let dir = std::env::temp_dir().join(format!("klide-retained-q-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let content = big_output(999) + "\nFAILED: the widget test";
        retain_large_result(&dir, "run1", "tc2", "run_command", &content).unwrap();

        let input = serde_json::json!({ "id": "tc2", "query": "failed" });
        let peeked = peek(Some(&dir), "run1", &input).unwrap();
        assert!(peeked.contains("1000\tFAILED: the widget test"), "{peeked}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn peek_unknown_id_is_a_readable_error() {
        let dir = std::env::temp_dir().join(format!("klide-retained-miss-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let error = peek(Some(&dir), "run1", &serde_json::json!({ "id": "nope" })).unwrap_err();
        assert!(error.contains("No retained output #nope"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn peek_id_cannot_escape_the_values_dir() {
        let dir = std::env::temp_dir().join(format!("klide-retained-esc-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let input = serde_json::json!({ "id": "../../etc/passwd" });
        let error = peek(Some(&dir), "run1", &input).unwrap_err();
        assert!(error.contains("No retained output"), "traversal must sanitize: {error}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn replay_stub_matches_the_live_stub() {
        let content = big_output(500);
        let live = stub_for("grep", "tc1", &content).unwrap();
        let replay = stub_for_replay("grep", "tc1", &content);
        assert_eq!(live, replay);
    }

    #[test]
    fn a_peek_result_is_never_large_enough_to_be_retained() {
        assert!(PEEK_MAX_BYTES + 500 < RETAIN_MIN_BYTES);
    }
}
