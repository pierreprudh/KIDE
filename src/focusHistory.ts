import type { ProviderId } from "./agent/types";

/** Resolve a provider group's disclosure state when the user has not made an
 * explicit choice. Kept pure so secondary-panel history behavior is testable
 * without mounting the full Focus workspace. */
export function providerHistoryExpanded(
  explicit: boolean | undefined,
  groupProvider: ProviderId,
  activeProvider: ProviderId,
  newestProvider: ProviderId | undefined,
): boolean {
  return explicit ?? (
    groupProvider === activeProvider || groupProvider === newestProvider
  );
}
