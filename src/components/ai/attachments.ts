// Staging dropped/pasted files as turn attachments — the one place Klide
// decides what a photo or a document becomes on its way into a conversation.
//
// Two kinds land here, and they travel differently:
//
//  · a **photo** becomes a data-URI attachment the harness hands to a
//    vision-capable model, and the chat renders it as an image;
//  · a **document** becomes a text attachment — the same `{ path, content }`
//    shape an `@mention` produces — so it works on every model, blind or not.
//
// Anything else (a PDF, a zip, a binary) is refused by name rather than
// attached as garbage: Klide has no document wire yet, and folding raw bytes
// into the prompt would read as support that isn't there.
//
// Kept free of React, Tauri and the toast bus so both composers — the AI
// panel's and Focus's start stage — share one set of rules, and the rules
// stay testable.
import type { AgentAttachment as Attachment } from "../../agent/types";

/** Per-image ceiling, matching the harness's own per-image guard. */
export const MAX_IMAGE_BYTES = 6_000_000;
/** Per-document ceiling. Read whole, then truncated to MAX_DOC_CHARS. */
export const MAX_DOC_BYTES = 2_000_000;
/** Same text budget an `@mention` attachment gets. */
export const MAX_DOC_CHARS = 12_000;
/** How many files one drop/paste may stage at once. */
export const MAX_FILES_PER_DROP = 8;
/** How many attachments may sit staged on a composer. */
export const MAX_STAGED = 12;

/** Text-ish MIME types that carry no `text/` prefix. */
const TEXT_MIMES = new Set([
  "application/json",
  "application/xml",
  "application/javascript",
  "application/x-javascript",
  "application/typescript",
  "application/x-yaml",
  "application/yaml",
  "application/toml",
  "application/x-sh",
  "application/sql",
  "image/svg+xml", // markup a blind model can still read
]);

/** Extensions we treat as documents when the browser gives us no MIME at all
 *  (a common case for source files dragged from an editor or Finder). */
const TEXT_EXTENSIONS = new Set([
  "txt", "md", "markdown", "mdx", "rst", "org", "log",
  "json", "jsonc", "json5", "yaml", "yml", "toml", "ini", "cfg", "conf", "env",
  "csv", "tsv", "xml", "html", "htm", "css", "scss", "sass",
  "js", "jsx", "mjs", "cjs", "ts", "tsx", "rs", "go", "py", "rb", "php",
  "java", "kt", "kts", "swift", "c", "h", "cc", "cpp", "hpp", "cs",
  "sh", "bash", "zsh", "fish", "sql", "graphql", "gql", "lua", "vim",
  "dockerfile", "gitignore", "diff", "patch", "srt", "vtt",
]);

/** The file kinds a composer can stage. `"other"` is refused. */
export type AttachmentKind = "photo" | "document" | "other";

/** What a composer should say out loud after a staging attempt. Returned
 *  rather than raised so the caller owns the notification surface. */
export type StagingNotice = { text: string; tone: "warn" | "info" };

export type StagingResult = { attachments: Attachment[]; notices: StagingNotice[] };

/** Just the fields staging needs — so a test can hand over a plain object and
 *  a browser can hand over a real `File`. */
export type StageableFile = {
  name: string;
  type: string;
  size: number;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
};

function extensionOf(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name;
  // A dotfile (".gitignore") is all extension; a bare "Dockerfile" is its own.
  const dot = base.lastIndexOf(".");
  // A dotfile has no extension of its own — its name *is* the kind.
  if (dot <= 0) return base.replace(/^\./, "").toLowerCase();
  return base.slice(dot + 1).toLowerCase();
}

export function classifyFile(file: Pick<StageableFile, "name" | "type">): AttachmentKind {
  if (file.type.startsWith("image/") && file.type !== "image/svg+xml") return "photo";
  if (file.type.startsWith("text/") || TEXT_MIMES.has(file.type)) return "document";
  if (!file.type && TEXT_EXTENSIONS.has(extensionOf(file.name))) return "document";
  return "other";
}

/** True when this attachment is a photo rather than a document. The `dataUri`
 *  field is what the harness and the chat both key on. */
export function isPhotoAttachment(a: Attachment): boolean {
  return typeof a.dataUri === "string" && a.dataUri.length > 0;
}

function base64Of(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let binary = "";
  // Chunked so a multi-megabyte photo doesn't blow the argument limit.
  const CHUNK = 0x8000;
  for (let i = 0; i < view.length; i += CHUNK) {
    binary += String.fromCharCode(...view.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function humanSize(bytes: number): string {
  return bytes >= 1_000_000
    ? `${Math.round(bytes / 100_000) / 10} MB`
    : `${Math.max(1, Math.round(bytes / 1000))} KB`;
}

/**
 * Turn dropped/pasted files into staged attachments.
 *
 * `allowPhotos` is the vision gate: when the chosen model is blind, a photo is
 * refused by name instead of being sent somewhere it can't be seen. Documents
 * are never gated — text reaches every model.
 */
export async function stageFiles(
  files: readonly StageableFile[],
  opts: { allowPhotos: boolean; alreadyStaged?: number },
): Promise<StagingResult> {
  const notices: StagingNotice[] = [];
  const room = Math.max(0, MAX_STAGED - (opts.alreadyStaged ?? 0));
  if (files.length > 0 && room === 0) {
    return { attachments: [], notices: [{ text: `Already holding ${MAX_STAGED} attachments — send or remove some first.`, tone: "warn" }] };
  }
  const considered = files.slice(0, MAX_FILES_PER_DROP);
  if (files.length > considered.length) {
    notices.push({ text: `Taking the first ${MAX_FILES_PER_DROP} files — the rest were skipped.`, tone: "info" });
  }

  const staged: Attachment[] = [];
  for (const file of considered) {
    const name = file.name || "attachment";
    const kind = classifyFile(file);
    if (kind === "other") {
      notices.push({ text: `Klide can't read ${name} yet — attach an image or a text document.`, tone: "warn" });
      continue;
    }
    if (kind === "photo" && !opts.allowPhotos) {
      notices.push({ text: `This model can't see images — ${name} wasn't attached.`, tone: "warn" });
      continue;
    }
    const limit = kind === "photo" ? MAX_IMAGE_BYTES : MAX_DOC_BYTES;
    if (file.size > limit) {
      notices.push({ text: `${name} is too large to attach (max ${humanSize(limit)}).`, tone: "warn" });
      continue;
    }
    try {
      if (kind === "photo") {
        const mime = file.type || "image/png";
        const dataUri = `data:${mime};base64,${base64Of(await file.arrayBuffer())}`;
        staged.push({ path: name, content: "", mime, dataUri });
      } else {
        let content = await file.text();
        if (content.length > MAX_DOC_CHARS) content = content.slice(0, MAX_DOC_CHARS) + "\n…(truncated)";
        // `mime` is the image lane's field by contract (see AgentAttachment) —
        // a document is identified by carrying no dataUri, so leave it unset.
        staged.push({ path: name, content });
      }
    } catch {
      notices.push({ text: `Couldn't read ${name}.`, tone: "warn" });
    }
  }

  if (staged.length > room) {
    notices.push({ text: `Only ${room} more attachment${room === 1 ? "" : "s"} fit on this turn.`, tone: "info" });
  }
  return { attachments: staged.slice(0, room), notices };
}
