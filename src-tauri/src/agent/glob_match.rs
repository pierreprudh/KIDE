//! One `*`/`?` matcher, for the two places that need one.
//!
//! The identical algorithm was written out twice — in `tools.rs` behind the
//! `glob` tool, and in `command_allowlist.rs` behind allowlist rules — differing
//! only in a local variable's name. A user experiences those as one thing ("`*`
//! means any run of characters"), and only one of the two copies was directly
//! tested, so the tested one could be fixed while the other quietly kept an old
//! behaviour.
//!
//! Deliberately not a crate: `glob`/`globset` bring path semantics (a `*` that
//! stops at `/`), and neither caller wants that. The allowlist matches command
//! *lines*, and the tool's caller strips `**/` itself before calling in.

/// Does `pattern` match the whole of `text`?
///
/// `*` matches any run of bytes including none; `?` matches exactly one byte.
/// Everything else is literal. Byte-wise, so a multi-byte character is several
/// `?` — neither caller matches against user prose, and treating a UTF-8
/// sequence as one unit would make the allowlist's coverage check harder to
/// reason about, not easier.
pub fn wildcard_match(pattern: &str, text: &str) -> bool {
    let p = pattern.as_bytes();
    let t = text.as_bytes();
    let (mut pi, mut ti) = (0_usize, 0_usize);
    // The most recent `*` in the pattern, and how much of `text` it had consumed
    // when we passed it — so a dead end can backtrack by giving it one more byte
    // rather than re-scanning from the start.
    let mut star: Option<usize> = None;
    let mut star_consumed = 0_usize;

    while ti < t.len() {
        if pi < p.len() && (p[pi] == b'?' || p[pi] == t[ti]) {
            pi += 1;
            ti += 1;
        } else if pi < p.len() && p[pi] == b'*' {
            star = Some(pi);
            star_consumed = ti;
            pi += 1;
        } else if let Some(star_i) = star {
            pi = star_i + 1;
            star_consumed += 1;
            ti = star_consumed;
        } else {
            return false;
        }
    }

    // Trailing `*`s may match nothing at all.
    while pi < p.len() && p[pi] == b'*' {
        pi += 1;
    }
    pi == p.len()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn literals_must_match_the_whole_text() {
        assert!(wildcard_match("cargo check", "cargo check"));
        assert!(!wildcard_match("cargo check", "cargo check --all"));
        assert!(!wildcard_match("cargo check --all", "cargo check"));
        assert!(wildcard_match("", ""));
        assert!(!wildcard_match("", "x"));
    }

    #[test]
    fn star_matches_any_run_including_nothing() {
        assert!(wildcard_match("cargo *", "cargo test"));
        assert!(wildcard_match("cargo test *", "cargo test --workspace --quiet"));
        // The one that matters for an allowlist rule: `cargo test *` should
        // cover the bare command too, not just an argumented one.
        assert!(wildcard_match("cargo test*", "cargo test"));
        assert!(wildcard_match("*", ""));
        assert!(wildcard_match("**", "anything"));
    }

    #[test]
    fn question_matches_exactly_one_byte() {
        assert!(wildcard_match("a?c", "abc"));
        assert!(!wildcard_match("a?c", "ac"));
        assert!(!wildcard_match("a?c", "abbc"));
    }

    #[test]
    fn backtracks_out_of_a_dead_end() {
        // A greedy `*` that never gave a byte back would fail these.
        assert!(wildcard_match("*.rs", "src/agent/mod.rs"));
        assert!(wildcard_match("src/*/mod.rs", "src/agent/mod.rs"));
        assert!(wildcard_match("*a*b*c", "xxayybzzc"));
        assert!(!wildcard_match("*a*b*c", "xxayybzz"));
    }

    #[test]
    fn a_star_spans_separators() {
        // Not path-aware, on purpose: the allowlist matches command lines, and
        // the glob tool's caller strips `**/` before calling in.
        assert!(wildcard_match("src/*.rs", "src/agent/mod.rs"));
    }
}
