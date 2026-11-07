/**
 * The small Markdown an article is written in, and the page it becomes.
 *
 * A record's body is plain text: its paragraphs are split on blank lines and
 * nothing else in it means anything. That suits a note sent from Telegram, and
 * it flattens an article — workshop sections, lists of findings, poll results —
 * into a wall of paragraphs. A record that sets `bodyFormat: "markdown"` is read
 * with this instead. Records without it never come here, so a note whose lines
 * happen to begin with "- " is shown exactly as it always was.
 *
 * Deliberately a small subset rather than a Markdown library: what is here is
 * what the stylesheet has a design for, a dependency would be the largest thing
 * the activity page downloads, and everything is built with `textContent`, so
 * there is no HTML anywhere in the pipeline for a body to smuggle in. A line
 * this does not recognise is text, shown as written.
 *
 *   ## Heading            a section; "Workshop 1: Title" puts "Workshop 1" above it
 *   ### Heading           a subsection
 *   #### Heading          a point within one
 *   - item / 1. item      a list, one line per item
 *   > text                a pull quote
 *   | a | b |             a table: a header row, a |---|---| line, then rows;
 *   |---|---|             every line starts and ends with a pipe, \| is a
 *   | 1 | 2 |             pipe in a cell, and a header of empty cells is none
 *   ---                   a section break
 *   ![alt](media:0)       the record's first media item, here in the text
 *   **strong**, *em*      inside any of the above
 *
 * Import-free, like fonts.ts, so it stays a module anything can read; the one
 * thing it cannot build itself — a figure, which needs the record's media — is
 * handed in by the caller.
 */

export interface InlineRun {
  kind: "text" | "strong" | "em";
  text: string;
}

export type ProseBlock =
  | { type: "heading"; level: 2 | 3 | 4; eyebrow: string | null; runs: InlineRun[] }
  | { type: "paragraph"; runs: InlineRun[]; deck: boolean }
  | { type: "list"; ordered: boolean; short: boolean; items: InlineRun[][] }
  | { type: "quote"; runs: InlineRun[] }
  | { type: "table"; header: InlineRun[][] | null; rows: InlineRun[][][] }
  | { type: "break" }
  | { type: "figure"; media: number; alt: string };

/**
 * Longest prefix that becomes a heading's eyebrow. "Workshop 1" is the shape
 * this is for; a colon further in than this is part of the title.
 */
const EYEBROW_MAX_LENGTH = 20;

/**
 * Longest item in a list that flows into two columns. Past this an item wraps
 * inside a half-width column, and two columns of wrapped items read worse than
 * one column of whole ones.
 */
const SHORT_ITEM_MAX_LENGTH = 28;

const HEADING = /^(#{2,4}) +(.+)$/;
const BULLET = /^- +(.+)$/;
const NUMBERED = /^\d+\. +(.+)$/;
const QUOTE = /^> ?(.*)$/;
const BREAK = /^-{3,}$/;
const FIGURE = /^!\[([^\]]*)\]\(media:(\d+)\)$/;
const EYEBROW = /^([^:]+): +(.+)$/;
const TABLE_ROW = /^\|.*\|$/;
const TABLE_DELIMITER = /^\|(?:\s*:?-+:?\s*\|)+$/;

/** A table line's cells: the outer pipes off, split on the rest, `\|` kept as a pipe. */
function tableCells(line: string): string[] {
  return line
    .slice(1, -1)
    .split(/(?<!\\)\|/)
    .map((cell) => cell.replace(/\\\|/g, "|").trim());
}

/**
 * `**strong**` and `*em*`, in the order they appear.
 *
 * An asterisk with nothing to pair with stays an asterisk. So does one with a
 * space inside it, so "3 * 4 * 5" is arithmetic rather than emphasis.
 */
export function parseInline(text: string): InlineRun[] {
  const runs: InlineRun[] = [];
  const pattern = /\*\*(\S(?:.*?\S)?)\*\*|\*(\S(?:.*?\S)?)\*/g;
  let last = 0;

  for (const match of text.matchAll(pattern)) {
    const at = match.index ?? 0;
    if (at > last) runs.push({ kind: "text", text: text.slice(last, at) });
    if (match[1] !== undefined) runs.push({ kind: "strong", text: match[1] });
    else runs.push({ kind: "em", text: match[2] });
    last = at + match[0].length;
  }
  if (last < text.length) runs.push({ kind: "text", text: text.slice(last) });
  return runs;
}

const plain = (runs: InlineRun[]) => runs.map((run) => run.text).join("");

/** Every block in a body, top to bottom. */
export function parseProse(body: string | null | undefined): ProseBlock[] {
  if (!body) return [];

  const blocks: ProseBlock[] = [];
  // The paragraph or list being gathered, line by line, until something ends it.
  let paragraph: string[] = [];
  let quote: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;

  const flush = () => {
    if (paragraph.length > 0) {
      const runs = parseInline(paragraph.join("\n"));
      // A paragraph that is all emphasis, straight after a section heading, is
      // the line under the heading that says what the section is about.
      const previous = blocks[blocks.length - 1];
      const deck =
        runs.length === 1 && runs[0].kind === "em" && previous?.type === "heading" && previous.level === 2;
      blocks.push({ type: "paragraph", runs, deck });
      paragraph = [];
    }
    if (quote.length > 0) {
      blocks.push({ type: "quote", runs: parseInline(quote.join("\n")) });
      quote = [];
    }
    if (list) {
      blocks.push({
        type: "list",
        ordered: list.ordered,
        short: list.items.every((item) => item.length <= SHORT_ITEM_MAX_LENGTH),
        items: list.items.map(parseInline),
      });
      list = null;
    }
  };

  const lines = body.split("\n");
  for (let at = 0; at < lines.length; at++) {
    const line = lines[at].trim();

    if (line === "") {
      flush();
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      const level = heading[1].length as 2 | 3 | 4;
      const split = level === 2 ? EYEBROW.exec(heading[2]) : null;
      const eyebrow = split && split[1].length <= EYEBROW_MAX_LENGTH ? split[1] : null;
      blocks.push({ type: "heading", level, eyebrow, runs: parseInline(eyebrow && split ? split[2] : heading[2]) });
      continue;
    }

    if (BREAK.test(line)) {
      flush();
      blocks.push({ type: "break" });
      continue;
    }

    // A table is its header line and the dashes under it, as in GitHub's
    // Markdown; a line of pipes without the dashes is text.
    const delimiter = lines[at + 1]?.trim() ?? "";
    if (TABLE_ROW.test(line) && TABLE_DELIMITER.test(delimiter)) {
      const header = tableCells(line);
      if (header.length === tableCells(delimiter).length) {
        flush();
        const width = header.length;
        const rows: InlineRun[][][] = [];
        at += 1;
        while (at + 1 < lines.length && TABLE_ROW.test(lines[at + 1].trim())) {
          at += 1;
          // Short rows are filled and long ones cut to the header's width.
          const cells = tableCells(lines[at].trim()).slice(0, width);
          while (cells.length < width) cells.push("");
          rows.push(cells.map(parseInline));
        }
        const named = header.some((cell) => cell !== "");
        // A header of empty cells is a table with no header; with no rows
        // either, it is nothing at all.
        if (named || rows.length > 0) blocks.push({ type: "table", header: named ? header.map(parseInline) : null, rows });
        continue;
      }
    }

    const figure = FIGURE.exec(line);
    if (figure) {
      flush();
      blocks.push({ type: "figure", media: Number(figure[2]), alt: figure[1] });
      continue;
    }

    const bullet = BULLET.exec(line);
    const numbered = bullet ? null : NUMBERED.exec(line);
    const item = bullet ?? numbered;
    if (item) {
      const ordered = numbered !== null;
      // A change from bullets to numbers is a new list, as it is in Markdown.
      if (!list || list.ordered !== ordered || paragraph.length > 0 || quote.length > 0) {
        flush();
        list = { ordered, items: [] };
      }
      list.items.push(item[1]);
      continue;
    }

    const quoted = QUOTE.exec(line);
    if (quoted) {
      if (paragraph.length > 0 || list) flush();
      quote.push(quoted[1]);
      continue;
    }

    if (quote.length > 0 || list) flush();
    paragraph.push(line);
  }

  flush();
  return blocks;
}

/**
 * The body's paragraphs as plain text, for a listing card's excerpt.
 *
 * Headings, decks, lists and quotes are left out rather than flattened: an
 * excerpt is a few lines of prose, and "Workshop 1 Closing the Cognitive Gaps
 * From fragmented data" is not one.
 */
export function proseParagraphs(body: string | null | undefined): string[] {
  return parseProse(body)
    .filter(
      (block): block is Extract<ProseBlock, { type: "paragraph" }> => block.type === "paragraph" && !block.deck,
    )
    .map((block) => plain(block.runs));
}

/** Which media items the text places itself, so nothing else shows them twice. */
export function placedMedia(body: string | null | undefined): Set<number> {
  const placed = new Set<number>();
  for (const block of parseProse(body)) if (block.type === "figure") placed.add(block.media);
  return placed;
}

function node(tag: string, className?: string): HTMLElement {
  const element = document.createElement(tag);
  if (className) element.className = className;
  return element;
}

function appendRuns(parent: HTMLElement, runs: InlineRun[]): HTMLElement {
  for (const run of runs) {
    if (run.kind === "text") parent.append(document.createTextNode(run.text));
    else {
      const element = node(run.kind);
      element.textContent = run.text;
      parent.append(element);
    }
  }
  return parent;
}

/** Fills one cell of a table. */
export type CellFiller = (cell: HTMLElement) => void;

/**
 * A table as the article page draws it, for a Markdown article and an editor
 * one alike: the structure is here once, and each renderer fills the cells.
 *
 * The roles are spelled out because a two-column table stacks into blocks on a
 * narrow screen, and an element whose `display` the stylesheet changes stops
 * being announced as a table cell. A wider table scrolls sideways instead, so its
 * wrapper is a labelled region a keyboard can focus and scroll.
 */
export function tableElement(header: CellFiller[] | null, rows: CellFiller[][]): HTMLElement {
  const columns = header?.length ?? rows[0]?.length ?? 0;
  const pairs = columns === 2;
  const wrapper = node("div", "prose-table-wrap");
  const table = node("table", pairs ? "prose-table prose-table--pairs" : "prose-table");
  table.setAttribute("role", "table");

  const row = (cells: CellFiller[], tag: "th" | "td") => {
    const tr = node("tr");
    tr.setAttribute("role", "row");
    for (const fill of cells) {
      const cell = node(tag);
      if (tag === "th") cell.setAttribute("scope", "col");
      cell.setAttribute("role", tag === "th" ? "columnheader" : "cell");
      fill(cell);
      tr.append(cell);
    }
    return tr;
  };

  if (header) {
    const thead = node("thead");
    thead.setAttribute("role", "rowgroup");
    thead.append(row(header, "th"));
    table.append(thead);
  }
  const tbody = node("tbody");
  tbody.setAttribute("role", "rowgroup");
  for (const cells of rows) tbody.append(row(cells, "td"));
  table.append(tbody);

  if (!pairs) {
    wrapper.tabIndex = 0;
    wrapper.setAttribute("role", "region");
    const names = header ? [...table.querySelectorAll("th")].map((th) => th.textContent?.trim()).filter(Boolean) : [];
    wrapper.setAttribute("aria-label", names.length > 0 ? `Table: ${names.join(", ")}` : "Table");
  }
  wrapper.append(table);
  return wrapper;
}

/**
 * The article, as one element.
 *
 * `figure` builds the media item a figure names, or returns null for one the
 * record does not have — which drops the figure rather than leaving an empty
 * frame in the text.
 */
export function renderProse(
  blocks: ProseBlock[],
  figure: (index: number, alt: string) => HTMLElement | null,
): HTMLElement {
  const root = node("div", "prose");

  for (const block of blocks) {
    switch (block.type) {
      case "heading": {
        const heading = node(`h${block.level}`, `prose-h${block.level}`);
        if (block.eyebrow) {
          // Its own line above the title, and still part of the heading, so the
          // outline a screen reader lists reads "Workshop 1 Closing the …".
          heading.append(Object.assign(node("span", "prose-eyebrow"), { textContent: block.eyebrow }));
          heading.append(document.createTextNode(" "));
        }
        root.append(appendRuns(heading, block.runs));
        break;
      }
      case "paragraph":
        root.append(appendRuns(node("p", block.deck ? "prose-deck" : undefined), block.runs));
        break;
      case "list": {
        const list = node(block.ordered ? "ol" : "ul", block.short ? "prose-list prose-list--short" : "prose-list");
        // The stylesheet draws its own markers with list-style: none, and Safari
        // stops announcing a list as one once its markers are gone.
        list.setAttribute("role", "list");
        for (const item of block.items) list.append(appendRuns(node("li"), item));
        root.append(list);
        break;
      }
      case "quote": {
        const quote = node("blockquote", "prose-quote");
        quote.append(appendRuns(node("p"), block.runs));
        root.append(quote);
        break;
      }
      case "break": {
        const rule = node("hr", "prose-break");
        root.append(rule);
        break;
      }
      case "table": {
        const fill = (runs: InlineRun[]): CellFiller => (cell) => appendRuns(cell, runs);
        root.append(tableElement(block.header?.map(fill) ?? null, block.rows.map((cells) => cells.map(fill))));
        break;
      }
      case "figure": {
        const built = figure(block.media, block.alt);
        if (built) root.append(built);
        break;
      }
    }
  }

  return root;
}
