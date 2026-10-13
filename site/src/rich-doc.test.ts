import { describe, expect, it } from "vitest";

import { cleanDoc, docFigures, docLead, docParagraphs, type RichDoc } from "./rich-doc";

const MEDIA = "https://media.test/media/activity-aaaaaaaaaaaaaaaa/";
const allow = { allowSrc: (src: string) => src.startsWith(MEDIA) };

const text = (value: string, marks?: unknown[]) => (marks ? { type: "text", text: value, marks } : { type: "text", text: value });
const doc = (...content: unknown[]) => ({ type: "doc", content });
const p = (...content: unknown[]) => ({ type: "paragraph", content });

describe("cleanDoc", () => {
  it("keeps everything the toolbar can make", () => {
    const input = doc(
      { type: "heading", attrs: { level: 2, textAlign: "center" }, content: [text("A section")] },
      p(
        text("Bold", [{ type: "bold" }]),
        text(" and "),
        text("a link", [{ type: "link", attrs: { href: "https://example.com", target: "_blank", rel: "x", class: null } }]),
        { type: "hardBreak" },
        text("in Playfair", [{ type: "textStyle", attrs: { fontFamily: "Playfair Display", fontSize: "1.25em" } }]),
      ),
      { type: "bulletList", content: [{ type: "listItem", content: [p(text("one"))] }] },
      { type: "orderedList", attrs: { start: 3, type: null }, content: [{ type: "listItem", content: [p(text("three"))] }] },
      { type: "blockquote", content: [p(text("Quoted"))] },
      { type: "horizontalRule" },
      { type: "figure", attrs: { src: `${MEDIA}x-1200.webp`, alt: " A room ", caption: "", upload: null } },
    );

    const result = cleanDoc(input, allow);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // What the editor adds that the page does not draw is dropped on the way.
    expect(result.doc.content[1].content?.[2].marks).toEqual([{ type: "link", attrs: { href: "https://example.com" } }]);
    expect(result.doc.content[3].attrs).toEqual({ start: 3 });
    expect(result.doc.content[6].attrs).toEqual({ src: `${MEDIA}x-1200.webp`, alt: "A room", caption: null });
  });

  it("drops the empty paragraph the editor keeps at the end", () => {
    const result = cleanDoc(doc(p(text("Last words")), { type: "paragraph" }, { type: "paragraph" }), allow);
    expect(result.ok && result.doc.content).toEqual([p(text("Last words"))]);
  });

  it("keeps only the alignments that change anything", () => {
    const result = cleanDoc(doc({ type: "paragraph", attrs: { textAlign: "left" }, content: [text("x")] }), allow);
    expect(result.ok && result.doc.content[0]).toEqual(p(text("x")));
  });

  it.each([
    ["a script link", doc(p(text("x", [{ type: "link", attrs: { href: "javascript:alert(1)" } }])))],
    ["a font the site does not host", doc(p(text("x", [{ type: "textStyle", attrs: { fontFamily: "Comic Sans MS" } }])))],
    ["a free font size", doc(p(text("x", [{ type: "textStyle", attrs: { fontSize: "72px" } }])))],
    ["an unknown mark", doc(p(text("x", [{ type: "highlight" }])))],
    ["an unknown node", doc({ type: "codeBlock", content: [text("x")] })],
    ["raw HTML", doc({ type: "html", text: "<script>" })],
    ["a heading level 1", doc({ type: "heading", attrs: { level: 1 }, content: [text("x")] })],
    ["a picture from another host", doc({ type: "figure", attrs: { src: "https://evil.example/x.webp" } })],
    ["a picture still uploading", doc({ type: "figure", attrs: { src: null, upload: "abc" } })],
    ["a picture whose address breaks out of an attribute", doc({ type: "figure", attrs: { src: `${MEDIA}x" onerror="y` } })],
    ["a picture where only text may go", doc(p({ type: "figure", attrs: { src: `${MEDIA}x.webp` } }))],
    ["not a document", { type: "paragraph" }],
  ])("refuses %s", (_, input) => {
    expect(cleanDoc(input, allow).ok).toBe(false);
  });

  it("refuses a document nested past the limit", () => {
    let node: Record<string, unknown> = p(text("deep"));
    for (let i = 0; i < 20; i++) node = { type: "blockquote", content: [node] };
    expect(cleanDoc(doc(node), allow).ok).toBe(false);
  });

  it("refuses a document past the size ceiling", () => {
    expect(cleanDoc(doc(p(text("x".repeat(600 * 1024)))), allow).ok).toBe(false);
  });
});

describe("the plain-text forms", () => {
  const sample: RichDoc = {
    type: "doc",
    content: [
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Workshop 1" }] },
      { type: "paragraph", content: [{ type: "text", text: "First line" }, { type: "hardBreak" }, { type: "text", text: "second" }] },
      {
        type: "orderedList",
        attrs: { start: 2 },
        content: [
          { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Two" }] }] },
          { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Three" }] }] },
        ],
      },
      { type: "figure", attrs: { src: `${MEDIA}a-800.webp`, alt: "A", caption: null } },
    ],
  };

  it("reads the text in order, with list markers", () => {
    expect(docParagraphs(sample)).toEqual(["Workshop 1", "First line\nsecond", "2. Two", "3. Three"]);
  });

  it("cuts the lead at a whole paragraph", () => {
    expect(docLead(sample, 30)).toBe("Workshop 1\n\nFirst line\nsecond");
    expect(docLead(sample, 5)).toBe("Work…");
  });

  it("lists the pictures the text places", () => {
    expect(docFigures(sample)).toEqual([{ src: `${MEDIA}a-800.webp`, alt: "A", caption: null }]);
  });
});
