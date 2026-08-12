import { describe, expect, it } from "vitest";

import { verbatimRecord } from "./verbatim";

describe("verbatimRecord", () => {
  it("takes the first line as the title and the rest as the body", () => {
    const record = verbatimRecord("A morning at the campus\nThe coffee was good, and the walk over was better.");

    expect(record).toEqual({
      title: "A morning at the campus",
      summary: null,
      body: "The coffee was good, and the walk over was better.",
      eventDate: null,
      tags: [],
      media: [],
    });
  });

  it("changes not one character of the body", () => {
    // The whole promise of this route. Blank lines, spacing and punctuation are
    // the author's, and a route that tidied them would be the model again.
    const body = "First paragraph.\n\nSecond one --- with an aside, and  odd   spacing.\n\n  Third.";
    expect(verbatimRecord(`A title\n${body}`)?.body).toBe(body);
  });

  it("invents no summary, date or tags", () => {
    const record = verbatimRecord("Ran the Basel half marathon on 3 May in 1:52\nA good day.");

    expect(record?.summary).toBeNull();
    expect(record?.eventDate).toBeNull();
    expect(record?.tags).toEqual([]);
  });

  it("publishes a one-line note as a title with no body", () => {
    const record = verbatimRecord("Back at the campus after three years");

    expect(record?.title).toBe("Back at the campus after three years");
    expect(record?.body).toBeNull();
  });

  it("keeps the whole message when the opening line is too long to be a title", () => {
    const line =
      "This week I finally got to see the trial site in person, and it is hard to overstate how different " +
      "it feels from a slide deck when you are standing in the pharmacy itself.";
    const record = verbatimRecord(line);

    expect(record?.title.length).toBeLessThanOrEqual(120);
    expect(record?.title).toMatch(/…$/);
    // Shortened for the heading, but not one word of it is lost from the page.
    expect(record?.body).toBe(line);
  });

  it("cuts a long opening line at a word boundary", () => {
    const record = verbatimRecord(`${"word ".repeat(60)}end`);

    expect(record?.title).toMatch(/^(word )+word…$/);
  });

  it("cuts a long line with no spaces where it stands", () => {
    // One unbroken word, or a script that does not separate them: a word
    // boundary that never arrives must not shorten the title to nothing.
    const record = verbatimRecord("x".repeat(400));

    expect(record?.title).toBe(`${"x".repeat(119)}…`);
  });

  it("has nothing to publish for an empty message", () => {
    // A photo sent without a caption. The caller decides what to say about it.
    expect(verbatimRecord("")).toBeNull();
    expect(verbatimRecord("   \n  \n ")).toBeNull();
  });

  it("ignores blank lines around the message", () => {
    const record = verbatimRecord("\n\n  A morning at the campus  \n\nThe coffee was good.\n\n");

    expect(record?.title).toBe("A morning at the campus");
    expect(record?.body).toBe("The coffee was good.");
  });
});
