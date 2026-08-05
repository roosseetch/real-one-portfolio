import { describe, expect, it } from "vitest";

import { RECORD_JSON_SCHEMA, parseRecord } from "./schema";

const VALID = {
  title: "Morning run by the river",
  summary: "An easy 8 km before work.",
  body: "Cool air, quiet paths, and a good pace.",
  eventDate: "2026-07-28",
  tags: ["Jogging", "Outdoors"],
};

describe("RECORD_JSON_SCHEMA", () => {
  it("asks for prose and nothing the Worker owns", () => {
    // Spec §8: ids, object names, paths and URLs are decided by code. The
    // surest way to keep the model out of them is to never ask.
    const asked = Object.keys(RECORD_JSON_SCHEMA.properties);
    expect(asked).toEqual(["title", "summary", "body", "eventDate", "tags"]);
    for (const field of ["id", "mediaId", "media", "url", "src", "path"]) {
      expect(asked).not.toContain(field);
    }
  });
});

describe("parseRecord", () => {
  it("accepts a well-formed record", () => {
    expect(parseRecord(VALID)).toEqual({ ...VALID, media: [] });
  });

  it("never takes media from the model", () => {
    // A model that volunteers a mediaId is naming an object it has no business
    // naming, so the field is dropped rather than trusted.
    const record = parseRecord({ ...VALID, media: [{ mediaId: "../../secret", alt: "x", caption: "y" }] });
    expect(record?.media).toEqual([]);
  });

  it("rejects anything that is not an object", () => {
    for (const value of [null, undefined, "text", 42, [VALID]]) {
      expect(parseRecord(value)).toBeNull();
    }
  });

  it("rejects a record with no usable title", () => {
    expect(parseRecord({ ...VALID, title: "" })).toBeNull();
    expect(parseRecord({ ...VALID, title: "   " })).toBeNull();
    expect(parseRecord({ ...VALID, title: 42 })).toBeNull();
    expect(parseRecord({ title: undefined })).toBeNull();
  });

  it("trims whitespace off the text fields", () => {
    const record = parseRecord({ ...VALID, title: "  Morning run  ", body: "\n Cool air \n" });
    expect(record?.title).toBe("Morning run");
    expect(record?.body).toBe("Cool air");
  });

  it("turns empty or missing optional text into null, not an empty string", () => {
    const record = parseRecord({ title: "Morning run", summary: "  ", tags: [] });
    expect(record?.summary).toBeNull();
    expect(record?.body).toBeNull();
  });

  it("keeps a plain calendar date", () => {
    expect(parseRecord({ ...VALID, eventDate: "2026-07-28" })?.eventDate).toBe("2026-07-28");
  });

  it("drops a date the site could not sort by", () => {
    // Worse than no date: it would sort into the wrong place silently.
    for (const bad of ["yesterday", "28/07/2026", "2026-07-28T10:00:00Z", "2026-7-8", "", null, 20260728]) {
      expect(parseRecord({ ...VALID, eventDate: bad })?.eventDate).toBeNull();
    }
  });

  it("drops tags that are not usable strings", () => {
    expect(parseRecord({ ...VALID, tags: ["Jogging", "", 42, null, "  "] })?.tags).toEqual(["Jogging"]);
    expect(parseRecord({ ...VALID, tags: "Jogging" })?.tags).toEqual([]);
    expect(parseRecord({ ...VALID, tags: undefined })?.tags).toEqual([]);
  });

  it("deduplicates tags regardless of case", () => {
    // Otherwise the same topic renders twice on one record.
    expect(parseRecord({ ...VALID, tags: ["Jogging", "jogging", "JOGGING"] })?.tags).toEqual(["Jogging"]);
  });

  it("caps the number of tags", () => {
    const many = Array.from({ length: 30 }, (_, i) => `Tag${i}`);
    expect(parseRecord({ ...VALID, tags: many })?.tags).toHaveLength(8);
  });

  it("truncates text a model ran away with", () => {
    const record = parseRecord({ ...VALID, title: "x".repeat(500), body: "y".repeat(9000) });
    expect(record?.title).toHaveLength(120);
    expect(record?.body).toHaveLength(4000);
  });
});
