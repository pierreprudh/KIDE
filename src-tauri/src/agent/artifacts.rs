//! What a command left behind.
//!
//! A write tool's edit is reviewed, checkpointed and announced as
//! `FileChanged`. A file a *command* produces — a deck built by python-pptx, a
//! PDF from pandoc, a report a script wrote — goes through none of that: the
//! harness ran a shell command, and the deliverable is invisible to every
//! surface that reads the event stream.
//!
//! So an approved command is bracketed: the workspace's dirty set is read
//! before it runs and again after, and whatever appeared or changed in between
//! is what that command produced. `git status --porcelain` is the source
//! because it is deterministic, already how the rest of the harness asks this
//! question (`commit_worktree_on_done`), and honours the project's ignore
//! rules for free — a `npm install` or a build into an ignored `dist/` says
//! nothing, which is exactly right.
//!
//! Everything here is pure and takes the porcelain text as input; the process
//! call and the event live in the tool handler.

use std::collections::BTreeMap;

/// How many produced files one command may announce. A command that rewrites
/// a thousand tracked files is a refactor, not a deliverable, and the event
/// stream is a transcript before it is a file list.
pub(crate) const MAX_PRODUCED: usize = 50;

/// One file a command left behind.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Produced {
    pub(crate) path: String,
    /// The file did not exist before the command — untracked (`??`) or added
    /// (`A`). A regenerated deck is a change, not a creation.
    pub(crate) created: bool,
}

/// Parse `git status --porcelain` into `path -> status`.
///
/// Porcelain v1 is `XY <path>`, where a rename carries `orig -> new` and a
/// path with a space or a quote is C-quoted. Only the right-hand side of a
/// rename is a file that now exists, and a quoted path is unwrapped rather
/// than dropped — a deck is far more likely to be called `Q3 review.pptx`
/// than `q3.pptx`.
pub(crate) fn parse_porcelain(out: &str) -> BTreeMap<String, String> {
    let mut map = BTreeMap::new();
    for line in out.lines() {
        if line.len() < 4 {
            continue;
        }
        let (status, rest) = line.split_at(2);
        let rest = rest.trim_start();
        let path = rest.rsplit(" -> ").next().unwrap_or(rest);
        let path = unquote(path);
        if path.is_empty() {
            continue;
        }
        // The two characters are kept as they come: ` M` (worktree) and `M `
        // (staged) are different states of the same file, and collapsing them
        // would hide a command that staged what the agent had already edited.
        map.insert(path, status.to_string());
    }
    map
}

/// Undo git's C-quoting of a path. Only the escapes git actually emits for a
/// path are handled; anything else is kept literally rather than eaten.
fn unquote(path: &str) -> String {
    let Some(inner) = path.strip_prefix('"').and_then(|p| p.strip_suffix('"')) else {
        return path.to_string();
    };
    let mut out = String::with_capacity(inner.len());
    let mut chars = inner.chars();
    while let Some(ch) = chars.next() {
        if ch != '\\' {
            out.push(ch);
            continue;
        }
        match chars.next() {
            Some('n') => out.push('\n'),
            Some('t') => out.push('\t'),
            Some('"') => out.push('"'),
            Some('\\') => out.push('\\'),
            Some(other) => {
                out.push('\\');
                out.push(other);
            }
            None => out.push('\\'),
        }
    }
    out
}

/// What changed between two dirty sets: a path the command added, or one whose
/// status it moved. A deletion produces nothing, so `D` is not a deliverable.
///
/// Comparing statuses rather than just membership is what keeps a file the
/// agent had already edited by hand out of the list — it is dirty in both
/// snapshots with the same status — while still catching a command that
/// overwrote it (`M` staged to ` M`, or untracked to added).
pub(crate) fn produced(
    before: &BTreeMap<String, String>,
    after: &BTreeMap<String, String>,
) -> Vec<Produced> {
    let mut out: Vec<Produced> = after
        .iter()
        .filter(|(path, status)| !status.contains('D') && before.get(*path) != Some(*status))
        .map(|(path, status)| Produced {
            path: path.clone(),
            created: status.starts_with('?') || status.starts_with('A'),
        })
        .collect();
    out.truncate(MAX_PRODUCED);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn set(lines: &str) -> BTreeMap<String, String> {
        parse_porcelain(lines)
    }

    #[test]
    fn an_untracked_file_a_command_wrote_is_produced_and_created() {
        let before = set("");
        let after = set("?? decks/Q3.pptx\n");
        assert_eq!(
            produced(&before, &after),
            vec![Produced {
                path: "decks/Q3.pptx".into(),
                created: true
            }],
        );
    }

    #[test]
    fn a_file_the_agent_had_already_edited_is_not_reannounced() {
        // The write tool's edit is already a FileChanged with a checkpoint; it
        // is dirty before the command and unchanged by it.
        let before = set(" M src/time.ts\n");
        let after = set(" M src/time.ts\n?? report.md\n");
        assert_eq!(
            produced(&before, &after),
            vec![Produced {
                path: "report.md".into(),
                created: true
            }],
        );
    }

    #[test]
    fn a_command_that_overwrites_an_edited_file_still_counts_as_a_change() {
        let before = set(" M report.md\n");
        let after = set("M  report.md\n");
        assert_eq!(
            produced(&before, &after),
            vec![Produced {
                path: "report.md".into(),
                created: false
            }],
        );
    }

    #[test]
    fn a_deletion_produces_nothing() {
        let before = set("");
        let after = set(" D old.pptx\n");
        assert_eq!(produced(&before, &after), vec![]);
    }

    #[test]
    fn a_rename_is_read_as_the_file_that_now_exists() {
        let after = set("R  decks/old.pptx -> decks/Q3 review.pptx\n");
        assert_eq!(
            produced(&set(""), &after),
            vec![Produced {
                path: "decks/Q3 review.pptx".into(),
                created: false
            }],
        );
    }

    #[test]
    fn a_quoted_path_survives_its_quoting() {
        let after = set("?? \"decks/Q3 review \\\"final\\\".pptx\"\n");
        assert_eq!(
            produced(&set(""), &after)[0].path,
            "decks/Q3 review \"final\".pptx",
        );
    }

    #[test]
    fn a_refactor_is_capped_rather_than_flooding_the_transcript() {
        let after = set(&(0..MAX_PRODUCED + 20)
            .map(|i| format!(" M src/file{i:03}.ts\n"))
            .collect::<String>());
        assert_eq!(produced(&set(""), &after).len(), MAX_PRODUCED);
    }
}
