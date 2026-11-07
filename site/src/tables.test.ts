/**
 * Tables, end to end: the editor makes one, the sanitiser keeps it (or says
 * why not), both renderers draw the same structure, and a Markdown article's
 * table survives being opened in the editor and published from it.
 */
import { afterEach, describe, expect, it } from "vitest";

import { docFromRecord } from "./editor-doc";
import { createEditor, tableShape } from "./editor-tiptap";
import { parseProse, proseParagraphs, renderProse } from "./prose";
import { renderRich } from "./rich";
import { MAX_TABLE_COLUMNS, MAX_TABLE_ROWS, cleanDoc, docLead, docParagraphs, type DocNode, type RichDoc } from "./rich-doc";
import type { ActivityRecord } from "./activity";

const allow = { allowSrc: () => true };
const text = (value: string, marks?: unknown[]) => (marks ? { type: "text", text: value, marks } : { type: "text", text: value });
const p = (...content: unknown[]) => (content.length > 0 ? { type: "paragraph", content } : { type: "paragraph" });
const cell = (type: "tableHeader" | "tableCell", value: string, attrs?: Record<string, unknown>) => ({
  type,
  ...(attrs ? { attrs } : {}),
  content: [value ? p(text(value)) : p()],
});
const row = (...cells: unknown[]) => ({ type: "tableRow", content: cells });
const table = (...rows: unknown[]) => ({ type: "table", content: rows });
const doc = (...content: unknown[]) => ({ type: "doc", content });

const PRACTICES = `## The five essential practices

| Practice | What it means |
|---|---|
| Advance a Just Cause | Lead toward a **specific**, inspiring vision. |
| Build Trusting Teams | Create an environment where people feel safe. |

After the table.`;

const record = (body: string): ActivityRecord =>
  ({ id: "aaaaaaaaaaaaaaaa", title: "T", body, bodyFormat: "markdown", publishedAt: "2026-11-07T00:00:00Z" }) as ActivityRecord;

describe("a table in a stored document", () => {
  it("keeps a header row and plain cells, and drops widths, alignment and other editor attributes", () => {
    const input = doc(
      table(
        row(cell("tableHeader", "Practice", { colspan: 1, rowspan: 1, colwidth: [120] }), cell("tableHeader", "What it means")),
        row(cell("tableCell", "Advance", { colspan: 1, rowspan: 1, colwidth: null, align: "center" }), {
          type: "tableCell",
          content: [p(text("Bold", [{ type: "bold" }])), p(text("second"))],
        }),
      ),
    );
    const result = cleanDoc(input, allow);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.doc.content[0]).toEqual(
      table(
        row(cell("tableHeader", "Practice"), cell("tableHeader", "What it means")),
        row(cell("tableCell", "Advance"), { type: "tableCell", content: [p(text("Bold", [{ type: "bold" }])), p(text("second"))] }),
      ),
    );
  });

  it("refuses merged cells, which could not be undone without moving words between columns", () => {
    const merged = doc(table(row(cell("tableCell", "a", { colspan: 2 })), row(cell("tableCell", "b"), cell("tableCell", "c"))));
    expect(cleanDoc(merged, allow)).toEqual({ ok: false, problem: "merged table cells are not supported" });
    const tall = doc(table(row(cell("tableCell", "a", { rowspan: 2 }))));
    expect(cleanDoc(tall, allow)).toEqual({ ok: false, problem: "merged table cells are not supported" });
  });

  it("refuses rows of different widths, and tables past the bounds", () => {
    const ragged = doc(table(row(cell("tableCell", "a"), cell("tableCell", "b")), row(cell("tableCell", "c"))));
    expect(cleanDoc(ragged, allow)).toMatchObject({ ok: false, problem: "a table's rows do not all have the same number of cells" });

    const wide = doc(table(row(...Array.from({ length: MAX_TABLE_COLUMNS + 1 }, () => cell("tableCell", "x")))));
    expect(cleanDoc(wide, allow)).toMatchObject({ ok: false, problem: `a table has more than ${MAX_TABLE_COLUMNS} columns` });

    const long = doc(table(...Array.from({ length: MAX_TABLE_ROWS + 1 }, () => row(cell("tableCell", "x")))));
    expect(cleanDoc(long, allow)).toMatchObject({ ok: false, problem: `a table has more than ${MAX_TABLE_ROWS} rows` });

    expect(cleanDoc(doc(table()), allow)).toMatchObject({ ok: false, problem: "an empty table" });
    expect(cleanDoc(doc(table(row())), allow)).toMatchObject({ ok: false, problem: "an empty table" });
  });

  it("allows only paragraphs in a cell, and a table only at the top level", () => {
    const listInCell = doc(
      table(row({ type: "tableCell", content: [{ type: "bulletList", content: [{ type: "listItem", content: [p(text("x"))] }] }] })),
    );
    expect(cleanDoc(listInCell, allow)).toMatchObject({ ok: false, problem: '"bulletList" is not allowed here' });

    const tableInQuote = doc({ type: "blockquote", content: [table(row(cell("tableCell", "x")))] });
    expect(cleanDoc(tableInQuote, allow)).toMatchObject({ ok: false, problem: '"table" is not allowed here' });

    const strayRow = doc(row(cell("tableCell", "x")));
    expect(cleanDoc(strayRow, allow)).toMatchObject({ ok: false, problem: '"tableRow" is not allowed here' });
  });

  it("turns header cells outside a whole first row into ordinary cells", () => {
    const headerColumn = doc(
      table(
        row(cell("tableHeader", "Name"), cell("tableCell", "Ana")),
        row(cell("tableHeader", "Role"), cell("tableCell", "Lead")),
      ),
    );
    const result = cleanDoc(headerColumn, allow);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const types = (result.doc.content[0].content ?? []).flatMap((r) => (r.content ?? []).map((c) => c.type));
    expect(types).toEqual(["tableCell", "tableCell", "tableCell", "tableCell"]);
  });

  it("gives a cell with nothing in it an empty paragraph", () => {
    const result = cleanDoc(doc(table(row({ type: "tableCell" }))), allow);
    expect(result.ok && result.doc.content[0].content?.[0].content?.[0]).toEqual({ type: "tableCell", content: [{ type: "paragraph" }] });
  });

  it("reads into the plain-text lead as one line per row, without the header row", () => {
    const input: RichDoc = {
      type: "doc",
      content: [
        p(text("Before.")) as DocNode,
        table(
          row(cell("tableHeader", "Practice"), cell("tableHeader", "What it means")),
          row(cell("tableCell", "Advance a Just Cause"), { type: "tableCell", content: [p(text("Lead,")), p(text("together."))] }),
          row(cell("tableCell", "Build Trusting Teams"), cell("tableCell", "")),
        ) as DocNode,
      ],
    };
    expect(docParagraphs(input)).toEqual(["Before.", "Advance a Just Cause — Lead, together.", "Build Trusting Teams"]);
    expect(docLead(input)).toBe("Before.\n\nAdvance a Just Cause — Lead, together.\n\nBuild Trusting Teams");
  });
});

describe("a table in Markdown", () => {
  it("is a header line, a line of dashes, and rows", () => {
    const blocks = parseProse(PRACTICES);
    expect(blocks.map((block) => block.type)).toEqual(["heading", "table", "paragraph"]);
    const found = blocks[1];
    if (found.type !== "table") throw new Error("not a table");
    expect(found.header?.map((runs) => runs.map((run) => run.text).join(""))).toEqual(["Practice", "What it means"]);
    expect(found.rows).toHaveLength(2);
    expect(found.rows[0][1]).toEqual([
      { kind: "text", text: "Lead toward a " },
      { kind: "strong", text: "specific" },
      { kind: "text", text: ", inspiring vision." },
    ]);
  });

  it("reads alignment colons, escaped pipes, short and long rows, and an empty header as none", () => {
    const [found] = parseProse("|   |   |\n|:--|--:|\n| a \\| b |\n| 1 | 2 | 3 |");
    if (found.type !== "table") throw new Error("not a table");
    expect(found.header).toBeNull();
    const plain = found.rows.map((cells) => cells.map((runs) => runs.map((run) => run.text).join("")));
    expect(plain).toEqual([
      ["a | b", ""],
      ["1", "2"],
    ]);
  });

  it("is text when the dashes are missing or do not match the header", () => {
    expect(parseProse("| a | b |\n| 1 | 2 |").map((block) => block.type)).toEqual(["paragraph"]);
    expect(parseProse("| a | b |\n|---|").map((block) => block.type)).toEqual(["paragraph"]);
  });

  it("stays out of a card's excerpt, as lists do", () => {
    expect(proseParagraphs(PRACTICES)).toEqual(["After the table."]);
  });
});

describe("a table on the page", () => {
  const structure = (root: HTMLElement) => {
    const tableElement = root.querySelector("table")!;
    return {
      className: tableElement.className,
      wrapper: tableElement.parentElement!.className,
      header: [...tableElement.querySelectorAll("thead th")].map((th) => [th.textContent, th.getAttribute("scope"), th.getAttribute("role")]),
      rows: [...tableElement.querySelectorAll("tbody tr")].map((tr) => [...tr.querySelectorAll("td")].map((td) => td.textContent)),
      roles: [tableElement.getAttribute("role"), tableElement.querySelector("tbody")!.getAttribute("role"), tableElement.querySelector("td")!.getAttribute("role")],
    };
  };

  it("is drawn the same from Markdown and from the editor's document", () => {
    const fromMarkdown = renderProse(parseProse(PRACTICES), () => null);
    const converted = docFromRecord(record(PRACTICES));
    const cleaned = cleanDoc(converted, allow);
    if (!cleaned.ok) throw new Error(cleaned.problem);
    const fromEditor = renderRich(cleaned.doc, () => null);

    const expected = {
      className: "prose-table prose-table--pairs",
      wrapper: "prose-table-wrap",
      header: [
        ["Practice", "col", "columnheader"],
        ["What it means", "col", "columnheader"],
      ],
      rows: [
        ["Advance a Just Cause", "Lead toward a specific, inspiring vision."],
        ["Build Trusting Teams", "Create an environment where people feel safe."],
      ],
      roles: ["table", "rowgroup", "cell"],
    };
    expect(structure(fromMarkdown)).toEqual(expected);
    expect(structure(fromEditor)).toEqual(expected);
    expect(fromMarkdown.querySelector("td strong")?.textContent).toBe("specific");
    expect(fromEditor.querySelector("td strong")?.textContent).toBe("specific");
  });

  it("makes a wider table a labelled region a keyboard can scroll, and a two-column one not", () => {
    const wide = renderProse(parseProse("| A | B | C |\n|---|---|---|\n| 1 | 2 | 3 |"), () => null);
    const wrapper = wide.querySelector(".prose-table-wrap")!;
    expect(wrapper.getAttribute("role")).toBe("region");
    expect(wrapper.getAttribute("tabindex")).toBe("0");
    expect(wrapper.getAttribute("aria-label")).toBe("Table: A, B, C");
    expect(wide.querySelector("table")!.className).toBe("prose-table");

    const pairs = renderProse(parseProse(PRACTICES), () => null).querySelector(".prose-table-wrap")!;
    expect(pairs.hasAttribute("role")).toBe(false);
    expect(pairs.hasAttribute("tabindex")).toBe(false);
  });

  it("draws an editor table with no header row as body rows only, and keeps a cell's alignment and line breaks", () => {
    const root = renderRich(
      {
        type: "doc",
        content: [
          table(
            row(
              { type: "tableCell", content: [{ type: "paragraph", attrs: { textAlign: "center" }, content: [text("one")] }, p(text("two"))] },
              cell("tableCell", "x"),
            ),
          ) as DocNode,
        ],
      },
      () => null,
    );
    expect(root.querySelector("thead")).toBeNull();
    const first = root.querySelector("td")!;
    expect(first.innerHTML).toBe("one<br>two");
    expect(first.style.textAlign).toBe("center");
  });

  it("never parses a cell's text as markup", () => {
    const root = renderProse(parseProse('| <img src=x onerror=alert(1)> | b |\n|---|---|\n| 1 | 2 |'), () => null);
    expect(root.querySelector("img")).toBeNull();
    expect(root.querySelector("th")!.textContent).toBe("<img src=x onerror=alert(1)>");
  });
});

describe("a table in the editor", () => {
  let mounted: { destroy: () => void } | null = null;
  afterEach(() => {
    mounted?.destroy();
    mounted = null;
  });

  const open = (content: object = { type: "doc", content: [{ type: "paragraph" }] }) => {
    const element = document.createElement("div");
    document.body.append(element);
    const editor = createEditor(element, content, () => {});
    mounted = editor;
    return editor;
  };

  it("inserts a table that publishes as it is", () => {
    const editor = open();
    expect(editor.chain().focus().insertTable({ rows: 3, cols: 2, withHeaderRow: true }).run()).toBe(true);
    expect(tableShape(editor)).toEqual({ rows: 3, columns: 2, headerRow: true });

    editor.commands.insertContent("Practice");
    const result = cleanDoc(editor.getJSON(), allow);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const stored = result.doc.content.find((node) => node.type === "table")!;
    expect(stored.content).toHaveLength(3);
    expect(stored.content![0].content!.map((c) => c.type)).toEqual(["tableHeader", "tableHeader"]);
    expect(stored.content![0].content![0]).toEqual({ type: "tableHeader", content: [p(text("Practice"))] });
  });

  it("adds and removes rows and columns, and toggles the header row", () => {
    const editor = open();
    editor.chain().focus().insertTable({ rows: 2, cols: 2, withHeaderRow: true }).run();
    editor.chain().focus().addColumnAfter().addRowAfter().run();
    expect(tableShape(editor)).toEqual({ rows: 3, columns: 3, headerRow: true });
    editor.chain().focus().toggleHeaderRow().run();
    expect(tableShape(editor)?.headerRow).toBe(false);
    editor.chain().focus().deleteColumn().run();
    expect(tableShape(editor)?.columns).toBe(2);
    editor.chain().focus().deleteTable().run();
    expect(tableShape(editor)).toBeNull();
    expect(editor.getJSON().content?.some((node) => node.type === "table")).toBe(false);
  });

  it("keeps a heading, a list or a picture out of a cell", () => {
    const editor = open();
    editor.chain().focus().insertTable({ rows: 2, cols: 2, withHeaderRow: false }).run();
    expect(editor.can().setHeading({ level: 2 })).toBe(false);
    expect(editor.can().toggleBulletList()).toBe(false);
    editor.commands.insertContent({ type: "figure", attrs: { src: "https://media.test/x.webp" } });
    const json = editor.getJSON() as unknown as RichDoc;
    const cells = json.content.find((node) => node.type === "table")!.content!.flatMap((r) => r.content!);
    expect(cells.every((c) => c.content!.every((child) => child.type === "paragraph"))).toBe(true);
  });

  it("opens a converted Markdown table and publishes it unchanged", () => {
    const converted = docFromRecord(record(PRACTICES));
    const editor = open(converted);
    const result = cleanDoc(editor.getJSON(), allow);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const before = cleanDoc(converted, allow);
    expect(before.ok && result.doc).toEqual(before.ok && before.doc);
  });
});
