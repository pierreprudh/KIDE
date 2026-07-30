//! Project-persistent approvals for network tools.
//!
//! Network tools are Goal-only and pause before first use. A project approval
//! stores a small target string such as `web_search` or `host:docs.rs` in
//! private, repository-fingerprint-bound app data.

use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct NetworkAllowlist {
    fingerprint: String,
    #[serde(default)]
    targets: Vec<String>,
}

pub fn list(runs_dir: &Path, workspace_root: &str) -> Result<Vec<String>, String> {
    let Some(location) = super::approval_store::location(runs_dir, workspace_root, "network")?
    else {
        return Ok(Vec::new());
    };
    let path = location.path;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let text = std::fs::read_to_string(&path)
        .map_err(|e| format!("Unable to read network allowlist: {e}"))?;
    let parsed: NetworkAllowlist =
        serde_json::from_str(&text).map_err(|e| format!("Invalid network allowlist JSON: {e}"))?;
    if parsed.fingerprint != location.fingerprint {
        return Ok(Vec::new());
    }
    Ok(normalize(parsed.targets))
}

pub fn add(runs_dir: &Path, workspace_root: &str, target: &str) -> Result<(), String> {
    let target = normalize_target(target);
    if target.is_empty() {
        return Ok(());
    }
    let location = super::approval_store::location(runs_dir, workspace_root, "network")?
        .ok_or_else(|| {
            "Project approvals require a Git repository with a manageable working tree".to_string()
        })?;
    let path = location.path;
    let mut targets = if path.exists() {
        list(runs_dir, workspace_root)?
    } else {
        Vec::new()
    };
    if !targets.iter().any(|t| t == &target) {
        targets.push(target);
        targets.sort();
    }
    let text = serde_json::to_string_pretty(&NetworkAllowlist {
        fingerprint: location.fingerprint,
        targets,
    })
    .map_err(|e| format!("Unable to serialize network allowlist: {e}"))?;
    super::approval_store::write_private(&path, format!("{text}\n").as_bytes())
}

pub fn is_allowed(runs_dir: &Path, workspace_root: &str, target: &str) -> Result<bool, String> {
    let target = normalize_target(target);
    Ok(list(runs_dir, workspace_root)?.iter().any(|t| t == &target))
}

fn normalize(targets: Vec<String>) -> Vec<String> {
    let mut out = Vec::new();
    for target in targets {
        let target = normalize_target(&target);
        if !target.is_empty() && !out.iter().any(|t| t == &target) {
            out.push(target);
        }
    }
    out.sort();
    out
}

fn normalize_target(target: &str) -> String {
    target.trim().to_ascii_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::process::Command;

    fn temp_workspace(name: &str) -> (String, PathBuf) {
        let dir = std::env::temp_dir().join(format!(
            "klide-network-allowlist-{name}-{}",
            std::process::id()
        ));
        let runs_dir = std::env::temp_dir().join(format!(
            "klide-network-allowlist-runs-{name}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&runs_dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::create_dir_all(&runs_dir).unwrap();
        Command::new("git")
            .args(["init", "-q"])
            .current_dir(&dir)
            .status()
            .unwrap();
        Command::new("git")
            .args([
                "-c",
                "user.name=Klide",
                "-c",
                "user.email=test@klide.local",
                "commit",
                "--allow-empty",
                "-qm",
                "initial",
            ])
            .current_dir(&dir)
            .status()
            .unwrap();
        (dir.to_string_lossy().to_string(), runs_dir)
    }

    #[test]
    fn missing_allowlist_is_empty() {
        let (root, runs_dir) = temp_workspace("missing");
        assert_eq!(list(&runs_dir, &root).unwrap(), Vec::<String>::new());
        let _ = std::fs::remove_dir_all(root);
        let _ = std::fs::remove_dir_all(runs_dir);
    }

    #[test]
    fn add_persists_unique_sorted_targets() {
        let (root, runs_dir) = temp_workspace("add");
        add(&runs_dir, &root, "host:Docs.RS").unwrap();
        add(&runs_dir, &root, " web_search ").unwrap();
        add(&runs_dir, &root, "host:docs.rs").unwrap();
        assert_eq!(
            list(&runs_dir, &root).unwrap(),
            vec!["host:docs.rs".to_string(), "web_search".to_string()]
        );
        assert!(is_allowed(&runs_dir, &root, "HOST:DOCS.RS").unwrap());
        assert!(!is_allowed(&runs_dir, &root, "host:example.com").unwrap());
        let _ = std::fs::remove_dir_all(root);
        let _ = std::fs::remove_dir_all(runs_dir);
    }
}
