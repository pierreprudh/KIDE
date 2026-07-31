import { normalizeProjectPath } from "./projectPaths";

export const MAX_RECENT_FOLDERS = 8;

/**
 * Navigation only ensures a folder is present. Existing rows keep their exact
 * order; a newly seen folder enters quietly at the bottom.
 */
export function rememberOpenedFolder(
  folders: readonly string[],
  root: string | null | undefined,
  limit = MAX_RECENT_FOLDERS,
): string[] {
  const normalizedRoot = normalizeProjectPath(root);
  if (!normalizedRoot || limit <= 0) return folders as string[];
  if (folders.some((folder) => normalizeProjectPath(folder) === normalizedRoot)) {
    return folders as string[];
  }
  return [...folders.slice(0, Math.max(0, limit - 1)), normalizedRoot];
}

/** Real task activity promotes the owning folder to the front. */
export function promoteWorkedFolder(
  folders: readonly string[],
  root: string | null | undefined,
  limit = MAX_RECENT_FOLDERS,
): string[] {
  const normalizedRoot = normalizeProjectPath(root);
  if (!normalizedRoot || limit <= 0) return folders as string[];
  if (normalizeProjectPath(folders[0]) === normalizedRoot) return folders as string[];
  return [
    normalizedRoot,
    ...folders.filter((folder) => normalizeProjectPath(folder) !== normalizedRoot),
  ].slice(0, limit);
}
