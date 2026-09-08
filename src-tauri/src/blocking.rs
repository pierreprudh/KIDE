//! The one door for blocking work.
//!
//! Two threads matter in this process and both are easy to stall by accident:
//!
//! * A **sync** `#[tauri::command]` runs **on the main thread**. Everything the
//!   window does — input, painting, every other `invoke` — waits for it. A
//!   2-second `gh pr list` there froze the whole app once; a `list_dir` every
//!   3 s per expanded folder does the same thing in smaller slices.
//! * An **async** command or the Harness run loop runs on a tokio worker.
//!   `std::fs`, `std::process::Command`, and a 6 000-file grep executed inline
//!   there hold the worker hostage, so *other* Runs' streams stop flowing.
//!
//! The rule used to live in three comments, each next to one call site that
//! remembered it. It lives here now: anything that touches the filesystem, a
//! child process, or a socket goes through [`run`], which hands the closure to
//! tokio's blocking pool and awaits it. The IO functions themselves stay
//! synchronous — that is the interface their tests use — and only the *door*
//! is async.
//!
//! `lib.rs` carries a drift test (`every_sync_command_is_on_the_allowlist`) that
//! reads the command modules' own source and fails when a new sync command
//! appears that nobody vouched for.

/// Run a blocking closure off the current thread and await its result.
///
/// The closure's own `Err` passes through unchanged. A join failure — the
/// closure panicked or the runtime is shutting down — becomes an `Err` too, so
/// a caller never has to reason about `JoinError`.
pub async fn run<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| format!("Background task failed: {e}"))?
}

/// [`run`] for closures that cannot fail. A join failure yields `T::default()`
/// — for the callers that use this (a snapshot, a session list) an empty value
/// is the honest answer when the worker is gone.
pub async fn run_infallible<T: Send + Default + 'static>(
    f: impl FnOnce() -> T + Send + 'static,
) -> T {
    tokio::task::spawn_blocking(f).await.unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn passes_the_closure_result_through() {
        assert_eq!(run(|| Ok::<_, String>(41 + 1)).await, Ok(42));
        assert_eq!(
            run(|| Err::<(), _>("nope".to_string())).await,
            Err("nope".to_string())
        );
    }

    #[tokio::test]
    async fn a_panic_becomes_an_error_not_a_crash() {
        let out = run(|| -> Result<(), String> { panic!("boom") }).await;
        assert!(out.unwrap_err().starts_with("Background task failed"));
    }

    #[tokio::test]
    async fn infallible_returns_default_when_the_worker_dies() {
        let out: Vec<u8> = run_infallible(|| -> Vec<u8> { panic!("boom") }).await;
        assert!(out.is_empty());
        assert_eq!(run_infallible(|| 7u8).await, 7);
    }

    #[tokio::test]
    async fn the_closure_leaves_the_calling_thread() {
        let caller = std::thread::current().id();
        let worker = run(move || Ok::<_, String>(std::thread::current().id()))
            .await
            .unwrap();
        assert_ne!(caller, worker);
    }
}
