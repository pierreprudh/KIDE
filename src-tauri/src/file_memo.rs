//! A parsed-file memo keyed on the file's identity on disk.
//!
//! Mission Control polls the run listing every 7.5 s, and until now every poll
//! re-parsed every Delegate transcript, every Harness summary and every
//! scrollback meta it could see — files that change only while a session is
//! live. `FileMemo` remembers the parsed value of one file against its
//! `(mtime_ns, len)` and a caller-supplied `epoch`, and recomputes only when one
//! of those moves. That is the trust Git's own index places in a stat: a byte
//! can change behind an unchanged mtime and length only by a rewrite landing in
//! the same nanosecond as the last one.
//!
//! The `epoch` is for inputs *outside* the file — Codex's run title lives in a
//! sidecar index, so its parser stamps the memo with that index's mtime. Pass
//! `0` when the file is the only input.
//!
//! One module, three adapters (Delegate runs, Harness summaries, scrollback
//! metas): the memo is the seam, the parse stays where it was.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

/// Past this many remembered files the memo starts over rather than growing
/// with the whole disk history. ~1 KB per entry, so this is a few tens of MB
/// at the very worst and never reached on a normal machine.
const MAX_ENTRIES: usize = 20_000;

struct Entry<T> {
    mtime_ns: u128,
    len: u64,
    epoch: u64,
    value: T,
    /// How many times this path has been computed — per path, so a test can
    /// look at its own file while other tests share the same static memo.
    #[cfg(test)]
    computes: usize,
}

pub struct FileMemo<T> {
    map: OnceLock<Mutex<HashMap<PathBuf, Entry<T>>>>,
    #[cfg(test)]
    computes: std::sync::atomic::AtomicUsize,
}

impl<T: Clone> FileMemo<T> {
    pub const fn new() -> Self {
        Self {
            map: OnceLock::new(),
            #[cfg(test)]
            computes: std::sync::atomic::AtomicUsize::new(0),
        }
    }

    fn map(&self) -> &Mutex<HashMap<PathBuf, Entry<T>>> {
        self.map.get_or_init(|| Mutex::new(HashMap::new()))
    }

    /// The remembered value for `path` at its current mtime, length and
    /// `epoch`, or `compute(path)` remembered for next time. A path whose
    /// metadata cannot be read (missing, or not a path at all) is computed and
    /// not remembered — the caller sees exactly what it would have without the
    /// memo.
    pub fn get_or_compute(&self, path: &Path, epoch: u64, compute: impl FnOnce(&Path) -> T) -> T {
        let Ok(meta) = std::fs::symlink_metadata(path) else {
            #[cfg(test)]
            self.computes.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            return compute(path);
        };
        let mtime_ns = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let len = meta.len();
        if let Some(hit) = self.map().lock().unwrap().get(path) {
            if hit.mtime_ns == mtime_ns && hit.len == len && hit.epoch == epoch {
                return hit.value.clone();
            }
        }
        // Parse outside the lock: a 90 MB transcript must not stall every
        // other reader, and two threads parsing the same file once each is
        // cheaper than serializing all of them.
        #[cfg(test)]
        self.computes.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let value = compute(path);
        let mut map = self.map().lock().unwrap();
        if map.len() >= MAX_ENTRIES {
            map.clear();
        }
        #[cfg(test)]
        let computes = map.get(path).map(|e| e.computes).unwrap_or(0) + 1;
        map.insert(
            path.to_path_buf(),
            Entry {
                mtime_ns,
                len,
                epoch,
                value: value.clone(),
                #[cfg(test)]
                computes,
            },
        );
        value
    }

    /// How many times `compute` has run for this one path.
    #[cfg(test)]
    pub fn computes_for(&self, path: &Path) -> usize {
        self.map()
            .lock()
            .unwrap()
            .get(path)
            .map(|e| e.computes)
            .unwrap_or(0)
    }

    /// How many times `compute` has run — the tests' way of seeing a hit.
    #[cfg(test)]
    pub fn computes(&self) -> usize {
        self.computes.load(std::sync::atomic::Ordering::Relaxed)
    }
}

/// The mtime of `path` in milliseconds, or 0 when it cannot be read — the
/// usual `epoch` for a sidecar input.
pub fn mtime_epoch(path: &Path) -> u64 {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("klide-file-memo-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn an_unchanged_file_is_parsed_once() {
        let dir = scratch("hit");
        let path = dir.join("a.txt");
        std::fs::write(&path, "one").unwrap();
        let memo: FileMemo<String> = FileMemo::new();
        let read = |p: &Path| std::fs::read_to_string(p).unwrap();
        assert_eq!(memo.get_or_compute(&path, 0, read), "one");
        assert_eq!(memo.get_or_compute(&path, 0, read), "one");
        assert_eq!(memo.get_or_compute(&path, 0, read), "one");
        assert_eq!(memo.computes(), 1);
    }

    #[test]
    fn a_rewrite_is_seen_through_length_or_mtime() {
        let dir = scratch("rewrite");
        let path = dir.join("a.txt");
        std::fs::write(&path, "one").unwrap();
        let memo: FileMemo<String> = FileMemo::new();
        let read = |p: &Path| std::fs::read_to_string(p).unwrap();
        assert_eq!(memo.get_or_compute(&path, 0, read), "one");
        // Different length.
        std::fs::write(&path, "three").unwrap();
        assert_eq!(memo.get_or_compute(&path, 0, read), "three");
        // Same length, later mtime.
        std::thread::sleep(std::time::Duration::from_millis(20));
        std::fs::write(&path, "seven").unwrap();
        assert_eq!(memo.get_or_compute(&path, 0, read), "seven");
        assert_eq!(memo.computes(), 3);
    }

    #[test]
    fn an_epoch_change_recomputes_an_unchanged_file() {
        let dir = scratch("epoch");
        let path = dir.join("a.txt");
        std::fs::write(&path, "one").unwrap();
        let memo: FileMemo<String> = FileMemo::new();
        let read = |p: &Path| std::fs::read_to_string(p).unwrap();
        memo.get_or_compute(&path, 1, read);
        memo.get_or_compute(&path, 1, read);
        memo.get_or_compute(&path, 2, read);
        assert_eq!(memo.computes(), 2);
    }

    #[test]
    fn a_path_without_metadata_is_computed_and_not_remembered() {
        let memo: FileMemo<Option<u8>> = FileMemo::new();
        let key = Path::new("not-a-file-just-a-session-id");
        assert_eq!(memo.get_or_compute(key, 0, |_| Some(1)), Some(1));
        assert_eq!(memo.get_or_compute(key, 0, |_| Some(2)), Some(2));
        assert_eq!(memo.computes(), 2);
    }
}
