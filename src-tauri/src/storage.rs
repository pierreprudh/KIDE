// Where Klide keeps things, and how much room they take.
//
// Two stores hold a conversation, and they are not equals:
//
//  · the **local cache** — the browser's localStorage index the Focus rail and
//    the AI panel list read from. Bounded by the webview's ~5 MB quota, owned
//    by the frontend, and disposable.
//  · the **Run transcripts** — this module's subject: `runs/` under the app
//    data dir, written through `durable.rs`, the record Mission Control reads
//    and the only copy that survives clearing the cache.
//
// Settings needs to say all of that in numbers and give the folder a name you
// can open, which is what these two commands are for. Measuring walks the
// directory, so both commands are async and do their work off the main thread —
// a synchronous Tauri command runs ON the UI thread and freezes the window.
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::Manager;

/// One directory Klide owns, measured.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageDir {
    /// Stable id the frontend addresses this directory by (`app_storage_reveal`).
    pub kind: String,
    pub label: String,
    /// What lives here, in one line — Settings shows it verbatim.
    pub detail: String,
    pub path: String,
    pub files: usize,
    pub bytes: u64,
}

/// How deep a measured walk may go. `runs/` is flat and `missions/` is two
/// levels; a bound keeps a stray symlink or a huge nested tree from turning a
/// Settings render into a filesystem crawl.
const MAX_DEPTH: usize = 4;

fn measure(dir: &Path, depth: usize) -> (usize, u64) {
    if depth > MAX_DEPTH {
        return (0, 0);
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return (0, 0);
    };
    let mut files = 0;
    let mut bytes = 0;
    for entry in entries.flatten() {
        let Ok(meta) = entry.metadata() else { continue };
        if meta.is_dir() {
            let (f, b) = measure(&entry.path(), depth + 1);
            files += f;
            bytes += b;
        } else if meta.is_file() {
            files += 1;
            bytes += meta.len();
        }
    }
    (files, bytes)
}

fn app_data(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| format!("Unable to resolve the app data dir: {e}"))
}

/// The subdirectory a `kind` names, relative to the app data dir. This mapping
/// IS the allowlist — it is the only thing that turns a caller's string into a
/// path, it never returns a path built from that string, and it has no
/// catch-all, so `reveal` can only ever open a directory Klide itself owns.
fn relative_for(kind: &str) -> Result<&'static str, String> {
    match kind {
        "runs" => Ok("runs"),
        "app-data" => Ok(""),
        other => Err(format!("Unknown storage directory: {other}")),
    }
}

fn dir_for(app: &tauri::AppHandle, kind: &str) -> Result<PathBuf, String> {
    let root = app_data(app)?;
    let relative = relative_for(kind)?;
    Ok(if relative.is_empty() { root } else { root.join(relative) })
}

#[tauri::command]
pub async fn app_storage_dirs(app: tauri::AppHandle) -> Result<Vec<StorageDir>, String> {
    let runs = dir_for(&app, "runs")?;
    let root = dir_for(&app, "app-data")?;
    tokio::task::spawn_blocking(move || {
        let (run_files, run_bytes) = measure(&runs, 0);
        let (all_files, all_bytes) = measure(&root, 0);
        Ok(vec![
            StorageDir {
                kind: "runs".into(),
                label: "Run transcripts".into(),
                detail: "Every agent run's events and summary — the durable record behind Mission Control.".into(),
                path: runs.to_string_lossy().to_string(),
                files: run_files,
                bytes: run_bytes,
            },
            StorageDir {
                kind: "app-data".into(),
                label: "Klide app data".into(),
                detail: "The folder above: transcripts, plus anything else Klide writes for itself.".into(),
                path: root.to_string_lossy().to_string(),
                files: all_files,
                bytes: all_bytes,
            },
        ])
    })
    .await
    .map_err(|e| format!("Storage measurement failed: {e}"))?
}

#[tauri::command]
pub async fn app_storage_reveal(app: tauri::AppHandle, kind: String) -> Result<(), String> {
    let dir = dir_for(&app, &kind)?;
    tokio::task::spawn_blocking(move || {
        // Reveal wants something that exists; the runs dir is only created when
        // the first run is written.
        std::fs::create_dir_all(&dir)
            .map_err(|e| format!("Unable to create {}: {e}", dir.display()))?;
        tauri_plugin_opener::reveal_item_in_dir(&dir)
            .map_err(|e| format!("Unable to reveal in Finder: {e}"))
    })
    .await
    .map_err(|e| format!("Reveal task failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn measure_counts_files_and_bytes_under_the_depth_bound() {
        let dir = std::env::temp_dir().join(format!("klide-storage-{}", std::process::id()));
        let nested = dir.join("a").join("b");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(dir.join("top.jsonl"), b"12345").unwrap();
        std::fs::write(nested.join("deep.jsonl"), b"123").unwrap();

        let (files, bytes) = measure(&dir, 0);
        assert_eq!(files, 2);
        assert_eq!(bytes, 8);

        // Starting past the bound measures nothing rather than walking anyway.
        assert_eq!(measure(&dir, MAX_DEPTH + 1), (0, 0));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn only_klide_owned_directories_can_be_named() {
        assert_eq!(relative_for("runs").unwrap(), "runs");
        assert_eq!(relative_for("app-data").unwrap(), "");
        // A caller's string never becomes a path component.
        for hostile in ["../../etc", "/etc", "runs/../..", "", "RUNS"] {
            assert!(relative_for(hostile).is_err(), "{hostile} must be refused");
        }
    }
}
