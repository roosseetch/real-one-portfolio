import { describe, expect, it } from "vitest";

import type { DraftRecord } from "../drafts/types";
import { inventedQuotation } from "./quotes";

function record(body: string): DraftRecord {
  return { title: "A Great Start", summary: null, body, eventDate: null, tags: [], media: [] };
}

const NOTE = "Mmmm today in the Morning Coffee was great at Novartis Campus";

describe("inventedQuotation", () => {
  it("catches the quotation that actually reached production", () => {
    // The first record ever published carried this, from a note that said only
    // that the coffee was good.
    const published = record(
      "My day began on a high note with a delicious cup of coffee at the Novartis Campus this morning. " +
        "As Simon Sinek says, 'When we feel safe, we are more likely to relax and be our authentic selves', " +
        "and that's exactly how I felt in that moment",
    );

    expect(inventedQuotation(published, [NOTE])).toContain("When we feel safe");
  });

  it("passes a record that quotes nothing", () => {
    expect(inventedQuotation(record("Coffee at the campus, and a good start to the day."), [NOTE])).toBeNull();
  });

  it("allows a quotation the author wrote themselves", () => {
    // Her own words coming back is not an invention.
    const note = 'She told me "the trial start-up timeline has moved up by three weeks" this morning';
    const r = record('She told me "the trial start-up timeline has moved up by three weeks" today.');
    expect(inventedQuotation(r, [note])).toBeNull();
  });

  it("sees through typographic quotes and reflowed whitespace", () => {
    const note = 'He said "we should start the study in March" yesterday';
    const straight = record('He said "we should start the study in March" yesterday.');
    const curly = record('He said “we should   start the study in March” yesterday.');

    expect(inventedQuotation(straight, [note])).toBeNull();
    expect(inventedQuotation(curly, [note])).toBeNull();
  });

  it("ignores short quoted fragments used for emphasis", () => {
    // A quoted word is punctuation, not an attribution worth blocking on.
    expect(inventedQuotation(record('It was a "great" morning.'), [NOTE])).toBeNull();
  });

  it("checks the title and summary, not only the body", () => {
    const r: DraftRecord = {
      title: "A Great Start",
      summary: 'As they say, "the best ideas arrive before the first meeting"',
      body: null,
      eventDate: null,
      tags: [],
      media: [],
    };
    expect(inventedQuotation(r, [NOTE])).toContain("the best ideas arrive");
  });
});
