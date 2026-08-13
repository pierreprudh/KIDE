// The one persisted-store contract for localStorage-backed run data (tasks,
// conversations, races, ledger metadata). Each store used to hand-roll its own
// cache + persist + pub/sub skeleton — with three different subscription
// shapes between them — so the skeleton lives once here and a store
// contributes only its decoder (plus, when it needs them, a bound and a
// durable form).
//
// The contract:
// - `get()` reads + decodes localStorage once (corruption-safe: a missing key,
//   a parse error, or an unavailable localStorage all decode from `undefined`)
//   and serves the in-memory value after that. The reference only changes on
//   `mutate`, so `get` is a stable `useSyncExternalStore` snapshot.
// - `mutate(updater)` replaces the value with `updater(current)`, applies the
//   bound, writes through to localStorage, and notifies subscribers — one
//   write, one notification. A full/unavailable storage never blocks the
//   notification: subscribers still see the in-memory value.
// - `subscribe(fn)` is the ONE subscription shape: a void callback fired after
//   every mutate; read the new value with `get()`. A store whose public API
//   pushes the value (races) wraps this shape, not the other way around.

export type PersistedStore<T> = {
  get(): T;
  subscribe(fn: () => void): () => void;
  mutate(updater: (current: T) => T): T;
};

export function createPersistedStore<T>({
  key,
  validate,
  bound,
  persist,
}: {
  key: string;
  /** Total decoder: raw parsed JSON (`undefined` when the key is missing or
   *  corrupt) → a valid T. Must never throw — filter bad elements, don't
   *  assert. `validatedArray` is the usual first rung. */
  validate: (parsed: unknown) => T;
  /** Applied to every mutate result (e.g. cap to the newest N entries) before
   *  it is cached and persisted. */
  bound?: (value: T) => T;
  /** The durable form, when it differs from the in-memory one (e.g. a live
   *  status that must not survive a restart). Defaults to the value itself. */
  persist?: (value: T) => unknown;
}): PersistedStore<T> {
  // Definite-assignment: `loaded` guards every read, so `value` is always
  // assigned before use even though TS can't see it through the closure.
  let value!: T;
  let loaded = false;
  const subscribers = new Set<() => void>();

  function get(): T {
    if (!loaded) {
      let parsed: unknown;
      try {
        const raw = localStorage.getItem(key);
        parsed = raw ? (JSON.parse(raw) as unknown) : undefined;
      } catch {
        parsed = undefined;
      }
      value = validate(parsed);
      loaded = true;
    }
    return value;
  }

  return {
    get,
    subscribe(fn) {
      subscribers.add(fn);
      return () => {
        subscribers.delete(fn);
      };
    },
    mutate(updater) {
      const updated = updater(get());
      value = bound ? bound(updated) : updated;
      try {
        localStorage.setItem(key, JSON.stringify(persist ? persist(value) : value));
      } catch {
        /* storage full or unavailable — subscribers still see the in-memory value */
      }
      for (const fn of subscribers) fn();
      return value;
    },
  };
}

/** Keep only the elements of a parsed JSON value that form an array and pass
 *  `isValid`. Anything else — non-array JSON, `undefined` from a corrupt read —
 *  yields `[]`. The per-element rung of a store's corruption-tolerance ladder. */
export function validatedArray<T>(
  parsed: unknown,
  isValid: (value: unknown) => value is T,
): T[] {
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(isValid);
}
