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

  it("leaves contractions and possessives alone, however many there are", () => {
    // What actually broke in production: a long note produced a long body, and
    // pairing its apostrophes read "it's … the team's" as a quotation. Every
    // attempt was rejected, so the note never came back as a preview at all.
    const body =
      "This week I finally got to see the trial site in person, and it's hard to overstate how " +
      "different it feels from a slide deck. The team's energy was infectious, and it's the kind " +
      "of detail that never survives a protocol summary. What I don't want to lose is the texture " +
      "of it, and every patient's first name.";

    expect(inventedQuotation(record(body), [NOTE])).toBeNull();
  });

  it("leaves typographic apostrophes alone too", () => {
    const body =
      "It’s hard to overstate how different it feels, the team’s energy was infectious, and the " +
      "coordinators’ notes were already on the desk waiting.";

    expect(inventedQuotation(record(body), [NOTE])).toBeNull();
  });

  it("still catches an invented quotation that contains a contraction", () => {
    // The boundary rule must not become a way past the check: an apostrophe
    // inside a word sits within the span rather than ending it.
    const straight = record("As she put it, 'when the team feels safe, it's far more likely to speak up early'.");
    const curly = record("As she put it, ‘when the team feels safe, it’s far more likely to speak up early’.");

    expect(inventedQuotation(straight, [NOTE])).toContain("when the team feels safe");
    expect(inventedQuotation(curly, [NOTE])).toContain("when the team feels safe");
  });

  it("does not pair a quote mark in one field with one in the next", () => {
    // Title, summary and body are searched as one string. Without this, an
    // unbalanced mark in the title would quote the whole summary after it.
    const r: DraftRecord = {
      title: 'A morning at the "Novartis Campus',
      summary: "The coffee was good and the walk over was better than usual.",
      body: 'Nothing here is a quotation" at all.',
      eventDate: null,
      tags: [],
      media: [],
    };

    expect(inventedQuotation(r, [NOTE])).toBeNull();
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
