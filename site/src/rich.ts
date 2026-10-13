/**
 * Draws an article written on the site's editor (rich-doc.ts) as the article
 * page shows it.
 *
 * The same `.prose` element and the same classes prose.ts builds for a Markdown
 * article, so the two read as one design: Fraunces headings, the drop cap, the
 * hairline breaks and the pull quotes come from the stylesheet either way.
 *
 * Nothing here parses HTML. Every node is made with createElement and every
 * word lands through a text node, and the two style properties set — a family
 * and a size — are looked up from rich-doc.ts's lists rather than copied from
 * the document. A document is cleaned with `cleanDoc` before it gets here, so
 * an unknown node is already gone; the `default` branches are for the editor's
 * preview, which draws whatever the editor holds at that moment.
 */
import { FONT_STACKS, type ArticleFont, type DocMark, type DocNode, type RichDoc } from "./rich-doc";

function node(tag: string, className?: string): HTMLElement {
  const element = document.createElement(tag);
  if (className) element.className = className;
  return element;
}

/** Wraps a run of text in its marks, innermost first in the order the editor lists them. */
function marked(text: string, marks: DocMark[] | undefined): Node {
  let current: Node = document.createTextNode(text);
  for (const mark of [...(marks ?? [])].reverse()) {
    let wrapper: HTMLElement;
    switch (mark.type) {
      case "bold":
        wrapper = node("strong");
        break;
      case "italic":
        wrapper = node("em");
        break;
      case "underline":
        wrapper = node("u");
        break;
      case "strike":
        wrapper = node("s");
        break;
      case "link": {
        const link = node("a") as HTMLAnchorElement;
        link.href = mark.attrs?.href ?? "#";
        link.rel = "noopener nofollow";
        wrapper = link;
        break;
      }
      case "textStyle": {
        wrapper = node("span");
        const family = mark.attrs?.fontFamily as ArticleFont | undefined;
        if (family && FONT_STACKS[family]) wrapper.style.fontFamily = FONT_STACKS[family];
        if (mark.attrs?.fontSize) wrapper.style.fontSize = mark.attrs.fontSize;
        break;
      }
      default:
        continue;
    }
    wrapper.append(current);
    current = wrapper;
  }
  return current;
}

function inline(parent: HTMLElement, content: DocNode[] | undefined): HTMLElement {
  for (const child of content ?? []) {
    if (child.type === "text" && child.text) parent.append(marked(child.text, child.marks));
    else if (child.type === "hardBreak") parent.append(node("br"));
  }
  return parent;
}

function aligned(element: HTMLElement, attrs: Record<string, unknown> | undefined): HTMLElement {
  const align = attrs?.textAlign;
  if (align === "center" || align === "right") element.style.textAlign = align;
  return element;
}

/** The Markdown article's rule (prose.ts): "Workshop 1: Title" puts "Workshop 1" above the title. */
const EYEBROW = /^([^:]{1,20}): +(\S.*)$/;

/**
 * A section heading, with its eyebrow split off when the first run of plain
 * text starts with one — so an article converted from Markdown reads exactly as
 * it did, and a new one gets the same label for the same shape of heading.
 */
function sectionHeading(item: DocNode): HTMLElement {
  const heading = node("h2", "prose-h2");
  const [first, ...rest] = item.content ?? [];
  const split = first?.type === "text" && !first.marks?.length ? EYEBROW.exec(first.text ?? "") : null;
  if (!split) return inline(heading, item.content);

  // Its own line above the title, and still part of the heading, so a screen
  // reader's outline reads "Workshop 1 Closing the …".
  heading.append(Object.assign(node("span", "prose-eyebrow"), { textContent: split[1] }), document.createTextNode(" "));
  return inline(heading, [{ type: "text", text: split[2] }, ...rest]);
}

export type FigureBuilder = (src: string, alt: string | null, caption: string | null) => HTMLElement | null;

function block(item: DocNode, figure: FigureBuilder): HTMLElement | null {
  switch (item.type) {
    case "paragraph":
      return aligned(inline(node("p"), item.content), item.attrs);
    case "heading": {
      const level = item.attrs?.level === 3 || item.attrs?.level === 4 ? item.attrs.level : 2;
      if (level === 2) return aligned(sectionHeading(item), item.attrs);
      return aligned(inline(node(`h${level}`, `prose-h${level}`), item.content), item.attrs);
    }
    case "bulletList":
    case "orderedList": {
      const list = node(item.type === "orderedList" ? "ol" : "ul", "prose-list");
      // Safari stops announcing a list once its markers are styled away.
      list.setAttribute("role", "list");
      const start = item.attrs?.start;
      if (typeof start === "number" && start > 1) {
        list.setAttribute("start", String(start));
        list.style.counterReset = `prose-item ${start - 1}`;
      }
      for (const entry of item.content ?? []) {
        const li = node("li");
        for (const child of entry.content ?? []) {
          // A list item's first paragraph is its text; a <p> inside an <li>
          // would add the paragraph spacing between every item.
          if (child.type === "paragraph") {
            if (li.childNodes.length > 0) li.append(node("br"));
            inline(li, child.content);
          } else {
            const nested = block(child, figure);
            if (nested) li.append(nested);
          }
        }
        list.append(li);
      }
      return list;
    }
    case "blockquote": {
      const quote = node("blockquote", "prose-quote");
      for (const child of item.content ?? []) {
        const built = block(child, figure);
        if (built) quote.append(built);
      }
      return quote;
    }
    case "horizontalRule":
      return node("hr", "prose-break");
    case "figure": {
      const src = item.attrs?.src;
      if (typeof src !== "string") return null;
      return figure(src, (item.attrs?.alt as string | null) ?? null, (item.attrs?.caption as string | null) ?? null);
    }
    default:
      return null;
  }
}

/** The article, as one `.prose` element. `figure` builds a picture, or returns null to leave it out. */
export function renderRich(doc: RichDoc, figure: FigureBuilder): HTMLElement {
  // `prose-rich` on top of the Markdown article's classes: the one place Bold
  // means weight (Lora has its 700 face for this), and a link looks like one.
  const root = node("div", "prose prose-rich");
  for (const item of doc.content) {
    const built = block(item, figure);
    if (built) root.append(built);
  }
  return root;
}
