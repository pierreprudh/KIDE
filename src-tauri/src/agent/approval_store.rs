//! User-local storage for project-scoped capability approvals.
//!
//! A repository must never be able to ship its own permission decisions. The
//! files produced here live under Klide's app-data directory (next to `runs/`),
//! are mode 0600, and are scoped to a fingerprint of the repository's current
//! HEAD plus its tracked and untracked changes. Switching commits or changing a
//! command-defining file invalidates prior approvals and forces a fresh prompt.

use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};

const MAX_GIT_BYTES: usize = 32 * 1024 * 1024;
const MAX_UNTRACKED_LIST_BYTES: usize = 1024 * 1024;

pub struct ApprovalLocation {
    pub path: PathBuf,
    pub fingerprint: String,
}

fn hex_digest(bytes: impl AsRef<[u8]>) -> String {
    let digest = Sha256::digest(bytes.as_ref());
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

fn git_bytes_limited(root: &Path, args: &[&str], limit: usize) -> Result<Vec<u8>, String> {
    let mut child = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("Unable to inspect repository trust state: {e}"))?;
    let mut bytes = Vec::new();
    child
        .stdout
        .take()
        .ok_or_else(|| "Unable to inspect repository trust state".to_string())?
        .take((limit + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("Unable to inspect repository trust state: {e}"))?;
    if bytes.len() > limit {
        let _ = child.kill();
        let _ = child.wait();
        return Err("Repository changes are too large for a persistent approval".to_string());
    }
    let status = child
        .wait()
        .map_err(|e| format!("Unable to inspect repository trust state: {e}"))?;
    if !status.success() {
        return Err("Persistent approvals require a Git repository with an initial commit".into());
    }
    Ok(bytes)
}

fn hash_file(hasher: &mut Sha256, path: &Path, remaining: &mut usize) -> Result<(), String> {
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|e| format!("Unable to fingerprint {}: {e}", path.display()))?;
    hasher.update(path.to_string_lossy().as_bytes());
    if metadata.file_type().is_symlink() {
        return Err(format!(
            "Persistent approvals are disabled while {} is a symlink",
            path.display()
        ));
    }
    if !metadata.is_file() {
        return Ok(());
    }
    let size = usize::try_from(metadata.len()).unwrap_or(usize::MAX);
    if size > *remaining {
        return Err("Repository changes are too large for a persistent approval".to_string());
    }
    *remaining -= size;
    let mut file = std::fs::File::open(path)
        .map_err(|e| format!("Unable to fingerprint {}: {e}", path.display()))?;
    let mut buf = [0_u8; 16 * 1024];
    loop {
        let read = file
            .read(&mut buf)
            .map_err(|e| format!("Unable to fingerprint {}: {e}", path.display()))?;
        if read == 0 {
            break;
        }
        hasher.update(&buf[..read]);
    }
    Ok(())
}

fn trust_fingerprint(root: &Path) -> Result<String, String> {
    let canonical_root = std::fs::canonicalize(root)
        .map_err(|e| format!("Unable to resolve workspace for approval: {e}"))?;
    let toplevel = git_bytes_limited(
        &canonical_root,
        &["rev-parse", "--show-toplevel"],
        16 * 1024,
    )?;
    let toplevel = PathBuf::from(String::from_utf8_lossy(&toplevel).trim());
    let canonical_toplevel = std::fs::canonicalize(&toplevel)
        .map_err(|e| format!("Unable to resolve repository for approval: {e}"))?;
    if !canonical_root.starts_with(&canonical_toplevel) {
        return Err("Workspace does not belong to its reported Git repository".into());
    }

    let head = git_bytes_limited(&canonical_toplevel, &["rev-parse", "HEAD"], 1024)?;
    let diff = git_bytes_limited(
        &canonical_toplevel,
        &["diff", "--binary", "--no-ext-diff", "HEAD", "--", "."],
        MAX_GIT_BYTES,
    )?;
    let untracked = git_bytes_limited(
        &canonical_toplevel,
        &[
            "ls-files",
            "--others",
            "--exclude-standard",
            "-z",
            "--",
            ".",
        ],
        MAX_UNTRACKED_LIST_BYTES,
    )?;

    let mut hasher = Sha256::new();
    hasher.update(b"klide-project-approval-v1\0");
    hasher.update(canonical_root.to_string_lossy().as_bytes());
    hasher.update(b"\0head\0");
    hasher.update(&head);
    hasher.update(b"\0diff\0");
    hasher.update(&diff);

    let mut remaining = MAX_GIT_BYTES;
    for raw in untracked.split(|b| *b == 0).filter(|s| !s.is_empty()) {
        let rel = PathBuf::from(String::from_utf8_lossy(raw).as_ref());
        if rel
            .components()
            .any(|c| !matches!(c, Component::Normal(_) | Component::CurDir))
        {
            return Err("Git returned an unsafe untracked path".into());
        }
        let path = canonical_toplevel.join(rel);
        if path.exists() {
            hash_file(&mut hasher, &path, &mut remaining)?;
        }
    }

    // Ignored local configuration can change command semantics too. Include
    // the common top-level files even though Git deliberately omitted them.
    for name in [
        ".env",
        ".env.local",
        ".env.development",
        ".env.development.local",
        ".npmrc",
        ".agents/tools.json",
        ".klide/worktree.json",
    ] {
        let path = canonical_root.join(name);
        if path.exists() {
            hash_file(&mut hasher, &path, &mut remaining)?;
        }
    }

    Ok(hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect())
}

/// Resolve a private app-data file for one capability and current repository
/// state. `Ok(None)` means project persistence is unavailable (not a Git repo,
/// unborn HEAD, or too much uncommitted data); callers safely fall back to
/// prompting and run-scoped memory.
pub fn location(
    runs_dir: &Path,
    workspace_root: &str,
    capability: &str,
) -> Result<Option<ApprovalLocation>, String> {
    let canonical_root = std::fs::canonicalize(workspace_root)
        .map_err(|e| format!("Unable to resolve workspace for approval: {e}"))?;
    let fingerprint = match trust_fingerprint(&canonical_root) {
        Ok(value) => value,
        Err(_) => return Ok(None),
    };
    let project_id = hex_digest(canonical_root.to_string_lossy().as_bytes());
    let app_data = runs_dir.parent().unwrap_or(runs_dir);
    Ok(Some(ApprovalLocation {
        path: app_data
            .join("approvals")
            .join(project_id)
            .join(format!("{capability}.json")),
        fingerprint,
    }))
}

pub fn write_private(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Approval store has no parent directory".to_string())?;
    std::fs::create_dir_all(parent).map_err(|e| format!("Unable to create approval store: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| format!("Unable to secure approval store: {e}"))?;
    }
    crate::durable::write_atomic_private(path, bytes)
        .map_err(|e| format!("Unable to write approval store: {e}"))
}
