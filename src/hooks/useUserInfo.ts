// useUserInfo — the identity shown at the foot of whichever rail is on screen.
// Local name/host and the authenticated GitHub profile picture resolve in
// parallel and are cached independently, so a slow/offline `gh` lookup never
// delays the local identity or refetches when layouts switch.

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { githubCurrentUser } from "../ipc/git";

type LocalUserInfo = { username: string; hostname: string };
type GitHubUserInfo = { githubLogin: string; avatarUrl: string };
export type UserInfo = LocalUserInfo & GitHubUserInfo;

const EMPTY_LOCAL: LocalUserInfo = { username: "", hostname: "" };
const EMPTY_GITHUB: GitHubUserInfo = { githubLogin: "", avatarUrl: "" };

let cachedLocal: LocalUserInfo | null = null;
let localInflight: Promise<LocalUserInfo> | null = null;
let cachedGitHub: GitHubUserInfo | null = null;
let githubInflight: Promise<GitHubUserInfo> | null = null;

function fetchLocalUserInfo(): Promise<LocalUserInfo> {
  if (cachedLocal) return Promise.resolve(cachedLocal);
  if (!localInflight) {
    localInflight = invoke<LocalUserInfo>("app_user_info")
      .then((u) => {
        cachedLocal = u;
        return u;
      })
      .catch(() => EMPTY_LOCAL)
      .finally(() => {
        localInflight = null;
      });
  }
  return localInflight;
}

function fetchGitHubUserInfo(): Promise<GitHubUserInfo> {
  if (cachedGitHub) return Promise.resolve(cachedGitHub);
  if (!githubInflight) {
    githubInflight = githubCurrentUser()
      .then((user) => {
        const next = { githubLogin: user.login, avatarUrl: user.avatarUrl };
        cachedGitHub = next;
        return next;
      })
      .catch(() => EMPTY_GITHUB)
      .finally(() => {
        githubInflight = null;
      });
  }
  return githubInflight;
}

// The GitHub identity is cached for the app's lifetime because it never changes
// on its own — except when you re-pin the account in Settings. That's a
// deliberate act, so it publishes here and every mounted rail/profile repaints
// instead of waiting for a restart.
const githubListeners = new Set<(info: GitHubUserInfo) => void>();

export function setGitHubUserInfo(user: { login: string; avatarUrl: string }): void {
  const next = { githubLogin: user.login, avatarUrl: user.avatarUrl };
  cachedGitHub = next;
  githubListeners.forEach((listen) => listen(next));
}

export function useUserInfo(): UserInfo {
  const [info, setInfo] = useState<UserInfo>(() => ({
    ...(cachedLocal ?? EMPTY_LOCAL),
    ...(cachedGitHub ?? EMPTY_GITHUB),
  }));

  useEffect(() => {
    // StrictMode mounts effects twice; module-level promises deduplicate both
    // lookups and the cancel flag drops results for an abandoned mount.
    let cancelled = false;
    fetchLocalUserInfo().then((local) => {
      if (!cancelled) setInfo((current) => ({ ...current, ...local }));
    });
    fetchGitHubUserInfo().then((github) => {
      if (!cancelled) setInfo((current) => ({ ...current, ...github }));
    });
    const onGitHubChange = (github: GitHubUserInfo) =>
      setInfo((current) => ({ ...current, ...github }));
    githubListeners.add(onGitHubChange);
    return () => {
      cancelled = true;
      githubListeners.delete(onGitHubChange);
    };
  }, []);

  return info;
}

/** Two-letter initials for the avatar — first + last word, else the first two
 *  characters. Punctuation and digits are stripped first. */
export function initialsOf(name: string): string {
  const parts = name.replace(/[^a-zA-Z0-9]+/g, " ").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
