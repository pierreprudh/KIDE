// File extension → Monaco language id.
//
// The same 13-entry table existed twice, byte-identical apart from where the
// `?? ""` sat, in `App.tsx` and `ArtifactInspector.tsx`. Both feed the same
// Monaco instance, so a language added to one and not the other means the same
// file is highlighted in one surface and plain in the other.

const BY_EXTENSION: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  rs: "rust",
  py: "python",
  json: "json",
  md: "markdown",
  html: "html",
  css: "css",
  // Monaco has no TOML mode; `ini` is the closest thing that highlights
  // `key = value` and `[section]` correctly.
  toml: "ini",
  yml: "yaml",
  yaml: "yaml",
};

/** Monaco language id for a path, or `"plaintext"` when the extension is
 *  unknown or absent. */
export function detectLanguage(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return BY_EXTENSION[ext] ?? "plaintext";
}
