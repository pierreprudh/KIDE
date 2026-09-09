import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DocumentViewer } from "./DocumentViewer";

const documents = [
  { path: "q3-demo/deck.pptx", bytes: 28_625 },
  { path: "q3-demo/summary.docx", bytes: 3_796 },
];
const render = (path: string, docs = documents, placeholder?: (path: string) => string | null) => renderToStaticMarkup(
  <DocumentViewer documents={docs} path={path} load={async () => null} placeholder={placeholder}
    onOpenExternal={() => {}} onClose={() => {}} />,
);

describe("DocumentViewer", () => {
  it("names the document it opened on, with its folder and its size", () => {
    const html = render("q3-demo/deck.pptx");
    expect(html).toContain("deck.pptx");
    expect(html).toContain("q3-demo");
    expect(html).toContain("29 KB");
  });

  it("rails the whole set and marks the one being read", () => {
    const html = render("q3-demo/summary.docx");
    expect(html).toContain("Documents from this run");
    expect(html).toContain("deck.pptx");
    // aria-current on the active entry, so the rail is navigable by more than
    // the border colour.
    expect(html).toMatch(/aria-current="true"[^>]*>(?:(?!<\/button>).)*summary\.docx/s);
  });

  it("keeps a way out to the application that owns the file", () => {
    expect(render("q3-demo/deck.pptx")).toContain("Open in app");
  });

  it("drops the rail when the run produced one document", () => {
    const html = render("q3-demo/deck.pptx", [documents[0]]);
    expect(html).not.toContain("Documents from this run");
    expect(html).toContain("deck.pptx");
  });

  it("says the picture is coming rather than showing an empty sheet", () => {
    // The load promise has not resolved in a static render — the reader is
    // told, instead of being given a blank canvas that looks broken.
    expect(render("q3-demo/deck.pptx")).toContain("Drawing the preview…");
  });

  it("opens on the picture the host already has, and marks it provisional until the sharp one lands", () => {
    // The card drew this deck at 900 px a click ago. Quick Look takes ~200 ms
    // for the 1800 px one, so the canvas shows the picture it has rather than
    // an empty sheet, and swaps in place when the large one arrives.
    const html = render("q3-demo/deck.pptx", documents, (path) => path.endsWith("deck.pptx") ? "data:image/png;base64,c21hbGw=" : null);
    expect(html).toContain('src="data:image/png;base64,c21hbGw="');
    expect(html).toContain('data-provisional="1"');
    expect(html).not.toContain("Drawing the preview…");
  });

  it("says the picture is coming when the host has none to stand in", () => {
    expect(render("q3-demo/summary.docx", documents, () => null)).toContain("Drawing the preview…");
  });
});
