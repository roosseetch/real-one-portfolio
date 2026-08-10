import { describe, expect, it } from "vitest";

import type { DraftRecord } from "../drafts/types";
import { toPublicRecord } from "./records";

const DRAFT: DraftRecord = {
  title: "Inspiration from Nature",
  summary: "I appreciated the sounds of Nature today.",
  body: "I took a moment to appreciate the sounds of Nature.",
  eventDate: null,
  tags: ["Nature"],
  media: [{ mediaId: "media0", alt: "A path through trees", caption: "Quiet at that hour" }],
};

describe("toPublicRecord", () => {
  it("stamps when the record was published", () => {
    const record = toPublicRecord(DRAFT, new Date("2026-08-10T09:21:04.000Z"));
    expect(record.publishedAt).toBe("2026-08-10T09:21:04.000Z");
  });

  it("stamps it even when the note named no date of its own", () => {
    // The case that broke the feed: the model returns eventDate null whenever the
    // author's note names no date, and the site used to order on that alone, so
    // an undated entry sank to the bottom however recently it went live.
    const record = toPublicRecord(DRAFT, new Date("2026-08-10T09:21:04.000Z"));
    expect(record.eventDate).toBeNull();
    expect(record.publishedAt).not.toBeNull();
  });

  it("keeps the two dates apart", () => {
    // eventDate is what the author's note said; publishedAt is what the Worker
    // did. A note about last week's run published today is both.
    const record = toPublicRecord(
      { ...DRAFT, eventDate: "2026-08-03" },
      new Date("2026-08-10T09:21:04.000Z"),
    );
    expect(record.eventDate).toBe("2026-08-03");
    expect(record.publishedAt).toBe("2026-08-10T09:21:04.000Z");
  });

  it("orders lexicographically, because the site sorts the strings", () => {
    // UTC with a fixed number of digits, which is what makes a string compare on
    // the site the same as a chronological one.
    const earlier = toPublicRecord(DRAFT, new Date("2026-08-10T09:21:04.000Z")).publishedAt;
    const later = toPublicRecord(DRAFT, new Date("2026-08-10T09:21:04.001Z")).publishedAt;

    expect(earlier < later).toBe(true);
    expect(later).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("mints an id rather than carrying the draft's", () => {
    // A draft is private and a record is public; one identifier spanning both
    // would put the private object's name into a URL anyone can read.
    const first = toPublicRecord(DRAFT);
    const second = toPublicRecord(DRAFT);
    expect(first.id).not.toBe(second.id);
    expect(first.id).toHaveLength(16);
  });

  it("publishes no media until the pipeline has sanitised some", () => {
    expect(toPublicRecord(DRAFT).media).toEqual([]);
  });
});
