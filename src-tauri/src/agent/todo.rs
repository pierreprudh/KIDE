use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// A single task item.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TodoItem {
    pub id: String,
    pub text: String,
    pub done: bool,
    pub created_at: i64,
    #[serde(default)]
    pub updated_at: i64,
}

/// A single todo mutation, used by the UI to show how an agent's plan evolved.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TodoEvent {
    pub seq: u64,
    pub action: String,
    pub todo_id: Option<String>,
    pub text: Option<String>,
    pub previous_text: Option<String>,
    pub done: Option<bool>,
    pub at: i64,
}

/// The on-disk todo list.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct TodoStore {
    pub todos: Vec<TodoItem>,
    pub next_id: u64,
    #[serde(default)]
    pub events: Vec<TodoEvent>,
    #[serde(default = "default_next_event_id")]
    pub next_event_id: u64,
}

fn default_next_event_id() -> u64 {
    1
}

fn safe_scope(scope: &str) -> String {
    scope
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

fn store_path(root: &str, scope: &str) -> PathBuf {
    if scope.trim().is_empty() {
        return Path::new(root).join(".agents").join("todos.json");
    }
    Path::new(root)
        .join(".agents")
        .join("todos")
        .join(format!("{}.json", safe_scope(scope)))
}

fn load(root: &str, scope: &str) -> TodoStore {
    let path = store_path(root, scope);
    std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str::<TodoStore>(&s).ok())
        .unwrap_or(TodoStore {
            todos: Vec::new(),
            next_id: 1,
            events: Vec::new(),
            next_event_id: 1,
        })
}

fn save(root: &str, scope: &str, store: &TodoStore) -> Result<(), String> {
    let path = store_path(root, scope);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Cannot create .agents dir: {e}"))?;
    }
    let json =
        serde_json::to_string_pretty(store).map_err(|e| format!("Cannot serialize todos: {e}"))?;
    // Atomic, because `load` treats an unparseable store as an empty one: a
    // truncated write here would silently discard the whole plan mid-run and
    // the next save would make that permanent. Same helper the Mission event
    // log uses (`durable`).
    crate::durable::write_atomic(&path, json.as_bytes())
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn push_event(
    store: &mut TodoStore,
    action: &str,
    todo_id: Option<String>,
    text: Option<String>,
    previous_text: Option<String>,
    done: Option<bool>,
    at: i64,
) {
    store.events.push(TodoEvent {
        seq: store.next_event_id,
        action: action.to_string(),
        todo_id,
        text,
        previous_text,
        done,
        at,
    });
    store.next_event_id += 1;
    const MAX_EVENTS: usize = 120;
    if store.events.len() > MAX_EVENTS {
        let overflow = store.events.len() - MAX_EVENTS;
        store.events.drain(0..overflow);
    }
}

/// Return a formatted string of all todos, or None if there are none.
pub fn list_todos_text(root: &str, scope: &str) -> Option<String> {
    let store = load(root, scope);
    if store.todos.is_empty() {
        return None;
    }
    let mut lines = Vec::new();
    for item in &store.todos {
        let checkbox = if item.done { "[x]" } else { "[ ]" };
        lines.push(format!("{} {}: {}", checkbox, item.id, item.text));
    }
    Some(lines.join("\n"))
}

/// Add a new todo item. Returns a confirmation message.
pub fn add_todo(root: &str, scope: &str, text: String) -> Result<String, String> {
    let mut store = load(root, scope);
    let id = format!("T{}", store.next_id);
    store.next_id += 1;
    let at = now_ms();
    store.todos.push(TodoItem {
        id: id.clone(),
        text: text.clone(),
        done: false,
        created_at: at,
        updated_at: at,
    });
    push_event(
        &mut store,
        "add",
        Some(id.clone()),
        Some(text),
        None,
        Some(false),
        at,
    );
    save(root, scope, &store)?;
    Ok(format!("Added todo {id}."))
}

/// Set the done status of a todo. Returns the updated status.
pub fn set_todo_done(root: &str, scope: &str, id: &str, done: bool) -> Result<String, String> {
    let mut store = load(root, scope);
    let at = now_ms();
    let item = store
        .todos
        .iter_mut()
        .find(|t| t.id == id)
        .ok_or_else(|| format!("Todo {id} not found."))?;
    let changed = item.done != done;
    item.done = done;
    item.updated_at = at;
    let status = if item.done { "done" } else { "pending" };
    if changed {
        push_event(
            &mut store,
            if done { "complete" } else { "uncomplete" },
            Some(id.to_string()),
            None,
            None,
            Some(done),
            at,
        );
    }
    save(root, scope, &store)?;
    Ok(format!("Todo {id} marked as {status}."))
}

/// Remove a todo by id.
pub fn remove_todo(root: &str, scope: &str, id: &str) -> Result<String, String> {
    let mut store = load(root, scope);
    let Some(index) = store.todos.iter().position(|t| t.id == id) else {
        return Err(format!("Todo {id} not found."));
    };
    let removed = store.todos.remove(index);
    push_event(
        &mut store,
        "remove",
        Some(id.to_string()),
        Some(removed.text),
        None,
        Some(removed.done),
        now_ms(),
    );
    save(root, scope, &store)?;
    Ok(format!("Removed todo {id}."))
}

/// Clear all completed todos. Returns a count of removed items.
pub fn clear_done(root: &str, scope: &str) -> Result<String, String> {
    let mut store = load(root, scope);
    let removed_items: Vec<TodoItem> = store.todos.iter().filter(|t| t.done).cloned().collect();
    let len_before = store.todos.len();
    store.todos.retain(|t| !t.done);
    let removed = len_before - store.todos.len();
    let at = now_ms();
    for item in removed_items {
        push_event(
            &mut store,
            "remove",
            Some(item.id),
            Some(item.text),
            None,
            Some(true),
            at,
        );
    }
    save(root, scope, &store)?;
    Ok(format!("Cleared {removed} completed todo(s)."))
}

/// Remove every todo (done and pending). Use to start a fresh plan.
pub fn clear_all(root: &str, scope: &str) -> Result<String, String> {
    let mut store = load(root, scope);
    let removed_items: Vec<TodoItem> = store.todos.drain(..).collect();
    let removed = removed_items.len();
    let at = now_ms();
    for item in removed_items {
        push_event(
            &mut store,
            "remove",
            Some(item.id),
            Some(item.text),
            None,
            Some(item.done),
            at,
        );
    }
    save(root, scope, &store)?;
    Ok(format!("Cleared {removed} todo(s)."))
}

/// Update the text of a todo item.
pub fn update_text(root: &str, scope: &str, id: &str, text: String) -> Result<String, String> {
    let mut store = load(root, scope);
    let at = now_ms();
    let (previous_text, done) = {
        let item = store
            .todos
            .iter_mut()
            .find(|t| t.id == id)
            .ok_or_else(|| format!("Todo {id} not found."))?;
        let previous_text = item.text.clone();
        let done = item.done;
        item.text = text.clone();
        item.updated_at = at;
        (previous_text, done)
    };
    if previous_text != text {
        push_event(
            &mut store,
            "edit",
            Some(id.to_string()),
            Some(text),
            Some(previous_text),
            Some(done),
            at,
        );
    }
    save(root, scope, &store)?;
    Ok(format!("Updated todo {id}."))
}

#[cfg(test)]
mod tests {
    //! The todo store is on the hot path — `list_todos_text` runs on every
    //! agent turn to build the system prompt, and the plan tools mutate it
    //! mid-run. It carries three invariants nothing checked before: ids are
    //! never reused, the event log's `seq` only ever increases, and a `scope`
    //! can't escape `.agents/todos/`.
    use super::*;

    /// A fresh workspace root per test. Scoped by name so tests can run in
    /// parallel without sharing a store.
    fn root(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("klide-todo-test-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn at(root: &Path) -> &str {
        root.to_str().unwrap()
    }

    #[test]
    fn add_list_complete_and_clear_round_trip() {
        let dir = root("round-trip");
        let r = at(&dir);
        assert!(
            list_todos_text(r, "").is_none(),
            "empty store lists nothing"
        );

        add_todo(r, "", "write the parser".into()).unwrap();
        add_todo(r, "", "wire the seam".into()).unwrap();
        assert_eq!(
            list_todos_text(r, "").unwrap(),
            "[ ] T1: write the parser\n[ ] T2: wire the seam"
        );

        set_todo_done(r, "", "T1", true).unwrap();
        assert_eq!(
            list_todos_text(r, "").unwrap(),
            "[x] T1: write the parser\n[ ] T2: wire the seam"
        );

        assert_eq!(clear_done(r, "").unwrap(), "Cleared 1 completed todo(s).");
        assert_eq!(list_todos_text(r, "").unwrap(), "[ ] T2: wire the seam");

        assert_eq!(clear_all(r, "").unwrap(), "Cleared 1 todo(s).");
        assert!(list_todos_text(r, "").is_none());
    }

    #[test]
    fn ids_are_never_reused_after_removal() {
        // The model refers to todos by id inside a run. If `next_id` were
        // derived from the list length, removing T1 and adding another item
        // would mint a second T1 — and a `complete T1` from earlier in the
        // conversation would tick the wrong task.
        let dir = root("id-reuse");
        let r = at(&dir);
        add_todo(r, "", "first".into()).unwrap();
        remove_todo(r, "", "T1").unwrap();
        add_todo(r, "", "second".into()).unwrap();
        assert_eq!(list_todos_text(r, "").unwrap(), "[ ] T2: second");
    }

    #[test]
    fn missing_ids_are_reported_not_ignored() {
        let dir = root("missing-id");
        let r = at(&dir);
        assert_eq!(
            set_todo_done(r, "", "T9", true).unwrap_err(),
            "Todo T9 not found."
        );
        assert_eq!(remove_todo(r, "", "T9").unwrap_err(), "Todo T9 not found.");
        assert_eq!(
            update_text(r, "", "T9", "x".into()).unwrap_err(),
            "Todo T9 not found."
        );
    }

    #[test]
    fn edits_record_the_previous_text_once() {
        let dir = root("edit-events");
        let r = at(&dir);
        add_todo(r, "", "old".into()).unwrap();
        update_text(r, "", "T1", "new".into()).unwrap();
        // A no-op edit must not push an event — otherwise a model that
        // re-states its plan verbatim floods the log and evicts real history.
        update_text(r, "", "T1", "new".into()).unwrap();

        let store = load(r, "");
        let edits: Vec<&TodoEvent> = store.events.iter().filter(|e| e.action == "edit").collect();
        assert_eq!(edits.len(), 1);
        assert_eq!(edits[0].previous_text.as_deref(), Some("old"));
        assert_eq!(edits[0].text.as_deref(), Some("new"));
    }

    #[test]
    fn toggling_to_the_same_state_records_nothing() {
        let dir = root("idempotent-complete");
        let r = at(&dir);
        add_todo(r, "", "task".into()).unwrap();
        set_todo_done(r, "", "T1", true).unwrap();
        set_todo_done(r, "", "T1", true).unwrap();
        let store = load(r, "");
        assert_eq!(
            store
                .events
                .iter()
                .filter(|e| e.action == "complete")
                .count(),
            1
        );
    }

    #[test]
    fn event_seq_keeps_increasing_past_the_ring_cap() {
        // The ring drops the *oldest* events at 120, but `seq` is a running
        // counter, not an index. The UI reads it to order the plan's history,
        // so it must never restart or repeat after an eviction.
        let dir = root("event-ring");
        let r = at(&dir);
        for i in 0..130 {
            add_todo(r, "", format!("task {i}")).unwrap();
        }
        let store = load(r, "");
        assert_eq!(store.events.len(), 120, "ring capped");
        let seqs: Vec<u64> = store.events.iter().map(|e| e.seq).collect();
        assert_eq!(seqs.first().copied(), Some(11), "oldest 10 evicted");
        assert_eq!(seqs.last().copied(), Some(130));
        assert!(
            seqs.windows(2).all(|w| w[1] == w[0] + 1),
            "seq is contiguous and increasing"
        );
    }

    #[test]
    fn a_scope_cannot_escape_the_todos_directory() {
        // `scope` reaches this module from a tool call, so it is model-authored
        // input. Anything that isn't `[A-Za-z0-9_-]` collapses to `_` —
        // including `.` and `/` — so the result is always a single filename
        // inside `.agents/todos/`, never a path.
        let dir = root("scope-escape");
        let r = at(&dir);
        let hostile = store_path(r, "../../../../etc/passwd");
        assert_eq!(
            hostile,
            dir.join(".agents")
                .join("todos")
                .join("____________etc_passwd.json")
        );
        assert!(hostile.starts_with(dir.join(".agents").join("todos")));

        // And a scoped list is genuinely separate from the default one.
        add_todo(r, "", "unscoped".into()).unwrap();
        add_todo(r, "run-1", "scoped".into()).unwrap();
        assert_eq!(list_todos_text(r, "").unwrap(), "[ ] T1: unscoped");
        assert_eq!(list_todos_text(r, "run-1").unwrap(), "[ ] T1: scoped");
        // A whitespace-only scope is the default store, not a `" ".json` file.
        assert_eq!(store_path(r, "   "), store_path(r, ""));
    }

    #[test]
    fn an_unreadable_store_reads_as_empty() {
        // Pinning current behaviour, not endorsing it: `load` swallows a parse
        // error and hands back an empty store, so the next `save` overwrites
        // whatever was there. Writes are atomic (see `save`), so Klide can no
        // longer *create* this state — but an externally corrupted file still
        // costs the user their list silently.
        let dir = root("corrupt-store");
        let r = at(&dir);
        let path = store_path(r, "");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "{not json").unwrap();
        assert!(list_todos_text(r, "").is_none());
    }
}
