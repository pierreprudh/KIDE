// React binding for the self-hosted (custom:*) provider store.
//
// The store is a module-level cache (src/customProviders.ts) that
// providerName()/providerDefinition() read synchronously. Anything rendering a
// self-hosted endpoint's name has to re-render when that name changes —
// otherwise renaming an endpoint in Settings leaves a stale label in the AI
// panel header, the model picker, Mission Control, and the orchestrator.
//
// `useCustomProviders()` subscribes to the store and refreshes it once on
// mount. Components that only need names can ignore the return value.

import { useEffect, useSyncExternalStore } from "react";
import {
  getCustomProvidersSync,
  refreshCustomProviders,
  subscribeCustomProviders,
  type CustomProvider,
} from "../customProviders";

export function useCustomProviders(): CustomProvider[] {
  const providers = useSyncExternalStore(subscribeCustomProviders, getCustomProvidersSync);
  useEffect(() => {
    void refreshCustomProviders().catch(() => {
      /* store unreadable → keep whatever is cached */
    });
  }, []);
  return providers;
}
