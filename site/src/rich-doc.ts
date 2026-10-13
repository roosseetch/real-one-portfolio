/**
 * The document an article written on the site's editor is stored as, and the
 * one check that decides whether a document is one.
 *
 * It is the editor's own JSON (Tiptap's ProseMirror shape) cut down to what the
 * article page has a design for. Storing the editor's shape rather than
 * converting it means an article reopened for an update comes back exactly as it
 * was saved; cutting it down means a document that names anything else — a node
 * the page cannot draw, a link to `javascript:`, a font the site does not host,
 * a picture on somebody else's server — is refused rather than half-shown.
 *
 * Two readers, and this is why it is import-free and DOM-free. The Worker runs
 * `cleanDoc` on every publish, so nothing reaches the content bucket that this
 * file would not accept; the site runs it again before drawing, so a document
 * that got there some other way is still drawn only from what is listed here.
 * The Worker imports this file from site/ (deploy-worker.yml triggers on it),
 * because the format is the site's: it is what the article page can show.
 */

/** Families the font picker offers. Each must have its faces in fonts.ts. */
export const ARTICLE_FONTS = [
  "Fraunces",
  "Cormorant Garamond",
  "Lora",
  "Playfair Display",
  "Source Serif 4",
  "Inter",
] as const;
export type ArticleFont = (typeof ARTICLE_FONTS)[number];

/** The stack each family is set in, so a slow font file still lands in something close. */
export const FONT_STACKS: Record<ArticleFont, string> = {
  Fraunces: '"Fraunces", "Cormorant Garamond", Georgia, serif',
  "Cormorant Garamond": '"Cormorant Garamond", Georgia, serif',
  Lora: '"Lora", Georgia, serif',
  "Playfair Display": '"Playfair Display", Georgia, serif',
  "Source Serif 4": '"Source Serif 4", Georgia, serif',
  Inter: '"Inter", "Helvetica Neue", Arial, sans-serif',
};

/** Text sizes, relative to the paragraph they sit in. Three steps rather than a free value. */
export const FONT_SIZES = { small: "0.875em", large: "1.25em", larger: "1.5em" } as const;
const SIZE_VALUES = new Set<string>(Object.values(FONT_SIZES));

const ALIGNMENTS = new Set(["left", "center", "right", "justify"]);

export interface DocMark {
  type: "bold" | "italic" | "underline" | "strike" | "link" | "textStyle";
  attrs?: { href?: string; fontFamily?: string | null; fontSize?: string | null };
}

export interface DocNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: DocNode[];
  marks?: DocMark[];
  text?: string;
}

export interface RichDoc {
  type: "doc";
  content: DocNode[];
}

/** Serialised size ceiling. The longest article so far is 29k characters of Markdown. */
export const MAX_DOC_BYTES = 512 * 1024;
const MAX_NODES = 20_000;
const MAX_DEPTH = 12;

/** Which children each container may hold. Anything not a key here is a leaf or not allowed. */
const CHILDREN: Record<string, ReadonlySet<string>> = {
  doc: new Set(["paragraph", "heading", "bulletList", "orderedList", "blockquote", "horizontalRule", "figure"]),
  paragraph: new Set(["text", "hardBreak"]),
  heading: new Set(["text", "hardBreak"]),
  bulletList: new Set(["listItem"]),
  orderedList: new Set(["listItem"]),
  listItem: new Set(["paragraph", "bulletList", "orderedList"]),
  blockquote: new Set(["paragraph"]),
};

export type CleanResult = { ok: true; doc: RichDoc } | { ok: false; problem: string };

export interface CleanOptions {
  /**
   * Whether a picture's `src` may appear. The Worker allows the media folder
   * the editor uploads into and the pictures the article already had, so a
   * document cannot borrow one from another article, let alone another host;
   * the site allows its own media bucket.
   */
  allowSrc: (src: string) => boolean;
}

function isSafeHref(href: unknown): href is string {
  if (typeof href !== "string" || href.length > 2048) return false;
  try {
    const url = new URL(href);
    return url.protocol === "https:" || url.protocol === "http:" || url.protocol === "mailto:";
  } catch {
    return false;
  }
}

function cleanMarks(marks: unknown): DocMark[] | null | "bad" {
  if (marks === undefined) return null;
  if (!Array.isArray(marks)) return "bad";
  const kept: DocMark[] = [];
  for (const mark of marks as Array<{ type?: unknown; attrs?: Record<string, unknown> }>) {
    switch (mark?.type) {
      case "bold":
      case "italic":
      case "underline":
      case "strike":
        kept.push({ type: mark.type });
        break;
      case "link":
        if (!isSafeHref(mark.attrs?.href)) return "bad";
        kept.push({ type: "link", attrs: { href: mark.attrs!.href as string } });
        break;
      case "textStyle": {
        const family = mark.attrs?.fontFamily ?? null;
        const size = mark.attrs?.fontSize ?? null;
        if (family !== null && !(ARTICLE_FONTS as readonly unknown[]).includes(family)) return "bad";
        if (size !== null && !SIZE_VALUES.has(size as string)) return "bad";
        // An empty textStyle is what the editor leaves behind after a font is
        // unset; it means nothing, so it is dropped rather than refused.
        if (family === null && size === null) break;
        kept.push({
          type: "textStyle",
          attrs: { ...(family ? { fontFamily: family as string } : {}), ...(size ? { fontSize: size as string } : {}) },
        });
        break;
      }
      default:
        return "bad";
    }
  }
  return kept.length > 0 ? kept : null;
}

/**
 * The document rebuilt from only what is allowed, or the first thing that is not.
 *
 * Rebuilt rather than checked in place: attributes the editor adds that this
 * does not know about (a link's `target`, a paragraph's empty `textAlign`) are
 * dropped on the way through, so what is stored is exactly what is drawn.
 */
export function cleanDoc(input: unknown, options: CleanOptions): CleanResult {
  let nodes = 0;

  const fail = (problem: string): never => {
    throw new Error(problem);
  };

  const walk = (raw: unknown, allowed: ReadonlySet<string>, depth: number): DocNode => {
    if (++nodes > MAX_NODES) fail("the document is too long");
    if (depth > MAX_DEPTH) fail("the document is nested too deeply");
    if (typeof raw !== "object" || raw === null) fail("a node is not an object");
    const node = raw as DocNode;
    if (typeof node.type !== "string" || !allowed.has(node.type)) fail(`"${String(node.type)}" is not allowed here`);

    switch (node.type) {
      case "text": {
        if (typeof node.text !== "string" || node.text === "") fail("a text node has no text");
        const marks = cleanMarks(node.marks);
        if (marks === "bad") throw new Error("a mark is not allowed");
        return marks ? { type: "text", text: node.text, marks } : { type: "text", text: node.text };
      }
      case "hardBreak":
      case "horizontalRule":
        return { type: node.type };
      case "figure": {
        const src = node.attrs?.src;
        if (typeof src !== "string" || /[\s"'<>\\]/.test(src) || !options.allowSrc(src)) {
          fail("a picture is not one uploaded for this article");
        }
        const text = (value: unknown, max: number) =>
          typeof value === "string" && value.trim() !== "" ? value.trim().slice(0, max) : null;
        return {
          type: "figure",
          attrs: { src, alt: text(node.attrs?.alt, 500), caption: text(node.attrs?.caption, 500) },
        };
      }
    }

    const attrs: Record<string, unknown> = {};
    if (node.type === "heading") {
      const level = node.attrs?.level;
      if (level !== 2 && level !== 3 && level !== 4) fail("headings are levels 2 to 4");
      attrs.level = level;
    }
    if (node.type === "paragraph" || node.type === "heading") {
      const align = node.attrs?.textAlign;
      // Left is the default and "justify" is what .prose already does, so only
      // the two that change anything are kept.
      if (typeof align === "string" && ALIGNMENTS.has(align) && align !== "left" && align !== "justify") {
        attrs.textAlign = align;
      }
    }
    if (node.type === "orderedList") {
      const start = node.attrs?.start;
      if (typeof start === "number" && Number.isInteger(start) && start > 1 && start < 10_000) attrs.start = start;
    }

    const children = CHILDREN[node.type];
    const content = node.content === undefined ? [] : node.content;
    if (!Array.isArray(content)) fail("a node's content is not a list");
    const cleaned = content.map((child) => walk(child, children, depth + 1));
    if ((node.type === "bulletList" || node.type === "orderedList" || node.type === "listItem") && cleaned.length === 0) {
      fail("an empty list");
    }

    return {
      type: node.type,
      ...(Object.keys(attrs).length > 0 ? { attrs } : {}),
      ...(cleaned.length > 0 ? { content: cleaned } : {}),
    };
  };

  try {
    if (typeof input !== "object" || input === null || (input as RichDoc).type !== "doc") {
      return { ok: false, problem: "not a document" };
    }
    if (JSON.stringify(input).length > MAX_DOC_BYTES) return { ok: false, problem: "the document is too long" };
    const content = (input as RichDoc).content ?? [];
    if (!Array.isArray(content)) return { ok: false, problem: "a node's content is not a list" };
    const cleaned = content.map((node) => walk(node, CHILDREN.doc, 1));
    // The editor always keeps an empty paragraph after the last block, so there
    // is somewhere to type below a picture. Published, it is a gap at the end.
    while (cleaned.length > 0 && cleaned.at(-1)!.type === "paragraph" && !cleaned.at(-1)!.content) cleaned.pop();
    return { ok: true, doc: { type: "doc", content: cleaned } };
  } catch (error) {
    return { ok: false, problem: (error as Error).message };
  }
}

function inlineText(node: DocNode): string {
  if (node.type === "text") return node.text ?? "";
  if (node.type === "hardBreak") return "\n";
  return (node.content ?? []).map(inlineText).join("");
}

/**
 * The document as plain paragraphs, one string each, top to bottom.
 *
 * Headings are kept as their own paragraph and list items as "- item", so the
 * text still reads in order; pictures and rules leave nothing behind.
 */
export function docParagraphs(doc: RichDoc): string[] {
  const out: string[] = [];
  const block = (node: DocNode, bullet: string | null) => {
    switch (node.type) {
      case "paragraph":
      case "heading": {
        const text = inlineText(node).trim();
        if (text) out.push(bullet ? `${bullet}${text}` : text);
        break;
      }
      case "bulletList":
      case "orderedList":
        (node.content ?? []).forEach((item, index) => {
          const marker = node.type === "bulletList" ? "- " : `${((node.attrs?.start as number) ?? 1) + index}. `;
          (item.content ?? []).forEach((child, position) => block(child, position === 0 ? marker : null));
        });
        break;
      case "blockquote":
        for (const child of node.content ?? []) block(child, bullet);
        break;
    }
  };
  for (const node of doc.content) block(node, null);
  return out;
}

/**
 * Longest plain-text lead a record carries. The whole article is in its own
 * object; the record's `body` is what a card, a link preview and a LinkedIn
 * repost read, and every chunk carries it, so it stops near LinkedIn's own
 * 3,000-character ceiling.
 */
export const LEAD_MAX = 3000;

/** The opening paragraphs, as many whole ones as fit in LEAD_MAX, blank-line separated. */
export function docLead(doc: RichDoc, max: number = LEAD_MAX): string {
  let lead = "";
  for (const paragraph of docParagraphs(doc)) {
    const next = lead ? `${lead}\n\n${paragraph}` : paragraph;
    if (next.length > max) {
      if (lead === "") lead = `${paragraph.slice(0, max - 1).trimEnd()}…`;
      break;
    }
    lead = next;
  }
  return lead;
}

/** Every picture's `src`, in the order the text places them. */
export function docFigures(doc: RichDoc): Array<{ src: string; alt: string | null; caption: string | null }> {
  const found: Array<{ src: string; alt: string | null; caption: string | null }> = [];
  const walk = (node: DocNode) => {
    if (node.type === "figure") {
      found.push({
        src: node.attrs!.src as string,
        alt: (node.attrs!.alt as string | null) ?? null,
        caption: (node.attrs!.caption as string | null) ?? null,
      });
    }
    for (const child of node.content ?? []) walk(child);
  };
  for (const node of doc.content) walk(node);
  return found;
}

/** Where an article's document lives in the content bucket, from its record. */
export function docKey(recordId: string, docId: string): string {
  return `content/articles/${recordId}-${docId}.json`;
}
