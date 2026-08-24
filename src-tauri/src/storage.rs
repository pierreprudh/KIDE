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
// Settings needs to say all of that in numbers, give the folder a name you can
// open, and — since transcripts are the copy that matters — let you decide
// which disk they live on. Measuring and moving both walk the filesystem, so
// every command here is async and does its work off the main thread: a
// synchronous Tauri command runs ON the UI thread and freezes the window.
//
// The runs directory is resolved in exactly one place (`runs_dir`), which
// `agent::transcripts::app_runs_dir` delegates to. Every writer and reader in
// the app already goes through that function, so an override cannot half-apply
// and leave one caller writing to the old folder.
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
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
    /// True when this folder is where it is because someone chose it.
    pub custom: bool,
    /// Where it would be with no choice made — what "Use default" restores.
    pub default_path: String,
    /// Set when a chosen folder was ignored (missing volume, gone read-only)
    /// and Klide fell back to the default.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
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
    let relative = relative_for(kind)?;
    // "runs" goes through the resolver, so Reveal opens the folder transcripts
    // are actually written to — not the default one under app data.
    if relative == "runs" {
        return runs_dir(app);
    }
    let root = app_data(app)?;
    Ok(if relative.is_empty() { root } else { root.join(relative) })
}

/// `~/.klide/storage.json` — the same `~/.klide` home the skills loader and the
/// custom-provider store use for global (non-workspace) Klide config.
fn config_path() -> Option<PathBuf> {
    crate::cli::home_dir_path().map(|home| home.join(".klide").join("storage.json"))
}

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StorageConfig {
    /// Absolute path the user chose for run transcripts. `None` = app data dir.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    runs_dir: Option<String>,
}

/// Read the config. A missing or unparseable file is "no override", not an
/// error: the file only exists once someone moves the folder, and a corrupt one
/// must not stop the app from finding its transcripts.
fn read_config() -> StorageConfig {
    let Some(path) = config_path() else {
        return StorageConfig::default();
    };
    let Ok(bytes) = std::fs::read(&path) else {
        return StorageConfig::default();
    };
    serde_json::from_slice(&bytes).unwrap_or_default()
}

fn write_config(config: &StorageConfig) -> Result<(), String> {
    let path = config_path().ok_or_else(|| "Could not resolve the home directory".to_string())?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Could not create {}: {e}", parent.display()))?;
    }
    let json = serde_json::to_vec_pretty(config).map_err(|e| e.to_string())?;
    // Through durable.rs: a torn config would read as "no override" and send
    // the next run's transcript to a different folder than the last one's.
    crate::durable::write_atomic(&path, &json)
}

/// The folder Klide's own data lives under when nothing is overridden.
fn default_runs_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app_data(app)?.join("runs"))
}

/// Why an override was ignored, if it was. Surfaced by `app_storage_dirs` so a
/// folder that went missing (an unplugged drive) is visible rather than silent.
fn override_problem(path: &Path) -> Option<String> {
    if !path.is_absolute() {
        return Some(format!("{} is not an absolute path.", path.display()));
    }
    if path.exists() && !path.is_dir() {
        return Some(format!("{} is a file, not a folder.", path.display()));
    }
    if let Err(e) = std::fs::create_dir_all(path) {
        return Some(format!("{} is unreachable: {e}", path.display()));
    }
    None
}

/// THE resolution point for run transcripts. An override that no longer works
/// falls back to the default rather than failing every run — Klide keeps
/// working on the built-in folder, and Settings says why.
pub fn runs_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let default = default_runs_dir(app)?;
    if let Some(chosen) = read_config().runs_dir {
        let path = PathBuf::from(&chosen);
        if override_problem(&path).is_none() {
            return Ok(path);
        }
    }
    std::fs::create_dir_all(&default)
        .map_err(|e| format!("Unable to create {}: {e}", default.display()))?;
    Ok(default)
}

/// What a caller may hand `app_storage_set_runs_dir`. Kept separate from
/// `override_problem` because choosing a folder deserves stricter answers than
/// tolerating one that already exists.
fn validate_target(target: &Path, current: &Path) -> Result<(), String> {
    if !target.is_absolute() {
        return Err("Choose an absolute path.".to_string());
    }
    if target == current {
        return Err("That is already the transcript folder.".to_string());
    }
    if target.starts_with(current) {
        return Err("Choose a folder outside the current one — nesting it inside would move the folder into itself.".to_string());
    }
    if target.exists() && !target.is_dir() {
        return Err(format!("{} is a file, not a folder.", target.display()));
    }
    std::fs::create_dir_all(target)
        .map_err(|e| format!("Cannot use {}: {e}", target.display()))?;
    // Writability is worth proving now rather than at the first run's first
    // event — a read-only volume looks fine until something needs saving.
    let probe = target.join(".klide-write-probe");
    std::fs::write(&probe, b"klide").map_err(|e| {
        format!("Cannot write in {}: {e}", target.display())
    })?;
    std::fs::remove_file(&probe).ok();
    Ok(())
}

/// Move every transcript from one folder to the other. `rename` first (instant
/// on the same volume), copy-then-remove across volumes. A file that will not
/// move stops the move and is reported: half a folder silently left behind is
/// worse than an error, because the runs it holds would look deleted.
fn move_runs(from: &Path, to: &Path) -> Result<(usize, u64), String> {
    if !from.exists() {
        return Ok((0, 0));
    }
    let entries = std::fs::read_dir(from)
        .map_err(|e| format!("Could not read {}: {e}", from.display()))?;
    let mut moved = 0;
    let mut bytes = 0;
    for entry in entries.flatten() {
        let source = entry.path();
        let Ok(meta) = entry.metadata() else { continue };
        if !meta.is_file() {
            continue;
        }
        let Some(name) = source.file_name() else { continue };
        let dest = to.join(name);
        if dest.exists() {
            // Same run id in both folders: keep the destination, which is the
            // one the app will read from now.
            continue;
        }
        if std::fs::rename(&source, &dest).is_err() {
            std::fs::copy(&source, &dest).map_err(|e| {
                format!("Could not copy {} to {}: {e}", source.display(), dest.display())
            })?;
            std::fs::remove_file(&source).ok();
        }
        moved += 1;
        bytes += meta.len();
    }
    Ok((moved, bytes))
}

/// The outcome of changing the folder — what Settings reports back.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunsDirChange {
    pub path: String,
    pub custom: bool,
    pub moved_files: usize,
    pub moved_bytes: u64,
}

#[tauri::command]
pub async fn app_storage_set_runs_dir(
    app: tauri::AppHandle,
    path: String,
    move_existing: bool,
) -> Result<RunsDirChange, String> {
    let current = runs_dir(&app)?;
    let target = PathBuf::from(path.trim());
    tokio::task::spawn_blocking(move || {
        validate_target(&target, &current)?;
        let (moved_files, moved_bytes) = if move_existing {
            move_runs(&current, &target)?
        } else {
            (0, 0)
        };
        // Written only after a successful move, so a failure leaves every
        // transcript where the app is still looking for it.
        write_config(&StorageConfig {
            runs_dir: Some(target.to_string_lossy().to_string()),
        })?;
        Ok(RunsDirChange {
            path: target.to_string_lossy().to_string(),
            custom: true,
            moved_files,
            moved_bytes,
        })
    })
    .await
    .map_err(|e| format!("Changing the transcript folder failed: {e}"))?
}

#[tauri::command]
pub async fn app_storage_reset_runs_dir(
    app: tauri::AppHandle,
    move_existing: bool,
) -> Result<RunsDirChange, String> {
    let current = runs_dir(&app)?;
    let default = default_runs_dir(&app)?;
    tokio::task::spawn_blocking(move || {
        if current == default {
            return Ok(RunsDirChange {
                path: default.to_string_lossy().to_string(),
                custom: false,
                moved_files: 0,
                moved_bytes: 0,
            });
        }
        std::fs::create_dir_all(&default)
            .map_err(|e| format!("Unable to create {}: {e}", default.display()))?;
        let (moved_files, moved_bytes) = if move_existing {
            move_runs(&current, &default)?
        } else {
            (0, 0)
        };
        write_config(&StorageConfig { runs_dir: None })?;
        Ok(RunsDirChange {
            path: default.to_string_lossy().to_string(),
            custom: false,
            moved_files,
            moved_bytes,
        })
    })
    .await
    .map_err(|e| format!("Restoring the transcript folder failed: {e}"))?
}

#[tauri::command]
pub async fn app_storage_dirs(app: tauri::AppHandle) -> Result<Vec<StorageDir>, String> {
    let runs = dir_for(&app, "runs")?;
    let root = dir_for(&app, "app-data")?;
    let default_runs = default_runs_dir(&app)?;
    // A chosen folder that no longer works: `runs_dir` already fell back, so
    // say which one was skipped and why rather than showing a healthy default.
    let warning = read_config()
        .runs_dir
        .map(PathBuf::from)
        .and_then(|chosen| override_problem(&chosen).map(|why| format!("{why} Using the default folder.")));
    tokio::task::spawn_blocking(move || {
        let (run_files, run_bytes) = measure(&runs, 0);
        let (all_files, all_bytes) = measure(&root, 0);
        let custom = runs != default_runs;
        Ok(vec![
            StorageDir {
                kind: "runs".into(),
                label: "Run transcripts".into(),
                detail: "Every agent run's events and summary — the durable record behind Mission Control.".into(),
                path: runs.to_string_lossy().to_string(),
                files: run_files,
                bytes: run_bytes,
                custom,
                default_path: default_runs.to_string_lossy().to_string(),
                warning,
            },
            StorageDir {
                kind: "app-data".into(),
                label: "Klide app data".into(),
                detail: "Settings, caches, and — unless you moved them — the transcripts above.".into(),
                path: root.to_string_lossy().to_string(),
                files: all_files,
                bytes: all_bytes,
                custom: false,
                default_path: root.to_string_lossy().to_string(),
                warning: None,
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

    /// A fresh temp dir, unique per test name so cases cannot collide.
    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("klide-storage-{tag}-{}", std::process::id()));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_target_folder_must_be_absolute_new_and_writable() {
        let root = scratch("target");
        let current = root.join("current");
        std::fs::create_dir_all(&current).unwrap();

        assert!(validate_target(Path::new("relative/runs"), &current).is_err());
        assert!(validate_target(&current, &current).is_err());
        // Nesting the destination inside the source would move it into itself.
        assert!(validate_target(&current.join("inner"), &current).is_err());

        let file = root.join("a-file");
        std::fs::write(&file, b"x").unwrap();
        assert!(validate_target(&file, &current).is_err());

        let good = root.join("elsewhere");
        assert!(validate_target(&good, &current).is_ok());
        assert!(good.is_dir(), "a valid target is created, ready to receive");
        // The write probe cleans up after itself.
        assert!(!good.join(".klide-write-probe").exists());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn moving_carries_the_transcripts_and_leaves_nothing_behind() {
        let root = scratch("move");
        let from = root.join("from");
        let to = root.join("to");
        std::fs::create_dir_all(&from).unwrap();
        std::fs::create_dir_all(&to).unwrap();
        std::fs::write(from.join("run_a.jsonl"), b"12345").unwrap();
        std::fs::write(from.join("run_a.summary.json"), b"123").unwrap();
        // A run id already present at the destination keeps the destination's
        // copy — that is the one the app reads from now.
        std::fs::write(from.join("run_b.jsonl"), b"old").unwrap();
        std::fs::write(to.join("run_b.jsonl"), b"kept").unwrap();

        let (moved, bytes) = move_runs(&from, &to).unwrap();
        assert_eq!((moved, bytes), (2, 8));
        assert!(to.join("run_a.jsonl").exists());
        assert!(!from.join("run_a.jsonl").exists());
        assert_eq!(std::fs::read(to.join("run_b.jsonl")).unwrap(), b"kept");

        // Moving from a folder that was never created is not an error.
        assert_eq!(move_runs(&root.join("absent"), &to).unwrap(), (0, 0));
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn an_unusable_override_is_reported_rather_than_obeyed() {
        let root = scratch("override");
        let missing = root.join("gone").join("deeper");
        // Creatable, so no problem to report.
        assert!(override_problem(&missing).is_none());

        let file = root.join("not-a-folder");
        std::fs::write(&file, b"x").unwrap();
        assert!(override_problem(&file).unwrap().contains("is a file"));
        assert!(override_problem(Path::new("runs")).unwrap().contains("absolute"));
        std::fs::remove_dir_all(&root).ok();
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
