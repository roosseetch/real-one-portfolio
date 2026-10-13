import { describe, expect, it } from "vitest";

import { docFromRecord } from "./editor-doc";
import { renderRich } from "./rich";
import type { RichDoc } from "./rich-doc";

const noFigure = () => null;

describe("renderRich", () => {
  it("draws the article in the Markdown article's classes", () => {
    const doc: RichDoc = {
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 2, textAlign: "center" }, content: [{ type: "text", text: "Section" }] },
        { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "one" }] }] }] },
        { type: "blockquote", content: [{ type: "paragraph", content: [{ type: "text", text: "Quoted" }] }] },
        { type: "horizontalRule" },
      ],
    };
    const root = renderRich(doc, noFigure);

    expect(root.className).toBe("prose prose-rich");
    const heading = root.querySelector("h2.prose-h2") as HTMLElement;
    expect(heading.textContent).toBe("Section");
    expect(heading.style.textAlign).toBe("center");
    expect(root.querySelector("ul.prose-list")?.getAttribute("role")).toBe("list");
    expect(root.querySelector("blockquote.prose-quote p")?.textContent).toBe("Quoted");
    expect(root.querySelector("hr.prose-break")).not.toBeNull();
  });

  it("nests marks, sets a hosted family through its stack, and never parses text as HTML", () => {
    const doc: RichDoc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "<img src=x onerror=alert(1)>",
              marks: [{ type: "bold" }, { type: "textStyle", attrs: { fontFamily: "Source Serif 4", fontSize: "1.25em" } }],
            },
            { type: "text", text: "link", marks: [{ type: "link", attrs: { href: "https://example.com/" } }] },
          ],
        },
      ],
    };
    const root = renderRich(doc, noFigure);

    expect(root.querySelector("img")).toBeNull();
    const span = root.querySelector("strong > span") as HTMLElement;
    expect(span.textContent).toBe("<img src=x onerror=alert(1)>");
    expect(span.style.fontFamily).toContain("Source Serif 4");
    expect(span.style.fontSize).toBe("1.25em");
    const link = root.querySelector("a") as HTMLAnchorElement;
    expect(link.href).toBe("https://example.com/");
    expect(link.rel).toBe("noopener nofollow");
  });

  it("puts a section heading's eyebrow above it, as a Markdown article does", () => {
    const doc: RichDoc = {
      type: "doc",
      content: [{ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Workshop 1: Closing the gaps" }] }],
    };
    const heading = renderRich(doc, noFigure).querySelector("h2")!;
    expect(heading.querySelector(".prose-eyebrow")?.textContent).toBe("Workshop 1");
    expect(heading.textContent).toBe("Workshop 1 Closing the gaps");
  });

  it("hands a figure to the caller to build", () => {
    const doc: RichDoc = { type: "doc", content: [{ type: "figure", attrs: { src: "https://media.test/x.webp", alt: "A", caption: null } }] };
    const seen: unknown[] = [];
    renderRich(doc, (...args) => {
      seen.push(args);
      return document.createElement("figure");
    });
    expect(seen).toEqual([["https://media.test/x.webp", "A", null]]);
  });
});

describe("docFromRecord", () => {
  const picture = (n: number) => ({ type: "image" as const, src: `https://media.test/m/${n}-800.webp`, alt: `Picture ${n}`, caption: null });

  it("turns a plain note into paragraphs, and puts its pictures after the text", () => {
    const doc = docFromRecord({
      id: "r",
      title: "t",
      body: "First paragraph\nsame paragraph\n\nSecond",
      media: [picture(1), { type: "video", src: "https://media.test/m/v.mp4" }],
    });
    expect(doc.content.map((node) => node.type)).toEqual(["paragraph", "paragraph", "figure"]);
    expect(doc.content[0].content?.map((node) => node.type)).toEqual(["text", "hardBreak", "text"]);
    expect(doc.content[2].attrs?.src).toBe("https://media.test/m/1-800.webp");
  });

  it("turns a Markdown article into blocks, keeping a figure where the text placed it", () => {
    const doc = docFromRecord({
      id: "r",
      title: "t",
      bodyFormat: "markdown",
      body: "## Workshop 1: Closing gaps\n\nSome **bold** text.\n\n![The room](media:1)\n\n- one\n- two\n\n> Quoted\n\n---",
      media: [picture(0), picture(1)],
    });
    expect(doc.content.map((node) => node.type)).toEqual([
      "heading",
      "paragraph",
      "figure",
      "bulletList",
      "blockquote",
      "horizontalRule",
      "figure",
    ]);
    expect(doc.content[0].content?.[0].text).toBe("Workshop 1: ");
    expect(doc.content[1].content?.[1]).toEqual({ type: "text", text: "bold", marks: [{ type: "bold" }] });
    expect(doc.content[2].attrs).toEqual({ src: "https://media.test/m/1-800.webp", alt: "The room", caption: null });
    // The picture the text did not place still ends up in the article.
    expect(doc.content[6].attrs?.src).toBe("https://media.test/m/0-800.webp");
  });
});
