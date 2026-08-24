// Storage — where a conversation lives, how much room it takes, and what you
// can throw away.
//
// Klide keeps a conversation twice, and the two copies are not equals:
//
//  · the **local cache** — the browser's localStorage index the Focus rail and
//    the AI panel's history read from. It shares one ~5 MB quota with every
//    other Klide key, and when a write no longer fits, the oldest snapshots are
//    evicted to make room. That is the number this section makes visible,
//    because it used to be invisible until a toast said 33 threads were gone.
//  · the **Run transcripts** on disk — the durable record Mission Control
//    reads. Nothing here deletes those; the folder rows say where they are.
//
// So the whole section answers one question: what is the cache holding, and
// what happens if I clear it? (Answer: your history list shortens, your runs
// don't move.)

import { useCallback, useEffect, useState } from "react";
import {
  cachedConversationSizes,
  clearStoredConversations,
  dropCachedImages,
  forgetStoredConversation,
  localCacheUsage,
  type CachedConversationSize,
} from "../ai/storedConversations";
import { deleteKlideConvo } from "../../klideConvos";
import { readStorageDirs, revealStorageDir, type StorageDir } from "../../ipc/storage";
import { relativeTime } from "../ai/utils";
import { errMessage } from "../../errors";
import { notify } from "../../toast";
import { CodeText, GhostButton, LinkButton, Panel, Row, SettingBlock } from "./controls";

/** What a webview gives the whole origin. Not readable at runtime — WebKit
 *  reports no quota — so the meter measures against the figure the platform
 *  actually enforces, and says it is approximate. */
const CACHE_QUOTA_BYTES = 5_000_000;

export function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 KB";
  if (bytes < 1000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${Math.round(bytes / 1000)} KB`;
  return `${(bytes / 1_000_000).toFixed(bytes < 10_000_000 ? 1 : 0)} MB`;
}

/** A hairline fill, not a progress bar: it reports pressure, and turns from
 *  quiet to warning only once the quota is genuinely close. */
function CacheMeter({ used, quota }: { used: number; quota: number }) {
  const ratio = Math.max(0, Math.min(1, used / quota));
  const tight = ratio >= 0.8;
  return (
    <div style={{ display: "grid", gap: 6, minWidth: 180 }}>
      <div
        role="meter"
        aria-valuenow={Math.round(ratio * 100)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Local cache used"
        style={{ height: 3, borderRadius: 2, background: "var(--border)", overflow: "hidden" }}
      >
        <div
          style={{
            width: `${Math.max(ratio * 100, ratio > 0 ? 2 : 0)}%`,
            height: "100%",
            background: tight ? "var(--warning)" : "var(--fg-subtle)",
            transition: "width var(--motion-med) var(--ease-out)",
          }}
        />
      </div>
      <div style={{ fontSize: 11.5, color: tight ? "var(--warning)" : "var(--fg-subtle)", textAlign: "right" }}>
        {formatBytes(used)} of about {formatBytes(quota)}
      </div>
    </div>
  );
}

export function StorageSection() {
  const [sizes, setSizes] = useState<CachedConversationSize[]>([]);
  const [used, setUsed] = useState(0);
  const [dirs, setDirs] = useState<StorageDir[] | null>(null);
  const [dirsError, setDirsError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  const refreshCache = useCallback(() => {
    setSizes(cachedConversationSizes());
    setUsed(localCacheUsage().bytes);
  }, []);

  useEffect(() => {
    refreshCache();
    let cancelled = false;
    readStorageDirs()
      .then((list) => {
        if (!cancelled) setDirs(list);
      })
      .catch((e) => {
        if (!cancelled) setDirsError(errMessage(e));
      });
    return () => {
      cancelled = true;
    };
  }, [refreshCache]);

  const photoBytes = sizes.reduce((sum, s) => sum + s.imageBytes, 0);
  const withPhotos = sizes.filter((s) => s.imageBytes > 0).length;
  const shown = expanded ? sizes : sizes.slice(0, 6);

  function forget(row: CachedConversationSize) {
    forgetStoredConversation(row.id);
    // The AI panel's own delete does both writes; a Settings delete that only
    // touched localStorage would leave the row on Mission Control's board.
    deleteKlideConvo(row.id);
    refreshCache();
  }

  return (
    <>
      <SettingBlock title="Local conversation cache">
        <Panel>
          <Row
            title="Cache used"
            description={
              sizes.length === 0
                ? "Nothing cached. Your runs are still on disk — see the folders below."
                : `${sizes.length} conversation${sizes.length === 1 ? "" : "s"} in the history list${
                    withPhotos > 0
                      ? `, ${withPhotos} carrying ${formatBytes(photoBytes)} of photos`
                      : ""
                  }. Shared with every other Klide key in this webview.`
            }
            control={<CacheMeter used={used} quota={CACHE_QUOTA_BYTES} />}
          />
          <Row
            title="Drop cached photos"
            description="Frees the image bytes in the list above. The photos stay in their run transcripts, and each message still names the file it carried."
            control={
              <LinkButton
                disabled={photoBytes === 0}
                onClick={() => {
                  const freed = dropCachedImages();
                  refreshCache();
                  notify(
                    freed > 0
                      ? `Freed ${formatBytes(freed)} of cached photos.`
                      : "No cached photos to drop.",
                    { tone: "info" },
                  );
                }}
              >
                {photoBytes > 0 ? `Free ${formatBytes(photoBytes)}` : "Nothing to free"}
              </LinkButton>
            }
          />
          <Row
            title="Clear the history list"
            description="Empties the local index only. Every run keeps its transcript on disk, and Mission Control still lists them."
            control={
              <LinkButton
                disabled={sizes.length === 0}
                onClick={() => {
                  const count = sizes.length;
                  clearStoredConversations();
                  refreshCache();
                  notify(`Cleared ${count} cached conversation${count === 1 ? "" : "s"}.`, {
                    tone: "info",
                  });
                }}
              >
                Clear
              </LinkButton>
            }
          />
        </Panel>
      </SettingBlock>

      {sizes.length > 0 && (
        <SettingBlock title="What is taking the room">
          <Panel>
            {shown.map((row) => (
              <Row
                key={row.id}
                title={row.title}
                description={`${relativeTime(row.updatedAt)} · ${row.messages} message${
                  row.messages === 1 ? "" : "s"
                }${row.imageBytes > 0 ? ` · ${formatBytes(row.imageBytes)} of photos` : ""}`}
                control={
                  <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <CodeText>{formatBytes(row.bytes)}</CodeText>
                    <LinkButton onClick={() => forget(row)}>Forget</LinkButton>
                  </div>
                }
              />
            ))}
            {sizes.length > shown.length && (
              <Row
                title="More conversations"
                description={`${sizes.length - shown.length} smaller thread${
                  sizes.length - shown.length === 1 ? "" : "s"
                } not listed.`}
                control={<GhostButton onClick={() => setExpanded(true)}>Show all</GhostButton>}
              />
            )}
          </Panel>
        </SettingBlock>
      )}

      <SettingBlock title="On disk">
        <Panel>
          {dirsError ? (
            <Row
              title="Could not measure Klide's folders"
              description={dirsError}
              control={null}
            />
          ) : dirs === null ? (
            <Row title="Measuring…" description="Walking Klide's app data folder." control={null} />
          ) : (
            dirs.map((dir) => (
              <Row
                key={dir.kind}
                title={dir.label}
                description={`${dir.detail} — ${dir.files} file${
                  dir.files === 1 ? "" : "s"
                }, ${formatBytes(dir.bytes)}.`}
                control={
                  <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
                    <span
                      title={dir.path}
                      style={{
                        color: "var(--fg-subtle)",
                        fontFamily: "var(--font-mono)",
                        fontSize: 11.5,
                        maxWidth: 260,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        direction: "rtl",
                        textAlign: "left",
                      }}
                    >
                      {dir.path}
                    </span>
                    <GhostButton
                      onClick={() => {
                        void revealStorageDir(dir.kind).catch((e) =>
                          notify(errMessage(e), { tone: "error" }),
                        );
                      }}
                    >
                      Reveal
                    </GhostButton>
                  </div>
                }
              />
            ))
          )}
        </Panel>
      </SettingBlock>
    </>
  );
}
