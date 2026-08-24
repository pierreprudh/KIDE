// Typed frontend Adapter for the `app_storage_*` command family — the folders
// Klide writes for itself, measured.
//
// This is the disk half of the story Settings tells. The other half — the
// browser cache the conversation list reads — needs no IPC: it lives in
// localStorage, and `components/ai/storedConversations.ts` owns measuring and
// managing it.

import { invoke } from "@tauri-apps/api/core";

export type StorageDir = {
  /** Stable id to address this directory by in `revealStorageDir`. */
  kind: "runs" | "app-data";
  label: string;
  /** What lives here, in one line. */
  detail: string;
  path: string;
  files: number;
  bytes: number;
};

/** Measure the folders Klide owns. Walks the tree, so treat it as a fetch:
 *  call it when the section opens, not on every render. */
export function readStorageDirs(): Promise<StorageDir[]> {
  return invoke<StorageDir[]>("app_storage_dirs");
}

/** Open one of those folders in Finder. */
export function revealStorageDir(kind: StorageDir["kind"]): Promise<void> {
  return invoke<void>("app_storage_reveal", { kind });
}
