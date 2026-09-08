import { describe, expect, it } from "vitest";
import { artifactActionLabel, artifactOpensIn, artifactPreview } from "./artifacts";

describe("where a produced document opens", () => {
  it.each(["notes.md", "report.MD", "data.csv", "index.html", "src/gen/types.ts"])(
    "reads %s in the inspector",
    (path) => expect(artifactOpensIn(path)).toBe("inspector"),
  );

  it.each(["decks/Q3.pptx", "brief.docx", "report.pdf", "budget.xlsx", "chart.png", "bundle.zip"])(
    "hands %s to the app that owns it",
    (path) => expect(artifactOpensIn(path)).toBe("system"),
  );

  it("treats an unknown or missing extension as a binary", () => {
    // Monaco showing a binary is the failure this list exists to prevent, so
    // the unknown case leaves the app rather than guessing.
    expect(artifactOpensIn("build/output")).toBe("system");
    expect(artifactOpensIn("archive.tar.zst")).toBe("system");
  });

  it("does not read a dotfile's name as its extension", () => {
    expect(artifactOpensIn(".env")).toBe("system");
    expect(artifactOpensIn("config/.gitignore")).toBe("system");
  });

  it("says which of the two things the row will do", () => {
    expect(artifactActionLabel("decks/Q3 review.pptx")).toBe("Open Q3 review.pptx in its app");
    expect(artifactActionLabel("notes/summary.md")).toBe("Read summary.md");
  });

  it.each(["decks/Q3.pptx", "brief.docx", "report.pdf", "budget.xlsx"])(
    "asks Quick Look to picture %s",
    (path) => expect(artifactPreview(path)).toBe("quicklook"),
  );
  it("draws a picture itself when the document is one", () => {
    expect(artifactPreview("chart.png")).toBe("image");
  });
  it("does not picture what the inspector will show as text", () => {
    expect(artifactPreview("notes.md")).toBe("none");
    expect(artifactPreview("data.csv")).toBe("none");
  });
});
