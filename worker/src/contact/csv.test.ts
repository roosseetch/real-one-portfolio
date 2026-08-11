/**
 * The CSV reader and writer.
 *
 * These files hold text a stranger typed, so the tests are mostly about the
 * characters that would otherwise let them choose the shape of the file:
 * commas, quotation marks and newlines. A round trip that survives all three is
 * the whole property worth having.
 */
import { describe, expect, it } from "vitest";

import { csvRow, csvText, parseCsv } from "./csv";

describe("writing", () => {
  it("leaves an ordinary field alone", () => {
    expect(csvRow(["a@example.com", "2026-08-11T05:00:00Z"])).toBe("a@example.com,2026-08-11T05:00:00Z\r\n");
  });

  it("quotes a field with a comma in it", () => {
    expect(csvRow(["Hello, world"])).toBe('"Hello, world"\r\n');
  });

  it("doubles a quotation mark, and quotes the field around it", () => {
    expect(csvRow(['He said "hello"'])).toBe('"He said ""hello"""\r\n');
  });

  it("quotes a field with a newline in it", () => {
    expect(csvRow(["line one\nline two"])).toBe('"line one\nline two"\r\n');
  });

  it("writes an empty field as nothing at all", () => {
    expect(csvRow(["a", "", "b"])).toBe("a,,b\r\n");
  });
});

describe("reading", () => {
  it("reads back what it wrote, whatever was in it", () => {
    const rows = [
      ["A Visitor", "visitor@example.com", "Acme, Inc.", "+44 20 7946 0958"],
      ['He said "hello"', "line one\nline two", "", "plain"],
      ["comma,quote\",newline\n", "", "", ""],
    ];

    expect(parseCsv(csvText(rows))).toEqual(rows);
  });

  it("finds nothing in an empty file", () => {
    expect(parseCsv("")).toEqual([]);
  });

  it("does not invent a row from a trailing newline", () => {
    expect(parseCsv("a,b\r\n")).toEqual([["a", "b"]]);
  });

  it("reads a file written with bare newlines", () => {
    expect(parseCsv("a,b\nc,d")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  it("keeps an empty trailing field", () => {
    expect(parseCsv("a,b,\r\n")).toEqual([["a", "b", ""]]);
  });

  it("keeps a row that is entirely empty fields", () => {
    expect(parseCsv(",,\r\n")).toEqual([["", "", ""]]);
  });

  it("gives back what it could read when the file ends mid-quote", () => {
    // A truncated write must not make every earlier row unreadable.
    expect(parseCsv('a,b\r\n"unterminated')).toEqual([
      ["a", "b"],
      ["unterminated"],
    ]);
  });

  it("cannot be made to grow a column by a field that contains a comma", () => {
    const row = parseCsv(csvText([["name", "a@example.com", "hello, and also goodbye"]]))[0];

    expect(row).toHaveLength(3);
    expect(row[2]).toBe("hello, and also goodbye");
  });
});
