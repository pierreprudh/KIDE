// One seam so a background module can send you to a Settings section.
//
// The quota toast is written from `storedConversations.ts` — a data module with
// no access to the app's view state — but it is exactly the moment you want the
// Storage section, so the message needs to be able to offer it. Rather than let
// a data module reach into App (or invent a second event bus), App registers
// the opener it already has and anyone may ask for it.
//
// Deliberately best-effort: `openSettingsSection` reports whether an opener was
// registered, so a caller can decide not to offer an action that would do
// nothing (a headless test, or a surface mounted before App's effect ran).
import type { SettingsSectionId } from "./settingsStore";

type SettingsOpener = (section: SettingsSectionId) => void;

let opener: SettingsOpener | null = null;

/** App calls this on mount, and with `null` on unmount. */
export function registerSettingsOpener(next: SettingsOpener | null): void {
  opener = next;
}

/** True when Settings is reachable — i.e. an action is worth offering. */
export function canOpenSettings(): boolean {
  return opener !== null;
}

/** Open Settings on one section. Returns false when nothing is listening. */
export function openSettingsSection(section: SettingsSectionId): boolean {
  if (!opener) return false;
  opener(section);
  return true;
}
