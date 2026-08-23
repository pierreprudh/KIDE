import { describe, expect, it } from "vitest";
import {
  MAX_DOC_CHARS,
  MAX_IMAGE_BYTES,
  MAX_STAGED,
  classifyFile,
  isPhotoAttachment,
  stageFiles,
  type StageableFile,
} from "./attachments";

function fake(name: string, type: string, body: string, size?: number): StageableFile {
  const bytes = new TextEncoder().encode(body);
  return {
    name,
    type,
    size: size ?? bytes.byteLength,
    text: async () => body,
    arrayBuffer: async () => bytes.buffer.slice(0) as ArrayBuffer,
  };
}

describe("classifyFile", () => {
  it("reads a photo from its MIME type", () => {
    expect(classifyFile({ name: "shot.png", type: "image/png" })).toBe("photo");
  });

  it("treats SVG as a document — it is markup a blind model can read", () => {
    expect(classifyFile({ name: "mark.svg", type: "image/svg+xml" })).toBe("document");
  });

  it("falls back to the extension when the browser gives no MIME", () => {
    expect(classifyFile({ name: "notes.md", type: "" })).toBe("document");
    expect(classifyFile({ name: "main.rs", type: "" })).toBe("document");
    expect(classifyFile({ name: ".gitignore", type: "" })).toBe("document");
  });

  it("refuses what Klide has no wire for", () => {
    expect(classifyFile({ name: "spec.pdf", type: "application/pdf" })).toBe("other");
    expect(classifyFile({ name: "bundle.zip", type: "application/zip" })).toBe("other");
  });
});

describe("stageFiles", () => {
  it("stages a photo as a data URI the chat can render", async () => {
    const { attachments, notices } = await stageFiles([fake("shot.png", "image/png", "PNGDATA")], {
      allowPhotos: true,
    });
    expect(notices).toEqual([]);
    expect(attachments).toHaveLength(1);
    expect(isPhotoAttachment(attachments[0])).toBe(true);
    expect(attachments[0].dataUri?.startsWith("data:image/png;base64,")).toBe(true);
    expect(attachments[0].mime).toBe("image/png");
  });

  it("stages a document as text, the same shape an @mention produces", async () => {
    const { attachments } = await stageFiles([fake("readme.md", "text/markdown", "# Hi")], {
      allowPhotos: true,
    });
    expect(isPhotoAttachment(attachments[0])).toBe(false);
    expect(attachments[0]).toMatchObject({ path: "readme.md", content: "# Hi" });
  });

  it("truncates an oversized document instead of dropping it", async () => {
    const long = "x".repeat(MAX_DOC_CHARS + 500);
    const { attachments } = await stageFiles([fake("log.txt", "text/plain", long)], {
      allowPhotos: true,
    });
    expect(attachments[0].content.length).toBeLessThan(long.length);
    expect(attachments[0].content.endsWith("…(truncated)")).toBe(true);
  });

  it("refuses a photo by name when the model is blind, and keeps the document", async () => {
    const { attachments, notices } = await stageFiles(
      [fake("shot.png", "image/png", "PNGDATA"), fake("notes.md", "text/markdown", "hi")],
      { allowPhotos: false },
    );
    expect(attachments.map((a) => a.path)).toEqual(["notes.md"]);
    expect(notices[0].text).toContain("shot.png");
    expect(notices[0].tone).toBe("warn");
  });

  it("refuses an unreadable kind by name", async () => {
    const { attachments, notices } = await stageFiles([fake("spec.pdf", "application/pdf", "%PDF")], {
      allowPhotos: true,
    });
    expect(attachments).toEqual([]);
    expect(notices[0].text).toContain("spec.pdf");
  });

  it("refuses an over-limit photo rather than sending a truncated one", async () => {
    const { attachments, notices } = await stageFiles(
      [fake("huge.png", "image/png", "PNGDATA", MAX_IMAGE_BYTES + 1)],
      { allowPhotos: true },
    );
    expect(attachments).toEqual([]);
    expect(notices[0].text).toContain("too large");
  });

  it("stops at the staged ceiling, counting what the composer already holds", async () => {
    const { attachments, notices } = await stageFiles(
      [fake("a.md", "text/markdown", "a"), fake("b.md", "text/markdown", "b")],
      { allowPhotos: true, alreadyStaged: MAX_STAGED - 1 },
    );
    expect(attachments).toHaveLength(1);
    expect(notices.some((n) => n.text.includes("1 more attachment"))).toBe(true);
  });

  it("says so when a drop is already full", async () => {
    const { attachments, notices } = await stageFiles([fake("a.md", "text/markdown", "a")], {
      allowPhotos: true,
      alreadyStaged: MAX_STAGED,
    });
    expect(attachments).toEqual([]);
    expect(notices[0].text).toContain(`${MAX_STAGED} attachments`);
  });
});
