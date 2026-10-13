/**
 * The Markdown subset an article is written in. What it recognises is in the
 * header of prose.ts; what matters as much is what it does not — anything else
 * is text, shown as written, and no body can put markup on the page.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { parseInline, parseProse, placedMedia, proseParagraphs, renderProse } from "./prose";

const render = (body: string, figure = () => null as HTMLElement | null) => {
  const root = renderProse(parseProse(body), figure);
  document.body.replaceChildren(root);
  return root;
};

beforeEach(() => {
  document.body.replaceChildren();
});

describe("emphasis inside a line", () => {
  it("reads strong and em, in order", () => {
    expect(parseInline("a **b** c *d* e")).toEqual([
      { kind: "text", text: "a " },
      { kind: "strong", text: "b" },
      { kind: "text", text: " c " },
      { kind: "em", text: "d" },
      { kind: "text", text: " e" },
    ]);
  });

  it("leaves an asterisk with nothing to pair with as an asterisk", () => {
    expect(parseInline("five * stars")).toEqual([{ kind: "text", text: "five * stars" }]);
  });

  it("is not fooled by spaced asterisks", () => {
    expect(parseInline("3 * 4 * 5")).toEqual([{ kind: "text", text: "3 * 4 * 5" }]);
  });
});

describe("the blocks of an article", () => {
  it("makes sections, subsections and paragraphs", () => {
    const root = render("## Findings\n\n### First\n\n#### 1. A point\n\nOne paragraph\nwrapped.\n\nAnother.");

    expect(root.querySelector("h2")?.textContent).toBe("Findings");
    expect(root.querySelector("h3")?.textContent).toBe("First");
    expect(root.querySelector("h4")?.textContent).toBe("1. A point");
    expect([...root.querySelectorAll("p")].map((p) => p.textContent)).toEqual(["One paragraph\nwrapped.", "Another."]);
  });

  /** "Workshop 1" over the title, and still inside the heading the outline reads. */
  it("lifts a short prefix off a section heading as its eyebrow", () => {
    const heading = render("## Workshop 1: Closing the Gaps").querySelector("h2");

    expect(heading?.querySelector(".prose-eyebrow")?.textContent).toBe("Workshop 1");
    expect(heading?.textContent).toBe("Workshop 1 Closing the Gaps");
  });

  it("keeps a colon further in as part of the title", () => {
    const heading = render("## What three long days in Barcelona taught us: a summary").querySelector("h2");

    expect(heading?.querySelector(".prose-eyebrow")).toBeNull();
  });

  it("sets an all-italic line under a section heading as its deck", () => {
    const root = render("## Workshop 2: AI\n\n*Reimagining how trials are run*\n\n*Just emphasis.*");
    const paragraphs = [...root.querySelectorAll("p")];

    expect(paragraphs[0].className).toBe("prose-deck");
    expect(paragraphs[1].className).toBe("");
  });

  it("makes bulleted and numbered lists, one line per item", () => {
    const root = render("- one\n- two\n\n1. first\n2. second");

    expect([...root.querySelectorAll("ul li")].map((li) => li.textContent)).toEqual(["one", "two"]);
    expect([...root.querySelectorAll("ol li")].map((li) => li.textContent)).toEqual(["first", "second"]);
  });

  it("flows a list of short items into columns, and not a list of long ones", () => {
    const root = render(`- Cost\n- Timing\n\n- ${"a long item ".repeat(5)}\n- short`);
    const [short, long] = [...root.querySelectorAll("ul")];

    expect(short.classList.contains("prose-list--short")).toBe(true);
    expect(long.classList.contains("prose-list--short")).toBe(false);
  });

  it("joins consecutive quoted lines into one pull quote", () => {
    const root = render("> Technology alone\n> will not do it.");

    expect(root.querySelectorAll("blockquote")).toHaveLength(1);
    expect(root.querySelector("blockquote p")?.textContent).toBe("Technology alone\nwill not do it.");
  });

  it("ends a paragraph where a list starts, blank line or not", () => {
    const root = render("Polling results:\n- Agentic AI: 8 votes");

    expect(root.querySelector("p")?.textContent).toBe("Polling results:");
    expect(root.querySelector("li")?.textContent).toBe("Agentic AI: 8 votes");
  });

  it("draws a section break", () => {
    expect(render("Before\n\n---\n\nAfter").querySelector("hr.prose-break")).not.toBeNull();
  });

  it("asks the caller for a figure, and drops one the record does not have", () => {
    const asked: Array<[number, string]> = [];
    const root = render("![The infographic](media:0)\n\n![Missing](media:4)", ((index: number, alt: string) => {
      asked.push([index, alt]);
      return index === 0 ? document.createElement("figure") : null;
    }) as never);

    expect(asked).toEqual([
      [0, "The infographic"],
      [4, "Missing"],
    ]);
    expect(root.querySelectorAll("figure")).toHaveLength(1);
  });

  /** Built with textContent throughout: a body is words, never markup. */
  it("shows markup in the body as text", () => {
    const root = render("<script>alert(1)</script>\n\n## <img src=x onerror=alert(1)>\n\n- **<b>bold</b>**");

    expect(root.querySelector("script, img, b")).toBeNull();
    expect(root.querySelector("p")?.textContent).toBe("<script>alert(1)</script>");
  });

  it("shows a line it does not recognise as written", () => {
    expect(render("#hashtag and +plus").querySelector("p")?.textContent).toBe("#hashtag and +plus");
  });
});

describe("what other views take from an article", () => {
  it("gives an excerpt the paragraphs, without markup, headings or lists", () => {
    expect(proseParagraphs("## Title\n\nThe **first** words.\n\n- a list\n\n> a quote\n\nMore *here*.")).toEqual([
      "The first words.",
      "More here.",
    ]);
  });

  it("names the media the text places itself", () => {
    expect([...placedMedia("![a](media:0)\n\ntext\n\n![b](media:2)")]).toEqual([0, 2]);
  });
});
