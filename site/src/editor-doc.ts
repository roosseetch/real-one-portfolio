/**
 * An existing record, as a document the editor can open.
 *
 * An update key can open any article: one already written on the editor, whose
 * document is fetched as it was saved, or one that predates it — a Telegram
 * note in plain paragraphs, or a Markdown article published by hand. Those are
 * converted here, once, when the editor opens them; publishing then stores the
 * result as a document like any other.
 *
 * Nothing on the page is dropped on the way. Every picture the record shows
 * ends up as a figure — where the Markdown placed it, or after the text if
 * nothing did — because publishing rebuilds the record's pictures from the
 * document's figures, and a picture left out of it would leave the site.
 */
import type { ActivityMedia, ActivityRecord } from "./activity";
import { parseProse, type InlineRun } from "./prose";
import type { DocMark, DocNode, RichDoc } from "./rich-doc";

/** A run of text with its marks, and a hard break wherever the source had a single newline. */
function textNodes(text: string, marks: DocMark[] = []): DocNode[] {
  const nodes: DocNode[] = [];
  text.split("\n").forEach((line, index) => {
    if (index > 0) nodes.push({ type: "hardBreak" });
    if (line !== "") nodes.push(marks.length > 0 ? { type: "text", text: line, marks } : { type: "text", text: line });
  });
  return nodes;
}

function runs(items: InlineRun[], extra: DocMark[] = []): DocNode[] {
  return items.flatMap((run) =>
    textNodes(run.text, run.kind === "strong" ? [...extra, { type: "bold" }] : run.kind === "em" ? [...extra, { type: "italic" }] : extra),
  );
}

const paragraph = (content: DocNode[]): DocNode => (content.length > 0 ? { type: "paragraph", content } : { type: "paragraph" });

function figure(media: ActivityMedia, alt?: string): DocNode {
  return {
    type: "figure",
    attrs: { src: media.src, alt: (alt || media.alt) ?? null, caption: media.caption ?? null },
  };
}

/** A Markdown body (prose.ts), block for block. */
function fromMarkdown(record: ActivityRecord, placed: Set<number>): DocNode[] {
  const media = record.media ?? [];
  const nodes: DocNode[] = [];

  for (const block of parseProse(record.body)) {
    switch (block.type) {
      case "heading": {
        // The eyebrow was the "Workshop 1:" before the title; it goes back in
        // front of it, which is how it was written.
        const prefix: DocNode[] = block.eyebrow ? [{ type: "text", text: `${block.eyebrow}: ` }] : [];
        nodes.push({ type: "heading", attrs: { level: block.level }, content: [...prefix, ...runs(block.runs)] });
        break;
      }
      case "paragraph":
        nodes.push(paragraph(runs(block.runs)));
        break;
      case "list":
        nodes.push({
          type: block.ordered ? "orderedList" : "bulletList",
          content: block.items.map((item) => ({ type: "listItem", content: [paragraph(runs(item))] })),
        });
        break;
      case "quote":
        nodes.push({ type: "blockquote", content: [paragraph(runs(block.runs))] });
        break;
      case "break":
        nodes.push({ type: "horizontalRule" });
        break;
      case "figure": {
        const item = media[block.media];
        if (item && item.type === "image") {
          nodes.push(figure(item, block.alt));
          placed.add(block.media);
        }
        break;
      }
    }
  }
  return nodes;
}

/** A plain body: a paragraph per blank-line-separated block, single newlines kept. */
function fromPlain(body: string | null | undefined): DocNode[] {
  return (body ?? "")
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter((block) => block !== "")
    .map((block) => paragraph(textNodes(block)));
}

/** The record as a document. Only for a record that is not already one. */
export function docFromRecord(record: ActivityRecord): RichDoc {
  const placed = new Set<number>();
  const content = record.bodyFormat === "markdown" ? fromMarkdown(record, placed) : fromPlain(record.body);

  // Pictures the text did not place go after it, in the order the record had
  // them. A video stays where it was, in the carousel under the article.
  (record.media ?? []).forEach((item, index) => {
    if (item.type === "image" && !placed.has(index)) content.push(figure(item));
  });

  return { type: "doc", content: content.length > 0 ? content : [{ type: "paragraph" }] };
}
