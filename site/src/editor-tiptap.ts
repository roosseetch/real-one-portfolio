/**
 * The editor itself: Tiptap, cut down to what an article on this site can be.
 *
 * Everything the toolbar can make is something rich-doc.ts accepts and rich.ts
 * draws, and nothing more: headings 2–4, lists, quotes, rules, links, the six
 * hosted families, three sizes, centre and right alignment, pictures, and
 * tables of plain paragraphs — no merged cells, no dragged column widths.
 * Code, code blocks and arbitrary colours are left out of StarterKit rather
 * than filtered later, so the author is never offered something the page
 * would quietly drop.
 *
 * Two pieces are this site's own. The font is an attribute on Tiptap's
 * textStyle mark that names one of ARTICLE_FONTS and is drawn through
 * FONT_STACKS — Tiptap's FontFamily would write the family unquoted, which a
 * browser rejects for "Source Serif 4". And a picture is a `figure` node that
 * holds only an address the sanitiser produced: it is never parsed from pasted
 * HTML, so pasting a page cannot put somebody else's image into the article.
 */
import { Editor, Extension, Node, type JSONContent } from "@tiptap/core";
import { Table, TableCell, TableHeader, TableRow } from "@tiptap/extension-table";
import TextAlign from "@tiptap/extension-text-align";
import { TextStyle } from "@tiptap/extension-text-style";
import { Placeholder } from "@tiptap/extensions";
import StarterKit from "@tiptap/starter-kit";

import { ARTICLE_FONTS, FONT_STACKS, type ArticleFont } from "./rich-doc";

/*
 * A cell holds paragraphs and nothing else, which is all rich-doc.ts accepts
 * there; Tiptap's default lets a list, a heading or a picture in. Its `align`
 * attribute goes too: alignment is the paragraph's, as everywhere else.
 * colspan, rowspan and colwidth stay because prosemirror-tables needs them to
 * find its way around a table; the sanitiser drops the widths.
 */
const withoutAlign = <T extends Record<string, unknown>>(attributes: T | undefined) => {
  const { align: _align, ...rest } = attributes ?? ({} as T);
  return rest;
};
const ArticleTableCell = TableCell.extend({
  content: "paragraph+",
  addAttributes() {
    return withoutAlign(this.parent?.());
  },
});
const ArticleTableHeader = TableHeader.extend({
  content: "paragraph+",
  addAttributes() {
    return withoutAlign(this.parent?.());
  },
});

const ArticleStyle = Extension.create({
  name: "articleStyle",
  addGlobalAttributes() {
    return [
      {
        types: ["textStyle"],
        attributes: {
          fontFamily: {
            default: null,
            parseHTML: (element) => {
              const named = element.getAttribute("data-font");
              return named && (ARTICLE_FONTS as readonly string[]).includes(named) ? named : null;
            },
            renderHTML: (attributes) => {
              const family = attributes.fontFamily as ArticleFont | null;
              return family && FONT_STACKS[family]
                ? { "data-font": family, style: `font-family: ${FONT_STACKS[family]}` }
                : {};
            },
          },
          fontSize: {
            default: null,
            parseHTML: () => null,
            renderHTML: (attributes) =>
              attributes.fontSize ? { style: `font-size: ${attributes.fontSize as string}` } : {},
          },
        },
      },
    ];
  },
});

/**
 * A picture in the text. `upload` and `failed` are the editor's own bookkeeping
 * for a picture still being sanitised; neither is published — rich-doc.ts
 * keeps only src, alt and caption.
 */
const Figure = Node.create({
  name: "figure",
  group: "block",
  atom: true,
  selectable: true,
  draggable: true,
  addAttributes() {
    return {
      src: { default: null, rendered: false },
      alt: { default: null, rendered: false },
      caption: { default: null, rendered: false },
      upload: { default: null, rendered: false },
      failed: { default: false, rendered: false },
    };
  },
  parseHTML() {
    return [];
  },
  renderHTML({ node }) {
    const { src, alt, caption, failed } = node.attrs as {
      src: string | null;
      alt: string | null;
      caption: string | null;
      failed: boolean;
    };
    if (!src) {
      return [
        "figure",
        { class: `prose-figure editor-figure is-pending${failed ? " is-failed" : ""}` },
        [
          "span",
          { class: "editor-figure-note" },
          failed
            ? "This picture could not be processed. Select it, delete it, and try another."
            : "Removing the picture's metadata. This takes a minute or two.",
        ],
      ];
    }
    const picture: [string, Record<string, string>] = ["img", { src, alt: alt ?? "" }];
    return caption
      ? ["figure", { class: "prose-figure editor-figure" }, picture, ["figcaption", {}, caption]]
      : ["figure", { class: "prose-figure editor-figure" }, picture];
  },
});

export function createEditor(element: HTMLElement, content: JSONContent, onChange: () => void): Editor {
  return new Editor({
    element,
    content,
    extensions: [
      StarterKit.configure({
        code: false,
        codeBlock: false,
        heading: { levels: [2, 3, 4] },
        link: {
          openOnClick: false,
          autolink: true,
          defaultProtocol: "https",
          protocols: ["mailto"],
          HTMLAttributes: { rel: "noopener nofollow", target: null },
        },
      }),
      TextStyle,
      ArticleStyle,
      TextAlign.configure({ types: ["heading", "paragraph"], alignments: ["left", "center", "right"] }),
      Placeholder.configure({ placeholder: "Write the article here…" }),
      Figure,
      Table.configure({ resizable: false, HTMLAttributes: { class: "editor-table" } }),
      TableRow,
      ArticleTableHeader,
      ArticleTableCell,
    ],
    editorProps: {
      attributes: { class: "prose prose-rich editor-content", "aria-label": "Article text", spellcheck: "true" },
    },
    onUpdate: onChange,
  });
}

/** Sets attributes on every figure a test matches, in one transaction. */
export function updateFigures(
  editor: Editor,
  matches: (attrs: Record<string, unknown>) => boolean,
  attrs: Record<string, unknown>,
): void {
  const { state } = editor;
  const tr = state.tr;
  let changed = false;
  state.doc.descendants((node, pos) => {
    if (node.type.name === "figure" && matches(node.attrs)) {
      tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...attrs });
      changed = true;
    }
  });
  if (changed) editor.view.dispatch(tr);
}

/** The figures still waiting on the sanitiser, and the ones it gave up on. */
export function figureStates(editor: Editor): { pending: string[]; failed: number } {
  const pending: string[] = [];
  let failed = 0;
  editor.state.doc.descendants((node) => {
    if (node.type.name !== "figure" || node.attrs.src) return;
    if (node.attrs.failed) failed++;
    else if (typeof node.attrs.upload === "string") pending.push(node.attrs.upload);
  });
  return { pending, failed };
}

/** The table the cursor is in: its size, and whether its first row is a header. */
export function tableShape(editor: Editor): { rows: number; columns: number; headerRow: boolean } | null {
  const { $from } = editor.state.selection;
  for (let depth = $from.depth; depth > 0; depth--) {
    const node = $from.node(depth);
    if (node.type.name !== "table") continue;
    const first = node.firstChild;
    let headerRow = first !== null && first.childCount > 0;
    first?.forEach((cell) => {
      if (cell.type.name !== "tableHeader") headerRow = false;
    });
    return { rows: node.childCount, columns: first?.childCount ?? 0, headerRow };
  }
  return null;
}
