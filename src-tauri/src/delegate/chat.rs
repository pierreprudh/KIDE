//! One-shot headless chat with a subscription delegate CLI.
//!
//! The AI panel's "subscription" providers (Claude Code, Codex, OpenCode, Omp)
//! don't stream over a wire API — they run the CLI once with the prompt on
//! stdin and read plain text back. Building the command is the adapter's job
//! (`Delegate::chat_invocation`); this module owns the rest — folding the
//! conversation into a prompt, running the process, and streaming its output.
//! Keeping it here means the whole one-shot-chat operation lives behind the
//! Delegate seam instead of being split across the lib.rs IPC glue.

use std::process::Stdio;
use std::time::Duration;
use tauri::ipc::Channel;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command as TokioCommand;
use tokio::time::timeout;

use super::Delegate;
use crate::providers::{text_from_message, AiChatResponse, ObservedToolActivity, StreamChunk};

/// Hard ceiling for one headless delegate turn. See `run_cli_with_stdin`.
const CHAT_TURN_CEILING: Duration = Duration::from_secs(30 * 60);

/// Run one headless chat turn against a subscription delegate CLI: fold the
/// conversation into a prompt, spawn the adapter's chat invocation, stream its
/// output back, and wrap the result. The single entry the `ai_chat` dispatcher
/// calls for the subscription path.
pub async fn run_subscription_chat(
    adapter: &dyn Delegate,
    label: &str,
    model: String,
    messages: Vec<serde_json::Value>,
    workspace_root: Option<String>,
    on_chunk: &Channel<StreamChunk>,
) -> Result<AiChatResponse, String> {
    let prompt = prompt_from_messages(&messages);
    let cwd = workspace_root.unwrap_or_else(|| ".".to_string());
    // The "default" sentinel means "no model picked" — hand the adapter an
    // empty model so it omits its model flag and the CLI uses its own default.
    let model = model.trim();
    let model = if model.eq_ignore_ascii_case(super::CLI_DEFAULT_MODEL) {
        ""
    } else {
        model
    };
    // Prefer the CLI's structured stream when it has one: the prose-only mode
    // reports an answer with no visible work behind it, and a delegate's work
    // is most of what the user wants to see.
    let content = match adapter.chat_stream_invocation(&cwd, model) {
        Some(command) => {
            run_cli_streaming(command?, prompt, label, adapter.id(), on_chunk).await?
        }
        None => run_cli_with_stdin(adapter.chat_invocation(&cwd, model)?, prompt, label, on_chunk)
            .await?
    };
    Ok(AiChatResponse {
        content,
        thinking: None,
        // Empty on purpose: a delegate has *already run* its tools. Reporting
        // them here would make the harness queue them for execution a second
        // time. They reach the UI as observed activity instead.
        tool_calls: Vec::new(),
        usage: None,
        stop_reason: None,
    })
}

/// Drive a CLI that reports itself line by line: prompt on stdin, one JSON
/// object per stdout line. Assistant prose is streamed as ordinary content;
/// tool calls and their results are streamed as *observed* activity, which the
/// harness forwards without ever dispatching or gating it.
///
/// The returned string is the assistant text only — the answer — so a saved
/// transcript reads as prose rather than as a mixture of prose and tool logs.
async fn run_cli_streaming(
    mut command: TokioCommand,
    prompt: String,
    label: &str,
    provider_id: &str,
    on_chunk: &Channel<StreamChunk>,
) -> Result<String, String> {
    use super::chat_stream::{parse_stream_line, summarize_call, StreamItem};

    command.stdin(Stdio::piped());
    command.stdout(Stdio::piped());
    command.stderr(Stdio::piped());
    command.kill_on_drop(true);

    let mut child = command
        .spawn()
        .map_err(|e| format!("Unable to start {label}: {e}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(prompt.as_bytes())
            .await
            .map_err(|e| format!("Unable to write prompt to {label}: {e}"))?;
        // The CLI reads until EOF before it starts working, so the handle has to
        // drop here — holding it open deadlocks the turn.
        drop(stdin);
    }

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| format!("Unable to capture {label} stdout"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| format!("Unable to capture {label} stderr"))?;

    let answer = timeout(CHAT_TURN_CEILING, async {
        let mut lines = BufReader::new(stdout).lines();
        let mut answer = String::new();
        // With partial messages on, every block arrives twice: as deltas while
        // it is written, then again whole. Deltas win — they are what makes the
        // answer type out — so a completed block is dropped once any delta has
        // been seen. (The flag is per-adapter, so the whole-block path still has
        // to work for a CLI that streams no deltas.)
        let mut saw_delta = false;
        while let Some(line) = lines
            .next_line()
            .await
            .map_err(|e| format!("Unable to read {label} stdout: {e}"))?
        {
            for item in parse_stream_line(&line) {
                match item {
                    StreamItem::TextDelta(text) => {
                        saw_delta = true;
                        answer.push_str(&text);
                        let _ = on_chunk.send(StreamChunk::text(text));
                    }
                    StreamItem::Text(text) if saw_delta => {
                        // Already streamed, character for character.
                        let _ = text;
                    }
                    StreamItem::Text(text) => {
                        answer.push_str(&text);
                        answer.push('\n');
                        let _ = on_chunk.send(StreamChunk::text(format!("{text}\n")));
                    }
                    StreamItem::ToolCall { id, name, input } => {
                        let summary = summarize_call(&name, &input);
                        let _ = on_chunk.send(StreamChunk {
                            observed: Some(ObservedToolActivity::Call {
                                id,
                                name,
                                input,
                                provider: provider_id.to_string(),
                                summary,
                            }),
                            ..Default::default()
                        });
                    }
                    StreamItem::ToolResult { id, ok, content } => {
                        let _ = on_chunk.send(StreamChunk {
                            observed: Some(ObservedToolActivity::Result { id, ok, content }),
                            ..Default::default()
                        });
                    }
                    // Session id and cost are not shown yet; the parser reports
                    // them so wiring `--resume` later needs no protocol change.
                    StreamItem::Session(_) | StreamItem::Finished { .. } => {}
                }
            }
        }

        let status = child
            .wait()
            .await
            .map_err(|e| format!("Unable to read {label} exit status: {e}"))?;
        if !status.success() {
            // stderr is only read on failure: on the happy path it carries
            // warnings that would otherwise be pasted into the answer.
            let mut stderr_text = String::new();
            let mut stderr_lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = stderr_lines.next_line().await {
                stderr_text.push_str(&line);
                stderr_text.push('\n');
            }
            let stderr_text = stderr_text.trim().to_string();
            return Err(if stderr_text.is_empty() {
                format!("{label} exited with {status}")
            } else {
                format!("{label} exited with {status}: {stderr_text}")
            });
        }
        Ok::<_, String>(answer.trim().to_string())
    })
    .await
    .map_err(|_| {
        format!(
            "{label} timed out after {} minutes",
            CHAT_TURN_CEILING.as_secs() / 60
        )
    })??;

    Ok(answer)
}

fn prompt_from_messages(messages: &[serde_json::Value]) -> String {
    let mut out = String::from(
        "You are running as a subscription CLI backend inside Klide.\n\
         Answer the user's latest request using the conversation below.\n\
         Follow the active Klide mode described in the system message. In Goal mode,\n\
         you may edit files directly in the current workspace; Klide will surface the\n\
         resulting file and git diffs after you finish. In Chat or Plan mode, do not\n\
         edit files unless the mode instructions explicitly allow it.\n\n",
    );

    for message in messages {
        let role = message
            .get("role")
            .and_then(|role| role.as_str())
            .unwrap_or("message");
        if role == "tool" {
            continue;
        }
        let content = text_from_message(message);
        if content.trim().is_empty() {
            continue;
        }
        out.push_str(&format!("[{role}]\n{content}\n\n"));
    }
    out
}

async fn run_cli_with_stdin(
    mut command: TokioCommand,
    prompt: String,
    label: &str,
    on_chunk: &Channel<StreamChunk>,
) -> Result<String, String> {
    command.stdin(Stdio::piped());
    command.stdout(Stdio::piped());
    command.stderr(Stdio::piped());
    // Stopping a turn drops this future. Without `kill_on_drop` the CLI would
    // keep running unattended — still editing the workspace, with nothing left
    // reading its output — so cancelling from the composer has to end it.
    command.kill_on_drop(true);

    let mut child = command
        .spawn()
        .map_err(|e| format!("Unable to start {label}: {e}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(prompt.as_bytes())
            .await
            .map_err(|e| format!("Unable to write prompt to {label}: {e}"))?;
    }

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| format!("Unable to capture {label} stdout"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| format!("Unable to capture {label} stderr"))?;

    // A backstop against a wedged CLI, not a work budget. Three minutes was
    // enough when this only answered questions; a delegate driving a Goal-mode
    // task in Focus routinely runs longer, and cutting it mid-edit leaves the
    // workspace half-written. Stop in the composer is the real control.
    let (status, stdout, stderr) = timeout(CHAT_TURN_CEILING, async {
        let mut stdout_lines = BufReader::new(stdout).lines();
        let mut stderr_lines = BufReader::new(stderr).lines();
        let mut stdout_done = false;
        let mut stderr_done = false;
        let mut stdout_text = String::new();
        let mut stderr_text = String::new();

        while !stdout_done || !stderr_done {
            tokio::select! {
                line = stdout_lines.next_line(), if !stdout_done => {
                    match line.map_err(|e| format!("Unable to read {label} stdout: {e}"))? {
                        Some(line) => {
                            stdout_text.push_str(&line);
                            stdout_text.push('\n');
                            let _ = on_chunk.send(StreamChunk::text(format!("{line}\n")));
                        }
                        None => stdout_done = true,
                    }
                }
                line = stderr_lines.next_line(), if !stderr_done => {
                    match line.map_err(|e| format!("Unable to read {label} stderr: {e}"))? {
                        Some(line) => {
                            stderr_text.push_str(&line);
                            stderr_text.push('\n');
                            let _ = on_chunk.send(StreamChunk::text(format!("stderr: {line}\n")));
                        }
                        None => stderr_done = true,
                    }
                }
            }
        }

        let status = child
            .wait()
            .await
            .map_err(|e| format!("Unable to read {label} exit status: {e}"))?;
        Ok::<_, String>((
            status,
            stdout_text.trim().to_string(),
            stderr_text.trim().to_string(),
        ))
    })
    .await
    .map_err(|_| {
        format!(
            "{label} timed out after {} minutes",
            CHAT_TURN_CEILING.as_secs() / 60
        )
    })??;

    if status.success() {
        Ok(if stdout.is_empty() { stderr } else { stdout })
    } else if stderr.is_empty() {
        Err(format!("{label} exited with {status}"))
    } else {
        Err(format!("{label} exited with {status}: {stderr}"))
    }
}
