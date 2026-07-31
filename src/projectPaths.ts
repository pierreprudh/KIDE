/** Normalize a filesystem path for UI ownership comparisons. */
export function normalizeProjectPath(path: string | null | undefined): string | null {
  if (!path) return null;
  const slashed = path.trim().replace(/\\/g, "/");
  if (!slashed) return null;
  if (slashed === "/") return slashed;
  if (/^[A-Za-z]:\/+$/u.test(slashed)) return `${slashed.slice(0, 2)}/`;
  return slashed.replace(/\/+$/u, "");
}

function isSameOrDescendant(path: string, root: string): boolean {
  const prefix = root.endsWith("/") ? root : `${root}/`;
  return path === root || path.startsWith(prefix);
}

/**
 * Whether a working directory belongs to a project, including Klide's linked
 * worktrees stored beside the checkout in `<project>-worktrees/<name>`.
 */
export function pathBelongsToProject(
  path: string | null | undefined,
  projectRoot: string | null | undefined,
): boolean {
  const normalizedPath = normalizeProjectPath(path);
  const normalizedRoot = normalizeProjectPath(projectRoot);
  if (!normalizedPath || !normalizedRoot) return false;
  if (isSameOrDescendant(normalizedPath, normalizedRoot)) return true;

  const worktreeContainer = `${normalizedRoot}-worktrees`;
  return isSameOrDescendant(normalizedPath, worktreeContainer);
}

/** Find the most specific visible project that owns a working directory. */
export function linkedProjectForPath(
  path: string | null | undefined,
  projectRoots: readonly string[],
): string | null {
  let bestMatch: string | null = null;
  for (const candidate of projectRoots) {
    const projectRoot = normalizeProjectPath(candidate);
    if (!projectRoot || !pathBelongsToProject(path, projectRoot)) continue;
    if (!bestMatch || projectRoot.length > bestMatch.length) bestMatch = projectRoot;
  }
  return bestMatch;
}

/** Extra folder context shown when a conversation isn't at the project root. */
export function linkedFolderLabel(
  path: string | null | undefined,
  projectRoot: string | null | undefined,
): string | null {
  const normalizedPath = normalizeProjectPath(path);
  const normalizedRoot = normalizeProjectPath(projectRoot);
  if (!normalizedPath || !normalizedRoot || normalizedPath === normalizedRoot) return null;

  const projectPrefix = normalizedRoot.endsWith("/") ? normalizedRoot : `${normalizedRoot}/`;
  if (normalizedPath.startsWith(projectPrefix)) {
    return normalizedPath.slice(projectPrefix.length) || null;
  }

  const worktreePrefix = `${normalizedRoot}-worktrees/`;
  if (normalizedPath.startsWith(worktreePrefix)) {
    return `Worktree · ${normalizedPath.slice(worktreePrefix.length)}`;
  }

  return normalizedPath.split("/").filter(Boolean).pop() ?? normalizedPath;
}
